import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveEngramConfig } from "../src/config.js";
import { openDatabase } from "../src/db/connection.js";
import { EngramContextEngine } from "../src/engine/engine.js";
import { dropKbCollection, indexAllSummariesIntoKB, indexPath, indexSessionSummaryById, SESSION_COLLECTION_NAME, syncConfiguredCollections } from "../src/kb/indexer.js";
import { searchKnowledgeBase } from "../src/kb/store.js";

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

describe("kb indexer", () => {
  it("indexes a directory of text files into kb tables", async () => {
    const root = mkdtempSync(join(tmpdir(), "engram-indexer-"));
    tempPaths.push(root);
    const docsDir = join(root, "docs");
    mkdirSync(docsDir);
    writeFileSync(join(docsDir, "guide.md"), "# Guide\n\nEngram indexing makes search work.", "utf8");
    writeFileSync(join(docsDir, "notes.txt"), "Session notes and migration details.", "utf8");
    writeFileSync(join(docsDir, "binary.bin"), "\u0000\u0001", "utf8");

    const dbPath = join(root, "engram.db");
    const config = resolveEngramConfig({ dbPath });
    const result = await indexPath(config, docsDir, "docs");
    const hits = await searchKnowledgeBase(config, "indexing search", { limit: 5 });

    expect(result.collectionName).toBe("docs");
    expect(result.indexedDocuments).toBe(2);
    expect(result.indexedChunks).toBeGreaterThanOrEqual(2);
    expect(hits[0]?.title).toBe("guide");
  });

  it("indexes newly compacted session summaries into the reserved session collection", async () => {
    const root = mkdtempSync(join(tmpdir(), "engram-indexer-session-"));
    tempPaths.push(root);
    const dbPath = join(root, "engram.db");
    const database = openDatabase(dbPath);
    const config = resolveEngramConfig({ dbPath, freshTailCount: 2, leafTargetTokens: 20 });
    const engine = new EngramContextEngine(database, config);
    try {
      await engine.bootstrap({ sessionId: "s1", sessionFile: "session.jsonl", sessionKey: "k1" });
      await engine.ingestBatch({
        sessionId: "s1",
        messages: [
          { role: "user", content: "The migration importer needs idempotent tracking for repeated runs." },
          { role: "assistant", content: "Record completed source paths in a durable import run table." },
          { role: "user", content: "Also preserve chunk metadata for qmd imports." },
          { role: "assistant", content: "Chunk metadata preservation was added to the importer." },
        ],
      });

      await engine.afterTurn({
        sessionId: "s1",
        sessionFile: "session.jsonl",
        messages: [
          { role: "user", content: "Wrap up the migration design." },
          { role: "assistant", content: "The migration design is wrapped up." },
        ],
        prePromptMessageCount: 0,
      });
    } finally {
      await engine.dispose();
    }

    const sessionHits = await searchKnowledgeBase(resolveEngramConfig({ dbPath }), "idempotent tracking repeated runs", {
      limit: 5,
      collection: SESSION_COLLECTION_NAME,
    });
    expect(sessionHits.length).toBeGreaterThan(0);
    expect(sessionHits[0]?.collectionName).toBe(SESSION_COLLECTION_NAME);
  });

  it("stores embeddings for indexed chunks when embedding is enabled", async () => {
    const root = mkdtempSync(join(tmpdir(), "engram-indexer-embeds-"));
    tempPaths.push(root);
    const docsDir = join(root, "docs");
    mkdirSync(docsDir);
    writeFileSync(join(docsDir, "guide.md"), "# Guide\n\nEmbeddings should be stored for indexed chunks.", "utf8");

    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const payload = JSON.parse(String(init?.body ?? "{}")) as { input?: string[] };
      return {
        ok: true,
        json: async () => ({
          data: (payload.input ?? []).map((_value, index) => ({ embedding: [index + 0.25, index + 0.5] })),
        }),
      } satisfies Partial<Response>;
    });
    vi.stubGlobal("fetch", fetchMock);

    const dbPath = join(root, "engram.db");
    const config = resolveEngramConfig({
      dbPath,
      embedEnabled: true,
      embedApiUrl: "http://localhost:11434/v1/embeddings",
      embedApiModel: "nomic-embed-text",
      embedBatchSize: 10,
    });

    const result = await indexPath(config, docsDir, "docs");
    const database = openDatabase(dbPath);
    try {
      const row = database.db.prepare("SELECT COUNT(*) AS count FROM kb_embeddings").get() as { count?: number } | undefined;
      expect(result.indexedDocuments).toBe(1);
      expect(row?.count).toBeGreaterThan(0);
    } finally {
      database.close();
    }
  });

  it("populates the FTS table and marks collections as FTS-capable during indexing", async () => {
    const root = mkdtempSync(join(tmpdir(), "engram-indexer-fts-"));
    tempPaths.push(root);
    const docsDir = join(root, "docs");
    mkdirSync(docsDir);
    writeFileSync(join(docsDir, "guide.md"), "# Guide\n\nFTS indexing should stay in sync.", "utf8");

    const dbPath = join(root, "engram.db");
    const config = resolveEngramConfig({ dbPath });
    await indexPath(config, docsDir, "docs");

    const database = openDatabase(dbPath);
    try {
      const ftsRows = (database.db.prepare("SELECT COUNT(*) AS count FROM kb_chunks_fts").get() as { count?: number } | undefined)?.count ?? 0;
      const collection = database.db.prepare("SELECT fts5_available AS fts5Available FROM kb_collections WHERE name = 'docs'").get() as { fts5Available?: number } | undefined;

      expect(ftsRows).toBeGreaterThan(0);
      expect(collection?.fts5Available).toBe(1);
    } finally {
      database.close();
    }
  });

  it("skips unchanged documents on repeated indexing runs", async () => {
    const root = mkdtempSync(join(tmpdir(), "engram-indexer-idempotent-"));
    tempPaths.push(root);
    const docsDir = join(root, "docs");
    mkdirSync(docsDir);
    writeFileSync(join(docsDir, "guide.md"), "# Guide\n\nRepeated sync should skip unchanged files.", "utf8");

    const dbPath = join(root, "engram.db");
    const config = resolveEngramConfig({ dbPath });
    const first = await indexPath(config, docsDir, "docs");
    const second = await indexPath(config, docsDir, "docs");

    expect(first.indexedDocuments).toBe(1);
    expect(second.indexedDocuments).toBe(0);
    expect(second.indexedChunks).toBe(0);
  });

  it("syncs configured collections using their declared glob patterns", async () => {
    const root = mkdtempSync(join(tmpdir(), "engram-indexer-sync-"));
    tempPaths.push(root);
    const docsDir = join(root, "docs");
    mkdirSync(docsDir);
    writeFileSync(join(docsDir, "guide.md"), "# Guide\n\nConfigured collections should sync.", "utf8");
    writeFileSync(join(docsDir, "scratch.txt"), "This should be ignored by the markdown glob.", "utf8");

    const dbPath = join(root, "engram.db");
    const config = resolveEngramConfig({
      dbPath,
      kbCollections: [{ name: "docs", path: docsDir, pattern: "**/*.md", description: "Docs" }],
      kbAutoIndexOnStart: true,
    });

    const result = await syncConfiguredCollections(config);
    const hits = await searchKnowledgeBase(config, "configured collections sync", { limit: 5 });

    expect(result.collections).toHaveLength(1);
    expect(result.collections[0]?.indexedDocuments).toBe(1);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.relPath).toBe("guide.md");
  });

  it("skips indexing summary-of-summary artifacts when the circuit breaker is enabled", async () => {
    const root = mkdtempSync(join(tmpdir(), "engram-indexer-breaker-"));
    tempPaths.push(root);
    const dbPath = join(root, "engram.db");
    const database = openDatabase(dbPath);
    try {
      database.db.exec(`
        INSERT INTO conversations (conversation_id, session_id, session_key, created_at)
        VALUES ('conv-1', 'conv-1', 'key-1', datetime('now'));
        INSERT INTO summaries (summary_id, conversation_id, kind, depth, content, token_count, created_at)
        VALUES ('sum-deep', 'conv-1', 'condensed', 1, 'Deep summary content', 10, datetime('now'));
      `);

      const result = await indexSessionSummaryById(database.db, resolveEngramConfig({ dbPath }), {
        conversationId: "conv-1",
        summaryId: "sum-deep",
      });
      const chunkCount = (database.db.prepare("SELECT COUNT(*) AS count FROM kb_chunks").get() as { count?: number } | undefined)?.count ?? 0;

      expect(result).toBeNull();
      expect(chunkCount).toBe(0);
    } finally {
      database.close();
    }
  });

  it("indexAllSummariesIntoKB bulk-indexes depth-0 summaries that are not yet in __sessions", async () => {
    const root = mkdtempSync(join(tmpdir(), "engram-indexer-bulk-"));
    tempPaths.push(root);
    const dbPath = join(root, "engram.db");
    const database = openDatabase(dbPath);
    try {
      database.db.exec(`
        INSERT INTO conversations (conversation_id, session_id, session_key, created_at)
        VALUES ('conv-lcm1', 'conv-lcm1', 'lcm-key', datetime('now')),
               ('conv-lcm2', 'conv-lcm2', 'lcm-key2', datetime('now'));
        INSERT INTO summaries (summary_id, conversation_id, kind, depth, content, quality_score, token_count, created_at)
        VALUES
          ('lcm:sum-a', 'conv-lcm1', 'leaf', 0, 'We discussed idempotent migration tracking for repeated imports.', 60, 10, datetime('now')),
          ('lcm:sum-b', 'conv-lcm2', 'leaf', 0, 'We decided to preserve chunk metadata across all qmd import passes.', 60, 10, datetime('now')),
          ('lcm:sum-deep', 'conv-lcm1', 'condensed', 1, 'Condensed summary should be skipped.', 60, 10, datetime('now'));
      `);

      const config = resolveEngramConfig({ dbPath });
      const report = await indexAllSummariesIntoKB(database.db, config);

      expect(report.scanned).toBe(2);
      expect(report.indexed).toBe(2);
      expect(report.skipped).toBe(0);

      const hits = await searchKnowledgeBase(config, "idempotent migration tracking", { limit: 5 });
      expect(hits.some((h) => h.collectionName === SESSION_COLLECTION_NAME)).toBe(true);

      // Running again should skip all (idempotent)
      const report2 = await indexAllSummariesIntoKB(database.db, config);
      expect(report2.indexed).toBe(0);
      expect(report2.skipped).toBe(2);
    } finally {
      database.close();
    }
  });

  it("dropKbCollection removes all docs, chunks, embeddings, and the collection entry", async () => {
    const root = mkdtempSync(join(tmpdir(), "engram-indexer-drop-"));
    tempPaths.push(root);
    const docsDir = join(root, "sessions-raw");
    mkdirSync(docsDir);
    writeFileSync(join(docsDir, "dump.md"), "# Raw dump\n\nRaw conversation dump content here.", "utf8");

    const dbPath = join(root, "engram.db");
    const config = resolveEngramConfig({ dbPath });
    await indexPath(config, docsDir, "sessions");

    const database = openDatabase(dbPath);
    try {
      const before = (database.db.prepare("SELECT COUNT(*) AS n FROM kb_chunks WHERE collection_name = 'sessions'").get() as { n: number }).n;
      expect(before).toBeGreaterThan(0);

      const result = dropKbCollection(database.db, "sessions");

      expect(result.droppedDocs).toBe(1);
      expect(result.droppedChunks).toBeGreaterThan(0);

      const after = (database.db.prepare("SELECT COUNT(*) AS n FROM kb_chunks WHERE collection_name = 'sessions'").get() as { n: number }).n;
      const collectionGone = (database.db.prepare("SELECT COUNT(*) AS n FROM kb_collections WHERE name = 'sessions'").get() as { n: number }).n;
      expect(after).toBe(0);
      expect(collectionGone).toBe(0);
    } finally {
      database.close();
    }
  });
});