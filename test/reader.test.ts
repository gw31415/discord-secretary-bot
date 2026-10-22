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
