// Each entry upgrades the schema by one version. Never edit an applied entry.
export const MIGRATIONS: string[] = [
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
  // The retention sweep deletes by started_at; without this it scans the whole table.
  `
  CREATE INDEX IF NOT EXISTS rule_runs_started ON rule_runs (started_at);
  `,
];
