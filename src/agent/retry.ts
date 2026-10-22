import type { Agent, AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";

// A model call can fail partway through a reply: the connection drops mid-stream
// ("This operation was aborted", "terminated"), the provider is overloaded, or it
// answers 5xx. The tools already run are kept in the transcript, so the agent can
// pick up from the step that failed instead of losing the whole reply.

/** Retries of a failed model call within one reply. */
export const MAX_LLM_RETRIES = 2;
const RETRY_DELAY_MS = 1_500;

const TRANSIENT =
  /aborted|terminated|timed? ?out|timeout|socket|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|fetch failed|network|other side closed|overloaded|Stream ended without finish_reason|\b5\d\d\b/i;
/** A 4xx is the request's or the account's problem (a bad key, no balance), and retrying will not help. */
const CLIENT_ERROR = /^\s*4\d\d\b/;

function failedCall(messages: AgentMessage[]): AssistantMessage | null {
  const last = messages[messages.length - 1] as AssistantMessage | undefined;
  return last?.role === "assistant" && last.stopReason === "error" ? last : null;
}

export function isTransient(message: string): boolean {
  return TRANSIENT.test(message) && !CLIENT_ERROR.test(message);
}

/**
 * When the run ended on a model call that failed for a passing reason, drops that
 * call and continues from the step before it. Returns how many retries it made.
 * `canRetry` says whether the reply still has room (turns left, not stopped).
 */
export async function retryFailedCall(
  agent: Agent,
  canRetry: () => boolean,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<number> {
  let retries = 0;
  for (;;) {
    const failed = failedCall(agent.state.messages);
    if (!failed || !isTransient(failed.errorMessage ?? "") || retries >= MAX_LLM_RETRIES || !canRetry()) return retries;
    retries++;
    await sleep(RETRY_DELAY_MS * retries);
    if (!canRetry()) return retries;
    agent.state.messages = agent.state.messages.slice(0, -1);
    await agent.continue();
  }
}
