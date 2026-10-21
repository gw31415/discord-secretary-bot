import { test } from "node:test";
import assert from "node:assert/strict";
import { PermissionFlagsBits as P } from "discord-api-types/v10";
import { ALL_PERMISSIONS, audienceHasGuildPermission, canReadHistory, canView, channelPermissions, shareableChannels, viewersOf } from "../src/discord/permissions.ts";
import { makeGuild, SELF } from "./helpers.ts";

test("owner and administrators get every permission", () => {
  const g = makeGuild();
  assert.equal(channelPermissions(g, g.members.get("1")!, "11"), ALL_PERMISSIONS);
  g.roles.get("200")!.permissions |= P.Administrator;
  assert.equal(channelPermissions(g, g.members.get("2")!, "11"), ALL_PERMISSIONS);
});

test("role overwrites hide and reveal channels", () => {
  const g = makeGuild();
  assert.equal(canView(g, g.members.get("3")!, "11"), false);
  assert.equal(canView(g, g.members.get("2")!, "11"), true);
});

test("member overwrites beat role overwrites", () => {
  const g = makeGuild();
  g.channels.get("11")!.overwrites.push({ id: "2", type: 1, allow: 0n, deny: P.ViewChannel });
  assert.equal(canView(g, g.members.get("2")!, "11"), false);
});

test("threads inherit the parent's permissions", () => {
  const g = makeGuild();
  assert.equal(canReadHistory(g, g.members.get("3")!, "13"), true);
});

test("viewing without history does not count as readable", () => {
  const g = makeGuild();
  assert.equal(canView(g, g.members.get("3")!, "12"), true);
  assert.equal(canReadHistory(g, g.members.get("3")!, "12"), false);
});

test("viewers exclude the bot itself", () => {
  const g = makeGuild();
  assert.deepEqual(viewersOf(g, "11", SELF).map((m) => m.userId).sort(), ["1", "2"]);
});

test("a reply in a public channel cannot use the staff channel even for a moderator", () => {
  const g = makeGuild();
  const shareable = shareableChannels(g, "10", g.members.get("2")!, SELF);
  assert.ok(shareable.has("10"));
  assert.ok(shareable.has("13"));
  assert.ok(!shareable.has("11"), "staff would leak to regular members");
  assert.ok(!shareable.has("12"), "readonly history is not readable by everyone");
  assert.ok(!shareable.has("14"), "private threads are excluded");
});

test("a reply inside the staff channel may use staff and public channels", () => {
  const g = makeGuild();
  const shareable = shareableChannels(g, "11", g.members.get("2")!, SELF);
  assert.ok(shareable.has("11"));
  assert.ok(shareable.has("10"));
});

test("the speaker's own permissions still limit what is shareable", () => {
  const g = makeGuild();
  // Regular member speaking in general cannot pull staff in, and staff is not visible to them anyway.
  assert.ok(!shareableChannels(g, "10", g.members.get("3")!, SELF).has("11"));
});

test("guild permissions must be held by the whole audience", () => {
  const g = makeGuild();
  assert.equal(audienceHasGuildPermission(g, "10", g.members.get("2")!, SELF, P.ViewAuditLog), false);
  assert.equal(audienceHasGuildPermission(g, "11", g.members.get("2")!, SELF, P.ViewAuditLog), true);
});
