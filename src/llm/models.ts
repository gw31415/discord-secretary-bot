import { createModels } from "@earendil-works/pi-ai";
import type { Api, Model, ThinkingLevel } from "@earendil-works/pi-ai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { opencodeGoProvider } from "@earendil-works/pi-ai/providers/opencode-go";
import { zaiProvider } from "@earendil-works/pi-ai/providers/zai";

export const PROVIDERS = {
  anthropic: { label: "Claude API" },
  "opencode-go": { label: "OpenCode Go" },
  // pi-ai's "zai" provider is the global GLM Coding Plan endpoint (api.z.ai/api/coding).
  zai: { label: "GLM Coding Plan" },
} as const;

export type ProviderId = keyof typeof PROVIDERS;

export function isProviderId(value: string): value is ProviderId {
  return Object.hasOwn(PROVIDERS, value);
}

/** The model collection every LLM call goes through. Keys are passed per request. */
export const llm = createModels();
llm.setProvider(anthropicProvider());
llm.setProvider(opencodeGoProvider());
llm.setProvider(zaiProvider());

// Dated snapshots duplicate their alias (claude-sonnet-4-5 vs claude-sonnet-4-5-20250929)
// and only lengthen the select menus.
const DATED_SNAPSHOT = /-\d{8}$/;

export function selectableModels(provider: ProviderId): Model<Api>[] {
  return llm.getModels(provider).filter((m) => !DATED_SNAPSHOT.test(m.id));
}

export function findModel(provider: ProviderId, modelId: string): Model<Api> | undefined {
  return llm.getModel(provider, modelId);
}

const THINKING_LEVELS: ThinkingLevel[] = ["minimal", "low", "medium", "high", "xhigh", "max"];

/**
 * The bot answers without thinking where it can. Some models (GLM-5.3) reject
 * requests with thinking off, marked by `off: null` in their level map; those get
 * their lightest supported level instead.
 */
export function lightestThinking(model: Model<Api>): ThinkingLevel | undefined {
  const map = model.thinkingLevelMap;
  if (!model.reasoning || !map || map.off !== null) return undefined;
  return THINKING_LEVELS.find((level) => map[level] !== null);
}
