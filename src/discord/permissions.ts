import { ChannelType, OverwriteType, PermissionFlagsBits } from "discord-api-types/v10";

// Deterministic re-implementation of Discord's permission computation.
// https://docs.discord.com/developers/topics/permissions#permission-overwrites

export interface RoleState {
  id: string;
  permissions: bigint;
  position: number;
  /** For display only. */
  name?: string;
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

type OverwriteIndex = Map<string, OverwriteState>;

function overwriteIndex(channel: ChannelState): OverwriteIndex {
  return new Map(channel.overwrites.map((o) => [o.id, o]));
}

function applyOverwrites(guild: GuildState, member: MemberState, byId: OverwriteIndex, base: bigint): bigint {
  let perms = base;

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

/** The channel whose overwrites decide `channelId`: a thread's parent, or the channel itself. */
function overwritesHolder(guild: GuildState, channelId: string): ChannelState | undefined {
  const channel = guild.channels.get(channelId);
  if (channel && isThread(channel) && channel.parentId) return guild.channels.get(channel.parentId);
  return channel;
}

/** Effective permissions of `member` in `channelId`. Threads use their parent's overwrites. */
export function channelPermissions(guild: GuildState, member: MemberState, channelId: string): bigint {
  const base = basePermissions(guild, member);
  if (base === ALL_PERMISSIONS) return ALL_PERMISSIONS;
  const channel = overwritesHolder(guild, channelId);
  if (!channel) return 0n;
  return applyOverwrites(guild, member, overwriteIndex(channel), base);
}

export function has(perms: bigint, ...bits: bigint[]): boolean {
  return bits.every((bit) => (perms & bit) === bit);
}

export function canView(guild: GuildState, member: MemberState, channelId: string): boolean {
  return has(channelPermissions(guild, member, channelId), PermissionFlagsBits.ViewChannel);
}

/**
 * True when seeing `channelId` also takes being one of its members: a private
 * thread, for someone without Manage Threads there (Discord shows private
 * threads only to their members and to those who manage threads). Channel
 * permissions alone cannot tell, because a thread takes its parent's.
 */
export function needsThreadMembership(guild: GuildState, member: MemberState, channelId: string): boolean {
  if (guild.channels.get(channelId)?.type !== ChannelType.PrivateThread) return false;
  return !has(channelPermissions(guild, member, channelId), PermissionFlagsBits.ManageThreads);
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
 * The bot itself, from the cache. Without Administrator it reads only what its
 * roles allow, so every check below also requires the bot to hold the permission.
 * Unknown (not cached yet) means no access.
 */
function self(guild: GuildState, selfId: string): MemberState | undefined {
  return guild.members.get(selfId);
}

/**
 * Channels whose contents may appear in a reply posted in `currentChannelId`:
 * the bot and the speaker can read their history, and everyone who can see the
 * current channel can also read them. Private threads are only allowed when they are the
 * current channel, because their membership is not tracked.
 */
export function shareableChannels(
  guild: GuildState,
  currentChannelId: string,
  speaker: MemberState,
  selfId: string,
): Set<string> {
  const audience = viewersOf(guild, currentChannelId, selfId);
  const bot = self(guild, selfId);
  const result = new Set<string>([currentChannelId]);
  if (!bot) return result;
  // Permissions follow from being the owner, the set of roles and a member's own overwrite
  // in the channel. So the audience is checked once per role set, and anyone with their
  // own overwrite in a channel (or the owner) is checked as themselves there.
  const groups = new Map<string, { members: MemberState[]; base: bigint }>();
  const byUser = new Map<string, { member: MemberState; base: bigint }>();
  for (const member of audience) {
    const key = member.userId === guild.ownerId ? `owner:${member.userId}` : [...new Set(member.roleIds)].sort().join(",");
    let group = groups.get(key);
    if (!group) groups.set(key, (group = { members: [], base: basePermissions(guild, member) }));
    group.members.push(member);
    byUser.set(member.userId, { member, base: group.base });
  }
  const reads = (member: MemberState, base: bigint, holder: ChannelState | undefined, byId: OverwriteIndex | undefined) =>
    has(base === ALL_PERMISSIONS ? ALL_PERMISSIONS : holder ? applyOverwrites(guild, member, byId!, base) : 0n, PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory);
  const botBase = basePermissions(guild, bot);
  const speakerBase = basePermissions(guild, speaker);
  for (const channel of guild.channels.values()) {
    if (channel.id === currentChannelId) continue;
    if (channel.type === ChannelType.PrivateThread) continue;
    const holder = overwritesHolder(guild, channel.id);
    const byId = holder ? overwriteIndex(holder) : undefined;
    if (!reads(bot, botBase, holder, byId)) continue;
    if (!reads(speaker, speakerBase, holder, byId)) continue;
    const own = new Set<string>();
    for (const id of byId?.keys() ?? []) if (byUser.has(id)) own.add(id);
    let everyone = true;
    for (const id of own) {
      const viewer = byUser.get(id)!;
      if (!reads(viewer.member, viewer.base, holder, byId)) everyone = false;
      if (!everyone) break;
    }
    if (everyone) {
      for (const group of groups.values()) {
        const representative = group.members.find((m) => !own.has(m.userId));
        if (representative && !reads(representative, group.base, holder, byId)) {
          everyone = false;
          break;
        }
      }
    }
    if (everyone) result.add(channel.id);
  }
  return result;
}

/** True when the bot, the speaker and every viewer of the current channel hold all `bits` guild-wide. */
export function audienceHasGuildPermission(
  guild: GuildState,
  currentChannelId: string,
  speaker: MemberState,
  selfId: string,
  bits: bigint,
): boolean {
  const bot = self(guild, selfId);
  if (!bot) return false;
  const people = [bot, speaker, ...viewersOf(guild, currentChannelId, selfId)];
  return people.every((m) => has(basePermissions(guild, m), bits));
}

/**
 * Channels a rule may read: the bot and the rule's owner can both read their
 * history. A rule posts nowhere by itself, so there is no audience to narrow to;
 * where its writes may go is fixed by the allow list its owner approved.
 */
export function readableChannels(guild: GuildState, owner: MemberState, selfId: string): Set<string> {
  const bot = self(guild, selfId);
  const result = new Set<string>();
  if (!bot) return result;
  for (const channel of guild.channels.values()) {
    if (channel.type === ChannelType.PrivateThread) continue;
    if (canReadHistory(guild, bot, channel.id) && canReadHistory(guild, owner, channel.id)) result.add(channel.id);
  }
  return result;
}
