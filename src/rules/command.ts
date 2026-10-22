import { ApplicationCommandOptionType, ApplicationCommandType, InteractionType, PermissionFlagsBits } from "discord-api-types/v10";
import type { APIApplicationCommandInteractionDataBasicOption, APIInteraction, RESTPostAPIChatInputApplicationCommandsJSONBody } from "discord-api-types/v10";
import type { MemberState } from "../discord/permissions.ts";

// Rules that a person starts with a guild slash command. The command's options
// arrive as `event.options`, the code runs like any rule (with its owner's
// permissions, within its allow list), and what it passes to reply() goes back
// to whoever ran the command. Each server's custom commands are registered next
// to /settings and /rules whenever its rules change.

export const OPTION_TYPES = {
  string: ApplicationCommandOptionType.String,
  integer: ApplicationCommandOptionType.Integer,
  number: ApplicationCommandOptionType.Number,
  boolean: ApplicationCommandOptionType.Boolean,
  user: ApplicationCommandOptionType.User,
  channel: ApplicationCommandOptionType.Channel,
  role: ApplicationCommandOptionType.Role,
} as const;
export type OptionTypeName = keyof typeof OPTION_TYPES;

export interface CommandOption {
  name: string;
  description: string;
  type: OptionTypeName;
  required?: boolean;
  /** Fixed values to pick from (string, integer and number options only). */
  choices?: Array<{ name: string; value: string | number }>;
}

export interface CommandSpec {
  name: string;
  description: string;
  options?: CommandOption[];
  /** Discord permission names (e.g. "ManageChannels") the person running it must have. */
  permissions?: string[];
  /**
   * Who sees the reply: only whoever ran it, everyone in the channel, or (the
   * default) whichever the owner's judge model picks for each reply.
   */
  visibility?: CommandVisibility;
}

export const VISIBILITIES = ["auto", "private", "public"] as const;
export type CommandVisibility = (typeof VISIBILITIES)[number];

/** The choices on the confirmation dialog and the /rules panel. */
export const VISIBILITY_CHOICES = [
  { value: "public", label: "返事を全員に見せる" },
  { value: "private", label: "返事は実行した人だけに見せる" },
  { value: "auto", label: "返事ごとにモデルが判定する" },
] as const satisfies ReadonlyArray<{ value: CommandVisibility; label: string }>;

/** The bot's own commands; custom ones cannot take these names. */
export const RESERVED_COMMANDS = new Set(["settings", "rules"]);
/** Custom commands per server, well under Discord's 100. */
export const MAX_CUSTOM_COMMANDS = 50;
export const MAX_OPTIONS = 10;
export const MAX_REPLY = 1900;
const NAME = /^[-_\p{Ll}\p{Lo}\p{N}]{1,32}$/u;

const PERMISSIONS = PermissionFlagsBits as Record<string, bigint>;

export function permissionBits(names: string[] | undefined): bigint {
  return (names ?? []).reduce((acc, n) => acc | (PERMISSIONS[n] ?? 0n), 0n);
}

/** Shape problems of a command; `taken` holds names other enabled commands in the server use. */
export function commandProblems(spec: CommandSpec | undefined, taken: Set<string> = new Set()): string[] {
  if (!spec) return ["きっかけ COMMAND には command(名前・説明・オプション)が必要です"];
  const problems: string[] = [];
  if (typeof spec.name !== "string" || !NAME.test(spec.name)) problems.push("コマンド名は小文字・数字・-・_ の32文字までにしてください");
  else if (RESERVED_COMMANDS.has(spec.name)) problems.push(`コマンド名 /${spec.name} はBotが使っています`);
  else if (taken.has(spec.name)) problems.push(`コマンド名 /${spec.name} はこのサーバーの別のルールが使っています`);
  if (typeof spec.description !== "string" || spec.description.length < 1 || spec.description.length > 100) problems.push("コマンドの説明は1〜100文字にしてください");
  const options = spec.options ?? [];
  if (!Array.isArray(options) || options.length > MAX_OPTIONS) problems.push(`コマンドのオプションは${MAX_OPTIONS}個までです`);
  const seen = new Set<string>();
  let optionalSeen = false;
  for (const o of Array.isArray(options) ? options : []) {
    const where = `オプション ${String(o?.name)}`;
    if (typeof o?.name !== "string" || !NAME.test(o.name)) problems.push(`${where}: 名前は小文字・数字・-・_ の32文字までにしてください`);
    else if (seen.has(o.name)) problems.push(`${where}: 名前が重なっています`);
    else seen.add(o.name);
    if (typeof o?.description !== "string" || o.description.length < 1 || o.description.length > 100) problems.push(`${where}: 説明は1〜100文字にしてください`);
    if (!Object.hasOwn(OPTION_TYPES, o?.type)) problems.push(`${where}: type は ${Object.keys(OPTION_TYPES).join("・")} のどれかです`);
    // Discord lists required options before optional ones.
    if (o?.required && optionalSeen) problems.push(`${where}: 必須のオプションは任意のものより前に置いてください`);
    if (!o?.required) optionalSeen = true;
    if (o?.choices !== undefined) {
      const numeric = o.type === "integer" || o.type === "number";
      if (o.type !== "string" && !numeric) problems.push(`${where}: choices は string・integer・number だけに付けられます`);
      else if (!Array.isArray(o.choices) || o.choices.length < 1 || o.choices.length > 25) problems.push(`${where}: choices は1〜25個です`);
      else if (!o.choices.every((c) => typeof c?.name === "string" && c.name.length >= 1 && c.name.length <= 100 && (numeric ? typeof c.value === "number" && (o.type === "number" || Number.isInteger(c.value)) : typeof c.value === "string" && c.value.length <= 100))) {
        problems.push(`${where}: choices は { name, value } で、value はオプションの型に合わせてください`);
      }
    }
  }
  if (spec.visibility !== undefined && !VISIBILITIES.includes(spec.visibility)) problems.push(`visibility は ${VISIBILITIES.join("・")} のどれかです`);
  for (const p of spec.permissions ?? []) if (!Object.hasOwn(PERMISSIONS, p)) problems.push(`権限 ${p} はありません(例: ManageChannels・ManageRoles)`);
  return problems;
}

/** The command as Discord registers it. */
export function commandJson(spec: CommandSpec): RESTPostAPIChatInputApplicationCommandsJSONBody {
  const bits = permissionBits(spec.permissions);
  return {
    name: spec.name,
    description: spec.description,
    type: ApplicationCommandType.ChatInput,
    // Hides the command from those without the permissions; the run checks them again.
    ...(bits ? { default_member_permissions: bits.toString() } : {}),
    options: (spec.options ?? []).map((o) => ({
      name: o.name,
      description: o.description,
      type: OPTION_TYPES[o.type],
      required: o.required ?? false,
      ...(o.choices ? { choices: o.choices } : {}),
    })) as RESTPostAPIChatInputApplicationCommandsJSONBody["options"],
  };
}

/** The command a slash-command interaction names; null for anything else. */
export function commandName(interaction: APIInteraction): string | null {
  if (interaction.type !== InteractionType.ApplicationCommand || interaction.data.type !== ApplicationCommandType.ChatInput) return null;
  return interaction.data.name;
}

/** The event a run of the command reads: who ran it, where, and the option values (ids for users, channels and roles). */
export function commandEvent(interaction: APIInteraction): Record<string, unknown> {
  const data = interaction.data as { name: string; options?: APIApplicationCommandInteractionDataBasicOption[] };
  const options: Record<string, unknown> = {};
  for (const o of data.options ?? []) options[o.name] = o.value;
  const user = interaction.member?.user;
  return {
    guild_id: interaction.guild_id,
    channel_id: interaction.channel?.id ?? null,
    command: data.name,
    user: user ? { id: user.id, username: user.username, global_name: user.global_name ?? null } : null,
    member: interaction.member ? { roles: interaction.member.roles, nick: interaction.member.nick ?? null } : null,
    options,
  };
}

/** A run on the owner's behalf for the dry run: options from the sample, else each option's first choice or a stand-in. */
export function sampleCommandEvent(spec: CommandSpec, guildId: string, channelId: string, owner: MemberState | undefined, sample: unknown): Record<string, unknown> {
  const given = (sample as { options?: Record<string, unknown> } | null | undefined)?.options ?? {};
  const options: Record<string, unknown> = {};
  for (const o of spec.options ?? []) {
    if (Object.hasOwn(given, o.name)) options[o.name] = given[o.name];
    else if (o.choices?.[0]) options[o.name] = o.choices[0].value;
    else if (o.required) options[o.name] = standIn(o.type, owner?.userId ?? "0", channelId, guildId);
  }
  return {
    guild_id: guildId,
    channel_id: channelId || null,
    command: spec.name,
    user: owner ? { id: owner.userId, username: null, global_name: null } : null,
    member: owner ? { roles: [...owner.roleIds], nick: null } : null,
    options,
  };
}

function standIn(type: OptionTypeName, userId: string, channelId: string, guildId: string): unknown {
  switch (type) {
    case "string":
      return "test";
    case "integer":
    case "number":
      return 1;
    case "boolean":
      return true;
    case "user":
      return userId;
    case "channel":
      return channelId;
    case "role":
      return guildId; // @everyone
  }
}
