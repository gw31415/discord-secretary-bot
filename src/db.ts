import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { open, seal } from "./crypto.ts";
import { isKeyProviderId, isProviderId } from "./llm/models.ts";
import type { KeyProviderId, ProviderId } from "./llm/models.ts";
import { isWebTool } from "./agent/web.ts";
import type { WebTool } from "./agent/web.ts";
import type { Actor, Plan, PlanStatus, StepState } from "./plan/types.ts";
import type { Rule, RuleDefinition, RuleRun, RunOutcome } from "./rules/types.ts";
import type { ModuleInfo } from "./wasm/module.ts";
import { triggerEvents } from "./rules/triggers.ts";

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
  `
  CREATE TABLE rules (
    id TEXT PRIMARY KEY,
    guild_id TEXT NOT NULL,
    owner_id TEXT NOT NULL,
    name TEXT NOT NULL,
    rule_json TEXT NOT NULL,
    version INTEGER NOT NULL,
    enabled INTEGER NOT NULL,
    consecutive_failures INTEGER NOT NULL DEFAULT 0,
    disabled_reason TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX rules_guild ON rules (guild_id, enabled);
  CREATE TABLE rule_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    rule_id TEXT NOT NULL,
    rule_version INTEGER NOT NULL,
    event_id TEXT NOT NULL,
    plan_id TEXT,
    outcome TEXT NOT NULL,
    error TEXT,
    logs_json TEXT,
    started_at TEXT NOT NULL,
    finished_at TEXT
  );
  CREATE INDEX rule_runs_rule ON rule_runs (rule_id, id);
  CREATE INDEX audit_log_at ON audit_log (at);
  `,
  `
  ALTER TABLE user_settings ADD COLUMN code_provider TEXT;
  ALTER TABLE user_settings ADD COLUMN code_model TEXT;
  `,
  `
  ALTER TABLE user_settings ADD COLUMN reaction_provider TEXT;
  ALTER TABLE user_settings ADD COLUMN reaction_model TEXT;
  `,
  `
  ALTER TABLE rules ADD COLUMN state_json TEXT;
  `,
  `
  CREATE TABLE wasm_modules (
    owner_id TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    name TEXT NOT NULL,
    data BLOB NOT NULL,
    size INTEGER NOT NULL,
    info_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (owner_id, sha256)
  );
  CREATE INDEX wasm_modules_sha ON wasm_modules (sha256);
  CREATE TABLE js_bytecode (
    key TEXT PRIMARY KEY,
    data BLOB NOT NULL,
    used_at TEXT NOT NULL
  );
  `,
  `
  UPDATE rules SET rule_json = json_remove(json_set(rule_json, '$.program',
    CASE WHEN json_extract(rule_json, '$.wasm') IS NOT NULL
      THEN json_object('kind', 'wasm', 'sha256', json_extract(rule_json, '$.wasm'))
      ELSE json_object('kind', 'js', 'code', coalesce(json_extract(rule_json, '$.code'), '')) END), '$.code', '$.wasm')
  WHERE json_extract(rule_json, '$.program') IS NULL;
  `,
];

export interface ModelRef {
  provider: ProviderId;
  model: string;
}

export interface UserSettings {
  response: ModelRef | null;
  /** Judgments of every kind; unset means the response model judges. */
  judge: ModelRef | null;
  /** Whether a message is addressed to the bot; unset means the judge model. */
  addressee: ModelRef | null;
  /** Writes the agent's code (run_code, plans, rules). Unset means the response model writes it. */
  code: ModelRef | null;
  /** Decides whether to answer with a reaction alone, and which. Unset leaves reactions to the response model. */
  reaction: ModelRef | null;
  /** The web service the agent uses. Unset means the response model's own. */
  web: WebTool;
  /**
   * Reading beyond what everyone in the channel can see, up to the person's own
   * permissions: "ask" puts a button in front of them each time, "always" allows it.
   */
  readScope: ReadScopeSetting;
}

export type ReadScopeSetting = "ask" | "always";

export interface KeySummary {
  provider: KeyProviderId;
  last4: string;
}

export interface ConversationRow {
  channelId: string;
  startedBy: string;
  awakeUntil: number;
}

export type AuditActor = Actor | { kind: "system" };

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

export interface AuditEntry {
  id: number;
  at: string;
  actor: AuditActor;
  action: string;
  planId: string | null;
  ruleId: string | null;
  detail: Record<string, unknown>;
}

/** later() requests waiting for their time (see RuleEngine). */
const RULE_TIMERS = `
  CREATE TABLE IF NOT EXISTS rule_timers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    rule_id TEXT NOT NULL,
    guild_id TEXT NOT NULL,
    actor_id TEXT,
    due_at INTEGER NOT NULL,
    chain INTEGER NOT NULL,
    channel_id TEXT,
    message_id TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS rule_timers_due ON rule_timers (guild_id, due_at);
  CREATE INDEX IF NOT EXISTS rule_timers_rule ON rule_timers (rule_id);
`;

/** A later() request of a rule's run, waiting for its time. */
export interface RuleTimer {
  id: number;
  ruleId: string;
  guildId: string;
  /** Whom the run that asked acted as; null for the rule's owner. */
  actorId: string | null;
  dueAt: number;
  /** How many later() requests in a row led here, this one included: 1 unless a TIMER run asked for it. */
  chain: number;
  /** For a command's run, the message its reply became. */
  message: { channelId: string; messageId: string } | null;
  createdAt: string;
}

export interface WasmModule {
  ownerId: string;
  sha256: string;
  name: string;
  size: number;
  info: ModuleInfo;
  createdAt: string;
  /** Set when the bot built it from source (the files themselves: wasmSource). */
  source?: { language: string; files: number };
}

/** The sources a module was compiled from, kept with it. */
export interface WasmSource {
  language: string;
  /** The language build that compiled it. */
  version: string;
  files: Array<{ path: string; content: string }>;
}

interface WasmModuleRow {
  owner_id: string;
  sha256: string;
  name: string;
  size: number;
  info_json: string;
  created_at: string;
  source_language: string | null;
  source_files: number | null;
}

const WASM_COLUMNS = "owner_id, sha256, name, size, info_json, created_at, json_extract(source_json, '$.language') AS source_language, json_array_length(source_json, '$.files') AS source_files";

function toWasmModule(row: WasmModuleRow): WasmModule {
  return {
    ownerId: row.owner_id,
    sha256: row.sha256,
    name: row.name,
    size: row.size,
    info: JSON.parse(row.info_json) as ModuleInfo,
    createdAt: row.created_at,
    ...(row.source_language ? { source: { language: row.source_language, files: row.source_files ?? 0 } } : {}),
  };
}

interface RuleDbRow {
  id: string;
  guild_id: string;
  owner_id: string;
  rule_json: string;
  version: number;
  enabled: number;
  consecutive_failures: number;
  disabled_reason: string | null;
  created_at: string;
  updated_at: string;
}

function definitionOf(rule: RuleDefinition): RuleDefinition {
  const { name, sourcePrompt, trigger, allow, program, params, summary, limits } = rule;
  return { name, sourcePrompt, trigger, allow, program, ...(params ? { params } : {}), summary, limits };
}

function toRule(row: RuleDbRow): Rule {
  return {
    ...definitionOf(JSON.parse(row.rule_json) as RuleDefinition),
    id: row.id,
    guildId: row.guild_id,
    ownerId: row.owner_id,
    version: row.version,
    enabled: row.enabled === 1,
    consecutiveFailures: row.consecutive_failures,
    disabledReason: row.disabled_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
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
    this.#ensureColumn("user_settings", "read_scope", "TEXT");
    this.#ensureColumn("user_settings", "addressee_provider", "TEXT");
    this.#ensureColumn("user_settings", "addressee_model", "TEXT");
    this.#ensureColumn("wasm_modules", "source_json", "TEXT");
    // Like the columns above, outside the numbered migrations.
    this.db.exec(RULE_TIMERS);
    // Claude's web tools are no longer a choice of their own: they are the standard for a Claude model.
    this.db.exec("UPDATE user_settings SET web_tool = 'auto' WHERE web_tool = 'anthropic'");
  }

  /**
   * Columns added outside the numbered migrations, so branches that each add
   * migrations do not have to agree on their order. Safe to run every start.
   */
  #ensureColumn(table: string, column: string, type: string): void {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (!columns.some((c) => c.name === column)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
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

  deleteMeta(key: string): void {
    this.db.prepare("DELETE FROM meta WHERE key = ?").run(key);
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
      | { default_provider: string | null; default_model: string | null; judge_provider: string | null; judge_model: string | null; addressee_provider: string | null; addressee_model: string | null; code_provider: string | null; code_model: string | null; reaction_provider: string | null; reaction_model: string | null; web_tool: string | null; read_scope: string | null }
      | undefined;
    const ref = (provider: string | null | undefined, model: string | null | undefined): ModelRef | null =>
      provider && model && isProviderId(provider) ? { provider, model } : null;
    return {
      response: ref(row?.default_provider, row?.default_model),
      judge: ref(row?.judge_provider, row?.judge_model),
      addressee: ref(row?.addressee_provider, row?.addressee_model),
      code: ref(row?.code_provider, row?.code_model),
      reaction: ref(row?.reaction_provider, row?.reaction_model),
      web: row?.web_tool && isWebTool(row.web_tool) ? row.web_tool : "auto",
      readScope: row?.read_scope === "always" ? "always" : "ask",
    };
  }

  setReadScope(userId: string, scope: ReadScopeSetting): void {
    this.db.prepare("INSERT INTO user_settings (user_id) VALUES (?) ON CONFLICT(user_id) DO NOTHING").run(userId);
    this.db.prepare("UPDATE user_settings SET read_scope = ? WHERE user_id = ?").run(scope, userId);
  }

  setWebTool(userId: string, tool: WebTool): void {
    this.db.prepare("INSERT INTO user_settings (user_id) VALUES (?) ON CONFLICT(user_id) DO NOTHING").run(userId);
    this.db.prepare("UPDATE user_settings SET web_tool = ? WHERE user_id = ?").run(tool, userId);
  }

  setModel(userId: string, role: "response" | "judge" | "addressee" | "code" | "reaction", ref: ModelRef | null): void {
    const [providerCol, modelCol] = {
      response: ["default_provider", "default_model"],
      judge: ["judge_provider", "judge_model"],
      addressee: ["addressee_provider", "addressee_model"],
      code: ["code_provider", "code_model"],
      reaction: ["reaction_provider", "reaction_model"],
    }[role];
    this.db.prepare("INSERT INTO user_settings (user_id) VALUES (?) ON CONFLICT(user_id) DO NOTHING").run(userId);
    this.db
      .prepare(`UPDATE user_settings SET ${providerCol} = ?, ${modelCol} = ? WHERE user_id = ?`)
      .run(ref?.provider ?? null, ref?.model ?? null, userId);
  }

  // --- Audit log (append only) --------------------------------------------

  audit(actor: AuditActor, action: string, detail: Record<string, unknown> = {}, planId?: string, ruleId?: string): void {
    this.db
      .prepare("INSERT INTO audit_log (at, actor_json, action, plan_id, rule_id, detail_json) VALUES (?, ?, ?, ?, ?, ?)")
      .run(new Date().toISOString(), JSON.stringify(actor), action, planId ?? null, ruleId ?? null, JSON.stringify(detail));
  }

  /**
   * Newest first. With a user, only entries that person made (their rules
   * included); otherwise the server's entries: its plans, its rules, and
   * entries that name it.
   */
  auditEntries(options: { guildId: string; userId?: string; limit: number }): AuditEntry[] {
    const rows = (
      options.userId
        ? this.db
            .prepare("SELECT * FROM audit_log WHERE json_extract(actor_json, '$.userId') = ? ORDER BY id DESC LIMIT ?")
            .all(options.userId, options.limit)
        : this.db
            .prepare(
              `SELECT * FROM audit_log
               WHERE plan_id IN (SELECT id FROM plans WHERE guild_id = ?)
                  OR rule_id IN (SELECT id FROM rules WHERE guild_id = ?)
                  OR json_extract(detail_json, '$.guildId') = ?
               ORDER BY id DESC LIMIT ?`,
            )
            .all(options.guildId, options.guildId, options.guildId, options.limit)
    ) as { id: number; at: string; actor_json: string; action: string; plan_id: string | null; rule_id: string | null; detail_json: string }[];
    return rows.map((r) => ({
      id: r.id,
      at: r.at,
      actor: JSON.parse(r.actor_json) as AuditActor,
      action: r.action,
      planId: r.plan_id,
      ruleId: r.rule_id,
      detail: JSON.parse(r.detail_json) as Record<string, unknown>,
    }));
  }

  // --- Plans --------------------------------------------------------------

  /** A rule's plan starts approved: its owner approved the rule. */
  insertPlan(plan: Plan, status: "pending_approval" | "approved" = "pending_approval"): void {
    const now = new Date().toISOString();
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO plans (id, guild_id, actor_json, plan_json, hash, risk, status, created_at, expires_at, updated_at, approved_by, approved_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          plan.id, plan.guildId, JSON.stringify(plan.actor), JSON.stringify(plan), plan.hash, plan.risk, status, plan.createdAt, plan.expiresAt, now,
          status === "approved" ? plan.actor.userId : null, status === "approved" ? now : null,
        );
      const step = this.db.prepare(
        "INSERT INTO plan_steps (plan_id, step_id, position, state, updated_at) VALUES (?, ?, ?, 'pending', ?)",
      );
      plan.steps.forEach((s, i) => step.run(plan.id, s.id, i, now));
    })();
  }

  /** Swaps in a changed version of a plan that still waits for approval; false once it does not. */
  replacePendingPlan(plan: Plan): boolean {
    const result = this.db
      .prepare("UPDATE plans SET plan_json = ?, hash = ?, risk = ?, updated_at = ? WHERE id = ? AND status = 'pending_approval'")
      .run(JSON.stringify(plan), plan.hash, plan.risk, new Date().toISOString(), plan.id);
    return result.changes === 1;
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

  /** Newest first, in one server; with a user, only the plans made for them. */
  recentPlans(options: { guildId: string; userId?: string; limit: number }): Array<PlanRow & { updatedAt: string }> {
    const rows = (
      options.userId
        ? this.db
            .prepare("SELECT id, updated_at FROM plans WHERE guild_id = ? AND json_extract(actor_json, '$.userId') = ? ORDER BY created_at DESC LIMIT ?")
            .all(options.guildId, options.userId, options.limit)
        : this.db.prepare("SELECT id, updated_at FROM plans WHERE guild_id = ? ORDER BY created_at DESC LIMIT ?").all(options.guildId, options.limit)
    ) as { id: string; updated_at: string }[];
    return rows.map((r) => ({ ...this.getPlan(r.id)!, updatedAt: r.updated_at }));
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

  // --- Rules --------------------------------------------------------------

  insertRule(rule: Rule): void {
    this.db
      .prepare(
        `INSERT INTO rules (id, guild_id, owner_id, name, rule_json, version, enabled, consecutive_failures, disabled_reason, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(rule.id, rule.guildId, rule.ownerId, rule.name, JSON.stringify(definitionOf(rule)), rule.version, rule.enabled ? 1 : 0, rule.consecutiveFailures, rule.disabledReason, rule.createdAt, rule.updatedAt);
  }

  /** A new approved version replaces the definition and starts it fresh. */
  updateRuleDefinition(id: string, definition: RuleDefinition, version: number): void {
    this.db
      .prepare("UPDATE rules SET name = ?, rule_json = ?, version = ?, enabled = 1, consecutive_failures = 0, disabled_reason = NULL, updated_at = ? WHERE id = ?")
      .run(definition.name, JSON.stringify(definitionOf(definition)), version, new Date().toISOString(), id);
  }

  /** Changes a setting of a rule (not its code or allow list), keeping its version and whether it is on. */
  updateRuleSettings(id: string, definition: RuleDefinition): void {
    this.db.prepare("UPDATE rules SET rule_json = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(definitionOf(definition)), new Date().toISOString(), id);
  }

  getRule(id: string): Rule | undefined {
    const row = this.db.prepare("SELECT * FROM rules WHERE id = ?").get(id) as RuleDbRow | undefined;
    return row && toRule(row);
  }

  listRules(guildId: string, ownerId?: string): Rule[] {
    const rows = (
      ownerId
        ? this.db.prepare("SELECT * FROM rules WHERE guild_id = ? AND owner_id = ? ORDER BY created_at").all(guildId, ownerId)
        : this.db.prepare("SELECT * FROM rules WHERE guild_id = ? ORDER BY created_at").all(guildId)
    ) as RuleDbRow[];
    return rows.map(toRule);
  }

  enabledRules(guildId: string, event: string): Rule[] {
    return this.listRules(guildId).filter((r) => r.enabled && triggerEvents(r.trigger).includes(event));
  }

  setRuleEnabled(id: string, enabled: boolean, reason: string | null): void {
    this.db
      .prepare("UPDATE rules SET enabled = ?, disabled_reason = ?, consecutive_failures = CASE WHEN ? THEN 0 ELSE consecutive_failures END, updated_at = ? WHERE id = ?")
      .run(enabled ? 1 : 0, enabled ? null : reason, enabled ? 1 : 0, new Date().toISOString(), id);
  }

  /** Counts a failed run; returns the count in a row. A success resets it. */
  recordRuleResult(id: string, failed: boolean): number {
    this.db
      .prepare("UPDATE rules SET consecutive_failures = CASE WHEN ? THEN consecutive_failures + 1 ELSE 0 END WHERE id = ?")
      .run(failed ? 1 : 0, id);
    return (this.db.prepare("SELECT consecutive_failures AS n FROM rules WHERE id = ?").get(id) as { n: number } | undefined)?.n ?? 0;
  }

  /** What the rule's code saved with setState on its last successful run; null when none. */
  getRuleState(id: string): unknown {
    const row = this.db.prepare("SELECT state_json FROM rules WHERE id = ?").get(id) as { state_json: string | null } | undefined;
    return row?.state_json ? JSON.parse(row.state_json) : null;
  }

  /** Null clears it. */
  setRuleState(id: string, state: unknown): void {
    this.db.prepare("UPDATE rules SET state_json = ? WHERE id = ?").run(state === null || state === undefined ? null : JSON.stringify(state), id);
  }

  // --- Rule timers (later()) ------------------------------------------------

  /** Keeps a run's later() requests; `actorId` null means the rule's owner. Returns their ids. */
  addRuleTimers(ruleId: string, guildId: string, actorId: string | null, timers: { dueAt: number; chain: number }[]): number[] {
    const insert = this.db.prepare("INSERT INTO rule_timers (rule_id, guild_id, actor_id, due_at, chain, created_at) VALUES (?, ?, ?, ?, ?, ?)");
    const at = new Date().toISOString();
    return this.db.transaction(() => timers.map((t) => Number(insert.run(ruleId, guildId, actorId, t.dueAt, t.chain, at).lastInsertRowid)))();
  }

  /** The message a command's reply became, for the TIMER runs its run asked for. */
  setRuleTimersMessage(ids: number[], channelId: string, messageId: string): void {
    const update = this.db.prepare("UPDATE rule_timers SET channel_id = ?, message_id = ? WHERE id = ?");
    this.db.transaction(() => ids.forEach((id) => update.run(channelId, messageId, id)))();
  }

  countRuleTimers(ruleId: string): number {
    return (this.db.prepare("SELECT count(*) AS n FROM rule_timers WHERE rule_id = ?").get(ruleId) as { n: number }).n;
  }

  /** Removes and returns the server's timers that are due, oldest first; each is handed out once. */
  takeDueRuleTimers(guildId: string, now: number, limit = 100): RuleTimer[] {
    return this.db.transaction(() => {
      const rows = this.db
        .prepare("SELECT * FROM rule_timers WHERE guild_id = ? AND due_at <= ? ORDER BY due_at, id LIMIT ?")
        .all(guildId, now, limit) as Array<{ id: number; rule_id: string; guild_id: string; actor_id: string | null; due_at: number; chain: number; channel_id: string | null; message_id: string | null; created_at: string }>;
      const remove = this.db.prepare("DELETE FROM rule_timers WHERE id = ?");
      for (const row of rows) remove.run(row.id);
      return rows.map((r) => ({
        id: r.id,
        ruleId: r.rule_id,
        guildId: r.guild_id,
        actorId: r.actor_id,
        dueAt: r.due_at,
        chain: r.chain,
        message: r.channel_id && r.message_id ? { channelId: r.channel_id, messageId: r.message_id } : null,
        createdAt: r.created_at,
      }));
    })();
  }

  deleteRule(id: string): void {
    this.db.prepare("DELETE FROM rule_timers WHERE rule_id = ?").run(id);
    this.db.prepare("DELETE FROM rules WHERE id = ?").run(id);
  }

  // --- Compiled JavaScript -------------------------------------------------

  getBytecode(key: string): Buffer | undefined {
    const row = this.db.prepare("SELECT data FROM js_bytecode WHERE key = ?").get(key) as { data: Buffer } | undefined;
    if (row) this.db.prepare("UPDATE js_bytecode SET used_at = ? WHERE key = ?").run(new Date().toISOString(), key);
    return row?.data;
  }

  setBytecode(key: string, data: Buffer): void {
    this.db.prepare("INSERT OR REPLACE INTO js_bytecode (key, data, used_at) VALUES (?, ?, ?)").run(key, data, new Date().toISOString());
  }

  /** Programs no run has used since `cutoff` (old rule versions, earlier engine builds). */
  deleteBytecodeBefore(cutoff: Date): void {
    this.db.prepare("DELETE FROM js_bytecode WHERE used_at < ?").run(cutoff.toISOString());
  }

  // --- Wasm modules ---------------------------------------------------------

  /** Keeps an uploaded module; the same bytes from the same person just take the new name (and the sources, when given). */
  saveWasmModule(ownerId: string, name: string, data: Buffer, info: ModuleInfo, source?: WasmSource): WasmModule {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO wasm_modules (owner_id, sha256, name, data, size, info_json, created_at, source_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (owner_id, sha256) DO UPDATE SET name = excluded.name, created_at = excluded.created_at, source_json = coalesce(excluded.source_json, source_json)`,
      )
      .run(ownerId, info.sha256, name, data, data.length, JSON.stringify(info), now, source ? JSON.stringify(source) : null);
    return this.getWasmModule(ownerId, info.sha256)!;
  }

  /** One person's modules, newest first, without their bytes. */
  listWasmModules(ownerId: string): WasmModule[] {
    const rows = this.db.prepare(`SELECT ${WASM_COLUMNS} FROM wasm_modules WHERE owner_id = ? ORDER BY created_at DESC`).all(ownerId) as WasmModuleRow[];
    return rows.map(toWasmModule);
  }

  getWasmModule(ownerId: string, sha256: string): WasmModule | undefined {
    const row = this.db.prepare(`SELECT ${WASM_COLUMNS} FROM wasm_modules WHERE owner_id = ? AND sha256 = ?`).get(ownerId, sha256) as WasmModuleRow | undefined;
    return row && toWasmModule(row);
  }

  /** Everyone who uploaded these bytes, oldest first. */
  wasmUploaders(sha256: string): WasmModule[] {
    const rows = this.db.prepare(`SELECT ${WASM_COLUMNS} FROM wasm_modules WHERE sha256 = ? ORDER BY created_at`).all(sha256) as WasmModuleRow[];
    return rows.map(toWasmModule);
  }

  /** Distinct uploaded builds whose sha256 starts with `prefix` (lowercase hex). */
  wasmShasWithPrefix(prefix: string): string[] {
    const rows = this.db.prepare("SELECT DISTINCT sha256 FROM wasm_modules WHERE substr(sha256, 1, ?) = ? LIMIT 5").all(prefix.length, prefix) as Array<{ sha256: string }>;
    return rows.map((r) => r.sha256);
  }

  /** The sources a build was compiled from, from whoever kept them. */
  wasmSource(sha256: string): WasmSource | undefined {
    const row = this.db.prepare("SELECT source_json FROM wasm_modules WHERE sha256 = ? AND source_json IS NOT NULL LIMIT 1").get(sha256) as { source_json: string } | undefined;
    return row ? (JSON.parse(row.source_json) as WasmSource) : undefined;
  }

  /** The bytes, whoever uploaded them. */
  wasmBytes(sha256: string): Buffer | undefined {
    return (this.db.prepare("SELECT data FROM wasm_modules WHERE sha256 = ? LIMIT 1").get(sha256) as { data: Buffer } | undefined)?.data;
  }

  renameWasmModule(ownerId: string, sha256: string, name: string): void {
    this.db.prepare("UPDATE wasm_modules SET name = ? WHERE owner_id = ? AND sha256 = ?").run(name, ownerId, sha256);
  }

  deleteWasmModule(ownerId: string, sha256: string): void {
    this.db.prepare("DELETE FROM wasm_modules WHERE owner_id = ? AND sha256 = ?").run(ownerId, sha256);
  }

  /** The code of every enabled JS rule, in any server. */
  enabledRuleCode(): string[] {
    const rows = this.db.prepare("SELECT DISTINCT json_extract(rule_json, '$.program.code') AS code FROM rules WHERE enabled = 1 AND json_extract(rule_json, '$.program.kind') = 'js'").all() as Array<{ code: string | null }>;
    return rows.map((r) => r.code ?? "").filter((c) => c.trim());
  }

  /** Builds that enabled rules run, in any server. */
  wasmInUse(): string[] {
    const rows = this.db.prepare("SELECT DISTINCT json_extract(rule_json, '$.program.sha256') AS sha FROM rules WHERE enabled = 1 AND json_extract(rule_json, '$.program.kind') = 'wasm'").all() as Array<{ sha: string }>;
    return rows.map((r) => r.sha);
  }

  /** Rules in any server that run these bytes. */
  rulesUsingWasm(sha256: string): Rule[] {
    const rows = this.db.prepare("SELECT * FROM rules WHERE json_extract(rule_json, '$.program.kind') = 'wasm' AND json_extract(rule_json, '$.program.sha256') = ? ORDER BY created_at").all(sha256) as RuleDbRow[];
    return rows.map(toRule);
  }

  startRuleRun(run: { ruleId: string; ruleVersion: number; eventId: string }): number {
    return Number(
      this.db
        .prepare("INSERT INTO rule_runs (rule_id, rule_version, event_id, outcome, started_at) VALUES (?, ?, ?, 'failed', ?)")
        .run(run.ruleId, run.ruleVersion, run.eventId, new Date().toISOString()).lastInsertRowid,
    );
  }

  finishRuleRun(id: number, result: { outcome: RunOutcome; planId?: string | null; error?: string | null; logs?: string[] }): void {
    this.db
      .prepare("UPDATE rule_runs SET outcome = ?, plan_id = ?, error = ?, logs_json = ?, finished_at = ? WHERE id = ?")
      .run(result.outcome, result.planId ?? null, result.error ?? null, result.logs?.length ? JSON.stringify(result.logs) : null, new Date().toISOString(), id);
  }

  recentRuleRuns(ruleId: string, limit: number): RuleRun[] {
    const rows = this.db.prepare("SELECT * FROM rule_runs WHERE rule_id = ? ORDER BY id DESC LIMIT ?").all(ruleId, limit) as {
      id: number; rule_id: string; rule_version: number; event_id: string; plan_id: string | null; outcome: RunOutcome; error: string | null; logs_json: string | null; started_at: string; finished_at: string | null;
    }[];
    return rows.map((r) => ({
      id: r.id,
      ruleId: r.rule_id,
      ruleVersion: r.rule_version,
      eventId: r.event_id,
      planId: r.plan_id,
      outcome: r.outcome,
      error: r.error,
      logs: r.logs_json ? (JSON.parse(r.logs_json) as string[]) : [],
      startedAt: r.started_at,
      finishedAt: r.finished_at,
    }));
  }

  deleteRuleRunsBefore(cutoff: Date): void {
    this.db.prepare("DELETE FROM rule_runs WHERE started_at < ?").run(cutoff.toISOString());
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
