import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { open, seal } from "./crypto.ts";
import { isKeyProviderId, isProviderId } from "./llm/models.ts";
import type { KeyProviderId, ProviderId } from "./llm/models.ts";
import { isWebTool } from "./agent/web.ts";
import type { WebTool } from "./agent/web.ts";
import type { Plan, PlanStatus, StepState } from "./plan/types.ts";

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
  `
  CREATE TABLE plans (
    id TEXT PRIMARY KEY,
    guild_id TEXT NOT NULL,
    actor_json TEXT NOT NULL,
    plan_json TEXT NOT NULL,
    hash TEXT NOT NULL,
    risk TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    approved_by TEXT,
    approved_at TEXT,
    channel_id TEXT,
    message_id TEXT,
    reason TEXT,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX plans_status ON plans (status, expires_at);
  CREATE TABLE plan_steps (
    plan_id TEXT NOT NULL REFERENCES plans (id),
    step_id TEXT NOT NULL,
    position INTEGER NOT NULL,
    state TEXT NOT NULL,
    attempt INTEGER NOT NULL DEFAULT 0,
    request_json TEXT,
    response_json TEXT,
    result_id TEXT,
    error TEXT,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (plan_id, step_id)
  );
  CREATE TABLE snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    plan_id TEXT NOT NULL,
    step_id TEXT NOT NULL,
    resource TEXT NOT NULL,
    data_json TEXT,
    taken_at TEXT NOT NULL
  );
  CREATE INDEX snapshots_taken ON snapshots (taken_at);
  `,
  // Columns of the withdrawn 元に戻す button. Applied on deployed databases, so kept; unused.
  `
  ALTER TABLE plans ADD COLUMN undo_until TEXT;
  ALTER TABLE plans ADD COLUMN undo_of TEXT;
  CREATE INDEX plans_undo_of ON plans (undo_of);
  `,
  `
  ALTER TABLE user_settings ADD COLUMN web_tool TEXT;
  `,
];

export interface ModelRef {
  provider: ProviderId;
  model: string;
}

export interface UserSettings {
  response: ModelRef | null;
  judge: ModelRef | null;
  /** The web service the agent uses. Unset means the response model's own. */
  web: WebTool;
}

export interface KeySummary {
  provider: KeyProviderId;
  last4: string;
}

export interface ConversationRow {
  channelId: string;
  startedBy: string;
  awakeUntil: number;
}

export type AuditActor = { kind: "user"; userId: string; via: "conversation" | "panel" } | { kind: "system" };

export interface PlanRow {
  plan: Plan;
  status: PlanStatus;
  channelId: string | null;
  messageId: string | null;
  reason: string | null;
  approvedBy: string | null;
}

export interface StepRow {
  stepId: string;
  state: StepState;
  attempt: number;
  /** The request as sent, with values from earlier steps filled in. */
  request: { pathParams: Record<string, unknown>; body?: unknown } | null;
  response: unknown;
  resultId: string | null;
  error: string | null;
}

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

  setApiKey(userId: string, provider: KeyProviderId, apiKey: string): void {
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

  deleteApiKey(userId: string, provider: KeyProviderId): boolean {
    return this.db.prepare("DELETE FROM api_keys WHERE user_id = ? AND provider = ?").run(userId, provider).changes > 0;
  }

  getApiKey(userId: string, provider: KeyProviderId): string | undefined {
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
    return rows.filter((r): r is KeySummary => isKeyProviderId(r.provider));
  }

  // --- Model settings -----------------------------------------------------

  getSettings(userId: string): UserSettings {
    const row = this.db.prepare("SELECT * FROM user_settings WHERE user_id = ?").get(userId) as
      | { default_provider: string | null; default_model: string | null; judge_provider: string | null; judge_model: string | null; web_tool: string | null }
      | undefined;
    const ref = (provider: string | null | undefined, model: string | null | undefined): ModelRef | null =>
      provider && model && isProviderId(provider) ? { provider, model } : null;
    return {
      response: ref(row?.default_provider, row?.default_model),
      judge: ref(row?.judge_provider, row?.judge_model),
      web: row?.web_tool && isWebTool(row.web_tool) ? row.web_tool : "auto",
    };
  }

  setWebTool(userId: string, tool: WebTool): void {
    this.db.prepare("INSERT INTO user_settings (user_id) VALUES (?) ON CONFLICT(user_id) DO NOTHING").run(userId);
    this.db.prepare("UPDATE user_settings SET web_tool = ? WHERE user_id = ?").run(tool, userId);
  }

  setModel(userId: string, role: "response" | "judge", ref: ModelRef | null): void {
    const [providerCol, modelCol] = role === "response" ? ["default_provider", "default_model"] : ["judge_provider", "judge_model"];
    this.db.prepare("INSERT INTO user_settings (user_id) VALUES (?) ON CONFLICT(user_id) DO NOTHING").run(userId);
    this.db
      .prepare(`UPDATE user_settings SET ${providerCol} = ?, ${modelCol} = ? WHERE user_id = ?`)
      .run(ref?.provider ?? null, ref?.model ?? null, userId);
  }

  // --- Audit log (append only) --------------------------------------------

  audit(actor: AuditActor, action: string, detail: Record<string, unknown> = {}, planId?: string): void {
    this.db
      .prepare("INSERT INTO audit_log (at, actor_json, action, plan_id, detail_json) VALUES (?, ?, ?, ?, ?)")
      .run(new Date().toISOString(), JSON.stringify(actor), action, planId ?? null, JSON.stringify(detail));
  }

  // --- Plans --------------------------------------------------------------

  insertPlan(plan: Plan): void {
    const now = new Date().toISOString();
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO plans (id, guild_id, actor_json, plan_json, hash, risk, status, created_at, expires_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 'pending_approval', ?, ?, ?)`,
        )
        .run(plan.id, plan.guildId, JSON.stringify(plan.actor), JSON.stringify(plan), plan.hash, plan.risk, plan.createdAt, plan.expiresAt, now);
      const step = this.db.prepare(
        "INSERT INTO plan_steps (plan_id, step_id, position, state, updated_at) VALUES (?, ?, ?, 'pending', ?)",
      );
      plan.steps.forEach((s, i) => step.run(plan.id, s.id, i, now));
    })();
  }

  getPlan(id: string): PlanRow | undefined {
    const row = this.db.prepare("SELECT * FROM plans WHERE id = ?").get(id) as
      | { plan_json: string; status: PlanStatus; channel_id: string | null; message_id: string | null; reason: string | null; approved_by: string | null }
      | undefined;
    if (!row) return undefined;
    return {
      plan: JSON.parse(row.plan_json) as Plan,
      status: row.status,
      channelId: row.channel_id,
      messageId: row.message_id,
      reason: row.reason,
      approvedBy: row.approved_by,
    };
  }

  setPlanMessage(id: string, channelId: string, messageId: string): void {
    this.db.prepare("UPDATE plans SET channel_id = ?, message_id = ? WHERE id = ?").run(channelId, messageId, id);
  }

  /** Moves a plan between states only from the expected one, so two clicks cannot both run it. */
  transitionPlan(id: string, from: PlanStatus[], to: PlanStatus, extra: { reason?: string | null; approvedBy?: string } = {}): boolean {
    const now = new Date().toISOString();
    const placeholders = from.map(() => "?").join(", ");
    const result = this.db
      .prepare(
        `UPDATE plans SET status = ?, updated_at = ?,
           reason = CASE WHEN ? THEN ? ELSE reason END,
           approved_by = COALESCE(?, approved_by),
           approved_at = CASE WHEN ? IS NULL THEN approved_at ELSE ? END
         WHERE id = ? AND status IN (${placeholders})`,
      )
      .run(to, now, "reason" in extra ? 1 : 0, extra.reason ?? null, extra.approvedBy ?? null, extra.approvedBy ?? null, now, id, ...from);
    return result.changes > 0;
  }

  /** Pending plans whose approval window has passed. */
  expiredPlans(now: Date): PlanRow[] {
    const ids = this.db
      .prepare("SELECT id FROM plans WHERE status = 'pending_approval' AND expires_at <= ?")
      .all(now.toISOString()) as { id: string }[];
    return ids.map((r) => this.getPlan(r.id)!);
  }

  /** Plans that were executing when the process stopped; their in-flight step has an unknown outcome. */
  interruptedPlans(): string[] {
    return (this.db.prepare("SELECT id FROM plans WHERE status IN ('executing', 'approved')").all() as { id: string }[]).map((r) => r.id);
  }

  getSteps(planId: string): StepRow[] {
    const rows = this.db
      .prepare("SELECT * FROM plan_steps WHERE plan_id = ? ORDER BY position")
      .all(planId) as { step_id: string; state: StepState; attempt: number; request_json: string | null; response_json: string | null; result_id: string | null; error: string | null }[];
    return rows.map((r) => ({
      stepId: r.step_id,
      state: r.state,
      attempt: r.attempt,
      request: r.request_json ? JSON.parse(r.request_json) : null,
      response: r.response_json ? JSON.parse(r.response_json) : null,
      resultId: r.result_id,
      error: r.error,
    }));
  }

  /** Recorded before the request is sent, so a crash leaves evidence that it may have happened. */
  markStepInFlight(planId: string, stepId: string, request: unknown): void {
    this.db
      .prepare("UPDATE plan_steps SET state = 'in_flight', attempt = attempt + 1, request_json = ?, error = NULL, updated_at = ? WHERE plan_id = ? AND step_id = ?")
      .run(JSON.stringify(request), new Date().toISOString(), planId, stepId);
  }

  finishStep(planId: string, stepId: string, outcome: { state: "done"; response: unknown; resultId: string | null } | { state: "failed" | "skipped"; error: string }): void {
    const now = new Date().toISOString();
    if (outcome.state === "done") {
      this.db
        .prepare("UPDATE plan_steps SET state = 'done', response_json = ?, result_id = ?, error = NULL, updated_at = ? WHERE plan_id = ? AND step_id = ?")
        .run(JSON.stringify(outcome.response ?? null), outcome.resultId, now, planId, stepId);
    } else {
      this.db
        .prepare("UPDATE plan_steps SET state = ?, error = ?, updated_at = ? WHERE plan_id = ? AND step_id = ?")
        .run(outcome.state, outcome.error, now, planId, stepId);
    }
  }

  saveSnapshot(planId: string, stepId: string, resource: string, data: unknown): void {
    this.db
      .prepare("INSERT INTO snapshots (plan_id, step_id, resource, data_json, taken_at) VALUES (?, ?, ?, ?, ?)")
      .run(planId, stepId, resource, data === null ? null : JSON.stringify(data), new Date().toISOString());
  }

  /** The latest snapshot taken for a step (the one right before its last attempt). */
  getSnapshot(planId: string, stepId: string): { resource: string; data: Record<string, unknown> | null } | undefined {
    const row = this.db
      .prepare("SELECT resource, data_json FROM snapshots WHERE plan_id = ? AND step_id = ? ORDER BY id DESC LIMIT 1")
      .get(planId, stepId) as { resource: string; data_json: string | null } | undefined;
    if (!row) return undefined;
    return { resource: row.resource, data: row.data_json ? (JSON.parse(row.data_json) as Record<string, unknown>) : null };
  }

  deleteSnapshotsBefore(cutoff: Date): void {
    this.db.prepare("DELETE FROM snapshots WHERE taken_at < ?").run(cutoff.toISOString());
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

  /** The latest time any channel stays awake, if one is awake now. */
  awakeUntil(now: number): number | undefined {
    const row = this.db.prepare("SELECT MAX(awake_until) AS until FROM conversations WHERE awake_until > ?").get(now) as { until: number | null };
    return row.until ?? undefined;
  }

  deleteExpiredConversations(now: number): void {
    this.db.prepare("DELETE FROM conversations WHERE awake_until <= ?").run(now);
  }

  close(): void {
    this.db.close();
  }
}
