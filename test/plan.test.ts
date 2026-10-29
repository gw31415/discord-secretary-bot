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
import { batchKey, referencedSteps } from "../src/plan/batch.ts";
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

test("an op with its ids written into the path names the same operation", () => {
  const [patch, del, react, mine] = normalizeSteps(
    [
      { op: `PATCH /guilds/${GUILD}/emojis/700`, body: { name: "new_cat" } },
      { op: "DELETE /guilds/{guild}/stickers/800" },
      { op: `DELETE /channels/10/messages/500/reactions/${encodeURIComponent("👍")}/3` },
      { op: "PUT /channels/10/messages/500/reactions/👍/@me" },
    ],
    GUILD,
    "p",
  );
  assert.equal(patch!.op, "PATCH /guilds/{guild}/emojis/{emoji}");
  assert.deepEqual(patch!.pathParams, { guild: GUILD, emoji: "700" });
  assert.deepEqual(del!.pathParams, { guild: GUILD, sticker: "800" });
  assert.equal(react!.op, "DELETE /channels/{channel}/messages/{message}/reactions/{emoji}/{user}");
  assert.deepEqual(react!.pathParams, { channel: "10", message: "500", emoji: "👍", user: "3" });
  // The literal @me wins over {user}.
  assert.equal(mine!.op, "PUT /channels/{channel}/messages/{message}/reactions/{emoji}/@me");
  rejects(() => normalizeSteps([{ op: "PATCH /guilds/{guild}/emojis/700", path: { emoji: "701" }, body: { name: "x_y" } }], GUILD, "p"), /食い違って/);
  rejects(() => normalizeSteps([{ op: "PATCH /guilds/555/emojis/700", body: { name: "x_y" } }], GUILD, "p"), /別のサーバー/);
});

test("whoever ran a command may edit its public reply without managing messages, and only that message", () => {
  const guild = makeGuild();
  const [own, other] = normalizeSteps([
    { op: "PATCH /channels/{channel}/messages/{message}", path: { channel: "10", message: "880" }, body: { components: [] } },
    { op: "PATCH /channels/{channel}/messages/{message}", path: { channel: "10", message: "881" }, body: { components: [] } },
  ], GUILD, "p");
  const ctx = { guild, actorId: "3", selfId: SELF, ownReply: { channelId: "10", messageId: "880" } };
  assert.deepEqual(permissionProblems(own!, ctx), []);
  assert.match(permissionProblems(other!, ctx).join(), /依頼者に権限 ManageMessages/);
  assert.match(permissionProblems(own!, { guild, actorId: "3", selfId: SELF }).join(), /依頼者に権限 ManageMessages/);
  // The bot still needs the permissions it always does.
  guild.roles.set(BOT_ROLE, { id: BOT_ROLE, permissions: P.ViewChannel, position: 2 });
  assert.match(permissionProblems(own!, ctx).join(), /Botに権限/);
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
  const emojis: Record<string, any> = { "700": { id: "700", name: "old_cat", roles: [] } };
  const stickers: Record<string, any> = { "800": { id: "800", name: "ねこ", description: null, tags: "cat" } };
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
    if ((m = /^\/guilds\/\d+\/emojis\/(\d+)$/.exec(path))) return emojis[m[1]!] ?? Promise.reject(notFound(path));
    if ((m = /^\/guilds\/\d+\/stickers\/(\d+)$/.exec(path))) return stickers[m[1]!] ?? Promise.reject(notFound(path));
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
    if (method === "POST" && path === `/guilds/${GUILD}/bulk-ban`) {
      const ids = (options?.body as { user_ids: string[] }).user_ids;
      return { banned_users: ids.filter((id) => !failures.has(`ban:${id}`)), failed_users: ids.filter((id) => failures.has(`ban:${id}`)) };
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
  return { api, calls, replies, channels, members, messages, roles, failures };
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

/** Picks a section (or 「ファイルで受け取る」) from the dialog's menu. */
function pick(plan: Plan, value: string, userId: string): APIInteraction {
  return {
    id: "i", token: "t", application_id: "app", type: InteractionType.MessageComponent, member: { user: { id: userId } },
    data: { custom_id: `plan:view:${plan.id}:${plan.hash.slice(0, 8)}`, component_type: ComponentType.StringSelect, values: [value] },
  } as unknown as APIInteraction;
}

/** The dialog's menu options, the shown one marked with *. */
function menu(body: { components: unknown[] }): string[] {
  const container = body.components[0] as { components: Array<{ type: number; components?: Array<{ custom_id?: string; options?: Array<{ label: string; default?: boolean }> }> }> };
  const select = container.components.flatMap((c) => c.components ?? []).find((c) => c.custom_id?.startsWith("plan:view:"));
  return (select?.options ?? []).map((o) => `${o.label}${o.default ? "*" : ""}`);
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
  assert.deepEqual(dialogButtons(dialog), ["実行", "修正", "取り消し"]);

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
  assert.deepEqual(dialogButtons(replies.at(-1)!.body), []);
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
  assert.deepEqual(dialogButtons(replies.at(-1)!.body), ["再開", "復元", "そのまま"]);

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
  assert.deepEqual(dialogButtons(replies.at(-1)!.body), ["出し直す"]);
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

test("a step on a hidden channel is turned down for that alone, whether or not the channel exists", async () => {
  const { planner } = setup();
  const reasons = async (channel: string) => {
    const e = await planner.propose({
      guildId: GUILD, channelId: "10", replyToId: null, actorId: "3", shareable: new Set(["10"]),
      drafts: [{ op: "PATCH /channels/{channel}", path: { channel }, body: { name: "x" } }],
    }).catch((e: unknown) => e);
    assert.ok(e instanceof PlanRejected);
    return e.reasons.map((r) => r.replace(channel, "X"));
  };
  // Nothing about who may manage the staff channel comes back, and it reads like a channel that is not there.
  assert.deepEqual(await reasons("11"), await reasons("4242"));
  assert.doesNotMatch((await reasons("11")).join(), /権限/);
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
  assert.match(dialogText(edited.body), /期限 <t:\d+:R>/);
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

test("a plan made from code opens on its explanation and the changes; the code and exact calls are sections away", async () => {
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
  assert.deepEqual(dialogButtons(opened), ["実行", "修正", "取り消し"]);

  assert.deepEqual(menu(opened), ["概要*", "コード", "詳細", "ファイルで受け取る"]);

  // Anyone may switch the section, in place; it stays switched when the dialog is redrawn.
  await planner.handleInteraction(pick(plan, "code", "2"));
  const shown = replies.at(-1)!;
  assert.equal(shown.kind, "updateMessage");
  assert.match(dialogText(shown.body), /```js\nconst ids/);
  assert.deepEqual(menu(shown.body), ["概要", "コード*", "詳細", "ファイルで受け取る"]);
  // Files go only to whoever asked; the dialog stays on its section.
  await planner.handleInteraction(pick(plan, "files", "2"));
  assert.deepEqual(replies.slice(-2).map((r) => r.kind), ["updateMessage", "followUp"]);
  assert.deepEqual(menu(replies.at(-2)!.body), ["概要", "コード*", "詳細", "ファイルで受け取る"]);
  assert.deepEqual(replies.at(-1)!.body.files.map((f: { name: string }) => f.name), [`plan-${plan.id}.json`, "plan.js"]);
  await planner.handleInteraction(pick(plan, "details", "2"));
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
  assert.deepEqual(dialogButtons(replies.at(-1)!.body), ["実行", "修正", "取り消し"]);
});

// --- Plans made by event rules -------------------------------------------------

test("a channel the dialog showed must still be one its actor can see when they approve", async () => {
  const { planner, store, calls, roles, channels, cache } = setup();
  roles[1]!.permissions = String(BigInt(roles[1]!.permissions) | P.ManageChannels);
  cache.guild!.roles.set(MOD_ROLE, { ...cache.guild!.roles.get(MOD_ROLE)!, permissions: BigInt(roles[1]!.permissions) });
  const plan = await planner.propose({
    guildId: GUILD, channelId: "10", replyToId: null, actorId: "2", shareable: new Set(["10", "11"]),
    drafts: [{ op: "POST /guilds/{guild}/channels", body: { name: "new", parent_id: "11" } }],
  });
  // After the proposal, the moderator is shut out of #staff.
  channels["11"].permission_overwrites = [{ id: "2", type: 1, allow: "0", deny: String(P.ViewChannel) }];
  await planner.handleInteraction(click(plan, "run", "2"));
  await settle(() => store.getPlan(plan.id)!.status === "aborted");
  assert.equal(calls.length, 0);
  assert.match(store.getPlan(plan.id)!.reason!, /チャンネル 11 を依頼者が見られなくなりました/);
});

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
  planner.deps.beforeWrite = (_plan, step) => void written.push(`before ${step.op} (${calls.length} sent)`);
  planner.deps.onWrite = (_plan, step) => void written.push(step.op);
  const done = await planner.runForRule({ guildId: GUILD, actorId: "1", rule: RULE, drafts: [{ op: "POST /channels/{channel}/messages", path: { channel: "10" }, body: { content: "ようこそ" } }] });
  assert.equal(done.status, "succeeded");
  assert.equal(replies.length, 0); // no dialog
  assert.deepEqual(calls.map((c) => `${c.method} ${c.path}`), ["POST /channels/10/messages"]);
  assert.match(calls[0]!.options!.reason!, /owner のルール「挨拶」/);
  const row = store.getPlan(done.plan.id)!;
  assert.equal(row.plan.actor.via, "rule");
  assert.equal(row.approvedBy, "1");
  // Marked before it is sent too, since the gateway may report it before the response arrives.
  assert.deepEqual(written, ["before POST /channels/{channel}/messages (0 sent)", "POST /channels/{channel}/messages"]);
});

test("a rule's steps outside its allow list, or past its count, are rejected before anything runs", async () => {
  const { planner, calls } = setup();
  const run = (drafts: any[]) => planner.runForRule({ guildId: GUILD, actorId: "1", rule: RULE, drafts });
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
  await assert.rejects(planner.runForRule({ guildId: GUILD, actorId: "3", rule: manage, drafts: [{ op: "PATCH /channels/{channel}", path: { channel: "10" }, body: { topic: "x" } }] }), /依頼者に権限 ManageChannels/);
  assert.equal(calls.length, 0);
});

test("a value from an earlier step is checked against the allow list once it is known", async () => {
  const { planner, calls } = setup();
  const rule = { ...RULE, allow: [{ op: "POST /guilds/{guild}/channels" }, { op: "POST /channels/{channel}/messages", path: { channel: { enum: ["10"] } } }] };
  const done = await planner.runForRule({
    guildId: GUILD, actorId: "1", rule,
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
  const run = (channel: string) => planner.runForRule({ guildId: GUILD, actorId: "1", rule, drafts: [{ op: "DELETE /channels/{channel}", path: { channel } }] });
  await assert.rejects(run("10"), (e: unknown) => e instanceof PlanRejected && /範囲外/.test(e.reasons.join()));
  assert.equal(calls.length, 0);
  assert.equal((await run("60")).status, "succeeded");
  assert.deepEqual(calls.map((c) => `${c.method} ${c.path}`), ["DELETE /channels/60"]);
});

test("a rule's step in a channel its runner cannot see says only that, before the target is read", async () => {
  const { planner, channels } = setup();
  channels["11"].name = "📞 secret";
  const rule = { ...RULE, ownerId: "1", allow: [{ op: "DELETE /channels/{channel}", target: { properties: { name: { pattern: "^📞" } }, required: ["name"] }, maxStepsPerRun: 1 }] };
  const read: string[] = [];
  const get = planner.deps.api.rest.get.bind(planner.deps.api.rest);
  (planner.deps.api.rest as any).get = (path: string, ...rest: unknown[]) => (read.push(path), get(path as never, ...(rest as [])));
  const reasons = async (channel: string) => {
    const e = await planner.runForRule({ guildId: GUILD, actorId: "3", rule, drafts: [{ op: "DELETE /channels/{channel}", path: { channel } }] }).catch((e: unknown) => e);
    assert.ok(e instanceof PlanRejected);
    return e.reasons.map((r) => r.replace(channel, "X"));
  };
  assert.deepEqual(await reasons("11"), await reasons("4242"));
  assert.match((await reasons("11")).join(), /見られるチャンネルではない/);
  assert.deepEqual(read, []);
});

// The dynamic voice channel example: a lobby made by the plan, and two rules that use it.
const LOBBY_RULE = {
  name: "通話部屋を作る",
  trigger: { event: "VOICE_STATE_UPDATE" },
  allow: [
    { op: "POST /guilds/{guild}/channels", body: { type: "object", properties: { name: { type: "string", pattern: "^📞" }, type: { const: 2 } }, required: ["name", "type"], additionalProperties: false }, maxStepsPerRun: 1 },
    { op: "PATCH /guilds/{guild}/members/{user}", body: { type: "object", properties: { channel_id: { type: "string" } }, required: ["channel_id"], additionalProperties: false }, maxStepsPerRun: 1 },
  ],
  program: { kind: "js" as const, code: "if (event.channel_id !== params.lobby) return null; return plan([]);" },
  params: { lobby: { $ref: "steps.s1.result.id" } },
};
const CLEANUP_RULE = {
  name: "空き部屋を消す",
  trigger: { event: "VOICE_STATE_UPDATE", includeBotOrigin: true },
  allow: [{ op: "DELETE /channels/{channel}", target: { properties: { name: { pattern: "^📞" } }, required: ["name"] }, maxStepsPerRun: 1 }],
  program: { kind: "js" as const, code: "return null;" },
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
  assert.deepEqual(dialogButtons(dialog), ["実行", "修正", "取り消し"]);
  await t.planner.handleInteraction(pick(plan, "details", "1"));
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

test("the rules a plan registers are checked against the actor's permissions again at approval, before any step runs", async () => {
  const t = setup();
  withRules(t);
  t.roles[1]!.permissions = String(BigInt(t.roles[1]!.permissions) | P.ManageChannels);
  t.cache.guild!.roles.set(MOD_ROLE, { ...t.cache.guild!.roles.get(MOD_ROLE)!, permissions: BigInt(t.roles[1]!.permissions) });
  const plan = await t.planner.propose({
    guildId: GUILD, channelId: "10", replyToId: null, actorId: "2", shareable: new Set(["10"]), reader, request: "x",
    drafts: [{ op: "POST /channels/{channel}/messages", path: { channel: "10" }, body: { content: "部屋を片付けます" } }],
    rules: [CLEANUP_RULE],
  });
  t.members["2"].roles = [];
  t.cache.guild!.members.set("2", { userId: "2", roleIds: [], bot: false });
  await t.planner.handleInteraction(click(plan, "run", "2"));
  await settle(() => t.store.getPlan(plan.id)!.status === "aborted");
  assert.equal(t.calls.length, 0);
  assert.equal(t.store.listRules(GUILD).length, 0);
  assert.match(t.store.getPlan(plan.id)!.reason!, /ルール「空き部屋を消す」: 許す操作に必要な権限をあなたが持っていません: ManageChannels/);
});

test("a command's plan needs its rule's owner to still hold what the rule allows, even when someone else ran it", async () => {
  const { planner, store, calls, members, roles, cache } = setup();
  roles[1]!.permissions = String(BigInt(roles[1]!.permissions) | P.ManageChannels);
  cache.guild!.roles.set(MOD_ROLE, { ...cache.guild!.roles.get(MOD_ROLE)!, permissions: BigInt(roles[1]!.permissions) });
  const rule = { ...RULE, ownerId: "2", allow: [{ op: "PATCH /channels/{channel}", body: { type: "object", properties: { topic: { type: "string" } }, additionalProperties: false } }] };
  const run = () => planner.runForRule({ guildId: GUILD, actorId: "1", rule, drafts: [{ op: "PATCH /channels/{channel}", path: { channel: "10" }, body: { topic: "x" } }] });
  const first = await run();
  assert.equal(first.status, "succeeded", first.reason ?? "");
  members["2"].roles = [];
  const done = await run();
  assert.equal(done.status, "aborted");
  assert.match(done.reason!, /ルールの作成者が持っていません: ManageChannels/);
  assert.equal(calls.length, 1);
  assert.equal(store.getPlan(done.plan.id)!.plan.rule!.ownerId, "2");
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

test("a new version of a rule lists what changes from the one it replaces", async () => {
  const t = setup();
  const { service } = withRules(t);
  const described: Array<[string, string]> = [];
  service.deps.describeChanges = async (before, after) => (described.push([before, after]), ["空いた部屋を5分待ってから消します"]);
  const base = { guildId: GUILD, channelId: "10", replyToId: null, actorId: "1", shareable: new Set(["10"]), reader, request: "x" };
  const first = await t.planner.propose({ ...base, drafts: [], rules: [CLEANUP_RULE] });
  await t.planner.handleInteraction(click(first, "run", "1"));
  await settle(() => t.store.getPlan(first.id)!.status === "succeeded");
  const old = t.store.listRules(GUILD)[0]!;
  t.store.db.prepare("UPDATE rules SET rule_json = json_set(rule_json, '$.summary', ?) WHERE id = ?").run("前の説明です。", old.id);

  // The same code: only the settings that changed are listed, and no model is asked.
  const plan = await t.planner.propose({ ...base, drafts: [], rules: [{ ...CLEANUP_RULE, replaces: old.id, trigger: { event: "VOICE_STATE_UPDATE" } }] });
  const text = dialogText(renderDialog(plan, { status: "pending_approval" }));
  assert.match(text, /v1 からの変更/);
  assert.match(text, /\n- きっかけ: .* → /);
  assert.doesNotMatch(text, /```|変更前|説明です。/);
  assert.equal(described.length, 0);

  // New code: the changes written from both versions' code, as bullets.
  const code = CLEANUP_RULE.program.code;
  const changed = await t.planner.propose({ ...base, drafts: [], rules: [{ ...CLEANUP_RULE, replaces: old.id, program: { kind: "js" as const, code: `${code}\n// v2` } }] });
  const bullets = dialogText(renderDialog(changed, { status: "pending_approval" }));
  assert.match(bullets, /\n- 空いた部屋を5分待ってから消します/);
  assert.doesNotMatch(bullets, /きっかけ: .* → /);
  assert.deepEqual(described, [[code, `${code}\n// v2`]]);

  // The code section shows the code as a diff against the replaced version.
  const diffed = dialogText(renderDialog(changed, { status: "pending_approval", view: "code" }));
  assert.match(diffed, /コードの変更\(v1 から/);
  assert.match(diffed, /```diff\n[\s\S]*\n\+ \/\/ v2\n```/);
  assert.match(dialogText(renderDialog(plan, { status: "pending_approval", view: "code" })), /コードは変わりません/);

  // A diff too long for the dialog is cut, and the whole comes as files.
  const long = Array.from({ length: 400 }, (_, i) => `log(${i});`).join("\n");
  const big = await t.planner.propose({ ...base, drafts: [], rules: [{ ...CLEANUP_RULE, replaces: old.id, program: { kind: "js" as const, code: `${code}\n${long}` } }] });
  const cut = renderDialog(big, { status: "pending_approval", view: "code" });
  assert.match(dialogText(cut), /…\(続きは「ファイルで受け取る」\)/);
  await t.planner.handleInteraction(pick(big, "files", "2"));
  const files = t.replies.at(-1)!.body.files as Array<{ name: string; data: Buffer }>;
  assert.deepEqual(files.map((f) => f.name), [`plan-${big.id}.json`, "rule-r1.diff", "rule-r1-v1.js", "rule-r1.js"]);
  assert.match(files[1]!.data.toString(), /\+ log\(399\);$/);

  // Without the bullets, what each version does is shown instead.
  service.deps.describeChanges = async () => null;
  const plain = await t.planner.propose({ ...base, drafts: [], rules: [{ ...CLEANUP_RULE, replaces: old.id, program: { kind: "js" as const, code: `${code}\n// v3` } }] });
  assert.match(dialogText(renderDialog(plain, { status: "pending_approval" })), /変更前: 前の説明です。\n変更後: 説明です。/);
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
  const [drafts, code, rules] = proposed[0] as [Array<{ op: string }>, string, Array<{ program: { code: string }; name: string }>];
  assert.equal(drafts[0]!.op, "POST /guilds/{guild}/channels");
  assert.match(code, /vc作成/);
  assert.equal(rules[0]!.program.code, "if (!event.channel_id) return null; return plan([])");
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
  await assert.rejects(planner.runForRule({ guildId: GUILD, actorId: "1", rule, drafts }), /画像 img1 がありません/);
  const done = await planner.runForRule({ guildId: GUILD, actorId: "1", rule, drafts, images: { img1: PNG } });
  assert.equal(done.status, "succeeded");
  assert.equal((calls.at(-1)!.options as { files?: unknown[] }).files!.length, 1);
  // The allow list still decides: a body without files in it refuses them.
  await assert.rejects(planner.runForRule({ guildId: GUILD, actorId: "1", rule: RULE, drafts, images: { img1: PNG } }), /範囲外/);
});

test("emojis and stickers are registered from an image made in the reply, edited and deleted", async () => {
  const { planner, store, calls, replies } = setup();
  const base = { guildId: GUILD, channelId: "10", replyToId: null, actorId: "1", shareable: new Set(["10"]) };
  const emoji = await planner.propose({ ...base, drafts: [{ op: "POST /guilds/{guild}/emojis", body: { name: "party_cat", image: "img1" } }], images: { img1: PNG } });
  assert.match(dialogText(replies.find((r) => r.kind === "createMessage")!.body), /絵文字の登録.*:party_cat:/);
  await planner.handleInteraction(click(emoji, "run", "1"));
  await settle(() => store.getPlan(emoji.id)!.status === "succeeded");
  // The image goes inside the JSON body as a data URI, not as an upload.
  const sent = calls.at(-1)!.options as { body: Record<string, unknown>; files?: unknown };
  assert.equal(calls.at(-1)!.path, `/guilds/${GUILD}/emojis`);
  assert.equal(sent.body.image, `data:image/png;base64,${PNG.data}`);
  assert.equal(sent.files, undefined);

  const sticker = await planner.propose({ ...base, drafts: [{ op: "POST /guilds/{guild}/stickers", body: { name: "ねこ2", description: "", tags: "😺", file: "img1" } }], images: { img1: PNG } });
  await planner.handleInteraction(click(sticker, "run", "1"));
  await settle(() => store.getPlan(sticker.id)!.status === "succeeded");
  // A sticker is a form: its fields go beside the file.
  const form = calls.at(-1)!.options as { body: Record<string, unknown>; files: Array<{ key: string; name: string }>; appendToFormData?: boolean };
  assert.equal(form.appendToFormData, true);
  assert.deepEqual(form.body, { name: "ねこ2", description: "", tags: "😺" });
  assert.deepEqual(form.files.map((f) => [f.key, f.name]), [["file", "formula.png"]]);

  // Editing shows the name it has now, and can be undone; deleting is destructive.
  const edit = await planner.propose({ ...base, drafts: [{ op: "PATCH /guilds/{guild}/emojis/{emoji}", path: { emoji: "700" }, body: { name: "new_cat" } }] });
  assert.match(dialogText(replies.filter((r) => r.kind === "createMessage").at(-1)!.body), /:old_cat:.*name: "old_cat" → "new_cat"/);
  assert.equal(edit.risk, "write");
  const del = await planner.propose({ ...base, drafts: [{ op: "DELETE /guilds/{guild}/stickers/{sticker}", path: { sticker: "800" } }] });
  assert.equal(del.risk, "destructive");
  assert.match(dialogText(replies.filter((r) => r.kind === "createMessage").at(-1)!.body), /スタンプ「ねこ」.*削除/);
});

test("an emoji or sticker names an image that exists, under Discord's field rules", async () => {
  const { planner } = setup();
  const base = { guildId: GUILD, channelId: "10", replyToId: null, actorId: "1", shareable: new Set(["10"]) };
  await assert.rejects(
    planner.propose({ ...base, drafts: [{ op: "POST /guilds/{guild}/emojis", body: { name: "x", image: "img1" } }], images: { img1: PNG } }),
    (e: unknown) => e instanceof PlanRejected && /本文が仕様に合いません/.test(e.message),
  );
  await assert.rejects(
    planner.propose({ ...base, drafts: [{ op: "POST /guilds/{guild}/emojis", body: { name: "nope", image: "img2" } }], images: { img1: PNG } }),
    (e: unknown) => e instanceof PlanRejected && /画像 img2 がありません。.*image に/.test(e.message),
  );
});

test("many stickers can be registered at once from a message's images, past the reply's image limit", async () => {
  const { readTools } = await import("../src/agent/tools.ts");
  const { ImageBox } = await import("../src/agent/attachments.ts");
  const attachments = Array.from({ length: 12 }, (_, i) => ({ url: `https://cdn.discordapp.com/a/${i}.gif`, content_type: "image/gif", size: 10, filename: `${i}.gif` }));
  const fakeReader = { guild: { id: GUILD }, scope: { speakerId: "1", channelId: "10" }, get: async () => ({ id: "900", attachments, embeds: [] }) } as never;
  const fetchFn = (async (url: URL) => new Response(`gif-${url.pathname}`, { headers: { "content-type": "image/gif" } })) as unknown as typeof fetch;
  const box = new ImageBox();
  const proposed: Array<Array<{ body: { file: string } }>> = [];
  const tool = readTools(fakeReader, { images: false, attachments: box, fetch: fetchFn, propose: async (drafts) => (proposed.push(drafts as never), ({ id: "p", steps: [], risk: "write" }) as never) })
    .find((t) => t.name === "propose_plan")!;
  const steps = attachments.map((_, i) => ({ op: "POST /guilds/{guild}/stickers", body: { name: `s${i}`, file: { message_id: "900", index: i } } }));
  await tool.execute("t", { steps });
  // Each attachment becomes an image of the plan, kept as posted (a GIF stays a GIF), and none goes out with the reply.
  assert.deepEqual(proposed[0]!.map((d) => d.body.file), attachments.map((_, i) => `img${i + 1}`));
  assert.match(box.get("img12")!.name, /\.gif$/);
  assert.equal(box.get("img12")!.data.toString(), "gif-/a/11.gif");
  assert.deepEqual(box.forReply(), []);

  // The dialog shows the first ten images and counts the rest; the plan carries all of them.
  const { planner, replies } = setup();
  const plan = await planner.propose({ guildId: GUILD, channelId: "10", replyToId: null, actorId: "1", shareable: new Set(["10"]), drafts: proposed[0]! as never, images: box.all() });
  assert.equal(Object.keys(plan.attachments!).length, 12);
  const dialog = replies.find((r) => r.kind === "createMessage")!.body;
  assert.equal(dialog.files.length, 10);
  assert.ok(JSON.stringify(dialog.components).includes("ほかに画像2枚"));
});

test("plan code can draw the images its steps register; a failed run leaves none", async () => {
  const { readTools } = await import("../src/agent/tools.ts");
  const { ImageBox } = await import("../src/agent/attachments.ts");
  const fakeReader = { guild: { id: GUILD }, scope: { speakerId: "1", channelId: "10" }, get: async () => [] } as never;
  const box = new ImageBox();
  const proposed: Array<Array<{ body: { image: string } }>> = [];
  const tool = readTools(fakeReader, { images: false, attachments: box, propose: async (drafts) => (proposed.push(drafts as never), ({ id: "p", steps: [], risk: "write" }) as never) })
    .find((t) => t.name === "propose_plan")!;
  const draw = (name: string) => `(() => { const c = createCanvas(8, 8); c.getContext("2d").fillRect(0, 0, 8, 8); return attachImage(c, "${name}"); })()`;
  await assert.rejects(tool.execute("t", { code: `${draw("lost")}; throw new Error("x")` }), /x/);
  await tool.execute("t", { code: `return plan(["a", "b"].map((n) => call("POST /guilds/{guild}/emojis", { body: { name: "cat_" + n, image: ${draw("cat")} } })))` });
  assert.deepEqual(proposed[0]!.map((d) => d.body.image), ["img2", "img3"]);
  assert.deepEqual(Object.keys(box.all()), ["img2", "img3"]);
});

test("registering needs Create Expressions; changing or deleting needs Manage Expressions", () => {
  const guild = makeGuild();
  const ctx = (actorId: string) => ({ guild, actorId, selfId: SELF });
  const [create] = normalizeSteps([{ op: "POST /guilds/{guild}/emojis", body: { name: "cat", image: "img1" } }], GUILD, "p");
  const [remove] = normalizeSteps([{ op: "DELETE /guilds/{guild}/emojis/{emoji}", path: { emoji: "700" } }], GUILD, "p");
  assert.match(permissionProblems(create!, ctx("3")).join(), /依頼者に権限 CreateGuildExpressions/);
  guild.roles.set(MOD_ROLE, { id: MOD_ROLE, permissions: P.CreateGuildExpressions, position: 1 });
  assert.deepEqual(permissionProblems(create!, ctx("2")), []);
  assert.match(permissionProblems(remove!, ctx("2")).join(), /依頼者に権限 ManageGuildExpressions/);
  assert.deepEqual(permissionProblems(remove!, ctx("1")), []);
});

const TEX_RULE = {
  name: "数式",
  trigger: { event: "COMMAND", command: { name: "tex", description: "数式を画像にする", options: [{ name: "tex", description: "TeX", type: "string" as const, required: true }] } },
  allow: [],
  program: { kind: "js" as const, code: "reply('ok'); return null;" },
};

test("a command's dialog starts on the judge's pick for who sees replies, and the requester can change it", async () => {
  const t = setup();
  let score: number | null = 0.5;
  withRules(t, async () => score);
  const base = { guildId: GUILD, channelId: "10", replyToId: null, actorId: "1", shareable: new Set(["10"]), reader, request: "/tex を作って", drafts: [] };
  const selectOf = (body: any) => body.components[0].components.find((c: any) => c.type === ComponentType.ActionRow && c.components[0].custom_id?.startsWith("plan:visibility"))?.components[0];
  const chosen = (body: any) => selectOf(body)?.options.find((o: any) => o.default)?.value;

  const plan = await t.planner.propose({ ...base, rules: [TEX_RULE] });
  assert.equal(plan.rules![0]!.trigger.command!.visibility, "auto");
  // The summary says who sees the replies; it is picked in 詳細.
  assert.equal(selectOf(t.replies.at(-1)!.body), undefined);
  assert.match(dialogText(t.replies.at(-1)!.body), /判定用のモデルが決めます/);
  await t.planner.handleInteraction(click(plan, "details", "1"));
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

// --- Sending neighbouring steps in one request ---------------------------------

const ANY = (op: string) => ({ op, maxStepsPerRun: 50 });

test("neighbouring position changes go in one request; other steps are sent alone", async () => {
  const { planner, store, calls } = setup();
  const written: string[] = [];
  planner.deps.onWrite = (_plan, step) => void written.push(String(step.pathParams.channel));
  const rule = { ...RULE, allow: [ANY("PATCH /channels/{channel}")] };
  const done = await planner.runForRule({
    guildId: GUILD, actorId: "1", rule,
    drafts: [
      { op: "PATCH /channels/{channel}", path: { channel: "11" }, body: { position: 0 } },
      { op: "PATCH /channels/{channel}", path: { channel: "10" }, body: { position: 1, parent_id: null } },
      { op: "PATCH /channels/{channel}", path: { channel: "10" }, body: { name: "renamed" } },
    ],
  });
  assert.equal(done.status, "succeeded");
  assert.deepEqual(calls.map((c) => `${c.method} ${c.path}`), [`PATCH /guilds/${GUILD}/channels`, "PATCH /channels/10"]);
  assert.deepEqual(calls[0]!.options!.body, [{ id: "11", position: 0 }, { id: "10", position: 1, parent_id: null }]);
  assert.match(calls[0]!.options!.reason!, /ルール「挨拶」/);
  // Each step is still recorded, and reported as the bot's own write, one by one.
  assert.deepEqual(store.getSteps(done.plan.id).map((s) => s.state), ["done", "done", "done"]);
  assert.deepEqual(written, ["11", "10", "10"]);
});

test("recent deletions in one channel use bulk delete; old ones are deleted one by one", async () => {
  const { planner, now, calls, messages } = setup();
  const recent = (ms: number) => String((BigInt(now.t - ms) - 1420070400000n) << 22n);
  const [a, b] = [recent(60_000), recent(3600_000)];
  const old = recent(15 * 24 * 3600_000);
  for (const id of [a, b, old]) messages[id] = { id, content: "x", author: { username: "alice" } };
  const rule = { ...RULE, allow: [ANY("DELETE /channels/{channel}/messages/{message}")] };
  const done = await planner.runForRule({
    guildId: GUILD, actorId: "1", rule,
    drafts: [a, b, old].map((message) => ({ op: "DELETE /channels/{channel}/messages/{message}", path: { channel: "10", message } })),
  });
  assert.equal(done.status, "succeeded");
  assert.deepEqual(calls.map((c) => `${c.method} ${c.path}`), ["POST /channels/10/messages/bulk-delete", `DELETE /channels/10/messages/${old}`]);
  assert.deepEqual(calls[0]!.options!.body, { messages: [a, b] });
});

test("bans with the same message deletion go in one bulk ban, and a user it could not ban fails that step", async () => {
  const { planner, store, calls, failures } = setup();
  failures.add("ban:2");
  const plan = await planner.propose({
    guildId: GUILD, channelId: "10", replyToId: null, actorId: "1", shareable: new Set(["10"]),
    drafts: [
      { op: "PUT /guilds/{guild}/bans/{user}", path: { user: "3" }, body: {} },
      { op: "PUT /guilds/{guild}/bans/{user}", path: { user: "2" }, body: {} },
      { op: "PUT /guilds/{guild}/bans/{user}", path: { user: "4" }, body: { delete_message_seconds: 3600 } },
    ],
  });
  await planner.handleInteraction(modal(plan, "1", confirmPhrase(plan)));
  await settle(() => store.getPlan(plan.id)!.status === "failed");
  assert.deepEqual(calls.map((c) => `${c.method} ${c.path}`), [`POST /guilds/${GUILD}/bulk-ban`]);
  assert.deepEqual(calls[0]!.options!.body, { user_ids: ["3", "2"], delete_message_seconds: 0 });
  assert.deepEqual(store.getSteps(plan.id).map((s) => s.state), ["done", "failed", "pending"]);
  assert.match(store.getPlan(plan.id)!.reason!, /s2 で失敗: BANできませんでした/);
});

test("a step whose result a later step uses is never merged", () => {
  const steps = normalizeSteps(
    [
      { op: "PATCH /channels/{channel}", path: { channel: "10" }, body: { position: 0 } },
      { op: "PATCH /channels/{channel}", path: { channel: "11" }, body: { position: 1 } },
      { op: "POST /channels/{channel}/messages", path: { channel: { $ref: "steps.s2.result.id" } }, body: { content: "x" } },
    ],
    GUILD,
    "p",
  );
  const referenced = referencedSteps(steps);
  assert.deepEqual([...referenced], ["s2"]);
  assert.notEqual(batchKey(steps[0]!, referenced, 0), null);
  assert.equal(batchKey(steps[1]!, referenced, 0), null);
  assert.equal(batchKey(steps[2]!, referenced, 0), null);
});

function addRoles(t: { roles: any[]; cache: GuildCache }, ...ids: string[]): void {
  for (const id of ids) {
    t.roles.push({ id, name: `r${id}`, permissions: "0", position: 1 });
    t.cache.guild!.roles.set(id, { id, permissions: 0n, position: 1 });
  }
}

test("several role changes of one member become one PATCH with the whole list, read right before", async () => {
  const t = setup();
  const { planner, calls, members } = t;
  addRoles(t, "900", "901");
  members["3"].roles = ["900"];
  const rule = { ...RULE, allow: [ANY("PUT /guilds/{guild}/members/{user}/roles/{role}"), ANY("DELETE /guilds/{guild}/members/{user}/roles/{role}")] };
  const done = await planner.runForRule({
    guildId: GUILD, actorId: "1", rule,
    drafts: [
      { op: "PUT /guilds/{guild}/members/{user}/roles/{role}", path: { user: "3", role: MOD_ROLE } },
      { op: "PUT /guilds/{guild}/members/{user}/roles/{role}", path: { user: "3", role: "901" } },
      { op: "DELETE /guilds/{guild}/members/{user}/roles/{role}", path: { user: "3", role: "900" } },
    ],
  });
  assert.equal(done.status, "succeeded");
  assert.deepEqual(calls.map((c) => `${c.method} ${c.path}`), [`PATCH /guilds/${GUILD}/members/3`]);
  assert.deepEqual(calls[0]!.options!.body, { roles: [MOD_ROLE, "901"] });
});

test("two role changes are sent one by one: reading the list first would not save a request", async () => {
  const t = setup();
  const { planner, calls } = t;
  addRoles(t, "901");
  const rule = { ...RULE, allow: [ANY("PUT /guilds/{guild}/members/{user}/roles/{role}")] };
  await planner.runForRule({
    guildId: GUILD, actorId: "1", rule,
    drafts: [MOD_ROLE, "901"].map((role) => ({ op: "PUT /guilds/{guild}/members/{user}/roles/{role}", path: { user: "3", role } })),
  });
  assert.deepEqual(calls.map((c) => c.method), ["PUT", "PUT"]);
});

test("overwrites of one channel go in one PATCH; changes to one resource are merged in order", async () => {
  const { planner, calls, channels, members } = setup();
  members["11"] = { roles: [], nick: null, user: { id: "11", username: "eleven" } };
  channels["10"].permission_overwrites = [{ id: "3", type: 1, allow: "0", deny: "2048" }];
  const rule = { ...RULE, allow: [ANY("PUT /channels/{channel}/permissions/{overwrite}"), ANY("DELETE /channels/{channel}/permissions/{overwrite}"), ANY("PATCH /channels/{channel}"), ANY("PATCH /guilds/{guild}/members/{user}")] };
  const done = await planner.runForRule({
    guildId: GUILD, actorId: "1", rule,
    drafts: [
      { op: "PUT /channels/{channel}/permissions/{overwrite}", path: { channel: "10", overwrite: MOD_ROLE }, body: { type: 0, allow: "1024" } },
      { op: "PUT /channels/{channel}/permissions/{overwrite}", path: { channel: "10", overwrite: GUILD }, body: { type: 0, deny: "1024" } },
      { op: "DELETE /channels/{channel}/permissions/{overwrite}", path: { channel: "10", overwrite: "3" } },
      { op: "PATCH /channels/{channel}", path: { channel: "11" }, body: { name: "a", topic: "x" } },
      { op: "PATCH /channels/{channel}", path: { channel: "11" }, body: { name: "b" } },
      // Same id as a channel above, but a member: never in the same request.
      { op: "PATCH /guilds/{guild}/members/{user}", path: { user: "11" }, body: { nick: "n" } },
    ],
  });
  assert.equal(done.status, "succeeded");
  assert.deepEqual(calls.map((c) => `${c.method} ${c.path}`), ["PATCH /channels/10", "PATCH /channels/11", `PATCH /guilds/${GUILD}/members/11`]);
  assert.deepEqual(calls[0]!.options!.body, { permission_overwrites: [{ id: MOD_ROLE, type: 0, allow: "1024", deny: "0" }, { id: GUILD, type: 0, allow: "0", deny: "1024" }] });
  assert.deepEqual(calls[1]!.options!.body, { name: "b", topic: "x" });
});

test("lineDiff marks added and removed lines with a little context", async () => {
  const { lineDiff } = await import("../src/plan/diff.ts");
  assert.equal(lineDiff("a\nb", "a\nb"), "");
  assert.equal(lineDiff("1\n2\n3\n4\n5\n6\n7", "1\n2\n3\nX\n5\n6\n7", 1), "  3\n- 4\n+ X\n  5\n…");
  assert.equal(lineDiff("a", "a\nb"), "  a\n+ b");
});
