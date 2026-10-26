import { createAssistantMessageEventStream, createModels, isModelType } from "@earendil-works/pi-ai";
import type { Api, ClassifierApi, ClassifierModel, Model, ThinkingLevel } from "@earendil-works/pi-ai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
import { typesafeProvider } from "@earendil-works/pi-ai/providers/typesafe";
import { zaiProvider } from "@earendil-works/pi-ai/providers/zai";

export const PROVIDERS = {
  anthropic: { label: "Claude API" },
  // TypeSafe only serves classifiers (Jev), so it is offered for addressee judgment and reactions only.
  typesafe: { label: "TypeSafe" },
  // pi-ai's "zai" provider is Z.AI's GLM Coding Plan endpoint (api.z.ai/api/coding).
  zai: { label: "GLM Coding Plan" },
  // Chat models through the Responses API, plus the Decisions API (gpt-6-luna) for judgment and reactions.
  openai: { label: "OpenAI" },
  // Hundreds of models from many vendors (chat and classifiers such as Jev), chosen by typing the id.
  openrouter: { label: "OpenRouter" },
} as const;

export type ProviderId = keyof typeof PROVIDERS;

/** Providers with too many models for a select menu; the person types the model id instead. */
export const TYPED_MODEL_PROVIDERS: ReadonlySet<ProviderId> = new Set(["openrouter"]);

/** Every key a person can register: the LLM providers, plus services the agent's tools call. */
export const KEY_PROVIDERS = {
  ...PROVIDERS,
  // Web search and page reading for any model (src/agent/web.ts).
  tavily: { label: "Tavily" },
} as const;

export type KeyProviderId = keyof typeof KEY_PROVIDERS;
export type ModelRole = "response" | "judge" | "addressee" | "code" | "reaction";

/** Roles that take a classifier as well as a chat model. */
export function judgesOnly(role: ModelRole): boolean {
  return role === "judge" || role === "addressee" || role === "reaction";
}

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
llm.setProvider(openaiProvider());
llm.setProvider(openrouterProvider());

/**
 * OpenRouter models whose endpoint refuses requests with thinking off but are not marked
 * `off: null` in the catalog. They are learned from the 400 and kept until restart.
 */
const mustThink = new Set<string>();
const MUST_THINK_ERROR = /Reasoning is mandatory/i;

export function isMustThinkError(message: string | undefined): boolean {
  return !!message && MUST_THINK_ERROR.test(message);
}

function thinksAnyway(model: Model<Api>): boolean {
  return model.provider === "openrouter" && mustThink.has(model.id);
}

/** Mark a model as one that cannot skip thinking (also used by tests). */
export function rememberMustThink(model: Model<Api>): void {
  mustThink.add(model.id);
}

// The bot asks for no thinking, which OpenRouter sends as `reasoning: { effort: "none" }`.
// When the endpoint answers that thinking is mandatory, the request is sent again once with the
// lightest level, and later requests to that model start there.
const streamWithoutRetry = llm.streamSimple.bind(llm);
llm.streamSimple = (model, context, options) => {
  if (model.provider !== "openrouter" || !model.reasoning || options?.reasoning) return streamWithoutRetry(model, context, options);
  const thinking = { ...options, reasoning: lightestLevel(model), maxTokens: Math.max(options?.maxTokens ?? 0, 2000) };
  if (thinksAnyway(model)) return streamWithoutRetry(model, context, thinking);
  const out = createAssistantMessageEventStream();
  void (async () => {
    for await (const event of streamWithoutRetry(model, context, options)) {
      if (event.type === "error" && event.reason === "error" && isMustThinkError(event.error.errorMessage)) {
        rememberMustThink(model);
        for await (const retried of streamWithoutRetry(model, context, thinking)) out.push(retried);
        return out.end();
      }
      out.push(event);
    }
    out.end();
  })();
  return out;
};

// Dated snapshots duplicate their alias (claude-sonnet-4-5 vs claude-sonnet-4-5-20250929)
// and only lengthen the select menus.
const DATED_SNAPSHOT = /-\d{8}$|-\d{4}-\d{2}-\d{2}$/;
// OpenAI lists every model it ever served; the menus offer the current general-purpose
// ones (GPT-5.5 and later, without Pro). A model chosen before stays valid.
const OPENAI_CURRENT = /^gpt-(5\.[5-9]|[6-9])(\.\d+)?(-(luna|sol|terra|astra))?$/;

export function selectableModels(provider: ProviderId, role: ModelRole): JudgeModel[] {
  const chat = llm.getModels(provider).filter((m) => !DATED_SNAPSHOT.test(m.id) && (provider !== "openai" || OPENAI_CURRENT.test(m.id)));
  // Judging and choosing reactions also take classifiers.
  if (!judgesOnly(role)) return chat;
  // A classifier shadows a chat model of the same id (gpt-6-luna): settings store only the id,
  // and findJudgeModel picks the classifier.
  const classifiers = llm.getModelsOfType("classifier", provider);
  return [...classifiers, ...chat.filter((m) => !classifiers.some((c) => c.id === m.id))];
}

export function findChatModel(provider: ProviderId, modelId: string): Model<Api> | undefined {
  return llm.getModel(provider, modelId);
}

export function findJudgeModel(provider: ProviderId, modelId: string): JudgeModel | undefined {
  return llm.getModelOfType("classifier", provider, modelId) ?? llm.getModel(provider, modelId);
}

export function findModel(role: ModelRole, provider: ProviderId, modelId: string): JudgeModel | undefined {
  return judgesOnly(role) ? findJudgeModel(provider, modelId) : findChatModel(provider, modelId);
}

/** The judge model, or the default language model when none is set. */
export function judgeRef<T>(settings: { response: T | null; judge: T | null }): T | null {
  return settings.judge ?? settings.response;
}

export function isClassifier(model: JudgeModel): model is ClassifierModel<ClassifierApi> {
  return isModelType(model, "classifier");
}

const THINKING_LEVELS: ThinkingLevel[] = ["minimal", "low", "medium", "high", "xhigh", "max"];

/**
 * The bot answers without thinking where it can. Some models reject requests
 * with thinking off, marked by `off: null` in their level map; those get their
 * lightest supported level instead, as do OpenRouter models learned to refuse
 * (see llm.streamSimple above).
 */
export function lightestThinking(model: Model<Api>): ThinkingLevel | undefined {
  if (thinksAnyway(model)) return lightestLevel(model);
  const map = model.thinkingLevelMap;
  if (!model.reasoning || !map || map.off !== null) return undefined;
  return lightestLevel(model);
}

function lightestLevel(model: Model<Api>): ThinkingLevel {
  return THINKING_LEVELS.find((level) => model.thinkingLevelMap?.[level] !== null) ?? "minimal";
}
