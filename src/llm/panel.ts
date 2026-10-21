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
import { isWebTool, WEB_TOOLS, webToolWarning } from "../agent/web.ts";
import type { WebTool } from "../agent/web.ts";
import { findModel, isKeyProviderId, isProviderId, KEY_PROVIDERS, PROVIDERS, selectableModels } from "./models.ts";
import type { KeyProviderId, ModelRole, ProviderId } from "./models.ts";

export type { ModelRole };

// The /llm panel: an ephemeral Components V2 message for one user's keys and models.
// Both models are required and never chosen automatically.


export const CUSTOM_ID = {
  keyButton: (p: KeyProviderId) => `llm:key:${p}`,
  deleteButton: (p: KeyProviderId) => `llm:delkey:${p}`,
  keyModal: (p: KeyProviderId) => `llm:keymodal:${p}`,
  // Provider and page only keep custom_ids unique; the chosen value carries the model.
  modelSelect: (role: ModelRole, p: ProviderId, page: number) => `llm:model:${role}:${p}:${page}`,
  webSelect: "llm:web:tool",
} as const;

export interface SetupStatus {
  complete: boolean;
  missing: string[];
}

export function setupStatus(store: Store, userId: string): SetupStatus {
  const keys = new Set(store.listKeys(userId).map((k) => k.provider));
  const settings = store.getSettings(userId);
  const missing: string[] = [];
  if (![...keys].some(isProviderId)) missing.push("APIキー");
  for (const [role, label] of [["response", "応答に使うモデル"], ["judge", "宛先判定に使うモデル"]] as const) {
    const ref = settings[role];
    if (!ref) missing.push(label);
    else if (!keys.has(ref.provider)) missing.push(`${label}(${PROVIDERS[ref.provider].label}のキーがありません)`);
    else if (!findModel(role, ref.provider, ref.model)) missing.push(`${label}(${ref.model}は使えなくなりました)`);
  }
  return { complete: missing.length === 0, missing };
}

const SELECT_LIMIT = 25;

// One select per provider, split into more selects when a provider lists more
// models than Discord's 25-option limit, so no model is dropped.
function modelSelects(store: Store, userId: string, role: ModelRole, placeholder: string): APIActionRowComponent<APIStringSelectComponent>[] {
  const providers = store.listKeys(userId).map((k) => k.provider).filter(isProviderId);
  const current = store.getSettings(userId)[role];
  return providers.flatMap((provider) => {
    const models = selectableModels(provider, role);
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

  const keyLines = (Object.keys(KEY_PROVIDERS) as KeyProviderId[]).map((p) => {
    const last4 = keys.get(p);
    const note = p === "tavily" ? "(Web検索用)" : "";
    return `${KEY_PROVIDERS[p].label}${note}: ${last4 ? `登録済み(末尾 \`${last4}\`)` : "未登録"}`;
  });
  // One row per provider: an action row holds at most five buttons.
  const buttonRows = (Object.keys(KEY_PROVIDERS) as KeyProviderId[]).map((p): APIComponentInContainer => {
    const registered = keys.has(p);
    const list: APIButtonComponent[] = [
      { type: ComponentType.Button, style: ButtonStyle.Primary, custom_id: CUSTOM_ID.keyButton(p), label: `${KEY_PROVIDERS[p].label}のキーを${registered ? "差し替え" : "登録"}` },
    ];
    if (registered) list.push({ type: ComponentType.Button, style: ButtonStyle.Danger, custom_id: CUSTOM_ID.deleteButton(p), label: `${KEY_PROVIDERS[p].label}のキーを削除` });
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
  if (judge.length > 0) {
    body.push(
      { type: ComponentType.TextDisplay, content: "**応答に使うモデル**(必須)\nBotがあなたに返事をするときに使います。" },
      ...(response.length > 0
        ? response
        : [{ type: ComponentType.TextDisplay, content: "-# 応答に使えるモデルがありません。Claude APIのキーを登録してください。" } satisfies APIComponentInContainer]),
      { type: ComponentType.TextDisplay, content: "**宛先判定に使うモデル**(必須)\nあなたが起こした会話で、発言がBot宛てかを判定するときに使います。軽いモデルか、判定専用のJev(TypeSafe)がおすすめです。" },
      ...judge,
    );
  } else {
    body.push({ type: ComponentType.TextDisplay, content: "**モデル**\n先にAPIキーを登録すると、モデルを選べるようになります。" });
  }

  body.push(...webSection(store, userId));

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

// Not required for setup: the bot answers without the web when none works.
function webSection(store: Store, userId: string): APIComponentInContainer[] {
  const settings = store.getSettings(userId);
  const keys = new Set(store.listKeys(userId).map((k) => k.provider));
  const warning = webToolWarning(settings.web, settings.response?.provider, keys);
  return [
    { type: ComponentType.Separator },
    { type: ComponentType.TextDisplay, content: "**Webツール**\nBotがWebを検索したりページを読んだりするときに使います。" },
    {
      type: ComponentType.ActionRow,
      components: [{
        type: ComponentType.StringSelect,
        custom_id: CUSTOM_ID.webSelect,
        placeholder: "Webツール",
        options: (Object.keys(WEB_TOOLS) as WebTool[]).map((tool) => ({
          label: WEB_TOOLS[tool].label,
          value: tool,
          description: WEB_TOOLS[tool].description.slice(0, 100),
          default: settings.web === tool,
        })),
      }],
    },
    ...(warning ? [{ type: ComponentType.TextDisplay, content: `-# ⚠️ ${warning}` } satisfies APIComponentInContainer] : []),
  ];
}

export function keyModal(provider: KeyProviderId): APIModalInteractionResponseCallbackData {
  return {
    custom_id: CUSTOM_ID.keyModal(provider),
    title: `${KEY_PROVIDERS[provider].label}のAPIキー`,
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
  | { kind: "openKeyModal"; provider: KeyProviderId }
  | { kind: "deleteKey"; provider: KeyProviderId }
  | { kind: "submitKey"; provider: KeyProviderId }
  | { kind: "selectModel"; role: ModelRole; provider: ProviderId; model: string }
  | { kind: "selectWeb"; tool: WebTool };

/** Parses a custom_id (and select value) into an action. Unknown ids return null. */
export function parseCustomId(customId: string, values: string[] = []): PanelAction | null {
  const [ns, kind, arg] = customId.split(":");
  if (ns !== "llm" || !arg) return null;
  if (kind === "key" && isKeyProviderId(arg)) return { kind: "openKeyModal", provider: arg };
  if (kind === "delkey" && isKeyProviderId(arg)) return { kind: "deleteKey", provider: arg };
  if (kind === "keymodal" && isKeyProviderId(arg)) return { kind: "submitKey", provider: arg };
  if (kind === "web" && arg === "tool") {
    const tool = values[0] ?? "";
    return isWebTool(tool) ? { kind: "selectWeb", tool } : null;
  }
  if (kind === "model" && (arg === "response" || arg === "judge")) {
    const value = values[0] ?? "";
    const slash = value.indexOf("/");
    const provider = value.slice(0, slash);
    const model = value.slice(slash + 1);
    if (slash < 0 || !isProviderId(provider) || !findModel(arg, provider, model)) return null;
    return { kind: "selectModel", role: arg, provider, model };
  }
  return null;
}
