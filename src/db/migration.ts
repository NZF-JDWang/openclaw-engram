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

  db.exec(
    `
    INSERT OR IGNORE INTO engram_migrations (version, applied_at, description)
    VALUES (${SCHEMA_VERSION}, datetime('now'), 'Engram schema bootstrap, summary quality tracking, durable-fact metadata expansion, and KB FTS support')
    `,
  );
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
