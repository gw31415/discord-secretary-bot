import { Type } from "typebox";
import type { Static } from "typebox";

// Core Plan types. TypeBox gives both the TypeScript type and the JSON Schema
// that validates what the agent proposes.

export type Risk = "read" | "write" | "destructive";
export const RISK_ORDER: Risk[] = ["read", "write", "destructive"];
export const RISK_LABEL: Record<Risk, string> = { read: "読み取り", write: "書き込み", destructive: "破壊的" };

export function maxRisk(risks: Risk[]): Risk {
  return risks.reduce<Risk>((a, b) => (RISK_ORDER.indexOf(b) > RISK_ORDER.indexOf(a) ? b : a), "read");
}

export type Actor = { kind: "user"; userId: string; via: "conversation" | "panel" };

/** A value taken from an earlier step's response, e.g. "steps.s1.result.id". */
export type Ref = { $ref: string };
export const REF_PATTERN = /^steps\.([A-Za-z0-9_-]{1,32})\.result((?:\.[A-Za-z0-9_]+)*)$/;

export function isRef(value: unknown): value is Ref {
  return typeof value === "object" && value !== null && !Array.isArray(value) && Object.keys(value).length === 1 && typeof (value as Ref).$ref === "string";
}

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
  hash: string;
  createdAt: string;
  expiresAt: string;
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
