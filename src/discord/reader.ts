import type { REST } from "@discordjs/rest";
import { ChannelType, PermissionFlagsBits } from "discord-api-types/v10";
import type { APIChannel, APIMessage, RESTGetAPIGuildMessagesSearchResult } from "discord-api-types/v10";
import type { GuildCache } from "./cache.ts";
import { toChannel } from "./cache.ts";
import { audienceHasGuildPermission, basePermissions, has, readableChannels, shareableChannels } from "./permissions.ts";
import type { GuildState, MemberState } from "./permissions.ts";

// Every read the agent or sandbox makes goes through here. The bot token can
// read everything (Administrator), so results are narrowed to what may be shown
// in the channel where the reply will be posted. Unknown routes are refused.

export class ReadDenied extends Error {}

export interface ReadScope {
  guildId: string;
  channelId: string;
  speakerId: string;
  /**
   * "channel" (default): what everyone who can see the channel may read, for a reply posted there.
   * "owner": what the speaker alone may read, for a rule that runs with its owner's permissions.
   */
  audience?: "channel" | "owner";
}

export interface ReaderLimits {
  /** Messages fetched per agent response, across all tools. */
  maxMessages: number;
}

type Query = Record<string, string | number | boolean | Array<string | number>>;

interface RouteRule {
  pattern: RegExp;
  handle: (reader: Reader, params: string[], query: Query) => Promise<unknown>;
}

function toSearchParams(query: Query): URLSearchParams {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    for (const v of Array.isArray(value) ? value : [value]) params.append(key, String(v));
  }
  return params;
}

const GUILD_PERMISSION_ROUTES: Array<[RegExp, bigint]> = [
  [/^\/guilds\/(\d+)\/audit-logs$/, PermissionFlagsBits.ViewAuditLog],
  [/^\/guilds\/(\d+)\/bans$/, PermissionFlagsBits.BanMembers],
  [/^\/guilds\/(\d+)\/bans\/(\d+)$/, PermissionFlagsBits.BanMembers],
  [/^\/guilds\/(\d+)\/invites$/, PermissionFlagsBits.ManageGuild],
  [/^\/guilds\/(\d+)\/auto-moderation\/rules$/, PermissionFlagsBits.ManageGuild],
];

const RULES: RouteRule[] = [
  { pattern: /^\/guilds\/(\d+)$/, handle: (r, [g]) => r.guildRoute(g!, `/guilds/${g}`, {}) },
  { pattern: /^\/guilds\/(\d+)\/roles$/, handle: (r, [g]) => r.roles(g!) },
  { pattern: /^\/guilds\/(\d+)\/members$/, handle: (r, [g], q) => r.guildRoute(g!, `/guilds/${g}/members`, q) },
  { pattern: /^\/guilds\/(\d+)\/members\/search$/, handle: (r, [g], q) => r.guildRoute(g!, `/guilds/${g}/members/search`, q) },
  { pattern: /^\/guilds\/(\d+)\/members\/(\d+)$/, handle: (r, [g, u]) => r.guildRoute(g!, `/guilds/${g}/members/${u}`, {}) },
  { pattern: /^\/guilds\/(\d+)\/emojis$/, handle: (r, [g]) => r.guildRoute(g!, `/guilds/${g}/emojis`, {}) },
  { pattern: /^\/guilds\/(\d+)\/stickers$/, handle: (r, [g]) => r.guildRoute(g!, `/guilds/${g}/stickers`, {}) },
  { pattern: /^\/guilds\/(\d+)\/scheduled-events$/, handle: (r, [g], q) => r.guildRoute(g!, `/guilds/${g}/scheduled-events`, q) },
  { pattern: /^\/guilds\/(\d+)\/channels$/, handle: (r, [g]) => r.listChannels(g!) },
  { pattern: /^\/guilds\/(\d+)\/voice-states$/, handle: async (r, [g], q) => r.voiceStates(g!, q) },
  { pattern: /^\/guilds\/(\d+)\/threads\/active$/, handle: (r, [g]) => r.activeThreads(g!) },
  { pattern: /^\/guilds\/(\d+)\/messages\/search$/, handle: (r, [g], q) => r.searchMessages(g!, q) },
  { pattern: /^\/channels\/(\d+)$/, handle: (r, [c]) => r.channel(c!) },
  { pattern: /^\/channels\/(\d+)\/messages$/, handle: (r, [c], q) => r.messages(c!, q) },
  { pattern: /^\/channels\/(\d+)\/messages\/(\d+)$/, handle: (r, [c, m]) => r.channelRoute(c!, `/channels/${c}/messages/${m}`, {}) },
  { pattern: /^\/channels\/(\d+)\/messages\/pins$/, handle: (r, [c], q) => r.channelRoute(c!, `/channels/${c}/messages/pins`, q) },
  { pattern: /^\/channels\/(\d+)\/threads\/archived\/public$/, handle: (r, [c], q) => r.channelRoute(c!, `/channels/${c}/threads/archived/public`, q) },
];

export class Reader {
  readonly rest: REST;
  readonly cache: GuildCache;
  readonly selfId: string;
  readonly scope: ReadScope;
  readonly limits: ReaderLimits;
  messagesRead = 0;
  #shareable: Set<string> | null = null;
  readonly #fetched = new Map<string, Promise<unknown>>();

  constructor(rest: REST, cache: GuildCache, selfId: string, scope: ReadScope, limits: ReaderLimits) {
    this.rest = rest;
    this.cache = cache;
    this.selfId = selfId;
    this.scope = scope;
    this.limits = limits;
  }

  get guild(): GuildState {
    return this.cache.require();
  }

  get speaker(): MemberState {
    const member = this.cache.member(this.scope.speakerId);
    if (!member) throw new ReadDenied("話し手がサーバーのメンバーとして見つかりません");
    return member;
  }

  /** Channels whose contents may appear in this reply. Computed once per reply. */
  shareable(): Set<string> {
    this.#shareable ??=
      this.scope.audience === "owner"
        ? readableChannels(this.guild, this.speaker, this.selfId)
        : shareableChannels(this.guild, this.scope.channelId, this.speaker, this.selfId);
    return this.#shareable;
  }

  /**
   * Archived threads are not in the Gateway cache. Fetch them once so that a
   * public thread under a shareable channel can be read like its parent.
   */
  async assertChannel(channelId: string): Promise<void> {
    if (!this.shareable().has(channelId) && !this.guild.channels.has(channelId)) {
      const raw = (await this.rest.get(`/channels/${channelId}`)) as APIChannel & { guild_id?: string };
      const fetched = toChannel(raw);
      if (raw.guild_id === this.guild.id && fetched.type !== ChannelType.PrivateThread && fetched.parentId && this.shareable().has(fetched.parentId)) {
        this.shareable().add(fetched.id);
      }
    }
    if (!this.shareable().has(channelId)) {
      throw new ReadDenied(`チャンネル ${channelId} の内容はこの場所では扱えません(閲覧権限または公開範囲の制約)`);
    }
  }

  #assertGuild(guildId: string): void {
    if (guildId !== this.guild.id) throw new ReadDenied("このサーバー以外は読めません");
  }

  #countMessages(n: number): void {
    this.messagesRead += n;
    if (this.messagesRead > this.limits.maxMessages) {
      throw new ReadDenied(`1回の応答で読めるメッセージは${this.limits.maxMessages}件までです`);
    }
  }

  /** Generic GET used by the sandbox. Only allowlisted routes are served. */
  async get(route: string, query: Query = {}): Promise<unknown> {
    const path = route.replace(/^GET /, "");
    // Strict: the query goes in its own argument, so the route is only ever a bare path.
    if (path.includes("?")) throw new ReadDenied("クエリは discord.get(route, { query: { ... } }) の query に渡してください");
    for (const [pattern, bits] of GUILD_PERMISSION_ROUTES) {
      const m = pattern.exec(path);
      if (!m) continue;
      this.#assertGuild(m[1]!);
      if (this.scope.audience === "owner") {
        const bot = this.guild.members.get(this.selfId);
        if (!bot || !has(basePermissions(this.guild, this.speaker), bits) || !has(basePermissions(this.guild, bot), bits)) {
          throw new ReadDenied("必要な権限がないため読めません");
        }
      } else if (!audienceHasGuildPermission(this.guild, this.scope.channelId, this.speaker, this.selfId, bits)) {
        throw new ReadDenied("話し手とこのチャンネルを見られる全員が必要な権限を持っていないため読めません");
      }
      return this.rest.get(path as `/${string}`, { query: toSearchParams(query) });
    }
    for (const rule of RULES) {
      const m = rule.pattern.exec(path);
      if (m) return rule.handle(this, m.slice(1), query);
    }
    throw new ReadDenied(`読み取りが許可されていない経路です: ${path}`);
  }

  /** REST GET, remembered for the life of this reader (one reply or one rule run): code often asks twice. */
  #fetch(path: string, query: Query): Promise<unknown> {
    const key = `${path}?${toSearchParams(query).toString()}`;
    let pending = this.#fetched.get(key);
    if (!pending) {
      pending = this.rest.get(path as `/${string}`, { query: toSearchParams(query) });
      this.#fetched.set(key, pending);
      pending.catch(() => this.#fetched.delete(key));
    }
    return pending;
  }

  async guildRoute(guildId: string, path: string, query: Query): Promise<unknown> {
    this.#assertGuild(guildId);
    return this.#fetch(path, query);
  }

  async channelRoute(channelId: string, path: string, query: Query): Promise<unknown> {
    await this.assertChannel(channelId);
    return this.#fetch(path, query);
  }

  /** Roles from the Gateway cache when it has them. */
  async roles(guildId: string): Promise<unknown> {
    this.#assertGuild(guildId);
    const raw = this.cache.raw;
    if (!raw) return this.#fetch(`/guilds/${guildId}/roles`, {});
    return [...raw.roles.values()];
  }

  async channel(channelId: string): Promise<unknown> {
    await this.assertChannel(channelId);
    return this.cache.raw?.channels.get(channelId) ?? this.#fetch(`/channels/${channelId}`, {});
  }

  async listChannels(guildId: string): Promise<APIChannel[]> {
    this.#assertGuild(guildId);
    const raw = this.cache.raw;
    const all = raw ? [...raw.channels.values()] : ((await this.#fetch(`/guilds/${guildId}/channels`, {})) as APIChannel[]);
    const allowed = this.shareable();
    return all.filter((c) => allowed.has(c.id));
  }

  /**
   * Who is in which voice channel, from the Gateway (Discord has no REST route
   * for the whole server). Only channels this reply may show are included.
   */
  voiceStates(guildId: string, query: Query): Array<{ user_id: string; channel_id: string }> {
    this.#assertGuild(guildId);
    const allowed = this.shareable();
    const only = query.channel_id === undefined ? null : String(query.channel_id);
    return [...this.cache.voice]
      .filter(([, channelId]) => allowed.has(channelId) && (only === null || channelId === only))
      .map(([userId, channelId]) => ({ user_id: userId, channel_id: channelId }));
  }

  async activeThreads(guildId: string): Promise<unknown> {
    this.#assertGuild(guildId);
    const res = (await this.rest.get(`/guilds/${guildId}/threads/active`)) as { threads: APIChannel[]; members: unknown[] };
    const allowed = this.shareable();
    return { threads: res.threads.filter((t) => allowed.has(t.id)) };
  }

  async messages(channelId: string, query: Query): Promise<APIMessage[]> {
    await this.assertChannel(channelId);
    const limit = Math.min(Number(query.limit ?? 50), 100);
    const result = (await this.rest.get(`/channels/${channelId}/messages`, {
      query: toSearchParams({ ...query, limit }),
    })) as APIMessage[];
    this.#countMessages(result.length);
    return result;
  }

  async searchMessages(guildId: string, query: Query): Promise<RESTGetAPIGuildMessagesSearchResult> {
    this.#assertGuild(guildId);
    const allowed = this.shareable();
    const requested = query.channel_id === undefined ? [] : [query.channel_id].flat().map(String);
    const channels = requested.length > 0 ? requested.filter((id) => allowed.has(id)) : [...allowed];
    if (channels.length === 0) throw new ReadDenied("検索できるチャンネルがありません");
    const limit = Math.min(Number(query.limit ?? 25), 25);
    const res = (await this.rest.get(`/guilds/${guildId}/messages/search`, {
      query: toSearchParams({ ...query, limit, channel_id: channels.slice(0, 500) }),
    })) as RESTGetAPIGuildMessagesSearchResult;
    if (!("messages" in res)) return res; // index not ready (code 110000)
    // Hits inside threads carry the thread id; allow public threads of shareable channels.
    const threadParent = new Map(
      (res.threads ?? []).filter((t) => t.type !== ChannelType.PrivateThread).map((t) => [t.id, t.parent_id]),
    );
    const visible = (id: string) => allowed.has(id) || allowed.has(threadParent.get(id) ?? "");
    const messages = res.messages.filter((group) => group.every((m) => visible(m.channel_id)));
    this.#countMessages(messages.length);
    return { ...res, messages, threads: res.threads?.filter((t) => visible(t.id)) };
  }
}
