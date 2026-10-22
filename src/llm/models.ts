import { createModels, isModelType } from "@earendil-works/pi-ai";
import type { Api, ClassifierApi, ClassifierModel, Model, ThinkingLevel } from "@earendil-works/pi-ai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { typesafeProvider } from "@earendil-works/pi-ai/providers/typesafe";
import { zaiProvider } from "@earendil-works/pi-ai/providers/zai";

export const PROVIDERS = {
  anthropic: { label: "Claude API" },
  // TypeSafe only serves classifiers (Jev), so it is offered for addressee judgment and reactions only.
  typesafe: { label: "TypeSafe" },
  // pi-ai's "zai" provider is Z.AI's GLM Coding Plan endpoint (api.z.ai/api/coding).
  zai: { label: "GLM Coding Plan" },
} as const;

export type ProviderId = keyof typeof PROVIDERS;

/** Every key a person can register: the LLM providers, plus services the agent's tools call. */
export const KEY_PROVIDERS = {
  ...PROVIDERS,
  // Web search and page reading for any model (src/agent/web.ts).
  tavily: { label: "Tavily" },
} as const;

export type KeyProviderId = keyof typeof KEY_PROVIDERS;
export type ModelRole = "response" | "judge" | "code" | "reaction";

/** Answers use a chat model; judgment takes a chat model or a classifier. */
export type JudgeModel = Model<Api> | ClassifierModel<ClassifierApi>;

export function isProviderId(value: string): value is ProviderId {
  return Object.hasOwn(PROVIDERS, value);
}

export function isKeyProviderId(value: string): value is KeyProviderId {
  return Object.hasOwn(KEY_PROVIDERS, value);
}

/** The model collection every LLM call goes through. Keys are passed per request. */
export const llm = createModels();
llm.setProvider(anthropicProvider());
llm.setProvider(typesafeProvider());
llm.setProvider(zaiProvider());

// Dated snapshots duplicate their alias (claude-sonnet-4-5 vs claude-sonnet-4-5-20250929)
// and only lengthen the select menus.
const DATED_SNAPSHOT = /-\d{8}$/;

export function selectableModels(provider: ProviderId, role: ModelRole): JudgeModel[] {
  const chat = llm.getModels(provider).filter((m) => !DATED_SNAPSHOT.test(m.id));
  // Judging and choosing reactions also take classifiers.
  if (role !== "judge" && role !== "reaction") return chat;
  return [...llm.getModelsOfType("classifier", provider), ...chat];
}

export function findChatModel(provider: ProviderId, modelId: string): Model<Api> | undefined {
  return llm.getModel(provider, modelId);
}

export function findJudgeModel(provider: ProviderId, modelId: string): JudgeModel | undefined {
  return llm.getModelOfType("classifier", provider, modelId) ?? llm.getModel(provider, modelId);
}

export function findModel(role: ModelRole, provider: ProviderId, modelId: string): JudgeModel | undefined {
  return role === "judge" || role === "reaction" ? findJudgeModel(provider, modelId) : findChatModel(provider, modelId);
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
