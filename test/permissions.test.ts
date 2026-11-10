import { test } from "node:test";
import assert from "node:assert/strict";
import { ChannelType, OverwriteType, PermissionFlagsBits as P } from "discord-api-types/v10";
import { ALL_PERMISSIONS, audienceHasGuildPermission, canReadHistory, canView, channelPermissions, shareableChannels, viewersOf } from "../src/discord/permissions.ts";
import type { ChannelState, GuildState, MemberState, OverwriteState, RoleState } from "../src/discord/permissions.ts";
import { BOT_ROLE, makeGuild, SELF } from "./helpers.ts";

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

test("without Administrator the bot's own permissions narrow what is shareable", () => {
  const g = makeGuild();
  // A server that gives the bot only @everyone-level access: it cannot see the staff channel.
  g.roles.get(BOT_ROLE)!.permissions = 0n;
  const shareable = shareableChannels(g, "11", g.members.get("2")!, SELF);
  assert.ok(shareable.has("10"), "general is readable by the bot through @everyone");
  assert.ok(!shareable.has("12"), "nobody, the bot included, can read readonly's history");
  // Letting the bot read staff through a member overwrite brings it back.
  g.channels.get("11")!.overwrites.push({ id: SELF, type: OverwriteType.Member, allow: P.ViewChannel | P.ReadMessageHistory, deny: 0n });
  assert.ok(shareableChannels(g, "11", g.members.get("2")!, SELF).has("11"));
});

test("without the permission itself the bot cannot read guild-level data even for an entitled audience", () => {
  const g = makeGuild();
  g.roles.get(BOT_ROLE)!.permissions = 0n;
  assert.equal(audienceHasGuildPermission(g, "11", g.members.get("2")!, SELF, P.ViewAuditLog), false);
  g.roles.get(BOT_ROLE)!.permissions = P.ViewAuditLog;
  assert.equal(audienceHasGuildPermission(g, "11", g.members.get("2")!, SELF, P.ViewAuditLog), true);
});

test("before the bot's own member is cached, nothing outside the current channel is shared", () => {
  const g = makeGuild();
  g.members.delete(SELF);
  assert.deepEqual([...shareableChannels(g, "11", g.members.get("2")!, SELF)], ["11"]);
});

// The per-viewer computation shareableChannels did before it grouped viewers by role set,
// kept as the reference the grouped one must agree with.
const reference = (() => {
  const THREADS = new Set<number>([ChannelType.PublicThread, ChannelType.PrivateThread, ChannelType.AnnouncementThread]);
  const base = (guild: GuildState, member: MemberState): bigint => {
    if (member.userId === guild.ownerId) return ALL_PERMISSIONS;
    let perms = guild.roles.get(guild.id)?.permissions ?? 0n;
    for (const roleId of member.roleIds) perms |= guild.roles.get(roleId)?.permissions ?? 0n;
    if ((perms & P.Administrator) !== 0n) return ALL_PERMISSIONS;
    return perms;
  };
  const apply = (guild: GuildState, member: MemberState, channel: ChannelState, perms: bigint): bigint => {
    const byId = new Map(channel.overwrites.map((o) => [o.id, o]));
    const everyone = byId.get(guild.id);
    if (everyone) perms = (perms & ~everyone.deny) | everyone.allow;
    let allow = 0n;
    let deny = 0n;
    for (const roleId of member.roleIds) {
      const o = byId.get(roleId);
      if (o && o.type === OverwriteType.Role) {
        allow |= o.allow;
        deny |= o.deny;
      }
    }
    perms = (perms & ~deny) | allow;
    const own = byId.get(member.userId);
    if (own && own.type === OverwriteType.Member) perms = (perms & ~own.deny) | own.allow;
    return perms;
  };
  const permissions = (guild: GuildState, member: MemberState, channelId: string): bigint => {
    const b = base(guild, member);
    if (b === ALL_PERMISSIONS) return ALL_PERMISSIONS;
    let channel = guild.channels.get(channelId);
    if (channel && THREADS.has(channel.type) && channel.parentId) channel = guild.channels.get(channel.parentId);
    if (!channel) return 0n;
    return apply(guild, member, channel, b);
  };
  const can = (perms: bigint, ...bits: bigint[]) => bits.every((bit) => (perms & bit) === bit);
  const readsHistory = (guild: GuildState, member: MemberState, channelId: string) => can(permissions(guild, member, channelId), P.ViewChannel, P.ReadMessageHistory);
  const shareable = (guild: GuildState, currentChannelId: string, speaker: MemberState, selfId: string): Set<string> => {
    const audience = [...guild.members.values()].filter((m) => m.userId !== selfId && can(permissions(guild, m, currentChannelId), P.ViewChannel));
    const bot = guild.members.get(selfId);
    const result = new Set<string>([currentChannelId]);
    if (!bot) return result;
    for (const channel of guild.channels.values()) {
      if (channel.id === currentChannelId) continue;
      if (channel.type === ChannelType.PrivateThread) continue;
      if (!readsHistory(guild, bot, channel.id)) continue;
      if (!readsHistory(guild, speaker, channel.id)) continue;
      if (audience.every((m) => readsHistory(guild, m, channel.id))) result.add(channel.id);
    }
    return result;
  };
  return { permissions, shareable };
})();

test("shareableChannels and channelPermissions agree with the per-viewer computation on random servers", () => {
  // A fixed pseudo-random sequence, so a failing case can be replayed from its number.
  let seed = 1;
  const random = (n: number) => ((seed = (seed * 1103515245 + 12345) % 2147483648), Math.floor(seed / 65536) % n);
  const chance = (p: number) => random(1000) < p * 1000;
  const BITS = [P.ViewChannel, P.ReadMessageHistory, P.ManageThreads, P.SendMessages, P.Administrator];
  const bits = (administrator: number) => BITS.reduce((acc, bit) => (bit === P.Administrator ? (chance(administrator) ? acc | bit : acc) : chance(0.5) ? acc | bit : acc), 0n);
  let shared = 0;
  for (let n = 0; n < 400; n++) {
    seed = n + 1;
    const guildId = "g";
    const roles = new Map<string, RoleState>();
    if (!chance(0.1)) roles.set(guildId, { id: guildId, permissions: bits(0.03), position: 0 });
    const roleIds = Array.from({ length: 1 + random(6) }, (_, i) => `r${i}`);
    for (const [i, id] of roleIds.entries()) roles.set(id, { id, permissions: bits(0.05), position: i + 1 });
    const members = new Map<string, MemberState>();
    const memberCount = 1 + random(25);
    for (let i = 0; i < memberCount; i++) {
      const id = `m${i}`;
      // Few roles each, so many viewers share a role set; sometimes a role that no longer exists, or one twice.
      const own = roleIds.filter(() => chance(0.25));
      if (chance(0.05)) own.push("gone");
      if (own.length && chance(0.05)) own.push(own[0]!);
      members.set(id, { userId: id, roleIds: own, bot: false });
    }
    const selfId = "self";
    if (!chance(0.05)) members.set(selfId, { userId: selfId, roleIds: roleIds.filter(() => chance(0.3)), bot: true });
    const ownerId = chance(0.3) ? `m${random(memberCount)}` : "absent-owner";
    const overwrites = (): OverwriteState[] => {
      const list: OverwriteState[] = [];
      if (chance(0.5)) list.push({ id: guildId, type: OverwriteType.Role, allow: chance(0.3) ? bits(0) : 0n, deny: chance(0.6) ? bits(0) : 0n });
      for (const id of roleIds) if (chance(0.3)) list.push({ id, type: OverwriteType.Role, allow: bits(0), deny: bits(0) });
      for (let i = 0; i < memberCount; i++) if (chance(0.08)) list.push({ id: `m${i}`, type: OverwriteType.Member, allow: bits(0), deny: bits(0) });
      if (chance(0.05)) list.push({ id: selfId, type: OverwriteType.Member, allow: bits(0), deny: bits(0) });
      if (chance(0.05)) list.push({ id: ownerId, type: OverwriteType.Member, allow: 0n, deny: bits(0) });
      return list;
    };
    const channels = new Map<string, ChannelState>();
    const categories = Array.from({ length: random(3) }, (_, i) => `cat${i}`);
    for (const id of categories) channels.set(id, { id, type: ChannelType.GuildCategory, name: id, parentId: null, overwrites: overwrites() });
    const texts = Array.from({ length: 1 + random(10) }, (_, i) => `c${i}`);
    for (const id of texts) {
      const parentId = categories.length && chance(0.6) ? categories[random(categories.length)]! : null;
      channels.set(id, { id, type: chance(0.2) ? ChannelType.GuildVoice : ChannelType.GuildText, name: id, parentId, overwrites: overwrites() });
    }
    const threadTypes = [ChannelType.PublicThread, ChannelType.PrivateThread, ChannelType.AnnouncementThread];
    for (let i = 0; i < random(5); i++) {
      const id = `t${i}`;
      const parentId = chance(0.1) ? "missing-parent" : texts[random(texts.length)]!;
      // A thread's own overwrites are ignored in favour of its parent's.
      channels.set(id, { id, type: threadTypes[random(3)]!, name: id, parentId, overwrites: chance(0.2) ? overwrites() : [] });
    }
    const guild: GuildState = { id: guildId, ownerId, roles, channels, members };
    const channelIds = [...channels.keys(), "no-such-channel"];
    for (const member of members.values()) {
      for (const channelId of channelIds) assert.equal(channelPermissions(guild, member, channelId), reference.permissions(guild, member, channelId), `case ${n}: ${member.userId} in ${channelId}`);
    }
    const people = [...members.values()];
    for (let k = 0; k < 4; k++) {
      const current = channelIds[random(channelIds.length)]!;
      const speaker = people[random(people.length)]!;
      const expected = reference.shareable(guild, current, speaker, selfId);
      assert.deepEqual([...shareableChannels(guild, current, speaker, selfId)].sort(), [...expected].sort(), `case ${n}: ${speaker.userId} in ${current}`);
      shared += expected.size - 1;
    }
  }
  assert.ok(shared > 200, `the cases share channels often enough to mean something (${shared})`);
});
