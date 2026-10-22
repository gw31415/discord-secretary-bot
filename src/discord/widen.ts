import type { API } from "@discordjs/core";
import { ButtonStyle, ComponentType, InteractionType, MessageFlags } from "discord-api-types/v10";
import type { APIInteraction } from "discord-api-types/v10";
import { randomUUID } from "node:crypto";

// Asking the speaker to let one reply read beyond what everyone in the channel
// can see. The bot posts the question with two buttons only the speaker can
// press, and the reply waits for the answer (or gives up after a while).

export const WIDEN_TIMEOUT_MS = 2 * 60_000;
const PREFIX = "widen";

interface Pending {
  speakerId: string;
  resolve: (allowed: boolean) => void;
}

export interface WidenRequest {
  channelId: string;
  replyToId: string;
  speakerId: string;
  reason: string;
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
  async ask(input: WidenRequest): Promise<boolean> {
    const token = randomUUID();
    const message = await this.#api.channels.createMessage(input.channelId, {
      content: [
        `🔓 <@${input.speakerId}> さん、この返答のために、あなたが見られる範囲まで読み取りを広げてよいですか?`,
        `理由: ${input.reason.slice(0, 300)}`,
        "-# 許可すると、このチャンネルの全員は見られない内容が返答に入ることがあります。この返答のあいだだけ有効です。",
      ].join("\n"),
      message_reference: { message_id: input.replyToId, fail_if_not_exists: false },
      allowed_mentions: { parse: [], users: [input.speakerId], replied_user: false },
      components: [{
        type: ComponentType.ActionRow,
        components: [
          { type: ComponentType.Button, style: ButtonStyle.Primary, custom_id: `${PREFIX}:${token}:yes`, label: "許可する" },
          { type: ComponentType.Button, style: ButtonStyle.Secondary, custom_id: `${PREFIX}:${token}:no`, label: "許可しない" },
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
        .editMessage(input.channelId, message.id, { content: "🔒 読み取りを広げる許可は、返事がなかったので取り下げました。", components: [] })
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
      await this.#api.interactions.updateMessage(interaction.id, interaction.token, { content: "🔒 この許可の確認はもう終わっています。", components: [] });
      return true;
    }
    if (userId !== pending.speakerId) {
      await this.#api.interactions.reply(interaction.id, interaction.token, { content: "頼んだ本人だけが押せます。", flags: MessageFlags.Ephemeral });
      return true;
    }
    const allowed = answer === "yes";
    pending.resolve(allowed);
    await this.#api.interactions.updateMessage(interaction.id, interaction.token, {
      content: allowed
        ? `🔓 <@${pending.speakerId}> さんの許可で、この返答はその人が見られる範囲まで読み取ります。`
        : "🔒 読み取りは広げずに答えます。",
      components: [],
      allowed_mentions: { parse: [] },
    });
    return true;
  }
}
