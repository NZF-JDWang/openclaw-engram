import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveEngramConfig } from "../src/config.js";
import { openDatabase } from "../src/db/connection.js";
import {
  createBeforePromptBuildHook,
  estimateSubstance,
  extractLatestUserQuery,
  formatRecallBlock,
  isDuplicateAgainstRecentContext,
  loadFeedbackWeights,
  rankRecallCandidates,
  scanResponseForRecallReferences,
  shouldInjectRecall,
} from "../src/plugin/recall.js";

const tempPaths: string[] = [];

afterEach(() => {
  while (tempPaths.length > 0) {
    const current = tempPaths.pop();
    if (current) {
      rmSync(current, { recursive: true, force: true });
    }
  }
});

describe("recall hook", () => {
  it("extracts the latest user query from messages", () => {
    expect(
      extractLatestUserQuery({
        prompt: "fallback",
        messages: [
          { role: "assistant", content: "earlier" },
          { role: "user", content: "Find the qmd migration details" },
        ],
      }),
    ).toBe("Find the qmd migration details");
  });

  it("augments short follow-up queries with the prior assistant turn", () => {
    expect(
      extractLatestUserQuery({
        messages: [
          { role: "assistant", content: "The migration tracks import runs in the database and prevents duplicates." },
          { role: "user", content: "how do i fix it?" },
        ],
      }),
    ).toContain("Context: The migration tracks import runs in the database and prevents duplicates.");
  });

  it("formats a stable recall block", () => {
    const xml = formatRecallBlock("query", [
      {
        chunkId: "chunk-1",
        collectionId: "docs",
        title: "Migration Notes",
        score: 0.875,
        snippet: "Importer tracks completed runs.",
      },
    ], 200);
    expect(xml).toContain('<engram_recall query="query">');
    expect(xml).toContain('<memory chunk_id="chunk-1"');
    expect(xml).toContain('source_kind="document_derived"');
    expect(xml).toContain('Importer tracks completed runs.');
  });

  it("suppresses trivial queries and duplicate snippets already present in context", () => {
    expect(estimateSubstance("keep going")).toBe(0);
    expect(
      isDuplicateAgainstRecentContext("Importer tracks completed runs for repeated migrations.", [
        { role: "assistant", content: "The importer tracks completed runs for repeated migrations." },
      ]),
    ).toBe(true);
    expect(
      isDuplicateAgainstRecentContext(
        "Importer tracks completed runs for repeated migrations. It also stores the original source path for audit.",
        [{ role: "assistant", content: "The importer tracks completed runs for repeated migrations." }],
      ),
    ).toBe(false);
  });

  it("normalizes recall candidates by score", () => {
    const ranked = rankRecallCandidates(
      [
        {
          kind: "memory",
          chunkId: "chunk-1",
          docId: "doc-1",
          collectionId: "docs",
          relPath: "notes/migration.md",
          title: "Migration Notes",
          score: 12,
          snippet: "Import runs are stored in engram_import_runs.",
        },
        {
          kind: "memory",
          chunkId: "chunk-2",
          docId: "doc-2",
          collectionId: "docs",
          relPath: "notes/other.md",
          title: "Other Notes",
          score: 6,
          snippet: "Something else.",
        },
      ],
      { recallMaxResults: 3 },
    );

    expect(ranked[0]?.normalizedScore).toBe(1);
    expect(ranked[1]?.normalizedScore).toBe(0.5);
  });

  it("requires either score gap or high confidence before injecting recall", () => {
    expect(
      shouldInjectRecall(
        [{ normalizedScore: 0.55 }, { normalizedScore: 0.51 }],
        { recallMinScore: 0.4, recallGapThreshold: 0.08, recallHighConfidenceScore: 0.75 },
      ),
    ).toBe(false);

    expect(
      shouldInjectRecall(
        [{ normalizedScore: 0.8 }, { normalizedScore: 0.76 }],
        { recallMinScore: 0.4, recallGapThreshold: 0.08, recallHighConfidenceScore: 0.75 },
      ),
    ).toBe(true);
  });

  it("returns appendSystemContext when KB hits exist", async () => {
    const root = mkdtempSync(join(tmpdir(), "engram-recall-"));
    tempPaths.push(root);
    const dbPath = join(root, "engram.db");
    const database = openDatabase(dbPath);
    try {
      database.db.exec(`
        INSERT INTO kb_collections (name, path, pattern, description, auto_index, fts5_available, created_at) VALUES ('docs', '.', '**/*.md', 'Docs', 0, 0, datetime('now'));
        INSERT INTO kb_documents (doc_id, collection_name, rel_path, title, content_hash, token_count, indexed_at) VALUES ('doc-1', 'docs', 'docs/qmd-migration.md', 'QMD Migration', 'abc', 12, datetime('now'));
        INSERT INTO kb_chunks (chunk_id, doc_id, collection_name, ordinal, content, token_count, chunk_hash, derivation_depth) VALUES ('chunk-1', 'doc-1', 'docs', 0, 'QMD migration stores imported chunks and tracks import runs.', 12, 'chunk-abc', 0);
      `);

      const hook = createBeforePromptBuildHook(resolveEngramConfig({ dbPath }));
      const result = await hook({
        prompt: 'fallback',
        messages: [{ role: 'user', content: 'How does qmd migration tracking work?' }],
      });

      expect(result?.appendSystemContext).toContain('<engram_recall');
      expect(result?.appendSystemContext).toContain('QMD Migration');
    } finally {
      database.close();
    }
  });

  it("logs would-be recall blocks in shadow mode instead of injecting them", async () => {
    const root = mkdtempSync(join(tmpdir(), "engram-recall-shadow-"));
    tempPaths.push(root);
    const dbPath = join(root, "engram.db");
    const shadowLogFile = join(root, "shadow.log");
    const database = openDatabase(dbPath);
    try {
      database.db.exec(`
        INSERT INTO kb_collections (name, path, pattern, description, auto_index, fts5_available, created_at) VALUES ('docs', '.', '**/*.md', 'Docs', 0, 0, datetime('now'));
        INSERT INTO kb_documents (doc_id, collection_name, rel_path, title, content_hash, token_count, indexed_at) VALUES ('doc-1', 'docs', 'docs/shadow.md', 'Shadow', 'abc', 12, datetime('now'));
        INSERT INTO kb_chunks (chunk_id, doc_id, collection_name, ordinal, content, token_count, chunk_hash, derivation_depth) VALUES ('chunk-1', 'doc-1', 'docs', 0, 'Use sqlite for the Engram store in shadow mode recall.', 12, 'chunk-abc', 0);
      `);
    } finally {
      database.close();
    }

    const config = resolveEngramConfig({ dbPath, recallShadowMode: true, recallShadowLogFile: shadowLogFile });
    const hook = createBeforePromptBuildHook(config);
    const result = await hook({
      prompt: "fallback",
      messages: [{ role: "user", content: "Which store did we choose for engram?" }],
    });

    expect(result?.appendSystemContext).toBeUndefined();
    expect(result).toBeUndefined();
    expect(existsSync(shadowLogFile)).toBe(true);
    expect(readFileSync(shadowLogFile, "utf8")).toContain("Use sqlite for the Engram store in shadow mode recall.");
  });
});

describe("scanResponseForRecallReferences", () => {
  it("marks events as referenced when all title keywords appear in the response", () => {
    const root = mkdtempSync(join(tmpdir(), "engram-recall-scan-"));
    tempPaths.push(root);
    const dbPath = join(root, "engram.db");
    const database = openDatabase(dbPath);
    try {
      database.db.exec(`
        INSERT INTO kb_collections (name, path, pattern, description, auto_index, fts5_available, created_at) VALUES ('docs', '.', '**/*.md', 'Docs', 0, 0, datetime('now'));
        INSERT INTO kb_documents (doc_id, collection_name, rel_path, title, content_hash, token_count, indexed_at) VALUES ('doc-1', 'docs', 'notes/migration.md', 'QMD Migration Notes', 'abc', 10, datetime('now'));
        INSERT INTO kb_chunks (chunk_id, doc_id, collection_name, ordinal, content, token_count, chunk_hash, derivation_depth) VALUES ('chunk-1', 'doc-1', 'docs', 0, 'The qmd migration notes detail the import process.', 10, 'chunk-abc', 0);
        INSERT INTO recall_events (event_id, conversation_id, chunk_id, injected_score, was_referenced, created_at) VALUES ('evt-1', 'conv-1', 'chunk-1', 0.8, 0, datetime('now'));
      `);

      const marked = scanResponseForRecallReferences(
        database.db,
        "conv-1",
        "The qmd migration notes explain how the importer handles duplicate runs.",
      );

      expect(marked).toBe(1);
      const row = database.db.prepare(
        "SELECT was_referenced FROM recall_events WHERE event_id = 'evt-1'",
      ).get() as { was_referenced: number };
      expect(row.was_referenced).toBe(1);
    } finally {
      database.close();
    }
  });

  it("does not mark events when the response has no keyword overlap", () => {
    const root = mkdtempSync(join(tmpdir(), "engram-recall-scan-nomatch-"));
    tempPaths.push(root);
    const dbPath = join(root, "engram.db");
    const database = openDatabase(dbPath);
    try {
      database.db.exec(`
        INSERT INTO kb_collections (name, path, pattern, description, auto_index, fts5_available, created_at) VALUES ('docs', '.', '**/*.md', 'Docs', 0, 0, datetime('now'));
        INSERT INTO kb_documents (doc_id, collection_name, rel_path, title, content_hash, token_count, indexed_at) VALUES ('doc-1', 'docs', 'notes/compaction.md', 'Compaction Strategy', 'abc', 10, datetime('now'));
        INSERT INTO kb_chunks (chunk_id, doc_id, collection_name, ordinal, content, token_count, chunk_hash, derivation_depth) VALUES ('chunk-1', 'doc-1', 'docs', 0, 'Compaction merges summaries.', 10, 'chunk-abc', 0);
        INSERT INTO recall_events (event_id, conversation_id, chunk_id, injected_score, was_referenced, created_at) VALUES ('evt-1', 'conv-1', 'chunk-1', 0.7, 0, datetime('now'));
      `);

      const marked = scanResponseForRecallReferences(
        database.db,
        "conv-1",
        "The weather is sunny and warm today.",
      );

      expect(marked).toBe(0);
      const row = database.db.prepare(
        "SELECT was_referenced FROM recall_events WHERE event_id = 'evt-1'",
      ).get() as { was_referenced: number };
      expect(row.was_referenced).toBe(0);
    } finally {
      database.close();
    }
  });

  it("returns 0 and skips DB query for empty response text", () => {
    const root = mkdtempSync(join(tmpdir(), "engram-recall-scan-empty-"));
    tempPaths.push(root);
    const dbPath = join(root, "engram.db");
    const database = openDatabase(dbPath);
    try {
      const marked = scanResponseForRecallReferences(database.db, "conv-1", "   ");
      expect(marked).toBe(0);
    } finally {
      database.close();
    }
  });

  it("does not re-mark events already flagged as referenced", () => {
    const root = mkdtempSync(join(tmpdir(), "engram-recall-scan-already-"));
    tempPaths.push(root);
    const dbPath = join(root, "engram.db");
    const database = openDatabase(dbPath);
    try {
      database.db.exec(`
        INSERT INTO kb_collections (name, path, pattern, description, auto_index, fts5_available, created_at) VALUES ('docs', '.', '**/*.md', 'Docs', 0, 0, datetime('now'));
        INSERT INTO kb_documents (doc_id, collection_name, rel_path, title, content_hash, token_count, indexed_at) VALUES ('doc-1', 'docs', 'notes/migration.md', 'QMD Migration Notes', 'abc', 10, datetime('now'));
        INSERT INTO kb_chunks (chunk_id, doc_id, collection_name, ordinal, content, token_count, chunk_hash, derivation_depth) VALUES ('chunk-1', 'doc-1', 'docs', 0, 'content', 10, 'chunk-abc', 0);
        INSERT INTO recall_events (event_id, conversation_id, chunk_id, injected_score, was_referenced, created_at) VALUES ('evt-1', 'conv-1', 'chunk-1', 0.8, 1, datetime('now'));
      `);

      const marked = scanResponseForRecallReferences(
        database.db,
        "conv-1",
        "The qmd migration notes explain how the importer works.",
      );

      expect(marked).toBe(0);
    } finally {
      database.close();
    }
  });
});

describe("loadFeedbackWeights", () => {
  it("returns boost multiplier >= 1.0 for chunks referenced at >= 50% rate with >= 3 injections", () => {
    const root = mkdtempSync(join(tmpdir(), "engram-weights-boost-"));
    tempPaths.push(root);
    const dbPath = join(root, "engram.db");
    const database = openDatabase(dbPath);
    try {
      database.db.exec(`
        INSERT INTO kb_collections (name, path, pattern, description, auto_index, fts5_available, created_at) VALUES ('docs', '.', '**/*.md', 'Docs', 0, 0, datetime('now'));
        INSERT INTO kb_documents (doc_id, collection_name, rel_path, title, content_hash, token_count, indexed_at) VALUES ('doc-1', 'docs', 'notes/a.md', 'A', 'abc', 5, datetime('now'));
        INSERT INTO kb_chunks (chunk_id, doc_id, collection_name, ordinal, content, token_count, chunk_hash, derivation_depth) VALUES ('chunk-boost', 'doc-1', 'docs', 0, 'content', 5, 'h1', 0);
        INSERT INTO recall_events (event_id, conversation_id, chunk_id, injected_score, was_referenced) VALUES
          ('e1', 'c1', 'chunk-boost', 0.9, 1),
          ('e2', 'c2', 'chunk-boost', 0.9, 1),
          ('e3', 'c3', 'chunk-boost', 0.9, 1);
      `);

      const weights = loadFeedbackWeights(database.db, ["chunk-boost"]);
      const w = weights.get("chunk-boost") ?? 1.0;
      expect(w).toBeGreaterThan(1.0);
      expect(w).toBeLessThanOrEqual(1.5);
    } finally {
      database.close();
    }
  });

  it("returns demote multiplier < 1.0 for chunks never referenced with >= 5 injections", () => {
    const root = mkdtempSync(join(tmpdir(), "engram-weights-demote-"));
    tempPaths.push(root);
    const dbPath = join(root, "engram.db");
    const database = openDatabase(dbPath);
    try {
      database.db.exec(`
        INSERT INTO kb_collections (name, path, pattern, description, auto_index, fts5_available, created_at) VALUES ('docs', '.', '**/*.md', 'Docs', 0, 0, datetime('now'));
        INSERT INTO kb_documents (doc_id, collection_name, rel_path, title, content_hash, token_count, indexed_at) VALUES ('doc-1', 'docs', 'notes/b.md', 'B', 'abc', 5, datetime('now'));
        INSERT INTO kb_chunks (chunk_id, doc_id, collection_name, ordinal, content, token_count, chunk_hash, derivation_depth) VALUES ('chunk-demote', 'doc-1', 'docs', 0, 'content', 5, 'h2', 0);
        INSERT INTO recall_events (event_id, conversation_id, chunk_id, injected_score, was_referenced) VALUES
          ('e1', 'c1', 'chunk-demote', 0.5, 0),
          ('e2', 'c2', 'chunk-demote', 0.5, 0),
          ('e3', 'c3', 'chunk-demote', 0.5, 0),
          ('e4', 'c4', 'chunk-demote', 0.5, 0),
          ('e5', 'c5', 'chunk-demote', 0.5, 0);
      `);

      const weights = loadFeedbackWeights(database.db, ["chunk-demote"]);
      const w = weights.get("chunk-demote") ?? 1.0;
      expect(w).toBeLessThan(1.0);
    } finally {
      database.close();
    }
  });

  it("returns neutral weight for chunks with too few events", () => {
    const root = mkdtempSync(join(tmpdir(), "engram-weights-neutral-"));
    tempPaths.push(root);
    const dbPath = join(root, "engram.db");
    const database = openDatabase(dbPath);
    try {
      database.db.exec(`
        INSERT INTO kb_collections (name, path, pattern, description, auto_index, fts5_available, created_at) VALUES ('docs', '.', '**/*.md', 'Docs', 0, 0, datetime('now'));
        INSERT INTO kb_documents (doc_id, collection_name, rel_path, title, content_hash, token_count, indexed_at) VALUES ('doc-1', 'docs', 'notes/c.md', 'C', 'abc', 5, datetime('now'));
        INSERT INTO kb_chunks (chunk_id, doc_id, collection_name, ordinal, content, token_count, chunk_hash, derivation_depth) VALUES ('chunk-neutral', 'doc-1', 'docs', 0, 'content', 5, 'h3', 0);
        INSERT INTO recall_events (event_id, conversation_id, chunk_id, injected_score, was_referenced) VALUES
          ('e1', 'c1', 'chunk-neutral', 0.6, 0),
          ('e2', 'c2', 'chunk-neutral', 0.6, 0);
      `);

      const weights = loadFeedbackWeights(database.db, ["chunk-neutral"]);
      expect(weights.get("chunk-neutral")).toBe(1.0);
    } finally {
      database.close();
    }
  });

  it("returns empty map for empty chunkIds input", () => {
    const root = mkdtempSync(join(tmpdir(), "engram-weights-empty-"));
    tempPaths.push(root);
    const dbPath = join(root, "engram.db");
    const database = openDatabase(dbPath);
    try {
      const weights = loadFeedbackWeights(database.db, []);
      expect(weights.size).toBe(0);
    } finally {
      database.close();
    }
  });
});