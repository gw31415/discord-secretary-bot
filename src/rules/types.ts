import type { AllowEntry } from "../plan/types.ts";

// An event rule: when `trigger` fires, `code` runs in the sandbox and returns
// steps, which run without a dialog as long as each fits `allow` and the owner
// still holds the permissions. The owner approved this exact version.

export interface RuleLimits {
  /** Runs per minute; events past this are skipped and recorded as rate_limited. */
  perMinute: number;
  /** Failed or rejected runs in a row before the rule switches itself off. */
  maxConsecutiveFailures: number;
}

export const DEFAULT_LIMITS: RuleLimits = { perMinute: 10, maxConsecutiveFailures: 3 };

export interface RuleTrigger {
  event: string;
  /** Also fire on events the bot itself caused. Off by default to stop loops. */
  includeBotOrigin?: boolean;
}

/** What the owner approves. Any change makes a new version that is approved again. */
export interface RuleDefinition {
  name: string;
  /** The request the rule was written from. */
  sourcePrompt: string;
  trigger: RuleTrigger;
  allow: AllowEntry[];
  code: string;
  /** Written from the code alone by a model that did not see the request. */
  summary: string | null;
  limits: RuleLimits;
}

export interface Rule extends RuleDefinition {
  id: string;
  guildId: string;
  ownerId: string;
  version: number;
  enabled: boolean;
  consecutiveFailures: number;
  /** Why the rule is off when someone other than its owner (or the bot) switched it off. */
  disabledReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export type RunOutcome = "no_change" | "executed" | "rejected" | "failed" | "rate_limited";

export interface RuleRun {
  id: number;
  ruleId: string;
  ruleVersion: number;
  eventId: string;
  planId: string | null;
  outcome: RunOutcome;
  error: string | null;
  logs: string[];
  startedAt: string;
  finishedAt: string | null;
}

/** A rule as the agent proposes it, before anyone approves it. */
export interface RuleDraft {
  name: string;
  trigger: RuleTrigger;
  allow: AllowEntry[];
  code: string;
  /** An event the agent made up for the dry run when no real one is at hand. */
  sampleEvent?: unknown;
}
