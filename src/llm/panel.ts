import { ButtonStyle, ComponentType, MessageFlags, TextInputStyle } from "discord-api-types/v10";
import type {
  APIActionRowComponent,
  APIButtonComponent,
  APIComponentInContainer,
  APIMessageTopLevelComponent,
  APIModalInteractionResponseCallbackData,
  APIStringSelectComponent,
} from "discord-api-types/v10";
import type { ReadScopeSetting, Store } from "../db.ts";
import { isWebTool, WEB_TOOLS, webToolWarning } from "../agent/web.ts";
import type { WebTool } from "../agent/web.ts";
import { findModel, isClassifier, isKeyProviderId, isProviderId, KEY_PROVIDERS, PROVIDERS, selectableModels } from "./models.ts";
import type { KeyProviderId, ModelRole, ProviderId } from "./models.ts";

export type { ModelRole };

// The /settings panel: an ephemeral Components V2 message for one user's keys and models.
// The response and judge models are required and never chosen automatically;
// the code and reaction models are optional.


/** An optional role's option for leaving it to the response model. */
const MODEL_UNSET = "none";

export const CUSTOM_ID = {
  keySetSelect: "llm:key:set",
  keyDeleteSelect: "llm:key:delete",
  keyModal: (p: KeyProviderId) => `llm:keymodal:${p}`,
  // Provider and page only keep custom_ids unique; the chosen value carries the model.
  modelSelect: (role: ModelRole, p: ProviderId | "all", page: number) => `llm:model:${role}:${p}:${page}`,
  webSelect: "llm:web:tool",
  readScopeSelect: "llm:read:scope",
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

// One select per role across every provider with a key, split into more
// selects past Discord's 25-option limit so no model is dropped. Optional roles
// lead with the option that leaves the role unset. The panel is near Discord's
// 40-component limit, so providers share a select.
function roleSelects(store: Store, userId: string, role: ModelRole, placeholder: string, unset?: { label: string; description: string }): APIActionRowComponent<APIStringSelectComponent>[] {
  const providers = store.listKeys(userId).map((k) => k.provider).filter(isProviderId);
  const current = store.getSettings(userId)[role];
  const options = [
    ...(unset ? [{ label: unset.label, value: MODEL_UNSET, description: unset.description, default: !current }] : []),
    ...providers.flatMap((provider) =>
      selectableModels(provider, role).map((model) => ({
        label: (isClassifier(model) ? `${model.name}(判定専用)` : model.name).slice(0, 100),
        value: `${provider}/${model.id}`,
        description: `${PROVIDERS[provider].label} · ${model.id}`.slice(0, 100),
        default: current?.provider === provider && current.model === model.id,
      })),
    ),
  ];
  if (options.length === (unset ? 1 : 0)) return [];
  const pages = Math.ceil(options.length / SELECT_LIMIT);
  return Array.from({ length: pages }, (_, page) => ({
    type: ComponentType.ActionRow,
    components: [{
      type: ComponentType.StringSelect,
      custom_id: CUSTOM_ID.modelSelect(role, "all", page),
      placeholder: `${placeholder}${pages > 1 ? ` (${page + 1}/${pages})` : ""}`.slice(0, 150),
      options: options.slice(page * SELECT_LIMIT, (page + 1) * SELECT_LIMIT),
    }],
  }) satisfies APIActionRowComponent<APIStringSelectComponent>);
}

export function renderPanel(store: Store, userId: string, notice?: string): { flags: number; components: APIMessageTopLevelComponent[] } {
  const keys = new Map(store.listKeys(userId).map((k) => [k.provider, k.last4]));
  const status = setupStatus(store, userId);

  const keyLines = (Object.keys(KEY_PROVIDERS) as KeyProviderId[]).map((p) => {
    const last4 = keys.get(p);
    const note = p === "tavily" ? "(Web検索用)" : "";
    return `${KEY_PROVIDERS[p].label}${note}: ${last4 ? `登録済み(末尾 \`${last4}\`)` : "未登録"}`;
  });
  // Two selects instead of a button row per provider: the panel is near Discord's 40-component limit.
  const keySelects: APIComponentInContainer[] = [
    {
      type: ComponentType.ActionRow,
      components: [{
        type: ComponentType.StringSelect,
        custom_id: CUSTOM_ID.keySetSelect,
        placeholder: "キーを登録・差し替える",
        options: (Object.keys(KEY_PROVIDERS) as KeyProviderId[]).map((p) => ({
          label: `${KEY_PROVIDERS[p].label}のキーを${keys.has(p) ? "差し替える" : "登録する"}`,
          value: p,
        })),
      }],
    },
  ];
  const registered = (Object.keys(KEY_PROVIDERS) as KeyProviderId[]).filter((p) => keys.has(p));
  if (registered.length > 0) {
    keySelects.push({
      type: ComponentType.ActionRow,
      components: [{
        type: ComponentType.StringSelect,
        custom_id: CUSTOM_ID.keyDeleteSelect,
        placeholder: "キーを削除する",
        options: registered.map((p) => ({ label: `${KEY_PROVIDERS[p].label}のキーを削除する`, value: p })),
      }],
    });
  }

  const body: APIComponentInContainer[] = [
    { type: ComponentType.TextDisplay, content: "## 設定\nあなたのAPIキー・モデルなどの設定です。この画面はあなたにだけ見えています。" },
    { type: ComponentType.Separator },
    { type: ComponentType.TextDisplay, content: `**APIキー**\n${keyLines.join("\n")}` },
    ...keySelects,
    { type: ComponentType.Separator },
  ];

  const response = roleSelects(store, userId, "response", "応答に使うモデル");
  const judge = roleSelects(store, userId, "judge", "宛先判定に使うモデル");
  if (judge.length > 0) {
    body.push(
      { type: ComponentType.TextDisplay, content: "**応答に使うモデル**(必須)\nBotがあなたに返事をするときに使います。" },
      ...(response.length > 0
        ? response
        : [{ type: ComponentType.TextDisplay, content: "-# 応答に使えるモデルがありません。Claude API・GLM Coding Plan・OpenAIのどれかのキーを登録してください。" } satisfies APIComponentInContainer]),
      { type: ComponentType.TextDisplay, content: "**宛先判定に使うモデル**(必須)\nあなたが起こした会話で、発言がBot宛てかを判定するときに使います。軽いモデルか、判定専用のJev(TypeSafe)・GPT-6 Luna(OpenAIのDecisions API)がおすすめです。" },
      ...judge,
      ...codeSection(store, userId),
      ...reactionSection(store, userId),
    );
  } else {
    body.push({ type: ComponentType.TextDisplay, content: "**モデル**\n先にAPIキーを登録すると、モデルを選べるようになります。" });
  }

  body.push(...webSection(store, userId), readScopeSelect(store, userId));

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

// Optional: without it the response model writes the code itself.
function codeSection(store: Store, userId: string): APIComponentInContainer[] {
  const current = store.getSettings(userId).code;
  const text = current
    ? `**コードを書くモデル**(任意)\n調べもの・変更案・ルールのコードを ${current.model} が書きます。`
    : "**コードを書くモデル**(任意)\n未設定なので、応答に使うモデルがコードも書きます。選ぶと、調べもの・変更案・ルールのコードをそのモデルが書きます。";
  return [
    { type: ComponentType.TextDisplay, content: text },
    ...roleSelects(store, userId, "code", "コードを書くモデル", { label: "応答に使うモデルに任せる", description: "コード用のモデルを使いません" }),
  ];
}

// Optional: without it the response model reacts when it sees fit.
function reactionSection(store: Store, userId: string): APIComponentInContainer[] {
  const current = store.getSettings(userId).reaction;
  const text = current
    ? `**リアクションを選ぶモデル**(任意)\nBotがあなたに答える前に ${current.model} が、文章で返すかリアクションだけで返すかと、どの絵文字にするかを選びます。Botの発言にあなたが付けたリアクションへの応じ方も選びます。`
    : "**リアクションを選ぶモデル**(任意)\n未設定なので、応答に使うモデルが必要に応じてリアクションで返します。選ぶと、文章かリアクションかをそのモデルが先に決めます。Jev(TypeSafe)やGPT-6 Luna(OpenAIのDecisions API)のような判定専用のモデルが向いています。";
  return [
    { type: ComponentType.TextDisplay, content: text },
    ...roleSelects(store, userId, "reaction", "リアクションを選ぶモデル", { label: "応答に使うモデルに任せる", description: "リアクション用のモデルを使いません" }),
  ];
}

// Not required for setup: the bot answers without the web when none works.
function webSection(store: Store, userId: string): APIComponentInContainer[] {
  const settings = store.getSettings(userId);
  const keys = new Set(store.listKeys(userId).map((k) => k.provider));
  const warning = webToolWarning(settings.web, settings.response?.provider, keys);
  return [
    { type: ComponentType.Separator },
    // The warning shares the heading's text display: the panel is at Discord's 40-component limit.
    {
      type: ComponentType.TextDisplay,
      content: [
        "**Webツールと読み取り**",
        "Webツールは、BotがWebを検索したりページを読んだりするときに使います。",
        "Botはふつう、そのチャンネルを見られる全員が見られる情報だけを使います。あなたへの返答でそれ以上が要るとき、あなたが見られる範囲まで広げてよいかを下で選べます。",
        ...(warning ? [`-# ⚠️ ${warning}`] : []),
      ].join("\n"),
    },
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
  ];
}

const READ_SCOPES: Record<ReadScopeSetting, { label: string; description: string }> = {
  ask: { label: "毎回確認する", description: "チャンネルの全員が見られる範囲の外が必要になったら、ボタンで聞きます" },
  always: { label: "常に許可する", description: "必要になったら、確認せずにあなたが見られる範囲まで読みます" },
};

// Replies normally read only what everyone in the channel can see; this decides
// how the bot may go up to the speaker's own permissions when it needs to.
// Only a select, without its own heading: the panel is at Discord's 40-component limit.
function readScopeSelect(store: Store, userId: string): APIComponentInContainer {
  const current = store.getSettings(userId).readScope;
  return {
    type: ComponentType.ActionRow,
    components: [{
      type: ComponentType.StringSelect,
      custom_id: CUSTOM_ID.readScopeSelect,
      placeholder: "読み取りを広げるとき",
      options: (Object.keys(READ_SCOPES) as ReadScopeSetting[]).map((scope) => ({
        label: `読み取りを広げるとき: ${READ_SCOPES[scope].label}`,
        description: READ_SCOPES[scope].description,
        value: scope,
        default: current === scope,
      })),
    }],
  };
}

export function readScopeLabel(scope: ReadScopeSetting): string {
  return READ_SCOPES[scope].label;
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
  | { kind: "clearModel"; role: "code" | "reaction" }
  | { kind: "selectWeb"; tool: WebTool }
  | { kind: "selectReadScope"; scope: ReadScopeSetting };

/** Parses a custom_id (and select value) into an action. Unknown ids return null. */
export function parseCustomId(customId: string, values: string[] = []): PanelAction | null {
  const [ns, kind, arg] = customId.split(":");
  if (ns !== "llm" || !arg) return null;
  if (kind === "key" && (arg === "set" || arg === "delete")) {
    const provider = values[0] ?? "";
    if (!isKeyProviderId(provider)) return null;
    return arg === "set" ? { kind: "openKeyModal", provider } : { kind: "deleteKey", provider };
  }
  // Buttons on panels opened before the key selects.
  if (kind === "key" && isKeyProviderId(arg)) return { kind: "openKeyModal", provider: arg };
  if (kind === "delkey" && isKeyProviderId(arg)) return { kind: "deleteKey", provider: arg };
  if (kind === "keymodal" && isKeyProviderId(arg)) return { kind: "submitKey", provider: arg };
  if (kind === "read" && arg === "scope") {
    const scope = values[0];
    return scope === "ask" || scope === "always" ? { kind: "selectReadScope", scope } : null;
  }
  if (kind === "web" && arg === "tool") {
    const tool = values[0] ?? "";
    return isWebTool(tool) ? { kind: "selectWeb", tool } : null;
  }
  if (kind === "model" && (arg === "response" || arg === "judge" || arg === "code" || arg === "reaction")) {
    const value = values[0] ?? "";
    if ((arg === "code" || arg === "reaction") && value === MODEL_UNSET) return { kind: "clearModel", role: arg };
    const slash = value.indexOf("/");
    const provider = value.slice(0, slash);
    const model = value.slice(slash + 1);
    if (slash < 0 || !isProviderId(provider) || !findModel(arg, provider, model)) return null;
    return { kind: "selectModel", role: arg, provider, model };
  }
  return null;
}
