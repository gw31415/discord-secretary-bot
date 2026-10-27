import { toUploadable } from "../media.ts";
import type { API } from "@discordjs/core";
import { InteractionType, MessageFlags, PermissionFlagsBits } from "discord-api-types/v10";
import { commandEvent, commandName, permissionBits, RESERVED_COMMANDS } from "./command.ts";
import { InteractionAnswer, interactionEvent, isRuleInteraction } from "./interaction.ts";
import type { CommandReport } from "./engine.ts";
import type { APIInteraction, APIMessage } from "discord-api-types/v10";
import type { Store, WasmSource } from "../db.ts";
import type { GuildCaches } from "../discord/cache.ts";
import { guildCommandIds } from "../discord/commands.ts";
import type { GuildState } from "../discord/permissions.ts";
import type { Reader } from "../discord/reader.ts";
import { CATALOG } from "../plan/catalog.ts";
import { stepLines } from "../plan/dialog.ts";
import type { PrepareRulesInput } from "../plan/service.ts";
import { isRef } from "../plan/types.ts";
import type { Plan, PlanRuleDraft, RuleDryRun } from "../plan/types.ts";
import { badRefs, normalizeSteps, permissionProblems, PlanRejected, planRisk, stepProblems } from "../plan/validate.ts";
import { AdminDenied } from "./admin.ts";
import type { RuleAdmin } from "./admin.ts";
import { allowProblems } from "./allow.ts";
import { attachmentsFor } from "../plan/files.ts";
import type { RuleEngine } from "./engine.ts";
import { auditView, commandsView, commandView, DELETE_CHOICE, detailView, homeView, parseRuleCustomId, plansView, RULE_PAGES } from "./panel.ts";
import type { RulePage } from "./panel.ts";
import type { Rendered } from "./panel.ts";
import { syntheticEvent, triggerEvents, triggerProblems } from "./triggers.ts";
import { commandProblems, MAX_CUSTOM_COMMANDS, sampleCommandEvent } from "./command.ts";
import type { CommandSpec, CommandVisibility } from "./command.ts";
import { VISIBILITY_CHOICES } from "./command.ts";
import { defaultVisibility, showsToAll } from "../agent/judge.ts";
import { DEFAULT_LIMITS, ruleLimits } from "./types.ts";
import { ModuleRejected, sizeLabel, wasmRef } from "../wasm/registry.ts";
import type { WasmRegistry } from "../wasm/registry.ts";
import type { WasmRef } from "../plan/types.ts";
import type { Rule, RuleDefinition, RuleProgram, RuleProposal, RuleRun, RuleTrigger } from "./types.ts";

// Rules are made in conversation, inside a plan: propose_plan can carry rules
// next to its steps, and one approval runs the steps and registers the rules.
// Here they are checked and dry-run at proposal (prepare) and registered after
// the steps have run (register). The "ルール" section of /settings is the
// management panel, only visible to whoever opened it.

/** Rules one plan may register. */
export const MAX_RULES_PER_PLAN = 5;

export interface RuleServiceDeps {
  api: API;
  store: Store;
  caches: Pick<GuildCaches, "get">;
  admin: RuleAdmin;
  engine: Pick<RuleEngine, "evaluate" | "ownerReader" | "runCommand" | "dispatchInteraction">;
  selfId: () => string;
  now: () => number;
  log: (message: string, error?: unknown) => void;
  /** Explains rule code from the code alone, paid for by the owner. */
  /** `language` is set for sources compiled to Wasm; JavaScript otherwise. */
  summarize?: (code: string, ownerId: string, trigger: string, language?: string) => Promise<string | null>;
  /** How likely a command's reply is meant for everyone (0 to 1), by that person's judge model (the owner's at approval, the runner's when run); null without one. */
  /** Uploaded Wasm modules a rule may run instead of code. */
  wasm?: Pick<WasmRegistry, "resolve" | "source">;
  visibilityScore?: (input: { userId: string; command: CommandSpec; options: Record<string, unknown>; reply: string; images: number; steps: number }) => Promise<number | null>;
}

/** `wasm` is the module's sha256 here, already resolved. */
type DryRunInput = Pick<RuleProposal, "allow" | "trigger" | "params" | "sampleEvent" | "replaces"> & { program: RuleProgram; id?: string };

/** How the dialog and panel describe a module, in place of an explanation of code. */
export function wasmSummary(ref: WasmRef): string {
  const by = ref.producers.length ? `、${ref.producers.slice(0, 2).join("・")} 製` : "";
  if (ref.source) return `Botが ${ref.source.language} のソースからコンパイルしたWasmモジュール「${ref.name}」(${sizeLabel(ref.size)}、<@${ref.ownerId}> が登録、sha256 ${ref.sha256.slice(0, 12)})を動かします。`;
  return `アップロードされたWasmモジュール「${ref.name}」(${sizeLabel(ref.size)}${by}、<@${ref.ownerId}> が登録、sha256 ${ref.sha256.slice(0, 12)})を動かします。中身はAIの説明の対象外です。`;
}

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
    if (event === "COMMAND" && draft.trigger.command) {
      const owner = this.deps.caches.get(guildId)?.guild?.members.get(ownerId);
      return { event: sampleCommandEvent(draft.trigger.command, guildId, channelId, owner, draft.sampleEvent), source: draft.sampleEvent !== undefined ? "AIが用意したオプションであなたが実行したとき" : "あなたがここで実行したとき" };
    }
    // Events the bot makes itself need no sample: the dry run makes one like the real thing.
    const synthetic = syntheticEvent(event, guildId, draft.trigger, this.deps.now());
    if (synthetic) return { event: synthetic, source: "いま発火したとしたときのイベント" };
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
    // A saved rule (or a new version of one) is tried on its current state; nothing a dry run sets is kept.
    const saved = rule.id ?? rule.replaces;
    const state = saved && this.deps.store.getRule(saved)?.ownerId === ownerId ? this.deps.store.getRuleState(saved) : null;
    const result = await this.deps.engine.evaluate({ guildId, ownerId, program: rule.program, ...(rule.params ? { params: rule.params } : {}) }, event, reader, rule.trigger.event, undefined, state);
    if (result.kind === "error") return { source, outcome: "error", lines: [], problems: [result.error], logs: result.logs };
    const kept = {
      ...(result.state ? { state: JSON.stringify(result.state.value) } : {}),
      ...(result.reply !== undefined ? { reply: result.reply } : {}),
      ...(result.response !== undefined ? { response: JSON.stringify(result.response) } : {}),
      ...(result.images?.length ? { images: result.images.length } : {}),
    };
    if (result.kind === "none") return { source, outcome: "none", lines: [], problems: [], logs: result.logs, ...kept };
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
      ...steps.flatMap((s) => (shareable ? stepProblems(s, ctx, shareable) : permissionProblems(s, ctx))),
      ...attachmentsFor(steps, [Object.fromEntries((result.images ?? []).map((image, i) => [`img${i + 1}`, { name: image.name, data: image.data.toString("base64") }]))]).problems,
    ];
    const label = cacheLabel(guild);
    const labels: Record<string, string> = {};
    for (const step of steps) for (const v of Object.values(step.pathParams)) if (typeof v === "string") labels[v] = label(v);
    const now = new Date(this.deps.now()).toISOString();
    const pseudo: Plan = { id: "dryrun", guildId, actor: { kind: "user", userId: ownerId, via: "rule" }, preconditions: [], steps, labels, risk: planRisk(steps), hash: "", createdAt: now, expiresAt: now };
    // Names would come from what the code read; nothing outside this channel's reach is shown.
    return { source, outcome: "steps", lines: problems.some((p) => p.includes("この場所では扱えません")) ? [] : stepLines(pseudo), problems, logs: result.logs, ...kept };
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
    for (const [i, proposed] of input.rules.entries()) {
      const where = `ルール「${proposed.name}」`;
      const own: string[] = [];
      if (!proposed.name.trim()) own.push("名前がありません");
      // A module named by the request runs instead of code, pinned to the build found now.
      const code = proposed.program.kind === "js" ? proposed.program.code : null;
      let wasm: WasmRef | undefined;
      if (proposed.program.kind === "wasm") {
        try {
          if (!this.deps.wasm) throw new ModuleRejected("Wasmのルールはここでは作れません");
          const found = this.deps.wasm.resolve(input.ownerId, this.deps.caches.get(input.guildId)?.guild, proposed.program.module);
          wasm = wasmRef(found, this.deps.wasm.source(found.sha256));
        } catch (e) {
          own.push(e instanceof Error ? e.message : String(e));
        }
      } else if (!code?.trim()) own.push("code(または wasm)がありません");
      const program: RuleProgram = code !== null ? { kind: "js", code } : { kind: "wasm", sha256: wasm?.sha256 ?? "" };
      const r = { ...proposed, program };
      const triggerIssues = triggerProblems(r.trigger);
      own.push(...triggerIssues);
      for (const ref of [...badRefs(r.allow, stepIds), ...badRefs(r.params ?? {}, stepIds)]) own.push(`参照 ${ref} はこの変更のステップの結果を指していません`);
      const definition: RuleDefinition = { name: r.name, sourcePrompt: "", trigger: r.trigger, allow: r.allow, program, summary: null, limits: ruleLimits(r.limits) };
      // A pinned channel this conversation may not show gets only that answer, not who holds which permission there.
      const hiddenPins = pinnedIds(r).filter((id) => !input.shareable.has(id));
      if (triggerIssues.length === 0 && hiddenPins.length === 0) own.push(...this.deps.admin.ownershipProblems(input.guildId, input.ownerId, definition).filter((p) => !p.startsWith("きっかけ")));
      if (r.trigger.command && triggerIssues.length === 0) {
        own.push(...this.commandNameProblems(input.guildId, r.trigger.command.name, r.replaces, input.rules.slice(0, i).map((o) => o.trigger.command?.name)));
      }
      for (const id of hiddenPins) own.push(`チャンネル ${id} はこの場所では扱えません。そのチャンネルを見られる人だけがいる場所で頼んでください`);
      let replaces: PlanRuleDraft["replaces"];
      if (r.replaces) {
        const rule = this.deps.store.getRule(r.replaces);
        // Someone else's rule reads the same as a missing one, so its id tells nothing.
        if (!rule || rule.guildId !== input.guildId || rule.ownerId !== input.ownerId) own.push(`ルール ${r.replaces} は見つからないか、あなたのルールではありません(直せるのは作成者だけです)`);
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
        trigger: await this.#withVisibility(input.ownerId, r, dry),
        allow: r.allow,
        program: wasm ? { kind: "wasm", module: wasm } : { kind: "js", code: code ?? "" },
        ...(r.params ? { params: r.params } : {}),
        ...(r.limits ? { limits: ruleLimits(r.limits) } : {}),
        summary: wasm
          ? wasm.source
            ? ((await this.#summarize(wasm.source.files.map((f) => `// ${f.path}\n${f.content}`).join("\n\n"), input.ownerId, triggerEvents(r.trigger).join("・"), wasm.source.language)) ?? wasmSummary(wasm))
            : wasmSummary(wasm)
          : r.summary !== undefined
            ? r.summary
            : await this.#summarize(code ?? "", input.ownerId, triggerEvents(r.trigger).join("・")),
        ...(replaces ? { replaces } : {}),
        dry,
        ...(r.sampleEvent !== undefined ? { sampleEvent: r.sampleEvent } : {}),
        request: r.request ?? input.request,
      });
    }
    if (problems.length > 0) throw new PlanRejected(problems);
    return drafts;
  }

  /**
   * A command whose request did not say who sees its replies starts the dialog
   * on the judge model's pick, from the dry run's reply; the requester can change it there.
   */
  async #withVisibility(ownerId: string, r: { trigger: RuleTrigger; sampleEvent?: unknown }, dry: RuleDryRun): Promise<RuleTrigger> {
    const command = r.trigger.command;
    if (!command || command.visibility) return r.trigger;
    let visibility: CommandVisibility = "private";
    try {
      const score = await this.deps.visibilityScore?.({
        userId: ownerId,
        command,
        options: ((r.sampleEvent as { options?: Record<string, unknown> } | undefined)?.options ?? {}),
        reply: dry.reply ?? "",
        images: dry.images ?? 0,
        steps: dry.lines.length,
      });
      if (typeof score === "number") visibility = defaultVisibility(score);
    } catch (e) {
      this.deps.log(`コマンド /${command.name} の公開の既定値を決められませんでした`, e);
    }
    return { ...r.trigger, command: { ...command, visibility } };
  }

  /** A command name must be free in the server, counting this plan's earlier rules; `replaces` may keep its own. */
  commandNameProblems(guildId: string, name: string, replaces: string | undefined, earlier: Array<string | undefined> = []): string[] {
    const others = this.deps.store.enabledRules(guildId, "COMMAND").filter((rule) => rule.id !== replaces);
    const taken = new Set([...others.map((rule) => rule.trigger.command?.name ?? ""), ...earlier.filter((n): n is string => !!n)]);
    const problems = commandProblems({ name, description: "-" }, taken).filter((p) => p.includes("使っています"));
    if (!taken.has(name) && others.length >= MAX_CUSTOM_COMMANDS) problems.push(`コマンドは1つのサーバーに${MAX_CUSTOM_COMMANDS}個までです`);
    return problems;
  }

  /** Registers a plan's rule once its steps have run. Ownership is checked again on the filled-in values. */
  register(guildId: string, ownerId: string, draft: PlanRuleDraft): string {
    const definition: RuleDefinition = {
      name: draft.name,
      sourcePrompt: draft.request,
      trigger: draft.trigger,
      allow: draft.allow,
      program: draft.program.kind === "wasm" ? { kind: "wasm", sha256: draft.program.module.sha256 } : draft.program,
      ...(draft.params ? { params: draft.params } : {}),
      summary: draft.summary,
      limits: draft.limits ?? DEFAULT_LIMITS,
    };
    return this.deps.admin.save(guildId, ownerId, definition, draft.replaces?.id).id;
  }

  async #summarize(code: string, ownerId: string, trigger: string, language?: string): Promise<string | null> {
    if (!this.deps.summarize) return null;
    try {
      return await this.deps.summarize(code, ownerId, trigger, language);
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

  /** The state, like the runs, can carry event data, so it comes only with a rule that may be shown here. */
  rulesFor(guildId: string, ownerId: string, shareable: Set<string>): Array<{ rule: Rule; shown: boolean; state?: unknown }> {
    return this.deps.store.listRules(guildId, ownerId).map((rule) => {
      const shown = pinnedIds(rule).every((id) => shareable.has(id));
      return { rule, shown, ...(shown ? { state: this.deps.store.getRuleState(rule.id) } : {}) };
    });
  }

  // --- Interactions -------------------------------------------------------

  /** A custom slash command: runs its rule and tells whoever ran it how it went. */
  async handleCustomCommand(interaction: APIInteraction): Promise<boolean> {
    const name = commandName(interaction);
    if (!name || RESERVED_COMMANDS.has(name)) return false;
    const { api, store } = this.deps;
    const guildId = interaction.guild_id;
    const member = interaction.member;
    if (!guildId || !member) return true;
    const rule = store.enabledRules(guildId, "COMMAND").find((r) => r.trigger.command?.name === name);
    const ephemeral = (content: string) => api.interactions.reply(interaction.id, interaction.token, { content, flags: MessageFlags.Ephemeral, allowed_mentions: { parse: [] } });
    if (!rule?.trigger.command) {
      await ephemeral("このコマンドは今は使えません(ルールが止まっているか、削除されました)");
      return true;
    }
    const needed = permissionBits(rule.trigger.command.permissions);
    // Discord sends the member's permissions in this channel with the interaction.
    if (needed && (BigInt(member.permissions) & needed) !== needed) {
      await ephemeral(`このコマンドを使うには ${rule.trigger.command.permissions!.join(", ")} の権限が必要です`);
      return true;
    }
    const spec = rule.trigger.command;
    const visibility = spec.visibility ?? "auto";
    // The deferred reply's visibility is fixed now, so "auto" starts private and
    // moves to a public follow-up if the judge says so.
    await api.interactions.defer(interaction.id, interaction.token, visibility === "public" ? {} : { flags: MessageFlags.Ephemeral });
    const event = commandEvent(interaction);
    let report: CommandReport;
    try {
      report = await this.deps.engine.runCommand(rule, event, member.user.id);
    } catch (e) {
      this.deps.log(`コマンド /${name} の実行に失敗`, e);
      report = { outcome: "failed", error: "実行中にエラーが起きました", reply: null, images: [], steps: 0 };
    }
    const content = commandReplyText(rule.name, report);
    const files = commandFailed(report) ? [] : await toUploadable(report.images.map((i) => ({ name: i.name, data: i.data })));
    const body = { content, allowed_mentions: { parse: [] }, ...(files.length ? { files } : {}) };
    if (visibility === "auto" && (report.reply || files.length) && !commandFailed(report) && (await this.#showToAll(member.user.id, spec, event, report))) {
      await api.interactions.followUp(interaction.application_id, interaction.token, body);
      await api.interactions.deleteReply(interaction.application_id, interaction.token);
    } else {
      await api.interactions.editReply(interaction.application_id, interaction.token, body);
    }
    return true;
  }

  /**
   * A press or form on a message that is not the bot's own panel goes to the
   * server's INTERACTION_CREATE rules; false for anything else.
   */
  async handleRuleInteraction(interaction: APIInteraction): Promise<boolean> {
    if (!isRuleInteraction(interaction)) return false;
    const guildId = interaction.guild_id;
    if (!guildId || !interaction.member) return false;
    const answer = new InteractionAnswer(this.deps.api, interaction, this.deps.log);
    const { fired, limited } = this.deps.engine.dispatchInteraction(guildId, interactionEvent(interaction), answer);
    if (fired === 0) {
      await answer.note(limited ? "混み合っています。少し待ってからもう一度試してください" : "これに応えるルールは今はありません");
      return true;
    }
    answer.arm();
    return true;
  }

  /** The judge model of whoever ran the command decides; without one, or on any error, the reply stays private. */
  async #showToAll(userId: string, spec: CommandSpec, event: Record<string, unknown>, report: CommandReport): Promise<boolean> {
    if (!this.deps.visibilityScore) return false;
    try {
      return showsToAll((await this.deps.visibilityScore({ userId, command: spec, options: (event.options ?? {}) as Record<string, unknown>, reply: report.reply ?? "", images: report.images.length, steps: report.steps })) ?? 0);
    } catch (e) {
      this.deps.log(`コマンド /${spec.name} の公開判定に失敗`, e);
      return false;
    }
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

  #detail(guildId: string, userId: string, ruleId: string, extra: { dry?: RuleDryRun; notice?: string; confirmDelete?: boolean; page?: RulePage } = {}): Rendered {
    const { admin } = this.deps;
    const rule = admin.get(guildId, userId, ruleId);
    return detailView(
      { rule, userId, runs: admin.runs(guildId, userId, ruleId), can: admin.abilities(guildId, userId, rule), state: this.deps.store.getRuleState(rule.id), ...this.#wasmSource(rule), ...extra },
      cacheLabel(this.deps.caches.get(guildId)?.guild),
    );
  }

  /**
   * The server's enabled commands the presser may run (Discord sends their
   * permissions in this channel with the interaction), and their own commands.
   */
  #commands(guildId: string, userId: string, permissions: string, notice?: string): Rendered {
    const bits = BigInt(permissions);
    const canRun = (r: Rule) => {
      const needed = permissionBits(r.trigger.command!.permissions);
      return (bits & PermissionFlagsBits.Administrator) !== 0n || (bits & needed) === needed;
    };
    const rules = this.deps.store
      .listRules(guildId)
      .filter((r) => r.trigger.command && triggerEvents(r.trigger).includes("COMMAND") && (r.ownerId === userId || (r.enabled && canRun(r))))
      .sort((a, b) => a.trigger.command!.name.localeCompare(b.trigger.command!.name));
    return commandsView({ rules, userId, ids: guildCommandIds(this.deps.store, guildId), ...(notice ? { notice } : {}) });
  }

  /** Only the owner manages a command here; the rules panel covers the rest. */
  #command(guildId: string, userId: string, ruleId: string, extra: { notice?: string; confirmDelete?: boolean } = {}): Rendered {
    const rule = this.deps.admin.get(guildId, userId, ruleId);
    if (rule.ownerId !== userId) throw new AdminDenied("コマンドを管理できるのは作成者だけです");
    if (!rule.trigger.command) throw new AdminDenied("このルールはコマンドではありません");
    return commandView({ rule, ids: guildCommandIds(this.deps.store, guildId), ...extra });
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
        case "commands":
          await update(this.#commands(guildId, userId, interaction.member?.permissions ?? "0"));
          return true;
        case "cmd": {
          const values = "values" in interaction.data ? interaction.data.values : [];
          await update(this.#command(guildId, userId, values[0] ?? parsed.arg));
          return true;
        }
        case "cmdvis": {
          const value = interaction.type === InteractionType.MessageComponent && "values" in interaction.data ? interaction.data.values[0] : undefined;
          const rule = this.deps.admin.setVisibility(guildId, userId, parsed.arg, value as CommandVisibility);
          const label = VISIBILITY_CHOICES.find((o) => o.value === rule.trigger.command?.visibility)?.label ?? "";
          await update(this.#command(guildId, userId, rule.id, { notice: `「${label}」にしました` }));
          return true;
        }
        case "cmddel":
          await update(this.#command(guildId, userId, parsed.arg, { confirmDelete: true }));
          return true;
        case "cmddel2": {
          const rule = this.deps.admin.get(guildId, userId, parsed.arg);
          this.deps.admin.remove(guildId, userId, rule.id);
          await update(this.#commands(guildId, userId, interaction.member?.permissions ?? "0", `コマンド /${rule.trigger.command?.name ?? ""} とルール「${rule.name}」を削除しました`));
          return true;
        }
        case "home":
          await update(this.#home(guildId, userId));
          return true;
        case "open": {
          const values = "values" in interaction.data ? interaction.data.values : [];
          await update(this.#detail(guildId, userId, values[0] ?? parsed.arg));
          return true;
        }
        case "allow":
        case "source":
        case "runs":
          await update(this.#detail(guildId, userId, parsed.arg, { page: parsed.action }));
          return true;
        case "view": {
          const value = "values" in interaction.data ? interaction.data.values[0] : undefined;
          if (value === DELETE_CHOICE) await update(this.#detail(guildId, userId, parsed.arg, { confirmDelete: true }));
          else await update(this.#detail(guildId, userId, parsed.arg, { page: RULE_PAGES.includes(value as RulePage) ? (value as RulePage) : "summary" }));
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
        case "visibility": {
          const value = interaction.type === InteractionType.MessageComponent && "values" in interaction.data ? interaction.data.values[0] : undefined;
          const rule = this.deps.admin.setVisibility(guildId, userId, parsed.arg, value as CommandVisibility);
          const label = VISIBILITY_CHOICES.find((o) => o.value === rule.trigger.command?.visibility)?.label ?? "";
          await update(this.#detail(guildId, userId, rule.id, { notice: `「${label}」にしました` }));
          return true;
        }
        case "clearstate": {
          const rule = this.deps.admin.get(guildId, userId, parsed.arg);
          if (rule.ownerId !== userId) {
            await ephemeral("状態を消せるのは作成者だけです");
            return true;
          }
          this.deps.store.setRuleState(rule.id, null);
          this.deps.store.audit({ kind: "user", userId, via: "panel" }, "rule.clear_state", {}, undefined, rule.id);
          await update(this.#detail(guildId, userId, rule.id, { page: "runs", notice: "状態を消しました。次の実行は state が null で始まります" }));
          return true;
        }
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

  #wasmSource(rule: Pick<Rule, "program">): { wasmSource?: WasmSource } {
    const source = rule.program.kind === "wasm" ? this.deps.wasm?.source(rule.program.sha256) : undefined;
    return source ? { wasmSource: source } : {};
  }

  async #codeFile(interaction: APIInteraction, name: string, definition: Pick<Rule, "trigger" | "allow" | "program" | "params">): Promise<void> {
    const json = JSON.stringify({ trigger: definition.trigger, allow: definition.allow, params: definition.params ?? null }, null, 2);
    const { program } = definition;
    const source = this.#wasmSource(definition).wasmSource;
    // Discord file names have no directories, so src/main.rs goes out as src_main.rs.
    const code = program.kind === "js"
      ? [{ name: "rule.js", data: Buffer.from(program.code) }]
      : source
        ? source.files.slice(0, 9).map((f) => ({ name: f.path.replaceAll("/", "_"), data: Buffer.from(f.content) }))
        : [{ name: "rule.txt", data: Buffer.from(`Wasm sha256 ${program.sha256}`) }];
    await this.deps.api.interactions.reply(interaction.id, interaction.token, {
      content: `ルール「${name}」のコードと許す操作です`,
      files: [...code, { name: "rule.json", data: Buffer.from(json) }],
      flags: MessageFlags.Ephemeral,
      allowed_mentions: { parse: [] },
    });
  }
}

/** What whoever ran a command sees: the code's reply, or how the run went. */
function commandFailed(report: CommandReport): boolean {
  return report.outcome === "failed" || report.outcome === "rejected" || report.outcome === "skipped" || report.outcome === "rate_limited";
}

export function commandReplyText(ruleName: string, report: CommandReport): string {
  const status = commandFailed(report)
    ? `⚠️ 実行できませんでした: ${(report.error ?? "不明なエラー").slice(0, 500)}`
    : report.reply || report.images.length
      ? null
      : report.outcome === "executed"
        ? `「${ruleName}」を実行しました(${report.steps}件の変更)`
        : "変更することはありませんでした";
  return [report.reply, status].filter((t): t is string => !!t).join("\n").slice(0, 2000);
}
