import { createModels } from "@earendil-works/pi-ai";
import type { Api, Model } from "@earendil-works/pi-ai";
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
