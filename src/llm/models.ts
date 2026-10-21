import { createModels, createProvider, envApiKeyAuth, isModelType } from "@earendil-works/pi-ai";
import type { Api, ClassifierApi, ClassifierModel, Model, ProviderStreams, StreamOptions, ThinkingLevel } from "@earendil-works/pi-ai";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { typesafeProvider } from "@earendil-works/pi-ai/providers/typesafe";
import { zaiProvider } from "@earendil-works/pi-ai/providers/zai";

export const PROVIDERS = {
  anthropic: { label: "Claude API" },
  // TypeSafe only serves classifiers (Jev), so it is offered for addressee judgment only.
  typesafe: { label: "TypeSafe" },
  glm: { label: "GLM Coding Plan" },
} as const;

export type ProviderId = keyof typeof PROVIDERS;
export type ModelRole = "response" | "judge";

/** Answers use a chat model; judgment takes a chat model or a classifier. */
export type JudgeModel = Model<Api> | ClassifierModel<ClassifierApi>;

export function isProviderId(value: string): value is ProviderId {
  return Object.hasOwn(PROVIDERS, value);
}

// GLM Coding Plan through Z.AI's Anthropic-compatible endpoint, the route Z.AI documents
// for Claude Code. That endpoint takes the key as a Bearer token (ANTHROPIC_AUTH_TOKEN),
// so it is sent both ways. The model list follows pi-ai's Z.AI catalog.
const GLM_BASE_URL = "https://api.z.ai/api/anthropic";

function withBearer<T extends StreamOptions>(options: T | undefined): T | undefined {
  if (!options?.apiKey) return options;
  return { ...options, headers: { ...options.headers, authorization: `Bearer ${options.apiKey}` } };
}

function glmProvider() {
  const anthropic: ProviderStreams = anthropicMessagesApi();
  return createProvider({
    id: "glm",
    name: "GLM Coding Plan",
    baseUrl: GLM_BASE_URL,
    auth: { apiKey: envApiKeyAuth("GLM Coding Plan API key", []) },
    models: zaiProvider()
      .getModels()
      .map(({ compat: _compat, ...m }) => ({ ...m, api: "anthropic-messages" as const, provider: "glm", baseUrl: GLM_BASE_URL })),
    api: {
      ...anthropic,
      stream: (model, context, options) => anthropic.stream(model, context, withBearer(options)),
      streamSimple: (model, context, options) => anthropic.streamSimple(model, context, withBearer(options)),
    },
  });
}

/** The model collection every LLM call goes through. Keys are passed per request. */
export const llm = createModels();
llm.setProvider(anthropicProvider());
llm.setProvider(typesafeProvider());
llm.setProvider(glmProvider());

// Dated snapshots duplicate their alias (claude-sonnet-4-5 vs claude-sonnet-4-5-20250929)
// and only lengthen the select menus.
const DATED_SNAPSHOT = /-\d{8}$/;

export function selectableModels(provider: ProviderId, role: ModelRole): JudgeModel[] {
  const chat = llm.getModels(provider).filter((m) => !DATED_SNAPSHOT.test(m.id));
  if (role === "response") return chat;
  return [...llm.getModelsOfType("classifier", provider), ...chat];
}

export function findChatModel(provider: ProviderId, modelId: string): Model<Api> | undefined {
  return llm.getModel(provider, modelId);
}

export function findJudgeModel(provider: ProviderId, modelId: string): JudgeModel | undefined {
  return llm.getModelOfType("classifier", provider, modelId) ?? llm.getModel(provider, modelId);
}

export function findModel(role: ModelRole, provider: ProviderId, modelId: string): JudgeModel | undefined {
  return role === "response" ? findChatModel(provider, modelId) : findJudgeModel(provider, modelId);
}

export function isClassifier(model: JudgeModel): model is ClassifierModel<ClassifierApi> {
  return isModelType(model, "classifier");
}

const THINKING_LEVELS: ThinkingLevel[] = ["minimal", "low", "medium", "high", "xhigh", "max"];

/**
 * The bot answers without thinking where it can. Some models reject requests
 * with thinking off, marked by `off: null` in their level map; those get their
 * lightest supported level instead.
 */
export function lightestThinking(model: Model<Api>): ThinkingLevel | undefined {
  const map = model.thinkingLevelMap;
  if (!model.reasoning || !map || map.off !== null) return undefined;
  return THINKING_LEVELS.find((level) => map[level] !== null);
}
