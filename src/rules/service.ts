import { randomBytes } from "node:crypto";
import type { API } from "@discordjs/core";
import { InteractionType, MessageFlags } from "discord-api-types/v10";
import type { APIInteraction, APIMessage } from "discord-api-types/v10";
import type { Store } from "../db.ts";
import type { GuildCaches } from "../discord/cache.ts";
import { modalValue } from "../discord/modal.ts";
import type { GuildState } from "../discord/permissions.ts";
import type { Reader } from "../discord/reader.ts";
import { CATALOG } from "../plan/catalog.ts";
import { stepLines } from "../plan/dialog.ts";
import type { Plan } from "../plan/types.ts";
import { normalizeSteps, permissionProblems, PlanRejected, planRisk, visibilityProblems } from "../plan/validate.ts";
import { AdminDenied } from "./admin.ts";
import type { RuleAdmin } from "./admin.ts";
import { allowProblems } from "./allow.ts";
import type { RuleEngine } from "./engine.ts";
import { auditView, detailView, draftView, homeView, instructionModal, parseRuleCustomId, plansView, ruleCustomId } from "./panel.ts";
import type { DraftStatus, DryRunView, Rendered } from "./panel.ts";
import { DEFAULT_LIMITS } from "./types.ts";
import type { Rule, RuleDefinition, RuleDraft } from "./types.ts";

// Rules are made in conversation: the agent proposes one with propose_rule,
// it is dry-run on the spot, and a confirmation is posted in the channel like
// a plan's dialog. Only the requester can register it. /rules opens the
// management panel, which is only visible to whoever opened it.

export const DRAFT_MS = 10 * 60_000;

export class RuleRejected extends Error {
  readonly reasons: string[];
  constructor(reasons: string[]) {
    super(reasons.join("\n"));
    this.reasons = reasons;
  }
}

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
  /** Asks the agent to rework a pending draft; it proposes again with `replacesDraft`. */
  revise?: (input: ReviseRuleInput) => Promise<void>;
}

export interface ReviseRuleInput {
  draftId: string;
  guildId: string;
  channelId: string;
  messageId: string;
  ownerId: string;
  draft: RuleDraft;
  replacesRule?: string;
  instruction: string;
}

export interface ProposeRuleInput {
  guildId: string;
  channelId: string;
  replyToId: string | null;
  ownerId: string;
  /** The request the rule was written for, kept as the rule's source. */
  request: string;
  draft: RuleDraft;
  /** The conversation's reader: the dry run and the dialog stay within what this channel may show. */
  reader: Reader;
  /** An existing rule of the owner's this draft is a new version of. */
  replacesRule?: string;
  /** A pending draft whose dialog this one takes over. */
  replacesDraft?: string;
}

interface PendingDraft {
  id: string;
  guildId: string;
  ownerId: string;
  channelId: string;
  messageId: string;
  request: string;
  draft: RuleDraft;
  summary: string | null;
  dry: DryRunView;
  replacesRule?: { id: string; name: string; version: number };
  status: DraftStatus;
  expiresAt: string;
  note?: string;
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

/** Channels an allow list pins its entries to. */
function pinnedIds(draft: RuleDraft): string[] {
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
  readonly #drafts = new Map<string, PendingDraft>();

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
  async sample(guildId: string, ownerId: string, channelId: string, draft: Pick<RuleDraft, "trigger" | "sampleEvent">, reader: Pick<Reader, "get">): Promise<{ event: unknown; source: string | null }> {
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
  async dryRun(guildId: string, ownerId: string, channelId: string, rule: Pick<RuleDraft, "code" | "allow" | "trigger" | "sampleEvent">, reader: Pick<Reader, "get">, shareable?: Set<string>): Promise<DryRunView> {
    const { event, source } = await this.sample(guildId, ownerId, channelId, rule, reader);
    if (event === null) return { source: null, outcome: "no_event", lines: [], problems: [], logs: [] };
    const result = await this.deps.engine.evaluate({ guildId, ownerId, code: rule.code }, event, reader);
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

  // --- Proposal from the conversation ---------------------------------------

  async propose(input: ProposeRuleInput): Promise<{ draftId: string; report: string }> {
    const { draft } = input;
    const shareable = input.reader.shareable();
    const definition: RuleDefinition = { name: draft.name, sourcePrompt: input.request, trigger: draft.trigger, allow: draft.allow, code: draft.code, summary: null, limits: DEFAULT_LIMITS };
    const problems = this.deps.admin.ownershipProblems(input.guildId, input.ownerId, definition);
    for (const id of pinnedIds(draft)) {
      if (!shareable.has(id)) problems.push(`チャンネル ${id} はこの場所では扱えません。そのチャンネルを見られる人だけがいる場所で頼んでください`);
    }
    let replacesRule: PendingDraft["replacesRule"];
    if (input.replacesRule) {
      const rule = this.deps.store.getRule(input.replacesRule);
      if (!rule || rule.guildId !== input.guildId) problems.push(`ルール ${input.replacesRule} が見つかりません`);
      else if (rule.ownerId !== input.ownerId) problems.push("ルールを直せるのは作成者だけです");
      else replacesRule = { id: rule.id, name: rule.name, version: rule.version };
    }
    if (problems.length > 0) throw new RuleRejected(problems);

    const dry = await this.dryRun(input.guildId, input.ownerId, input.channelId, draft, input.reader, shareable);
    const dryProblems = dry.outcome === "no_event" && draft.sampleEvent === undefined
      ? ["このきっかけは試せる実際のイベントがないので、sample_event を付けて出し直してください"]
      : dry.problems;
    if (dryProblems.length > 0) throw new RuleRejected(dryProblems.map((p) => `ドライラン: ${p}`));

    const summary = await this.#summarize(draft.code, input.ownerId, draft.trigger.event);
    const pending: PendingDraft = {
      id: randomBytes(6).toString("hex"),
      guildId: input.guildId,
      ownerId: input.ownerId,
      channelId: input.channelId,
      messageId: "",
      request: input.request,
      draft,
      summary,
      dry,
      ...(replacesRule ? { replacesRule } : {}),
      status: "pending",
      expiresAt: new Date(this.deps.now() + DRAFT_MS).toISOString(),
    };
    const old = input.replacesDraft ? this.#drafts.get(input.replacesDraft) : undefined;
    if (old && old.ownerId === input.ownerId && old.channelId === input.channelId && old.messageId) {
      // Takes over the earlier dialog, so the channel keeps one message per request.
      pending.messageId = old.messageId;
      pending.request = old.request;
      old.status = "replaced";
      this.#drafts.set(pending.id, pending);
      await this.deps.api.channels.editMessage(old.channelId, old.messageId, this.#view(pending));
    } else {
      this.#drafts.set(pending.id, pending);
      const message = await this.deps.api.channels.createMessage(input.channelId, {
        ...this.#view(pending),
        allowed_mentions: { parse: [] },
        ...(input.replyToId ? { message_reference: { message_id: input.replyToId, fail_if_not_exists: false } } : {}),
      });
      pending.messageId = message.id;
    }
    this.deps.store.audit({ kind: "user", userId: input.ownerId, via: "conversation" }, "rule.propose", { guildId: input.guildId, draft: pending.id, trigger: draft.trigger, replaces: replacesRule?.id ?? null });
    const report = dry.outcome === "steps" ? `${dry.lines.length}種類の変更` : dry.outcome === "none" ? "変更なし" : "試せるイベントなし";
    return { draftId: pending.id, report };
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

  #view(d: PendingDraft): Rendered {
    return draftView(
      {
        draftId: d.id,
        ownerId: d.ownerId,
        name: d.draft.name,
        trigger: d.draft.trigger,
        allow: d.draft.allow,
        code: d.draft.code,
        summary: d.summary,
        limits: DEFAULT_LIMITS,
        dry: d.dry,
        ...(d.replacesRule ? { replaces: { name: d.replacesRule.name, version: d.replacesRule.version } } : {}),
        status: d.status,
        expiresAt: d.expiresAt,
        ...(d.note ? { note: d.note } : {}),
      },
      cacheLabel(this.deps.caches.get(d.guildId)?.guild),
    );
  }

  /** The rules of the speaker's that the agent may read here, for a request to change one. */
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

  #detail(guildId: string, userId: string, ruleId: string, extra: { dry?: DryRunView; notice?: string; confirmDelete?: boolean } = {}): Rendered {
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
        case "save":
        case "revise":
        case "revisetext":
        case "discard":
        case "draftcode":
          return await this.#draftAction(interaction, parsed.action, parsed.arg, userId, ephemeral);
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

  async #codeFile(interaction: APIInteraction, name: string, definition: Pick<RuleDraft, "trigger" | "allow" | "code">): Promise<void> {
    const json = JSON.stringify({ trigger: definition.trigger, allow: definition.allow }, null, 2);
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

  async #draftAction(interaction: APIInteraction, action: "save" | "revise" | "revisetext" | "discard" | "draftcode", draftId: string, userId: string, ephemeral: (content: string) => Promise<unknown>): Promise<boolean> {
    const { api, store } = this.deps;
    const d = this.#drafts.get(draftId);
    if (!d) {
      await ephemeral("このルール案は見つかりません(Botが再起動すると消えます)。もう一度頼んでください。");
      return true;
    }
    if (action === "draftcode") {
      await this.#codeFile(interaction, d.draft.name, d.draft);
      return true;
    }
    if (userId !== d.ownerId) {
      await ephemeral("このルール案を操作できるのは依頼した本人だけです");
      return true;
    }
    const expired = Date.parse(d.expiresAt) <= this.deps.now();
    if (d.status !== "pending" || (expired && action !== "discard")) {
      if (expired && d.status === "pending") {
        d.status = "expired";
        await api.interactions.updateMessage(interaction.id, interaction.token, this.#view(d));
        return true;
      }
      await ephemeral("このルール案はもう確認待ちではありません");
      return true;
    }
    const actor = { kind: "user" as const, userId, via: "conversation" as const };
    switch (action) {
      case "save": {
        const definition: RuleDefinition = { name: d.draft.name, sourcePrompt: d.request, trigger: d.draft.trigger, allow: d.draft.allow, code: d.draft.code, summary: d.summary, limits: DEFAULT_LIMITS };
        try {
          this.deps.admin.save(d.guildId, d.ownerId, definition, d.replacesRule?.id);
          d.status = "saved";
          d.note = undefined;
        } catch (e) {
          if (!(e instanceof AdminDenied)) throw e;
          d.note = `登録できませんでした: ${e.message}`;
        }
        await api.interactions.updateMessage(interaction.id, interaction.token, this.#view(d));
        return true;
      }
      case "discard":
        d.status = "discarded";
        store.audit(actor, "rule.discard", { guildId: d.guildId, draft: d.id });
        await api.interactions.updateMessage(interaction.id, interaction.token, this.#view(d));
        return true;
      case "revise":
        if (!this.deps.revise) {
          await ephemeral("今は修正できません");
          return true;
        }
        await api.interactions.createModal(interaction.id, interaction.token, instructionModal(ruleCustomId("revisetext", d.id), "ルール案の修正", "どう直しますか", "例: 対象は #雑談 だけにして / Botの投稿は無視して"));
        return true;
      case "revisetext": {
        const instruction = interaction.type === InteractionType.ModalSubmit ? modalValue(interaction, "instruction")?.trim() : undefined;
        if (!instruction || !this.deps.revise) {
          await ephemeral("修正の内容がありません");
          return true;
        }
        await api.interactions.deferMessageUpdate(interaction.id, interaction.token);
        store.audit(actor, "rule.revise", { guildId: d.guildId, draft: d.id, instruction: instruction.slice(0, 500) });
        void this.deps
          .revise({ draftId: d.id, guildId: d.guildId, channelId: d.channelId, messageId: d.messageId, ownerId: d.ownerId, draft: d.draft, ...(d.replacesRule ? { replacesRule: d.replacesRule.id } : {}), instruction })
          .catch((e) => {
            this.deps.log(`ルール案 ${d.id} の修正に失敗`, e);
            void api.interactions
              .followUp(interaction.application_id, interaction.token, { content: `修正版を作れませんでした: ${e instanceof Error ? e.message : String(e)}`.slice(0, 1800), flags: MessageFlags.Ephemeral })
              .catch(() => undefined);
          });
        return true;
      }
    }
  }

  /** Marks unanswered drafts expired and forgets old ones. Called every minute. */
  async sweep(): Promise<void> {
    const now = this.deps.now();
    for (const [id, d] of this.#drafts) {
      const expires = Date.parse(d.expiresAt);
      if (d.status === "pending" && expires <= now) {
        d.status = "expired";
        await this.deps.api.channels.editMessage(d.channelId, d.messageId, this.#view(d)).catch((e) => this.deps.log(`ルール案 ${id} の表示更新に失敗`, e));
      }
      // Kept a while after closing, so the code can still be downloaded.
      if (expires + DRAFT_MS * 6 <= now) this.#drafts.delete(id);
    }
  }
}
