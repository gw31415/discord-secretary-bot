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
import { ruleCustomId } from "../rules/panel.ts";
import { WASM_SECTION_ID } from "../wasm/panel.ts";

export type { ModelRole };

// The /settings panel: an ephemeral Components V2 message for one user's keys and models,
// split into a home page and pages for keys and models, with the per-use models under the
// models page. Only the language (response) model is required and it is never chosen
// automatically; the judge model falls back to it, and the per-use models override them.


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
function roleSelects(store: Store, userId: string, role: ModelRole, placeholder: string, unset?: string): APIActionRowComponent<APIStringSelectComponent>[] {
  const providers = store.listKeys(userId).map((k) => k.provider).filter(isProviderId);
  const current = store.getSettings(userId)[role];
  // A model typed in for OpenRouter is listed alone, so the menu shows what is chosen.
  const typed = current && TYPED_MODEL_PROVIDERS.has(current.provider) && providers.includes(current.provider) ? findModel(role, current.provider, current.model) : undefined;
  const options = [
    ...(unset ? [{ label: unset, value: MODEL_UNSET, default: !current }] : []),
    ...(typed ? [{ label: typed.name.slice(0, 100), value: `${current!.provider}/${typed.id}`.slice(0, 100), description: `${PROVIDERS[current!.provider].label} · ${typed.id}`.slice(0, 100), default: true }] : []),
    ...providers.filter((provider) => !TYPED_MODEL_PROVIDERS.has(provider)).flatMap((provider) =>
      selectableModels(provider, role).map((model) => ({
        label: (isClassifier(model) ? `${model.name}(判定専用)` : model.name).slice(0, 100),
        value: `${provider}/${model.id}`,
        description: PROVIDERS[provider].label,
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

/** "roles" holds the per-use models, a part of the models page; "lookup" the web tool and the read scope. */
export type PanelPage = "home" | "keys" | "models" | "roles" | "lookup";

const LOOKUP_TITLE = "調べもの";

function navButton(page: PanelPage, label: string, current: PanelPage): APIButtonComponent {
  return { type: ComponentType.Button, custom_id: CUSTOM_ID.page(page), label, style: page === "home" ? ButtonStyle.Secondary : ButtonStyle.Primary, disabled: page === current };
}

/** The settings panel: a home page with the general settings, and pages for keys and models reached by buttons. */
export function renderPanel(store: Store, userId: string, notice?: string, page: PanelPage = "home"): { flags: number; components: APIMessageTopLevelComponent[] } {
  const status = setupStatus(store, userId);
  const body: APIComponentInContainer[] =
    page === "keys" ? keysPage(store, userId) : page === "models" ? modelsPage(store, userId) : page === "roles" ? rolesPage(store, userId) : page === "lookup" ? lookupPage(store, userId) : homePage(store, userId);
  body.push(
    { type: ComponentType.Separator },
    {
      type: ComponentType.TextDisplay,
      content: status.complete
        ? "✅ 設定は済んでいます。Botをメンションすると会話できます。"
        : `⚠️ まだ設定していないものがあります: ${status.missing.join("、")}`,
    },
  );
  if (notice) body.push({ type: ComponentType.TextDisplay, content: `-# ${notice}` });
  // At most three buttons a row; the rules and the commands open their own panels in this message.
  body.push(
    { type: ComponentType.ActionRow, components: [navButton("keys", "APIキー", page), navButton("models", "モデル", page), navButton("lookup", LOOKUP_TITLE, page)] },
    {
      type: ComponentType.ActionRow,
      components: [
        { type: ComponentType.Button, custom_id: ruleCustomId("home"), label: "ルール", style: ButtonStyle.Primary },
        { type: ComponentType.Button, custom_id: ruleCustomId("commands"), label: "コマンド", style: ButtonStyle.Primary },
        { type: ComponentType.Button, custom_id: WASM_SECTION_ID, label: "Wasm", style: ButtonStyle.Primary },
      ],
    },
    // From the per-use page, the モデル button above leads back to the models page.
    ...(page === "home" ? [] : [{ type: ComponentType.ActionRow, components: [navButton("home", "← 設定のトップへ", page)] } satisfies APIActionRowComponent<APIButtonComponent>]),
  );
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
    ...(settings.addressee ? [`宛先の判定 ${modelName(settings.addressee)}`] : []),
    ...(settings.code ? [`コード ${modelName(settings.code)}`] : []),
    ...(settings.reaction ? [`リアクション ${modelName(settings.reaction)}`] : []),
  ];
  return [
    { type: ComponentType.TextDisplay, content: "## 設定\nこの画面はあなたにだけ見えています。" },
    { type: ComponentType.Separator },
    {
      type: ComponentType.TextDisplay,
      content: [
        `**APIキー**: ${keys.length > 0 ? keys.join("・") : "未登録"}`,
        `**言語モデル**: ${language ?? "未設定"}`,
        `**判定モデル**: ${modelName(settings.judge) ?? (language ? "言語モデルと同じ" : "未設定")}`,
        ...(overrides.length > 0 ? [`**用途別のモデル**: ${overrides.join("、")}`] : []),
        `**Webツール**: ${WEB_TOOLS[settings.web].label}`,
        `**読み取りの範囲**: ${READ_SCOPES[settings.readScope].label}`,
      ].join("\n"),
    },
  ];
}

// How the bot gathers information: the web outside the server, and how far it reads inside.
function lookupPage(store: Store, userId: string): APIComponentInContainer[] {
  return [
    { type: ComponentType.TextDisplay, content: `## ${LOOKUP_TITLE}` },
    ...webSection(store, userId),
    { type: ComponentType.Separator },
    {
      type: ComponentType.TextDisplay,
      content: "**読み取りの範囲**\nBotは、チャンネルの全員が見られる情報だけを使います。あなたへの返事にそれより広い情報が要るときの扱いを選んでください。",
    },
    readScopeSelect(store, userId),
  ];
}

function keysPage(store: Store, userId: string): APIComponentInContainer[] {
  const keys = new Map(store.listKeys(userId).map((k) => [k.provider, k.last4]));
  const keyLines = (Object.keys(KEY_PROVIDERS) as KeyProviderId[]).map((p) => {
    const last4 = keys.get(p);
    const note = p === "tavily" ? "(Webツール)" : "";
    return `${KEY_PROVIDERS[p].label}${note}: ${last4 ? `登録済み(末尾 \`${last4}\`)` : "未登録"}`;
  });
  const body: APIComponentInContainer[] = [
    { type: ComponentType.TextDisplay, content: "## APIキー\nキーは暗号化して保存します。表示するのは末尾4文字だけです。" },
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
    { type: ComponentType.TextDisplay, content: "## モデル\nBotがあなたのキーで使うモデルです。用途ごとに変えたいときは「用途別のモデル」で選びます。" },
    { type: ComponentType.Separator },
  ];
  if (!store.listKeys(userId).some((k) => isProviderId(k.provider))) {
    body.push({ type: ComponentType.TextDisplay, content: NO_KEY });
    return body;
  }
  const response = roleSelects(store, userId, "response", "言語モデル");
  body.push(
    { type: ComponentType.TextDisplay, content: "**言語モデル**\n返事を書く、調べものをする、変更案やコードを作るときに使います。" },
    ...(response.length > 0
      ? response
      : [{ type: ComponentType.TextDisplay, content: "-# 言語モデルに使えるモデルがありません。Claude API、GLM Coding Plan、OpenAI、OpenRouterのどれかのキーを登録してください。" } satisfies APIComponentInContainer]),
    {
      type: ComponentType.TextDisplay,
      content: "**判定モデル**\n発言がBot宛てかどうか、コマンドの返事を誰に見せるか、どのリアクションを付けるかを決めるときに使います。コードやルールの judge()・rank() もこのモデルが答えます。軽いモデルか、判定専用のJevやGPT-6 Lunaが向いています。",
    },
    ...roleSelects(store, userId, "judge", "判定モデル", "言語モデルと同じ"),
    ...typedModelSelect(store, userId, ["response", "judge"]),
    { type: ComponentType.ActionRow, components: [navButton("roles", "用途別のモデル", "models")] },
  );
  return body;
}

const NO_KEY = "先に「APIキー」でキーを登録すると、モデルを選べます。";

// Part of the models page: each use takes the language or judge model unless one is chosen here.
function rolesPage(store: Store, userId: string): APIComponentInContainer[] {
  const body: APIComponentInContainer[] = [
    { type: ComponentType.TextDisplay, content: "## 用途別のモデル\n用途ごとに、言語モデルや判定モデルとは別のモデルを選べます。選ばなければ元のモデルを使います。" },
    { type: ComponentType.Separator },
  ];
  if (!store.listKeys(userId).some((k) => isProviderId(k.provider))) {
    body.push({ type: ComponentType.TextDisplay, content: NO_KEY });
    return body;
  }
  body.push(
    { type: ComponentType.TextDisplay, content: "**宛先の判定**\nあなたが始めた会話で、発言がBot宛てかどうかを決めます。" },
    ...roleSelects(store, userId, "addressee", "宛先を判定するモデル", "判定モデルと同じ"),
    { type: ComponentType.TextDisplay, content: "**コード**\n調べもの、変更案、ルールのコードを書きます。" },
    ...roleSelects(store, userId, "code", "コードを書くモデル", "言語モデルと同じ"),
    {
      type: ComponentType.TextDisplay,
      content: "**リアクション**\n文章で返すかリアクションだけで返すか、どの絵文字を付けるかを決めます。Botの発言にあなたが付けたリアクションへの応じ方も決めます。判定専用のモデルが向いています。",
    },
    ...roleSelects(store, userId, "reaction", "リアクションを選ぶモデル", "判定モデルと同じ"),
    ...typedModelSelect(store, userId, ["addressee", "code", "reaction"]),
  );
  return body;
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
        "BotがWebを検索したりページを読んだりするときに使います。",
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
          ...(WEB_TOOLS[tool].description ? { description: WEB_TOOLS[tool].description.slice(0, 100) } : {}),
          default: settings.web === tool,
        })),
      }],
    },
  ];
}

const READ_SCOPES: Record<ReadScopeSetting, { label: string; description: string }> = {
  ask: { label: "毎回確認する", description: "広げる前にボタンで聞きます" },
  always: { label: "常に許可する", description: "聞かずに、あなたが見られる範囲まで読みます" },
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
      placeholder: "読み取りの範囲",
      options: (Object.keys(READ_SCOPES) as ReadScopeSetting[]).map((scope) => ({
        label: READ_SCOPES[scope].label,
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
        label: `${ROLE_LABEL[role]}モデル`.slice(0, 100),
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
            label: "openrouter.ai/models に載っているモデルID",
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
  // "advanced" is the per-use page's id on panels opened before it moved under the models page.
  if (kind === "page" && arg === "advanced") return { kind: "page", page: "roles" };
  if (kind === "page" && (arg === "home" || arg === "keys" || arg === "models" || arg === "roles" || arg === "lookup")) return { kind: "page", page: arg };
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
