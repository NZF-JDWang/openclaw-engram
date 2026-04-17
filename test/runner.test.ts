import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { formatMigrationReport, runMigrationDryRun } from "../src/migrate/runner.js";

const tempPaths: string[] = [];

afterEach(() => {
  while (tempPaths.length > 0) {
    const current = tempPaths.pop();
    if (current) {
      rmSync(current, { recursive: true, force: true });
    }
  }
});

describe("runMigrationDryRun", () => {
  it("reports counts for detected lossless-claw and qmd databases", () => {
    const root = mkdtempSync(join(tmpdir(), "engram-runner-"));
    tempPaths.push(root);

    const stateDir = join(root, "state");
    const qmdDir = join(root, "qmd");
    mkdirSync(stateDir, { recursive: true });
    mkdirSync(qmdDir, { recursive: true });

    const lcmPath = join(stateDir, "lcm.db");
    const qmdPath = join(qmdDir, "index.sqlite");
    buildLcmFixture(lcmPath);
    buildQmdFixture(qmdPath);

    const report = runMigrationDryRun({
      OPENCLAW_STATE_DIR: stateDir,
      QMD_CACHE_DIR: qmdDir,
    } as NodeJS.ProcessEnv);

    expect(report.dryRun).toBe(true);
    expect(report.inspections).toHaveLength(2);
    expect(report.inspections[0]?.counts.find((entry) => entry.table === "messages")?.count).toBe(1);
    expect(report.inspections[1]?.counts.find((entry) => entry.table === "documents")?.count).toBe(1);
    expect(formatMigrationReport(report)).toContain("Engram migration dry-run");
  });

  it("warns when qmd vector table is missing", () => {
    const root = mkdtempSync(join(tmpdir(), "engram-runner-qmd-"));
    tempPaths.push(root);

    const qmdDir = join(root, "qmd");
    mkdirSync(qmdDir, { recursive: true });
    const qmdPath = join(qmdDir, "index.sqlite");
    buildQmdFixture(qmdPath, { withVectorsVec: false });

    const report = runMigrationDryRun({ QMD_CACHE_DIR: qmdDir } as NodeJS.ProcessEnv);

    expect(report.inspections).toHaveLength(1);
    expect(report.inspections[0]?.warnings[0]).toContain("vectors_vec");
  });
});

function buildLcmFixture(filePath: string): void {
  const db = new DatabaseSync(filePath);
  db.exec(`
    CREATE TABLE conversations (conversation_id INTEGER PRIMARY KEY, session_id TEXT, session_key TEXT, created_at TEXT);
    CREATE TABLE messages (message_id INTEGER PRIMARY KEY, conversation_id INTEGER, role TEXT, content TEXT, created_at TEXT);
    CREATE TABLE message_parts (part_id TEXT PRIMARY KEY, message_id INTEGER, session_id TEXT, part_type TEXT, ordinal INTEGER);
    CREATE TABLE summaries (summary_id TEXT PRIMARY KEY, conversation_id INTEGER, kind TEXT, depth INTEGER, content TEXT, created_at TEXT);
    CREATE TABLE summary_messages (summary_id TEXT, message_id INTEGER, ordinal INTEGER);
    CREATE TABLE summary_parents (summary_id TEXT, parent_summary_id TEXT, ordinal INTEGER);
    CREATE TABLE context_items (conversation_id INTEGER, ordinal INTEGER, item_type TEXT, message_id INTEGER, summary_id TEXT);
    CREATE TABLE large_files (file_id TEXT PRIMARY KEY, conversation_id INTEGER, storage_uri TEXT, created_at TEXT);
    CREATE TABLE conversation_bootstrap_state (conversation_id INTEGER PRIMARY KEY, session_file_path TEXT, last_seen_size INTEGER, last_seen_mtime_ms INTEGER, last_processed_offset INTEGER, updated_at TEXT);
  `);
  db.exec(`
    INSERT INTO conversations VALUES (1, 'session-1', 'session-key-1', datetime('now'));
    INSERT INTO messages VALUES (1, 1, 'user', 'hello', datetime('now'));
    INSERT INTO message_parts VALUES ('part-1', 1, 'session-1', 'text', 0);
    INSERT INTO context_items VALUES (1, 0, 'message', 1, NULL);
  `);
  db.close();
}

function buildQmdFixture(filePath: string, options: { withVectorsVec?: boolean } = {}): void {
  const db = new DatabaseSync(filePath);
  db.exec(`
    CREATE TABLE content (hash TEXT PRIMARY KEY, doc TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE documents (id INTEGER PRIMARY KEY AUTOINCREMENT, collection TEXT NOT NULL, path TEXT NOT NULL, title TEXT NOT NULL, hash TEXT NOT NULL, created_at TEXT NOT NULL, modified_at TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE content_vectors (hash TEXT NOT NULL, seq INTEGER NOT NULL DEFAULT 0, pos INTEGER NOT NULL DEFAULT 0, model TEXT NOT NULL, embedded_at TEXT NOT NULL, PRIMARY KEY (hash, seq));
    CREATE TABLE store_collections (name TEXT PRIMARY KEY, path TEXT NOT NULL, pattern TEXT NOT NULL DEFAULT '**/*.md');
  `);
  if (options.withVectorsVec !== false) {
    db.exec(`CREATE TABLE vectors_vec (hash_seq TEXT PRIMARY KEY, embedding BLOB);`);
  }
  db.exec(`
    INSERT INTO content VALUES ('hash-1', '# Hello', datetime('now'));
    INSERT INTO documents (collection, path, title, hash, created_at, modified_at, active) VALUES ('docs', 'hello.md', 'Hello', 'hash-1', datetime('now'), datetime('now'), 1);
    INSERT INTO content_vectors VALUES ('hash-1', 0, 0, 'test-model', datetime('now'));
    INSERT INTO store_collections VALUES ('docs', 'C:/docs', '**/*.md');
  `);
  db.close();
}