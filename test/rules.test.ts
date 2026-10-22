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
    run: async () => code(),
  });
  const definition: RuleDefinition = {
    name: "挨拶",
    sourcePrompt: "投稿に返事して",
    trigger: { event: "MESSAGE_CREATE" },
    allow: [POST_GENERAL],
    code: "return plan([])",
    summary: null,
    limits: DEFAULT_LIMITS,
  };
  return {
    store, cache, admin, engine, runs, notices, now, definition,
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
  assert.deepEqual(parseRuleCustomId("rule:save:abc123"), { action: "save", arg: "abc123" });
  assert.equal(parseRuleCustomId("rule:drop:abc"), null);
  assert.equal(parseRuleCustomId("plan:run:abc:12345678"), null);
});

test("a rule proposed in conversation is dry-run, posted for confirmation, and only its requester registers it", async () => {
  const w = world();
  const posted: any[] = [];
  const api = {
    channels: {
      createMessage: async (channelId: string, body: any) => (posted.push({ kind: "create", channelId, body }), { id: "m1" }),
      editMessage: async (_c: string, _m: string, body: any) => void posted.push({ kind: "edit", body }),
    },
    interactions: {
      reply: async (_i: string, _t: string, body: any) => void posted.push({ kind: "reply", body }),
      updateMessage: async (_i: string, _t: string, body: any) => void posted.push({ kind: "update", body }),
    },
  } as any;
  const { RuleService } = await import("../src/rules/service.ts");
  const service = new RuleService({ api, store: w.store, caches: { get: (id) => (id === GUILD ? w.cache : undefined) }, admin: w.admin, engine: w.engine, selfId: () => SELF, now: () => w.now.t, log: () => {}, summarize: async () => "投稿に返事します。" });
  const reader = {
    shareable: () => new Set(["10"]),
    get: async (route: string) => (route.endsWith("/messages") ? [{ id: "600", channel_id: "10", content: "hi", author: { id: "3" } }] : null),
  } as any;
  const draft = { name: "挨拶", trigger: { event: "MESSAGE_CREATE" }, allow: [POST_GENERAL], code: "return plan([call(...)])" };
  const input = { guildId: GUILD, channelId: "10", replyToId: "400", ownerId: "1", request: "投稿に返事して", draft, reader };

  // A channel the conversation cannot show is refused before anything is posted.
  await assert.rejects(service.propose({ ...input, draft: { ...draft, allow: [{ ...POST_GENERAL, path: { channel: { enum: ["11"] } } }] } }), /この場所では扱えません/);
  // The dry run's steps must fit the allow list.
  w.setCode(() => ({ ok: true, value: { steps: [{ op: "POST /channels/{channel}/messages", path: { channel: "12" }, body: { content: "x" } }] }, logs: [] }));
  await assert.rejects(service.propose(input), /ドライラン: .*範囲外/);
  assert.equal(posted.length, 0);

  w.setCode(() => ({ ok: true, value: { steps: [{ op: "POST /channels/{channel}/messages", path: { channel: "10" }, body: { content: "ようこそ" } }] }, logs: [] }));
  const { draftId } = await service.propose(input);
  const dialog = posted[0];
  assert.equal(dialog.body.message_reference.message_id, "400");
  const text = JSON.stringify(dialog.body.components);
  assert.match(text, /ルール登録の確認/);
  assert.match(text, /#general のみ/);
  assert.match(text, /投稿に返事します/);
  assert.match(text, /このチャンネルの直近のメッセージ/);

  const click = (userId: string, action: string) => ({ id: "i", token: "t", application_id: "app", guild_id: GUILD, type: 3, member: { user: { id: userId } }, data: { custom_id: `rule:${action}:${draftId}`, component_type: 2 } }) as any;
  await service.handleInteraction(click("3", "save"));
  assert.match(posted.at(-1).body.content, /依頼した本人だけ/);
  assert.equal(w.store.listRules(GUILD).length, 0);
  await service.handleInteraction(click("1", "save"));
  assert.match(JSON.stringify(posted.at(-1).body.components), /登録しました/);
  const [rule] = w.store.listRules(GUILD);
  assert.equal(rule!.ownerId, "1");
  assert.equal(rule!.summary, "投稿に返事します。");
  assert.equal(rule!.sourcePrompt, "投稿に返事して");
});
