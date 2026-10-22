import type { APIMessage } from "discord-api-types/v10";
import type { Store } from "./db.ts";
import { formatMessage } from "./agent/tools.ts";
import { imageRefs } from "./agent/images.ts";
import type { ImageRef } from "./agent/images.ts";
import { resolveWebAccess } from "./agent/web.ts";
import { Inbox } from "./agent/respond.ts";
import type { RespondInput, RespondResult } from "./agent/respond.ts";
import type { Judgement } from "./agent/judge.ts";
import { CONFIDENCE_THRESHOLD } from "./agent/judge.ts";
import { findChatModel, findJudgeModel } from "./llm/models.ts";
import type { JudgeModel } from "./llm/models.ts";
import { setupStatus } from "./llm/panel.ts";
import type { Reader, ReadScope } from "./discord/reader.ts";
import type { ProposeInput } from "./plan/service.ts";
import type { Plan } from "./plan/types.ts";
import type { Rule } from "./rules/types.ts";

// Conversation mode: wake on a mention, answer messages addressed to the bot,
// and fall asleep after a quiet period. One session per channel (a thread is
// its own channel). Replies use the speaker's key, model and permissions.

export const SESSION_MS = 5 * 60_000;
export const CONTEXT_MESSAGES = 30;
export const MAX_MESSAGES_PER_REPLY = 500;
const DISCORD_LIMIT = 2000;

export interface ConversationDeps {
  store: Store;
  selfId: () => string;
  botName: () => string;
  now: () => number;
  /** False turns the web off for everyone, whatever each person chose in /llm. */
  webSearch: boolean;
  fetchBefore: (channelId: string, beforeId: string, limit: number) => Promise<APIMessage[]>;
  /** replyToId is null for follow-up posts, which read as a natural series. */
  sendReply: (channelId: string, replyToId: string | null, content: string) => Promise<void>;
  sendDm: (userId: string, content: string) => Promise<void>;
  typing: (channelId: string) => Promise<void>;
  makeReader: (scope: ReadScope) => Reader;
  respond: (input: RespondInput) => Promise<RespondResult>;
  judge: (input: { model: JudgeModel; apiKey: string; botName: string; transcript: string[]; message: string }) => Promise<Judgement>;
  /** Posts an approval dialog for writes. Absent keeps conversations read-only. */
  propose?: (input: ProposeInput) => Promise<Plan>;
  /** Event rules, proposed inside plans. Absent means the agent cannot propose them. */
  rules?: {
    list: (guildId: string, ownerId: string, shareable: Set<string>) => Array<{ rule: Rule; shown: boolean }>;
  };
  /** A conversation woke or was extended. */
  onAwake?: () => void;
  log: (message: string, error?: unknown) => void;
}

/** A message from a server channel; the Gateway adds the guild it came from. */
export type GuildMessage = APIMessage & { guild_id: string };

export type Decision =
  | { kind: "ignore" }
  | { kind: "notify-unregistered" }
  | { kind: "reply"; wake: boolean }
  | { kind: "judge"; judgeUserId: string };

export const SETUP_NOTICE =
  "このBotと話すには、サーバーで `/llm` を実行して、APIキー・応答に使うモデル・宛先判定に使うモデルを設定してください。";

interface ChannelContext {
  /** Every recent message, oldest first, so the model can follow the conversation. */
  transcript: string[];
  /** Recent human messages only, the reference for how long and how casual a reply is. */
  styleSamples: string[];
}

const STYLE_SAMPLES = 15;

/**
 * Human messages to imitate. Bots and webhooks are filtered out here, not by
 * instruction, so the bot's own long answers never set the tone.
 */
export function styleSamples(messages: Pick<APIMessage, "author" | "webhook_id" | "content">[]): string[] {
  return messages
    .filter((m) => !m.author.bot && !m.webhook_id && m.content.trim())
    .map((m) => m.content.trim())
    .slice(-STYLE_SAMPLES);
}

/** Splits a reply into posts: first at the model's own breaks, then at Discord's length limit. */
export function splitForDiscord(text: string, limit = DISCORD_LIMIT): string[] {
  return text.split(/^[ \t]*<next>[ \t]*$/m).flatMap((part) => splitByLength(part, limit));
}

function splitByLength(text: string, limit: number): string[] {
  const chunks: string[] = [];
  let rest = text.trim();
  while (rest.length > limit) {
    let cut = rest.lastIndexOf("\n", limit);
    if (cut < limit / 2) cut = limit;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).trimStart();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

export class Conversations {
  readonly deps: ConversationDeps;
  /** `${channelId}:${userId}` -> time until which the setup DM is not repeated. */
  readonly #notified = new Map<string, number>();
  /** Per-channel promise chain so messages in one channel are handled in order. */
  readonly #queues = new Map<string, Promise<void>>();
  /** The answer being worked on in each channel, which takes in its speaker's follow-ups and edits. */
  readonly #working = new Map<string, { speaker: string; messageIds: Set<string>; inbox: Inbox }>();

  constructor(deps: ConversationDeps) {
    this.deps = deps;
  }

  isDirect(message: APIMessage): boolean {
    const self = this.deps.selfId();
    return message.mentions.some((u) => u.id === self) || message.referenced_message?.author.id === self;
  }

  /** Deterministic triage. Only the "judge" outcome costs an LLM call. */
  decide(message: APIMessage): Decision {
    const { store } = this.deps;
    if (message.author.bot || message.webhook_id) return { kind: "ignore" };
    const direct = this.isDirect(message);
    const conv = store.getConversation(message.channel_id);
    const awake = conv !== undefined && conv.awakeUntil > this.deps.now();
    if (!direct && !awake) return { kind: "ignore" };

    if (!setupStatus(store, message.author.id).complete) {
      // Unregistered speakers are never judged; a mention gets one DM per session.
      if (!direct) return { kind: "ignore" };
      const key = `${message.channel_id}:${message.author.id}`;
      if ((this.#notified.get(key) ?? 0) > this.deps.now()) return { kind: "ignore" };
      return { kind: "notify-unregistered" };
    }
    if (direct) return { kind: "reply", wake: !awake };
    return { kind: "judge", judgeUserId: conv!.startedBy };
  }

  handle(message: GuildMessage): Promise<void> {
    const working = this.#working.get(message.channel_id);
    if (working && !message.author.bot && !message.webhook_id && message.author.id === working.speaker) {
      if (working.inbox.deliver(`[追いコメント] ${formatMessage(message)}`)) {
        working.messageIds.add(message.id);
        return Promise.resolve();
      }
    }
    return this.#enqueue(message.channel_id, () => this.#process(message)).catch((e) =>
      this.deps.log(`メッセージ ${message.id} の処理に失敗`, e),
    );
  }

  async #process(message: GuildMessage): Promise<void> {
    const decision = this.decide(message);
    switch (decision.kind) {
      case "ignore":
        return;
      case "notify-unregistered": {
        const conv = this.deps.store.getConversation(message.channel_id);
        const until = Math.max(conv?.awakeUntil ?? 0, this.deps.now() + SESSION_MS);
        this.#notified.set(`${message.channel_id}:${message.author.id}`, until);
        // A refused DM (privacy settings) is ignored by design.
        await this.deps.sendDm(message.author.id, SETUP_NOTICE).catch(() => undefined);
        return;
      }
      case "judge": {
        const context = await this.#context(message);
        if (!(await this.#addressed(decision.judgeUserId, context.transcript, message))) return;
        return this.#reply(message, context, false);
      }
      case "reply":
        return this.#reply(message, await this.#context(message), decision.wake);
    }
  }

  /**
   * An edit to a message the bot is still answering reaches the agent. Edits to
   * anything else are already current wherever history is read.
   */
  edited(message: Pick<APIMessage, "id" | "channel_id"> & Partial<APIMessage>): void {
    const working = this.#working.get(message.channel_id);
    if (!working || !working.messageIds.has(message.id) || message.author?.id !== working.speaker || message.content === undefined) return;
    working.inbox.deliver(`[編集] 次の発言が編集されました。今の内容: ${formatMessage(message as APIMessage)}`);
  }

  async #context(message: GuildMessage): Promise<ChannelContext> {
    const before = await this.deps.fetchBefore(message.channel_id, message.id, CONTEXT_MESSAGES);
    return { transcript: before.map(formatMessage).reverse(), styleSamples: styleSamples([...before].reverse()) };
  }

  async #addressed(judgeUserId: string, transcript: string[], message: GuildMessage): Promise<boolean> {
    const { store } = this.deps;
    const ref = store.getSettings(judgeUserId).judge;
    const model = ref && findJudgeModel(ref.provider, ref.model);
    const apiKey = ref && store.getApiKey(judgeUserId, ref.provider);
    if (!model || !apiKey) return false; // The waker's setup broke; stay quiet rather than guess.
    const verdict = await this.deps.judge({
      model,
      apiKey,
      botName: this.deps.botName(),
      transcript,
      message: formatMessage(message),
    });
    return verdict.addressed && verdict.confidence >= CONFIDENCE_THRESHOLD;
  }

  async #reply(message: GuildMessage, context: ChannelContext, wake: boolean): Promise<void> {
    const { store } = this.deps;
    const speaker = message.author.id;
    const conv = store.getConversation(message.channel_id);
    store.saveConversation({
      channelId: message.channel_id,
      startedBy: wake || !conv ? speaker : conv.startedBy,
      awakeUntil: this.deps.now() + SESSION_MS,
    });
    this.deps.onAwake?.();
    await this.#answer({
      guildId: message.guild_id,
      channelId: message.channel_id,
      replyToId: message.id,
      speaker,
      context,
      target: formatMessage(message),
      // The replied-to message is in the same channel, so its images may be shown here too.
      images: [...imageRefs(message), ...(message.referenced_message ? imageRefs(message.referenced_message) : [])],
      messageIds: [message.id],
      audit: { channelId: message.channel_id, messageId: message.id },
    });

    // Extend the session from the moment the reply went out.
    const latest = store.getConversation(message.channel_id);
    if (latest) store.saveConversation({ ...latest, awakeUntil: this.deps.now() + SESSION_MS });
    this.deps.onAwake?.();
  }

  /**
   * The dialog's 修正 button: the agent reworks the plan from the person's
   * instruction, and its new proposal takes over the same dialog.
   */
  revise(input: { plan: Plan; channelId: string; messageId: string; instruction: string }): Promise<void> {
    const { plan } = input;
    const speaker = plan.actor.userId;
    if (!setupStatus(this.deps.store, speaker).complete) {
      return Promise.reject(new Error("/llm の設定が終わっていないため修正できません"));
    }
    const run = async () => {
      const before = await this.deps.fetchBefore(input.channelId, input.messageId, CONTEXT_MESSAGES);
      const context = { transcript: before.map(formatMessage).reverse(), styleSamples: styleSamples([...before].reverse()) };
      const current = plan.steps.map((s) => ({ id: s.id, op: s.op, path: s.pathParams, ...(s.body !== undefined ? { body: s.body } : {}) }));
      const name = plan.labels[speaker] ?? speaker;
      await this.#answer({
        guildId: plan.guildId,
        channelId: input.channelId,
        replyToId: input.messageId,
        speaker,
        context,
        target: [
          `[修正依頼] ${name}(${speaker}): 承認待ちの変更案 ${plan.id} を次のとおり直して、propose_plan で出し直してください。`,
          `直してほしいこと: ${input.instruction}`,
          `今の案: ${JSON.stringify(current)}`,
        ].join("\n"),
        images: [],
        replaces: plan.id,
        audit: { channelId: input.channelId, messageId: input.messageId, revises: plan.id },
      });
    };
    return this.#enqueue(input.channelId, run);
  }

  #enqueue(channelId: string, task: () => Promise<void>): Promise<void> {
    const next = (this.#queues.get(channelId) ?? Promise.resolve()).then(task);
    const settled = next.catch(() => undefined);
    this.#queues.set(channelId, settled);
    void settled.finally(() => {
      if (this.#queues.get(channelId) === settled) this.#queues.delete(channelId);
    });
    return next;
  }

  async #answer(input: {
    guildId: string;
    channelId: string;
    replyToId: string;
    speaker: string;
    context: ChannelContext;
    target: string;
    images: ImageRef[];
    replaces?: string;
    /** The messages this answer is for, whose edits it should take in. */
    messageIds?: string[];
    audit: Record<string, unknown>;
  }): Promise<void> {
    const { store } = this.deps;
    const { speaker, channelId } = input;
    const ref = store.getSettings(speaker).response!;
    const model = findChatModel(ref.provider, ref.model)!;
    const apiKey = store.getApiKey(speaker, ref.provider)!;
    const web = this.deps.webSearch
      ? resolveWebAccess(store.getSettings(speaker).web, ref.provider, (p) => store.getApiKey(speaker, p))
      : null;
    const reader = this.deps.makeReader({ guildId: input.guildId, channelId, speakerId: speaker });

    await this.deps.typing(channelId).catch(() => undefined);
    const typing = setInterval(() => void this.deps.typing(channelId).catch(() => undefined), 8000);
    const inbox = new Inbox();
    this.#working.set(channelId, { speaker, messageIds: new Set(input.messageIds ?? []), inbox });
    // The first post answers the message; the rest follow it as a series.
    let replyTo: string | null = input.replyToId;
    const post = async (content: string) => {
      for (const part of splitForDiscord(content)) {
        await this.deps.sendReply(channelId, replyTo, part);
        replyTo = null;
      }
    };
    let progress = 0;
    let text: string;
    let detail: Record<string, unknown> = { ...input.audit, model: `${ref.provider}/${ref.model}`, web: web?.kind ?? null };
    try {
      const result = await this.deps.respond({
        model,
        apiKey,
        reader,
        botName: this.deps.botName(),
        transcript: input.context.transcript,
        styleSamples: input.context.styleSamples,
        target: input.target,
        images: input.images,
        web,
        inbox,
        onProgress: async (content) => {
          await post(content);
          await this.deps.typing(channelId).catch(() => undefined);
        },
        propose: this.deps.propose
          ? (drafts, code, rules) =>
              this.deps.propose!({
                guildId: input.guildId,
                channelId,
                replyToId: input.replyToId,
                actorId: speaker,
                drafts,
                shareable: reader.shareable(),
                ...(code ? { code } : {}),
                ...(input.replaces ? { replaces: input.replaces } : {}),
                ...(rules ? { rules, reader, request: input.target } : {}),
              })
          : undefined,
        rules: this.deps.rules
          ? {
              list: () => this.deps.rules!.list(input.guildId, speaker, reader.shareable()),
            }
          : undefined,
      });
      progress = result.progress;
      text = result.text || (progress > 0 ? "" : "うまく答えを作れませんでした。言い方を変えてもう一度聞いてください。");
      detail = { ...detail, progress: result.progress, turns: result.turns, toolCalls: result.toolCalls, ...(result.toolErrors?.length ? { toolErrors: result.toolErrors } : {}), messagesRead: reader.messagesRead };
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      this.deps.log(`応答の生成に失敗 (${input.replyToId})`, e);
      text = `応答の生成に失敗しました: ${reason.slice(0, 300)}`;
      detail = { ...detail, error: reason.slice(0, 500) };
    } finally {
      clearInterval(typing);
      if (this.#working.get(channelId)?.inbox === inbox) this.#working.delete(channelId);
    }

    await post(text);
    store.audit({ kind: "user", userId: speaker, via: "conversation" }, "conversation.reply", detail);
  }

  sweep(): void {
    const now = this.deps.now();
    this.deps.store.deleteExpiredConversations(now);
    for (const [key, until] of this.#notified) if (until <= now) this.#notified.delete(key);
  }
}
