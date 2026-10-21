import { ButtonStyle, ComponentType, MessageFlags, TextInputStyle } from "discord-api-types/v10";
import type {
  APIActionRowComponent,
  APIButtonComponent,
  APIComponentInContainer,
  APIMessageTopLevelComponent,
  APIModalInteractionResponseCallbackData,
  APIStringSelectComponent,
} from "discord-api-types/v10";
import type { Store } from "../db.ts";
import { findModel, isProviderId, PROVIDERS, selectableModels } from "./models.ts";
import type { ProviderId } from "./models.ts";

// The /llm panel: an ephemeral Components V2 message for one user's keys and models.
// Both models are required and never chosen automatically.

export type ModelRole = "response" | "judge";

export const CUSTOM_ID = {
  keyButton: (p: ProviderId) => `llm:key:${p}`,
  deleteButton: (p: ProviderId) => `llm:delkey:${p}`,
  keyModal: (p: ProviderId) => `llm:keymodal:${p}`,
  // Provider and page only keep custom_ids unique; the chosen value carries the model.
  modelSelect: (role: ModelRole, p: ProviderId, page: number) => `llm:model:${role}:${p}:${page}`,
} as const;

export interface SetupStatus {
  complete: boolean;
  missing: string[];
}

export function setupStatus(store: Store, userId: string): SetupStatus {
  const keys = new Set(store.listKeys(userId).map((k) => k.provider));
  const settings = store.getSettings(userId);
  const missing: string[] = [];
  if (keys.size === 0) missing.push("APIキー");
  for (const [role, label] of [["response", "応答に使うモデル"], ["judge", "宛先判定に使うモデル"]] as const) {
    const ref = settings[role];
    if (!ref) missing.push(label);
    else if (!keys.has(ref.provider)) missing.push(`${label}(${PROVIDERS[ref.provider].label}のキーがありません)`);
    else if (!findModel(ref.provider, ref.model)) missing.push(`${label}(${ref.model}は使えなくなりました)`);
  }
  return { complete: missing.length === 0, missing };
}

const SELECT_LIMIT = 25;

// One select per provider, split into more selects when a provider lists more
// models than Discord's 25-option limit, so no model is dropped.
function modelSelects(store: Store, userId: string, role: ModelRole, placeholder: string): APIActionRowComponent<APIStringSelectComponent>[] {
  const providers = store.listKeys(userId).map((k) => k.provider);
  const current = store.getSettings(userId)[role];
  return providers.flatMap((provider) => {
    const models = selectableModels(provider);
    const pages = Math.ceil(models.length / SELECT_LIMIT);
    return Array.from({ length: pages }, (_, page) => {
      const options = models.slice(page * SELECT_LIMIT, (page + 1) * SELECT_LIMIT).map((model) => ({
        label: model.name.slice(0, 100),
        value: `${provider}/${model.id}`,
        description: model.id.slice(0, 100),
        default: current?.provider === provider && current.model === model.id,
      }));
      const suffix = pages > 1 ? ` (${page + 1}/${pages})` : "";
      return {
        type: ComponentType.ActionRow,
        components: [{
          type: ComponentType.StringSelect,
          custom_id: CUSTOM_ID.modelSelect(role, provider, page),
          placeholder: `${placeholder}: ${PROVIDERS[provider].label}${suffix}`.slice(0, 150),
          options,
        }],
      } satisfies APIActionRowComponent<APIStringSelectComponent>;
    });
  });
}

export function renderPanel(store: Store, userId: string, notice?: string): { flags: number; components: APIMessageTopLevelComponent[] } {
  const keys = new Map(store.listKeys(userId).map((k) => [k.provider, k.last4]));
  const status = setupStatus(store, userId);

  const keyLines = (Object.keys(PROVIDERS) as ProviderId[]).map((p) => {
    const last4 = keys.get(p);
    return `${PROVIDERS[p].label}: ${last4 ? `登録済み(末尾 \`${last4}\`)` : "未登録"}`;
  });
  // One row per provider: an action row holds at most five buttons.
  const buttonRows = (Object.keys(PROVIDERS) as ProviderId[]).map((p): APIComponentInContainer => {
    const registered = keys.has(p);
    const list: APIButtonComponent[] = [
      { type: ComponentType.Button, style: ButtonStyle.Primary, custom_id: CUSTOM_ID.keyButton(p), label: `${PROVIDERS[p].label}のキーを${registered ? "差し替え" : "登録"}` },
    ];
    if (registered) list.push({ type: ComponentType.Button, style: ButtonStyle.Danger, custom_id: CUSTOM_ID.deleteButton(p), label: `${PROVIDERS[p].label}のキーを削除` });
    return { type: ComponentType.ActionRow, components: list };
  });

  const body: APIComponentInContainer[] = [
    { type: ComponentType.TextDisplay, content: "## LLM設定\nあなたのAPIキーとモデルです。この画面はあなたにだけ見えています。" },
    { type: ComponentType.Separator },
    { type: ComponentType.TextDisplay, content: `**APIキー**\n${keyLines.join("\n")}` },
    ...buttonRows,
    { type: ComponentType.Separator },
  ];

  const response = modelSelects(store, userId, "response", "応答に使うモデル");
  const judge = modelSelects(store, userId, "judge", "宛先判定に使うモデル");
  if (response.length > 0 && judge.length > 0) {
    body.push(
      { type: ComponentType.TextDisplay, content: "**応答に使うモデル**(必須)\nBotがあなたに返事をするときに使います。" },
      ...response,
      { type: ComponentType.TextDisplay, content: "**宛先判定に使うモデル**(必須)\nあなたが起こした会話で、発言がBot宛てかを判定するときに使います。軽いモデルがおすすめです。" },
      ...judge,
    );
  } else {
    body.push({ type: ComponentType.TextDisplay, content: "**モデル**\n先にAPIキーを登録すると、モデルを選べるようになります。" });
  }

  body.push(
    { type: ComponentType.Separator },
    {
      type: ComponentType.TextDisplay,
      content: status.complete
        ? "✅ 設定は完了しています。Botをメンションすると会話できます。"
        : `⚠️ 設定が完了していません。未設定: ${status.missing.join("、")}`,
    },
  );
  if (notice) body.push({ type: ComponentType.TextDisplay, content: `-# ${notice}` });

  return {
    flags: MessageFlags.Ephemeral | MessageFlags.IsComponentsV2,
    components: [{ type: ComponentType.Container, components: body }],
  };
}

export function keyModal(provider: ProviderId): APIModalInteractionResponseCallbackData {
  return {
    custom_id: CUSTOM_ID.keyModal(provider),
    title: `${PROVIDERS[provider].label}のAPIキー`,
    components: [
      {
        type: ComponentType.ActionRow,
        components: [
          {
            type: ComponentType.TextInput,
            custom_id: "key",
            label: "APIキー",
            style: TextInputStyle.Short,
            required: true,
            min_length: 10,
            max_length: 512,
            placeholder: "暗号化して保存し、表示は末尾4文字だけにします",
          },
        ],
      },
    ],
  };
}

export type PanelAction =
  | { kind: "openKeyModal"; provider: ProviderId }
  | { kind: "deleteKey"; provider: ProviderId }
  | { kind: "submitKey"; provider: ProviderId }
  | { kind: "selectModel"; role: ModelRole; provider: ProviderId; model: string };

/** Parses a custom_id (and select value) into an action. Unknown ids return null. */
export function parseCustomId(customId: string, values: string[] = []): PanelAction | null {
  const [ns, kind, arg] = customId.split(":");
  if (ns !== "llm" || !arg) return null;
  if (kind === "key" && isProviderId(arg)) return { kind: "openKeyModal", provider: arg };
  if (kind === "delkey" && isProviderId(arg)) return { kind: "deleteKey", provider: arg };
  if (kind === "keymodal" && isProviderId(arg)) return { kind: "submitKey", provider: arg };
  if (kind === "model" && (arg === "response" || arg === "judge")) {
    const value = values[0] ?? "";
    const slash = value.indexOf("/");
    const provider = value.slice(0, slash);
    const model = value.slice(slash + 1);
    if (slash < 0 || !isProviderId(provider) || !findModel(provider, model)) return null;
    return { kind: "selectModel", role: arg, provider, model };
  }
  return null;
}
