import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase } from "../src/db/connection.js";
import { importFromQmd } from "../src/migrate/qmd-importer.js";

const tempPaths: string[] = [];

afterEach(() => {
  while (tempPaths.length > 0) {
    const current = tempPaths.pop();
    if (current) {
      rmSync(current, { recursive: true, force: true });
    }
  }
});

describe("importFromQmd", () => {
  it("imports qmd collections and documents as kb rows and records the import", () => {
    const root = mkdtempSync(join(tmpdir(), "engram-import-qmd-"));
    tempPaths.push(root);

    const sourcePath = join(root, "index.sqlite");
    const destPath = join(root, "engram.db");
    buildQmdFixture(sourcePath);

    const dest = openDatabase(destPath);
    try {
      const first = importFromQmd(sourcePath, dest.db);
      const second = importFromQmd(sourcePath, dest.db);

      const collectionCount = (dest.db.prepare(`SELECT COUNT(*) AS count FROM kb_collections`).get() as { count: number }).count;
      const documentCount = (dest.db.prepare(`SELECT COUNT(*) AS count FROM kb_documents`).get() as { count: number }).count;
      const chunkCount = (dest.db.prepare(`SELECT COUNT(*) AS count FROM kb_chunks`).get() as { count: number }).count;
      const importRunCount = (dest.db.prepare(`SELECT COUNT(*) AS count FROM engram_import_runs WHERE source_kind = 'qmd'`).get() as { count: number }).count;

      expect(first.imported).toBe(true);
      expect(first.counts.documents).toBe(1);
      expect(first.warnings[0]).toContain("re-indexing");
      expect(second.skipped).toBe(true);
      expect(collectionCount).toBe(1);
      expect(documentCount).toBe(1);
      expect(chunkCount).toBe(1);
      expect(importRunCount).toBe(1);
    } finally {
      dest.close();
    }
  });

  it("chunks larger qmd documents into multiple kb_chunks", () => {
    const root = mkdtempSync(join(tmpdir(), "engram-import-qmd-large-"));
    tempPaths.push(root);

    const sourcePath = join(root, "index.sqlite");
    const destPath = join(root, "engram.db");
    buildQmdFixture(sourcePath, { body: buildLargeBody() });

    const dest = openDatabase(destPath);
    try {
      const result = importFromQmd(sourcePath, dest.db);
      const chunkCount = (dest.db.prepare(`SELECT COUNT(*) AS count FROM kb_chunks`).get() as { count: number }).count;

      expect(result.imported).toBe(true);
      expect(result.counts.chunks).toBeGreaterThan(1);
      expect(chunkCount).toBeGreaterThan(1);
    } finally {
      dest.close();
    }
  });
});

function buildQmdFixture(filePath: string, options: { body?: string } = {}): void {
  const db = new DatabaseSync(filePath);
  db.exec(`
    CREATE TABLE content (hash TEXT PRIMARY KEY, doc TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE documents (id INTEGER PRIMARY KEY AUTOINCREMENT, collection TEXT NOT NULL, path TEXT NOT NULL, title TEXT NOT NULL, hash TEXT NOT NULL, created_at TEXT NOT NULL, modified_at TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE content_vectors (hash TEXT NOT NULL, seq INTEGER NOT NULL DEFAULT 0, pos INTEGER NOT NULL DEFAULT 0, model TEXT NOT NULL, embedded_at TEXT NOT NULL, PRIMARY KEY (hash, seq));
    CREATE TABLE store_collections (name TEXT PRIMARY KEY, path TEXT NOT NULL, pattern TEXT NOT NULL DEFAULT '**/*.md', context TEXT);
  `);
  const body = options.body ?? '# Hello from qmd';
  db.exec(`
    INSERT INTO content VALUES ('hash-1', ${sqlString(body)}, datetime('now'));
    INSERT INTO documents (collection, path, title, hash, created_at, modified_at, active) VALUES ('docs', 'hello.md', 'Hello', 'hash-1', datetime('now'), datetime('now'), 1);
    INSERT INTO content_vectors VALUES ('hash-1', 0, 0, 'test-model', datetime('now'));
    INSERT INTO store_collections VALUES ('docs', 'C:/docs', '**/*.md', 'Imported docs');
  `);
  db.close();
}

function buildLargeBody(): string {
  return Array.from({ length: 80 }, (_, index) => `## Section ${index + 1}\nThis is a long qmd import paragraph about docker networking, context windows, memory systems, and retrieval quality.`).join('\n\n');
}

function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}