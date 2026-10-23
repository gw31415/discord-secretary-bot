import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { PermissionFlagsBits as P } from "discord-api-types/v10";
import { Store } from "../src/db.ts";
import { GuildCache } from "../src/discord/cache.ts";
import { normalizeSteps } from "../src/plan/validate.ts";
import { AdminDenied, RuleAdmin } from "../src/rules/admin.ts";
import { allowProblems, allowShapeProblems, missingPermissions } from "../src/rules/allow.ts";
import { RuleEngine } from "../src/rules/engine.ts";
import { parseRuleCustomId } from "../src/rules/panel.ts";
import { DEFAULT_LIMITS } from "../src/rules/types.ts";
import type { RuleDefinition } from "../src/rules/types.ts";
import { GUILD, makeGuild, MOD_ROLE, SELF } from "./helpers.ts";

const POST_GENERAL = {
  op: "POST /channels/{channel}/messages",
  path: { channel: { enum: ["10"] } },
  body: { type: "object", properties: { content: { type: "string" } }, additionalProperties: false },
  maxStepsPerRun: 2,
};

test("steps must fit an allow entry, within its count", () => {
  const steps = (drafts: any[]) => normalizeSteps(drafts, GUILD, "p");
  assert.deepEqual(allowProblems(steps([{ op: "POST /channels/{channel}/messages", path: { channel: "10" }, body: { content: "hi" } }]), [POST_GENERAL]), []);
  assert.match(allowProblems(steps([{ op: "POST /channels/{channel}/messages", path: { channel: "12" }, body: { content: "hi" } }]), [POST_GENERAL]).join(), /範囲外/);
  assert.match(allowProblems(steps([{ op: "DELETE /channels/{channel}", path: { channel: "10" } }]), [POST_GENERAL]).join(), /範囲外/);
  const three = steps([1, 2, 3].map((i) => ({ op: "POST /channels/{channel}/messages", path: { channel: "10" }, body: { content: String(i) } })));
  assert.match(allowProblems(three, [POST_GENERAL]).join(), /1回に2件まで/);
  // A value from an earlier step passes until it is known.
  const withRef = steps([
    { op: "POST /guilds/{guild}/channels", body: { name: "x" } },
    { op: "POST /channels/{channel}/messages", path: { channel: { $ref: "steps.s1.result.id" } }, body: { content: "hi" } },
  ]);
  assert.deepEqual(allowProblems(withRef, [{ op: "POST /guilds/{guild}/channels" }, POST_GENERAL]), []);
});

test("an allow list is checked for shape and for the permissions it needs", () => {
  assert.match(allowShapeProblems([]).join(), /1つもありません/);
  assert.match(allowShapeProblems([{ op: "POST /guilds/{guild}/webhooks" }]).join(), /対応していない操作/);
  assert.match(allowShapeProblems([{ op: "DELETE /channels/{channel}", body: {} }]).join(), /本文を取りません/);
  assert.match(allowShapeProblems([{ op: "DELETE /channels/{channel}", path: { user: {} } }]).join(), /不明なパスパラメータ/);
  assert.deepEqual(allowShapeProblems([POST_GENERAL]), []);
  // Conditions on the target need an operation that has one.
  assert.match(allowShapeProblems([{ op: "POST /guilds/{guild}/channels", target: {} }]).join(), /対象の条件を付けられません/);
  assert.deepEqual(allowShapeProblems([{ op: "DELETE /channels/{channel}", target: { properties: { name: { pattern: "^📞" } } } }]), []);

  const guild = makeGuild();
  // Everyone may post in #general; the staff channel is hidden from regular members.
  assert.deepEqual(missingPermissions(guild, guild.members.get("3")!, [POST_GENERAL]), []);
  assert.deepEqual(missingPermissions(guild, guild.members.get("3")!, [{ ...POST_GENERAL, path: { channel: { enum: ["11"] } } }]), ["ViewChannel"]);
  // Unpinned, it is judged server-wide; nickname changes need Manage Nicknames.
  assert.deepEqual(missingPermissions(guild, guild.members.get("3")!, [{ op: "PATCH /guilds/{guild}/members/{user}", body: { type: "object", properties: { nick: {} } } }]), ["ManageNicknames"]);
});

function world(now = { t: 1_000_000 }) {
  const store = new Store(":memory:", randomBytes(32));
  const cache = new GuildCache(GUILD);
  cache.guild = makeGuild();
  const caches = { get: (id: string | undefined) => (id === GUILD ? cache : undefined) };
  const admin = new RuleAdmin({ store, caches, selfId: () => SELF, now: () => now.t });
  const runs: any[] = [];
  const notices: string[] = [];
  const seen: any[] = [];
  let result: () => Promise<any> = async () => ({ plan: { id: "p1" }, status: "succeeded", reason: null });
  let code: () => any = () => ({ ok: true, value: { steps: [{ op: "POST /channels/{channel}/messages", path: { channel: "10" }, body: { content: "hi" } }] }, logs: [] });
  const engine = new RuleEngine({
    store,
    caches,
    planner: { runForRule: async (input) => (runs.push(input), result()) },
    selfId: () => SELF,
    now: () => now.t,
    makeReader: () => ({ get: async () => null }) as never,
    notifyOwner: async (_u, content) => void notices.push(content),
    log: () => {},
    run: async (_code, bindings) => (seen.push(bindings), code()),
  });
  const definition: RuleDefinition = {
    name: "挨拶",
    sourcePrompt: "投稿に返事して",
    trigger: { event: "MESSAGE_CREATE" },
    allow: [POST_GENERAL],
    program: { kind: "js", code: "return plan([])" },
    summary: null,
    limits: DEFAULT_LIMITS,
  };
  return {
    store, cache, admin, engine, runs, notices, now, definition, seen,
    setResult: (f: () => Promise<any>) => (result = f),
    setCode: (f: () => any) => (code = f),
  };
}

const message = (channel: string, author: string, id = "700") => ({ id, channel_id: channel, guild_id: GUILD, content: "hello", author: { id: author } });

test("a matching event runs the rule as its owner; the bot's own events and hidden channels do not", async () => {
  const w = world();
  const rule = w.admin.save(GUILD, "1", w.definition);
  w.engine.dispatch("MESSAGE_CREATE", GUILD, message("10", "3"));
  await w.engine.idle();
  assert.equal(w.runs.length, 1);
  assert.equal(w.runs[0].ownerId, "1");
  assert.equal(w.runs[0].rule.id, rule.id);
  assert.equal(w.store.recentRuleRuns(rule.id, 1)[0]!.outcome, "executed");

  // The bot's own message is ignored.
  w.engine.dispatch("MESSAGE_CREATE", GUILD, message("10", SELF, "701"));
  // Other events do not match the trigger.
  w.engine.dispatch("GUILD_MEMBER_ADD", GUILD, { guild_id: GUILD, user: { id: "5" } });
  await w.engine.idle();
  assert.equal(w.runs.length, 1);

  // A regular member's rule does not see the staff channel.
  const memberRule = w.admin.save(GUILD, "3", w.definition);
  w.engine.dispatch("MESSAGE_CREATE", GUILD, message("11", "2", "702"));
  await w.engine.idle();
  assert.deepEqual(w.runs.map((r) => r.ownerId), ["1", "1"]);
  assert.equal(w.store.recentRuleRuns(memberRule.id, 5).length, 0);
});

test("a change the bot just made does not set off rules unless they opt in", async () => {
  const w = world();
  w.admin.save(GUILD, "1", { ...w.definition, trigger: { event: "GUILD_MEMBER_UPDATE" }, allow: [{ op: "PUT /guilds/{guild}/members/{user}/roles/{role}" }] });
  const plan = { guildId: GUILD } as any;
  w.engine.noteWrite(plan, { id: "s1", kind: "call", op: "PUT /guilds/{guild}/members/{user}/roles/{role}", pathParams: { guild: GUILD, user: "3", role: MOD_ROLE }, idempotencyKey: "x" }, undefined);
  w.engine.dispatch("GUILD_MEMBER_UPDATE", GUILD, { guild_id: GUILD, user: { id: "3" }, roles: [MOD_ROLE] });
  await w.engine.idle();
  assert.equal(w.runs.length, 0);
  // Later, the same kind of change by someone else fires.
  w.now.t += 60_000;
  w.engine.dispatch("GUILD_MEMBER_UPDATE", GUILD, { guild_id: GUILD, user: { id: "3" }, roles: [] });
  await w.engine.idle();
  assert.equal(w.runs.length, 1);
});

test("only the voice move the bot made is skipped; the member's own moves right after still fire", async () => {
  const w = world();
  w.admin.save(GUILD, "1", { ...w.definition, trigger: { event: "VOICE_STATE_UPDATE" }, allow: [{ op: "PATCH /guilds/{guild}/members/{user}" }] });
  const plan = { guildId: GUILD } as any;
  const voice = (channel: string | null, before: string | null) => ({ guild_id: GUILD, user_id: "3", channel_id: channel, before_channel_id: before });
  w.engine.noteWrite(plan, { id: "s1", kind: "call", op: "PATCH /guilds/{guild}/members/{user}", pathParams: { guild: GUILD, user: "3" }, body: { channel_id: "10" }, idempotencyKey: "x" }, undefined);
  // The move the bot made.
  w.engine.dispatch("VOICE_STATE_UPDATE", GUILD, voice("10", "11"));
  await w.engine.idle();
  assert.equal(w.runs.length, 0);
  // Leaving a few seconds later is the member's own doing.
  w.now.t += 3_000;
  w.engine.dispatch("VOICE_STATE_UPDATE", GUILD, voice(null, "10"));
  await w.engine.idle();
  assert.equal(w.runs.length, 1);
  // A server mute by the bot keeps them in place and is skipped; muting themselves is not.
  w.engine.noteWrite(plan, { id: "s2", kind: "call", op: "PATCH /guilds/{guild}/members/{user}", pathParams: { guild: GUILD, user: "3" }, body: { mute: true }, idempotencyKey: "y" }, undefined);
  w.engine.dispatch("VOICE_STATE_UPDATE", GUILD, voice("10", "10"));
  w.engine.dispatch("VOICE_STATE_UPDATE", GUILD, voice("10", "10"));
  await w.engine.idle();
  assert.equal(w.runs.length, 2);
});

test("runs are rate limited, and failures in a row switch the rule off and tell its owner", async () => {
  const w = world();
  const rule = w.admin.save(GUILD, "1", { ...w.definition, limits: { perMinute: 2, maxConsecutiveFailures: 3 } });
  for (let i = 0; i < 4; i++) w.engine.dispatch("MESSAGE_CREATE", GUILD, message("10", "3", String(800 + i)));
  await w.engine.idle();
  assert.equal(w.runs.length, 2);
  assert.equal(w.store.recentRuleRuns(rule.id, 10).filter((r) => r.outcome === "rate_limited").length, 1);

  w.now.t += 61_000;
  w.setCode(() => ({ ok: false, error: "TypeError: boom", logs: [] }));
  w.engine.dispatch("MESSAGE_CREATE", GUILD, message("10", "3", "900"));
  w.engine.dispatch("MESSAGE_CREATE", GUILD, message("10", "3", "901"));
  await w.engine.idle();
  w.now.t += 61_000;
  w.engine.dispatch("MESSAGE_CREATE", GUILD, message("10", "3", "902"));
  await w.engine.idle();
  const stopped = w.store.getRule(rule.id)!;
  assert.equal(stopped.enabled, false);
  assert.match(stopped.disabledReason!, /3回続けて失敗/);
  assert.match(w.notices[0]!, /boom/);
});

test("the emergency stop halts every rule, and a departing owner's rules switch off", async () => {
  const w = world();
  const rule = w.admin.save(GUILD, "1", w.definition);
  assert.throws(() => w.admin.halt(GUILD, "3"), AdminDenied);
  w.admin.halt(GUILD, "1");
  w.engine.dispatch("MESSAGE_CREATE", GUILD, message("10", "3"));
  await w.engine.idle();
  assert.equal(w.runs.length, 0);
  w.admin.resume(GUILD, "1");
  w.engine.dispatch("MESSAGE_CREATE", GUILD, message("10", "3", "701"));
  await w.engine.idle();
  assert.equal(w.runs.length, 1);

  w.engine.ownerLeft(GUILD, "1");
  assert.equal(w.store.getRule(rule.id)!.enabled, false);
  assert.match(w.store.getRule(rule.id)!.disabledReason!, /作成者がサーバーを抜けた/);
});

test("who may see, switch off and delete rules follows Discord permissions", () => {
  const w = world();
  const guild = w.cache.guild!;
  const own = w.admin.save(GUILD, "3", w.definition);
  const ownerRule = w.admin.save(GUILD, "1", w.definition);

  // A regular member sees only their own; the moderator (View Audit Log) sees all.
  assert.deepEqual(w.admin.list(GUILD, "3").map((r) => r.id), [own.id]);
  assert.equal(w.admin.list(GUILD, "2").length, 2);
  assert.throws(() => w.admin.get(GUILD, "3", ownerRule.id), AdminDenied);

  // Switching off someone else's rule needs Manage Server and the rule's permissions.
  assert.throws(() => w.admin.setEnabled(GUILD, "2", own.id, false), AdminDenied);
  guild.roles.set(MOD_ROLE, { id: MOD_ROLE, permissions: P.ViewAuditLog | P.ManageGuild | P.ViewChannel | P.SendMessages, position: 1 });
  assert.equal(w.admin.setEnabled(GUILD, "2", own.id, false).enabled, false);
  assert.match(w.store.getRule(own.id)!.disabledReason!, /<@2> が止めました/);
  // Only the owner turns it back on or deletes it.
  assert.throws(() => w.admin.setEnabled(GUILD, "2", own.id, true), AdminDenied);
  assert.throws(() => w.admin.remove(GUILD, "2", own.id), AdminDenied);
  assert.equal(w.admin.setEnabled(GUILD, "3", own.id, true).enabled, true);
  w.admin.remove(GUILD, "3", own.id);
  assert.equal(w.store.getRule(own.id), undefined);

  // Owning a rule needs its permissions: a regular member cannot own one that kicks.
  assert.throws(() => w.admin.save(GUILD, "3", { ...w.definition, allow: [{ op: "DELETE /guilds/{guild}/members/{user}" }] }), /KickMembers/);
  // A new version replaces the definition and is counted.
  const v2 = w.admin.save(GUILD, "1", { ...w.definition, name: "挨拶2" }, ownerRule.id);
  assert.equal(v2.version, 2);
  assert.equal(v2.name, "挨拶2");
  assert.ok(w.store.auditEntries({ guildId: GUILD, limit: 20 }).some((e) => e.action === "rule.approve" && e.detail.version === 2));
});

test("rule custom ids round-trip and refuse unknown actions", () => {
  assert.deepEqual(parseRuleCustomId("rule:open:"), { action: "open", arg: "" });
  assert.deepEqual(parseRuleCustomId("rule:disable:abc123"), { action: "disable", arg: "abc123" });
  assert.equal(parseRuleCustomId("rule:save:abc"), null);
  assert.equal(parseRuleCustomId("plan:run:abc:12345678"), null);
});

test("a madeInRun field takes only a value from an earlier step of the same run", () => {
  const allow = [
    { op: "POST /guilds/{guild}/channels", body: { properties: { name: { pattern: "^📞" }, type: { const: 2 } }, additionalProperties: false }, maxStepsPerRun: 1 },
    { op: "PATCH /guilds/{guild}/members/{user}", body: { properties: { channel_id: { madeInRun: true } }, required: ["channel_id"], additionalProperties: false }, maxStepsPerRun: 1 },
  ];
  assert.deepEqual(allowShapeProblems(allow), []);
  const room = { op: "POST /guilds/{guild}/channels", id: "room", body: { name: "📞1", type: 2 } };
  const move = (channel: unknown) => normalizeSteps([room, { op: "PATCH /guilds/{guild}/members/{user}", path: { user: "3" }, body: { channel_id: channel } }], GUILD, "p");
  // Moving into the room this run makes fits, at proposal and once the id is known.
  const steps = move({ $ref: "steps.room.result.id" });
  assert.deepEqual(allowProblems(steps, allow), []);
  const resolved = { ...steps[1]!, body: { channel_id: "777" } };
  assert.deepEqual(allowProblems([resolved], allow, undefined, [steps[1]!]), []);
  // A fixed channel does not, nor does a resolved value without its ref.
  assert.equal(allowProblems(move("555"), allow).length, 1);
  assert.equal(allowProblems([resolved], allow).length, 1);
  // Nor does leaving the required field out, or adding another field.
  assert.equal(allowProblems(normalizeSteps([{ op: "PATCH /guilds/{guild}/members/{user}", path: { user: "3" }, body: { nick: "x" } }], GUILD, "p"), allow).length, 1);
});

test("one rule can fire on several triggers, and its code sees which one", async () => {
  const w = world();
  const rule = w.admin.save(GUILD, "1", { ...w.definition, trigger: { event: "MESSAGE_CREATE", events: ["MESSAGE_UPDATE"] } });
  w.engine.dispatch("MESSAGE_CREATE", GUILD, message("10", "3", "901"));
  w.engine.dispatch("MESSAGE_UPDATE", GUILD, message("10", "3", "901"));
  w.engine.dispatch("MESSAGE_DELETE", GUILD, { id: "901", channel_id: "10", guild_id: GUILD });
  await w.engine.idle();
  assert.equal(w.runs.length, 2);
  assert.deepEqual(w.seen.map((b) => b.eventName), ["MESSAGE_CREATE", "MESSAGE_UPDATE"]);
  assert.equal(w.store.recentRuleRuns(rule.id, 5).length, 2);
  // Unknown or too many triggers are refused.
  assert.throws(() => w.admin.save(GUILD, "1", { ...w.definition, trigger: { event: "MESSAGE_CREATE", events: ["NOPE"] } }), /NOPE/);
  assert.throws(() => w.admin.save(GUILD, "1", { ...w.definition, trigger: { event: "MESSAGE_CREATE", events: ["MESSAGE_UPDATE", "MESSAGE_DELETE", "CHANNEL_CREATE", "CHANNEL_UPDATE", "CHANNEL_DELETE"] } }), /5種類まで/);
});

test("cron schedules are read in their time zone", async () => {
  const { cronMatches, parseCron, scheduleProblems } = await import("../src/rules/schedule.ts");
  // 2026-10-22T19:00Z is 04:00 on Friday the 23rd in Tokyo.
  const at = Date.parse("2026-10-22T19:00:30Z");
  assert.ok(cronMatches(parseCron("0 4 * * *"), at, "Asia/Tokyo"));
  assert.ok(!cronMatches(parseCron("0 4 * * *"), at, "UTC"));
  assert.ok(cronMatches(parseCron("*/10 * * * 5"), at, "Asia/Tokyo"));
  assert.ok(cronMatches(parseCron("0 4 * * 7,1-4"), at, "Asia/Tokyo") === false);
  // Day and weekday both given: either matches.
  assert.ok(cronMatches(parseCron("0 4 1 * 5"), at, "Asia/Tokyo"));
  assert.ok(cronMatches(parseCron("@daily"), Date.parse("2026-10-22T15:00:00Z"), "Asia/Tokyo"));
  assert.match(scheduleProblems("61 * * * *", undefined).join(), /範囲/);
  assert.match(scheduleProblems("* * *", undefined).join(), /5つの欄/);
  assert.match(scheduleProblems("0 4 * * *", "Mars/Base").join(), /timezone/);
  assert.match(scheduleProblems(undefined, undefined).join(), /schedule/);
});

test("trigger settings are checked together", async () => {
  const { triggerProblems } = await import("../src/rules/triggers.ts");
  assert.deepEqual(triggerProblems({ event: "CHANNEL_CREATE", events: ["SCHEDULE"], schedule: "0 4 * * *", debounceSeconds: 5, includeBotOrigin: "other_rules" }), []);
  assert.match(triggerProblems({ event: "CHANNEL_CREATE", schedule: "0 4 * * *" }).join(), /SCHEDULE と一緒/);
  assert.match(triggerProblems({ event: "SCHEDULE" }).join(), /schedule/);
  assert.match(triggerProblems({ event: "CHANNEL_CREATE", debounceSeconds: 0 }).join(), /debounce_seconds/);
});

test("SCHEDULE rules fire once in their minute, with the scheduled time as the event", async () => {
  const w = world({ t: Date.parse("2026-10-22T19:00:05Z") });
  const rule = w.admin.save(GUILD, "1", { ...w.definition, trigger: { event: "SCHEDULE", schedule: "0 4 * * *" } });
  w.admin.save(GUILD, "1", { ...w.definition, name: "別の時刻", trigger: { event: "SCHEDULE", schedule: "30 4 * * *" } });
  w.engine.tick([GUILD]);
  w.engine.tick([GUILD], w.now.t + 20_000); // the same minute again
  await w.engine.idle();
  assert.equal(w.runs.length, 1);
  assert.equal(w.runs[0].rule.id, rule.id);
  assert.equal(w.seen[0].eventName, "SCHEDULE");
  assert.equal(w.seen[0].event.scheduled_at, "2026-10-22T19:00:00.000Z");
  assert.equal(w.seen[0].batch.length, 1);
  // The dry run makes the same kind of event without a sample.
  const { syntheticEvent } = await import("../src/rules/triggers.ts");
  assert.equal(syntheticEvent("SCHEDULE", GUILD, rule.trigger, w.now.t)!.timezone, "Asia/Tokyo");
});

test("a debounced rule runs once on the whole batch, at the latest after five periods", async () => {
  const timers: Array<{ fn: () => void; at: number; cleared: boolean }> = [];
  const w = world();
  (w.engine.deps as any).setTimer = (fn: () => void, ms: number) => {
    const t = { fn, at: w.now.t + ms, cleared: false };
    timers.push(t);
    return t;
  };
  (w.engine.deps as any).clearTimer = (t: any) => t && (t.cleared = true);
  const advance = (ms: number) => {
    w.now.t += ms;
    for (const t of timers) if (!t.cleared && t.at <= w.now.t) (t.cleared = true), t.fn();
  };
  w.admin.save(GUILD, "1", { ...w.definition, trigger: { event: "CHANNEL_UPDATE", debounceSeconds: 2 } });
  const update = (id: string) => w.engine.dispatch("CHANNEL_UPDATE", GUILD, { id, guild_id: GUILD, name: "x", type: 0, permission_overwrites: [] });
  update("10");
  advance(1000);
  update("13");
  advance(1500);
  await w.engine.idle();
  assert.equal(w.runs.length, 0);
  advance(600);
  await w.engine.idle();
  assert.equal(w.runs.length, 1);
  assert.deepEqual(w.seen[0].batch.map((b: any) => b.event.id), ["10", "13"]);
  assert.equal(w.seen[0].event.id, "13");
  // A steady stream still runs within five periods of its first event.
  for (let i = 0; i < 12; i++) {
    update("10");
    advance(1000);
  }
  await w.engine.idle();
  assert.equal(w.runs.length, 2);
});

test("other_rules fires on other writers' changes but not on the rule's own", async () => {
  const w = world();
  const sitemap = w.admin.save(GUILD, "1", { ...w.definition, trigger: { event: "CHANNEL_UPDATE", includeBotOrigin: "other_rules" } });
  const update = { id: "10", guild_id: GUILD, name: "x", type: 0, permission_overwrites: [] };
  const write = (rule: string | undefined) =>
    w.engine.noteWrite({ guildId: GUILD, ...(rule ? { rule: { id: rule } } : {}) } as any, { op: "PATCH /channels/{channel}", pathParams: { channel: "10" } } as any, {});
  write(sitemap.id);
  w.engine.dispatch("CHANNEL_UPDATE", GUILD, update);
  await w.engine.idle();
  assert.equal(w.runs.length, 0);
  write("sorter");
  w.engine.dispatch("CHANNEL_UPDATE", GUILD, update);
  write(undefined); // from a conversation's plan
  w.engine.dispatch("CHANNEL_UPDATE", GUILD, update);
  await w.engine.idle();
  assert.equal(w.runs.length, 2);
  // The bot's own posts cannot be told apart, so they never fire it.
  w.admin.save(GUILD, "1", { ...w.definition, trigger: { event: "MESSAGE_CREATE", includeBotOrigin: "other_rules" } });
  w.engine.dispatch("MESSAGE_CREATE", GUILD, message("10", SELF, "703"));
  await w.engine.idle();
  assert.equal(w.runs.length, 2);
});

test("an allow entry can put conditions on the channel a step acts in", () => {
  const entry = { op: "POST /channels/{channel}/messages", channel: { properties: { parent_id: { const: "500" } }, required: ["parent_id"] } };
  assert.deepEqual(allowShapeProblems([entry]), []);
  assert.match(allowShapeProblems([{ op: "POST /guilds/{guild}/channels", channel: {} }]).join(), /チャンネルの条件/);
  const steps = normalizeSteps([{ op: "POST /channels/{channel}/messages", path: { channel: "10" }, body: { content: "x" } }], GUILD, "p");
  assert.deepEqual(allowProblems(steps, [entry], undefined, undefined, new Map([["s1", { id: "10", parent_id: "500" }]])), []);
  assert.match(allowProblems(steps, [entry], undefined, undefined, new Map([["s1", { id: "10", parent_id: "501" }]])).join(), /範囲外/);
  assert.match(allowProblems(steps, [entry], undefined, undefined, new Map([["s1", null]])).join(), /範囲外/);
});

test("reaction operations take an emoji, not an id, in their path", () => {
  const op = "PUT /channels/{channel}/messages/{message}/reactions/{emoji}/@me";
  assert.equal(normalizeSteps([{ op, path: { channel: "10", message: "1", emoji: "👍" } }], GUILD, "p").length, 1);
  assert.equal(normalizeSteps([{ op, path: { channel: "10", message: "1", emoji: "ok_hand:123" } }], GUILD, "p").length, 1);
  for (const emoji of ["..", "a/b", "", "%F0"]) assert.throws(() => normalizeSteps([{ op, path: { channel: "10", message: "1", emoji } }], GUILD, "p"), /emoji/);
});

test("a rule carries its state to the next run, but only from runs that went through", async () => {
  const w = world();
  const rule = w.admin.save(GUILD, "1", w.definition);
  let next: any = { ok: true, value: null, state: { value: { count: 1 } }, logs: [] };
  w.setCode(() => next);
  w.engine.dispatch("MESSAGE_CREATE", GUILD, message("10", "3", "710"));
  await w.engine.idle();
  assert.equal(w.seen[0].state, null);
  assert.deepEqual(w.store.getRuleState(rule.id), { count: 1 });
  // A rejected run keeps the state it started from.
  next = { ok: true, value: { steps: [{ op: "DELETE /channels/{channel}", path: { channel: "10" } }] }, state: { value: { count: 2 } }, logs: [] };
  w.setResult(async () => {
    const { PlanRejected } = await import("../src/plan/validate.ts");
    throw new PlanRejected(["範囲外"]);
  });
  w.engine.dispatch("MESSAGE_CREATE", GUILD, message("10", "3", "711"));
  await w.engine.idle();
  assert.deepEqual(w.seen[1].state, { count: 1 });
  assert.deepEqual(w.store.getRuleState(rule.id), { count: 1 });
  // Too large is an error, and nothing is kept.
  next = { ok: true, value: null, state: { value: "x".repeat(20_000) }, logs: [] };
  w.engine.dispatch("MESSAGE_CREATE", GUILD, message("10", "3", "712"));
  await w.engine.idle();
  assert.match(w.store.recentRuleRuns(rule.id, 1)[0]!.error ?? "", /setState/);
  assert.deepEqual(w.store.getRuleState(rule.id), { count: 1 });
  w.store.setRuleState(rule.id, null);
  assert.equal(w.store.getRuleState(rule.id), null);
});

test("a rule's runs go one at a time, while another rule runs alongside", async () => {
  const w = world();
  const slow = w.admin.save(GUILD, "1", { ...w.definition, name: "遅い" });
  const fast = w.admin.save(GUILD, "1", { ...w.definition, name: "速い" });
  const order: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let slowRunning = 0;
  let overlapped = false;
  w.setResult(async () => {
    const name = w.runs.at(-1).rule.id === slow.id ? "slow" : "fast";
    order.push(`${name} start`);
    if (name === "slow") {
      if (++slowRunning > 1) overlapped = true;
      await gate;
      slowRunning--;
    }
    order.push(`${name} end`);
    return { plan: { id: "p" }, status: "succeeded", reason: null };
  });
  w.engine.dispatch("MESSAGE_CREATE", GUILD, message("10", "3", "701"));
  w.engine.dispatch("MESSAGE_CREATE", GUILD, message("10", "3", "702"));
  await new Promise((r) => setTimeout(r, 50));
  // The other rule finished both of its runs while the first one waits.
  assert.equal(order.filter((o) => o === "fast end").length, 2);
  // The waiting rule has started its first run only; its second waits for it.
  assert.equal(order.filter((o) => o === "slow start").length, 1);
  release();
  await w.engine.idle();
  assert.equal(order.filter((o) => o === "slow end").length, 2);
  assert.equal(overlapped, false);
  assert.equal(w.store.recentRuleRuns(slow.id, 5).length, 2);
  assert.equal(w.store.recentRuleRuns(fast.id, 5).length, 2);
});
