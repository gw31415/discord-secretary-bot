import type { APIMessage } from "discord-api-types/v10";
import type { Store } from "./db.ts";
import { formatMessage } from "./agent/tools.ts";
import { imageRefs } from "./agent/images.ts";
import type { RespondInput, RespondResult } from "./agent/respond.ts";
import type { Judgement } from "./agent/judge.ts";
import { CONFIDENCE_THRESHOLD } from "./agent/judge.ts";
import { findChatModel, findJudgeModel } from "./llm/models.ts";
import type { JudgeModel } from "./llm/models.ts";
import { setupStatus } from "./llm/panel.ts";
import type { Reader, ReadScope } from "./discord/reader.ts";

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
  webSearch: boolean;
  fetchBefore: (channelId: string, beforeId: string, limit: number) => Promise<APIMessage[]>;
  /** replyToId is null for follow-up posts, which read as a natural series. */
  sendReply: (channelId: string, replyToId: string | null, content: string) => Promise<void>;
  sendDm: (userId: string, content: string) => Promise<void>;
  typing: (channelId: string) => Promise<void>;
  makeReader: (scope: ReadScope) => Reader;
  respond: (input: RespondInput) => Promise<RespondResult>;
  judge: (input: { model: JudgeModel; apiKey: string; botName: string; transcript: string[]; message: string }) => Promise<Judgement>;
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
    const channelId = message.channel_id;
    const next = (this.#queues.get(channelId) ?? Promise.resolve())
      .then(() => this.#process(message))
      .catch((e) => this.deps.log(`メッセージ ${message.id} の処理に失敗`, e));
    this.#queues.set(channelId, next);
    void next.finally(() => {
      if (this.#queues.get(channelId) === next) this.#queues.delete(channelId);
    });
    return next;
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
        const transcript = await this.#transcript(message);
        if (!(await this.#addressed(decision.judgeUserId, transcript, message))) return;
        return this.#reply(message, transcript, false);
      }
      case "reply":
        return this.#reply(message, await this.#transcript(message), decision.wake);
    }
  }

  async #transcript(message: GuildMessage): Promise<string[]> {
    const before = await this.deps.fetchBefore(message.channel_id, message.id, CONTEXT_MESSAGES);
    return before.map(formatMessage).reverse();
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

  async #reply(message: GuildMessage, transcript: string[], wake: boolean): Promise<void> {
    const { store } = this.deps;
    const speaker = message.author.id;
    const conv = store.getConversation(message.channel_id);
    store.saveConversation({
      channelId: message.channel_id,
      startedBy: wake || !conv ? speaker : conv.startedBy,
      awakeUntil: this.deps.now() + SESSION_MS,
    });

    const ref = store.getSettings(speaker).response!;
    const model = findChatModel(ref.provider, ref.model)!;
    const apiKey = store.getApiKey(speaker, ref.provider)!;
    const reader = this.deps.makeReader({ guildId: message.guild_id, channelId: message.channel_id, speakerId: speaker });

    await this.deps.typing(message.channel_id).catch(() => undefined);
    const typing = setInterval(() => void this.deps.typing(message.channel_id).catch(() => undefined), 8000);
    let text: string;
    let detail: Record<string, unknown> = { channelId: message.channel_id, messageId: message.id, model: `${ref.provider}/${ref.model}` };
    try {
      const result = await this.deps.respond({
        model,
        apiKey,
        reader,
        botName: this.deps.botName(),
        transcript,
        target: formatMessage(message),
        // The replied-to message is in the same channel, so its images may be shown here too.
        images: [...imageRefs(message), ...(message.referenced_message ? imageRefs(message.referenced_message) : [])],
        webSearch: this.deps.webSearch,
      });
      text = result.text || "うまく答えを作れませんでした。言い方を変えてもう一度聞いてください。";
      detail = { ...detail, turns: result.turns, toolCalls: result.toolCalls, messagesRead: reader.messagesRead };
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      this.deps.log(`応答の生成に失敗 (${message.id})`, e);
      text = `応答の生成に失敗しました: ${reason.slice(0, 300)}`;
      detail = { ...detail, error: reason.slice(0, 500) };
    } finally {
      clearInterval(typing);
    }

    const posts = splitForDiscord(text);
    for (const [i, post] of posts.entries()) await this.deps.sendReply(message.channel_id, i === 0 ? message.id : null, post);
    store.audit({ kind: "user", userId: speaker, via: "conversation" }, "conversation.reply", detail);

    // Extend the session from the moment the reply went out.
    const latest = store.getConversation(message.channel_id);
    if (latest) store.saveConversation({ ...latest, awakeUntil: this.deps.now() + SESSION_MS });
  }

  sweep(): void {
    const now = this.deps.now();
    this.deps.store.deleteExpiredConversations(now);
    for (const [key, until] of this.#notified) if (until <= now) this.#notified.delete(key);
  }
}
