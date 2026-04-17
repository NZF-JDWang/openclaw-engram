import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveEngramConfig } from "../../src/config.js";
import { openDatabase } from "../../src/db/connection.js";
import { indexPath } from "../../src/kb/indexer.js";
import { searchKnowledgeBase } from "../../src/kb/store.js";

const tempPaths: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  while (tempPaths.length > 0) {
    const current = tempPaths.pop();
    if (current) {
      rmSync(current, { recursive: true, force: true });
    }
  }
});

describe("chaos embed down", () => {
  it("keeps indexed chunks searchable with BM25 when the embedding endpoint fails", async () => {
    const root = mkdtempSync(join(tmpdir(), "engram-chaos-embed-down-"));
    tempPaths.push(root);
    const docsDir = join(root, "docs");
    mkdirSync(docsDir);
    writeFileSync(
      join(docsDir, "migration.md"),
      "# Migration\n\nPreserve qmd chunk metadata and keep migration audit trails searchable even if embeddings are unavailable.",
      "utf8",
    );

    const fetchMock = vi.fn(async () => {
      throw new Error("embedding endpoint unavailable");
    });
    vi.stubGlobal("fetch", fetchMock);

    const dbPath = join(root, "engram.db");
    const config = resolveEngramConfig({
      dbPath,
      embedEnabled: true,
      embedApiUrl: "http://localhost:11434/v1/embeddings",
      embedApiModel: "nomic-embed-text",
      embedBatchSize: 8,
    });

    const result = await indexPath(config, docsDir, "docs");
    const hits = await searchKnowledgeBase(config, "qmd chunk metadata migration audit trails", { limit: 5 });
    const database = openDatabase(dbPath);
    try {
      const row = database.db.prepare("SELECT COUNT(*) AS count FROM kb_embeddings").get() as { count?: number } | undefined;

      expect(result.indexedDocuments).toBe(1);
      expect(result.indexedChunks).toBeGreaterThan(0);
      expect(hits.length).toBeGreaterThan(0);
      expect(hits[0]?.title).toBe("migration");
      expect(row?.count).toBe(0);
      expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(3);
    } finally {
      database.close();
    }
  });
});