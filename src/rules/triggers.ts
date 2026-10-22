import { GatewayIntentBits } from "discord-api-types/v10";

// Gateway events a rule can fire on. Each entry says where the event happened
// (so a rule only sees events in channels its owner can view), who caused it
// and what it touched (so the bot's own writes do not set off rules), and the
// payload shape the rule's code reads as `event`.

type Data = Record<string, any>;

export interface TriggerSpec {
  label: string;
  intent: number;
  /** The main fields of `event`, for the model writing the rule. */
  payload: string;
  /** The channel the event happened in; the owner must be able to view it. */
  channel?: (d: Data) => string | null | undefined;
  /** The event is itself a channel (create/update/delete), so its own overwrites decide visibility. */
  isChannel?: boolean;
  /** Who did it, when the payload says so. */
  actorId?: (d: Data) => string | undefined;
  /** Resources the event is about; a recent write by the bot to one of them makes it bot-made. */
  resources?: (d: Data) => string[];
  /** Created resources have no id before the write returns, so any recent create of this kind counts. */
  createdKind?: string;
}

const MESSAGE = "id, channel_id, guild_id, content, author { id, username, global_name, bot }, member { roles, nick }, mentions[], mention_roles[], attachments[], message_reference, timestamp";
const MEMBER = "guild_id, user { id, username, global_name, bot }, roles[], nick, joined_at, communication_disabled_until";

export const TRIGGERS: Record<string, TriggerSpec> = {
  MESSAGE_CREATE: {
    label: "メッセージが投稿されたとき",
    intent: GatewayIntentBits.GuildMessages,
    payload: MESSAGE,
    channel: (d) => d.channel_id,
    actorId: (d) => d.author?.id,
  },
  MESSAGE_UPDATE: {
    label: "メッセージが編集されたとき",
    intent: GatewayIntentBits.GuildMessages,
    payload: `${MESSAGE}, edited_timestamp`,
    channel: (d) => d.channel_id,
    actorId: (d) => d.author?.id,
  },
  MESSAGE_DELETE: {
    label: "メッセージが削除されたとき",
    intent: GatewayIntentBits.GuildMessages,
    payload: "id, channel_id, guild_id(本文や投稿者は含まれません)",
    channel: (d) => d.channel_id,
    resources: (d) => [`message:${d.channel_id}/${d.id}`],
  },
  MESSAGE_REACTION_ADD: {
    label: "リアクションが付いたとき",
    intent: GatewayIntentBits.GuildMessageReactions,
    payload: "user_id, channel_id, message_id, guild_id, member { roles, user }, emoji { id, name }, message_author_id",
    channel: (d) => d.channel_id,
    actorId: (d) => d.user_id,
  },
  MESSAGE_REACTION_REMOVE: {
    label: "リアクションが外れたとき",
    intent: GatewayIntentBits.GuildMessageReactions,
    payload: "user_id, channel_id, message_id, guild_id, emoji { id, name }",
    channel: (d) => d.channel_id,
    actorId: (d) => d.user_id,
  },
  GUILD_MEMBER_ADD: {
    label: "メンバーが参加したとき",
    intent: GatewayIntentBits.GuildMembers,
    payload: MEMBER,
  },
  GUILD_MEMBER_UPDATE: {
    label: "メンバーのロールやニックネームが変わったとき",
    intent: GatewayIntentBits.GuildMembers,
    payload: `${MEMBER}(変更前の値は含まれません)`,
    resources: (d) => [`member:${d.user?.id}`],
  },
  GUILD_MEMBER_REMOVE: {
    label: "メンバーが抜けたとき",
    intent: GatewayIntentBits.GuildMembers,
    payload: "guild_id, user { id, username, global_name, bot }",
    resources: (d) => [`member:${d.user?.id}`],
  },
  GUILD_BAN_ADD: {
    label: "BANされたとき",
    intent: GatewayIntentBits.GuildModeration,
    payload: "guild_id, user { id, username, global_name, bot }",
    resources: (d) => [`member:${d.user?.id}`],
  },
  GUILD_BAN_REMOVE: {
    label: "BANが解除されたとき",
    intent: GatewayIntentBits.GuildModeration,
    payload: "guild_id, user { id, username, global_name, bot }",
    resources: (d) => [`ban:${d.guild_id}/${d.user?.id}`],
  },
  CHANNEL_CREATE: {
    label: "チャンネルが作られたとき",
    intent: GatewayIntentBits.Guilds,
    payload: "id, guild_id, name, type, parent_id, topic, permission_overwrites[]",
    channel: (d) => d.id,
    isChannel: true,
    createdKind: "channel",
  },
  CHANNEL_UPDATE: {
    label: "チャンネルが変更されたとき",
    intent: GatewayIntentBits.Guilds,
    payload: "id, guild_id, name, type, parent_id, topic, permission_overwrites[](変更前の値は含まれません)",
    channel: (d) => d.id,
    isChannel: true,
    resources: (d) => [`channel:${d.id}`, ...((d.permission_overwrites as Data[] | undefined) ?? []).map((o) => `overwrite:${d.id}/${o.id}`)],
  },
  CHANNEL_DELETE: {
    label: "チャンネルが削除されたとき",
    intent: GatewayIntentBits.Guilds,
    payload: "id, guild_id, name, type, parent_id",
    channel: (d) => d.id,
    isChannel: true,
    resources: (d) => [`channel:${d.id}`],
  },
  THREAD_CREATE: {
    label: "スレッドが作られたとき",
    intent: GatewayIntentBits.Guilds,
    payload: "id, guild_id, name, type, parent_id, owner_id, newly_created",
    channel: (d) => d.id,
    isChannel: true,
    actorId: (d) => d.owner_id,
  },
  GUILD_ROLE_CREATE: {
    label: "ロールが作られたとき",
    intent: GatewayIntentBits.Guilds,
    payload: "guild_id, role { id, name, permissions, position, color }",
    createdKind: "role",
  },
  GUILD_ROLE_UPDATE: {
    label: "ロールが変更されたとき",
    intent: GatewayIntentBits.Guilds,
    payload: "guild_id, role { id, name, permissions, position, color }(変更前の値は含まれません)",
    resources: (d) => [`role:${d.role?.id}`],
  },
  GUILD_ROLE_DELETE: {
    label: "ロールが削除されたとき",
    intent: GatewayIntentBits.Guilds,
    payload: "guild_id, role_id",
    resources: (d) => [`role:${d.role_id}`],
  },
  VOICE_STATE_UPDATE: {
    label: "ボイスチャンネルに入った・出た・移ったとき",
    intent: GatewayIntentBits.GuildVoiceStates,
    payload: "guild_id, user_id, channel_id(抜けたときは null), before_channel_id(直前にいたチャンネル。いなかったときは null), member { roles, user }, self_mute, self_deaf",
    channel: (d) => d.channel_id ?? d.before_channel_id,
    actorId: (d) => d.user_id,
    resources: (d) => [`member:${d.user_id}`],
  },
};

export function isTrigger(name: string): boolean {
  return Object.hasOwn(TRIGGERS, name);
}

/** Intents the triggers need, on top of what conversations use. */
export const TRIGGER_INTENTS = Object.values(TRIGGERS).reduce((acc, t) => acc | t.intent, 0);

/** The kind of resource a create step makes, matched with `createdKind`. */
export function createdKindOf(op: string): string | undefined {
  if (op === "POST /guilds/{guild}/channels" || op === "POST /channels/{channel}/threads") return "channel";
  if (op === "POST /guilds/{guild}/roles") return "role";
  return undefined;
}

/** One line per trigger for the model's instructions. */
export function triggerSummary(): string {
  return Object.entries(TRIGGERS)
    .map(([name, t]) => `- ${name}: ${t.label}。event: ${t.payload}`)
    .join("\n");
}
