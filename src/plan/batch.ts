import type { Step } from "./types.ts";

// Steps that Discord can take in one request. A plan is still shown, checked
// and recorded step by step; only the sending merges a run of neighbouring
// steps of the same kind. A step whose result a later step refers to is sent
// on its own, so the reference still gets the response.

const DISCORD_EPOCH = 1420070400000n;
/** Bulk delete refuses messages older than two weeks; an hour of margin for the clock and the send. */
const BULK_DELETE_MAX_AGE_MS = 14 * 24 * 3600_000 - 3600_000;

interface Kind {
  /** Steps with the same key can share a request; null means the step is sent alone. */
  key: (step: Step, now: number) => string | null;
  max: number;
  request: (steps: Step[], guildId: string) => { method: "PATCH" | "POST"; path: `/${string}`; body: unknown };
}

const POSITION_FIELDS = new Set(["position", "parent_id"]);

const KINDS: Record<string, Kind> = {
  // PATCH /guilds/{guild}/channels: positions and categories of many channels at once.
  "PATCH /channels/{channel}": {
    key: (step) => (onlyFields(step.body, POSITION_FIELDS) ? "channel-positions" : null),
    max: 100,
    request: (steps, guildId) => ({
      method: "PATCH",
      path: `/guilds/${guildId}/channels`,
      body: steps.map((s) => ({ id: String(s.pathParams.channel), ...(s.body as Record<string, unknown>) })),
    }),
  },
  // PATCH /guilds/{guild}/roles: positions of many roles at once.
  "PATCH /guilds/{guild}/roles/{role}": {
    key: (step) => (onlyFields(step.body, new Set(["position"])) ? "role-positions" : null),
    max: 100,
    request: (steps, guildId) => ({
      method: "PATCH",
      path: `/guilds/${guildId}/roles`,
      body: steps.map((s) => ({ id: String(s.pathParams.role), position: (s.body as { position: number }).position })),
    }),
  },
  // POST /channels/{channel}/messages/bulk-delete: 2 to 100 messages of one channel, none older than two weeks.
  "DELETE /channels/{channel}/messages/{message}": {
    key: (step, now) => {
      const age = now - snowflakeTime(step.pathParams.message);
      return age >= 0 && age < BULK_DELETE_MAX_AGE_MS ? `delete:${step.pathParams.channel}` : null;
    },
    max: 100,
    request: (steps) => ({
      method: "POST",
      path: `/channels/${steps[0]!.pathParams.channel}/messages/bulk-delete`,
      body: { messages: steps.map((s) => String(s.pathParams.message)) },
    }),
  },
  // POST /guilds/{guild}/bulk-ban: up to 200 users with the same message deletion.
  "PUT /guilds/{guild}/bans/{user}": {
    key: (step) => `ban:${(step.body as { delete_message_seconds?: number } | undefined)?.delete_message_seconds ?? 0}`,
    max: 200,
    request: (steps, guildId) => ({
      method: "POST",
      path: `/guilds/${guildId}/bulk-ban`,
      body: {
        user_ids: steps.map((s) => String(s.pathParams.user)),
        delete_message_seconds: (steps[0]!.body as { delete_message_seconds?: number } | undefined)?.delete_message_seconds ?? 0,
      },
    }),
  },
};

function onlyFields(body: unknown, allowed: Set<string>): boolean {
  if (typeof body !== "object" || body === null) return false;
  const keys = Object.keys(body);
  return keys.length > 0 && keys.every((k) => allowed.has(k));
}

function snowflakeTime(id: unknown): number {
  return typeof id === "string" && /^\d{1,20}$/.test(id) ? Number((BigInt(id) >> 22n) + DISCORD_EPOCH) : Number.NaN;
}

/** Ids of the steps some step refers to with `$ref`. */
export function referencedSteps(steps: Step[]): Set<string> {
  const ids = new Set<string>();
  const json = JSON.stringify(steps.map((s) => [s.pathParams, s.body]));
  for (const m of json.matchAll(/"\$ref":"steps\.([^."]+)\./g)) ids.add(m[1]!);
  return ids;
}

/** The batch key of a resolved step, or null when it must be sent alone. */
export function batchKey(step: Step, referenced: Set<string>, now: number): string | null {
  const kind = KINDS[step.op];
  if (!kind || referenced.has(step.id)) return null;
  const key = kind.key(step, now);
  return key === null ? null : `${step.op}\u0000${key}`;
}

/** How many steps a batch of this step's kind can hold. */
export function batchMax(step: Step): number {
  return KINDS[step.op]?.max ?? 1;
}

/** The one request that carries all of `steps` (same batch key, two or more). */
export function batchRequest(steps: Step[], guildId: string): { method: "PATCH" | "POST"; path: `/${string}`; body: unknown } {
  return KINDS[steps[0]!.op]!.request(steps, guildId);
}

/** Per step, whether the batch did it: bulk ban reports users it could not ban. */
export function batchOutcome(steps: Step[], response: unknown): Array<string | null> {
  if (steps[0]!.op !== "PUT /guilds/{guild}/bans/{user}") return steps.map(() => null);
  const failed = new Set((response as { failed_users?: string[] } | null)?.failed_users ?? []);
  return steps.map((s) => (failed.has(String(s.pathParams.user)) ? "BANできませんでした" : null));
}
