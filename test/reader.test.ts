import { test } from "node:test";
import assert from "node:assert/strict";
import type { REST } from "@discordjs/rest";
import { GuildCache } from "../src/discord/cache.ts";
import { Reader } from "../src/discord/reader.ts";
import { GUILD, makeGuild, SELF } from "./helpers.ts";

function fakeRest(responses: Record<string, unknown>) {
  const calls: Array<{ path: string; query: URLSearchParams | undefined }> = [];
  const rest = {
    get: async (path: string, opts?: { query?: URLSearchParams }) => {
      calls.push({ path, query: opts?.query });
      if (!(path in responses)) throw new Error(`unexpected ${path}`);
      return responses[path];
    },
  } as unknown as REST;
  return { rest, calls };
}

function makeReader(rest: REST, channelId: string, speakerId: string) {
  const cache = new GuildCache(GUILD);
  cache.guild = makeGuild();
  return new Reader(rest, cache, SELF, { guildId: GUILD, channelId, speakerId }, { maxMessages: 150 });
}

const msg = (id: string, channel: string) => ({
  id, channel_id: channel, content: "x", timestamp: "2026-10-21T00:00:00Z",
  author: { id: "3", username: "u" }, attachments: [], embeds: [], mentions: [],
});

test("unknown routes are refused", async () => {
  const { rest } = fakeRest({});
  const reader = makeReader(rest, "10", "2");
  await assert.rejects(reader.get(`/guilds/${GUILD}/webhooks`), /許可されていない経路/);
  await assert.rejects(reader.get(`/users/@me`), /許可されていない経路/);
});

test("channel reads outside the shareable set are refused before calling Discord", async () => {
  const { rest, calls } = fakeRest({});
  const reader = makeReader(rest, "10", "2");
  await assert.rejects(reader.get("/channels/11/messages"), /この場所では扱えません/);
  assert.equal(calls.length, 0);
});

test("the same moderator can read staff history from inside the staff channel", async () => {
  const { rest } = fakeRest({ "/channels/11/messages": [msg("1", "11")] });
  const reader = makeReader(rest, "11", "2");
  assert.equal(((await reader.get("/channels/11/messages")) as unknown[]).length, 1);
});

test("search is restricted to shareable channels and filters results again", async () => {
  const { rest, calls } = fakeRest({
    [`/guilds/${GUILD}/messages/search`]: {
      doing_deep_historical_index: false, total_results: 2,
      messages: [[msg("1", "10")], [msg("2", "11")]], threads: [],
    },
  });
  const reader = makeReader(rest, "10", "2");
  const res = (await reader.get(`/guilds/${GUILD}/messages/search`, { content: "x", channel_id: ["10", "11"] })) as { messages: unknown[][] };
  assert.deepEqual(calls[0]!.query!.getAll("channel_id"), ["10"]);
  assert.equal(res.messages.length, 1);
});

test("guild routes that need a permission require it from the whole audience", async () => {
  const { rest } = fakeRest({ [`/guilds/${GUILD}/audit-logs`]: { audit_log_entries: [] } });
  await assert.rejects(makeReader(rest, "10", "2").get(`/guilds/${GUILD}/audit-logs`), /必要な権限/);
  assert.deepEqual(await makeReader(rest, "11", "2").get(`/guilds/${GUILD}/audit-logs`), { audit_log_entries: [] });
});

test("channel lists only include shareable channels", async () => {
  const { rest } = fakeRest({
    [`/guilds/${GUILD}/channels`]: [{ id: "10" }, { id: "11" }, { id: "12" }],
  });
  const res = (await makeReader(rest, "10", "3").get(`/guilds/${GUILD}/channels`)) as Array<{ id: string }>;
  assert.deepEqual(res.map((c) => c.id), ["10"]);
});

test("other guilds are refused", async () => {
  const { rest } = fakeRest({});
  await assert.rejects(makeReader(rest, "10", "3").get(`/guilds/555/roles`), /このサーバー以外/);
});

test("the per-reply message budget is enforced", async () => {
  const page = Array.from({ length: 100 }, (_, i) => msg(String(i), "10"));
  const { rest } = fakeRest({ "/channels/10/messages": page });
  const reader = makeReader(rest, "10", "3");
  await reader.messages("10", { limit: 100 });
  await assert.rejects(reader.messages("10", { limit: 100 }), /150件まで/);
});

test("archived public threads under a shareable channel become readable", async () => {
  const { rest } = fakeRest({
    "/channels/77": { id: "77", type: 11, name: "old", parent_id: "10", guild_id: GUILD },
    "/channels/77/messages": [msg("1", "77")],
  });
  const reader = makeReader(rest, "10", "3");
  assert.equal(((await reader.get("/channels/77/messages")) as unknown[]).length, 1);
});

test("a thread from another server is refused even if its parent id looks shareable", async () => {
  const { rest } = fakeRest({
    "/channels/78": { id: "78", type: 11, name: "elsewhere", parent_id: "10", guild_id: "555" },
    "/channels/78/messages": [msg("1", "78")],
  });
  await assert.rejects(makeReader(rest, "10", "3").get("/channels/78/messages"), /この場所では扱えません/);
});

test("voice states come from the Gateway, narrowed to channels this reply may show", async () => {
  const { rest, calls } = fakeRest({});
  const reader = makeReader(rest, "10", "3");
  reader.cache.setVoice("3", "10");
  reader.cache.setVoice("2", "11"); // staff: hidden from regular members
  assert.equal(reader.cache.setVoice("2", "11"), "11");
  assert.deepEqual(await reader.get(`/guilds/${GUILD}/voice-states`), [{ user_id: "3", channel_id: "10" }]);
  assert.deepEqual(await reader.get(`/guilds/${GUILD}/voice-states`, { channel_id: "11" }), []);
  assert.equal(reader.cache.setVoice("3", null), "10");
  assert.deepEqual(await reader.get(`/guilds/${GUILD}/voice-states`), []);
  assert.equal(calls.length, 0);
});

test("channels and roles come from the Gateway cache once it is loaded, and repeated reads are fetched once", async () => {
  const { rest, calls } = fakeRest({ [`/guilds/${GUILD}/members/3`]: { user: { id: "3" } } });
  const cache = new GuildCache(GUILD);
  cache.loadGuild({
    id: GUILD, owner_id: "1", members: [], threads: [], voice_states: [],
    roles: [{ id: GUILD, name: "@everyone", permissions: String(1024 | 65536 | 2048), position: 0 }],
    channels: [{ id: "10", type: 0, name: "general", permission_overwrites: [] }, { id: "11", type: 0, name: "staff", permission_overwrites: [{ id: GUILD, type: 0, allow: "0", deny: "1024" }] }],
  } as never);
  cache.upsertMember({ roles: [], user: { id: "3" } });
  cache.upsertMember({ roles: [], user: { id: SELF, bot: true } });
  cache.upsertChannel({ id: "12", type: 2, name: "📞", guild_id: GUILD, permission_overwrites: [] } as never);
  const reader = new Reader(rest, cache, SELF, { guildId: GUILD, channelId: "10", speakerId: "3" }, { maxMessages: 150 });
  const channels = (await reader.get(`/guilds/${GUILD}/channels`)) as Array<{ id: string }>;
  assert.deepEqual(channels.map((c) => c.id).sort(), ["10", "12"]); // staff is hidden
  assert.equal(((await reader.get(`/channels/12`)) as { name: string }).name, "📞");
  assert.equal(((await reader.get(`/guilds/${GUILD}/roles`)) as unknown[]).length, 1);
  await reader.get(`/guilds/${GUILD}/members/3`);
  await reader.get(`/guilds/${GUILD}/members/3`);
  assert.deepEqual(calls.map((c) => c.path), [`/guilds/${GUILD}/members/3`]);
});

test("the bot's own writes reach the cache before their Gateway events do", async () => {
  const cache = new GuildCache(GUILD);
  cache.loadGuild({ id: GUILD, owner_id: "1", members: [], threads: [], voice_states: [], roles: [], channels: [] } as never);
  cache.applyWrite("POST /guilds/{guild}/channels", { guild: GUILD }, { id: "70", type: 2, name: "📞", guild_id: GUILD, permission_overwrites: [] });
  assert.equal(cache.raw!.channels.get("70")!.name, "📞");
  assert.equal(cache.guild!.channels.get("70")!.name, "📞");
  cache.applyWrite("DELETE /channels/{channel}", { channel: "70" }, undefined);
  assert.equal(cache.raw!.channels.has("70"), false);
  assert.equal(cache.guild!.channels.has("70"), false);
});

test("hostile routes never reach Discord, and Discord is only ever asked to GET allowlisted shapes", async () => {
  // A REST client with only `get`: any other method would throw.
  const calls: string[] = [];
  const rest = { get: async (path: string) => (calls.push(path), []) } as unknown as REST;
  const reader = makeReader(rest, "10", "2");
  const hostile = [
    `/guilds/${GUILD}/webhooks`, `/guilds/${GUILD}/roles/../webhooks`, `/guilds/${GUILD}/roles/`, `/guilds/${GUILD}/roles?x=1/../../webhooks`,
    `/guilds/${GUILD}/roles%2F..%2Fwebhooks`, `/guilds/${GUILD}//roles`, `//evil.example/guilds/${GUILD}/roles`, `https://evil.example/guilds/${GUILD}/roles`,
    ` /guilds/${GUILD}/roles`, `/guilds/${GUILD}/roles\n/x`, `/guilds/${GUILD}/roles\n`, `/guilds/${GUILD}/roles#/webhooks`, `/Guilds/${GUILD}/roles`,
    `/guilds/１２３/roles`, `/guilds/${GUILD}/roles\u0000`, `/users/@me`, `/users/@me/guilds`, `/applications/1/commands`, `/gateway/bot`,
    `/channels/10/webhooks`, `/channels/10/invites`, `/channels/10/messages/1/reactions/..`, `/channels/10/messages/1/reactions/%2E%2E`, `/channels/11/messages/1/reactions/x`, `/guilds/999/roles`, `/guilds/${GUILD}/members/2/../../bans`,
    `POST /guilds/${GUILD}/roles`, `DELETE /channels/10`, `/channels/11/messages`, `/channels/10/messages/../../11/messages`, "", "/",
  ];
  for (const route of hostile) await assert.rejects(reader.get(route), Error, `not refused: ${JSON.stringify(route)}`);
  // Queries cannot change the path or method either.
  await reader.get(`/guilds/${GUILD}/members`, { "../webhooks": "1", limit: "1&x=/../webhooks" } as never);
  // Reactions: the emoji is one encoded path segment however it is written.
  await reader.get(`/channels/10/messages/1/reactions/👍`);
  await reader.get(`/channels/10/messages/1/reactions/%F0%9F%91%8D`);
  const SHAPES = [/^\/guilds\/\d+\/members$/, /^\/channels\/10\/messages\/1\/reactions\/%F0%9F%91%8D$/];
  for (const path of calls) assert.ok(SHAPES.some((p) => p.test(path)), `unexpected call ${path}`);
  assert.equal(calls.length, 2); // the two spellings of 👍 are one fetch
});

test("sandboxed code has no way out besides discord.get", async () => {
  const { runSandboxed, SANDBOX_LIMITS } = await import("../src/sandbox.ts");
  const routes: string[] = [];
  const bindings = { guildId: GUILD, actor: { kind: "user" as const, userId: "2" }, get: async (route: string) => (routes.push(route), null) };
  const probe = await runSandboxed(
    `return ["fetch","require","process","std","os","XMLHttpRequest","WebSocket","setTimeout","Deno","Bun","module","global"].filter((n) => typeof globalThis[n] !== "undefined")`,
    bindings, SANDBOX_LIMITS,
  );
  assert.deepEqual(probe.value, []);
  for (const code of [`return import("os")`, `return new Function("return this")().process.exit()`, `return (function(){ return this })().require("fs")`]) {
    const r = await runSandboxed(code, bindings, SANDBOX_LIMITS);
    // Either it fails, or it yields nothing from the host.
    assert.ok(!r.ok || r.value === undefined || JSON.stringify(r.value) === "{}", `escaped: ${code} → ${JSON.stringify(r)}`);
  }
  assert.deepEqual(routes, []);
});

test("widening lets a reply read what the speaker can, and the refusal says how to ask", async () => {
  const { rest } = fakeRest({ "/channels/11/messages": [msg("1", "11")], [`/guilds/${GUILD}/audit-logs`]: { audit_log_entries: [] } });
  const reader = makeReader(rest, "10", "2");
  assert.equal(reader.narrowed, true);
  await assert.rejects(reader.get("/channels/11/messages"), /widen_read/);
  await assert.rejects(reader.get(`/guilds/${GUILD}/audit-logs`), /widen_read/);
  reader.widen();
  assert.equal(reader.narrowed, false);
  assert.equal(((await reader.get("/channels/11/messages")) as unknown[]).length, 1);
  assert.deepEqual(await reader.get(`/guilds/${GUILD}/audit-logs`), { audit_log_entries: [] });
  assert.ok(reader.shareable().has("11"));
});

test("widening never goes past the speaker's own permissions", async () => {
  const { rest } = fakeRest({});
  const reader = makeReader(rest, "10", "3");
  reader.widen();
  await assert.rejects(reader.get("/channels/11/messages"), (e: Error) => /この場所では扱えません/.test(e.message) && !/widen_read/.test(e.message));
  await assert.rejects(reader.get(`/guilds/${GUILD}/audit-logs`), /必要な権限/);
});
