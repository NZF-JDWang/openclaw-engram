import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveEngramConfig } from "../../src/config.js";
import { openDatabase } from "../../src/db/connection.js";
import { createBeforePromptBuildHook } from "../../src/plugin/recall.js";

const tempPaths: string[] = [];

afterEach(() => {
  while (tempPaths.length > 0) {
    const current = tempPaths.pop();
    if (current) {
      rmSync(current, { recursive: true, force: true });
    }
  }
});

describe("integration recall pipeline", () => {
  it("injects KB recall in append context for a substantive query", async () => {
    const root = mkdtempSync(join(tmpdir(), "engram-integration-recall-"));
    tempPaths.push(root);
    const dbPath = join(root, "engram.db");
    const database = openDatabase(dbPath);
    try {
      database.db.exec(`
        INSERT INTO kb_collections (name, path, pattern, description, auto_index, fts5_available, created_at)
        VALUES ('docs', '.', '**/*.md', 'Docs', 0, 0, datetime('now'));
        INSERT INTO kb_documents (doc_id, collection_name, rel_path, title, content_hash, token_count, indexed_at)
        VALUES ('doc-1', 'docs', 'docs/architecture.md', 'Architecture', 'hash', 12, datetime('now'));
        INSERT INTO kb_chunks (chunk_id, doc_id, collection_name, ordinal, content, token_count, chunk_hash, derivation_depth)
        VALUES ('chunk-1', 'doc-1', 'docs', 0, 'Configured collection sync uses the declared glob pattern before indexing and stores embeddings optionally.', 12, 'chunk-hash', 0);
      `);
    } finally {
      database.close();
    }

    const config = resolveEngramConfig({ dbPath });

    const hook = createBeforePromptBuildHook(config);
    const result = await hook({
      messages: [{ role: 'user', content: 'How does configured collection sync work in engram?' }],
    });

    expect(result?.appendSystemContext).toContain('<engram_recall');
    expect(result?.appendSystemContext).toContain('Architecture');
    expect(result?.appendSystemContext).toContain('declared glob pattern');
  });
});