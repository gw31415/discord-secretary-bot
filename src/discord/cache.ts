import type {
  APIChannel,
  APIGuildMember,
  APIOverwrite,
  APIRole,
  GatewayGuildCreateDispatchData,
} from "discord-api-types/v10";
import type { ChannelState, GuildState, MemberState, OverwriteState, RoleState } from "./permissions.ts";

// In-memory mirror of each guild the bot serves, kept current from Gateway
// events. Permission checks read from here; writes (Phase 2) re-verify via REST.
// Each guild has its own cache, and a Reader is bound to one, so nothing read
// for one server can reach a conversation in another.

function toRole(role: APIRole): RoleState {
  return { id: role.id, permissions: BigInt(role.permissions), position: role.position };
}

function toOverwrite(o: APIOverwrite): OverwriteState {
  return { id: o.id, type: o.type, allow: BigInt(o.allow), deny: BigInt(o.deny) };
}

export function toChannel(channel: APIChannel): ChannelState {
  const c = channel as APIChannel & { name?: string | null; parent_id?: string | null; permission_overwrites?: APIOverwrite[] };
  return {
    id: c.id,
    type: c.type,
    name: c.name ?? "",
    parentId: c.parent_id ?? null,
    overwrites: (c.permission_overwrites ?? []).map(toOverwrite),
  };
}

export function toMember(member: Pick<APIGuildMember, "roles"> & { user: { id: string; bot?: boolean } }): MemberState {
  return { userId: member.user.id, roleIds: [...member.roles], bot: member.user.bot ?? false };
}

export class GuildCache {
  guild: GuildState | null = null;
  readonly guildId: string;

  constructor(guildId: string) {
    this.guildId = guildId;
  }

  require(): GuildState {
    if (!this.guild) throw new Error("ギルドの情報をまだ受信していません");
    return this.guild;
  }

  loadGuild(data: GatewayGuildCreateDispatchData): void {
    if (data.id !== this.guildId) return;
    this.guild = {
      id: data.id,
      ownerId: data.owner_id,
      roles: new Map(data.roles.map((r) => [r.id, toRole(r)])),
      channels: new Map([...data.channels, ...data.threads].map((c) => [c.id, toChannel(c as APIChannel)])),
      members: new Map(data.members.filter((m) => m.user).map((m) => [m.user.id, toMember(m)])),
    };
  }

  setOwner(ownerId: string): void {
    if (this.guild) this.guild.ownerId = ownerId;
  }

  upsertRole(role: APIRole): void {
    this.guild?.roles.set(role.id, toRole(role));
  }

  deleteRole(roleId: string): void {
    this.guild?.roles.delete(roleId);
  }

  upsertChannel(channel: APIChannel): void {
    this.guild?.channels.set(channel.id, toChannel(channel));
  }

  deleteChannel(channelId: string): void {
    this.guild?.channels.delete(channelId);
  }

  upsertMember(member: Pick<APIGuildMember, "roles"> & { user: { id: string; bot?: boolean } }): void {
    this.guild?.members.set(member.user.id, toMember(member));
  }

  deleteMember(userId: string): void {
    this.guild?.members.delete(userId);
  }

  member(userId: string): MemberState | undefined {
    return this.guild?.members.get(userId);
  }
}

/** One cache per served guild. */
export class GuildCaches {
  readonly #caches = new Map<string, GuildCache>();

  get(guildId: string | undefined): GuildCache | undefined {
    return guildId ? this.#caches.get(guildId) : undefined;
  }

  load(data: GatewayGuildCreateDispatchData): GuildCache {
    const cache = this.#caches.get(data.id) ?? new GuildCache(data.id);
    cache.loadGuild(data);
    this.#caches.set(data.id, cache);
    return cache;
  }

  delete(guildId: string): void {
    this.#caches.delete(guildId);
  }

  get size(): number {
    return this.#caches.size;
  }
}
