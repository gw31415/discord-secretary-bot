import { GatewayIntentBits } from "discord-api-types/v10";
import { DEFAULT_TIMEZONE, scheduleProblems } from "./schedule.ts";
import { commandProblems } from "./command.ts";
import type { RuleTrigger } from "./types.ts";

// Gateway events a rule can fire on. Each entry says where the event happened
// (so a rule only sees events in channels its owner can view), who caused it
// and what it touched (so the bot's own writes do not set off rules), and the
// payload shape the rule's code reads as `event`.

type Data = Record<string, any>;

export interface TriggerSpec {
  label: string;
  /** 0 for the bot's own events (SCHEDULE, BOT_READY), which come from no Gateway event. */
  intent: number;
  /** Made by the bot rather than received from the Gateway. */
  synthetic?: boolean;
  /** The server the event is in. Absent means `guild_id`. */
  guildId?: (d: Data) => string | undefined;
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
  /**
   * Exact outcomes of the bot's writes, each matching one event: a recent write that
   * produced this key makes the event bot-made, and the key is used up. Unlike
   * `resources`, later events about the same thing still fire.
   */
  outcomes?: (d: Data) => string[];
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
    resources: (d) => [`message:${d.channel_id}/${d.id}`],
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
    // The bot taking someone else's reaction off: user_id is theirs, not the bot's.
    outcomes: (d) => [reactionKey(d.channel_id as string, d.message_id as string, emojiKey(d.emoji), d.user_id as string)],
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
  GUILD_UPDATE: {
    label: "サーバーの設定が変わったとき",
    intent: GatewayIntentBits.Guilds,
    payload: "id(サーバーID), name, icon, owner_id, system_channel_id, rules_channel_id, afk_channel_id(変更前の値は含まれません)",
    guildId: (d) => d.id,
  },
  SCHEDULE: {
    label: "決まった時刻になったとき",
    intent: 0,
    synthetic: true,
    payload: "guild_id, scheduled_at(発火した分のISO時刻), schedule(cron), timezone。きっかけの schedule(cron: 分 時 日 月 曜日)と timezone(既定 Asia/Tokyo)で時刻を決めます",
  },
  BOT_READY: {
    label: "Botが起動・再接続してサーバーの情報を受け取ったとき",
    intent: 0,
    synthetic: true,
    payload: "guild_id。止まっていた間の変化をまとめて反映するのに使います",
  },
  COMMAND: {
    label: "スラッシュコマンドが実行されたとき",
    intent: 0,
    synthetic: true,
    payload: "guild_id, channel_id, command(コマンド名), user { id, username, global_name }(実行した人), member { roles, nick }, options { オプション名: 値 }(user・channel・role はID、省略されたオプションは入りません)。きっかけの command(name・description・options)でコマンドを決めます。reply(\"文\") で実行した人に返事を出せます",
    channel: (d) => d.channel_id,
    actorId: (d) => d.user?.id,
  },
  INTERACTION_CREATE: {
    label: "Botのメッセージのボタン・セレクトが押されたとき、フォームが送信されたとき",
    intent: 0,
    // Interactions reach the bot over the Gateway, but the bot's own panels take theirs first.
    synthetic: true,
    payload:
      "Discordのインタラクションのまま(token は除く): id, type(3 ボタン・セレクト, 5 フォーム送信), guild_id, channel_id, member { user, roles, nick, permissions }(押した人), message(ボタンが付いたメッセージ), data { custom_id, component_type, values(セレクト), components(フォームの入力欄。各 component に custom_id と value) }。respond({ type, data }) で押した人に応答します(type 9 でフォーム、4 でメッセージ、7 でボタンのメッセージを書き換え。data は Discord の形のまま。flags: 64 で押した人だけに見せる)",
    channel: (d) => d.channel_id ?? d.channel?.id,
    actorId: (d) => d.member?.user?.id ?? d.user?.id,
  },
  VOICE_STATE_UPDATE: {
    label: "ボイスチャンネルに入った・出た・移ったとき",
    intent: GatewayIntentBits.GuildVoiceStates,
    payload: "guild_id, user_id, channel_id(抜けたときは null), before_channel_id(直前にいたチャンネル。いなかったときは null), member { roles, user }, self_mute, self_deaf",
    channel: (d) => d.channel_id ?? d.before_channel_id,
    actorId: (d) => d.user_id,
    // Not `member:<user>`: after the bot moves someone, their own leaving moments later must still fire.
    outcomes: (d) => [
      voiceMoveKey(d.user_id as string, (d.channel_id as string | null) ?? null),
      ...(d.channel_id && d.channel_id === d.before_channel_id ? [voiceMuteKey(d.user_id as string)] : []),
    ],
  },
};

/** The bot moved (or disconnected, with null) a member in voice. */
export function voiceMoveKey(userId: string, channelId: string | null): string {
  return `voice:${userId}/${channelId ?? "none"}`;
}

/** The bot took `userId`'s reaction off a message. */
export function reactionKey(channelId: string, messageId: string, emoji: string, userId: string): string {
  return `reaction:${channelId}/${messageId}/${emoji}/${userId}`;
}

/** An emoji as the reaction routes name it: the character, or name:id for a custom one. */
export function emojiKey(emoji: { id?: string | null; name?: string | null } | undefined): string {
  if (!emoji) return "";
  return emoji.id ? `${emoji.name ?? ""}:${emoji.id}` : (emoji.name ?? "");
}

/** The bot server-muted or deafened a member, which leaves them where they are. */
export function voiceMuteKey(userId: string): string {
  return `voicemute:${userId}`;
}

/** Events a person causes on purpose; their rules act as that person unless the rule runs as its owner (run_as). */
export const ACTOR_EVENTS: ReadonlySet<string> = new Set(["INTERACTION_CREATE", "MESSAGE_REACTION_ADD", "MESSAGE_REACTION_REMOVE"]);

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

/** Every event a rule fires on: its main event, then the others, without repeats. */
export function triggerEvents(trigger: { event: string; events?: string[] }): string[] {
  return [...new Set([trigger.event, ...(trigger.events ?? [])])];
}

export const MAX_TRIGGER_EVENTS = 5;
export const MAX_DEBOUNCE_SECONDS = 300;
/** Events a debounced run keeps; the oldest are dropped. */
export const MAX_BATCH = 50;

/** Shape problems of a trigger. Every message starts with きっかけ. */
export function triggerProblems(trigger: RuleTrigger): string[] {
  const problems: string[] = [];
  const events = triggerEvents(trigger);
  for (const event of events) if (!isTrigger(event)) problems.push(`きっかけ ${event} には対応していません`);
  if (events.length > MAX_TRIGGER_EVENTS) problems.push(`きっかけは${MAX_TRIGGER_EVENTS}種類までです`);
  if (events.includes("SCHEDULE")) problems.push(...scheduleProblems(trigger.schedule, trigger.timezone));
  else if (trigger.schedule !== undefined || trigger.timezone !== undefined) problems.push("きっかけの schedule は SCHEDULE と一緒に使います");
  const debounce = trigger.debounceSeconds;
  if (debounce !== undefined && !(Number.isInteger(debounce) && debounce >= 1 && debounce <= MAX_DEBOUNCE_SECONDS)) {
    problems.push(`きっかけの debounce_seconds は1〜${MAX_DEBOUNCE_SECONDS}の整数にしてください`);
  }
  if (events.includes("COMMAND")) {
    if (events.length > 1) problems.push("きっかけ COMMAND はほかのきっかけと一緒にできません");
    if (debounce !== undefined) problems.push("きっかけ COMMAND には debounce_seconds を付けられません");
    problems.push(...commandProblems(trigger.command).map((p) => `きっかけ: ${p}`));
  } else if (trigger.command !== undefined) problems.push("きっかけの command は COMMAND と一緒に使います");
  if (trigger.runAs !== undefined) {
    if (!events.some((e) => ACTOR_EVENTS.has(e))) problems.push("きっかけの run_as は INTERACTION_CREATE・MESSAGE_REACTION_ADD・MESSAGE_REACTION_REMOVE と一緒に使います");
    else if (trigger.runAs !== "presser" && trigger.runAs !== "owner") problems.push("きっかけの run_as は \"presser\" か \"owner\" です");
  }
  if (events.includes("INTERACTION_CREATE") && debounce !== undefined) problems.push("きっかけ INTERACTION_CREATE には debounce_seconds を付けられません");
  const serial = trigger.serialBy;
  if (serial !== undefined && !(typeof serial === "string" && serial.length <= 64 && /^[A-Za-z0-9_]+(\.[A-Za-z0-9_]+)*$/.test(serial))) {
    problems.push("きっかけの serial_by は \"rule\" か、イベントの項目のパス(user_id、member.user.id など)にしてください");
  }
  const origin = trigger.includeBotOrigin;
  if (origin !== undefined && typeof origin !== "boolean" && origin !== "other_rules") problems.push("きっかけの include_bot_origin は true・false・\"other_rules\" のどれかです");
  return problems;
}

/** The payload of a synthetic event, for a run or a dry run. Null for Gateway events. */
export function syntheticEvent(event: string, guildId: string, trigger: RuleTrigger, now: number): Record<string, unknown> | null {
  if (event === "SCHEDULE") {
    const minute = Math.floor(now / 60_000) * 60_000;
    return { guild_id: guildId, scheduled_at: new Date(minute).toISOString(), schedule: trigger.schedule ?? null, timezone: trigger.timezone ?? DEFAULT_TIMEZONE };
  }
  if (event === "BOT_READY") return { guild_id: guildId };
  return null;
}

/** One line per trigger for the model's instructions. */
export function triggerSummary(): string {
  return Object.entries(TRIGGERS)
    .map(([name, t]) => `- ${name}: ${t.label}。event: ${t.payload}`)
    .join("\n");
}
