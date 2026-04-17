import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { resolveEngramConfig } from "../src/config.js";
import { initializeEngramDatabase } from "../src/plugin/bootstrap.js";

const tempPaths: string[] = [];

afterEach(() => {
  while (tempPaths.length > 0) {
    const current = tempPaths.pop();
    if (current) {
      rmSync(current, { recursive: true, force: true });
    }
  }
});

describe("initializeEngramDatabase", () => {
  it("auto-migrates detected lossless-claw data on first launch", () => {
    const root = mkdtempSync(join(tmpdir(), "engram-bootstrap-"));
    tempPaths.push(root);

    const stateDir = join(root, "state");
    const qmdDir = join(root, "qmd");
    mkdirSync(stateDir, { recursive: true });
    mkdirSync(qmdDir, { recursive: true });
    const lcmPath = join(stateDir, "lcm.db");
    buildLcmFixture(lcmPath);

    const config = resolveEngramConfig({ dbPath: join(root, "engram.db") });
    const result = initializeEngramDatabase(
      config,
      { OPENCLAW_STATE_DIR: stateDir, QMD_CACHE_DIR: qmdDir } as NodeJS.ProcessEnv,
    );

    try {
      expect(result.migrationReport?.dryRun).toBe(false);
      const messagesRow = result.database.db
        .prepare("SELECT COUNT(*) AS count FROM messages")
        .get() as { count?: number } | undefined;
      const importsRow = result.database.db
        .prepare("SELECT COUNT(*) AS count FROM engram_import_runs WHERE source_kind = 'lossless-claw'")
        .get() as { count?: number } | undefined;

      expect(messagesRow?.count).toBe(1);
      expect(importsRow?.count).toBe(1);
    } finally {
      result.database.close();
    }
  });

  it("does not auto-migrate when the Engram database already exists", () => {
    const root = mkdtempSync(join(tmpdir(), "engram-bootstrap-existing-"));
    tempPaths.push(root);

    const stateDir = join(root, "state");
    const qmdDir = join(root, "qmd");
    mkdirSync(stateDir, { recursive: true });
    mkdirSync(qmdDir, { recursive: true });
    buildLcmFixture(join(stateDir, "lcm.db"));

    const config = resolveEngramConfig({ dbPath: join(root, "engram.db") });
    const initial = initializeEngramDatabase(
      config,
      { OPENCLAW_STATE_DIR: stateDir, QMD_CACHE_DIR: qmdDir } as NodeJS.ProcessEnv,
    );
    initial.database.close();

    const result = initializeEngramDatabase(
      config,
      { OPENCLAW_STATE_DIR: stateDir, QMD_CACHE_DIR: qmdDir } as NodeJS.ProcessEnv,
    );

    try {
      expect(result.migrationReport).toBeUndefined();
    } finally {
      result.database.close();
    }
  });
});

function buildLcmFixture(filePath: string): void {
  const db = new DatabaseSync(filePath);
  db.exec(`
    CREATE TABLE conversations (conversation_id INTEGER PRIMARY KEY, session_id TEXT, session_key TEXT, created_at TEXT);
    CREATE TABLE messages (message_id INTEGER PRIMARY KEY, conversation_id INTEGER, seq INTEGER, role TEXT, content TEXT, token_count INTEGER, created_at TEXT);
    CREATE TABLE message_parts (part_id TEXT PRIMARY KEY, message_id INTEGER, session_id TEXT, part_type TEXT, ordinal INTEGER, text_content TEXT, tool_call_id TEXT, tool_name TEXT, tool_input TEXT, tool_output TEXT, metadata TEXT);
    CREATE TABLE summaries (summary_id TEXT PRIMARY KEY, conversation_id INTEGER, kind TEXT, depth INTEGER, content TEXT, token_count INTEGER, created_at TEXT);
    CREATE TABLE summary_messages (summary_id TEXT, message_id TEXT, ordinal INTEGER);
    CREATE TABLE summary_parents (summary_id TEXT, parent_summary_id TEXT, ordinal INTEGER);
    CREATE TABLE context_items (conversation_id INTEGER, ordinal INTEGER, item_type TEXT, message_id INTEGER, summary_id TEXT, created_at TEXT);
    CREATE TABLE large_files (file_id TEXT PRIMARY KEY, conversation_id INTEGER, file_name TEXT, mime_type TEXT, byte_size INTEGER, storage_uri TEXT, exploration_summary TEXT, created_at TEXT);
    CREATE TABLE conversation_bootstrap_state (conversation_id INTEGER PRIMARY KEY, session_file_path TEXT, last_seen_size INTEGER, last_seen_mtime_ms INTEGER, last_processed_offset INTEGER, updated_at TEXT);
  `);
  db.exec(`
    INSERT INTO conversations VALUES (1, 's1', 'k1', datetime('now'));
    INSERT INTO messages VALUES (1, 1, 0, 'user', 'hello', 1, datetime('now'));
    INSERT INTO message_parts VALUES ('part-1', 1, 's1', 'text', 0, 'hello', NULL, NULL, NULL, NULL, NULL);
    INSERT INTO context_items VALUES (1, 0, 'message', 1, NULL, datetime('now'));
  `);
  db.close();
}
