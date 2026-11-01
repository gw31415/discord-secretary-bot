import { existsSync } from "node:fs";

export interface Config {
  discordToken: string;
  applicationId: string;
  /** Servers the bot may serve. Empty means every server it is invited to. */
  allowedGuildIds: Set<string>;
  /** 32-byte key that wraps every per-key DEK. */
  masterKey: Buffer;
  dbPath: string;
  /** wasm-compiler's socket; unset when there is none, and then nothing is built from source. */
  compilerSocket?: string;
  /** A RustXNG instance for the web tool, offered only to `users`. */
  rustxng?: { url: string; users: Set<string> };
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
    ...compilerSocket(),
    ...rustxng(),
  };
}

const DEFAULT_COMPILER_SOCKET = "/run/wasm-compiler/compiler.sock";

/** WASM_COMPILER_SOCKET, or the service's usual socket when it is there; "" turns it off. */
function compilerSocket(): { compilerSocket?: string } {
  const set = process.env.WASM_COMPILER_SOCKET;
  if (set !== undefined) return set ? { compilerSocket: set } : {};
  return existsSync(DEFAULT_COMPILER_SOCKET) ? { compilerSocket: DEFAULT_COMPILER_SOCKET } : {};
}

/** RUSTXNG_URL and RUSTXNG_USERS (comma-separated Discord user ids); both are needed. */
function rustxng(): { rustxng?: { url: string; users: Set<string> } } {
  const url = process.env.RUSTXNG_URL?.trim();
  const users = new Set((process.env.RUSTXNG_USERS ?? "").split(",").map((id) => id.trim()).filter(Boolean));
  if (!url || users.size === 0) return {};
  const protocol = new URL(url).protocol;
  if (protocol !== "http:" && protocol !== "https:") throw new Error("RUSTXNG_URL は http か https のURLにしてください");
  return { rustxng: { url, users } };
}
