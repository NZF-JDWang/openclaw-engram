import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveEngramConfig } from "../src/config.js";
import { openDatabase } from "../src/db/connection.js";
import {
  createEngramCommitmentTool,
  createEngramSearchTool,
  createMemorySearchTool,
} from "../src/plugin/tools.js";

const tempPaths: string[] = [];

afterEach(() => {
  while (tempPaths.length > 0) {
    const current = tempPaths.pop();
    if (current) {
      rmSync(current, { recursive: true, force: true });
    }
  }
});

describe("engram tools", () => {
  it("filters search results by collections and minimum score", async () => {
    const root = mkdtempSync(join(tmpdir(), "engram-tools-search-"));
    tempPaths.push(root);
    const dbPath = join(root, "engram.db");
    const database = openDatabase(dbPath);
    try {
      database.db.exec(`
        INSERT INTO kb_collections (name, path, pattern, created_at) VALUES
          ('docs', 'C:/docs', '**/*.md', datetime('now')),
          ('notes', 'C:/notes', '**/*.md', datetime('now'));
        INSERT INTO kb_documents (doc_id, collection_name, rel_path, title, content_hash, token_count, indexed_at) VALUES
          ('doc-1', 'docs', 'a.md', 'Architecture', 'hash-1', 10, datetime('now')),
          ('doc-2', 'notes', 'b.md', 'Notes', 'hash-2', 10, datetime('now'));
        INSERT INTO kb_chunks (chunk_id, doc_id, collection_name, ordinal, content, token_count, chunk_hash, derivation_depth) VALUES
          ('chunk-1', 'doc-1', 'docs', 0, 'sqlite architecture decision', 10, 'chunk-1', 0),
          ('chunk-2', 'doc-2', 'notes', 0, 'sqlite notes', 10, 'chunk-2', 0);
      `);
    } finally {
      database.close();
    }

    const tool = createEngramSearchTool(resolveEngramConfig({ dbPath }));
    const result = await tool.execute("call-1", {
      query: "sqlite architecture",
      maxResults: 5,
      collections: ["docs"],
      minScore: 1,
    });
    const details = result.details as { results: Array<{ collectionName: string }> };
    const firstContent = result.content[0] as { text?: string } | undefined;

    expect(details.results).toHaveLength(1);
    expect(details.results[0]?.collectionName).toBe("docs");
    expect(firstContent?.text).toContain("source_kind document_derived");
  });

  it("exposes compact OpenClaw-compatible memory search output", async () => {
    const root = mkdtempSync(join(tmpdir(), "engram-tools-memory-search-"));
    tempPaths.push(root);
    const dbPath = join(root, "engram.db");
    const database = openDatabase(dbPath);
    try {
      database.db.exec(`
        INSERT INTO kb_collections (name, path, pattern, created_at) VALUES
          ('openclaw-memory', 'C:/workspace/MEMORY.md', 'MEMORY.md', datetime('now'));
        INSERT INTO kb_documents (doc_id, collection_name, rel_path, title, content_hash, token_count, indexed_at) VALUES
          ('doc-1', 'openclaw-memory', 'MEMORY.md', 'Memory', 'hash-1', 10, datetime('now'));
        INSERT INTO kb_chunks (chunk_id, doc_id, collection_name, ordinal, content, token_count, chunk_hash, derivation_depth) VALUES
          ('chunk-1', 'doc-1', 'openclaw-memory', 0, 'prefers compact memory snippets', 10, 'chunk-1', 0);
      `);
    } finally {
      database.close();
    }

    const tool = createMemorySearchTool(resolveEngramConfig({ dbPath }));
    const result = await tool.execute("call-1", {
      query: "compact memory",
      maxResults: 1,
    });
    const firstContent = result.content[0] as { text?: string } | undefined;

    expect(firstContent?.text).toContain("chunk-1 [openclaw-memory] MEMORY.md");
    expect(firstContent?.text).toContain("score=");
  });

  it("stores and lists short-lived commitments", async () => {
    const root = mkdtempSync(join(tmpdir(), "engram-tools-commitment-"));
    tempPaths.push(root);
    const dbPath = join(root, "engram.db");
    openDatabase(dbPath).close();

    const tool = createEngramCommitmentTool(resolveEngramConfig({ dbPath }));
    const stored = await tool.execute("call-1", {
      action: "store",
      content: "Check in after the interview",
      dueAt: "2026-05-02T09:00:00.000Z",
    });
    expect((stored.content[0] as { text?: string } | undefined)?.text).toContain("Stored commitment");

    const listed = await tool.execute("call-2", { action: "list" });
    expect((listed.content[0] as { text?: string } | undefined)?.text).toContain("Check in after the interview");
  });
});
