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
import { findModel, isClassifier, judgesOnly, isKeyProviderId, isProviderId, KEY_PROVIDERS, PROVIDERS, selectableModels, TYPED_MODEL_PROVIDERS } from "./models.ts";
import type { KeyProviderId, ModelRole, ProviderId } from "./models.ts";

export type { ModelRole };

// The /settings panel: an ephemeral Components V2 message for one user's keys and models,
// split into a home page and pages for keys and models. Only the language (response)
// model is required and it is never chosen automatically; the judge model falls back
// to it, and the code and reaction models are optional overrides.


/** An optional role's option for leaving it to the response model. */
const MODEL_UNSET = "none";

export const CUSTOM_ID = {
  keySetSelect: "llm:key:set",
  keyDeleteSelect: "llm:key:delete",
  keyModal: (p: KeyProviderId) => `llm:keymodal:${p}`,
  // Provider and page only keep custom_ids unique; the chosen value carries the model.
  modelSelect: (role: ModelRole, p: ProviderId | "all", page: number) => `llm:model:${role}:${p}:${page}`,
  webSelect: "llm:web:tool",
  typedModelSelect: "llm:typed:role",
  typedModelModal: (role: ModelRole) => `llm:typedmodal:${role}`,
  readScopeSelect: "llm:read:scope",
  page: (page: PanelPage) => `llm:page:${page}`,
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
  for (const [role, label] of [["response", "言語モデル"], ["judge", "判定モデル"]] as const) {
    const ref = settings[role];
    // The judge model is optional: without one, the language model judges.
    if (!ref) {
      if (role === "response") missing.push(label);
      continue;
    }
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
  // A model typed in for OpenRouter is listed alone, so the menu shows what is chosen.
  const typed = current && TYPED_MODEL_PROVIDERS.has(current.provider) && providers.includes(current.provider) ? findModel(role, current.provider, current.model) : undefined;
  const options = [
    ...(unset ? [{ label: unset.label, value: MODEL_UNSET, description: unset.description, default: !current }] : []),
    ...(typed ? [{ label: typed.name.slice(0, 100), value: `${current!.provider}/${typed.id}`.slice(0, 100), description: `${PROVIDERS[current!.provider].label} · ${typed.id}`.slice(0, 100), default: true }] : []),
    ...providers.filter((provider) => !TYPED_MODEL_PROVIDERS.has(provider)).flatMap((provider) =>
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

export type PanelPage = "home" | "keys" | "models" | "advanced";

function navButton(page: PanelPage, label: string, current: PanelPage): APIButtonComponent {
  return { type: ComponentType.Button, custom_id: CUSTOM_ID.page(page), label, style: page === "home" ? ButtonStyle.Secondary : ButtonStyle.Primary, disabled: page === current };
}

/** The settings panel: a home page with the general settings, and pages for keys and models reached by buttons. */
export function renderPanel(store: Store, userId: string, notice?: string, page: PanelPage = "home"): { flags: number; components: APIMessageTopLevelComponent[] } {
  const status = setupStatus(store, userId);
  const body: APIComponentInContainer[] =
    page === "keys" ? keysPage(store, userId) : page === "models" ? modelsPage(store, userId) : page === "advanced" ? advancedPage(store, userId) : homePage(store, userId);
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
  body.push({
    type: ComponentType.ActionRow,
    components: [
      ...(page === "home" ? [] : [navButton("home", "← 設定のトップへ", page)]),
      navButton("keys", "APIキーの管理", page),
      navButton("models", "モデルの選択", page),
      navButton("advanced", "応用設定", page),
    ],
  });
  return {
    flags: MessageFlags.Ephemeral | MessageFlags.IsComponentsV2,
    components: [{ type: ComponentType.Container, components: body }],
  };
}

function modelName(ref: { provider: ProviderId; model: string } | null): string | null {
  return ref ? `${ref.model}(${PROVIDERS[ref.provider].label})` : null;
}

function homePage(store: Store, userId: string): APIComponentInContainer[] {
  const keys = store.listKeys(userId).map((k) => KEY_PROVIDERS[k.provider]?.label ?? k.provider);
  const settings = store.getSettings(userId);
  const language = modelName(settings.response);
  const overrides = [
    ...(settings.addressee ? [`宛先の判定: ${modelName(settings.addressee)}`] : []),
    ...(settings.code ? [`コード: ${modelName(settings.code)}`] : []),
    ...(settings.reaction ? [`リアクション: ${modelName(settings.reaction)}`] : []),
  ];
  return [
    { type: ComponentType.TextDisplay, content: "## 設定\nあなたのAPIキー・モデルなどの設定です。この画面はあなたにだけ見えています。" },
    { type: ComponentType.Separator },
    {
      type: ComponentType.TextDisplay,
      content: [
        `**APIキー**: ${keys.length > 0 ? keys.join("・") : "未登録"}`,
        `**言語モデル**: ${language ?? "未設定"}`,
        `**判定モデル**: ${modelName(settings.judge) ?? (language ? "言語モデルを使う" : "未設定")}`,
        ...(overrides.length > 0 ? [`**応用設定**: ${overrides.join("、")}`] : []),
        `**Webツール**: ${WEB_TOOLS[settings.web].label}`,
      ].join("\n"),
    },
    { type: ComponentType.Separator },
    {
      type: ComponentType.TextDisplay,
      content: "**読み取りを広げるとき**\nBotはふつう、そのチャンネルを見られる全員が見られる情報だけを使います。あなたへの返答でそれ以上が要るとき、あなたが見られる範囲まで広げてよいかを選べます。",
    },
    readScopeSelect(store, userId),
  ];
}

function keysPage(store: Store, userId: string): APIComponentInContainer[] {
  const keys = new Map(store.listKeys(userId).map((k) => [k.provider, k.last4]));
  const keyLines = (Object.keys(KEY_PROVIDERS) as KeyProviderId[]).map((p) => {
    const last4 = keys.get(p);
    const note = p === "tavily" ? "(Web検索用)" : "";
    return `${KEY_PROVIDERS[p].label}${note}: ${last4 ? `登録済み(末尾 \`${last4}\`)` : "未登録"}`;
  });
  const body: APIComponentInContainer[] = [
    { type: ComponentType.TextDisplay, content: "## APIキーの管理\nキーは暗号化して保存し、表示は末尾4文字だけです。" },
    { type: ComponentType.Separator },
    { type: ComponentType.TextDisplay, content: keyLines.join("\n") },
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
    body.push({
      type: ComponentType.ActionRow,
      components: [{
        type: ComponentType.StringSelect,
        custom_id: CUSTOM_ID.keyDeleteSelect,
        placeholder: "キーを削除する",
        options: registered.map((p) => ({ label: `${KEY_PROVIDERS[p].label}のキーを削除する`, value: p })),
      }],
    });
  }
  return body;
}

function modelsPage(store: Store, userId: string): APIComponentInContainer[] {
  const body: APIComponentInContainer[] = [
    { type: ComponentType.TextDisplay, content: "## モデルの選択\nBotがあなたのために使う基本のモデルです。用途ごとに別のモデルにしたいときは「応用設定」で上書きできます。" },
    { type: ComponentType.Separator },
  ];
  if (!store.listKeys(userId).some((k) => isProviderId(k.provider))) {
    body.push({ type: ComponentType.TextDisplay, content: "先に「APIキーの管理」でキーを登録すると、モデルを選べるようになります。" });
    return body;
  }
  const settings = store.getSettings(userId);
  const response = roleSelects(store, userId, "response", "言語モデル");
  body.push(
    { type: ComponentType.TextDisplay, content: "**言語モデル**(必須)\n返事を書く、調べる、変更案やコードを作るなど、文章を書く仕事に使います。" },
    ...(response.length > 0
      ? response
      : [{ type: ComponentType.TextDisplay, content: "-# 返事に使えるモデルがありません。Claude API・GLM Coding Plan・OpenAI・OpenRouterのどれかのキーを登録してください。" } satisfies APIComponentInContainer]),
    {
      type: ComponentType.TextDisplay,
      content: `**判定モデル**(任意)\nはい・いいえ、選択肢からの選択、点数付けやランク付けなど、判定の仕事全般に使います(発言が自分宛てかの判定、コマンドの返事を誰に見せるか、リアクション選び、コードやルールの judge()・rank())。${settings.judge ? "" : "未設定なので言語モデルが判定します。"}軽いモデルか、判定専用のJev(TypeSafe)・GPT-6 Luna(OpenAIのDecisions API)がおすすめです。`,
    },
    ...roleSelects(store, userId, "judge", "判定モデル", { label: "言語モデルを使う", description: "判定にも言語モデルを使います" }),
    ...typedModelSelect(store, userId, ["response", "judge"]),
  );
  return body;
}

function advancedPage(store: Store, userId: string): APIComponentInContainer[] {
  const body: APIComponentInContainer[] = [
    { type: ComponentType.TextDisplay, content: "## 応用設定\n用途ごとに、基本のモデルを別のモデルで上書きします。選ばなければ基本のモデルが使われます。" },
    { type: ComponentType.Separator },
  ];
  if (!store.listKeys(userId).some((k) => isProviderId(k.provider))) {
    body.push({ type: ComponentType.TextDisplay, content: "先に「APIキーの管理」でキーを登録すると、モデルを選べるようになります。" });
    return body;
  }
  const current = store.getSettings(userId).addressee;
  body.push(
    {
      type: ComponentType.TextDisplay,
      content: current
        ? `**宛先を判定するモデル**\nあなたが起こした会話で、発言がBot宛てかを ${current.model} が判定します。`
        : "**宛先を判定するモデル**\n未設定なので、判定モデルが、あなたが起こした会話の発言がBot宛てかを判定します。",
    },
    ...roleSelects(store, userId, "addressee", "宛先を判定するモデル", { label: "判定モデルに任せる", description: "宛先の判定も判定モデルがします" }),
    ...codeSection(store, userId),
    ...reactionSection(store, userId),
    ...typedModelSelect(store, userId, ["addressee", "code", "reaction"]),
    ...webSection(store, userId),
  );
  return body;
}

// Optional: without it the response model writes the code itself.
function codeSection(store: Store, userId: string): APIComponentInContainer[] {
  const current = store.getSettings(userId).code;
  const text = current
    ? `**コードを書くモデル**\n調べもの・変更案・ルールのコードを ${current.model} が書きます。`
    : "**コードを書くモデル**\n未設定なので、言語モデルがコードも書きます。選ぶと、調べもの・変更案・ルールのコードをそのモデルが書きます。";
  return [
    { type: ComponentType.TextDisplay, content: text },
    ...roleSelects(store, userId, "code", "コードを書くモデル", { label: "言語モデルに任せる", description: "コード用のモデルを使いません" }),
  ];
}

// Optional: without it the response model reacts when it sees fit.
function reactionSection(store: Store, userId: string): APIComponentInContainer[] {
  const current = store.getSettings(userId).reaction;
  const text = current
    ? `**リアクションを選ぶモデル**\nBotがあなたに答える前に ${current.model} が、文章で返すかリアクションだけで返すかと、どの絵文字にするかを選びます。Botの発言にあなたが付けたリアクションへの応じ方も選びます。`
    : "**リアクションを選ぶモデル**\n未設定なので、判定モデルが、文章で返すかリアクションだけで返すかとどの絵文字にするかを選びます。Botの発言にあなたが付けたリアクションへの応じ方も選びます。判定専用のモデルが向いています。";
  return [
    { type: ComponentType.TextDisplay, content: text },
    ...roleSelects(store, userId, "reaction", "リアクションを選ぶモデル", { label: "判定モデルに任せる", description: "リアクションも判定モデルが選びます" }),
  ];
}

// Not required for setup: the bot answers without the web when none works.
function webSection(store: Store, userId: string): APIComponentInContainer[] {
  const settings = store.getSettings(userId);
  const keys = new Set(store.listKeys(userId).map((k) => k.provider));
  const warning = webToolWarning(settings.web, settings.response?.provider, keys);
  return [
    { type: ComponentType.Separator },
    {
      type: ComponentType.TextDisplay,
      content: [
        "**Webツール**",
        "BotがWebを検索したりページを読んだりするときに使うものです。",
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

const ROLE_LABEL: Record<ModelRole, string> = { response: "言語", judge: "判定", addressee: "宛先を判定する", code: "コードを書く", reaction: "リアクションを選ぶ" };

export function roleLabel(role: ModelRole): string {
  return ROLE_LABEL[role];
}

// OpenRouter has hundreds of models, so its models are typed in rather than listed.
function typedModelSelect(store: Store, userId: string, roles: ModelRole[]): APIComponentInContainer[] {
  const providers = [...TYPED_MODEL_PROVIDERS].filter((p) => store.listKeys(userId).some((k) => k.provider === p));
  if (providers.length === 0) return [];
  const label = providers.map((p) => PROVIDERS[p].label).join("・");
  return [{
    type: ComponentType.ActionRow,
    components: [{
      type: ComponentType.StringSelect,
      custom_id: CUSTOM_ID.typedModelSelect,
      placeholder: `${label}のモデルをIDで選ぶ`.slice(0, 150),
      options: roles.map((role) => ({
        label: `${label}: ${ROLE_LABEL[role]}モデルをIDで指定`.slice(0, 100),
        description: (judgesOnly(role) ? "例: ~typesafe/jev-latest、anthropic/claude-haiku-5-5" : "例: anthropic/claude-sonnet-5、google/gemini-3-pro").slice(0, 100),
        value: role,
      })),
    }],
  }];
}

export function typedModelModal(role: ModelRole): APIModalInteractionResponseCallbackData {
  return {
    custom_id: CUSTOM_ID.typedModelModal(role),
    title: `OpenRouter: ${ROLE_LABEL[role]}モデル`.slice(0, 45),
    components: [
      {
        type: ComponentType.ActionRow,
        components: [
          {
            type: ComponentType.TextInput,
            custom_id: "model",
            label: "モデルID(openrouter.ai/models に載っているもの)",
            style: TextInputStyle.Short,
            required: true,
            min_length: 3,
            max_length: 90,
            placeholder: judgesOnly(role) ? "~typesafe/jev-latest" : "anthropic/claude-sonnet-5",
          },
        ],
      },
    ],
  };
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
  | { kind: "clearModel"; role: Exclude<ModelRole, "response"> }
  | { kind: "page"; page: PanelPage }
  | { kind: "selectWeb"; tool: WebTool }
  | { kind: "selectReadScope"; scope: ReadScopeSetting }
  | { kind: "openTypedModelModal"; role: ModelRole }
  | { kind: "submitTypedModel"; role: ModelRole };

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
  const isRole = (r: string | undefined): r is ModelRole => r === "response" || r === "judge" || r === "addressee" || r === "code" || r === "reaction";
  if (kind === "typed" && arg === "role") return isRole(values[0]) ? { kind: "openTypedModelModal", role: values[0] } : null;
  if (kind === "typedmodal" && isRole(arg)) return { kind: "submitTypedModel", role: arg };
  if (kind === "page" && (arg === "home" || arg === "keys" || arg === "models" || arg === "advanced")) return { kind: "page", page: arg };
  if (kind === "read" && arg === "scope") {
    const scope = values[0];
    return scope === "ask" || scope === "always" ? { kind: "selectReadScope", scope } : null;
  }
  if (kind === "web" && arg === "tool") {
    const tool = values[0] ?? "";
    return isWebTool(tool) ? { kind: "selectWeb", tool } : null;
  }
  if (kind === "model" && isRole(arg)) {
    const value = values[0] ?? "";
    if (arg !== "response" && value === MODEL_UNSET) return { kind: "clearModel", role: arg };
    const slash = value.indexOf("/");
    const provider = value.slice(0, slash);
    const model = value.slice(slash + 1);
    if (slash < 0 || !isProviderId(provider) || !findModel(arg, provider, model)) return null;
    return { kind: "selectModel", role: arg, provider, model };
  }
  return null;
}
