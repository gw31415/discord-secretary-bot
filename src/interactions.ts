import type { API } from "@discordjs/core";
import { ComponentType, InteractionType, MessageFlags } from "discord-api-types/v10";
import type { APIInteraction, APIModalSubmitInteraction } from "discord-api-types/v10";
import type { Store } from "./db.ts";
import { PROVIDERS } from "./llm/models.ts";
import { keyModal, parseCustomId, renderPanel } from "./llm/panel.ts";

// Interactions arrive over the Gateway (no HTTP endpoint). Each must be answered
// within 3 seconds; everything here is a local DB operation, so no defer is needed.

function modalValue(interaction: APIModalSubmitInteraction, customId: string): string | undefined {
  for (const row of interaction.data.components) {
    const inner = "components" in row ? row.components : "component" in row ? [row.component] : [];
    for (const c of inner) {
      if (c.type === ComponentType.TextInput && c.custom_id === customId) return c.value;
    }
  }
  return undefined;
}

function panelUpdate(store: Store, userId: string, notice?: string) {
  // UPDATE_MESSAGE cannot change the ephemeral flag, so only Components V2 is sent.
  const panel = renderPanel(store, userId, notice);
  return { ...panel, flags: MessageFlags.IsComponentsV2 };
}

export async function handleInteraction(api: API, store: Store, guildId: string, interaction: APIInteraction): Promise<void> {
  if (interaction.guild_id !== guildId) return;
  const userId = interaction.member?.user.id;
  if (!userId) return;
  const actor = { kind: "user" as const, userId, via: "panel" as const };

  if (interaction.type === InteractionType.ApplicationCommand && interaction.data.name === "llm") {
    await api.interactions.reply(interaction.id, interaction.token, renderPanel(store, userId));
    return;
  }

  if (interaction.type === InteractionType.MessageComponent) {
    const values = "values" in interaction.data ? interaction.data.values : [];
    const action = parseCustomId(interaction.data.custom_id, values);
    if (!action) return;
    switch (action.kind) {
      case "openKeyModal":
        await api.interactions.createModal(interaction.id, interaction.token, keyModal(action.provider));
        return;
      case "deleteKey": {
        store.deleteApiKey(userId, action.provider);
        store.audit(actor, "llm.key.delete", { provider: action.provider });
        await api.interactions.updateMessage(
          interaction.id,
          interaction.token,
          panelUpdate(store, userId, `${PROVIDERS[action.provider].label}のキーを削除しました`),
        );
        return;
      }
      case "selectModel": {
        const hasKey = store.listKeys(userId).some((k) => k.provider === action.provider);
        let notice: string;
        if (hasKey) {
          store.setModel(userId, action.role, { provider: action.provider, model: action.model });
          store.audit(actor, "llm.model.set", { role: action.role, provider: action.provider, model: action.model });
          notice = `${action.role === "response" ? "応答" : "宛先判定"}に使うモデルを ${action.model} にしました`;
        } else {
          notice = `${PROVIDERS[action.provider].label}のキーが登録されていません`;
        }
        await api.interactions.updateMessage(interaction.id, interaction.token, panelUpdate(store, userId, notice));
        return;
      }
      default:
        return;
    }
  }

  if (interaction.type === InteractionType.ModalSubmit) {
    const action = parseCustomId(interaction.data.custom_id);
    if (action?.kind !== "submitKey") return;
    const key = modalValue(interaction, "key")?.trim();
    if (!key) return;
    store.setApiKey(userId, action.provider, key);
    store.audit(actor, "llm.key.set", { provider: action.provider }); // never the key itself
    await api.interactions.updateMessage(
      interaction.id,
      interaction.token,
      panelUpdate(store, userId, `${PROVIDERS[action.provider].label}のキーを保存しました`),
    );
  }
}
