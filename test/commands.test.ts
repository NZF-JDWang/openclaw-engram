import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveEngramConfig } from "../src/config.js";
import { openDatabase } from "../src/db/connection.js";
import { createEngramCommand } from "../src/plugin/commands.js";

const tempPaths: string[] = [];

afterEach(() => {
  while (tempPaths.length > 0) {
    const current = tempPaths.pop();
    if (current) {
      rmSync(current, { recursive: true, force: true });
    }
  }
});

describe("engram command", () => {
  it("syncs configured collections when run without an explicit path", async () => {
    const root = mkdtempSync(join(tmpdir(), "engram-command-index-sync-"));
    tempPaths.push(root);
    const docsDir = join(root, "docs");
    mkdirSync(docsDir);
    writeFileSync(join(docsDir, "guide.md"), "# Guide\n\nConfigured sync should work.", "utf8");
    const dbPath = join(root, "engram.db");
    const database = openDatabase(dbPath);
    database.close();
    const config = resolveEngramConfig({
      dbPath,
      kbCollections: [{ name: "docs", path: docsDir, pattern: "**/*.md" }],
    });

    const command = createEngramCommand(config);
    const result = await command.handler({ args: "index" } as never);

    expect(result.text).toContain("Synced 1 configured collection");
    expect(result.text).toContain("[docs] 1 document");
  });

  it("indexes an explicit path when one is provided", async () => {
    const root = mkdtempSync(join(tmpdir(), "engram-command-index-path-"));
    tempPaths.push(root);
    const docsDir = join(root, "notes");
    mkdirSync(docsDir);
    writeFileSync(join(docsDir, "note.md"), "# Note\n\nExplicit path indexing should work.", "utf8");
    const dbPath = join(root, "engram.db");
    const database = openDatabase(dbPath);
    database.close();
    const config = resolveEngramConfig({ dbPath });

    const command = createEngramCommand(config);
    const result = await command.handler({ args: `index ${docsDir}` } as never);

    expect(result.text).toContain("Indexed 1 document");
  });

  it("includes source_kind in KB search output", async () => {
    const root = mkdtempSync(join(tmpdir(), "engram-command-search-"));
    tempPaths.push(root);
    const dbPath = join(root, "engram.db");
    const database = openDatabase(dbPath);
    try {
      database.db.exec(`
        INSERT INTO kb_collections (name, path, pattern, created_at) VALUES ('docs', '.', '**/*.md', datetime('now'));
        INSERT INTO kb_documents (doc_id, collection_name, rel_path, title, content_hash, token_count, indexed_at)
        VALUES ('doc-1', 'docs', 'guide.md', 'Guide', 'hash', 10, datetime('now'));
        INSERT INTO kb_chunks (chunk_id, doc_id, collection_name, ordinal, content, token_count, chunk_hash, derivation_depth)
        VALUES ('chunk-1', 'doc-1', 'docs', 0, 'sqlite search metadata output', 10, 'chunk-hash', 0);
      `);
    } finally {
      database.close();
    }

    const command = createEngramCommand(resolveEngramConfig({ dbPath }));
    const result = await command.handler({ args: 'search sqlite metadata' } as never);

    expect(result.text).toContain('source_kind document_derived');
  });
});