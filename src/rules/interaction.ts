import type { API } from "@discordjs/core";
import { InteractionResponseType, InteractionType, MessageFlags, Routes } from "discord-api-types/v10";
import type { APIInteraction } from "discord-api-types/v10";

// Presses of buttons and selects on the bot's messages, and forms sent from
// them, that are not the bot's own panels go to INTERACTION_CREATE rules. The
// rules run as whoever pressed, like a command (or as their owner when the
// rule says so); what the code passes to respond() is the interaction response, sent to whoever pressed as Discord
// takes it. Discord wants an answer within 3 seconds and a form can only be
// the first one, so a form is sent as soon as the code returns; other answers
// wait for the run's changes. If nothing has answered in time the press is
// acknowledged without a change, and a later message goes out as a follow-up.

/** The first segments of the custom ids the bot's own panels and dialogs use. */
export const BOT_CUSTOM_ID_NAMESPACES = new Set(["llm", "rule", "plan", "widen", "wasm"]);

/** How long a run may take before the press is acknowledged without an answer. */
export const ANSWER_WITHIN_MS = 2_500;
/** Discord's interaction tokens last 15 minutes. */
export const ANSWER_TTL_MS = 15 * 60_000;

/** A press or form on a message that is not the bot's own panel. */
export function isRuleInteraction(interaction: APIInteraction): boolean {
  if (interaction.type !== InteractionType.MessageComponent && interaction.type !== InteractionType.ModalSubmit) return false;
  return !BOT_CUSTOM_ID_NAMESPACES.has(interaction.data.custom_id.split(":")[0] ?? "");
}

/** The event the rule reads: the interaction as Discord sent it, without its token. */
export function interactionEvent(interaction: APIInteraction): Record<string, unknown> {
  const { token: _token, ...rest } = interaction as APIInteraction & Record<string, unknown>;
  return { ...rest, channel_id: interaction.channel?.id ?? (rest.channel_id as string | undefined) ?? null };
}

/** A form must be the first answer, so it goes out as soon as the code returns. */
export function isModalResponse(response: unknown): boolean {
  return (response as { type?: unknown } | null)?.type === InteractionResponseType.Modal;
}

/** Answers one interaction; send() returns why it could not, or null. */
export interface InteractionResponder {
  send(response: unknown): Promise<string | null>;
  /** The run that meant to answer failed; whoever pressed is told so, and why when it is theirs to know. */
  failed(ruleName: string, reason?: string): Promise<void>;
}

const ANSWER_TYPES = new Set<number>([
  InteractionResponseType.ChannelMessageWithSource,
  InteractionResponseType.DeferredChannelMessageWithSource,
  InteractionResponseType.DeferredMessageUpdate,
  InteractionResponseType.UpdateMessage,
  InteractionResponseType.Modal,
]);

export class InteractionAnswer implements InteractionResponder {
  readonly #api: API;
  readonly #interaction: APIInteraction;
  readonly #log: (message: string, error?: unknown) => void;
  #state: "none" | "deferred" | "answered" = "none";
  /** Answers go out one at a time, so the first one is the interaction's response. */
  #chain: Promise<unknown> = Promise.resolve();
  #timer: ReturnType<typeof setTimeout> | undefined;
  readonly createdAt = Date.now();

  constructor(api: API, interaction: APIInteraction, log: (message: string, error?: unknown) => void) {
    this.#api = api;
    this.#interaction = interaction;
    this.#log = log;
  }

  get id(): string {
    return this.#interaction.id;
  }

  /** Acknowledges the press without a change if nothing has answered by then. */
  arm(ms = ANSWER_WITHIN_MS): void {
    this.#timer = setTimeout(() => void this.#defer(), ms);
    this.#timer.unref?.();
  }

  #defer(): Promise<unknown> {
    return this.#queue(async () => {
      if (this.#state !== "none") return null;
      this.#state = "deferred";
      await this.#api.interactions.deferMessageUpdate(this.#interaction.id, this.#interaction.token);
      return null;
    }).catch((e) => this.#log("インタラクションの受け付けに失敗", e));
  }

  #queue<T>(task: () => Promise<T>): Promise<T> {
    const next = this.#chain.then(task, task);
    this.#chain = next.catch(() => undefined);
    return next;
  }

  send(response: unknown): Promise<string | null> {
    return this.#queue(async () => {
      const r = response as { type?: unknown; data?: Record<string, unknown> } | null;
      if (typeof r?.type !== "number" || !ANSWER_TYPES.has(r.type)) return "respond の type は 4・5・6・7・9 のどれかです";
      // Never ping anyone from a rule's answer.
      const data = r.type === InteractionResponseType.Modal ? r.data : { ...r.data, allowed_mentions: { parse: [] } };
      const { id, token, application_id } = this.#interaction;
      try {
        if (this.#state === "none") {
          clearTimeout(this.#timer);
          await this.#api.rest.post(Routes.interactionCallback(id, token), { body: { type: r.type, ...(data ? { data } : {}) }, auth: false });
          this.#state = "answered";
          return null;
        }
        if (r.type === InteractionResponseType.Modal) return "最初の応答に間に合わなかったため、フォームを出せませんでした(フォームはほかの応答より先に、3秒以内に返します)";
        if (r.type === InteractionResponseType.ChannelMessageWithSource) {
          await this.#api.interactions.followUp(application_id, token, data as never);
          return null;
        }
        if (r.type === InteractionResponseType.UpdateMessage && this.#state === "deferred") {
          await this.#api.interactions.editReply(application_id, token, data as never);
          this.#state = "answered";
          return null;
        }
        if (r.type === InteractionResponseType.UpdateMessage) return "もう応答済みのため、メッセージを書き換えられませんでした";
        return null; // A later "wait" changes nothing.
      } catch (e) {
        return `応答をDiscordが受け付けませんでした: ${e instanceof Error ? e.message : String(e)}`.slice(0, 500);
      }
    });
  }

  async failed(ruleName: string, reason?: string): Promise<void> {
    const content = `ルール「${ruleName}」の実行に失敗しました${reason ? `: ${reason}` : ""}`.slice(0, 2000);
    const error = await this.send({ type: InteractionResponseType.ChannelMessageWithSource, data: { content, flags: MessageFlags.Ephemeral } });
    if (error) this.#log(`ルール「${ruleName}」の失敗を伝えられませんでした: ${error}`);
  }

  /** Nothing will answer (no rule fired): the press is acknowledged with a note only the presser sees. */
  async note(content: string): Promise<void> {
    const error = await this.send({ type: InteractionResponseType.ChannelMessageWithSource, data: { content, flags: MessageFlags.Ephemeral } });
    if (error) this.#log(`インタラクションに応答できませんでした: ${error}`);
  }
}
