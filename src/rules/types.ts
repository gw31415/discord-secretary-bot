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
export const MAX_LIMITS: RuleLimits = { perMinute: 60, maxConsecutiveFailures: 20 };

/** The limits a rule asked for, inside what is allowed. */
export function ruleLimits(asked: Partial<RuleLimits> | undefined): RuleLimits {
  const clamp = (v: number | undefined, d: number, max: number) => (Number.isInteger(v) && v! >= 1 ? Math.min(v!, max) : d);
  return {
    perMinute: clamp(asked?.perMinute, DEFAULT_LIMITS.perMinute, MAX_LIMITS.perMinute),
    maxConsecutiveFailures: clamp(asked?.maxConsecutiveFailures, DEFAULT_LIMITS.maxConsecutiveFailures, MAX_LIMITS.maxConsecutiveFailures),
  };
}

export interface RuleTrigger {
  event: string;
  /** More events that fire the same rule; the code tells them apart by `eventName`. */
  events?: string[];
  /**
   * Also fire on events the bot itself caused. Off by default to stop loops.
   * "other_rules" fires on the bot's changes except this rule's own (and except
   * the bot's posts and reactions, whose maker cannot be told apart).
   */
  includeBotOrigin?: boolean | "other_rules";
  /** Cron (minute hour day month weekday) for the SCHEDULE trigger. */
  schedule?: string;
  /** Time zone the schedule is read in. Absent means Asia/Tokyo. */
  timezone?: string;
  /**
   * Waits this long after the last event before running once on the batch;
   * the code reads every event of it as `batch`.
   */
  debounceSeconds?: number;
}

/** What the owner approves. Any change makes a new version that is approved again. */
export interface RuleDefinition {
  name: string;
  /** The request the rule was written from. */
  sourcePrompt: string;
  trigger: RuleTrigger;
  allow: AllowEntry[];
  code: string;
  /** Values the code reads as `params`, e.g. the id of a channel made with the rule. */
  params?: Record<string, unknown>;
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

/** A rule as the agent proposes it inside a plan, before anyone approves it. */
export interface RuleProposal {
  name: string;
  trigger: RuleTrigger;
  allow: AllowEntry[];
  code: string;
  params?: Record<string, unknown>;
  /** An event the agent made up for the dry run when no real one is at hand. */
  sampleEvent?: unknown;
  /** The id of the owner's rule this is a new version of. */
  replaces?: string;
  /** Overrides of DEFAULT_LIMITS. */
  limits?: Partial<RuleLimits>;
}
