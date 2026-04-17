import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase } from "../src/db/connection.js";
import { importFromLcm } from "../src/migrate/lcm-importer.js";

const tempPaths: string[] = [];

afterEach(() => {
  while (tempPaths.length > 0) {
    const current = tempPaths.pop();
    if (current) {
      rmSync(current, { recursive: true, force: true });
    }
  }
});

describe("importFromLcm", () => {
  it("imports lossless-claw conversations, messages, and lineage tables idempotently", () => {
    const root = mkdtempSync(join(tmpdir(), "engram-import-lcm-"));
    tempPaths.push(root);

    const sourcePath = join(root, "lcm.db");
    const destPath = join(root, "engram.db");
    buildLcmFixture(sourcePath);

    const dest = openDatabase(destPath);
    try {
      const first = importFromLcm(sourcePath, dest.db);
      const second = importFromLcm(sourcePath, dest.db);

      const messageCount = (dest.db.prepare(`SELECT COUNT(*) AS count FROM messages`).get() as { count: number }).count;
      const summaryCount = (dest.db.prepare(`SELECT COUNT(*) AS count FROM summaries`).get() as { count: number }).count;
      const importRunCount = (dest.db.prepare(`SELECT COUNT(*) AS count FROM engram_import_runs`).get() as { count: number }).count;

      expect(first.imported).toBe(true);
      expect(first.counts.messages).toBe(1);
      expect(first.counts.summaries).toBe(1);
      expect(second.skipped).toBe(true);
      expect(messageCount).toBe(1);
      expect(summaryCount).toBe(1);
      expect(importRunCount).toBe(1);
    } finally {
      dest.close();
    }
  });
});

function buildLcmFixture(filePath: string): void {
  const db = new DatabaseSync(filePath);
  db.exec(`
    CREATE TABLE conversations (
      conversation_id INTEGER PRIMARY KEY,
      session_id TEXT NOT NULL,
      session_key TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE messages (
      message_id INTEGER PRIMARY KEY,
      conversation_id INTEGER NOT NULL,
      seq INTEGER NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      token_count INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE message_parts (
      part_id TEXT PRIMARY KEY,
      message_id INTEGER NOT NULL,
      session_id TEXT NOT NULL,
      part_type TEXT NOT NULL,
      ordinal INTEGER NOT NULL,
      text_content TEXT,
      tool_call_id TEXT,
      tool_name TEXT,
      tool_input TEXT,
      tool_output TEXT,
      metadata TEXT
    );
    CREATE TABLE summaries (
      summary_id TEXT PRIMARY KEY,
      conversation_id INTEGER NOT NULL,
      kind TEXT NOT NULL,
      depth INTEGER NOT NULL,
      content TEXT NOT NULL,
      token_count INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE summary_messages (
      summary_id TEXT NOT NULL,
      message_id INTEGER NOT NULL,
      ordinal INTEGER NOT NULL
    );
    CREATE TABLE summary_parents (
      summary_id TEXT NOT NULL,
      parent_summary_id TEXT NOT NULL,
      ordinal INTEGER NOT NULL
    );
    CREATE TABLE context_items (
      conversation_id INTEGER NOT NULL,
      ordinal INTEGER NOT NULL,
      item_type TEXT NOT NULL,
      message_id INTEGER,
      summary_id TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE large_files (
      file_id TEXT PRIMARY KEY,
      conversation_id INTEGER NOT NULL,
      file_name TEXT,
      mime_type TEXT,
      byte_size INTEGER,
      storage_uri TEXT NOT NULL,
      exploration_summary TEXT,
      created_at TEXT NOT NULL
    );
  `);
  db.exec(`
    INSERT INTO conversations VALUES (1, 'session-1', 'session-key-1', datetime('now'));
    INSERT INTO messages VALUES (1, 1, 0, 'user', 'hello', 1, datetime('now'));
    INSERT INTO message_parts VALUES ('part-1', 1, 'session-1', 'text', 0, 'hello', NULL, NULL, NULL, NULL, NULL);
    INSERT INTO summaries VALUES ('sum-1', 1, 'leaf', 0, 'summary', 1, datetime('now'));
    INSERT INTO summary_messages VALUES ('sum-1', 1, 0);
    INSERT INTO context_items VALUES (1, 0, 'summary', NULL, 'sum-1', datetime('now'));
    INSERT INTO large_files VALUES ('file-1', 1, 'a.txt', 'text/plain', 10, 'file:///a.txt', 'summary', datetime('now'));
  `);
  db.close();
}