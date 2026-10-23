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
    description: "あなたの設定(APIキー・使うモデル・Webツール・読み取りを広げる許可)を開きます",
    type: ApplicationCommandType.ChatInput,
    ...IN_SERVERS,
  },
  {
    name: "rules",
    description: "イベントルールの管理パネルを開きます(ルールは会話でBotに頼むと作れます)",
    type: ApplicationCommandType.ChatInput,
    ...IN_SERVERS,
  },
];

/** The server's custom commands; the bot's own are global and not repeated here. */
export function guildCommands(store: Store, guildId: string): RESTPutAPIApplicationGuildCommandsJSONBody {
  return store.enabledRules(guildId, "COMMAND").flatMap((r) => (r.trigger.command ? [commandJson(r.trigger.command)] : []));
}

/** /settings and /rules, the same in every server. */
export async function registerGlobalCommands(api: API, store: Store, applicationId: string): Promise<boolean> {
  const hash = createHash("sha256").update(JSON.stringify(COMMANDS)).digest("hex");
  const key = "commands_hash:global";
  if (store.getMeta(key) === hash) return false;
  await api.applicationCommands.bulkOverwriteGlobalCommands(applicationId, COMMANDS);
  store.setMeta(key, hash);
  return true;
}

export async function registerCommands(api: API, store: Store, applicationId: string, guildId: string): Promise<boolean> {
  const commands = guildCommands(store, guildId);
  const hash = createHash("sha256").update(JSON.stringify({ guildId, commands })).digest("hex");
  const key = `commands_hash:${guildId}`;
  if (store.getMeta(key) === hash) return false;
  await api.applicationCommands.bulkOverwriteGuildCommands(applicationId, guildId, commands);
  store.setMeta(key, hash);
  return true;
}
