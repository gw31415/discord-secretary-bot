import { Type } from "typebox";
import type { Static } from "typebox";
import type { RuleLimits, RuleTrigger } from "../rules/types.ts";

// Core Plan types. TypeBox gives both the TypeScript type and the JSON Schema
// that validates what the agent proposes.

export type Risk = "read" | "write" | "destructive";
export const RISK_ORDER: Risk[] = ["read", "write", "destructive"];
export const RISK_LABEL: Record<Risk, string> = { read: "読み取り", write: "書き込み", destructive: "破壊的" };

export function maxRisk(risks: Risk[]): Risk {
  return risks.reduce<Risk>((a, b) => (RISK_ORDER.indexOf(b) > RISK_ORDER.indexOf(a) ? b : a), "read");
}

/** Who a write is for. A rule acts with its owner's permissions (a command with its runner's), never its own. */
export type Actor = { kind: "user"; userId: string; via: "conversation" | "panel" | "rule" };

/** A value taken from an earlier step's response, e.g. "steps.s1.result.id". */
export type Ref = { $ref: string };
export const REF_PATTERN = /^steps\.([A-Za-z0-9_-]{1,32})\.result((?:\.[A-Za-z0-9_]+)*)$/;

export function isRef(value: unknown): value is Ref {
  return typeof value === "object" && value !== null && !Array.isArray(value) && Object.keys(value).length === 1 && typeof (value as Ref).$ref === "string";
}

/** An image fetched with attach_image, ready to upload; `data` is base64 so it can live inside a plan. */
export interface Attachment {
  name: string;
  data: string;
}

/** Discord's limit of files on one message. */
export const MAX_IMAGES_PER_REPLY = 10;
/** Images one reply may make, most of them for a change (new emojis, stickers) rather than the reply itself. */
export const MAX_IMAGES_PER_BOX = 100;
export const FILE_ID_PATTERN = "^img[0-9]{1,3}$";
/** Discord shows at most this many images on one message; a dialog shows the first ones. */
export const MAX_DIALOG_IMAGES = 10;

/** What the agent (or sandboxed code) proposes; ids are filled in when missing. */
export const StepDraftSchema = Type.Object(
  {
    id: Type.Optional(Type.String({ pattern: "^[A-Za-z0-9_-]{1,32}$" })),
    op: Type.String({ description: '操作ID。例: "POST /guilds/{guild}/channels"' }),
    path: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: "パスパラメータ。guild は省略可" })),
    query: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
    body: Type.Optional(Type.Unknown()),
  },
  { additionalProperties: false },
);
export type StepDraft = Static<typeof StepDraftSchema>;

export interface Step {
  id: string;
  kind: "call";
  op: string;
  pathParams: Record<string, unknown>;
  query?: Record<string, unknown>;
  body?: unknown;
  idempotencyKey: string;
}

/** The state a step relies on, checked again right before execution. */
export interface Precondition {
  resource: string;
  fields: string[];
  /** The values at proposal time, shown as "before" in the preview and used to restore. */
  values: Record<string, unknown> | null;
  fingerprint: string;
}

export interface Plan {
  id: string;
  guildId: string;
  actor: Actor;
  preconditions: Precondition[];
  steps: Step[];
  /** Display names of every id the plan mentions, fixed at proposal so the preview is deterministic. */
  labels: Record<string, string>;
  risk: Risk;
  /** The plan this one replaced (revised, or proposed again after it expired). */
  revises?: string;
  /** The code that produced the steps, and an explanation written from the code alone. */
  source?: PlanSource;
  /** Set when an event rule made the plan; it runs without a dialog, inside `allow`. */
  rule?: PlanRule;
  /** Event rules the plan registers once its steps have run, approved with the same dialog. */
  rules?: PlanRuleDraft[];
  /** Channels the plan deletes that have never had a message, so nothing is lost for good. */
  emptyChannels?: string[];
  /** Images the plan's posts carry, by the id their steps name in `files`. */
  attachments?: Record<string, Attachment>;
  hash: string;
  createdAt: string;
  expiresAt: string;
}

export interface PlanRule {
  id: string;
  version: number;
  name: string;
  eventId: string;
  /**
   * Who made the rule. A command runs as whoever used it, but its owner must
   * still hold everything the allow list permits. Older plans lack it; the actor is the owner there.
   */
  ownerId?: string;
  /** What the rule's owner approved; every step must fit one entry, checked again with real values. */
  allow: AllowEntry[];
  /** For a run `later()` scheduled from a command, that command's public reply, which whoever ran it may edit. */
  ownReply?: { channelId: string; messageId: string };
}

/**
 * One kind of write a rule may make. Path parameters and the body are JSON
 * Schemas the step's values must satisfy, e.g. { channel: { enum: ["123"] } }.
 */
export interface AllowEntry {
  op: string;
  path?: Record<string, Record<string, unknown>>;
  body?: Record<string, unknown>;
  /**
   * JSON Schema the target's current state must satisfy, read from REST right
   * before the step runs, e.g. { properties: { name: { pattern: "^📞" } } }.
   */
  target?: Record<string, unknown>;
  /**
   * JSON Schema the channel the step acts in must satisfy, read right before
   * the step runs, e.g. { properties: { parent_id: { const: "123" } } } for
   * posting only inside one category.
   */
  channel?: Record<string, unknown>;
  /** Steps of this kind per run. Absent means up to the plan limit. */
  maxStepsPerRun?: number;
}

/**
 * A rule inside a plan. `allow` and `params` may hold refs to the plan's step
 * results (e.g. the id of a channel the plan creates); they are filled in when
 * the steps have run, and the rule is registered then.
 */
/** An uploaded module a rule runs, as the dialog shows it. */
export interface WasmRef {
  sha256: string;
  name: string;
  size: number;
  /** Who uploaded it. */
  ownerId: string;
  producers: string[];
  /** The sources, when the bot compiled it: shown on the approval in place of the bare hash. */
  source?: { language: string; files: Array<{ path: string; content: string }> };
}

export interface PlanRuleDraft {
  /** "r1", "r2", … within the plan. */
  key: string;
  name: string;
  trigger: RuleTrigger;
  allow: AllowEntry[];
  program: { kind: "js"; code: string } | { kind: "wasm"; module: WasmRef };
  /** Values the code reads as `params`. */
  params?: Record<string, unknown>;
  /** Written from the code alone by a model that did not see the request. */
  summary: string | null;
  /** Absent means DEFAULT_LIMITS. */
  limits?: RuleLimits;
  /** An existing rule of the owner's this is a new version of. */
  replaces?: {
    id: string;
    name: string;
    version: number;
    /** The version being replaced, so the dialog can show before and after. Absent when it may not be shown here. */
    before?: { summary: string | null; trigger: RuleTrigger; allow: AllowEntry[]; params?: Record<string, unknown>; limits?: RuleLimits; code?: string };
    /** How the code's behaviour changes, written from both versions' code alone. Empty when the code is the same; absent when it could not be written. */
    changes?: string[];
  };
  /** The dry run at proposal. */
  dry: RuleDryRun;
  /** Kept so proposing the plan again can dry-run the same way. */
  sampleEvent?: unknown;
  /** The request the rule was written for, kept as the rule's source. */
  request: string;
}

export interface RuleDryRun {
  /** Where the event came from, e.g. "直近のメッセージ". Null when there was none. */
  source: string | null;
  /** "pending": it depends on values the plan's steps produce, so it was not tried. */
  outcome: "none" | "steps" | "error" | "no_event" | "pending";
  lines: string[];
  problems: string[];
  logs: string[];
  /** What setState would keep, as JSON; absent when the code did not call it. */
  state?: string;
  /** What a command's code would say back with reply(). */
  reply?: string;
  /** What an INTERACTION_CREATE rule's code would answer with respond(), as JSON. */
  response?: string;
  /** How many images that reply would carry. */
  images?: number;
}

export interface PlanSource {
  code: string;
  /** Null when the explainer failed; the dialog says so instead of guessing. */
  summary: string | null;
}

export type PlanStatus =
  | "pending_approval"
  | "approved"
  | "executing"
  | "succeeded"
  | "cancelled"
  | "aborted"
  | "failed";

export type StepState = "pending" | "in_flight" | "done" | "skipped" | "failed";
