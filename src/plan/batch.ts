import type { Step } from "./types.ts";

// Steps that Discord can take in one request. A plan is still shown, checked
// and recorded step by step; only the sending merges a run of neighbouring
// steps that share a batch key. A step whose result a later step refers to is
// sent on its own, so the reference still gets the response.
//
// Discord's write API was gone through for requests that carry several
// changes. Besides the ones below there are only whole-list replacements the
// bot does not expose to plans (application commands, onboarding, welcome
// screen); kicks, unbans, member moves, channel and role creation and
// deletion, messages, DMs, reactions, pins, threads, invites, emojis and
// stickers are one per request.

const DISCORD_EPOCH = 1420070400000n;
/** Bulk delete refuses messages older than two weeks; an hour of margin for the clock and the send. */
const BULK_DELETE_MAX_AGE_MS = 14 * 24 * 3600_000 - 3600_000;

export type Read = (path: `/${string}`) => Promise<unknown>;
export interface BatchRequest {
  method: "PATCH" | "POST";
  path: `/${string}`;
  body: unknown;
}

interface Kind {
  /** Steps with the same key can share a request; null means the step is sent alone. */
  key: (step: Step, now: number) => string | null;
  /** What a step changes; two steps changing the same thing are not put in one list. */
  item?: (step: Step) => string;
  /** Fewest steps worth a batch (a batch that reads first costs a request). */
  min: number;
  max: number;
  request: (steps: Step[], guildId: string, read: Read) => Promise<BatchRequest>;
}

const POSITION_FIELDS = new Set(["position", "parent_id"]);

const channelPositions: Kind = {
  // PATCH /guilds/{guild}/channels: positions and categories of many channels.
  key: (step) => (onlyFields(step.body, POSITION_FIELDS) ? "channel-positions" : null),
  item: (step) => String(step.pathParams.channel),
  min: 2,
  max: 100,
  request: async (steps, guildId) => ({
    method: "PATCH",
    path: `/guilds/${guildId}/channels`,
    body: steps.map((s) => ({ id: String(s.pathParams.channel), ...(s.body as Record<string, unknown>) })),
  }),
};

/** Several changes to one resource become one PATCH with their fields together; a later step's value wins, as it would in order. */
function samePatch(param: string): Kind {
  return {
    key: (step) => `patch:${step.op}:${step.pathParams[param]}`,
    min: 2,
    max: 50,
    request: async (steps) => ({
      method: "PATCH",
      path: pathOf(steps[0]!),
      body: Object.assign({}, ...steps.map((s) => s.body as Record<string, unknown>)),
    }),
  };
}

const memberRoles: Kind = {
  // Adding and removing roles of one member: PATCH /guilds/{guild}/members/{user} with the whole list.
  key: (step) => `member-roles:${step.pathParams.user}`,
  min: 3,
  max: 50,
  request: async (steps, guildId, read) => {
    const user = String(steps[0]!.pathParams.user);
    const member = (await read(`/guilds/${guildId}/members/${user}`)) as { roles?: string[] } | null;
    if (!member) throw new Error("メンバーが見つかりません");
    const roles = new Set(member.roles ?? []);
    for (const s of steps) {
      if (s.op.startsWith("PUT ")) roles.add(String(s.pathParams.role));
      else roles.delete(String(s.pathParams.role));
    }
    return { method: "PATCH", path: `/guilds/${guildId}/members/${user}`, body: { roles: [...roles] } };
  },
};

const channelOverwrites: Kind = {
  // Setting and removing permission overwrites of one channel: PATCH /channels/{channel} with the whole list.
  key: (step) => `overwrites:${step.pathParams.channel}`,
  min: 3,
  max: 50,
  request: async (steps, _guildId, read) => {
    const channel = String(steps[0]!.pathParams.channel);
    const current = (await read(`/channels/${channel}`)) as { permission_overwrites?: Array<{ id: string; type: number; allow: string; deny: string }> } | null;
    if (!current) throw new Error("チャンネルが見つかりません");
    const list = new Map((current.permission_overwrites ?? []).map((o) => [o.id, { id: o.id, type: o.type, allow: o.allow, deny: o.deny }]));
    for (const s of steps) {
      const id = String(s.pathParams.overwrite);
      if (s.op.startsWith("DELETE ")) list.delete(id);
      else {
        const b = s.body as { type: number; allow?: string; deny?: string };
        list.set(id, { id, type: b.type, allow: b.allow ?? "0", deny: b.deny ?? "0" });
      }
    }
    return { method: "PATCH", path: `/channels/${channel}`, body: { permission_overwrites: [...list.values()] } };
  },
};

const KINDS: Record<string, Kind> = {
  "PATCH /channels/{channel}": {
    ...channelPositions,
    key: (step, now) => channelPositions.key(step, now) ?? samePatch("channel").key(step, now),
    item: (step) => (onlyFields(step.body, POSITION_FIELDS) ? String(step.pathParams.channel) : ""),
    request: (steps, guildId, read) => (onlyFields(steps[0]!.body, POSITION_FIELDS) ? channelPositions : samePatch("channel")).request(steps, guildId, read),
  },
  "PATCH /guilds/{guild}/roles/{role}": {
    // PATCH /guilds/{guild}/roles: positions of many roles.
    key: (step) => (onlyFields(step.body, new Set(["position"])) ? "role-positions" : `patch:${step.pathParams.role}`),
    item: (step) => (onlyFields(step.body, new Set(["position"])) ? String(step.pathParams.role) : ""),
    min: 2,
    max: 100,
    request: async (steps, guildId, read) =>
      onlyFields(steps[0]!.body, new Set(["position"]))
        ? { method: "PATCH", path: `/guilds/${guildId}/roles`, body: steps.map((s) => ({ id: String(s.pathParams.role), position: (s.body as { position: number }).position })) }
        : samePatch("role").request(steps, guildId, read),
  },
  "PATCH /guilds/{guild}/members/{user}": samePatch("user"),
  "PATCH /channels/{channel}/messages/{message}": samePatch("message"),
  "PUT /guilds/{guild}/members/{user}/roles/{role}": memberRoles,
  "DELETE /guilds/{guild}/members/{user}/roles/{role}": memberRoles,
  "PUT /channels/{channel}/permissions/{overwrite}": channelOverwrites,
  "DELETE /channels/{channel}/permissions/{overwrite}": channelOverwrites,
  "DELETE /channels/{channel}/messages/{message}": {
    // POST /channels/{channel}/messages/bulk-delete: 2 to 100 messages of one channel, none older than two weeks.
    key: (step, now) => {
      const age = now - snowflakeTime(step.pathParams.message);
      return age >= 0 && age < BULK_DELETE_MAX_AGE_MS ? `delete:${step.pathParams.channel}` : null;
    },
    item: (step) => String(step.pathParams.message),
    min: 2,
    max: 100,
    request: async (steps) => ({
      method: "POST",
      path: `/channels/${steps[0]!.pathParams.channel}/messages/bulk-delete`,
      body: { messages: steps.map((s) => String(s.pathParams.message)) },
    }),
  },
  "PUT /guilds/{guild}/bans/{user}": {
    // POST /guilds/{guild}/bulk-ban: up to 200 users with the same message deletion.
    key: (step) => `ban:${(step.body as { delete_message_seconds?: number } | undefined)?.delete_message_seconds ?? 0}`,
    item: (step) => String(step.pathParams.user),
    min: 2,
    max: 200,
    request: async (steps, guildId) => ({
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

function pathOf(step: Step): `/${string}` {
  const template = step.op.slice(step.op.indexOf(" ") + 1);
  return template.replace(/\{(\w+)\}/g, (_, name: string) => encodeURIComponent(String(step.pathParams[name]))) as `/${string}`;
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
  return kind.key(step, now);
}

/**
 * The longest run of steps from the first that can share a request, given each
 * step's batch key; shorter than the kind's minimum means the first goes alone.
 */
export function batchRun(steps: Step[], keys: Array<string | null>): number {
  const kind = KINDS[steps[0]!.op];
  if (!kind || keys[0] === null) return 1;
  const items = new Set<string>();
  let n = 0;
  while (n < steps.length && n < kind.max && keys[n] === keys[0]) {
    const item = kind.item?.(steps[n]!) ?? "";
    if (item && items.has(item)) break;
    if (item) items.add(item);
    n++;
  }
  return n >= kind.min ? n : 1;
}

/** The one request that carries all of `steps` (one batch key, at least the kind's minimum). */
export function batchRequest(steps: Step[], guildId: string, read: Read): Promise<BatchRequest> {
  return KINDS[steps[0]!.op]!.request(steps, guildId, read);
}

/** Per step, why the batch did not do it, or null: bulk ban reports users it could not ban. */
export function batchOutcome(steps: Step[], response: unknown): Array<string | null> {
  if (steps[0]!.op !== "PUT /guilds/{guild}/bans/{user}") return steps.map(() => null);
  const failed = new Set((response as { failed_users?: string[] } | null)?.failed_users ?? []);
  return steps.map((s) => (failed.has(String(s.pathParams.user)) ? "BANできませんでした" : null));
}
