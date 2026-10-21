import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import type { API } from "@discordjs/core";
import { DiscordAPIError } from "@discordjs/rest";
import { InteractionType, ComponentType, PermissionFlagsBits as P } from "discord-api-types/v10";
import type { APIInteraction } from "discord-api-types/v10";
import { Store } from "../src/db.ts";
import { GuildCache } from "../src/discord/cache.ts";
import { confirmPhrase, dialogButtons, dialogText, parsePlanCustomId, renderDialog } from "../src/plan/dialog.ts";
import { Planner } from "../src/plan/service.ts";
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
  const planner = new Planner({
    api: discord.api,
    store,
    caches: { get: (id) => (id === GUILD ? cache : undefined) },
    selfId: () => SELF,
    now: () => now.t,
    log: () => {},
    sleep: async () => {},
  });
  return { ...discord, store, planner, now };
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
  const { planner, store, calls, replies } = setup();
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

test("a message deletion asks for the count, since a message has no name", async () => {
  const { planner } = setup();
  const plan = await planner.propose({
    guildId: GUILD, channelId: "10", replyToId: null, actorId: "2", shareable: new Set(["10"]),
    drafts: [{ op: "DELETE /channels/{channel}/messages/{message}", path: { channel: "10", message: "500" } }],
  });
  assert.equal(confirmPhrase(plan), "1");
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
