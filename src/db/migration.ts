import type { DatabaseSync } from "node:sqlite";
import { computeSummaryQualityScore } from "../lifecycle.js";
import { SCHEMA_STATEMENTS, SCHEMA_VERSION } from "./schema.js";

export function runMigrations(db: DatabaseSync): void {
  for (const statement of SCHEMA_STATEMENTS) {
    db.exec(statement);
  }

  ensureFactMetadataColumns(db);
  ensureSummaryQualityColumn(db);
  ensureKbFtsTable(db);
  ensureRecallEventsTable(db);
  ensureMemoryLayerTables(db);

  db.exec(
    `
    INSERT OR IGNORE INTO engram_migrations (version, applied_at, description)
    VALUES (${SCHEMA_VERSION}, datetime('now'), 'Engram schema bootstrap, summary quality tracking, durable-fact metadata expansion, KB FTS support, recall feedback infra, and OpenClaw memory layer tables')
    `,
  );
}

function ensureMemoryLayerTables(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_claims (
      claim_id TEXT PRIMARY KEY,
      source_kind TEXT NOT NULL,
      source_id TEXT NOT NULL,
      content TEXT NOT NULL,
      confidence REAL NOT NULL DEFAULT 0.75,
      freshness TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_memory_claims_source ON memory_claims (source_kind, source_id)
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS engram_commitments (
      commitment_id TEXT PRIMARY KEY,
      content TEXT NOT NULL,
      due_at TEXT,
      status TEXT NOT NULL DEFAULT 'open',
      scope TEXT NOT NULL DEFAULT 'session',
      source_conversation_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at TEXT,
      FOREIGN KEY (source_conversation_id) REFERENCES conversations(conversation_id)
    )
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_engram_commitments_due ON engram_commitments (status, due_at)
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS engram_dream_candidates (
      candidate_id TEXT PRIMARY KEY,
      content TEXT NOT NULL,
      source_kind TEXT NOT NULL,
      source_id TEXT NOT NULL,
      score REAL NOT NULL DEFAULT 0,
      recall_count INTEGER NOT NULL DEFAULT 0,
      query_count INTEGER NOT NULL DEFAULT 0,
      promoted INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_seen_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_engram_dream_candidates_score ON engram_dream_candidates (promoted, score DESC)
  `);
}

function ensureFactMetadataColumns(db: DatabaseSync): void {
  const tableExists = (db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name='kb_facts'").get() as { count?: number })?.count ?? 0;
  if (tableExists === 0) {
    return;
  }
  const columns = new Set(
    (db.prepare("PRAGMA table_info(kb_facts)").all() as Array<{ name?: string }>).map(
      (row) => row.name ?? "",
    ),
  );

  if (!columns.has("source_basis")) {
    db.exec("ALTER TABLE kb_facts ADD COLUMN source_basis TEXT");
  }
  if (!columns.has("scope")) {
    db.exec("ALTER TABLE kb_facts ADD COLUMN scope TEXT NOT NULL DEFAULT 'session'");
  }
  if (!columns.has("superseded_by")) {
    db.exec("ALTER TABLE kb_facts ADD COLUMN superseded_by TEXT");
  }
  if (!columns.has("deprecated_at")) {
    db.exec("ALTER TABLE kb_facts ADD COLUMN deprecated_at TEXT");
  }
  if (!columns.has("deprecated_reason")) {
    db.exec("ALTER TABLE kb_facts ADD COLUMN deprecated_reason TEXT");
  }
  if (!columns.has("expires_at")) {
    db.exec("ALTER TABLE kb_facts ADD COLUMN expires_at TEXT");
  }

  db.exec(`
    UPDATE kb_facts
    SET source_basis = COALESCE(source_basis, source_kind),
        scope = COALESCE(scope, 'session')
  `);
}

function ensureKbFtsTable(db: DatabaseSync): void {
  try {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS kb_chunks_fts USING fts5(
        chunk_id UNINDEXED,
        doc_id UNINDEXED,
        collection_name UNINDEXED,
        rel_path,
        title,
        content
      )
    `);
  } catch {
    // Leave existing collection metadata untouched; startup should not rewrite
    // the KB just because FTS5 is unavailable in the current runtime.
  }
}

function ensureRecallEventsTable(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS recall_events (
      event_id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      chunk_id TEXT NOT NULL,
      injected_score REAL NOT NULL,
      was_referenced INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (chunk_id) REFERENCES kb_chunks(chunk_id) ON DELETE CASCADE
    )
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_recall_events_conversation_id ON recall_events (conversation_id)
  `);
}

function ensureSummaryQualityColumn(db: DatabaseSync): void {
  const columns = new Set(
    (db.prepare("PRAGMA table_info(summaries)").all() as Array<{ name?: string }>).map(
      (row) => row.name ?? "",
    ),
  );

  if (!columns.has("quality_score")) {
    db.exec("ALTER TABLE summaries ADD COLUMN quality_score INTEGER NOT NULL DEFAULT 0");
  }

  const rows = db.prepare(`
    SELECT summary_id, content
    FROM summaries
    WHERE COALESCE(quality_score, 0) = 0
  `).all() as Array<{ summary_id: string; content: string }>;

  const update = db.prepare(`
    UPDATE summaries
    SET quality_score = ?
    WHERE summary_id = ?
  `);
  for (const row of rows) {
    update.run(computeSummaryQualityScore(row.content, 50), row.summary_id);
  }
}
