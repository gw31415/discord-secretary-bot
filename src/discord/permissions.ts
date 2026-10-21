import { ChannelType, OverwriteType, PermissionFlagsBits } from "discord-api-types/v10";

// Deterministic re-implementation of Discord's permission computation.
// https://docs.discord.com/developers/topics/permissions#permission-overwrites

export interface RoleState {
  id: string;
  permissions: bigint;
  position: number;
}

export interface OverwriteState {
  id: string;
  type: OverwriteType;
  allow: bigint;
  deny: bigint;
}

export interface ChannelState {
  id: string;
  type: ChannelType;
  name: string;
  parentId: string | null;
  overwrites: OverwriteState[];
}

export interface MemberState {
  userId: string;
  roleIds: string[];
  bot: boolean;
}

export interface GuildState {
  id: string;
  ownerId: string;
  roles: Map<string, RoleState>;
  channels: Map<string, ChannelState>;
  members: Map<string, MemberState>;
}

export const ALL_PERMISSIONS = Object.values(PermissionFlagsBits).reduce((acc, bit) => acc | bit, 0n);

const THREAD_TYPES = new Set<ChannelType>([
  ChannelType.PublicThread,
  ChannelType.PrivateThread,
  ChannelType.AnnouncementThread,
]);

export function isThread(channel: ChannelState): boolean {
  return THREAD_TYPES.has(channel.type);
}

export function basePermissions(guild: GuildState, member: MemberState): bigint {
  if (member.userId === guild.ownerId) return ALL_PERMISSIONS;
  let perms = guild.roles.get(guild.id)?.permissions ?? 0n; // @everyone shares the guild id
  for (const roleId of member.roleIds) perms |= guild.roles.get(roleId)?.permissions ?? 0n;
  if ((perms & PermissionFlagsBits.Administrator) !== 0n) return ALL_PERMISSIONS;
  return perms;
}

function applyOverwrites(guild: GuildState, member: MemberState, channel: ChannelState, base: bigint): bigint {
  let perms = base;
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
}

/** Effective permissions of `member` in `channelId`. Threads use their parent's overwrites. */
export function channelPermissions(guild: GuildState, member: MemberState, channelId: string): bigint {
  const base = basePermissions(guild, member);
  if (base === ALL_PERMISSIONS) return ALL_PERMISSIONS;
  let channel = guild.channels.get(channelId);
  if (channel && isThread(channel) && channel.parentId) channel = guild.channels.get(channel.parentId);
  if (!channel) return 0n;
  return applyOverwrites(guild, member, channel, base);
}

export function has(perms: bigint, ...bits: bigint[]): boolean {
  return bits.every((bit) => (perms & bit) === bit);
}

export function canView(guild: GuildState, member: MemberState, channelId: string): boolean {
  return has(channelPermissions(guild, member, channelId), PermissionFlagsBits.ViewChannel);
}

export function canReadHistory(guild: GuildState, member: MemberState, channelId: string): boolean {
  return has(
    channelPermissions(guild, member, channelId),
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.ReadMessageHistory,
  );
}

/**
 * Members who can see `channelId`. The bot itself is excluded because it can see
 * everything and never leaks to itself.
 */
export function viewersOf(guild: GuildState, channelId: string, selfId: string): MemberState[] {
  return [...guild.members.values()].filter((m) => m.userId !== selfId && canView(guild, m, channelId));
}

/**
 * Channels whose contents may appear in a reply posted in `currentChannelId`:
 * the speaker can read their history, and everyone who can see the current
 * channel can also read them. Private threads are only allowed when they are the
 * current channel, because their membership is not tracked.
 */
export function shareableChannels(
  guild: GuildState,
  currentChannelId: string,
  speaker: MemberState,
  selfId: string,
): Set<string> {
  const audience = viewersOf(guild, currentChannelId, selfId);
  const result = new Set<string>([currentChannelId]);
  for (const channel of guild.channels.values()) {
    if (channel.id === currentChannelId) continue;
    if (channel.type === ChannelType.PrivateThread) continue;
    if (!canReadHistory(guild, speaker, channel.id)) continue;
    if (audience.every((m) => canReadHistory(guild, m, channel.id))) result.add(channel.id);
  }
  return result;
}

/** True when the speaker and every viewer of the current channel hold all `bits` guild-wide. */
export function audienceHasGuildPermission(
  guild: GuildState,
  currentChannelId: string,
  speaker: MemberState,
  selfId: string,
  bits: bigint,
): boolean {
  const people = [speaker, ...viewersOf(guild, currentChannelId, selfId)];
  return people.every((m) => has(basePermissions(guild, m), bits));
}
