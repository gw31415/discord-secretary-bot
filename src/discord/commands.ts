import { createHash } from "node:crypto";
import type { API } from "@discordjs/core";
import { ApplicationCommandType, ApplicationIntegrationType, InteractionContextType } from "discord-api-types/v10";
import type { RESTPutAPIApplicationCommandsJSONBody, RESTPutAPIApplicationGuildCommandsJSONBody } from "discord-api-types/v10";
import type { Store } from "../db.ts";
import { commandJson } from "../rules/command.ts";

// Commands are overwritten as a whole at startup. The overwrite is idempotent,
// so nothing is restored on shutdown; the hashes only save the daily
// command-creation quota when nothing changed. The bot's own commands are
// global; each server's guild commands are those of its enabled COMMAND rules,
// rebuilt when rules change.

const IN_SERVERS = { contexts: [InteractionContextType.Guild], integration_types: [ApplicationIntegrationType.GuildInstall] };

export const COMMANDS: RESTPutAPIApplicationCommandsJSONBody = [
  {
    name: "settings",
    description: "あなたの設定(APIキー・使うモデル・Webツール・読み取りの許可)とルール・コマンドの管理を開きます",
    type: ApplicationCommandType.ChatInput,
    ...IN_SERVERS,
  },
];

/** The server's custom commands; the bot's own are global and not repeated here. */
export function guildCommands(store: Store, guildId: string): RESTPutAPIApplicationGuildCommandsJSONBody {
  return store.enabledRules(guildId, "COMMAND").flatMap((r) => (r.trigger.command ? [commandJson(r.trigger.command)] : []));
}

/** Where /settings's id is kept, for messages that link to the command (</settings:id>). */
export const SETTINGS_COMMAND_ID = "command_id:settings";

/** /settings, the same in every server; rules are one of its sections. */
export async function registerGlobalCommands(api: API, store: Store, applicationId: string): Promise<boolean> {
  const hash = createHash("sha256").update(JSON.stringify(COMMANDS)).digest("hex");
  const key = "commands_hash:global";
  const unchanged = store.getMeta(key) === hash;
  if (unchanged && store.getMeta(SETTINGS_COMMAND_ID)) return false;
  // Reading the commands back costs no creation quota, so a missing id is fetched.
  const registered = unchanged
    ? await api.applicationCommands.getGlobalCommands(applicationId)
    : await api.applicationCommands.bulkOverwriteGlobalCommands(applicationId, COMMANDS);
  const settings = registered.find((c) => c.name === "settings");
  if (settings) store.setMeta(SETTINGS_COMMAND_ID, settings.id);
  store.setMeta(key, hash);
  return !unchanged;
}

/** Where a server's guild command ids are kept (JSON name→id), for links in the commands list. */
export function guildCommandIdsKey(guildId: string): string {
  return `command_ids:${guildId}`;
}

export async function registerCommands(api: API, store: Store, applicationId: string, guildId: string): Promise<boolean> {
  const commands = guildCommands(store, guildId);
  const hash = createHash("sha256").update(JSON.stringify({ guildId, commands })).digest("hex");
  const key = `commands_hash:${guildId}`;
  const unchanged = store.getMeta(key) === hash;
  if (unchanged && store.getMeta(guildCommandIdsKey(guildId))) return false;
  const registered = unchanged
    ? await api.applicationCommands.getGuildCommands(applicationId, guildId)
    : await api.applicationCommands.bulkOverwriteGuildCommands(applicationId, guildId, commands);
  store.setMeta(guildCommandIdsKey(guildId), JSON.stringify(Object.fromEntries(registered.map((c) => [c.name, c.id]))));
  store.setMeta(key, hash);
  return !unchanged;
}

/** The ids registered for a server's guild commands; empty until the first registration. */
export function guildCommandIds(store: Store, guildId: string): Record<string, string> {
  try {
    return JSON.parse(store.getMeta(guildCommandIdsKey(guildId)) ?? "{}") as Record<string, string>;
  } catch {
    return {};
  }
}
