import type { API } from "@discordjs/core";
import { InteractionType, MessageFlags } from "discord-api-types/v10";
import type { APIInteraction, APIMessage } from "discord-api-types/v10";
import type { Store } from "../db.ts";
import type { GuildCaches } from "../discord/cache.ts";
import type { GuildState } from "../discord/permissions.ts";
import type { Reader } from "../discord/reader.ts";
import { CATALOG } from "../plan/catalog.ts";
import { stepLines } from "../plan/dialog.ts";
import type { PrepareRulesInput } from "../plan/service.ts";
import { isRef } from "../plan/types.ts";
import type { Plan, PlanRuleDraft, RuleDryRun } from "../plan/types.ts";
import { badRefs, normalizeSteps, permissionProblems, PlanRejected, planRisk, visibilityProblems } from "../plan/validate.ts";
import { AdminDenied } from "./admin.ts";
import type { RuleAdmin } from "./admin.ts";
import { allowProblems } from "./allow.ts";
import type { RuleEngine } from "./engine.ts";
import { auditView, detailView, homeView, parseRuleCustomId, plansView } from "./panel.ts";
import type { Rendered } from "./panel.ts";
import { isTrigger } from "./triggers.ts";
import { DEFAULT_LIMITS } from "./types.ts";
import type { Rule, RuleDefinition, RuleProposal, RuleRun } from "./types.ts";

// Rules are made in conversation, inside a plan: propose_plan can carry rules
// next to its steps, and one approval runs the steps and registers the rules.
// Here they are checked and dry-run at proposal (prepare) and registered after
// the steps have run (register). /rules opens the management panel, which is
// only visible to whoever opened it.

/** Rules one plan may register. */
export const MAX_RULES_PER_PLAN = 5;

export interface RuleServiceDeps {
  api: API;
  store: Store;
  caches: Pick<GuildCaches, "get">;
  admin: RuleAdmin;
  engine: Pick<RuleEngine, "evaluate" | "ownerReader">;
  selfId: () => string;
  now: () => number;
  log: (message: string, error?: unknown) => void;
  /** Explains rule code from the code alone, paid for by the owner. */
  summarize?: (code: string, ownerId: string, trigger: string) => Promise<string | null>;
}

type DryRunInput = Pick<RuleProposal, "code" | "allow" | "trigger" | "params" | "sampleEvent">;

/** Display names from the cache: channels and roles; anything else stays an id. */
export function cacheLabel(guild: GuildState | null | undefined): (id: string) => string {
  return (id) => {
    const channel = guild?.channels.get(id);
    if (channel) return `#${channel.name}`;
    const role = guild?.roles.get(id);
    if (role) return id === guild!.id ? "@everyone" : `@${role.name ?? id}`;
    return id;
  };
}

/** Whether a value holds refs to a plan's step results. */
function hasRefs(value: unknown): boolean {
  if (isRef(value)) return true;
  if (Array.isArray(value)) return value.some(hasRefs);
  if (value && typeof value === "object") return Object.values(value).some(hasRefs);
  return false;
}

/** Channels an allow list pins its entries to. */
function pinnedIds(draft: Pick<RuleProposal, "allow">): string[] {
  const ids: string[] = [];
  for (const entry of draft.allow) {
    const spec = CATALOG.get(entry.op);
    if (!spec?.channel) continue;
    const schema = entry.path?.[spec.channel] as { enum?: unknown[]; const?: unknown } | undefined;
    for (const v of schema?.enum ?? (schema?.const !== undefined ? [schema.const] : [])) if (typeof v === "string") ids.push(v);
  }
  return ids;
}

export class RuleService {
  readonly deps: RuleServiceDeps;

  constructor(deps: RuleServiceDeps) {
    this.deps = deps;
  }

  #guild(guildId: string): GuildState {
    const guild = this.deps.caches.get(guildId)?.guild;
    if (!guild) throw new Error("サーバーの情報をまだ受信していません");
    return guild;
  }

  // --- Dry run ------------------------------------------------------------

  /** A real event to try the rule on, read with `reader`; otherwise the agent's sample. */
  async sample(guildId: string, ownerId: string, channelId: string, draft: Pick<RuleProposal, "trigger" | "sampleEvent">, reader: Pick<Reader, "get">): Promise<{ event: unknown; source: string | null }> {
    const event = draft.trigger.event;
    try {
      if ((event === "MESSAGE_CREATE" || event === "MESSAGE_UPDATE") && channelId) {
        const messages = (await reader.get(`/channels/${channelId}/messages`, { limit: 10 })) as APIMessage[];
        const message = messages.find((m) => !m.author.bot && !m.webhook_id);
        if (message) return { event: { ...message, guild_id: guildId }, source: "このチャンネルの直近のメッセージ" };
      }
      if (event === "GUILD_MEMBER_ADD" || event === "GUILD_MEMBER_UPDATE") {
        const member = await reader.get(`/guilds/${guildId}/members/${ownerId}`);
        if (member) return { event: { ...(member as object), guild_id: guildId }, source: "依頼者のメンバー情報" };
      }
    } catch {
      // Fall back to the sample below.
    }
    if (draft.sampleEvent !== undefined) return { event: draft.sampleEvent, source: "AIが用意した例のイベント" };
    return { event: null, source: null };
  }

  /**
   * Runs the rule's code on one event and checks what it asks for, without
   * changing anything. `shareable` limits which channels the result may name.
   */
  async dryRun(guildId: string, ownerId: string, channelId: string, rule: DryRunInput, reader: Pick<Reader, "get">, shareable?: Set<string>): Promise<RuleDryRun> {
    const { event, source } = await this.sample(guildId, ownerId, channelId, rule, reader);
    if (event === null) return { source: null, outcome: "no_event", lines: [], problems: [], logs: [] };
    const result = await this.deps.engine.evaluate({ guildId, ownerId, code: rule.code, ...(rule.params ? { params: rule.params } : {}) }, event, reader);
    if (result.kind === "error") return { source, outcome: "error", lines: [], problems: [result.error], logs: result.logs };
    if (result.kind === "none") return { source, outcome: "none", lines: [], problems: [], logs: result.logs };
    const guild = this.#guild(guildId);
    let steps;
    try {
      steps = normalizeSteps(result.drafts, guildId, "dryrun");
    } catch (e) {
      return { source, outcome: "error", lines: [], problems: e instanceof PlanRejected ? e.reasons : [String(e)], logs: result.logs };
    }
    const ctx = { guild, actorId: ownerId, selfId: this.deps.selfId() };
    const problems = [
      ...allowProblems(steps, rule.allow),
      ...steps.flatMap((s) => permissionProblems(s, ctx)),
      ...(shareable ? steps.flatMap((s) => visibilityProblems(s, shareable)) : []),
    ];
    const label = cacheLabel(guild);
    const labels: Record<string, string> = {};
    for (const step of steps) for (const v of Object.values(step.pathParams)) if (typeof v === "string") labels[v] = label(v);
    const now = new Date(this.deps.now()).toISOString();
    const pseudo: Plan = { id: "dryrun", guildId, actor: { kind: "user", userId: ownerId, via: "rule" }, preconditions: [], steps, labels, risk: planRisk(steps), hash: "", createdAt: now, expiresAt: now };
    // Names would come from what the code read; nothing outside this channel's reach is shown.
    return { source, outcome: "steps", lines: problems.some((p) => p.includes("この場所では扱えません")) ? [] : stepLines(pseudo), problems, logs: result.logs };
  }

  // --- Rules inside a plan -------------------------------------------------

  /**
   * Checks the rules a plan proposes, dry-runs and explains each one. A rule
   * whose allow list or params wait on the plan's steps is only tried for
   * errors, since the values it needs do not exist yet.
   */
  async prepare(input: PrepareRulesInput): Promise<PlanRuleDraft[]> {
    if (input.rules.length > MAX_RULES_PER_PLAN) throw new PlanRejected([`ルールは1つの変更につき${MAX_RULES_PER_PLAN}個までです`]);
    const stepIds = new Set(input.stepIds);
    const drafts: PlanRuleDraft[] = [];
    const problems: string[] = [];
    for (const [i, r] of input.rules.entries()) {
      const where = `ルール「${r.name}」`;
      const own: string[] = [];
      if (!r.name.trim()) own.push("名前がありません");
      if (!isTrigger(r.trigger.event)) own.push(`きっかけ ${r.trigger.event} には対応していません`);
      for (const ref of [...badRefs(r.allow, stepIds), ...badRefs(r.params ?? {}, stepIds)]) own.push(`参照 ${ref} はこの変更のステップの結果を指していません`);
      const definition: RuleDefinition = { name: r.name, sourcePrompt: "", trigger: r.trigger, allow: r.allow, code: r.code, summary: null, limits: DEFAULT_LIMITS };
      if (isTrigger(r.trigger.event)) own.push(...this.deps.admin.ownershipProblems(input.guildId, input.ownerId, definition).filter((p) => !p.startsWith("きっかけ")));
      for (const id of pinnedIds(r)) {
        if (!input.shareable.has(id)) own.push(`チャンネル ${id} はこの場所では扱えません。そのチャンネルを見られる人だけがいる場所で頼んでください`);
      }
      let replaces: PlanRuleDraft["replaces"];
      if (r.replaces) {
        const rule = this.deps.store.getRule(r.replaces);
        if (!rule || rule.guildId !== input.guildId) own.push(`ルール ${r.replaces} が見つかりません`);
        else if (rule.ownerId !== input.ownerId) own.push("ルールを直せるのは作成者だけです");
        else {
          // The old version's contents follow the same visibility as the new one's.
          const shown = pinnedIds(rule).every((id) => input.shareable.has(id));
          replaces = {
            id: rule.id,
            name: rule.name,
            version: rule.version,
            ...(shown ? { before: { summary: rule.summary, trigger: rule.trigger, allow: rule.allow, ...(rule.params ? { params: rule.params } : {}) } } : {}),
          };
        }
      }
      if (own.length > 0) {
        problems.push(...own.map((p) => `${where}: ${p}`));
        continue;
      }

      let dry = r.dry;
      if (!dry) {
        const waits = hasRefs(r.allow) || hasRefs(r.params);
        const tried = input.reader
          ? await this.dryRun(input.guildId, input.ownerId, input.channelId, r, input.reader, input.shareable)
          : { source: null, outcome: "no_event" as const, lines: [], problems: [], logs: [] };
        if (waits) {
          if (tried.outcome === "error") problems.push(...tried.problems.map((p) => `${where}: ドライラン: ${p}`));
          dry = { source: null, outcome: "pending", lines: [], problems: [], logs: tried.logs };
        } else if (tried.outcome === "no_event" && r.sampleEvent === undefined && input.reader) {
          problems.push(`${where}: このきっかけは試せる実際のイベントがないので、sample_event を付けて出し直してください`);
        } else {
          problems.push(...tried.problems.map((p) => `${where}: ドライラン: ${p}`));
          dry = tried;
        }
      }
      if (!dry || problems.length > 0) continue;
      drafts.push({
        key: `r${i + 1}`,
        name: r.name.slice(0, 60),
        trigger: r.trigger,
        allow: r.allow,
        code: r.code,
        ...(r.params ? { params: r.params } : {}),
        summary: r.summary !== undefined ? r.summary : await this.#summarize(r.code, input.ownerId, r.trigger.event),
        ...(replaces ? { replaces } : {}),
        dry,
        ...(r.sampleEvent !== undefined ? { sampleEvent: r.sampleEvent } : {}),
        request: r.request ?? input.request,
      });
    }
    if (problems.length > 0) throw new PlanRejected(problems);
    return drafts;
  }

  /** Registers a plan's rule once its steps have run. Ownership is checked again on the filled-in values. */
  register(guildId: string, ownerId: string, draft: PlanRuleDraft): string {
    const definition: RuleDefinition = {
      name: draft.name,
      sourcePrompt: draft.request,
      trigger: draft.trigger,
      allow: draft.allow,
      code: draft.code,
      ...(draft.params ? { params: draft.params } : {}),
      summary: draft.summary,
      limits: DEFAULT_LIMITS,
    };
    return this.deps.admin.save(guildId, ownerId, definition, draft.replaces?.id).id;
  }

  async #summarize(code: string, ownerId: string, trigger: string): Promise<string | null> {
    if (!this.deps.summarize) return null;
    try {
      return await this.deps.summarize(code, ownerId, trigger);
    } catch (e) {
      this.deps.log("ルールのコードの要約に失敗", e);
      return null;
    }
  }

  /** The rules of the speaker's that the agent may read here, for a request to change one. */
  /**
   * Recent runs of the owner's rule. Errors and logs can carry event data, so they
   * follow the rule's own visibility: null when the rule is not theirs or not shown here.
   */
  runsFor(guildId: string, ownerId: string, ruleId: string, shareable: Set<string>, limit: number): RuleRun[] | null {
    const item = this.rulesFor(guildId, ownerId, shareable).find((r) => r.rule.id === ruleId);
    if (!item?.shown) return null;
    return this.deps.store.recentRuleRuns(ruleId, limit);
  }

  rulesFor(guildId: string, ownerId: string, shareable: Set<string>): Array<{ rule: Rule; shown: boolean }> {
    return this.deps.store.listRules(guildId, ownerId).map((rule) => ({ rule, shown: pinnedIds(rule).every((id) => shareable.has(id)) }));
  }

  // --- Interactions -------------------------------------------------------

  async handleCommand(interaction: APIInteraction): Promise<boolean> {
    if (interaction.type !== InteractionType.ApplicationCommand || interaction.data.name !== "rules") return false;
    const userId = interaction.member?.user.id;
    if (!userId || !interaction.guild_id) return true;
    await this.deps.api.interactions.reply(interaction.id, interaction.token, this.#home(interaction.guild_id, userId));
    return true;
  }

  #home(guildId: string, userId: string, notice?: string): Rendered {
    const { admin, store } = this.deps;
    const rules = admin.list(guildId, userId);
    return homeView({
      rules,
      userId,
      canSeeAll: admin.canSeeAll(guildId, userId),
      canHalt: admin.canHalt(guildId, userId),
      halted: admin.halted(guildId),
      lastRuns: new Map(rules.map((r) => [r.id, store.recentRuleRuns(r.id, 1)[0]])),
      ...(notice ? { notice } : {}),
    });
  }

  #detail(guildId: string, userId: string, ruleId: string, extra: { dry?: RuleDryRun; notice?: string; confirmDelete?: boolean } = {}): Rendered {
    const { admin } = this.deps;
    const rule = admin.get(guildId, userId, ruleId);
    return detailView({ rule, runs: admin.runs(guildId, userId, ruleId), can: admin.abilities(guildId, userId, rule), ...extra }, cacheLabel(this.deps.caches.get(guildId)?.guild));
  }

  async handleInteraction(interaction: APIInteraction): Promise<boolean> {
    if (interaction.type !== InteractionType.MessageComponent && interaction.type !== InteractionType.ModalSubmit) return false;
    const parsed = parseRuleCustomId(interaction.data.custom_id);
    if (!parsed) return false;
    const { api } = this.deps;
    const userId = interaction.member?.user.id;
    const guildId = interaction.guild_id;
    if (!userId || !guildId) return true;
    const ephemeral = (content: string) => api.interactions.reply(interaction.id, interaction.token, { content, flags: MessageFlags.Ephemeral, allowed_mentions: { parse: [] } });
    // The panel's views replace each other in place; UPDATE_MESSAGE cannot change the ephemeral flag.
    const update = (view: Rendered) => api.interactions.updateMessage(interaction.id, interaction.token, { ...view, flags: MessageFlags.IsComponentsV2 });
    const edit = (view: Rendered) => api.interactions.editReply(interaction.application_id, interaction.token, { ...view, flags: MessageFlags.IsComponentsV2 });

    try {
      switch (parsed.action) {
        case "home":
          await update(this.#home(guildId, userId));
          return true;
        case "open": {
          const values = "values" in interaction.data ? interaction.data.values : [];
          await update(this.#detail(guildId, userId, values[0] ?? parsed.arg));
          return true;
        }
        case "enable":
        case "disable": {
          const rule = this.deps.admin.setEnabled(guildId, userId, parsed.arg, parsed.action === "enable");
          await update(this.#detail(guildId, userId, rule.id, { notice: rule.enabled ? "有効にしました" : "止めました" }));
          return true;
        }
        case "dry": {
          const rule = this.deps.admin.get(guildId, userId, parsed.arg);
          if (rule.ownerId !== userId) {
            await ephemeral("ドライランは作成者だけが使えます");
            return true;
          }
          await api.interactions.deferMessageUpdate(interaction.id, interaction.token);
          const channelId = interaction.channel?.id ?? "";
          const dry = await this.dryRun(guildId, userId, channelId, rule, this.deps.engine.ownerReader(guildId, userId, channelId));
          await edit(this.#detail(guildId, userId, rule.id, { dry }));
          return true;
        }
        case "delete":
          await update(this.#detail(guildId, userId, parsed.arg, { confirmDelete: true }));
          return true;
        case "delete2": {
          const rule = this.deps.admin.get(guildId, userId, parsed.arg);
          this.deps.admin.remove(guildId, userId, rule.id);
          await update(this.#home(guildId, userId, `ルール「${rule.name}」を削除しました`));
          return true;
        }
        case "code": {
          const rule = this.deps.admin.get(guildId, userId, parsed.arg);
          await this.#codeFile(interaction, rule.name, rule);
          return true;
        }
        case "plans":
          await update(plansView(this.deps.admin.plans(guildId, userId), this.deps.admin.canSeeAll(guildId, userId)));
          return true;
        case "audit":
          await update(auditView(this.deps.admin.audit(guildId, userId), this.deps.admin.canSeeAll(guildId, userId)));
          return true;
        case "halt":
          this.deps.admin.halt(guildId, userId);
          await update(this.#home(guildId, userId, "全ルールを止めました。再開するまでどのルールも動きません。"));
          return true;
        case "resume":
          this.deps.admin.resume(guildId, userId);
          await update(this.#home(guildId, userId, "全ルールを再開しました"));
          return true;
      }
    } catch (e) {
      if (e instanceof AdminDenied) {
        await ephemeral(e.message.slice(0, 1800));
        return true;
      }
      throw e;
    }
  }

  async #codeFile(interaction: APIInteraction, name: string, definition: Pick<Rule, "trigger" | "allow" | "code" | "params">): Promise<void> {
    const json = JSON.stringify({ trigger: definition.trigger, allow: definition.allow, params: definition.params ?? null }, null, 2);
    await this.deps.api.interactions.reply(interaction.id, interaction.token, {
      content: `ルール「${name}」のコードと許す操作です`,
      files: [
        { name: "rule.js", data: Buffer.from(definition.code) },
        { name: "rule.json", data: Buffer.from(json) },
      ],
      flags: MessageFlags.Ephemeral,
      allowed_mentions: { parse: [] },
    });
  }
}
