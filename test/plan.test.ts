import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import type { API } from "@discordjs/core";
import { DiscordAPIError } from "@discordjs/rest";
import { InteractionType, ComponentType, PermissionFlagsBits as P } from "discord-api-types/v10";
import type { APIInteraction } from "discord-api-types/v10";
import { Store } from "../src/db.ts";
import { GuildCache } from "../src/discord/cache.ts";
import { confirmPhrase, needsTypedConfirm, dialogButtons, dialogText, parsePlanCustomId, renderDialog } from "../src/plan/dialog.ts";
import { Planner } from "../src/plan/service.ts";
import { RuleAdmin } from "../src/rules/admin.ts";
import { RuleEngine } from "../src/rules/engine.ts";
import { RuleService } from "../src/rules/service.ts";
import type { Plan } from "../src/plan/types.ts";
import { normalizeSteps, permissionProblems, PlanRejected, planRisk, visibilityProblems } from "../src/plan/validate.ts";
import { BOT_ROLE, GUILD, makeGuild, MOD_ROLE, SELF } from "./helpers.ts";

function rejects(fn: () => unknown, pattern: RegExp): void {
  assert.throws(fn, (e: unknown) => e instanceof PlanRejected && e.reasons.some((r) => pattern.test(r)));
}

test("drafts are checked against the operation table and body schemas", () => {
  rejects(() => normalizeSteps([{ op: "POST /guilds/{guild}/webhooks", body: {} }], GUILD, "p"), /対応していない操作/);
  rejects(() => normalizeSteps([{ op: "POST /guilds/{guild}/channels", body: { name: "x", bitrate: 64000 } }], GUILD, "p"), /本文が仕様に合いません/);
  rejects(() => normalizeSteps([{ op: "DELETE /channels/{channel}", path: {} }], GUILD, "p"), /channel がありません/);
  rejects(() => normalizeSteps([{ op: "DELETE /channels/{channel}", path: { channel: { $ref: "steps.s9.result.id" } } }], GUILD, "p"), /前のステップ/);
  rejects(() => normalizeSteps([{ op: "POST /guilds/{guild}/roles", path: { guild: "555" }, body: {} }], GUILD, "p"), /別のサーバー/);
  rejects(() => normalizeSteps(Array.from({ length: 51 }, (_, i) => ({ op: "POST /users/{user}/dm", path: { user: String(i + 1) }, body: { content: "hi" } })), GUILD, "p"), /DMは1つの変更につき50件/);

  const steps = normalizeSteps(
    [
      { op: "POST /guilds/{guild}/channels", body: { name: "new" } },
      { op: "POST /channels/{channel}/messages", path: { channel: { $ref: "steps.s1.result.id" } }, body: { content: "hi" } },
    ],
    GUILD,
    "p",
  );
  assert.deepEqual(steps.map((s) => s.id), ["s1", "s2"]);
  assert.equal(steps[0]!.pathParams.guild, GUILD);
  assert.equal(steps[1]!.idempotencyKey, "p:s2");
  assert.equal(planRisk(steps), "write");
});

test("a field can raise the risk (role permissions are destructive)", () => {
  const steps = normalizeSteps([{ op: "PATCH /guilds/{guild}/roles/{role}", path: { role: MOD_ROLE }, body: { permissions: "0" } }], GUILD, "p");
  assert.equal(planRisk(steps), "destructive");
});

test("both the actor and the bot need the permission, and hierarchy applies", () => {
  const guild = makeGuild();
  const ctx = (actorId: string) => ({ guild, actorId, selfId: SELF });
  const [create] = normalizeSteps([{ op: "POST /guilds/{guild}/channels", body: { name: "x" } }], GUILD, "p");
  assert.match(permissionProblems(create!, ctx("3")).join(), /依頼者に権限 ManageChannels/);
  assert.deepEqual(permissionProblems(create!, ctx("1")), []);

  // The moderator can delete messages; the bot without Administrator cannot.
  const [del] = normalizeSteps([{ op: "DELETE /channels/{channel}/messages/{message}", path: { channel: "10", message: "500" } }], GUILD, "p");
  assert.deepEqual(permissionProblems(del!, ctx("2")), []);
  guild.roles.set(BOT_ROLE, { id: BOT_ROLE, permissions: P.ViewChannel, position: 2 });
  assert.match(permissionProblems(del!, ctx("2")).join(), /Botに権限 ManageMessages/);
  guild.roles.set(BOT_ROLE, { id: BOT_ROLE, permissions: P.Administrator, position: 2 });

  // Handing out a permission the actor lacks is refused even with Manage Roles.
  guild.roles.set(MOD_ROLE, { id: MOD_ROLE, permissions: P.ManageRoles | P.ManageMessages, position: 1 });
  const [role] = normalizeSteps([{ op: "POST /guilds/{guild}/roles", body: { name: "god", permissions: String(P.Administrator) } }], GUILD, "p");
  assert.match(permissionProblems(role!, ctx("2")).join(), /依頼者が持っていない権限.*Administrator/);

  // The bot's role sits above the moderator's, so the moderator cannot grant it.
  const [grant] = normalizeSteps([{ op: "PUT /guilds/{guild}/members/{user}/roles/{role}", path: { user: "3", role: BOT_ROLE } }], GUILD, "p");
  assert.match(permissionProblems(grant!, ctx("2")).join(), /依頼者の最上位ロールと同じか上/);
  // Nobody may act on the owner.
  const [kick] = normalizeSteps([{ op: "DELETE /guilds/{guild}/members/{user}" , path: { user: "1" } }], GUILD, "p");
  assert.match(permissionProblems(kick!, ctx("2")).join(), /オーナー/);
  // Moving someone between voice channels has no hierarchy (as in Discord); a nickname does.
  guild.roles.set(MOD_ROLE, { id: MOD_ROLE, permissions: P.MoveMembers | P.ManageNicknames, position: 1 });
  const [move] = normalizeSteps([{ op: "PATCH /guilds/{guild}/members/{user}", path: { user: "1" }, body: { channel_id: "10" } }], GUILD, "p");
  assert.deepEqual(permissionProblems(move!, ctx("2")), []);
  const [nick] = normalizeSteps([{ op: "PATCH /guilds/{guild}/members/{user}", path: { user: "1" }, body: { nick: "x" } }], GUILD, "p");
  assert.match(permissionProblems(nick!, ctx("2")).join(), /オーナー/);
});

test("the preview may only reveal channels this conversation can show", () => {
  const [step] = normalizeSteps([{ op: "PATCH /channels/{channel}", path: { channel: "11" }, body: { topic: "x" } }], GUILD, "p");
  assert.match(visibilityProblems(step!, new Set(["10"])).join(), /チャンネル 11 はこの場所では扱えません/);
  assert.deepEqual(visibilityProblems(step!, new Set(["10", "11"])), []);
});

// --- Planner with a fake Discord ---------------------------------------------

interface Call {
  method: string;
  path: string;
  options?: { body?: unknown; reason?: string };
}

function notFound(path: string): DiscordAPIError {
  return new DiscordAPIError({ message: "Unknown", code: 10003 }, 10003, 404, "GET", path, {});
}

function fakeDiscord() {
  const calls: Call[] = [];
  const replies: Array<{ kind: string; body: any }> = [];
  const channels: Record<string, any> = {
    "10": { id: "10", type: 0, name: "general", guild_id: GUILD, permission_overwrites: [] },
    "11": { id: "11", type: 0, name: "staff", guild_id: GUILD, permission_overwrites: [] },
  };
  const roles = [
    { id: GUILD, name: "@everyone", permissions: String(P.ViewChannel | P.ReadMessageHistory | P.SendMessages), position: 0 },
    { id: MOD_ROLE, name: "Mod", permissions: String(P.ViewAuditLog | P.ManageMessages), position: 1 },
    { id: BOT_ROLE, name: "Bot", permissions: String(P.Administrator), position: 2 },
  ];
  const members: Record<string, any> = {
    "1": { roles: [], nick: null, user: { id: "1", username: "owner" } },
    "2": { roles: [MOD_ROLE], nick: "モデ", user: { id: "2", username: "mod" } },
    "3": { roles: [], nick: null, user: { id: "3", username: "alice" } },
    [SELF]: { roles: [BOT_ROLE], nick: null, user: { id: SELF, username: "bot", bot: true } },
  };
  const messages: Record<string, any> = { "500": { id: "500", content: "spam spam", author: { username: "alice" } } };
  const failures = new Set<string>();
  let next = 50;

  const get = async (path: string) => {
    let m: RegExpExecArray | null;
    if (path === `/guilds/${GUILD}`) return { id: GUILD, owner_id: "1", roles };
    if (path === `/guilds/${GUILD}/channels`) return Object.values(channels);
    if (path === `/guilds/${GUILD}/roles`) return roles;
    if ((m = /^\/guilds\/\d+\/roles\/(\d+)$/.exec(path))) return roles.find((r) => r.id === m![1]) ?? Promise.reject(notFound(path));
    if ((m = /^\/guilds\/\d+\/members\/(\d+)$/.exec(path))) return members[m[1]!] ?? Promise.reject(notFound(path));
    if ((m = /^\/channels\/(\d+)\/messages\/(\d+)$/.exec(path))) return messages[m[2]!] ?? Promise.reject(notFound(path));
    if ((m = /^\/channels\/(\d+)$/.exec(path))) return channels[m[1]!] ?? Promise.reject(notFound(path));
    throw notFound(path);
  };
  const write = (method: string) => async (path: string, options?: Call["options"]) => {
    calls.push({ method, path, options });
    if (failures.has(path)) throw new Error("Missing Permissions");
    if (method === "POST" && path === `/guilds/${GUILD}/channels`) {
      const id = String(next++);
      channels[id] = { id, type: 0, name: (options?.body as { name: string }).name, guild_id: GUILD, permission_overwrites: [] };
      return channels[id];
    }
    if (method === "POST") return { id: String(next++) };
    return undefined;
  };

  const api = {
    rest: { get, post: write("POST"), put: write("PUT"), patch: write("PATCH"), delete: write("DELETE") },
    channels: {
      createMessage: async (channelId: string, body: any) => {
        replies.push({ kind: "createMessage", body: { channelId, ...body } });
        return { id: String(next++) };
      },
      editMessage: async (_c: string, _m: string, body: any) => void replies.push({ kind: "editMessage", body }),
    },
    users: { createDM: async (id: string) => ({ id: `dm-${id}` }) },
    interactions: {
      reply: async (_i: string, _t: string, body: any) => void replies.push({ kind: "reply", body }),
      updateMessage: async (_i: string, _t: string, body: any) => void replies.push({ kind: "updateMessage", body }),
      createModal: async (_i: string, _t: string, body: any) => void replies.push({ kind: "modal", body }),
      deferMessageUpdate: async () => void replies.push({ kind: "defer", body: null }),
      followUp: async (_a: string, _t: string, body: any) => void replies.push({ kind: "followUp", body }),
    },
  } as unknown as API;
  return { api, calls, replies, channels, members, failures };
}

function setup(now = { t: Date.parse("2026-10-21T00:00:00Z") }) {
  const discord = fakeDiscord();
  const store = new Store(":memory:", randomBytes(32));
  const cache = new GuildCache(GUILD);
  cache.guild = makeGuild();
  const summarized: string[] = [];
  const planner = new Planner({
    api: discord.api,
    store,
    caches: { get: (id) => (id === GUILD ? cache : undefined) },
    selfId: () => SELF,
    now: () => now.t,
    log: () => {},
    sleep: async () => {},
    summarize: async (code) => {
      summarized.push(code);
      return "全員に @Mod を付けます。";
    },
  });
  return { ...discord, store, planner, now, summarized, cache };
}

function click(plan: Plan, action: string, userId: string, extra: Partial<APIInteraction> = {}): APIInteraction {
  return {
    id: "i",
    token: "t",
    application_id: "app",
    type: InteractionType.MessageComponent,
    member: { user: { id: userId } },
    data: { custom_id: `plan:${action}:${plan.id}:${plan.hash.slice(0, 8)}`, component_type: ComponentType.Button },
    ...extra,
  } as unknown as APIInteraction;
}

function modal(plan: Plan, userId: string, value: string): APIInteraction {
  return {
    id: "i",
    token: "t",
    application_id: "app",
    type: InteractionType.ModalSubmit,
    member: { user: { id: userId } },
    data: {
      custom_id: `plan:confirm:${plan.id}:${plan.hash.slice(0, 8)}`,
      components: [{ type: ComponentType.ActionRow, components: [{ type: ComponentType.TextInput, custom_id: "confirm", value }] }],
    },
  } as unknown as APIInteraction;
}

async function settle(check: () => boolean): Promise<void> {
  for (let i = 0; i < 100 && !check(); i++) await new Promise((r) => setImmediate(r));
  assert.ok(check(), "timed out waiting for the plan to finish");
}

test("a plan is proposed, approved by its actor, re-verified and executed in order", async () => {
  const { planner, store, calls, replies } = setup();
  const plan = await planner.propose({
    guildId: GUILD,
    channelId: "10",
    replyToId: "400",
    actorId: "1",
    shareable: new Set(["10"]),
    drafts: [
      { op: "POST /guilds/{guild}/channels", body: { name: "new" } },
      { op: "POST /channels/{channel}/messages", path: { channel: { $ref: "steps.s1.result.id" } }, body: { content: "hello" } },
    ],
  });
  assert.equal(store.getPlan(plan.id)!.status, "pending_approval");
  const dialog = replies.find((r) => r.kind === "createMessage")!.body;
  assert.equal(dialog.message_reference.message_id, "400");
  assert.deepEqual(dialog.allowed_mentions, { parse: [] });
  assert.match(dialogText(dialog), /チャンネル作成.*#new/);
  assert.deepEqual(dialogButtons(dialog), ["実行", "修正", "取り消し", "JSONを見る"]);

  // Someone else cannot approve.
  await planner.handleInteraction(click(plan, "run", "3"));
  assert.match(replies.at(-1)!.body.content, /依頼した本人だけ/);
  assert.equal(calls.length, 0);

  await planner.handleInteraction(click(plan, "run", "1"));
  await settle(() => store.getPlan(plan.id)!.status === "succeeded");
  // The second step posts into the channel the first one created.
  const created = store.getSteps(plan.id)[0]!.resultId;
  assert.deepEqual(calls.map((c) => `${c.method} ${c.path}`), [`POST /guilds/${GUILD}/channels`, `POST /channels/${created}/messages`]);
  assert.match(calls[0]!.options!.reason!, /owner の依頼/);
  const post = calls[1]!.options!.body as Record<string, unknown>;
  assert.equal(post.enforce_nonce, true);
  assert.deepEqual(post.allowed_mentions, { parse: ["users"] });
  assert.match(dialogText(replies.at(-1)!.body), /✅ 実行しました/);
  assert.deepEqual(dialogButtons(replies.at(-1)!.body), ["JSONを見る"]);
  assert.deepEqual(store.getSteps(plan.id).map((s) => s.state), ["done", "done"]);
});

test("destructive plans ask for the target's name before running", async () => {
  const { planner, store, calls, replies, channels } = setup();
  // A channel that never had a message is deleted with one click.
  const empty = await planner.propose({
    guildId: GUILD, channelId: "10", replyToId: null, actorId: "1", shareable: new Set(["10"]),
    drafts: [{ op: "DELETE /channels/{channel}", path: { channel: "10" } }],
  });
  assert.equal(needsTypedConfirm(empty), false);
  channels["10"].last_message_id = "499";
  const plan = await planner.propose({
    guildId: GUILD, channelId: "10", replyToId: null, actorId: "1", shareable: new Set(["10"]),
    drafts: [{ op: "DELETE /channels/{channel}", path: { channel: "10" } }],
  });
  assert.equal(confirmPhrase(plan), "general");
  await planner.handleInteraction(click(plan, "run", "1"));
  assert.equal(replies.at(-1)!.kind, "modal");

  await planner.handleInteraction(modal(plan, "1", "generall"));
  assert.match(replies.at(-1)!.body.content, /一致しない/);
  assert.equal(store.getPlan(plan.id)!.status, "pending_approval");

  await planner.handleInteraction(modal(plan, "1", "general"));
  await settle(() => store.getPlan(plan.id)!.status === "succeeded");
  assert.deepEqual(calls.map((c) => `${c.method} ${c.path}`), ["DELETE /channels/10"]);
  // The channel was snapshotted before deletion so it can be recreated.
  assert.equal(store.getSnapshot(plan.id, "s1")!.data!.name, "general");
});

test("a few message deletions take one click; more ask for the count, since a message has no name", async () => {
  const { planner } = setup();
  const plan = await planner.propose({
    guildId: GUILD, channelId: "10", replyToId: null, actorId: "2", shareable: new Set(["10"]),
    drafts: [{ op: "DELETE /channels/{channel}/messages/{message}", path: { channel: "10", message: "500" } }],
  });
  assert.equal(needsTypedConfirm(plan), false);
  const many = { ...plan, steps: [1, 2, 3, 4].map((n) => ({ ...plan.steps[0]!, id: `s${n}`, pathParams: { ...plan.steps[0]!.pathParams, message: String(500 + n) } })) };
  assert.equal(confirmPhrase(many), "4");
  assert.match(dialogText(renderDialog(plan, { status: "pending_approval" })), /alice「spam spam」を削除/);
});

test("a plan is aborted when its target changed after the proposal", async () => {
  const { planner, store, calls, channels } = setup();
  const plan = await planner.propose({
    guildId: GUILD, channelId: "10", replyToId: null, actorId: "1", shareable: new Set(["10"]),
    drafts: [{ op: "PATCH /channels/{channel}", path: { channel: "10" }, body: { name: "chat" } }],
  });
  assert.match(dialogText(renderDialog(plan, { status: "pending_approval" })), /name: "general" → "chat"/);
  channels["10"].name = "renamed";
  await planner.handleInteraction(click(plan, "run", "1"));
  await settle(() => store.getPlan(plan.id)!.status === "aborted");
  assert.equal(calls.length, 0);
  assert.match(store.getPlan(plan.id)!.reason!, /channel:10 の状態が提案のあとに変わりました/);
});

test("permissions lost after approval abort the plan", async () => {
  const { planner, store, calls, members } = setup();
  const plan = await planner.propose({
    guildId: GUILD, channelId: "10", replyToId: null, actorId: "2", shareable: new Set(["10"]),
    drafts: [{ op: "DELETE /channels/{channel}/messages/{message}", path: { channel: "10", message: "500" } }],
  });
  members["2"].roles = [];
  await planner.handleInteraction(click(plan, "run", "2"));
  await planner.handleInteraction(modal(plan, "2", "1"));
  await settle(() => store.getPlan(plan.id)!.status === "aborted");
  assert.equal(calls.length, 0);
});

test("a failed step stops the plan; restore proposes the inverse of what was done", async () => {
  const { planner, store, calls, failures, replies } = setup();
  const plan = await planner.propose({
    guildId: GUILD, channelId: "10", replyToId: null, actorId: "1", shareable: new Set(["10"]),
    drafts: [
      { op: "PUT /guilds/{guild}/members/{user}/roles/{role}", path: { user: "3", role: MOD_ROLE } },
      { op: "PUT /guilds/{guild}/members/{user}/roles/{role}", path: { user: "2", role: MOD_ROLE } },
      { op: "PATCH /guilds/{guild}/members/{user}", path: { user: "3" }, body: { nick: "A" } },
    ],
  });
  failures.add(`/guilds/${GUILD}/members/2/roles/${MOD_ROLE}`);
  await planner.handleInteraction(click(plan, "run", "1"));
  await settle(() => store.getPlan(plan.id)!.status === "failed");
  assert.deepEqual(store.getSteps(plan.id).map((s) => s.state), ["done", "failed", "pending"]);
  assert.match(dialogText(replies.at(-1)!.body), /途中で失敗しました\(1\/3件完了\)/);
  assert.deepEqual(dialogButtons(replies.at(-1)!.body), ["再開", "復元", "そのまま", "JSONを見る"]);

  const { drafts, skipped } = planner.restoreDrafts(store.getPlan(plan.id)!);
  assert.deepEqual(drafts, [{ op: "DELETE /guilds/{guild}/members/{user}/roles/{role}", path: { user: "3", role: MOD_ROLE } }]);
  assert.deepEqual(skipped, []);

  // Resume retries from the failed step once the cause is gone.
  failures.clear();
  await planner.handleInteraction(click(plan, "resume", "1"));
  await settle(() => store.getPlan(plan.id)!.status === "succeeded");
  assert.deepEqual(
    calls.map((c) => `${c.method} ${c.path}`),
    [
      `PUT /guilds/${GUILD}/members/3/roles/${MOD_ROLE}`,
      `PUT /guilds/${GUILD}/members/2/roles/${MOD_ROLE}`,
      `PUT /guilds/${GUILD}/members/2/roles/${MOD_ROLE}`,
      `PATCH /guilds/${GUILD}/members/3`,
    ],
  );
});

test("unanswered dialogs expire after five minutes", async () => {
  const now = { t: Date.parse("2026-10-21T00:00:00Z") };
  const { planner, store, replies } = setup(now);
  const plan = await planner.propose({
    guildId: GUILD, channelId: "10", replyToId: null, actorId: "1", shareable: new Set(["10"]),
    drafts: [{ op: "POST /channels/{channel}/messages", path: { channel: "10" }, body: { content: "x" } }],
  });
  now.t += 4 * 60_000;
  await planner.sweep();
  assert.equal(store.getPlan(plan.id)!.status, "pending_approval");
  now.t += 2 * 60_000;
  await planner.sweep();
  assert.equal(store.getPlan(plan.id)!.status, "cancelled");
  assert.match(dialogText(replies.at(-1)!.body), /期限切れ/);
  assert.deepEqual(dialogButtons(replies.at(-1)!.body), ["出し直す", "JSONを見る"]);
  // A late click does nothing.
  await planner.handleInteraction(click(plan, "run", "1"));
  assert.match(replies.at(-1)!.body.content, /もう承認待ちではありません/);
});

test("a restart marks interrupted plans failed so they can be resumed", async () => {
  const { planner, store } = setup();
  const plan = await planner.propose({
    guildId: GUILD, channelId: "10", replyToId: null, actorId: "1", shareable: new Set(["10"]),
    drafts: [{ op: "POST /channels/{channel}/messages", path: { channel: "10" }, body: { content: "x" } }],
  });
  store.transitionPlan(plan.id, ["pending_approval"], "approved", { approvedBy: "1" });
  store.transitionPlan(plan.id, ["approved"], "executing");
  store.markStepInFlight(plan.id, "s1", {});
  await planner.recover();
  assert.equal(store.getPlan(plan.id)!.status, "failed");
  assert.match(store.getSteps(plan.id)[0]!.error!, /再起動/);
});

test("custom ids round-trip and reject unknown actions", () => {
  assert.deepEqual(parsePlanCustomId("plan:run:abc123:0123abcd"), { action: "run", planId: "abc123", hash8: "0123abcd" });
  assert.equal(parsePlanCustomId("plan:drop:abc123:0123abcd"), null);
  assert.equal(parsePlanCustomId("llm:key:anthropic"), null);
});

test("proposals outside the conversation's visible channels are rejected before anything is posted", async () => {
  const { planner, replies } = setup();
  await assert.rejects(
    planner.propose({
      guildId: GUILD, channelId: "10", replyToId: null, actorId: "1", shareable: new Set(["10"]),
      drafts: [{ op: "POST /channels/{channel}/messages", path: { channel: "11" }, body: { content: "x" } }],
    }),
    PlanRejected,
  );
  assert.equal(replies.length, 0);
});

test("only irreversible steps ask for typed confirmation; reversible plans run on one click", async () => {
  const { planner, store, replies } = setup();
  const reversible = await planner.propose({
    guildId: GUILD, channelId: "10", replyToId: null, actorId: "1", shareable: new Set(["10"]),
    // Overwrites are destructive (a permission change) but can be put back.
    drafts: [{ op: "PUT /channels/{channel}/permissions/{overwrite}", path: { channel: "10", overwrite: "3" }, body: { type: 1, deny: String(P.SendMessages) } }],
  });
  assert.equal(reversible.risk, "destructive");
  await planner.handleInteraction(click(reversible, "run", "1"));
  assert.notEqual(replies.at(-1)!.kind, "modal");
  await settle(() => store.getPlan(reversible.id)!.status === "succeeded");

  const ban = await planner.propose({
    guildId: GUILD, channelId: "10", replyToId: null, actorId: "1", shareable: new Set(["10"]),
    drafts: [{ op: "PUT /guilds/{guild}/bans/{user}", path: { user: "3" }, body: { delete_message_seconds: 3600 } }],
  });
  await planner.handleInteraction(click(ban, "run", "1"));
  assert.equal(replies.at(-1)!.kind, "modal");
  assert.equal(confirmPhrase(ban), "alice");
});

test("出し直す re-validates an expired plan and takes over the same dialog", async () => {
  const now = { t: Date.parse("2026-10-21T00:00:00Z") };
  const { planner, store, replies } = setup(now);
  const plan = await planner.propose({
    guildId: GUILD, channelId: "10", replyToId: null, actorId: "1", shareable: new Set(["10"]),
    drafts: [{ op: "POST /channels/{channel}/messages", path: { channel: "10" }, body: { content: "x" } }],
  });
  const messageId = store.getPlan(plan.id)!.messageId;
  now.t += 6 * 60_000;
  await planner.sweep();
  await planner.handleInteraction(click(plan, "redo", "1"));
  const edited = replies.at(-1)!;
  assert.equal(edited.kind, "editMessage");
  assert.match(dialogText(edited.body), /依頼者が「実行」を押すと実行します/);
  assert.equal(replies.filter((r) => r.kind === "createMessage").length, 1);
  const newId = /`([0-9a-f]{12})`/.exec(dialogText(edited.body))![1]!;
  const fresh = store.getPlan(newId)!;
  assert.equal(fresh.plan.revises, plan.id);
  assert.equal(fresh.messageId, messageId);
  assert.equal(fresh.status, "pending_approval");
});

test("修正 opens a modal and hands the instruction to the agent", async () => {
  const revisions: Array<{ instruction: string; messageId: string }> = [];
  const { planner, replies } = setup();
  (planner.deps as { revise?: unknown }).revise = async (input: { instruction: string; messageId: string }) => void revisions.push(input);
  const plan = await planner.propose({
    guildId: GUILD, channelId: "10", replyToId: null, actorId: "1", shareable: new Set(["10"]),
    drafts: [{ op: "POST /guilds/{guild}/channels", body: { name: "new" } }],
  });
  await planner.handleInteraction(click(plan, "revise", "1"));
  assert.equal(replies.at(-1)!.kind, "modal");
  await planner.handleInteraction({
    id: "i", token: "t", application_id: "app", type: InteractionType.ModalSubmit, member: { user: { id: "1" } },
    data: {
      custom_id: `plan:revisetext:${plan.id}:${plan.hash.slice(0, 8)}`,
      components: [{ type: ComponentType.ActionRow, components: [{ type: ComponentType.TextInput, custom_id: "instruction", value: "名前は news に" }] }],
    },
  } as unknown as APIInteraction);
  await settle(() => revisions.length === 1);
  assert.equal(revisions[0]!.instruction, "名前は news に");

  // The revised proposal replaces the old one in the same message.
  const revised = await planner.propose({
    guildId: GUILD, channelId: "10", replyToId: null, actorId: "1", shareable: new Set(["10"]),
    drafts: [{ op: "POST /guilds/{guild}/channels", body: { name: "news" } }], replaces: plan.id,
  });
  assert.equal(planner.deps.store.getPlan(plan.id)!.status, "cancelled");
  assert.match(dialogText(replies.at(-1)!.body), /#news/);
  assert.equal(revised.revises, plan.id);
});

test("the same change to many targets is shown as one line", async () => {
  const { planner } = setup();
  const plan = await planner.propose({
    guildId: GUILD, channelId: "10", replyToId: null, actorId: "1", shareable: new Set(["10"]),
    drafts: ["1", "2", "3"].map((user) => ({ op: "PUT /guilds/{guild}/members/{user}/roles/{role}", path: { user, role: MOD_ROLE } })),
  });
  const text = dialogText(renderDialog(plan, { status: "pending_approval" }));
  assert.match(text, /1\. \*\*ロール付与\*\* \(3件\) owner、モデ、alice — @Mod を付与/);
  assert.doesNotMatch(text, /^2\./m);
});

test("a plan made from code opens on its explanation and the changes; the code and exact calls are pages away", async () => {
  const { planner, store, replies, summarized } = setup();
  const code = 'const ids = ["3"];\nreturn plan(ids.map((u) => call("PUT /guilds/{guild}/members/{user}/roles/{role}", { path: { user: u, role: "' + MOD_ROLE + '" } })));';
  const plan = await planner.propose({
    guildId: GUILD, channelId: "10", replyToId: null, actorId: "1", shareable: new Set(["10"]), code,
    drafts: [{ op: "PUT /guilds/{guild}/members/{user}/roles/{role}", path: { user: "3", role: MOD_ROLE } }],
  });
  // The explainer is given the code and nothing else.
  assert.deepEqual(summarized, [code]);
  assert.deepEqual(plan.source, { code, summary: "全員に @Mod を付けます。" });
  const opened = replies.at(-1)!.body;
  assert.match(dialogText(opened), /コードの説明\*\*\n全員に @Mod を付けます。[\s\S]*ロール付与/);
  assert.doesNotMatch(dialogText(opened), /```/);
  assert.deepEqual(dialogButtons(opened), ["実行", "修正", "取り消し", "概要", "コード", "詳細", "JSONを見る"]);

  // Anyone may switch the view; it stays switched when the dialog is redrawn.
  await planner.handleInteraction(click(plan, "code", "2"));
  assert.match(dialogText(replies.at(-1)!.body), /```js\nconst ids/);
  await planner.handleInteraction(click(plan, "details", "2"));
  assert.match(dialogText(replies.at(-1)!.body), /```json\n\[\{"id":"s1"/);
  await planner.handleInteraction(click(plan, "cancel", "1"));
  assert.match(dialogText(replies.at(-1)!.body), /```json/);
  assert.equal(store.getPlan(plan.id)!.status, "cancelled");
});

test("a plan made from steps has no code view", async () => {
  const { planner, replies, summarized } = setup();
  await planner.propose({
    guildId: GUILD, channelId: "10", replyToId: null, actorId: "1", shareable: new Set(["10"]),
    drafts: [{ op: "POST /channels/{channel}/messages", path: { channel: "10" }, body: { content: "x" } }],
  });
  assert.equal(summarized.length, 0);
  assert.deepEqual(dialogButtons(replies.at(-1)!.body), ["実行", "修正", "取り消し", "JSONを見る"]);
});

// --- Plans made by event rules -------------------------------------------------

const RULE = {
  id: "r1",
  version: 1,
  name: "挨拶",
  eventId: "MESSAGE_CREATE:500:x",
  allow: [{ op: "POST /channels/{channel}/messages", path: { channel: { enum: ["10"] } }, body: { type: "object", properties: { content: { type: "string", maxLength: 50 } }, additionalProperties: false }, maxStepsPerRun: 1 }],
};

test("a rule's plan runs without a dialog, as its owner, inside its allow list", async () => {
  const { planner, store, calls, replies } = setup();
  const written: string[] = [];
  planner.deps.onWrite = (_plan, step) => void written.push(step.op);
  const done = await planner.runForRule({ guildId: GUILD, ownerId: "1", rule: RULE, drafts: [{ op: "POST /channels/{channel}/messages", path: { channel: "10" }, body: { content: "ようこそ" } }] });
  assert.equal(done.status, "succeeded");
  assert.equal(replies.length, 0); // no dialog
  assert.deepEqual(calls.map((c) => `${c.method} ${c.path}`), ["POST /channels/10/messages"]);
  assert.match(calls[0]!.options!.reason!, /owner のルール「挨拶」/);
  const row = store.getPlan(done.plan.id)!;
  assert.equal(row.plan.actor.via, "rule");
  assert.equal(row.approvedBy, "1");
  assert.deepEqual(written, ["POST /channels/{channel}/messages"]);
});

test("a rule's steps outside its allow list, or past its count, are rejected before anything runs", async () => {
  const { planner, calls } = setup();
  const run = (drafts: any[]) => planner.runForRule({ guildId: GUILD, ownerId: "1", rule: RULE, drafts });
  await assert.rejects(run([{ op: "POST /channels/{channel}/messages", path: { channel: "11" }, body: { content: "x" } }]), (e: unknown) => e instanceof PlanRejected && /範囲外/.test(e.reasons.join()));
  await assert.rejects(run([{ op: "POST /channels/{channel}/messages", path: { channel: "10" }, body: { content: "x".repeat(60) } }]), PlanRejected);
  await assert.rejects(run([{ op: "DELETE /channels/{channel}", path: { channel: "10" } }]), PlanRejected);
  await assert.rejects(
    run([
      { op: "POST /channels/{channel}/messages", path: { channel: "10" }, body: { content: "a" } },
      { op: "POST /channels/{channel}/messages", path: { channel: "10" }, body: { content: "b" } },
    ]),
    (e: unknown) => e instanceof PlanRejected && /1回に1件まで/.test(e.reasons.join()),
  );
  // The owner's own permissions still apply.
  const manage = { ...RULE, allow: [{ op: "PATCH /channels/{channel}" }] };
  await assert.rejects(planner.runForRule({ guildId: GUILD, ownerId: "3", rule: manage, drafts: [{ op: "PATCH /channels/{channel}", path: { channel: "10" }, body: { topic: "x" } }] }), /依頼者に権限 ManageChannels/);
  assert.equal(calls.length, 0);
});

test("a value from an earlier step is checked against the allow list once it is known", async () => {
  const { planner, calls } = setup();
  const rule = { ...RULE, allow: [{ op: "POST /guilds/{guild}/channels" }, { op: "POST /channels/{channel}/messages", path: { channel: { enum: ["10"] } } }] };
  const done = await planner.runForRule({
    guildId: GUILD, ownerId: "1", rule,
    drafts: [
      { op: "POST /guilds/{guild}/channels", body: { name: "new" } },
      { op: "POST /channels/{channel}/messages", path: { channel: { $ref: "steps.s1.result.id" } }, body: { content: "hi" } },
    ],
  });
  assert.equal(done.status, "failed");
  assert.match(done.reason!, /範囲外/);
  assert.deepEqual(calls.map((c) => c.method), ["POST"]); // the message was never sent
});

test("a rule's target conditions are checked on the target as it is right before the step", async () => {
  const { planner, calls, channels, cache } = setup();
  channels["60"] = { id: "60", type: 2, name: "📞 alice", guild_id: GUILD, permission_overwrites: [] };
  cache.guild!.channels.set("60", { id: "60", type: 2, name: "📞 alice", parentId: null, overwrites: [] });
  const rule = { ...RULE, allow: [{ op: "DELETE /channels/{channel}", target: { properties: { name: { pattern: "^📞" } }, required: ["name"] }, maxStepsPerRun: 1 }] };
  const run = (channel: string) => planner.runForRule({ guildId: GUILD, ownerId: "1", rule, drafts: [{ op: "DELETE /channels/{channel}", path: { channel } }] });
  await assert.rejects(run("10"), (e: unknown) => e instanceof PlanRejected && /範囲外/.test(e.reasons.join()));
  assert.equal(calls.length, 0);
  assert.equal((await run("60")).status, "succeeded");
  assert.deepEqual(calls.map((c) => `${c.method} ${c.path}`), ["DELETE /channels/60"]);
});

// The dynamic voice channel example: a lobby made by the plan, and two rules that use it.
const LOBBY_RULE = {
  name: "通話部屋を作る",
  trigger: { event: "VOICE_STATE_UPDATE" },
  allow: [
    { op: "POST /guilds/{guild}/channels", body: { type: "object", properties: { name: { type: "string", pattern: "^📞" }, type: { const: 2 } }, required: ["name", "type"], additionalProperties: false }, maxStepsPerRun: 1 },
    { op: "PATCH /guilds/{guild}/members/{user}", body: { type: "object", properties: { channel_id: { type: "string" } }, required: ["channel_id"], additionalProperties: false }, maxStepsPerRun: 1 },
  ],
  code: "if (event.channel_id !== params.lobby) return null; return plan([]);",
  params: { lobby: { $ref: "steps.s1.result.id" } },
};
const CLEANUP_RULE = {
  name: "空き部屋を消す",
  trigger: { event: "VOICE_STATE_UPDATE", includeBotOrigin: true },
  allow: [{ op: "DELETE /channels/{channel}", target: { properties: { name: { pattern: "^📞" } }, required: ["name"] }, maxStepsPerRun: 1 }],
  code: "return null;",
  sampleEvent: { guild_id: GUILD, user_id: "3", channel_id: null, before_channel_id: "10" },
};

function withRules(t: ReturnType<typeof setup>, visibilityScore?: () => Promise<number | null>) {
  const caches = { get: (id: string | undefined) => (id === GUILD ? t.cache : undefined) };
  const admin = new RuleAdmin({ store: t.store, caches, selfId: () => SELF, now: () => t.now.t });
  const engine = new RuleEngine({
    store: t.store, caches, planner: t.planner, selfId: () => SELF, now: () => t.now.t, log: () => {},
    makeReader: () => ({ get: async () => null }) as never,
    run: async () => ({ ok: true, value: null, logs: [] }),
  });
  const service = new RuleService({ api: t.api, store: t.store, caches, admin, engine, selfId: () => SELF, now: () => t.now.t, log: () => {}, summarize: async () => "説明です。", ...(visibilityScore ? { visibilityScore } : {}) });
  t.planner.deps.rules = { prepare: (i) => service.prepare(i), register: (g, o, d) => service.register(g, o, d) };
  return { admin, engine, service };
}

const reader = { get: async () => null };

test("one approval runs the steps and registers the rules, with the steps' results filled in", async () => {
  const t = setup();
  withRules(t);
  const plan = await t.planner.propose({
    guildId: GUILD, channelId: "10", replyToId: "400", actorId: "1", shareable: new Set(["10"]),
    drafts: [{ op: "POST /guilds/{guild}/channels", body: { name: "vc作成", type: 2 } }],
    rules: [LOBBY_RULE, CLEANUP_RULE], reader, request: "vcを動的に作成削除する仕組みを作りたい",
  });
  assert.equal(plan.rules!.length, 2);
  assert.equal(plan.rules![0]!.dry.outcome, "pending"); // it needs the lobby's id
  assert.equal(plan.rules![1]!.dry.outcome, "none");
  assert.equal(plan.risk, "destructive"); // the cleanup rule may delete channels
  const dialog = t.replies.find((r) => r.kind === "createMessage")!.body;
  const text = dialogText(dialog);
  assert.match(text, /1件 · ルール2件/);
  assert.match(text, /登録するルール/);
  assert.match(text, /通話部屋を作る/);
  assert.doesNotMatch(text, /lobby:/);
  assert.deepEqual(dialogButtons(dialog), ["実行", "修正", "取り消し", "概要", "コード", "詳細", "JSONを見る"]);
  await t.planner.handleInteraction(click(plan, "details", "1"));
  const details = dialogText(t.replies.at(-1)!.body);
  assert.match(details, /lobby: \(s1 で作るもののid\)/);
  assert.match(details, /対象の条件: .*📞/);
  assert.equal(t.store.listRules(GUILD).length, 0); // nothing is registered before the approval

  // One click: the lobby is made, then both rules are registered.
  await t.planner.handleInteraction(click(plan, "run", "1"));
  await settle(() => t.store.getPlan(plan.id)!.status === "succeeded");
  const lobby = t.store.getSteps(plan.id)[0]!.resultId!;
  const rules = t.store.listRules(GUILD);
  assert.equal(rules.length, 2);
  const made = rules.find((r) => r.name === "通話部屋を作る")!;
  assert.deepEqual(made.params, { lobby });
  assert.equal(made.ownerId, "1");
  assert.equal(made.summary, "説明です。");
  assert.equal(made.sourcePrompt, "vcを動的に作成削除する仕組みを作りたい");
  assert.equal(rules.find((r) => r.name === "空き部屋を消す")!.trigger.includeBotOrigin, true);
  assert.match(dialogText(t.replies.at(-1)!.body), /ルール2件を登録しました/);
});

test("rules are checked at proposal: refs must point to the plan's steps, and a plan may be rules alone", async () => {
  const t = setup();
  withRules(t);
  const base = { guildId: GUILD, channelId: "10", replyToId: null, actorId: "1", shareable: new Set(["10"]), reader, request: "x" };
  await assert.rejects(
    t.planner.propose({ ...base, drafts: [], rules: [{ ...LOBBY_RULE, params: { lobby: { $ref: "steps.s9.result.id" } } }] }),
    (e: unknown) => e instanceof PlanRejected && /指していません/.test(e.reasons.join()),
  );
  // A regular member cannot own a rule that deletes channels.
  await assert.rejects(t.planner.propose({ ...base, actorId: "3", drafts: [], rules: [CLEANUP_RULE] }), /ManageChannels/);
  // Without a real event or a sample, the agent is asked for one.
  const { sampleEvent: _, ...unsampled } = CLEANUP_RULE;
  await assert.rejects(t.planner.propose({ ...base, drafts: [], rules: [unsampled] }), /sample_event/);

  const plan = await t.planner.propose({ ...base, drafts: [], rules: [CLEANUP_RULE] });
  assert.equal(plan.steps.length, 0);
  await t.planner.handleInteraction(click(plan, "run", "1"));
  await settle(() => t.store.getPlan(plan.id)!.status === "succeeded");
  assert.equal(t.store.listRules(GUILD).length, 1);
  assert.equal(t.calls.length, 0);
});

test("a new version of a rule shows what it did before and what it will do", async () => {
  const t = setup();
  withRules(t);
  const base = { guildId: GUILD, channelId: "10", replyToId: null, actorId: "1", shareable: new Set(["10"]), reader, request: "x" };
  const first = await t.planner.propose({ ...base, drafts: [], rules: [CLEANUP_RULE] });
  await t.planner.handleInteraction(click(first, "run", "1"));
  await settle(() => t.store.getPlan(first.id)!.status === "succeeded");
  const old = t.store.listRules(GUILD)[0]!;
  t.store.db.prepare("UPDATE rules SET rule_json = json_set(rule_json, '$.summary', ?) WHERE id = ?").run("前の説明です。", old.id);

  const plan = await t.planner.propose({ ...base, drafts: [], rules: [{ ...CLEANUP_RULE, replaces: old.id, trigger: { event: "VOICE_STATE_UPDATE" } }] });
  const text = dialogText(renderDialog(plan, { status: "pending_approval" }));
  assert.match(text, /変更前: 前の説明です。/);
  assert.match(text, /変更後: 説明です。/);
  assert.match(text, /変わる設定: きっかけ/);
});

test("propose_plan refuses steps and code together, and points out rule code passed as plan code", async () => {
  const { readTools } = await import("../src/agent/tools.ts");
  const fakeReader = { guild: { id: GUILD }, scope: { speakerId: "1", channelId: "10" }, get: async () => [] } as never;
  const proposed: unknown[] = [];
  const tool = readTools(fakeReader, { images: false, propose: async (...a) => (proposed.push(a), ({ id: "p", steps: [], risk: "write" }) as never), rules: { list: () => [], runs: () => null } })
    .find((t) => t.name === "propose_plan")!;
  await assert.rejects(tool.execute("t", { steps: [{ op: "POST /guilds/{guild}/channels", body: { name: "x" } }], code: "return plan([])" }), /同時に使えません/);
  await assert.rejects(tool.execute("t", { code: "return event.channel_id" }), /rules\[\]\.code/);
  assert.equal(proposed.length, 0);
});

test("with a coding model, the agent describes code and the coder writes and fixes it", async () => {
  const { readTools } = await import("../src/agent/tools.ts");
  const { extractCode, syntaxError } = await import("../src/agent/coder.ts");
  const fakeReader = { guild: { id: GUILD }, scope: { speakerId: "1", channelId: "10" }, get: async () => [{ id: "7", name: "general" }] } as never;
  // Hands out its answers in order, recording what it was asked and the errors it was shown.
  const asked: Array<{ kind: string; task: string; errors: string[] }> = [];
  const coderOf = (answers: Record<string, string[]>) => ({
    label: "fake",
    async write(kind: "read" | "plan" | "rule", task: string, { check }: { check: (code: string) => Promise<string | null> }) {
      const entry = { kind, task, errors: [] as string[] };
      asked.push(entry);
      const list = answers[kind]!;
      for (const [i, code] of list.entries()) {
        const problem = await check(code);
        if (problem === null) return { code, attempts: i + 1 };
        entry.errors.push(problem);
      }
      const { CodeFailed } = await import("../src/agent/coder.ts");
      throw new CodeFailed("直せませんでした", list.at(-1)!);
    },
  });
  const proposed: unknown[][] = [];
  const tools = (coder: ReturnType<typeof coderOf>) =>
    readTools(fakeReader, { images: false, coder, propose: async (...a) => (proposed.push(a), ({ id: "p", steps: [], risk: "write" }) as never), rules: { list: () => [], runs: () => null } });

  // run_code takes a task; the coder's first try throws and its second is run.
  const coder = coderOf({
    read: ["return nope.length", "return discord.get(`/guilds/${guild}/channels`).length"],
    plan: ["return plan([call('POST /guilds/{guild}/channels', { body: { name: 'vc作成', type: 2 } })])"],
    rule: ["if (!event.channel_id) return null; return plan([])"],
  });
  const run = tools(coder).find((t) => t.name === "run_code")!;
  assert.ok("task" in (run.parameters as { properties: object }).properties);
  const out = await run.execute("t", { task: "チャンネルの数を返す" });
  assert.match((out.content[0] as { text: string }).text, /結果:\n1/);
  assert.equal(asked[0]!.errors.length, 1);

  const propose = tools(coder).find((t) => t.name === "propose_plan")!;
  const props = (propose.parameters as { properties: Record<string, unknown> }).properties;
  assert.ok("code_task" in props && !("code" in props));
  await propose.execute("t", {
    code_task: "vc作成 というボイスチャンネルを作る",
    rules: [{ name: "通話部屋", trigger_event: "VOICE_STATE_UPDATE", allow: [{ op: "POST /guilds/{guild}/channels" }], code_task: "vc作成 に入った人の部屋を作る", params: { lobby: "1" } }],
  });
  const [drafts, code, rules] = proposed[0] as [Array<{ op: string }>, string, Array<{ code: string; name: string }>];
  assert.equal(drafts[0]!.op, "POST /guilds/{guild}/channels");
  assert.match(code, /vc作成/);
  assert.equal(rules[0]!.code, "if (!event.channel_id) return null; return plan([])");
  // The rule's task carries its trigger, params and allow, since the coder sees nothing else.
  const ruleAsk = asked.find((a) => a.kind === "rule")!;
  assert.match(ruleAsk.task, /VOICE_STATE_UPDATE/);
  assert.match(ruleAsk.task, /"lobby":"1"/);

  // When the coder gives up, the agent sees why and the last code.
  const stuck = tools(coderOf({ read: ["return nope", "return nope"], plan: [], rule: [] })).find((t) => t.name === "run_code")!;
  await assert.rejects(stuck.execute("t", { task: "x" }), /直せませんでした[\s\S]*return nope[\s\S]*task/);

  assert.equal(extractCode("説明\n```js\nreturn 1\n```\n```javascript\nreturn 2\n```"), "return 2");
  assert.equal(extractCode("return 3"), "return 3");
  assert.equal(await syntaxError("return event.x"), null);
  assert.match((await syntaxError("return ("))!, /SyntaxError/);
});

const PNG = { name: "formula.png", data: Buffer.from("png-bytes").toString("base64") };

test("a post can carry images drawn in the reply; the dialog shows them and the post uploads them", async () => {
  const { planner, store, calls, replies } = setup();
  const plan = await planner.propose({
    guildId: GUILD, channelId: "10", replyToId: null, actorId: "1", shareable: new Set(["10"]),
    drafts: [{ op: "POST /channels/{channel}/messages", path: { channel: "10" }, body: { content: "今日の式", files: ["img1"] } }],
    images: { img1: PNG, img2: { name: "unused.png", data: "eA==" } },
  });
  // Only the images the posts name go into the plan.
  assert.deepEqual(Object.keys(plan.attachments ?? {}), ["img1"]);
  const dialog = replies.find((r) => r.kind === "createMessage")!.body;
  assert.deepEqual(dialog.files.map((f: { name: string }) => f.name), ["img1.png"]);
  const gallery = dialog.components[0].components.find((c: { type: number }) => c.type === ComponentType.MediaGallery);
  assert.equal(gallery.items[0].media.url, "attachment://img1.png");
  assert.match(dialogText(dialog), /「今日の式」\(画像1枚\)/);

  await planner.handleInteraction(click(plan, "run", "1"));
  await settle(() => store.getPlan(plan.id)!.status === "succeeded");
  const options = calls[0]!.options as { body: Record<string, unknown>; files: Array<{ name: string; data: Buffer }> };
  assert.equal(options.body.files, undefined);
  assert.deepEqual(options.body.attachments, [{ id: 0, filename: "formula.png" }]);
  assert.equal(options.files[0]!.name, "formula.png");
  assert.equal(options.files[0]!.data.toString(), "png-bytes");
});

test("a post needs text or an image that exists; a DM can carry an image too", async () => {
  const { planner, replies } = setup();
  const base = { guildId: GUILD, channelId: "10", replyToId: null, actorId: "1", shareable: new Set(["10"]) };
  await assert.rejects(
    planner.propose({ ...base, drafts: [{ op: "POST /channels/{channel}/messages", path: { channel: "10" }, body: { files: ["img3"] } }], images: { img1: PNG } }),
    (e: unknown) => e instanceof PlanRejected && /画像 img3 がありません/.test(e.message),
  );
  await assert.rejects(
    planner.propose({ ...base, drafts: [{ op: "POST /channels/{channel}/messages", path: { channel: "10" }, body: {} }] }),
    (e: unknown) => e instanceof PlanRejected && /本文\(content\)か画像\(files\)/.test(e.message),
  );
  const dm = await planner.propose({ ...base, drafts: [{ op: "POST /users/{user}/dm", path: { user: "3" }, body: { files: ["img1"] } }], images: { img1: PNG } });
  assert.match(dialogText(replies.find((r) => r.kind === "createMessage")!.body), /DM\(画像のみ\)\(画像1枚\)/);
  assert.ok(dm.attachments?.img1);
});

test("a revised plan may keep the images of the plan it replaces, and the dialog swaps them", async () => {
  const { planner, replies } = setup();
  const base = { guildId: GUILD, channelId: "10", replyToId: null, actorId: "1", shareable: new Set(["10"]) };
  const first = await planner.propose({ ...base, drafts: [{ op: "POST /channels/{channel}/messages", path: { channel: "10" }, body: { files: ["img1"] } }], images: { img1: PNG } });
  const second = await planner.propose({ ...base, replaces: first.id, drafts: [{ op: "POST /channels/{channel}/messages", path: { channel: "10" }, body: { content: "直しました", files: ["img1"] } }] });
  assert.deepEqual(second.attachments, first.attachments);
  const edit = replies.find((r) => r.kind === "editMessage")!.body;
  assert.deepEqual(edit.attachments, [{ id: 0, filename: "img1.png" }]);
  assert.equal(edit.files.length, 1);
});

test("a rule's post carries the images its code made, and only those", async () => {
  const { planner, calls } = setup();
  const rule = { ...RULE, allow: [{ op: "POST /channels/{channel}/messages", path: { channel: { enum: ["10"] } }, body: { type: "object", properties: { content: { type: "string" }, files: { type: "array", maxItems: 4 } }, additionalProperties: false } }] };
  const drafts = [{ op: "POST /channels/{channel}/messages", path: { channel: "10" }, body: { content: "x", files: ["img1"] } }];
  await assert.rejects(planner.runForRule({ guildId: GUILD, ownerId: "1", rule, drafts }), /画像 img1 がありません/);
  const done = await planner.runForRule({ guildId: GUILD, ownerId: "1", rule, drafts, images: { img1: PNG } });
  assert.equal(done.status, "succeeded");
  assert.equal((calls.at(-1)!.options as { files?: unknown[] }).files!.length, 1);
  // The allow list still decides: a body without files in it refuses them.
  await assert.rejects(planner.runForRule({ guildId: GUILD, ownerId: "1", rule: RULE, drafts, images: { img1: PNG } }), /範囲外/);
});

const TEX_RULE = {
  name: "数式",
  trigger: { event: "COMMAND", command: { name: "tex", description: "数式を画像にする", options: [{ name: "tex", description: "TeX", type: "string" as const, required: true }] } },
  allow: [],
  code: "reply('ok'); return null;",
};

test("a command's dialog starts on the judge's pick for who sees replies, and the requester can change it", async () => {
  const t = setup();
  let score: number | null = 0.5;
  withRules(t, async () => score);
  const base = { guildId: GUILD, channelId: "10", replyToId: null, actorId: "1", shareable: new Set(["10"]), reader, request: "/tex を作って", drafts: [] };
  const selectOf = (body: any) => body.components[0].components.find((c: any) => c.type === ComponentType.ActionRow && c.components[0].type === ComponentType.StringSelect)?.components[0];
  const chosen = (body: any) => selectOf(body)?.options.find((o: any) => o.default)?.value;

  const plan = await t.planner.propose({ ...base, rules: [TEX_RULE] });
  assert.equal(plan.rules![0]!.trigger.command!.visibility, "auto");
  assert.equal(chosen(t.replies.at(-1)!.body), "auto");
  score = 0.9;
  assert.equal((await t.planner.propose({ ...base, rules: [TEX_RULE] })).rules![0]!.trigger.command!.visibility, "public");
  score = null; // no judge model: only the person who ran it
  assert.equal((await t.planner.propose({ ...base, rules: [TEX_RULE] })).rules![0]!.trigger.command!.visibility, "private");
  // What the request said is kept.
  const told = { ...TEX_RULE, trigger: { ...TEX_RULE.trigger, command: { ...TEX_RULE.trigger.command, visibility: "public" as const } } };
  score = 0;
  assert.equal((await t.planner.propose({ ...base, rules: [told] })).rules![0]!.trigger.command!.visibility, "public");

  // Only the requester changes it; the change is part of what gets approved.
  const pick = (userId: string, value: string) => ({
    ...click(plan, "visibility", userId),
    data: { custom_id: `plan:visibility.r1:${plan.id}:${plan.hash.slice(0, 8)}`, component_type: ComponentType.StringSelect, values: [value] },
  }) as unknown as APIInteraction;
  await t.planner.handleInteraction(pick("3", "public"));
  assert.equal(t.store.getPlan(plan.id)!.plan.rules![0]!.trigger.command!.visibility, "auto");
  await t.planner.handleInteraction(pick("1", "public"));
  const changed = t.store.getPlan(plan.id)!.plan;
  assert.equal(changed.rules![0]!.trigger.command!.visibility, "public");
  assert.notEqual(changed.hash, plan.hash);
  assert.equal(chosen(t.replies.at(-1)!.body), "public");
  // The old buttons no longer work; the redrawn ones do, and register the pick.
  await t.planner.handleInteraction(click(plan, "run", "1"));
  assert.equal(t.store.getPlan(plan.id)!.status, "pending_approval");
  await t.planner.handleInteraction(click(changed, "run", "1"));
  await settle(() => t.store.getPlan(plan.id)!.status === "succeeded");
  assert.equal(t.store.listRules(GUILD)[0]!.trigger.command!.visibility, "public");
});
