import { getModels } from "@mariozechner/pi-ai";
import type { Api, Model } from "@mariozechner/pi-ai";

export const PROVIDERS = {
  anthropic: { label: "Claude API" },
  "opencode-go": { label: "OpenCode Go" },
} as const;

export type ProviderId = keyof typeof PROVIDERS;

export function isProviderId(value: string): value is ProviderId {
  return Object.hasOwn(PROVIDERS, value);
}

// Dated snapshots duplicate their alias (claude-sonnet-4-5 vs claude-sonnet-4-5-20250929)
// and would push the select menu past Discord's 25-option limit.
const DATED_SNAPSHOT = /-\d{8}$/;

export function selectableModels(provider: ProviderId): Model<Api>[] {
  return getModels(provider).filter((m) => !DATED_SNAPSHOT.test(m.id));
}

export function findModel(provider: ProviderId, modelId: string): Model<Api> | undefined {
  return getModels(provider).find((m) => m.id === modelId);
}
