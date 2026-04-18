import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveEngramConfig } from "../src/config.js";
import { openDatabase } from "../src/db/connection.js";
import { createEngramMemoryRuntime } from "../src/plugin/memory-runtime.js";

const tempPaths: string[] = [];

afterEach(() => {
  while (tempPaths.length > 0) {
    const current = tempPaths.pop();
    if (current) {
      rmSync(current, { recursive: true, force: true });
    }
  }
});

describe("engram memory runtime", () => {
  it("maps KB search results into memory_search-compatible hits", async () => {
    const root = mkdtempSync(join(tmpdir(), "engram-memory-runtime-"));
    tempPaths.push(root);
    const dbPath = join(root, "engram.db");
    const database = openDatabase(dbPath);
    try {
      database.db.exec(`
        INSERT INTO kb_collections (name, path, pattern, created_at) VALUES
          ('docs', 'C:/docs', '**/*.md', datetime('now')),
          ('__sessions', 'engram://sessions', '*.summary', datetime('now'));
        INSERT INTO kb_documents (doc_id, collection_name, rel_path, title, content_hash, token_count, indexed_at) VALUES
          ('doc-1', 'docs', 'guide.md', 'Guide', 'hash-1', 10, datetime('now')),
          ('doc-2', '__sessions', 's1/summary.summary', 'Session Summary', 'hash-2', 10, datetime('now'));
        INSERT INTO kb_chunks (chunk_id, doc_id, collection_name, ordinal, content, token_count, chunk_hash, derivation_depth) VALUES
          ('chunk-1', 'doc-1', 'docs', 0, 'First line\nNeedle topic lives here.', 10, 'chunk-1', 0),
          ('chunk-2', 'doc-2', '__sessions', 0, 'Needle topic from a prior session.', 10, 'chunk-2', 0);
      `);
    } finally {
      database.close();
    }

    const config = resolveEngramConfig({ dbPath });
    const runtime = createEngramMemoryRuntime(config);
    const { manager } = await runtime.getMemorySearchManager({
      cfg: {} as never,
      agentId: "agent-1",
    });

    expect(manager).not.toBeNull();

    const debugCalls: Array<{ backend: string; configuredMode?: string }> = [];
    const results = await manager!.search("needle topic", {
      maxResults: 5,
      onDebug: (debug) => {
        debugCalls.push({
          backend: debug.backend,
          configuredMode: debug.configuredMode,
        });
      },
    });

    expect(results).toHaveLength(2);
    expect(results[0]?.path).toBe("docs:guide.md");
    expect(results[0]?.source).toBe("memory");
    expect(results[0]?.startLine).toBe(1);
    expect(results[0]?.endLine).toBe(2);
    expect(results[1]?.source).toBe("sessions");
    expect(debugCalls).toEqual([{ backend: "qmd", configuredMode: "engram" }]);
  });

  it("reads back a KB document through the synthetic memory path", async () => {
    const root = mkdtempSync(join(tmpdir(), "engram-memory-read-"));
    tempPaths.push(root);
    const dbPath = join(root, "engram.db");
    const database = openDatabase(dbPath);
    try {
      database.db.exec(`
        INSERT INTO kb_collections (name, path, pattern, created_at) VALUES ('docs', 'C:/docs', '**/*.md', datetime('now'));
        INSERT INTO kb_documents (doc_id, collection_name, rel_path, title, content_hash, token_count, indexed_at) VALUES
          ('doc-1', 'docs', 'guide.md', 'Guide', 'hash-1', 10, datetime('now'));
        INSERT INTO kb_chunks (chunk_id, doc_id, collection_name, ordinal, content, token_count, chunk_hash, derivation_depth) VALUES
          ('chunk-1', 'doc-1', 'docs', 0, 'Line 1\nLine 2', 10, 'chunk-1', 0),
          ('chunk-2', 'doc-1', 'docs', 1, 'Line 3', 10, 'chunk-2', 0);
      `);
    } finally {
      database.close();
    }

    const runtime = createEngramMemoryRuntime(resolveEngramConfig({ dbPath }));
    const { manager } = await runtime.getMemorySearchManager({
      cfg: {} as never,
      agentId: "agent-1",
    });

    const result = await manager!.readFile({
      relPath: "docs:guide.md",
      from: 2,
      lines: 2,
    });

    expect(result.path).toBe("docs:guide.md");
    expect(result.text).toBe("Line 2\n");
    expect(result.from).toBe(2);
    expect(result.lines).toBe(2);
    expect(result.nextFrom).toBe(4);
    expect(result.truncated).toBe(true);
  });
});
