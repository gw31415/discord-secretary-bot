export interface Config {
  discordToken: string;
  applicationId: string;
  /** Servers the bot may serve. Empty means every server it is invited to. */
  allowedGuildIds: Set<string>;
  /** 32-byte key that wraps every per-key DEK. */
  masterKey: Buffer;
  dbPath: string;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`環境変数 ${name} が設定されていません`);
  return value;
}

export function loadConfig(): Config {
  const masterKey = Buffer.from(required("MASTER_KEY"), "base64");
  if (masterKey.length !== 32) {
    throw new Error("MASTER_KEY は32バイトをbase64にした値にしてください(例: openssl rand -base64 32)");
  }
  return {
    discordToken: required("DISCORD_TOKEN"),
    applicationId: required("DISCORD_APPLICATION_ID"),
    allowedGuildIds: new Set((process.env.DISCORD_GUILD_IDS ?? "").split(",").map((id) => id.trim()).filter(Boolean)),
    masterKey,
    dbPath: process.env.DB_PATH ?? "data/bot.db",
  };
}
