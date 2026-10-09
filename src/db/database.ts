import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const MIGRATION_V1 = `
CREATE TABLE conversations (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'tool')),
  content TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('complete', 'incomplete', 'failed', 'cancelled')),
  created_at TEXT NOT NULL
);
CREATE INDEX idx_messages_conversation ON messages(conversation_id, created_at);

CREATE TABLE transcript_items (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL,
  kind TEXT NOT NULL,
  item_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (conversation_id, ordinal)
);

CREATE TABLE notes (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_notes_updated ON notes(updated_at DESC);

CREATE TABLE tool_batches (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('open', 'awaiting_approval', 'continued', 'cancelled', 'failed')),
  created_at TEXT NOT NULL
);

CREATE TABLE tool_executions (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  batch_id TEXT NOT NULL REFERENCES tool_batches(id) ON DELETE CASCADE,
  call_id TEXT NOT NULL UNIQUE,
  ordinal INTEGER NOT NULL,
  tool_name TEXT NOT NULL,
  arguments_json TEXT NOT NULL,
  risk TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending_approval', 'running', 'succeeded', 'failed', 'denied', 'cancelled')),
  result_json TEXT,
  created_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE INDEX idx_tool_executions_batch ON tool_executions(batch_id, ordinal);

CREATE TABLE approval_requests (
  id TEXT PRIMARY KEY,
  tool_execution_id TEXT NOT NULL UNIQUE REFERENCES tool_executions(id) ON DELETE CASCADE,
  conversation_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'denied', 'cancelled')),
  created_at TEXT NOT NULL,
  resolved_at TEXT
);

CREATE TABLE usage_records (
  id TEXT PRIMARY KEY,
  conversation_id TEXT,
  correlation_id TEXT NOT NULL,
  model TEXT NOT NULL,
  input_tokens INTEGER,
  output_tokens INTEGER,
  cached_input_tokens INTEGER,
  estimated_cost_usd REAL,
  latency_ms INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE audit_events (
  id TEXT PRIMARY KEY,
  conversation_id TEXT,
  correlation_id TEXT,
  action TEXT NOT NULL,
  tool_name TEXT,
  outcome TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_audit_created ON audit_events(created_at DESC);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

const MIGRATIONS = [MIGRATION_V1];

export function openDatabase(databasePath: string): DatabaseSync {
  if (databasePath !== ':memory:') {
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  }
  const db = new DatabaseSync(databasePath);
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  try {
    db.exec('PRAGMA journal_mode = WAL');
  } catch {
    // Some filesystems reject WAL. The default journal mode still persists data.
  }
  migrate(db);
  return db;
}

export function migrate(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL
  )`);
  const current = db.prepare('SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations').get() as
    | { version: number }
    | undefined;
  const applied = current?.version ?? 0;
  MIGRATIONS.forEach((sql, index) => {
    const version = index + 1;
    if (version <= applied) return;
    db.exec('BEGIN');
    try {
      db.exec(sql);
      db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(
        version,
        new Date().toISOString(),
      );
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  });
}

export function withTransaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
