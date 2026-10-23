import { createHash, randomBytes } from "node:crypto";
import { VISIBILITIES } from "../rules/command.ts";
import type { CommandVisibility } from "../rules/command.ts";
import type { API } from "@discordjs/core";
import { DiscordAPIError } from "@discordjs/rest";
import { InteractionType, MessageFlags } from "discord-api-types/v10";
import type { APIChannel, APIGuild, APIGuildMember, APIInteraction, APIRole } from "discord-api-types/v10";
import type { PlanRow, Store, StepRow } from "../db.ts";
import type { GuildCaches } from "../discord/cache.ts";
import { toChannel, toMember, toRole } from "../discord/cache.ts";
import { modalValue } from "../discord/modal.ts";
import { shareableChannels } from "../discord/permissions.ts";
import type { GuildState, MemberState } from "../discord/permissions.ts";
import { DM_INTERVAL_MS, routeOf } from "./catalog.ts";
import type { Body } from "./catalog.ts";
import { confirmModal, confirmPhrase, label, needsTypedConfirm, parsePlanCustomId, renderDialog, reviseModal } from "./dialog.ts";
import type { DialogState, DialogView } from "./dialog.ts";
import { attachmentsFor, dialogUploads, stepFiles, uploadsFor } from "./files.ts";
import { isRef, maxRisk } from "./types.ts";
import type { AllowEntry, Attachment, Plan, PlanRule, PlanRuleDraft, PlanStatus, Precondition, RuleDryRun, Step, StepDraft } from "./types.ts";
import type { Reader } from "../discord/reader.ts";
import { allowProblems, allowRisk, needsChannel, needsTarget } from "../rules/allow.ts";
import type { Targets } from "../rules/allow.ts";
import type { RuleProposal } from "../rules/types.ts";
import { normalizeSteps, permissionProblems, PlanRejected, planRisk, resolveRefs, specOf, visibilityProblems } from "./validate.ts";

// Proposal → approval dialog → re-verification → execution. Every write the
// bot makes on someone's behalf goes through here.

export const APPROVAL_MS = 5 * 60_000;
export const SNAPSHOT_RETENTION_MS = 90 * 24 * 60 * 60_000;
const PROGRESS_INTERVAL_MS = 2000;

export interface PlannerDeps {
  api: API;
  store: Store;
  caches: Pick<GuildCaches, "get">;
  selfId: () => string;
  now: () => number;
  log: (message: string, error?: unknown) => void;
  sleep?: (ms: number) => Promise<void>;
  /** Asks the agent to rework a pending plan; it proposes the new version with `replaces`. */
  revise?: (input: ReviseInput) => Promise<void>;
  /** Explains plan code from the code alone, paid for by the actor. */
  summarize?: (code: string, actorId: string) => Promise<string | null>;
  /**
   * A step is about to be sent. The gateway can report its event before the
   * REST response comes back, so event rules mark the write here as well.
   */
  beforeWrite?: (plan: Plan, step: Step) => void;
  /** A step went through; event rules use this to tell the bot's own changes from others'. */
  onWrite?: (plan: Plan, step: Step, response: unknown) => void;
  /** Event rules proposed together with a plan. Absent means plans cannot carry rules. */
  rules?: PlanRuleHooks;
}

/** A rule as a proposal carries it; when proposing a plan again, what was worked out the first time comes along. */
export type RuleInput = RuleProposal & { summary?: string | null; dry?: RuleDryRun; request?: string };

export interface PlanRuleHooks {
  /** Checks the proposed rules, dry-runs and explains them. Throws PlanRejected. */
  prepare: (input: PrepareRulesInput) => Promise<PlanRuleDraft[]>;
  /** Registers a rule whose refs are filled in, once the plan's steps have run. Returns its id. */
  register: (guildId: string, ownerId: string, draft: PlanRuleDraft) => string;
}

export interface PrepareRulesInput {
  guildId: string;
  ownerId: string;
  channelId: string;
  shareable: Set<string>;
  /** The conversation's reader, for the dry run; absent when proposing again. */
  reader?: Pick<Reader, "get">;
  rules: RuleInput[];
  /** Ids of the plan's steps, which the rules' refs may point to. */
  stepIds: string[];
  request: string;
}

export interface RuleRunInput {
  guildId: string;
  ownerId: string;
  rule: PlanRule;
  drafts: StepDraft[];
  /** Images the rule's code made, which its posts may name in `files`. */
  images?: Record<string, Attachment>;
}

export interface ReviseInput {
  plan: Plan;
  channelId: string;
  messageId: string;
  instruction: string;
}

export interface ProposeInput {
  guildId: string;
  /** Where the dialog is posted. */
  channelId: string;
  replyToId: string | null;
  actorId: string;
  drafts: StepDraft[];
  /** Channels this conversation may show; the preview must stay within them. */
  shareable: Set<string>;
  /** A plan whose dialog this one takes over (a revision, or the same plan proposed again). */
  replaces?: string;
  /** The sandboxed code the steps came from; shown in the dialog with an independent explanation. */
  code?: string;
  /** An explanation already written for this exact code (proposing the same plan again). */
  summary?: string | null;
  /** Event rules to register once the steps have run, approved with the same dialog. */
  rules?: RuleInput[];
  /** The conversation's reader, for dry-running the rules. */
  reader?: Pick<Reader, "get">;
  /** The request the plan answers, kept as each rule's source. */
  request?: string;
  /** Images attached in this reply that the steps' posts may name in `files`. */
  images?: Record<string, Attachment>;
}

type Resource = Record<string, unknown> | null;

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stable((value as Record<string, unknown>)[k])}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function fingerprint(resource: Resource, fields: string[]): string {
  if (!resource) return "absent";
  return sha256(stable(fields.map((f) => [f, resource[f] ?? null])));
}

export function planHash(plan: Omit<Plan, "hash">): string {
  const { id, guildId, actor, preconditions, steps, labels, risk, revises, source, rule, rules, createdAt, expiresAt } = plan;
  // The rules are approved too, so a change to them (such as who sees a command's replies) changes the hash.
  return sha256(stable({ id, guildId, actor, preconditions, steps, labels, risk, revises, source, rule, ...(rules ? { rules } : {}), createdAt, expiresAt }));
}

/** Fields shown as "before" in the preview, on top of the ones the step depends on. */
function displayValues(kind: string, resource: Resource, fields: string[]): Record<string, unknown> | null {
  if (!resource) return null;
  const values: Record<string, unknown> = {};
  for (const f of fields) values[f] = resource[f] ?? null;
  if (kind === "message") {
    values.content = resource.content;
    values.author = { username: (resource.author as { username?: string } | undefined)?.username };
  }
  if (kind === "channel" || kind === "role") values.name = resource.name;
  return values;
}

function memberLabel(m: APIGuildMember): string {
  return m.nick ?? m.user.global_name ?? m.user.username;
}

/** Thrown when the world changed between approval and execution. */
class Aborted extends Error {}

/** The steps ran but a rule could not be registered (e.g. its owner lost a permission it needs). */
class RuleNotRegistered extends Error {}

/** A plan's rule as input for proposing the plan again. */
function ruleInputOf(r: PlanRuleDraft): RuleInput {
  return {
    name: r.name, trigger: r.trigger, allow: r.allow, summary: r.summary, dry: r.dry, request: r.request,
    program: r.program.kind === "wasm" ? { kind: "wasm", module: r.program.module.sha256 } : r.program,
    ...(r.params ? { params: r.params } : {}),
    ...(r.replaces ? { replaces: r.replaces.id } : {}),
    ...(r.sampleEvent !== undefined ? { sampleEvent: r.sampleEvent } : {}),
    ...(r.limits ? { limits: r.limits } : {}),
  };
}

export class Planner {
  readonly deps: PlannerDeps;
  /** How each dialog is shown now, so a refresh keeps it. Lost on restart, which only resets the view. */
  readonly #shown = new Map<string, { view?: DialogView; closed?: boolean }>();

  constructor(deps: PlannerDeps) {
    this.deps = deps;
  }

  #render(plan: Plan, state: DialogState): ReturnType<typeof renderDialog> {
    const shown = this.#shown.get(plan.id);
    return renderDialog(plan, { ...state, view: state.view ?? shown?.view, actions: state.actions ?? !shown?.closed });
  }

  get #rest() {
    return this.deps.api.rest;
  }

  async #get(path: string): Promise<Resource> {
    try {
      return (await this.#rest.get(path as `/${string}`)) as Record<string, unknown>;
    } catch (e) {
      if (e instanceof DiscordAPIError && e.status === 404) return null;
      throw e;
    }
  }

  /**
   * Channels being deleted that never had a message, read from REST: the cache's
   * last_message_id is not kept up to date as messages arrive.
   */
  async #emptyChannels(steps: Step[]): Promise<{ emptyChannels?: string[] }> {
    const ids = steps.filter((s) => s.op === "DELETE /channels/{channel}" && typeof s.pathParams.channel === "string").map((s) => s.pathParams.channel as string);
    const empty: string[] = [];
    for (const id of ids.slice(0, 20)) {
      const channel = (await this.#get(`/channels/${id}`).catch(() => null)) as { last_message_id?: string | null } | null;
      if (channel && !channel.last_message_id) empty.push(id);
    }
    return empty.length > 0 ? { emptyChannels: empty } : {};
  }

  /** Current state of a resource key, straight from REST (never the cache). */
  async resource(guildId: string, key: string): Promise<Resource> {
    const sep = key.indexOf(":");
    const kind = key.slice(0, sep);
    const [a, b] = key.slice(sep + 1).split("/") as [string, string | undefined];
    switch (kind) {
      case "channel":
        return this.#get(`/channels/${a}`);
      case "role":
        return this.#get(`/guilds/${guildId}/roles/${a}`);
      case "member":
        return this.#get(`/guilds/${guildId}/members/${a}`);
      case "message":
        return this.#get(`/channels/${a}/messages/${b}`);
      case "overwrite": {
        const channel = (await this.#get(`/channels/${a}`)) as { permission_overwrites?: Array<Record<string, unknown>> } | null;
        return channel?.permission_overwrites?.find((o) => o.id === b) ?? null;
      }
      case "ban":
        return this.#get(`/guilds/${a}/bans/${b}`);
      default:
        throw new Error(`不明なリソース ${key}`);
    }
  }

  // --- Proposal -----------------------------------------------------------

  async propose(input: ProposeInput): Promise<Plan> {
    const cache = this.deps.caches.get(input.guildId);
    if (!cache?.guild) throw new Error("サーバーの情報をまだ受信していません");
    const guild = cache.guild;
    const id = randomBytes(6).toString("hex");
    const ruleInputs = input.rules ?? [];
    if (ruleInputs.length > 0 && !this.deps.rules) throw new PlanRejected(["ルールはここでは作れません"]);
    const steps = normalizeSteps(input.drafts, input.guildId, id, ruleInputs.length > 0);
    const ctx = { guild, actorId: input.actorId, selfId: this.deps.selfId() };
    const replaced = input.replaces ? this.deps.store.getPlan(input.replaces)?.plan : undefined;
    const files = attachmentsFor(steps, [input.images, replaced?.attachments]);
    const problems = [...steps.flatMap((s) => [...permissionProblems(s, ctx), ...visibilityProblems(s, input.shareable)]), ...files.problems];
    if (problems.length > 0) throw new PlanRejected(problems);
    const rules = ruleInputs.length > 0
      ? await this.deps.rules!.prepare({
          guildId: input.guildId,
          ownerId: input.actorId,
          channelId: input.channelId,
          shareable: input.shareable,
          ...(input.reader ? { reader: input.reader } : {}),
          rules: ruleInputs,
          stepIds: steps.map((s) => s.id),
          request: input.request ?? "",
        })
      : undefined;

    {
      const preconditions = await this.#preconditions(input.guildId, steps);
      const labels = await this.#labels(input.guildId, guild, steps, input.actorId, rules?.flatMap((r) => r.allow) ?? []);
      const source = input.code === undefined ? undefined : { code: input.code, summary: input.summary !== undefined ? input.summary : await this.#summarize(input.code, input.actorId) };
      const createdAt = new Date(this.deps.now());
      const draft: Omit<Plan, "hash"> = {
        id,
        guildId: input.guildId,
        actor: { kind: "user", userId: input.actorId, via: "conversation" },
        preconditions,
        steps,
        labels,
        risk: maxRisk([planRisk(steps), ...(rules ?? []).map((r) => allowRisk(r.allow))]),
        ...(input.replaces ? { revises: input.replaces } : {}),
        ...(source ? { source } : {}),
        ...(rules ? { rules } : {}),
        ...(await this.#emptyChannels(steps)),
        ...(files.attachments ? { attachments: files.attachments } : {}),
        createdAt: createdAt.toISOString(),
        expiresAt: new Date(createdAt.getTime() + APPROVAL_MS).toISOString(),
      };
      const plan: Plan = { ...draft, hash: planHash(draft) };
      this.deps.store.insertPlan(plan);
      this.deps.store.audit(plan.actor, "plan.propose", { risk: plan.risk, steps: steps.map((s) => s.op), ...(rules ? { rules: rules.map((r) => r.trigger.event) } : {}) }, plan.id);

      const oldRow = input.replaces ? this.deps.store.getPlan(input.replaces) : undefined;
      if (oldRow?.channelId && oldRow.messageId) {
        // Takes over the earlier dialog, so the channel keeps one message per request.
        this.deps.store.setPlanMessage(plan.id, oldRow.channelId, oldRow.messageId);
        this.deps.store.transitionPlan(oldRow.plan.id, ["pending_approval", "cancelled", "aborted"], "cancelled", { reason: `変更 \`${plan.id}\` に置き換えました` });
        this.deps.store.audit(plan.actor, "plan.replace", { by: plan.id }, oldRow.plan.id);
        // The new version's images replace the old ones on the message.
        const uploads = await dialogUploads(plan);
        await this.deps.api.channels.editMessage(oldRow.channelId, oldRow.messageId, {
          ...this.#render(plan, { status: "pending_approval" }),
          attachments: uploads.map((f, i) => ({ id: i, filename: f.name })),
          ...(uploads.length > 0 ? { files: uploads } : {}),
        });
        return plan;
      }
      const uploads = await dialogUploads(plan);
      const message = await this.deps.api.channels.createMessage(input.channelId, {
        ...this.#render(plan, { status: "pending_approval" }),
        ...(uploads.length > 0 ? { files: uploads } : {}),
        allowed_mentions: { parse: [] },
        ...(input.replyToId ? { message_reference: { message_id: input.replyToId, fail_if_not_exists: false } } : {}),
      });
      this.deps.store.setPlanMessage(plan.id, input.channelId, message.id);
      return plan;
    }
  }

  /**
   * A rule's plan: no dialog, since the owner approved the rule. Every step
   * must fit the rule's allow list and the owner's (and the bot's) current
   * permissions; then it runs through the same executor as any other plan.
   */
  async runForRule(input: RuleRunInput): Promise<{ plan: Plan; status: PlanStatus; reason: string | null }> {
    const cache = this.deps.caches.get(input.guildId);
    if (!cache?.guild) throw new Error("サーバーの情報をまだ受信していません");
    const guild = cache.guild;
    const id = randomBytes(6).toString("hex");
    const steps = normalizeSteps(input.drafts, input.guildId, id);
    const ctx = { guild, actorId: input.ownerId, selfId: this.deps.selfId() };
    const [targets, channels, preconditions] = await Promise.all([
      this.#targets(input.guildId, steps, input.rule.allow),
      this.#channelStates(steps, input.rule.allow),
      this.#preconditions(input.guildId, steps),
    ]);
    const files = attachmentsFor(steps, [input.images]);
    const problems = [...allowProblems(steps, input.rule.allow, targets, undefined, channels), ...steps.flatMap((s) => permissionProblems(s, ctx)), ...files.problems];
    if (problems.length > 0) throw new PlanRejected(problems);

    const labels = await this.#labels(input.guildId, guild, [], input.ownerId);
    const createdAt = new Date(this.deps.now()).toISOString();
    const draft: Omit<Plan, "hash"> = {
      id,
      guildId: input.guildId,
      actor: { kind: "user", userId: input.ownerId, via: "rule" },
      preconditions,
      steps,
      labels,
      risk: planRisk(steps),
      rule: input.rule,
      ...(files.attachments ? { attachments: files.attachments } : {}),
      createdAt,
      expiresAt: createdAt,
    };
    const plan: Plan = { ...draft, hash: planHash(draft) };
    this.deps.store.insertPlan(plan, "approved");
    this.deps.store.audit(plan.actor, "plan.propose", { risk: plan.risk, steps: steps.map((s) => s.op), event: input.rule.eventId }, plan.id, input.rule.id);
    // The preconditions were read from REST a moment ago, so they are not read again.
    await this.execute(plan.id, { fresh: true });
    const row = this.deps.store.getPlan(plan.id)!;
    return { plan, status: row.status, reason: row.reason };
  }

  /** Current state of the targets an allow list puts conditions on, for steps whose target is known. */
  async #targets(guildId: string, steps: Step[], allow: AllowEntry[]): Promise<Targets> {
    const targets: Targets = new Map();
    for (const step of steps) {
      const spec = specOf(step);
      if (!spec.target || !needsTarget(step, allow) || Object.values(step.pathParams).some(isRef)) continue;
      targets.set(step.id, await this.resource(guildId, spec.target(step.pathParams, guildId)));
    }
    return targets;
  }

  /** Current state of the channel each step acts in, where an allow list puts conditions on it. */
  async #channelStates(steps: Step[], allow: AllowEntry[]): Promise<Targets> {
    const channels: Targets = new Map();
    for (const step of steps) {
      const param = specOf(step).channel;
      const id = param ? step.pathParams[param] : undefined;
      if (typeof id !== "string" || !needsChannel(step, allow)) continue;
      channels.set(step.id, await this.#get(`/channels/${id}`));
    }
    return channels;
  }

  async #summarize(code: string, actorId: string): Promise<string | null> {
    if (!this.deps.summarize) return null;
    try {
      return await this.deps.summarize(code, actorId);
    } catch (e) {
      this.deps.log("コードの要約に失敗", e);
      return null;
    }
  }

  async #preconditions(guildId: string, steps: Step[]): Promise<Precondition[]> {
    const byResource = new Map<string, Set<string>>();
    for (const step of steps) {
      const spec = specOf(step);
      if (!spec.target || Object.values(step.pathParams).some(isRef)) continue;
      const key = spec.target(step.pathParams, guildId);
      const fields = byResource.get(key) ?? new Set<string>();
      for (const f of spec.targetFields?.(step.body as Body) ?? []) fields.add(f);
      byResource.set(key, fields);
    }
    const result: Precondition[] = [];
    const missing: string[] = [];
    for (const [key, fieldSet] of byResource) {
      const resource = await this.resource(guildId, key);
      const kind = key.slice(0, key.indexOf(":"));
      // A new channel overwrite has nothing to replace; everything else must exist.
      if (!resource && kind !== "overwrite") missing.push(key);
      const fields = [...fieldSet].sort();
      result.push({ resource: key, fields, values: displayValues(kind, resource, fields), fingerprint: fingerprint(resource, fields) });
    }
    if (missing.length > 0) throw new PlanRejected(missing.map((k) => `対象が見つかりません: ${k}`));
    return result;
  }

  async #labels(guildId: string, guild: GuildState, steps: Step[], actorId: string, allow: AllowEntry[] = []): Promise<Record<string, string>> {
    const labels: Record<string, string> = {};
    let roles: APIRole[] | null = null;
    const user = async (id: string) => {
      const m = (await this.#get(`/guilds/${guildId}/members/${id}`)) as APIGuildMember | null;
      if (m) labels[id] = memberLabel(m);
      else {
        const u = (await this.#get(`/users/${id}`)) as { username?: string; global_name?: string | null } | null;
        if (u) labels[id] = u.global_name ?? u.username ?? id;
      }
    };
    const channel = async (id: string) => {
      const name = guild.channels.get(id)?.name ?? ((await this.#get(`/channels/${id}`)) as { name?: string } | null)?.name;
      if (name) labels[id] = `#${name}`;
    };
    const role = async (id: string) => {
      roles ??= (await this.#rest.get(`/guilds/${guildId}/roles`)) as APIRole[];
      const r = roles.find((x) => x.id === id);
      if (r) labels[id] = id === guildId ? "@everyone" : `@${r.name}`;
    };

    await user(actorId);
    for (const step of steps) {
      const spec = specOf(step);
      const body = step.body as Body;
      const wanted: Array<{ id: unknown; kind: "channel" | "role" | "user" }> = [
        ...(spec.mentions?.(step.pathParams, body) ?? []),
        ...(spec.channels?.(step.pathParams, body) ?? []).map((id) => ({ id, kind: "channel" as const })),
      ];
      for (const { id, kind } of wanted) {
        if (typeof id !== "string" || labels[id]) continue;
        if (kind === "user") await user(id);
        else if (kind === "role") await role(id);
        else await channel(id);
      }
    }
    // Ids a rule's allow list pins its path parameters to, named after the parameter.
    for (const entry of allow) {
      for (const [name, schema] of Object.entries(entry.path ?? {})) {
        const s = schema as { enum?: unknown[]; const?: unknown };
        for (const id of s.enum ?? (s.const !== undefined ? [s.const] : [])) {
          if (typeof id !== "string" || labels[id]) continue;
          if (name === "user") await user(id);
          else if (name === "role") await role(id);
          else if (name === "channel") await channel(id);
        }
      }
    }
    return labels;
  }

  // --- Interactions -------------------------------------------------------

  /** Handles plan buttons and the confirmation modal. Returns false for anything else. */
  async handleInteraction(interaction: APIInteraction): Promise<boolean> {
    if (interaction.type !== InteractionType.MessageComponent && interaction.type !== InteractionType.ModalSubmit) return false;
    const parsed = parsePlanCustomId(interaction.data.custom_id);
    if (!parsed) return false;
    const { api, store } = this.deps;
    const userId = interaction.member?.user.id ?? interaction.user?.id;
    const ephemeral = (content: string) =>
      api.interactions.reply(interaction.id, interaction.token, { content, flags: MessageFlags.Ephemeral, allowed_mentions: { parse: [] } });

    const row = store.getPlan(parsed.planId);
    if (!row || row.plan.hash.slice(0, 8) !== parsed.hash8) {
      await ephemeral("この変更は見つかりません");
      return true;
    }
    const { plan } = row;

    if (parsed.action === "json") {
      const json = JSON.stringify({ plan, status: row.status, reason: row.reason, steps: store.getSteps(plan.id) }, null, 2);
      await api.interactions.reply(interaction.id, interaction.token, {
        content: `変更 \`${plan.id}\` の全内容です`,
        files: [{ name: `plan-${plan.id}.json`, data: Buffer.from(json) }],
        flags: MessageFlags.Ephemeral,
      });
      return true;
    }
    if (parsed.action === "code" || parsed.action === "result" || parsed.action === "details") {
      // Anyone who sees the dialog may switch what it shows.
      this.#shown.set(plan.id, { ...this.#shown.get(plan.id), view: parsed.action });
      const steps = row.status === "pending_approval" ? undefined : store.getSteps(plan.id);
      await api.interactions.updateMessage(interaction.id, interaction.token, this.#render(plan, { status: row.status, steps, reason: row.reason }));
      return true;
    }
    if (userId !== plan.actor.userId) {
      await ephemeral("この変更を操作できるのは依頼した本人だけです");
      return true;
    }
    const update = (state: DialogState) => api.interactions.updateMessage(interaction.id, interaction.token, this.#render(plan, state));
    const expired = () => Date.parse(plan.expiresAt) <= this.deps.now();
    const followUp = (content: string) =>
      api.interactions.followUp(interaction.application_id, interaction.token, { content, flags: MessageFlags.Ephemeral, allowed_mentions: { parse: [] } });
    const why = (e: unknown) => (e instanceof PlanRejected ? e.reasons.join("\n") : e instanceof Error ? e.message : String(e)).slice(0, 1800);

    switch (parsed.action) {
      case "visibility": {
        const value = interaction.type === InteractionType.MessageComponent && "values" in interaction.data ? interaction.data.values[0] : undefined;
        const target = plan.rules?.find((r) => r.key === parsed.rule && r.trigger.command);
        if (row.status !== "pending_approval" || expired() || !target || !VISIBILITIES.includes(value as CommandVisibility)) {
          await ephemeral("この変更はもう変えられません");
          return true;
        }
        const rules = plan.rules!.map((r) => (r === target ? { ...r, trigger: { ...r.trigger, command: { ...r.trigger.command!, visibility: value as CommandVisibility } } } : r));
        const { hash: _old, ...rest } = plan;
        const changed: Plan = { ...rest, rules, hash: planHash({ ...rest, rules }) };
        if (!store.replacePendingPlan(changed)) {
          await ephemeral("この変更はもう承認待ちではありません");
          return true;
        }
        store.audit(plan.actor, "plan.visibility", { rule: target.key, visibility: value }, plan.id);
        await api.interactions.updateMessage(interaction.id, interaction.token, this.#render(changed, { status: "pending_approval" }));
        return true;
      }
      case "cancel": {
        if (!store.transitionPlan(plan.id, ["pending_approval"], "cancelled", { reason: "依頼者が取り消しました" })) {
          await ephemeral("この変更はもう承認待ちではありません");
          return true;
        }
        store.audit(plan.actor, "plan.cancel", {}, plan.id);
        await update({ status: "cancelled", reason: "依頼者が取り消しました" });
        return true;
      }
      case "run":
      case "confirm": {
        if (row.status !== "pending_approval") {
          await ephemeral("この変更はもう承認待ちではありません");
          return true;
        }
        if (expired()) {
          await this.#expire(plan.id);
          await update({ status: "cancelled", reason: "期限切れになりました(5分)。もう一度頼んでください。" });
          return true;
        }
        if (parsed.action === "run" && needsTypedConfirm(plan)) {
          await api.interactions.createModal(interaction.id, interaction.token, confirmModal(plan));
          return true;
        }
        if (parsed.action === "confirm") {
          const typed = interaction.type === InteractionType.ModalSubmit ? modalValue(interaction, "confirm")?.trim() : undefined;
          if (typed !== confirmPhrase(plan)) {
            await ephemeral("入力が一致しないため実行しませんでした。もう一度「実行」を押してください。");
            return true;
          }
        }
        if (!store.transitionPlan(plan.id, ["pending_approval"], "approved", { approvedBy: userId })) {
          await ephemeral("この変更はもう承認待ちではありません");
          return true;
        }
        store.audit(plan.actor, "plan.approve", {}, plan.id);
        await update({ status: "executing" });
        void this.execute(plan.id);
        return true;
      }
      case "resume": {
        if (!store.transitionPlan(plan.id, ["failed"], "approved", { reason: null })) {
          await ephemeral("この変更は再開できる状態ではありません");
          return true;
        }
        store.audit(plan.actor, "plan.resume", {}, plan.id);
        await update({ status: "executing", steps: store.getSteps(plan.id) });
        void this.execute(plan.id);
        return true;
      }
      case "restore": {
        if (row.status !== "failed" || !row.channelId) {
          await ephemeral("この変更は復元できる状態ではありません");
          return true;
        }
        await api.interactions.deferMessageUpdate(interaction.id, interaction.token);
        const { drafts, skipped } = this.restoreDrafts(row);
        if (drafts.length === 0) {
          await followUp(`戻せる変更がありません。${skipped.length > 0 ? `戻せないもの: ${skipped.join("、")}` : ""}`);
          return true;
        }
        try {
          const shareable = this.#shareable(plan, row.channelId);
          const restore = await this.propose({ guildId: plan.guildId, channelId: row.channelId, replyToId: row.messageId, actorId: plan.actor.userId, drafts, shareable });
          store.audit(plan.actor, "plan.restore", { restorePlan: restore.id, skipped }, plan.id);
          const note = `復元の変更 \`${restore.id}\` を提案しました。${skipped.length > 0 ? `戻せないもの: ${skipped.join("、")}` : ""}`;
          store.transitionPlan(plan.id, ["failed"], "failed", { reason: `${row.reason ?? ""}\n${note}` });
          this.#shown.set(plan.id, { ...this.#shown.get(plan.id), closed: true });
          await this.#refresh(plan.id);
        } catch (e) {
          await followUp(`復元の変更を作れませんでした:\n${why(e)}`);
        }
        return true;
      }
      case "revise": {
        if (row.status !== "pending_approval" || expired() || !this.deps.revise) {
          await ephemeral("この変更はもう修正できません");
          return true;
        }
        await api.interactions.createModal(interaction.id, interaction.token, reviseModal(plan));
        return true;
      }
      case "revisetext": {
        const instruction = interaction.type === InteractionType.ModalSubmit ? modalValue(interaction, "instruction")?.trim() : undefined;
        if (row.status !== "pending_approval" || !instruction || !row.channelId || !row.messageId || !this.deps.revise) {
          await ephemeral("この変更はもう修正できません");
          return true;
        }
        await api.interactions.deferMessageUpdate(interaction.id, interaction.token);
        store.audit(plan.actor, "plan.revise", { instruction: instruction.slice(0, 500) }, plan.id);
        // The agent answers in the channel; it replaces this dialog when it proposes the new version.
        void this.deps.revise({ plan, channelId: row.channelId, messageId: row.messageId, instruction }).catch((e) => {
          this.deps.log(`変更 ${plan.id} の修正に失敗`, e);
          void followUp(`修正版を作れませんでした: ${why(e)}`).catch(() => undefined);
        });
        return true;
      }
      case "redo": {
        if ((row.status !== "cancelled" && row.status !== "aborted") || !row.channelId) {
          await ephemeral("この変更は出し直せません");
          return true;
        }
        await api.interactions.deferMessageUpdate(interaction.id, interaction.token);
        try {
          const drafts: StepDraft[] = plan.steps.map((s) => ({ id: s.id, op: s.op, path: s.pathParams, ...(s.body !== undefined ? { body: s.body } : {}) }));
          await this.propose({
            guildId: plan.guildId, channelId: row.channelId, replyToId: null, actorId: plan.actor.userId, drafts,
            shareable: this.#shareable(plan, row.channelId), replaces: plan.id,
            ...(plan.source ? { code: plan.source.code, summary: plan.source.summary } : {}),
            ...(plan.rules ? { rules: plan.rules.map(ruleInputOf) } : {}),
            ...(plan.attachments ? { images: plan.attachments } : {}),
          });
        } catch (e) {
          await followUp(`出し直せませんでした:\n${why(e)}`);
        }
        return true;
      }
      case "keep": {
        if (row.status !== "failed") {
          await ephemeral("この変更はもう終わっています");
          return true;
        }
        store.audit(plan.actor, "plan.keep", {}, plan.id);
        const reason = `${row.reason ?? ""}\nそのままにしました。`;
        store.transitionPlan(plan.id, ["failed"], "failed", { reason });
        this.#shown.set(plan.id, { ...this.#shown.get(plan.id), closed: true });
        await update({ status: "failed", steps: store.getSteps(plan.id), reason });
        return true;
      }
    }
  }

  /** Channels the actor may be shown in the plan's channel, from the cache. */
  #shareable(plan: Plan, channelId: string): Set<string> {
    const cache = this.deps.caches.get(plan.guildId);
    const actor = cache?.member(plan.actor.userId);
    if (!cache?.guild || !actor) throw new Error("サーバーの情報を読み込めていません");
    return shareableChannels(cache.guild, channelId, actor, this.deps.selfId());
  }

  /** Steps that undo what a failed plan already did, newest first. */
  restoreDrafts(row: PlanRow): { drafts: StepDraft[]; skipped: string[] } {
    const { plan } = row;
    const rows = new Map(this.deps.store.getSteps(plan.id).map((s) => [s.stepId, s]));
    const drafts: StepDraft[] = [];
    const skipped: string[] = [];
    for (const step of [...plan.steps].reverse()) {
      const state = rows.get(step.id);
      if (state?.state !== "done" || !state.request) continue;
      const spec = specOf(step);
      const snapshot = this.deps.store.getSnapshot(plan.id, step.id)?.data ?? null;
      const inverse = spec.inverse?.(state.request.pathParams, state.request.body as Body, snapshot, state.response as Record<string, unknown> | null);
      if (inverse) drafts.push(inverse);
      else skipped.push(`${step.id}(${spec.label})`);
    }
    return { drafts, skipped };
  }

  // --- Execution ----------------------------------------------------------

  async #freshState(plan: Plan, steps: Step[]): Promise<GuildState> {
    const g = plan.guildId;
    // Independent reads go out together: run one after another they made up most of a rule's delay.
    const [guild, channels] = (await Promise.all([this.#rest.get(`/guilds/${g}`), this.#rest.get(`/guilds/${g}/channels`)])) as [APIGuild, APIChannel[]];
    const state: GuildState = {
      id: g,
      ownerId: guild.owner_id,
      roles: new Map(guild.roles.map((r) => [r.id, toRole(r)])),
      channels: new Map(channels.map((c) => [c.id, toChannel(c)])),
      members: new Map(),
    };
    const memberIds = new Set([plan.actor.userId, this.deps.selfId()]);
    for (const step of steps) {
      const param = specOf(step).hierarchy?.member;
      if (param && !isRef(step.pathParams[param])) memberIds.add(String(step.pathParams[param]));
    }
    await Promise.all([...[...memberIds].map((id) => this.#addMember(state, id)), ...steps.map((step) => this.#addChannel(state, step))]);
    return state;
  }

  async #addMember(state: GuildState, userId: string): Promise<void> {
    const m = (await this.#get(`/guilds/${state.id}/members/${userId}`)) as APIGuildMember | null;
    if (m) state.members.set(userId, toMember(m) as MemberState);
  }

  /** Threads and channels created earlier in the plan are not in the guild's channel list. */
  async #addChannel(state: GuildState, step: Step): Promise<void> {
    const param = specOf(step).channel;
    const value = param ? step.pathParams[param] : undefined;
    if (typeof value !== "string" || state.channels.has(value)) return;
    const raw = (await this.#get(`/channels/${value}`)) as (APIChannel & { guild_id?: string }) | null;
    if (raw?.guild_id === state.id) state.channels.set(raw.id, toChannel(raw));
  }

  async #send(plan: Plan, step: Step): Promise<unknown> {
    const { api } = this.deps;
    const spec = specOf(step);
    const body = step.body as Record<string, unknown> | undefined;
    const uploads = await uploadsFor(plan, step);
    if (spec.op === "POST /users/{user}/dm") {
      const dm = await api.users.createDM(String(step.pathParams.user));
      return api.channels.createMessage(dm.id, {
        ...(typeof body?.content === "string" ? { content: body.content } : {}),
        allowed_mentions: { parse: [] },
        ...(uploads.length > 0 ? { files: uploads } : {}),
      });
    }
    const reason = plan.rule
      ? `${label(plan, plan.actor.userId)} のルール「${plan.rule.name}」(変更 ${plan.id})`
      : `${label(plan, plan.actor.userId)} の依頼(変更 ${plan.id})`;
    const { method, path } = routeOf(step.op, step.pathParams);
    let payload: unknown = body;
    if (spec.op === "POST /channels/{channel}/messages") {
      // Pings only the users the approved text names; the nonce stops a retry from posting twice.
      const { files: _files, ...text } = body ?? {};
      payload = {
        ...text,
        allowed_mentions: { parse: ["users"] },
        nonce: sha256(step.idempotencyKey).slice(0, 25),
        enforce_nonce: true,
        ...(uploads.length > 0 ? { attachments: uploads.map((f, i) => ({ id: i, filename: f.name })) } : {}),
      };
    }
    const options = { reason, ...(payload !== undefined ? { body: payload } : {}), ...(uploads.length > 0 ? { files: uploads } : {}) };
    switch (method) {
      case "POST":
        return this.#rest.post(path, options);
      case "PUT":
        return this.#rest.put(path, options);
      case "PATCH":
        return this.#rest.patch(path, options);
      case "DELETE":
        return this.#rest.delete(path, { reason });
      default:
        throw new Error(`未対応のメソッド ${method}`);
    }
  }

  /**
   * Runs an approved plan. Preconditions and permissions are re-read from REST
   * first; `fresh` skips the precondition re-read for a plan proposed just now.
   */
  async execute(planId: string, opts: { fresh?: boolean } = {}): Promise<void> {
    const { store } = this.deps;
    const row = store.getPlan(planId);
    if (!row || !store.transitionPlan(planId, ["approved"], "executing")) return;
    const { plan } = row;
    const sleep = this.deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));

    {
      const rows = new Map(store.getSteps(plan.id).map((s) => [s.stepId, s]));
      const remaining = plan.steps.filter((s) => rows.get(s.id)?.state !== "done");
      const results = new Map<string, unknown>(plan.steps.filter((s) => rows.get(s.id)?.state === "done").map((s) => [s.id, rows.get(s.id)!.response]));
      let current: Step | undefined;
      try {
        const state = await this.#freshState(plan, remaining);
        if (!opts.fresh) await this.#checkPreconditions(plan, remaining, results);
        const problems = remaining.flatMap((s) => permissionProblems(s, { guild: state, actorId: plan.actor.userId, selfId: this.deps.selfId() }));
        if (problems.length > 0) throw new Aborted(`権限が足りなくなりました: ${problems.join(" / ")}`);

        let lastDm = 0;
        let lastRefresh = this.deps.now();
        for (const step of remaining) {
          current = step;
          const resolved: Step = { ...step, pathParams: resolveRefs(step.pathParams, results), ...(step.body !== undefined ? { body: resolveRefs(step.body, results) } : {}) };
          const spec = specOf(resolved);
          await this.#addChannel(state, resolved);
          const key = spec.target?.(resolved.pathParams, plan.guildId);
          const [before, channels] = await Promise.all([
            key ? this.resource(plan.guildId, key) : null,
            plan.rule ? this.#channelStates([resolved], plan.rule.allow) : undefined,
          ]);
          const stepProblems = [
            ...permissionProblems(resolved, { guild: state, actorId: plan.actor.userId, selfId: this.deps.selfId() }),
            // Values from earlier steps are known now, so a rule's allow list is checked on them too, and on the target as it is now.
            ...(plan.rule ? allowProblems([resolved], plan.rule.allow, key ? new Map([[step.id, before]]) : undefined, [step], channels) : []),
          ];
          if (stepProblems.length > 0) throw new Error(stepProblems.join(" / "));
          if (key) store.saveSnapshot(plan.id, step.id, key, before);
          if (spec.op === "POST /users/{user}/dm") {
            const wait = lastDm + DM_INTERVAL_MS - this.deps.now();
            if (wait > 0) await sleep(wait);
            lastDm = this.deps.now();
          }
          store.markStepInFlight(plan.id, step.id, { pathParams: resolved.pathParams, body: resolved.body });
          this.deps.beforeWrite?.(plan, resolved);
          const response = await this.#send(plan, resolved);
          const resultId = (response as { id?: string } | undefined)?.id ?? null;
          store.finishStep(plan.id, step.id, { state: "done", response: response ?? null, resultId });
          results.set(step.id, response ?? null);
          this.deps.onWrite?.(plan, resolved, response);
          // Progress on long plans, without editing the dialog on every step.
          if (plan.steps.length > 1 && this.deps.now() - lastRefresh >= PROGRESS_INTERVAL_MS) {
            lastRefresh = this.deps.now();
            await this.#refresh(plan.id).catch(() => undefined);
          }
        }
        current = undefined;
        if (plan.rules?.length) await this.#registerRules(plan, results);
        store.transitionPlan(plan.id, ["executing"], "succeeded", { reason: null });
        store.audit(plan.actor, "plan.succeeded", { steps: plan.steps.length }, plan.id);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        if (e instanceof Aborted) {
          store.transitionPlan(plan.id, ["executing"], "aborted", { reason: message });
          store.audit(plan.actor, "plan.aborted", { reason: message }, plan.id);
        } else {
          if (current) store.finishStep(plan.id, current.id, { state: "failed", error: message.slice(0, 500) });
          const reason = current
            ? `${current.id} で失敗: ${message.slice(0, 300)}`
            : e instanceof RuleNotRegistered ? message.slice(0, 400) : `実行前の確認で失敗: ${message.slice(0, 300)}`;
          store.transitionPlan(plan.id, ["executing"], "failed", { reason });
          store.audit(plan.actor, "plan.failed", { step: current?.id, error: message.slice(0, 500) }, plan.id);
          this.deps.log(`変更 ${plan.id} の実行に失敗`, e);
        }
      }
    }
    await this.#refresh(plan.id).catch((e) => this.deps.log(`変更 ${plan.id} の表示更新に失敗`, e));
  }

  /**
   * Registers the plan's rules with the steps' results filled in. A rule that
   * cannot be registered fails the plan; resuming registers the rest.
   */
  async #registerRules(plan: Plan, results: Map<string, unknown>): Promise<void> {
    const { store } = this.deps;
    for (const draft of plan.rules ?? []) {
      const key = `plan_rule:${plan.id}:${draft.key}`;
      if (store.getMeta(key)) continue;
      try {
        const resolved: PlanRuleDraft = {
          ...draft,
          allow: resolveRefs(draft.allow, results),
          ...(draft.params ? { params: resolveRefs(draft.params, results) } : {}),
        };
        const ruleId = this.deps.rules!.register(plan.guildId, plan.actor.userId, resolved);
        store.setMeta(key, ruleId);
      } catch (e) {
        throw new RuleNotRegistered(`ルール「${draft.name}」を登録できませんでした: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  /**
   * The state each remaining step relies on must be as it was at proposal.
   * Resources an already-finished step of this plan touched are skipped: the
   * plan itself changed them.
   */
  async #checkPreconditions(plan: Plan, remaining: Step[], done: Map<string, unknown>): Promise<void> {
    const keyOf = (s: Step) => specOf(s).target?.(s.pathParams, plan.guildId);
    const touched = new Set(plan.steps.filter((s) => done.has(s.id)).map(keyOf));
    const needed = new Set(remaining.map(keyOf));
    for (const pre of plan.preconditions) {
      if (!needed.has(pre.resource) || touched.has(pre.resource)) continue;
      const now = fingerprint(await this.resource(plan.guildId, pre.resource), pre.fields);
      if (now !== pre.fingerprint) throw new Aborted(`${pre.resource} の状態が提案のあとに変わりました`);
    }
  }

  async #expire(planId: string): Promise<boolean> {
    const reason = "期限切れになりました(5分)。もう一度頼んでください。";
    if (!this.deps.store.transitionPlan(planId, ["pending_approval"], "cancelled", { reason })) return false;
    this.deps.store.audit({ kind: "system" }, "plan.expire", {}, planId);
    return true;
  }

  /** Redraws a plan's dialog from the database. */
  async #refresh(planId: string): Promise<void> {
    const row = this.deps.store.getPlan(planId);
    if (!row?.channelId || !row.messageId) return;
    const steps: StepRow[] = this.deps.store.getSteps(planId);
    await this.deps.api.channels.editMessage(row.channelId, row.messageId, this.#render(row.plan, { status: row.status, steps, reason: row.reason }));
  }

  /** Expires unanswered dialogs and drops old snapshots. Called every minute. */
  async sweep(): Promise<void> {
    const now = this.deps.now();
    for (const row of this.deps.store.expiredPlans(new Date(now))) {
      if (await this.#expire(row.plan.id)) await this.#refresh(row.plan.id).catch((e) => this.deps.log(`変更 ${row.plan.id} の表示更新に失敗`, e));
    }
    this.deps.store.deleteSnapshotsBefore(new Date(now - SNAPSHOT_RETENTION_MS));
  }

  /** A restart interrupted these plans; whether the in-flight request landed is unknown. */
  async recover(): Promise<void> {
    const { store } = this.deps;
    for (const id of store.interruptedPlans()) {
      for (const step of store.getSteps(id)) {
        if (step.state === "in_flight") {
          store.finishStep(id, step.stepId, { state: "failed", error: "Botの再起動で中断しました(実行されたかは不明です。再開すると送り直します)" });
        }
      }
      store.transitionPlan(id, ["executing", "approved"], "failed", { reason: "Botの再起動で中断しました。" });
      store.audit({ kind: "system" }, "plan.interrupted", {}, id);
      await this.#refresh(id).catch((e) => this.deps.log(`変更 ${id} の表示更新に失敗`, e));
    }
  }
}
