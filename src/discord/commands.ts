import { createHash } from "node:crypto";
import type { API } from "@discordjs/core";
import { ApplicationCommandType } from "discord-api-types/v10";
import type { RESTPutAPIApplicationGuildCommandsJSONBody } from "discord-api-types/v10";
import type { Store } from "../db.ts";

// Guild commands are overwritten as a whole at startup. The overwrite is
// idempotent, so nothing is restored on shutdown; the hash only saves the
// daily command-creation quota when nothing changed.

export const COMMANDS: RESTPutAPIApplicationGuildCommandsJSONBody = [
  {
    name: "llm",
    description: "あなたのAPIキーと、応答・宛先判定に使うモデルを設定します",
    type: ApplicationCommandType.ChatInput,
  },
];

export async function registerCommands(api: API, store: Store, applicationId: string, guildId: string): Promise<boolean> {
  const hash = createHash("sha256").update(JSON.stringify({ guildId, COMMANDS })).digest("hex");
  const key = `commands_hash:${guildId}`;
  if (store.getMeta(key) === hash) return false;
  await api.applicationCommands.bulkOverwriteGuildCommands(applicationId, guildId, COMMANDS);
  store.setMeta(key, hash);
  return true;
}
