import type { API } from "@discordjs/core";
import { InteractionType, MessageFlags } from "discord-api-types/v10";
import type { APIInteraction } from "discord-api-types/v10";
import type { Rendered } from "./ui.ts";

// The ways the bot answers a press that several handlers share.

type Answerable = Pick<APIInteraction, "id" | "token" | "application_id">;

/** A reply only the presser sees; nobody named in it is pinged. */
export function replyEphemeral(api: API, interaction: Answerable, content: string) {
  return api.interactions.reply(interaction.id, interaction.token, { content, flags: MessageFlags.Ephemeral, allowed_mentions: { parse: [] } });
}

/** UPDATE_MESSAGE cannot change the ephemeral flag, so only Components V2 is sent. */
export function asUpdate<T extends { flags: number }>(rendered: T): T {
  return { ...rendered, flags: MessageFlags.IsComponentsV2 };
}

/** Replaces the pressed message with a panel's view. */
export function updateV2(api: API, interaction: Answerable, rendered: Rendered) {
  return api.interactions.updateMessage(interaction.id, interaction.token, asUpdate(rendered));
}

/** Replaces the pressed message with a panel's view after a deferred update. */
export function editV2(api: API, interaction: Answerable, rendered: Rendered) {
  return api.interactions.editReply(interaction.application_id, interaction.token, asUpdate(rendered));
}

/** What a select was set to; empty for buttons and forms. */
export function selectedValues(interaction: APIInteraction): string[] {
  return interaction.type === InteractionType.MessageComponent && "values" in interaction.data ? interaction.data.values : [];
}

/** Who pressed: the member in a server, the user elsewhere. */
export function userIdOf(interaction: Pick<APIInteraction, "member" | "user">): string | undefined {
  return interaction.member?.user.id ?? interaction.user?.id;
}
