import type { API } from "@discordjs/core";
import { InteractionType, MessageFlags } from "discord-api-types/v10";
import type { APIInteraction } from "discord-api-types/v10";
import type { Store } from "./db.ts";
import { modalValue } from "./discord/modal.ts";
import { WEB_TOOLS } from "./agent/web.ts";
import { findModel, KEY_PROVIDERS, PROVIDERS } from "./llm/models.ts";
import { keyModal, parseCustomId, readScopeLabel, renderPanel, roleLabel, typedModelModal } from "./llm/panel.ts";

// Interactions arrive over the Gateway (no HTTP endpoint). Each must be answered
// within 3 seconds; everything here is a local DB operation, so no defer is needed.

function panelUpdate(store: Store, userId: string, notice?: string) {
  // UPDATE_MESSAGE cannot change the ephemeral flag, so only Components V2 is sent.
  const panel = renderPanel(store, userId, notice);
  return { ...panel, flags: MessageFlags.IsComponentsV2 };
}

// LLM settings belong to the person, not the server, so the panel is the same in every server.
export async function handleInteraction(api: API, store: Store, interaction: APIInteraction): Promise<void> {
  const userId = interaction.member?.user.id;
  if (!userId) return;
  const actor = { kind: "user" as const, userId, via: "panel" as const };

  if (interaction.type === InteractionType.ApplicationCommand && interaction.data.name === "settings") {
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
          panelUpdate(store, userId, `${KEY_PROVIDERS[action.provider].label}のキーを削除しました`),
        );
        return;
      }
      case "selectModel": {
        const hasKey = store.listKeys(userId).some((k) => k.provider === action.provider);
        let notice: string;
        if (hasKey) {
          store.setModel(userId, action.role, { provider: action.provider, model: action.model });
          store.audit(actor, "llm.model.set", { role: action.role, provider: action.provider, model: action.model });
          notice = `${roleLabel(action.role)}モデルを ${action.model} にしました`;
        } else {
          notice = `${PROVIDERS[action.provider].label}のキーが登録されていません`;
        }
        await api.interactions.updateMessage(interaction.id, interaction.token, panelUpdate(store, userId, notice));
        return;
      }
      case "clearModel": {
        store.setModel(userId, action.role, null);
        store.audit(actor, "llm.model.set", { role: action.role, provider: null, model: null });
        const notice = action.role === "code" ? "コードは応答に使うモデルが書くようにしました" : "リアクションは応答に使うモデルが選ぶようにしました";
        await api.interactions.updateMessage(interaction.id, interaction.token, panelUpdate(store, userId, notice));
        return;
      }
      case "openTypedModelModal":
        await api.interactions.createModal(interaction.id, interaction.token, typedModelModal(action.role));
        return;
      case "selectWeb": {
        store.setWebTool(userId, action.tool);
        store.audit(actor, "llm.web.set", { tool: action.tool });
        await api.interactions.updateMessage(
          interaction.id,
          interaction.token,
          panelUpdate(store, userId, `Webツールを「${WEB_TOOLS[action.tool].label}」にしました`),
        );
        return;
      }
      case "selectReadScope": {
        store.setReadScope(userId, action.scope);
        store.audit(actor, "llm.read_scope.set", { scope: action.scope });
        await api.interactions.updateMessage(
          interaction.id,
          interaction.token,
          panelUpdate(store, userId, `読み取りを広げる許可を「${readScopeLabel(action.scope)}」にしました`),
        );
        return;
      }
      default:
        return;
    }
  }

  if (interaction.type === InteractionType.ModalSubmit) {
    const action = parseCustomId(interaction.data.custom_id);
    if (action?.kind === "submitTypedModel") {
      const model = modalValue(interaction, "model")?.trim().replace(/^openrouter\//, "") ?? "";
      let notice: string;
      if (!store.listKeys(userId).some((k) => k.provider === "openrouter")) {
        notice = "OpenRouterのキーが登録されていません";
      } else if (!findModel(action.role, "openrouter", model)) {
        notice = `OpenRouterに「${model.slice(0, 90)}」という${action.role === "judge" || action.role === "reaction" ? "" : "会話用の"}モデルは見つかりません。openrouter.ai/models のIDを確かめてください`;
      } else {
        store.setModel(userId, action.role, { provider: "openrouter", model });
        store.audit(actor, "llm.model.set", { role: action.role, provider: "openrouter", model });
        notice = `${roleLabel(action.role)}モデルを ${model} にしました`;
      }
      await api.interactions.updateMessage(interaction.id, interaction.token, panelUpdate(store, userId, notice));
      return;
    }
    if (action?.kind !== "submitKey") return;
    const key = modalValue(interaction, "key")?.trim();
    if (!key) return;
    store.setApiKey(userId, action.provider, key);
    store.audit(actor, "llm.key.set", { provider: action.provider }); // never the key itself
    await api.interactions.updateMessage(
      interaction.id,
      interaction.token,
      panelUpdate(store, userId, `${KEY_PROVIDERS[action.provider].label}のキーを保存しました`),
    );
  }
}
