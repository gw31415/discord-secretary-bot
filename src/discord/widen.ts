import type { API } from "@discordjs/core";
import { ButtonStyle, ComponentType, InteractionType, MessageFlags } from "discord-api-types/v10";
import type { APIInteraction } from "discord-api-types/v10";
import { randomUUID } from "node:crypto";

// Questions to the speaker in the middle of a reply: letting it read beyond
// what everyone in the channel can see, or going on past its turn limit. The
// bot posts the question with two buttons only the speaker can press, and the
// reply waits for the answer (or gives up after a while).

export const WIDEN_TIMEOUT_MS = 2 * 60_000;
const PREFIX = "widen";

interface Pending {
  speakerId: string;
  resolve: (allowed: boolean) => void;
  /** What the message says once answered. */
  answered: (allowed: boolean, speakerId: string) => string;
}

interface Question {
  channelId: string;
  replyToId: string;
  speakerId: string;
  content: string;
  yes: string;
  no: string;
  answered: (allowed: boolean, speakerId: string) => string;
  expired: string;
}

export interface WidenRequest {
  channelId: string;
  replyToId: string;
  speakerId: string;
  reason: string;
}

export interface ContinueRequest {
  channelId: string;
  replyToId: string;
  speakerId: string;
  turns: number;
}

export class WidenPrompts {
  readonly #api: API;
  readonly #pending = new Map<string, Pending>();
  readonly #timeoutMs: number;

  constructor(api: API, timeoutMs = WIDEN_TIMEOUT_MS) {
    this.#api = api;
    this.#timeoutMs = timeoutMs;
  }

  /** Resolves true when the speaker pressed 許可, false on 許可しない or no answer in time. */
  ask(input: WidenRequest): Promise<boolean> {
    return this.#ask({
      ...input,
      content: [
        `🔓 <@${input.speakerId}> さん、この返答のために、あなたが見られる範囲まで読み取りを広げてよいですか?`,
        `理由: ${input.reason.slice(0, 300)}`,
        "-# 許可すると、このチャンネルの全員は見られない内容が返答に入ることがあります。この返答のあいだだけ有効です。",
      ].join("\n"),
      yes: "許可する",
      no: "許可しない",
      answered: (allowed, speakerId) => (allowed ? `🔓 <@${speakerId}> さんの許可で、この返答はその人が見られる範囲まで読み取ります。` : "🔒 読み取りは広げずに答えます。"),
      expired: "🔒 読み取りを広げる許可は、返事がなかったので取り下げました。",
    });
  }

  /** Resolves true when the speaker pressed 続ける, false on ここで終える or no answer in time. */
  askContinue(input: ContinueRequest): Promise<boolean> {
    return this.#ask({
      ...input,
      content: `⏸️ <@${input.speakerId}> さん、手順が${input.turns}回に達したので止めています。続けますか?`,
      yes: "続ける",
      no: "ここで終える",
      answered: (go) => (go ? "▶️ 続けます。" : "⏹️ ここで終えました。"),
      expired: "⏹️ 返事がなかったので終えました。",
    });
  }

  async #ask(input: Question): Promise<boolean> {
    const token = randomUUID();
    const message = await this.#api.channels.createMessage(input.channelId, {
      content: input.content,
      message_reference: { message_id: input.replyToId, fail_if_not_exists: false },
      allowed_mentions: { parse: [], users: [input.speakerId], replied_user: false },
      components: [{
        type: ComponentType.ActionRow,
        components: [
          { type: ComponentType.Button, style: ButtonStyle.Primary, custom_id: `${PREFIX}:${token}:yes`, label: input.yes },
          { type: ComponentType.Button, style: ButtonStyle.Secondary, custom_id: `${PREFIX}:${token}:no`, label: input.no },
        ],
      }],
    });
    const allowed = await new Promise<boolean | null>((resolve) => {
      const timer = setTimeout(() => {
        this.#pending.delete(token);
        resolve(null);
      }, this.#timeoutMs);
      this.#pending.set(token, {
        speakerId: input.speakerId,
        answered: input.answered,
        resolve: (ok) => {
          clearTimeout(timer);
          this.#pending.delete(token);
          resolve(ok);
        },
      });
    });
    if (allowed === null) {
      // Nobody pressed: take the buttons away so a late press does nothing.
      await this.#api.channels
        .editMessage(input.channelId, message.id, { content: input.expired, components: [], allowed_mentions: { parse: [] } })
        .catch(() => undefined);
    }
    return allowed === true;
  }

  /** Handles a press on one of the buttons; returns false for interactions that are not ours. */
  async handleInteraction(interaction: APIInteraction): Promise<boolean> {
    if (interaction.type !== InteractionType.MessageComponent) return false;
    const [ns, token, answer] = interaction.data.custom_id.split(":");
    if (ns !== PREFIX || !token) return false;
    const userId = interaction.member?.user.id ?? interaction.user?.id;
    const pending = this.#pending.get(token);
    if (!pending) {
      await this.#api.interactions.updateMessage(interaction.id, interaction.token, { content: "この確認はもう終わっています。", components: [] });
      return true;
    }
    if (userId !== pending.speakerId) {
      await this.#api.interactions.reply(interaction.id, interaction.token, { content: "頼んだ本人だけが押せます。", flags: MessageFlags.Ephemeral });
      return true;
    }
    const allowed = answer === "yes";
    pending.resolve(allowed);
    await this.#api.interactions.updateMessage(interaction.id, interaction.token, {
      content: pending.answered(allowed, pending.speakerId),
      components: [],
      allowed_mentions: { parse: [] },
    });
    return true;
  }
}
