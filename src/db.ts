import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { open, seal } from "./crypto.ts";
import { isProviderId } from "./llm/models.ts";
import type { ProviderId } from "./llm/models.ts";

// Each entry upgrades the schema by one version. Never edit an applied entry.
const MIGRATIONS: string[] = [
  `
  CREATE TABLE meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE api_keys (
    user_id TEXT NOT NULL,
    provider TEXT NOT NULL,
    ciphertext BLOB NOT NULL,
    wrapped_dek BLOB NOT NULL,
    last4 TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (user_id, provider)
  );
  CREATE TABLE user_settings (
    user_id TEXT PRIMARY KEY,
    default_provider TEXT,
    default_model TEXT,
    judge_provider TEXT,
    judge_model TEXT
  );
  CREATE TABLE audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at TEXT NOT NULL,
    actor_json TEXT NOT NULL,
    action TEXT NOT NULL,
    plan_id TEXT,
    rule_id TEXT,
    detail_json TEXT NOT NULL
  );
  CREATE TABLE conversations (
    channel_id TEXT PRIMARY KEY,
    started_by TEXT NOT NULL,
    awake_until INTEGER NOT NULL,
    updated_at TEXT NOT NULL
  );
  `,
];

export interface ModelRef {
  provider: ProviderId;
  model: string;
}

export interface UserSettings {
  response: ModelRef | null;
  judge: ModelRef | null;
}

export interface KeySummary {
  provider: ProviderId;
  last4: string;
}

export interface ConversationRow {
  channelId: string;
  startedBy: string;
  awakeUntil: number;
}

export type AuditActor = { kind: "user"; userId: string; via: "conversation" | "panel" } | { kind: "system" };

export class Store {
  readonly db: Database.Database;
  readonly #masterKey: Buffer;

  constructor(path: string, masterKey: Buffer) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.#masterKey = masterKey;
    this.#migrate();
  }

  #migrate(): void {
    const current = this.db.pragma("user_version", { simple: true }) as number;
    for (let v = current; v < MIGRATIONS.length; v++) {
      this.db.transaction(() => {
        this.db.exec(MIGRATIONS[v]!);
        this.db.pragma(`user_version = ${v + 1}`);
      })();
    }
  }

  getMeta(key: string): string | undefined {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined;
    return row?.value;
  }

  setMeta(key: string, value: string): void {
    this.db
      .prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(key, value);
  }

  // --- API keys -----------------------------------------------------------

  setApiKey(userId: string, provider: ProviderId, apiKey: string): void {
    const sealed = seal(this.#masterKey, apiKey, `${userId}:${provider}`);
    this.db
      .prepare(
        `INSERT INTO api_keys (user_id, provider, ciphertext, wrapped_dek, last4, created_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id, provider) DO UPDATE SET
           ciphertext = excluded.ciphertext, wrapped_dek = excluded.wrapped_dek,
           last4 = excluded.last4, created_at = excluded.created_at`,
      )
      .run(userId, provider, sealed.ciphertext, sealed.wrappedDek, apiKey.slice(-4), new Date().toISOString());
  }

  deleteApiKey(userId: string, provider: ProviderId): boolean {
    return this.db.prepare("DELETE FROM api_keys WHERE user_id = ? AND provider = ?").run(userId, provider).changes > 0;
  }

  getApiKey(userId: string, provider: ProviderId): string | undefined {
    const row = this.db
      .prepare("SELECT ciphertext, wrapped_dek FROM api_keys WHERE user_id = ? AND provider = ?")
      .get(userId, provider) as { ciphertext: Buffer; wrapped_dek: Buffer } | undefined;
    if (!row) return undefined;
    return open(this.#masterKey, { ciphertext: row.ciphertext, wrappedDek: row.wrapped_dek }, `${userId}:${provider}`);
  }

  // Rows of providers the bot no longer supports stay in the table but are ignored.
  listKeys(userId: string): KeySummary[] {
    const rows = this.db
      .prepare("SELECT provider, last4 FROM api_keys WHERE user_id = ? ORDER BY provider")
      .all(userId) as { provider: string; last4: string }[];
    return rows.filter((r): r is KeySummary => isProviderId(r.provider));
  }

  // --- Model settings -----------------------------------------------------

  getSettings(userId: string): UserSettings {
    const row = this.db.prepare("SELECT * FROM user_settings WHERE user_id = ?").get(userId) as
      | { default_provider: string | null; default_model: string | null; judge_provider: string | null; judge_model: string | null }
      | undefined;
    const ref = (provider: string | null | undefined, model: string | null | undefined): ModelRef | null =>
      provider && model && isProviderId(provider) ? { provider, model } : null;
    return {
      response: ref(row?.default_provider, row?.default_model),
      judge: ref(row?.judge_provider, row?.judge_model),
    };
  }

  setModel(userId: string, role: "response" | "judge", ref: ModelRef | null): void {
    const [providerCol, modelCol] = role === "response" ? ["default_provider", "default_model"] : ["judge_provider", "judge_model"];
    this.db.prepare("INSERT INTO user_settings (user_id) VALUES (?) ON CONFLICT(user_id) DO NOTHING").run(userId);
    this.db
      .prepare(`UPDATE user_settings SET ${providerCol} = ?, ${modelCol} = ? WHERE user_id = ?`)
      .run(ref?.provider ?? null, ref?.model ?? null, userId);
  }

  // --- Audit log (append only) --------------------------------------------

  audit(actor: AuditActor, action: string, detail: Record<string, unknown> = {}): void {
    this.db
      .prepare("INSERT INTO audit_log (at, actor_json, action, detail_json) VALUES (?, ?, ?, ?)")
      .run(new Date().toISOString(), JSON.stringify(actor), action, JSON.stringify(detail));
  }

  // --- Conversations ------------------------------------------------------

  getConversation(channelId: string): ConversationRow | undefined {
    const row = this.db.prepare("SELECT * FROM conversations WHERE channel_id = ?").get(channelId) as
      | { channel_id: string; started_by: string; awake_until: number }
      | undefined;
    if (!row) return undefined;
    return { channelId: row.channel_id, startedBy: row.started_by, awakeUntil: row.awake_until };
  }

  saveConversation(conv: ConversationRow): void {
    this.db
      .prepare(
        `INSERT INTO conversations (channel_id, started_by, awake_until, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(channel_id) DO UPDATE SET
           started_by = excluded.started_by, awake_until = excluded.awake_until, updated_at = excluded.updated_at`,
      )
      .run(conv.channelId, conv.startedBy, conv.awakeUntil, new Date().toISOString());
  }

  deleteExpiredConversations(now: number): void {
    this.db.prepare("DELETE FROM conversations WHERE awake_until <= ?").run(now);
  }

  close(): void {
    this.db.close();
  }
}
