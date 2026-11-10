import { DiscordAPIError } from "@discordjs/rest";
import type { PlanStatus } from "../plan/types.ts";

// Names shown to people in place of internal ones: Discord's permission flags,
// audit log actions, the fields a change shows, Discord's error codes and a
// plan's status. Only what is shown changes; anything a table lacks is shown as
// it is, and every value the bot accepts, checks or stores stays the same.

/** Discord's permission flags, as Discord's Japanese client names them. */
const PERMISSION_LABEL: Record<string, string> = {
  CreateInstantInvite: "招待を作成",
  KickMembers: "メンバーをキック",
  BanMembers: "メンバーをBAN",
  Administrator: "管理者",
  ManageChannels: "チャンネルの管理",
  ManageGuild: "サーバー管理",
  AddReactions: "リアクションの追加",
  ViewAuditLog: "監査ログを表示",
  PrioritySpeaker: "優先スピーカー",
  Stream: "動画",
  ViewChannel: "チャンネルを見る",
  SendMessages: "メッセージを送信",
  SendTTSMessages: "テキスト読み上げメッセージを送信する",
  ManageMessages: "メッセージの管理",
  EmbedLinks: "埋め込みリンク",
  AttachFiles: "ファイルを添付",
  ReadMessageHistory: "メッセージ履歴を読む",
  MentionEveryone: "@everyone、@here、全てのロールにメンション",
  UseExternalEmojis: "外部の絵文字を使用する",
  ViewGuildInsights: "サーバーインサイトを見る",
  Connect: "接続",
  Speak: "発言",
  MuteMembers: "メンバーをミュート",
  DeafenMembers: "メンバーをスピーカーミュート",
  MoveMembers: "メンバーを移動",
  UseVAD: "音声検出を使用",
  ChangeNickname: "ニックネームの変更",
  ManageNicknames: "ニックネームの管理",
  ManageRoles: "ロールの管理",
  ManageWebhooks: "ウェブフックの管理",
  ManageEmojisAndStickers: "エクスプレッションを管理",
  ManageGuildExpressions: "エクスプレッションを管理",
  UseApplicationCommands: "アプリコマンドを使う",
  RequestToSpeak: "スピーカー参加をリクエスト",
  ManageEvents: "イベントを管理",
  ManageThreads: "スレッドの管理",
  CreatePublicThreads: "公開スレッドの作成",
  CreatePrivateThreads: "プライベートスレッドの作成",
  UseExternalStickers: "外部のスタンプの使用",
  SendMessagesInThreads: "スレッドでメッセージを送信",
  UseEmbeddedActivities: "アクティビティを使用",
  ModerateMembers: "メンバーをタイムアウト",
  ViewCreatorMonetizationAnalytics: "収益化の分析を表示",
  UseSoundboard: "サウンドボードを使用",
  CreateGuildExpressions: "エクスプレッションを作成",
  CreateEvents: "イベントを作成",
  UseExternalSounds: "外部のサウンドの使用",
  SendVoiceMessages: "ボイスメッセージを送信",
  SetVoiceChannelStatus: "ボイスチャンネルステータスを設定",
  SendPolls: "投票の作成",
  UseExternalApps: "外部のアプリを使用",
  PinMessages: "メッセージのピン留め",
  BypassSlowmode: "低速モードを回避",
};

/** A permission flag's name as people know it; an unknown name as it is. */
export function permissionLabel(name: string): string {
  return Object.hasOwn(PERMISSION_LABEL, name) ? PERMISSION_LABEL[name]! : name;
}

/** Permission flags in a list ("チャンネルの管理・ロールの管理"). */
export function permissionList(names: string[]): string {
  return names.map(permissionLabel).join("・");
}

/** Permission flags inside a sentence (「チャンネルの管理」「ロールの管理」). */
export function permissionQuoted(names: string[]): string {
  return names.map((n) => `「${permissionLabel(n)}」`).join("");
}

/** What each `store.audit` action records. */
const AUDIT_ACTION_LABEL: Record<string, string> = {
  "plan.propose": "変更案の提案",
  "plan.replace": "変更案の置き換え",
  "plan.visibility": "返事を見せる相手の変更",
  "plan.cancel": "取り消し",
  "plan.approve": "実行",
  "plan.resume": "再開",
  "plan.restore": "復元",
  "plan.revise": "修正",
  "plan.keep": "そのまま",
  "plan.succeeded": "成功",
  "plan.aborted": "中止",
  "plan.failed": "失敗",
  "plan.expire": "期限切れ",
  "plan.interrupted": "再起動で中断",
  "rule.approve": "ルールの登録",
  "rule.enable": "ルールの再開",
  "rule.disable": "ルールの停止",
  "rule.visibility": "返事を見せる相手の変更",
  "rule.delete": "ルールの削除",
  "rule.clear_state": "状態の消去",
  "rule.run": "ルールの実行",
  "rule.auto_disable": "ルールの自動停止",
  "rules.halt": "緊急停止",
  "rules.resume": "全ルールを再開",
  "wasm.upload": "Wasmの登録",
  "wasm.delete": "Wasmの削除",
  "llm.key.set": "キーの登録",
  "llm.key.delete": "キーの削除",
  "llm.model.set": "モデルの変更",
  "llm.web.set": "Webツールの変更",
  "llm.read_scope.set": "読み取りの範囲の変更",
  "conversation.reply": "会話の返事",
  "conversation.react": "リアクションの返事",
};

export function auditActionLabel(action: string): string {
  return Object.hasOwn(AUDIT_ACTION_LABEL, action) ? AUDIT_ACTION_LABEL[action]! : action;
}

/** The body fields a change of a channel, role, member, emoji or sticker shows as "before → after". */
const FIELD_LABEL: Record<string, string> = {
  name: "名前",
  topic: "トピック",
  nsfw: "年齢制限",
  rate_limit_per_user: "低速モード(秒)",
  parent_id: "カテゴリ",
  position: "位置",
  permission_overwrites: "権限の上書き",
  permissions: "権限",
  color: "色",
  hoist: "別に表示",
  mentionable: "メンションを許可",
  nick: "ニックネーム",
  communication_disabled_until: "タイムアウトの終了時刻",
  mute: "サーバーミュート",
  deaf: "スピーカーミュート",
  channel_id: "ボイスチャンネルの移動先",
  description: "説明",
  tags: "関連する絵文字",
};

export function fieldLabel(key: string): string {
  return Object.hasOwn(FIELD_LABEL, key) ? FIELD_LABEL[key]! : key;
}

/** The common Discord errors, by code; 30000–30099 are Discord's limits. */
const DISCORD_ERROR_LABEL: Record<number, string> = {
  50013: "権限が足りません",
  50001: "アクセスできません",
  10003: "チャンネルがありません",
  10008: "メッセージがありません",
  50035: "内容が Discord の形に合いません",
};
const LIMIT_LABEL = "Discord の上限に達しました";

/**
 * The message Discord sends with each code above, for an error kept only as
 * its text (a failed step's error). A DiscordAPIError's text starts with it.
 */
const DISCORD_ERROR_TEXT: Array<[string, number]> = [
  ["Missing Permissions", 50013],
  ["Missing Access", 50001],
  ["Unknown Channel", 10003],
  ["Unknown Message", 10008],
  ["Invalid Form Body", 50035],
];

function codeLabel(code: number): string | undefined {
  if (code >= 30000 && code <= 30099) return LIMIT_LABEL;
  return DISCORD_ERROR_LABEL[code];
}

/**
 * A Discord error as people read it: the common codes in Japanese, anything
 * else as Discord wrote it. Takes the error itself or the text kept of it.
 */
export function discordErrorText(error: unknown): string {
  if (error instanceof DiscordAPIError && typeof error.code === "number") return codeLabel(error.code) ?? error.message;
  const text = error instanceof Error ? error.message : String(error);
  for (const [message, code] of DISCORD_ERROR_TEXT) {
    if (text === message || text.startsWith(`${message}\n`)) return codeLabel(code)!;
  }
  return text;
}

/** A plan's status in the words its dialog uses (approved runs at once, so it reads as running). */
export const PLAN_STATUS_LABEL: Record<PlanStatus, string> = {
  pending_approval: "実行待ち",
  approved: "実行中",
  executing: "実行中",
  succeeded: "成功",
  failed: "失敗",
  cancelled: "取り消し",
  aborted: "中止",
};

/** /settings as a link that opens it when its id is known, else as code (`/settings`). */
export function settingsCommand(settingsCommandId?: string): string {
  return settingsCommandId ? `</settings:${settingsCommandId}>` : "`/settings`";
}
