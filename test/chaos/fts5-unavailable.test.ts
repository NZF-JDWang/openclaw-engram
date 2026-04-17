import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveEngramConfig } from "../../src/config.js";
import { openDatabase } from "../../src/db/connection.js";
import { searchKnowledgeBase } from "../../src/kb/store.js";

const tempPaths: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  while (tempPaths.length > 0) {
    const current = tempPaths.pop();
    if (current) {
      rmSync(current, { recursive: true, force: true });
    }
  }
});

describe("chaos fts5 unavailable", () => {
  it("uses LIKE fallback for a small collection when FTS5 is unavailable", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const root = mkdtempSync(join(tmpdir(), "engram-chaos-fts-small-"));
    tempPaths.push(root);
    const dbPath = join(root, "engram.db");
    const database = openDatabase(dbPath);
    try {
      database.db.exec(`
        DROP TABLE IF EXISTS kb_chunks_fts;
        INSERT INTO kb_collections (name, path, pattern, description, auto_index, fts5_available, created_at)
        VALUES ('docs', 'C:/docs', '**/*.md', 'Docs', 0, 0, datetime('now'));
        INSERT INTO kb_documents (doc_id, collection_name, rel_path, title, content_hash, token_count, indexed_at)
        VALUES ('doc-1', 'docs', 'guide.md', 'Guide', 'hash-1', 10, datetime('now'));
        INSERT INTO kb_chunks (chunk_id, doc_id, collection_name, ordinal, content, token_count, chunk_hash, derivation_depth)
        VALUES ('chunk-1', 'doc-1', 'docs', 0, 'qmd metadata fallback search still works without fts', 10, 'chunk-1', 0);
      `);
    } finally {
      database.close();
    }

    const results = await searchKnowledgeBase(resolveEngramConfig({ dbPath }), "qmd metadata fallback", { limit: 5 });

    expect(results).toHaveLength(1);
    expect(results[0]?.chunkId).toBe("chunk-1");
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("using LIKE fallback"));
  });

  it("throws when FTS5 is unavailable for a large collection", async () => {
    const root = mkdtempSync(join(tmpdir(), "engram-chaos-fts-large-"));
    tempPaths.push(root);
    const dbPath = join(root, "engram.db");
    const database = openDatabase(dbPath);
    try {
      database.db.exec(`
        DROP TABLE IF EXISTS kb_chunks_fts;
        INSERT INTO kb_collections (name, path, pattern, description, auto_index, fts5_available, created_at)
        VALUES ('docs', 'C:/docs', '**/*.md', 'Docs', 0, 0, datetime('now'));
        INSERT INTO kb_documents (doc_id, collection_name, rel_path, title, content_hash, token_count, indexed_at)
        VALUES ('doc-1', 'docs', 'guide.md', 'Guide', 'hash-1', 10, datetime('now'));
        WITH RECURSIVE seq(value) AS (
          SELECT 1
          UNION ALL
          SELECT value + 1 FROM seq WHERE value < 5001
        )
        INSERT INTO kb_chunks (chunk_id, doc_id, collection_name, ordinal, content, token_count, chunk_hash, derivation_depth)
        SELECT
          'chunk-' || value,
          'doc-1',
          'docs',
          value,
          'oversized fallback collection chunk ' || value,
          10,
          'hash-' || value,
          0
        FROM seq;
      `);
    } finally {
      database.close();
    }

    await expect(searchKnowledgeBase(resolveEngramConfig({ dbPath }), "oversized fallback collection", { limit: 5 })).rejects.toThrow(
      /LIKE fallback is disabled above 5000 chunks/,
    );
  });
});