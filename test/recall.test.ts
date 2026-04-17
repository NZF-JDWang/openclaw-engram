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
  rankRecallCandidates,
  shouldInjectRecall,
} from "../src/plugin/recall.js";
import { rememberFact } from "../src/plugin/facts.js";

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
    ], 20, [
      {
        factId: "fact-1",
        memoryClass: "project",
        sourceKind: "decision",
        score: 10,
        content: "Use sqlite for the Engram store.",
      },
    ]);
    expect(xml).toContain('<engram_recall query="query">');
    expect(xml).toContain('<fact fact_id="fact-1"');
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

  it("normalizes recall candidates and promotes project facts to prepend tier", () => {
    const ranked = rankRecallCandidates(
      [
        {
          kind: "fact",
          factId: "fact-1",
          memoryClass: "project",
          sourceKind: "decision",
          score: 12,
          content: "Use sqlite for the Engram store.",
        },
      ],
      [
        {
          kind: "memory",
          chunkId: "chunk-1",
          collectionId: "docs",
          title: "Migration Notes",
          score: 6,
          snippet: "Import runs are stored in engram_import_runs.",
        },
      ],
      { recallMaxResults: 3 },
    );

    expect(ranked[0]?.normalizedScore).toBe(1);
    expect(ranked[0]?.target).toBe("prepend");
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

  it("injects approved fact recall even when no KB hit exists", async () => {
    const root = mkdtempSync(join(tmpdir(), "engram-recall-fact-"));
    tempPaths.push(root);
    const dbPath = join(root, "engram.db");
    const database = openDatabase(dbPath);
    database.close();
    const config = resolveEngramConfig({ dbPath });

    rememberFact(config, {
      content: "Use sqlite for the Engram store.",
      memoryClass: "project",
      sourceKind: "decision",
    });

    const hook = createBeforePromptBuildHook(config);
    const result = await hook({
      prompt: 'fallback',
      messages: [{ role: 'user', content: 'Which store did we choose for engram?' }],
    });

    expect(result?.prependSystemContext).toContain('<fact ');
    expect(result?.prependSystemContext).toContain('Use sqlite for the Engram store.');
  });

  it("accumulates project recall in prepend context across turns and evicts oldest entries when capped", async () => {
    const root = mkdtempSync(join(tmpdir(), "engram-recall-prepend-cap-"));
    tempPaths.push(root);
    const dbPath = join(root, "engram.db");
    const database = openDatabase(dbPath);
    database.close();
    const config = resolveEngramConfig({ dbPath, recallPrependMaxTokens: 5, recallMaxResults: 1 });

    rememberFact(config, {
      content: "Use sqlite.",
      memoryClass: "project",
      sourceKind: "decision",
    });
    rememberFact(config, {
      content: "Keep fallback search.",
      memoryClass: "project",
      sourceKind: "decision",
    });

    const hook = createBeforePromptBuildHook(config);
    const first = await hook({
      sessionId: "session-1",
      messages: [{ role: 'user', content: 'Which store should we use?' }],
    });
    const second = await hook({
      sessionId: "session-1",
      messages: [{ role: 'user', content: 'How should fallback search behave?' }],
    });

    expect(first?.prependSystemContext).toContain('Use sqlite.');
    expect(second?.prependSystemContext).toContain('Keep fallback search.');
    expect(second?.prependSystemContext).not.toContain('Use sqlite.');
  });

  it("logs would-be recall blocks in shadow mode instead of injecting them", async () => {
    const root = mkdtempSync(join(tmpdir(), "engram-recall-shadow-"));
    tempPaths.push(root);
    const dbPath = join(root, "engram.db");
    const shadowLogFile = join(root, "shadow.log");
    const database = openDatabase(dbPath);
    database.close();
    const config = resolveEngramConfig({ dbPath, recallShadowMode: true, recallShadowLogFile: shadowLogFile });

    rememberFact(config, {
      content: "Use sqlite for the Engram store.",
      memoryClass: "project",
      sourceKind: "decision",
    });

    const hook = createBeforePromptBuildHook(config);
    const result = await hook({
      prompt: "fallback",
      messages: [{ role: "user", content: "Which store did we choose for engram?" }],
    });

    expect(result?.appendSystemContext).toBeUndefined();
    expect(result?.prependSystemContext).toBeUndefined();
    expect(existsSync(shadowLogFile)).toBe(true);
    expect(readFileSync(shadowLogFile, "utf8")).toContain("Use sqlite for the Engram store.");
  });
});