import { Type } from "typebox";
import type { TSchema } from "typebox";
import { PermissionFlagsBits as P } from "discord-api-types/v10";
import { FILE_ID_PATTERN, MAX_IMAGES_PER_REPLY } from "./types.ts";
import type { Risk, StepDraft } from "./types.ts";

// The permission table: every write the bot can make, with the Discord
// permissions it needs, where they are evaluated, whether role hierarchy
// applies, and the body schema. Operations not listed here, and body fields not
// in a schema, are refused. Checked in with the code and reviewed by hand.

const Id = Type.String({ pattern: "^\\d{1,20}$" });
const Bits = Type.String({ pattern: "^\\d{1,20}$", description: "権限ビットの10進文字列" });
const Content = Type.String({ minLength: 1, maxLength: 2000 });
/** Images drawn with attach_image in the same reply, by id; content or files must be present. */
const Files = Type.Array(Type.String({ pattern: FILE_ID_PATTERN }), { minItems: 1, maxItems: MAX_IMAGES_PER_REPLY, uniqueItems: true, description: "attach_image で作った画像のID" });
const MessageBody = Type.Object({ content: Type.Optional(Content), files: Type.Optional(Files) }, { additionalProperties: false });

function filesNote(b: Record<string, unknown> | undefined): string {
  const files = Array.isArray(b?.files) ? b.files.length : 0;
  return files > 0 ? `(画像${files}枚)` : "";
}

const Overwrite = Type.Object(
  { id: Id, type: Type.Union([Type.Literal(0), Type.Literal(1)]), allow: Type.Optional(Bits), deny: Type.Optional(Bits) },
  { additionalProperties: false },
);

export type Params = Record<string, unknown>;
export type Body = Record<string, unknown> | undefined;

export interface FieldRule {
  perms?: bigint;
  risk?: Risk;
}

export interface OpSpec {
  op: string;
  label: string;
  risk: Risk;
  /** Path param of the channel whose overwrites apply. Absent means server-wide permissions. */
  channel?: string;
  always: bigint;
  /** Extra permissions and risk per body field present. */
  byField?: Record<string, FieldRule>;
  /** Extra permissions decided by body values (e.g. thread type). */
  extraPerms?: (body: Body) => bigint;
  /** Path params whose target must sit below both the actor and the bot. */
  hierarchy?: { member?: string; role?: string };
  /** Body fields that make `hierarchy.member` apply. Absent means it always does. */
  hierarchyFields?: string[];
  /** Permission bits the step hands out; the actor and the bot must hold each one. */
  grants?: (body: Body) => bigint;
  /** Absent means the operation takes no body. */
  body?: TSchema;
  /** Path params that are not ids, with the format each must have. */
  pathFormats?: Record<string, { pattern: RegExp; hint: string }>;
  /** The resource the step acts on; its state is a precondition and is snapshotted before execution. */
  target?: (p: Params, guildId: string) => string;
  /** Fields of the target the step depends on (besides existence). */
  targetFields?: (body: Body) => string[];
  /** Channels whose names or contents the preview reveals. */
  channels?: (p: Params, body: Body) => unknown[];
  /** Ids to label in the preview. */
  mentions?: (p: Params, body: Body) => Array<{ id: unknown; kind: "channel" | "role" | "user" }>;
  describe: (p: Params, body: Body, before: Record<string, unknown> | null, label: (id: unknown) => string) => { target: string; change: string };
  /**
   * Whether the inverse brings back everything. Defaults to "has an inverse".
   * A recreated channel lacks its messages, so deleting one is not undoable.
   */
  undoable?: (body: Body) => boolean;
  /** The step that undoes this one, from the snapshot taken before it ran and its response. */
  inverse?: (p: Params, body: Body, snapshot: Record<string, unknown> | null, result: Record<string, unknown> | null) => StepDraft | null;
}

export const PERMISSION_NAMES: Array<[string, bigint]> = Object.entries(P);

export function permissionNames(bits: bigint): string[] {
  return PERMISSION_NAMES.filter(([, bit]) => (bits & bit) === bit && bit !== 0n).map(([name]) => name);
}

function bits(value: unknown): bigint {
  return typeof value === "string" && /^\d+$/.test(value) ? BigInt(value) : 0n;
}

function short(text: unknown, max = 60): string {
  const s = String(text ?? "").replaceAll("\n", " ");
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function show(key: string, value: unknown): string {
  if (value === undefined) return "(なし)";
  if (value === null) return "(空)";
  if (key === "permissions") return permissionNames(bits(value)).join(", ") || "(なし)";
  if (key === "permission_overwrites" && Array.isArray(value)) return `${value.length}件`;
  if (typeof value === "string") return `"${short(value, 40)}"`;
  return short(JSON.stringify(value), 40);
}

/** "key: before → after" for each changed field. */
function diff(body: Body, before: Record<string, unknown> | null): string {
  return Object.entries(body ?? {})
    .map(([key, value]) => `${key}: ${before ? show(key, before[key]) : "?"} → ${show(key, value)}`)
    .join(" / ");
}

function pick(source: Record<string, unknown> | null, keys: string[]): Record<string, unknown> | null {
  if (!source) return null;
  const out: Record<string, unknown> = {};
  for (const key of keys) if (source[key] !== undefined) out[key] = source[key];
  return out;
}

function overwriteBits(body: Body): bigint {
  const list = (body?.permission_overwrites as Array<{ allow?: string; deny?: string }> | undefined) ?? [];
  return list.reduce((acc, o) => acc | bits(o.allow) | bits(o.deny), 0n);
}

const CHANNEL_FIELDS = {
  name: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
  topic: Type.Optional(Type.Union([Type.String({ maxLength: 1024 }), Type.Null()])),
  nsfw: Type.Optional(Type.Boolean()),
  rate_limit_per_user: Type.Optional(Type.Integer({ minimum: 0, maximum: 21600 })),
  parent_id: Type.Optional(Type.Union([Id, Type.Null()])),
  position: Type.Optional(Type.Integer({ minimum: 0 })),
  permission_overwrites: Type.Optional(Type.Array(Overwrite, { maxItems: 100 })),
};
const CHANNEL_RESTORE_KEYS = ["name", "type", "topic", "nsfw", "rate_limit_per_user", "parent_id", "position", "permission_overwrites"];

const ROLE_FIELDS = {
  name: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
  permissions: Type.Optional(Bits),
  color: Type.Optional(Type.Integer({ minimum: 0, maximum: 0xffffff })),
  hoist: Type.Optional(Type.Boolean()),
  mentionable: Type.Optional(Type.Boolean()),
};

const MEMBER_FIELDS = ["nick", "communication_disabled_until", "mute", "deaf"];

/** A Unicode emoji, or name:id for a server's custom one, as the reaction routes take it. */
export const EMOJI_FORMAT = { pattern: /^(?!\.+$)(?:[^\s:/?#%]{1,32}|[A-Za-z0-9_]{2,32}:\d{1,20})$/u, hint: "絵文字そのもの(例: 👍)か、カスタム絵文字の 名前:ID" };

const REACTION_PATH = "/channels/{channel}/messages/{message}/reactions/{emoji}";

const ops: OpSpec[] = [
  {
    op: "POST /channels/{channel}/messages",
    label: "投稿",
    risk: "write",
    channel: "channel",
    always: P.ViewChannel | P.SendMessages,
    body: MessageBody,
    channels: (p) => [p.channel],
    describe: (p, b, _before, l) => ({ target: l(p.channel), change: `${b?.content ? `「${short(b.content, 80)}」` : "画像のみ"}${filesNote(b)}` }),
    inverse: (p, _b, _s, result) => (result?.id ? { op: "DELETE /channels/{channel}/messages/{message}", path: { channel: p.channel, message: result.id } } : null),
  },
  {
    op: "DELETE /channels/{channel}/messages/{message}",
    label: "メッセージ削除",
    risk: "destructive",
    channel: "channel",
    always: P.ViewChannel | P.ReadMessageHistory | P.ManageMessages,
    target: (p) => `message:${p.channel}/${p.message}`,
    channels: (p) => [p.channel],
    describe: (p, _b, before, l) => {
      const author = (before?.author as { username?: string } | undefined)?.username;
      return { target: `${l(p.channel)} のメッセージ ${p.message}`, change: before ? `${author ?? "?"}「${short(before.content, 50)}」を削除` : "削除" };
    },
  },
  {
    op: "POST /channels/{channel}/messages/bulk-delete",
    label: "メッセージ一括削除",
    risk: "destructive",
    channel: "channel",
    always: P.ViewChannel | P.ReadMessageHistory | P.ManageMessages,
    body: Type.Object({ messages: Type.Array(Id, { minItems: 2, maxItems: 100, uniqueItems: true }) }, { additionalProperties: false }),
    channels: (p) => [p.channel],
    describe: (p, b, _before, l) => ({ target: l(p.channel), change: `${(b?.messages as unknown[]).length}件を削除(2週間より古いものは消せません)` }),
  },
  {
    // Only the bot's own messages can have their text changed.
    op: "PATCH /channels/{channel}/messages/{message}",
    label: "Botの投稿を編集",
    risk: "write",
    channel: "channel",
    always: P.ViewChannel | P.ReadMessageHistory | P.ManageMessages,
    body: Type.Object({ content: Content }, { additionalProperties: false }),
    target: (p) => `message:${p.channel}/${p.message}`,
    targetFields: () => ["content"],
    channels: (p) => [p.channel],
    describe: (p, b, before, l) => ({ target: `${l(p.channel)} のメッセージ ${p.message}`, change: `${before ? `「${short(before.content, 40)}」→ ` : ""}「${short(b?.content, 60)}」` }),
    inverse: (p, _b, snapshot) => (typeof snapshot?.content === "string" && snapshot.content ? { op: "PATCH /channels/{channel}/messages/{message}", path: { channel: p.channel, message: p.message }, body: { content: snapshot.content } } : null),
  },
  {
    op: `PUT ${REACTION_PATH}/@me`,
    label: "リアクションを付ける",
    risk: "write",
    channel: "channel",
    always: P.ViewChannel | P.ReadMessageHistory | P.AddReactions,
    pathFormats: { emoji: EMOJI_FORMAT },
    target: (p) => `message:${p.channel}/${p.message}`,
    channels: (p) => [p.channel],
    describe: (p, _b, before, l) => ({ target: `${l(p.channel)} のメッセージ ${p.message}${before ? `「${short(before.content, 40)}」` : ""}`, change: `${p.emoji} を付ける` }),
    inverse: (p) => ({ op: `DELETE ${REACTION_PATH}/@me`, path: { channel: p.channel, message: p.message, emoji: p.emoji } }),
  },
  {
    op: `DELETE ${REACTION_PATH}/@me`,
    label: "Botのリアクションを外す",
    risk: "write",
    channel: "channel",
    always: P.ViewChannel | P.ReadMessageHistory,
    pathFormats: { emoji: EMOJI_FORMAT },
    target: (p) => `message:${p.channel}/${p.message}`,
    channels: (p) => [p.channel],
    describe: (p, _b, before, l) => ({ target: `${l(p.channel)} のメッセージ ${p.message}${before ? `「${short(before.content, 40)}」` : ""}`, change: `Botの ${p.emoji} を外す` }),
    inverse: (p) => ({ op: `PUT ${REACTION_PATH}/@me`, path: { channel: p.channel, message: p.message, emoji: p.emoji } }),
  },
  {
    // Someone else's reaction cannot be put back by the bot, so this has no inverse.
    op: `DELETE ${REACTION_PATH}/{user}`,
    label: "リアクションを外す",
    risk: "write",
    channel: "channel",
    always: P.ViewChannel | P.ReadMessageHistory | P.ManageMessages,
    pathFormats: { emoji: EMOJI_FORMAT },
    target: (p) => `message:${p.channel}/${p.message}`,
    channels: (p) => [p.channel],
    mentions: (p) => [{ id: p.user, kind: "user" }],
    describe: (p, _b, _before, l) => ({ target: `${l(p.channel)} のメッセージ ${p.message}`, change: `${l(p.user)} の ${p.emoji} を外す` }),
  },
  {
    op: "PUT /channels/{channel}/messages/pins/{message}",
    label: "ピン留め",
    risk: "write",
    channel: "channel",
    always: P.ViewChannel | P.PinMessages,
    target: (p) => `message:${p.channel}/${p.message}`,
    channels: (p) => [p.channel],
    describe: (p, _b, before, l) => ({ target: `${l(p.channel)} のメッセージ ${p.message}`, change: before ? `「${short(before.content, 50)}」をピン留め` : "ピン留め" }),
    inverse: (p) => ({ op: "DELETE /channels/{channel}/messages/pins/{message}", path: { channel: p.channel, message: p.message } }),
  },
  {
    op: "DELETE /channels/{channel}/messages/pins/{message}",
    label: "ピン留め解除",
    risk: "write",
    channel: "channel",
    always: P.ViewChannel | P.PinMessages,
    target: (p) => `message:${p.channel}/${p.message}`,
    channels: (p) => [p.channel],
    describe: (p, _b, _before, l) => ({ target: `${l(p.channel)} のメッセージ ${p.message}`, change: "ピン留めを外す" }),
    inverse: (p) => ({ op: "PUT /channels/{channel}/messages/pins/{message}", path: { channel: p.channel, message: p.message } }),
  },
  {
    op: "POST /guilds/{guild}/channels",
    label: "チャンネル作成",
    risk: "write",
    always: P.ManageChannels,
    byField: { permission_overwrites: { perms: P.ManageRoles } },
    grants: overwriteBits,
    body: Type.Object(
      {
        ...CHANNEL_FIELDS,
        name: Type.String({ minLength: 1, maxLength: 100 }),
        type: Type.Optional(Type.Union([0, 2, 4, 5, 13, 15].map((t) => Type.Literal(t)), { description: "0=テキスト 2=ボイス 4=カテゴリ 5=アナウンス 13=ステージ 15=フォーラム" })),
      },
      { additionalProperties: false },
    ),
    channels: (_p, b) => [b?.parent_id],
    mentions: (_p, b) => ((b?.permission_overwrites as Array<{ id: string; type: number }> | undefined) ?? []).map((o) => ({ id: o.id, kind: o.type === 0 ? "role" : "user" })),
    describe: (_p, b, _before, l) => {
      const parts = [`#${b?.name}`];
      if (b?.parent_id) parts.push(`カテゴリ ${l(b.parent_id)}`);
      if (b?.permission_overwrites) parts.push(`権限上書き ${(b.permission_overwrites as unknown[]).length}件`);
      return { target: parts.join(" "), change: "作成" };
    },
    inverse: (_p, _b, _s, result) => (result?.id ? { op: "DELETE /channels/{channel}", path: { channel: result.id } } : null),
  },
  {
    op: "PATCH /channels/{channel}",
    label: "チャンネル変更",
    risk: "write",
    channel: "channel",
    always: P.ManageChannels,
    byField: { permission_overwrites: { perms: P.ManageRoles, risk: "destructive" } },
    grants: overwriteBits,
    body: Type.Object(CHANNEL_FIELDS, { additionalProperties: false, minProperties: 1 }),
    target: (p) => `channel:${p.channel}`,
    targetFields: (b) => Object.keys(b ?? {}),
    channels: (p, b) => [p.channel, b?.parent_id],
    describe: (p, b, before, l) => ({ target: l(p.channel), change: diff(b, before) }),
    inverse: (p, b, snapshot) => {
      const restore = pick(snapshot, Object.keys(b ?? {}));
      return restore ? { op: "PATCH /channels/{channel}", path: { channel: p.channel }, body: restore } : null;
    },
  },
  {
    op: "DELETE /channels/{channel}",
    label: "チャンネル削除",
    risk: "destructive",
    channel: "channel",
    always: P.ManageChannels,
    target: (p) => `channel:${p.channel}`,
    channels: (p) => [p.channel],
    describe: (p, _b, _before, l) => ({ target: l(p.channel), change: "削除(メッセージは戻せません)" }),
    undoable: () => false,
    // Recreates the channel with the same settings; its messages are gone for good.
    inverse: (_p, _b, snapshot) => {
      const body = pick(snapshot, CHANNEL_RESTORE_KEYS);
      if (!body) return null;
      for (const key of Object.keys(body)) if (body[key] === null) delete body[key];
      return { op: "POST /guilds/{guild}/channels", body };
    },
  },
  {
    op: "PUT /channels/{channel}/permissions/{overwrite}",
    label: "権限上書きの設定",
    risk: "destructive",
    channel: "channel",
    always: P.ManageRoles,
    grants: (b) => bits(b?.allow) | bits(b?.deny),
    body: Type.Object(
      { type: Type.Union([Type.Literal(0), Type.Literal(1)], { description: "0=ロール 1=メンバー" }), allow: Type.Optional(Bits), deny: Type.Optional(Bits) },
      { additionalProperties: false },
    ),
    target: (p) => `overwrite:${p.channel}/${p.overwrite}`,
    targetFields: () => ["allow", "deny"],
    channels: (p) => [p.channel],
    mentions: (p, b) => [{ id: p.overwrite, kind: b?.type === 0 ? "role" : "user" }],
    describe: (p, b, before, l) => {
      const fmt = (v: unknown) => permissionNames(bits(v)).join(", ") || "なし";
      const was = before ? `許可 ${fmt(before.allow)} / 拒否 ${fmt(before.deny)}` : "(上書きなし)";
      return { target: `${l(p.channel)} の ${l(p.overwrite)}`, change: `${was} → 許可 ${fmt(b?.allow)} / 拒否 ${fmt(b?.deny)}` };
    },
    inverse: (p, _b, snapshot) =>
      snapshot
        ? { op: "PUT /channels/{channel}/permissions/{overwrite}", path: { channel: p.channel, overwrite: p.overwrite }, body: { type: snapshot.type, allow: snapshot.allow, deny: snapshot.deny } }
        : { op: "DELETE /channels/{channel}/permissions/{overwrite}", path: { channel: p.channel, overwrite: p.overwrite } },
  },
  {
    op: "DELETE /channels/{channel}/permissions/{overwrite}",
    label: "権限上書きの削除",
    risk: "destructive",
    channel: "channel",
    always: P.ManageRoles,
    target: (p) => `overwrite:${p.channel}/${p.overwrite}`,
    channels: (p) => [p.channel],
    describe: (p, _b, _before, l) => ({ target: `${l(p.channel)} の ${l(p.overwrite)}`, change: "上書きを削除" }),
    inverse: (p, _b, snapshot) =>
      snapshot
        ? { op: "PUT /channels/{channel}/permissions/{overwrite}", path: { channel: p.channel, overwrite: p.overwrite }, body: { type: snapshot.type, allow: snapshot.allow, deny: snapshot.deny } }
        : null,
  },
  {
    op: "POST /channels/{channel}/threads",
    label: "スレッド作成",
    risk: "write",
    channel: "channel",
    always: P.ViewChannel,
    extraPerms: (b) => (b?.type === 12 ? P.CreatePrivateThreads : P.CreatePublicThreads),
    body: Type.Object(
      {
        name: Type.String({ minLength: 1, maxLength: 100 }),
        type: Type.Union([Type.Literal(11), Type.Literal(12)], { description: "11=公開 12=非公開" }),
        auto_archive_duration: Type.Optional(Type.Union([60, 1440, 4320, 10080].map((t) => Type.Literal(t)))),
        invitable: Type.Optional(Type.Boolean()),
      },
      { additionalProperties: false },
    ),
    channels: (p) => [p.channel],
    describe: (p, b, _before, l) => ({ target: `${l(p.channel)} に「${b?.name}」`, change: b?.type === 12 ? "非公開スレッドを作成" : "スレッドを作成" }),
    inverse: (_p, _b, _s, result) => (result?.id ? { op: "DELETE /channels/{channel}", path: { channel: result.id } } : null),
  },
  {
    op: "POST /guilds/{guild}/roles",
    label: "ロール作成",
    risk: "write",
    always: P.ManageRoles,
    grants: (b) => bits(b?.permissions),
    body: Type.Object(ROLE_FIELDS, { additionalProperties: false }),
    describe: (_p, b) => ({
      target: `@${b?.name ?? "new role"}`,
      change: b?.permissions !== undefined ? `作成(権限: ${show("permissions", b.permissions)})` : "作成",
    }),
    inverse: (_p, _b, _s, result) => (result?.id ? { op: "DELETE /guilds/{guild}/roles/{role}", path: { role: result.id } } : null),
  },
  {
    op: "PATCH /guilds/{guild}/roles/{role}",
    label: "ロール変更",
    risk: "write",
    always: P.ManageRoles,
    byField: { permissions: { risk: "destructive" } },
    hierarchy: { role: "role" },
    grants: (b) => bits(b?.permissions),
    body: Type.Object(ROLE_FIELDS, { additionalProperties: false, minProperties: 1 }),
    target: (p) => `role:${p.role}`,
    targetFields: (b) => Object.keys(b ?? {}),
    mentions: (p) => [{ id: p.role, kind: "role" }],
    describe: (p, b, before, l) => ({ target: l(p.role), change: diff(b, before) }),
    inverse: (p, b, snapshot) => {
      const restore = pick(snapshot, Object.keys(b ?? {}));
      return restore ? { op: "PATCH /guilds/{guild}/roles/{role}", path: { role: p.role }, body: restore } : null;
    },
  },
  {
    op: "DELETE /guilds/{guild}/roles/{role}",
    label: "ロール削除",
    risk: "destructive",
    always: P.ManageRoles,
    hierarchy: { role: "role" },
    target: (p) => `role:${p.role}`,
    mentions: (p) => [{ id: p.role, kind: "role" }],
    describe: (p, _b, _before, l) => ({ target: l(p.role), change: "削除(付いていたメンバーは戻せません)" }),
  },
  {
    op: "PUT /guilds/{guild}/members/{user}/roles/{role}",
    label: "ロール付与",
    risk: "write",
    always: P.ManageRoles,
    hierarchy: { role: "role" },
    target: (p) => `member:${p.user}`,
    mentions: (p) => [{ id: p.user, kind: "user" }, { id: p.role, kind: "role" }],
    describe: (p, _b, _before, l) => ({ target: l(p.user), change: `${l(p.role)} を付与` }),
    inverse: (p, _b, snapshot) =>
      (snapshot?.roles as string[] | undefined)?.includes(String(p.role))
        ? null // already had it; nothing changed
        : { op: "DELETE /guilds/{guild}/members/{user}/roles/{role}", path: { user: p.user, role: p.role } },
  },
  {
    op: "DELETE /guilds/{guild}/members/{user}/roles/{role}",
    label: "ロール解除",
    risk: "write",
    always: P.ManageRoles,
    hierarchy: { role: "role" },
    target: (p) => `member:${p.user}`,
    mentions: (p) => [{ id: p.user, kind: "user" }, { id: p.role, kind: "role" }],
    describe: (p, _b, _before, l) => ({ target: l(p.user), change: `${l(p.role)} を外す` }),
    inverse: (p, _b, snapshot) =>
      (snapshot?.roles as string[] | undefined)?.includes(String(p.role))
        ? { op: "PUT /guilds/{guild}/members/{user}/roles/{role}", path: { user: p.user, role: p.role } }
        : null,
  },
  {
    op: "PATCH /guilds/{guild}/members/{user}",
    label: "メンバー変更",
    risk: "write",
    always: 0n,
    byField: {
      nick: { perms: P.ManageNicknames },
      communication_disabled_until: { perms: P.ModerateMembers },
      mute: { perms: P.MuteMembers },
      deaf: { perms: P.DeafenMembers },
      channel_id: { perms: P.MoveMembers },
    },
    hierarchy: { member: "user" },
    // Discord checks role hierarchy for nicknames and timeouts, not for moving, muting or deafening.
    hierarchyFields: ["nick", "communication_disabled_until"],
    body: Type.Object(
      {
        nick: Type.Optional(Type.Union([Type.String({ maxLength: 32 }), Type.Null()])),
        communication_disabled_until: Type.Optional(Type.Union([Type.String({ format: "date-time" }), Type.Null()], { description: "タイムアウトの終了時刻(最長28日後)。null で解除" })),
        mute: Type.Optional(Type.Boolean()),
        deaf: Type.Optional(Type.Boolean()),
        channel_id: Type.Optional(Type.Union([Id, Type.Null()], { description: "ボイスチャンネルの移動先。null で切断" })),
      },
      { additionalProperties: false, minProperties: 1 },
    ),
    target: (p) => `member:${p.user}`,
    targetFields: (b) => Object.keys(b ?? {}).filter((k) => MEMBER_FIELDS.includes(k)),
    channels: (_p, b) => [b?.channel_id],
    mentions: (p) => [{ id: p.user, kind: "user" }],
    describe: (p, b, before, l) => ({ target: l(p.user), change: diff(b, before) }),
    // The voice channel someone was in is not on the member object.
    undoable: (b) => !Object.hasOwn(b ?? {}, "channel_id"),
    inverse: (p, b, snapshot) => {
      const restore = pick(snapshot, Object.keys(b ?? {}).filter((k) => MEMBER_FIELDS.includes(k)));
      if (restore && Object.keys(b ?? {}).includes("communication_disabled_until") && restore.communication_disabled_until === undefined) {
        restore.communication_disabled_until = null;
      }
      return restore && Object.keys(restore).length > 0 ? { op: "PATCH /guilds/{guild}/members/{user}", path: { user: p.user }, body: restore } : null;
    },
  },
  {
    op: "DELETE /guilds/{guild}/members/{user}",
    label: "キック",
    risk: "destructive",
    always: P.KickMembers,
    hierarchy: { member: "user" },
    target: (p) => `member:${p.user}`,
    mentions: (p) => [{ id: p.user, kind: "user" }],
    describe: (p, _b, _before, l) => ({ target: l(p.user), change: "サーバーからキック" }),
  },
  {
    op: "PUT /guilds/{guild}/bans/{user}",
    label: "BAN",
    risk: "destructive",
    always: P.BanMembers,
    hierarchy: { member: "user" },
    body: Type.Object({ delete_message_seconds: Type.Optional(Type.Integer({ minimum: 0, maximum: 604800 })) }, { additionalProperties: false }),
    mentions: (p) => [{ id: p.user, kind: "user" }],
    describe: (p, b, _before, l) => ({
      target: l(p.user),
      change: b?.delete_message_seconds ? `BAN(直近${Math.round(Number(b.delete_message_seconds) / 3600)}時間の発言も削除)` : "BAN",
    }),
    // Unbanning does not bring deleted messages back.
    undoable: (b) => !b?.delete_message_seconds,
    inverse: (p) => ({ op: "DELETE /guilds/{guild}/bans/{user}", path: { user: p.user } }),
  },
  {
    op: "DELETE /guilds/{guild}/bans/{user}",
    label: "BAN解除",
    risk: "write",
    always: P.BanMembers,
    target: (p, g) => `ban:${g}/${p.user}`,
    mentions: (p) => [{ id: p.user, kind: "user" }],
    describe: (p, _b, _before, l) => ({ target: l(p.user), change: "BANを解除" }),
    inverse: (p) => ({ op: "PUT /guilds/{guild}/bans/{user}", path: { user: p.user }, body: {} }),
  },
  {
    // Not a Discord route: the executor opens the DM channel and posts to it.
    // No Discord permission covers DMs, so sending them needs Manage Server.
    op: "POST /users/{user}/dm",
    label: "DM送信",
    risk: "destructive",
    always: P.ManageGuild,
    body: MessageBody,
    target: (p) => `member:${p.user}`,
    mentions: (p) => [{ id: p.user, kind: "user" }],
    describe: (p, b, _before, l) => ({ target: l(p.user), change: `DM${b?.content ? `「${short(b.content, 60)}」` : "(画像のみ)"}${filesNote(b)}` }),
  },
];

export const CATALOG: ReadonlyMap<string, OpSpec> = new Map(ops.map((o) => [o.op, o]));

/** Path parameter names of an operation id, in order. */
export function pathParamNames(op: string): string[] {
  return [...op.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!);
}

/** "METHOD /path" with params filled in. */
export function routeOf(op: string, params: Params): { method: string; path: `/${string}` } {
  const [method, template] = op.split(" ") as [string, string];
  const path = template.replace(/\{(\w+)\}/g, (_, name: string) => encodeURIComponent(String(params[name])));
  return { method, path: path as `/${string}` };
}

/** One line per operation for the agent's tool description. */
export function catalogSummary(): string {
  return ops.map((o) => `- ${o.op}: ${o.label}${o.body ? "" : "(bodyなし)"}`).join("\n");
}

export const MAX_DMS_PER_PLAN = 50;
export const DM_INTERVAL_MS = 1000;
