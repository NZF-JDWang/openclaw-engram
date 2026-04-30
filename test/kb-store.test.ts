import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveEngramConfig } from "../src/config.js";
import { openDatabase } from "../src/db/connection.js";
import { getKnowledgeDocument, searchKnowledgeBase } from "../src/kb/store.js";

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

describe("knowledge base store", () => {
  it("searches kb_chunks and ranks title/path matches higher", async () => {
    const root = mkdtempSync(join(tmpdir(), "engram-kb-"));
    tempPaths.push(root);
    const dbPath = join(root, "engram.db");
    const database = openDatabase(dbPath);
    try {
      database.db.exec(`
        INSERT INTO kb_collections (name, path, pattern, created_at) VALUES ('docs', 'C:/docs', '**/*.md', datetime('now'));
        INSERT INTO kb_documents (doc_id, collection_name, rel_path, title, content_hash, token_count, indexed_at) VALUES
          ('doc-1', 'docs', 'docker-networking.md', 'Docker Networking', 'hash-1', 10, datetime('now')),
          ('doc-2', 'docs', 'misc.md', 'Misc Notes', 'hash-2', 10, datetime('now'));
        INSERT INTO kb_chunks (chunk_id, doc_id, collection_name, ordinal, content, token_count, chunk_hash, derivation_depth) VALUES
          ('chunk-1', 'doc-1', 'docs', 0, 'Docker networking on WSL requires host integration and bridge awareness.', 10, 'hash-1', 0),
          ('chunk-2', 'doc-2', 'docs', 0, 'Networking mention but not the main topic.', 10, 'hash-2', 0);
      `);
    } finally {
      database.close();
    }

    const config = resolveEngramConfig({ dbPath });
    const results = await searchKnowledgeBase(config, 'docker networking', { limit: 2 });

    expect(results).toHaveLength(2);
    expect(results[0]?.docId).toBe('doc-1');
    expect(results[0]?.score).toBeGreaterThan(results[1]?.score ?? 0);
    expect(results[0]?.memoryClass).toBe('reference');
    expect(results[0]?.sourceKind).toBe('document_derived');
  });

  it("reassembles a document by doc id or chunk id", () => {
    const root = mkdtempSync(join(tmpdir(), "engram-kb-doc-"));
    tempPaths.push(root);
    const dbPath = join(root, "engram.db");
    const database = openDatabase(dbPath);
    try {
      database.db.exec(`
        INSERT INTO kb_collections (name, path, pattern, created_at) VALUES ('docs', 'C:/docs', '**/*.md', datetime('now'));
        INSERT INTO kb_documents (doc_id, collection_name, rel_path, title, content_hash, token_count, indexed_at) VALUES ('doc-1', 'docs', 'guide.md', 'Guide', 'hash-1', 10, datetime('now'));
        INSERT INTO kb_chunks (chunk_id, doc_id, collection_name, ordinal, content, token_count, chunk_hash, derivation_depth) VALUES
          ('chunk-1', 'doc-1', 'docs', 0, 'First part', 2, 'hash-1', 0),
          ('chunk-2', 'doc-1', 'docs', 1, 'Second part', 2, 'hash-2', 0);
      `);
    } finally {
      database.close();
    }

    const config = resolveEngramConfig({ dbPath });
    const byDoc = getKnowledgeDocument(config, 'doc-1');
    const byChunk = getKnowledgeDocument(config, 'chunk-2');

    expect(byDoc?.content).toContain('First part');
    expect(byDoc?.content).toContain('Second part');
    expect(byChunk?.docId).toBe('doc-1');
  });

  it("ranks primary documents above stale session summaries for similar content", async () => {
    const root = mkdtempSync(join(tmpdir(), "engram-kb-rank-"));
    tempPaths.push(root);
    const dbPath = join(root, "engram.db");
    const database = openDatabase(dbPath);
    try {
      database.db.exec(`
        INSERT INTO kb_collections (name, path, pattern, created_at) VALUES
          ('docs', 'C:/docs', '**/*.md', datetime('now')),
          ('__sessions', 'engram://sessions', '*.summary', datetime('now'));
        INSERT INTO kb_documents (doc_id, collection_name, rel_path, title, content_hash, token_count, indexed_at) VALUES
          ('doc-1', 'docs', 'architecture.md', 'Architecture', 'hash-1', 10, datetime('now')),
          ('doc-2', '__sessions', 's1/summary.summary', 'Session Summary', 'hash-2', 10, datetime('now', '-30 day'));
        INSERT INTO kb_chunks (chunk_id, doc_id, collection_name, ordinal, content, token_count, chunk_hash, derivation_depth) VALUES
          ('chunk-1', 'doc-1', 'docs', 0, 'sqlite durable store architecture decision for engram', 10, 'hash-1', 0),
          ('chunk-2', 'doc-2', '__sessions', 0, 'sqlite durable store architecture decision for engram', 10, 'hash-2', 1);
      `);
    } finally {
      database.close();
    }

    const config = resolveEngramConfig({ dbPath });
    const results = await searchKnowledgeBase(config, 'sqlite durable store architecture decision', { limit: 2 });

    expect(results[0]?.collectionName).toBe('docs');
    expect(results[0]?.score).toBeGreaterThan(results[1]?.score ?? 0);
    expect(results[1]?.memoryClass).toBe('task');
  });

  it("applies configured recallWeight to boost a KB collection", async () => {
    const root = mkdtempSync(join(tmpdir(), "engram-kb-weight-"));
    tempPaths.push(root);
    const dbPath = join(root, "engram.db");
    const database = openDatabase(dbPath);
    try {
      database.db.exec(`
        INSERT INTO kb_collections (name, path, pattern, created_at) VALUES
          ('vault', 'C:/vault', '**/*.md', datetime('now')),
          ('notes', 'C:/notes', '**/*.md', datetime('now'));
        INSERT INTO kb_documents (doc_id, collection_name, rel_path, title, content_hash, token_count, indexed_at) VALUES
          ('doc-1', 'vault', 'supplement-stack.md', 'Supplement Stack', 'hash-1', 10, datetime('now')),
          ('doc-2', 'notes', 'misc.md', 'Misc Notes', 'hash-2', 10, datetime('now'));
        INSERT INTO kb_chunks (chunk_id, doc_id, collection_name, ordinal, content, token_count, chunk_hash, derivation_depth) VALUES
          ('chunk-1', 'doc-1', 'vault', 0, 'creatine supplements health routine', 10, 'hash-1', 0),
          ('chunk-2', 'doc-2', 'notes', 0, 'creatine supplements health routine', 10, 'hash-2', 0);
      `);
    } finally {
      database.close();
    }

    const config = resolveEngramConfig({
      dbPath,
      kbCollections: [
        { name: 'vault', path: 'C:/vault', pattern: '**/*.md', recallWeight: 2 },
        { name: 'notes', path: 'C:/notes', pattern: '**/*.md' },
      ],
    });
    const results = await searchKnowledgeBase(config, 'I started taking some new supplements for my health', { limit: 2 });

    expect(results[0]?.collectionName).toBe('vault');
    expect(results[0]?.score).toBeGreaterThan(results[1]?.score ?? 0);
  });

  it("uses stored embeddings to rerank lexical candidates when embedding search is enabled", async () => {
    const root = mkdtempSync(join(tmpdir(), "engram-kb-embed-rank-"));
    tempPaths.push(root);
    const dbPath = join(root, "engram.db");
    const database = openDatabase(dbPath);
    try {
      database.db.exec(`
        INSERT INTO kb_collections (name, path, pattern, created_at) VALUES ('docs', 'C:/docs', '**/*.md', datetime('now'));
        INSERT INTO kb_documents (doc_id, collection_name, rel_path, title, content_hash, token_count, indexed_at) VALUES
          ('doc-1', 'docs', 'alpha.md', 'Alpha', 'hash-1', 10, datetime('now')),
          ('doc-2', 'docs', 'beta.md', 'Beta', 'hash-2', 10, datetime('now'));
        INSERT INTO kb_chunks (chunk_id, doc_id, collection_name, ordinal, content, token_count, chunk_hash, derivation_depth) VALUES
          ('chunk-1', 'doc-1', 'docs', 0, 'shared terms for migration ranking alpha', 10, 'hash-1', 0),
          ('chunk-2', 'doc-2', 'docs', 0, 'shared terms for migration ranking beta', 10, 'hash-2', 0);
        INSERT INTO kb_embeddings (chunk_id, model, vector, dimensions, created_at) VALUES
          ('chunk-1', 'nomic-embed-text', X'0000803F00000000', 2, datetime('now')),
          ('chunk-2', 'nomic-embed-text', X'000000000000803F', 2, datetime('now'));
      `);
    } finally {
      database.close();
    }

    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      json: async () => ({ data: [{ embedding: [0, 1] }] }),
    })));

    const config = resolveEngramConfig({
      dbPath,
      embedEnabled: true,
      embedApiUrl: "http://localhost:11434/v1/embeddings",
      embedApiModel: "nomic-embed-text",
    });
    const results = await searchKnowledgeBase(config, 'shared migration ranking', { limit: 2 });

    expect(results[0]?.chunkId).toBe('chunk-2');
  });

  it("bypasses KB decay for configured whole-word keyword matches", async () => {
    const root = mkdtempSync(join(tmpdir(), "engram-kb-bypass-"));
    tempPaths.push(root);
    const dbPath = join(root, "engram.db");
    const database = openDatabase(dbPath);
    try {
      database.db.exec(`
        INSERT INTO kb_collections (name, path, pattern, created_at) VALUES ('docs', 'C:/docs', '**/*.md', datetime('now'));
        INSERT INTO kb_documents (doc_id, collection_name, rel_path, title, content_hash, token_count, indexed_at) VALUES
          ('doc-1', 'docs', 'old.md', 'Legacy sqlite note', 'hash-1', 10, datetime('now', '-200 day')),
          ('doc-2', 'docs', 'new.md', 'Fresh note', 'hash-2', 10, datetime('now'));
        INSERT INTO kb_chunks (chunk_id, doc_id, collection_name, ordinal, content, token_count, chunk_hash, derivation_depth) VALUES
          ('chunk-1', 'doc-1', 'docs', 0, 'sqlite durability reference', 10, 'chunk-1', 0),
          ('chunk-2', 'doc-2', 'docs', 0, 'durability reference', 10, 'chunk-2', 0);
      `);
    } finally {
      database.close();
    }

    const results = await searchKnowledgeBase(resolveEngramConfig({ dbPath }), 'sqlite durability', { limit: 2 });

    expect(results[0]?.chunkId).toBe('chunk-1');
  });

  it("returns lexical results when vector reranking exceeds the timeout budget", async () => {
    vi.useFakeTimers();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const root = mkdtempSync(join(tmpdir(), "engram-kb-timeout-vector-"));
    tempPaths.push(root);
    const dbPath = join(root, "engram.db");
    const database = openDatabase(dbPath);
    try {
      database.db.exec(`
        INSERT INTO kb_collections (name, path, pattern, created_at) VALUES ('docs', 'C:/docs', '**/*.md', datetime('now'));
        INSERT INTO kb_documents (doc_id, collection_name, rel_path, title, content_hash, token_count, indexed_at) VALUES
          ('doc-1', 'docs', 'alpha.md', 'Alpha', 'hash-1', 10, datetime('now')),
          ('doc-2', 'docs', 'beta.md', 'Beta', 'hash-2', 10, datetime('now'));
        INSERT INTO kb_chunks (chunk_id, doc_id, collection_name, ordinal, content, token_count, chunk_hash, derivation_depth) VALUES
          ('chunk-1', 'doc-1', 'docs', 0, 'sqlite architecture alpha signal', 10, 'hash-1', 0),
          ('chunk-2', 'doc-2', 'docs', 0, 'sqlite architecture beta signal', 10, 'hash-2', 0);
      `);
    } finally {
      database.close();
    }

    vi.stubGlobal("fetch", vi.fn((_url: string, init?: RequestInit) => new Promise((_resolve, reject) => {
      const signal = init?.signal as AbortSignal | undefined;
      signal?.addEventListener("abort", () => {
        const error = new Error("aborted");
        error.name = "AbortError";
        reject(error);
      }, { once: true });
    })));

    const config = resolveEngramConfig({
      dbPath,
      embedEnabled: true,
      kbSearchTimeoutMs: 5,
    });

    const pending = searchKnowledgeBase(config, "sqlite architecture", { limit: 2 });
    await vi.advanceTimersByTimeAsync(10);
    const results = await pending;

    expect(results).toHaveLength(2);
    expect(results[0]?.chunkId).toBe("chunk-1");
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("vector reranking exceeded timeout budget"));
    vi.useRealTimers();
  });

  it("aborts the embedding request when vector reranking exceeds the timeout budget", async () => {
    vi.useFakeTimers();

    const root = mkdtempSync(join(tmpdir(), "engram-kb-timeout-abort-"));
    tempPaths.push(root);
    const dbPath = join(root, "engram.db");
    const database = openDatabase(dbPath);
    try {
      database.db.exec(`
        INSERT INTO kb_collections (name, path, pattern, created_at) VALUES ('docs', 'C:/docs', '**/*.md', datetime('now'));
        INSERT INTO kb_documents (doc_id, collection_name, rel_path, title, content_hash, token_count, indexed_at) VALUES
          ('doc-1', 'docs', 'alpha.md', 'Alpha', 'hash-1', 10, datetime('now'));
        INSERT INTO kb_chunks (chunk_id, doc_id, collection_name, ordinal, content, token_count, chunk_hash, derivation_depth) VALUES
          ('chunk-1', 'doc-1', 'docs', 0, 'sqlite architecture alpha signal', 10, 'hash-1', 0);
      `);
    } finally {
      database.close();
    }

    let observedSignal: AbortSignal | undefined;
    vi.stubGlobal("fetch", vi.fn((_url: string, init?: RequestInit) => {
      observedSignal = init?.signal as AbortSignal | undefined;
      return new Promise((_resolve, reject) => {
        observedSignal?.addEventListener("abort", () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        }, { once: true });
      });
    }));

    const pending = searchKnowledgeBase(resolveEngramConfig({
      dbPath,
      embedEnabled: true,
      kbSearchTimeoutMs: 5,
    }), "sqlite architecture", { limit: 1 });

    await vi.advanceTimersByTimeAsync(10);
    await pending;

    expect(observedSignal?.aborted).toBe(true);
    vi.useRealTimers();
  });

  it("returns no results when lexical search exceeds the timeout budget", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const nowSpy = vi.spyOn(Date, "now");

    const root = mkdtempSync(join(tmpdir(), "engram-kb-timeout-lexical-"));
    tempPaths.push(root);
    const dbPath = join(root, "engram.db");
    const database = openDatabase(dbPath);
    try {
      database.db.exec(`
        INSERT INTO kb_collections (name, path, pattern, created_at) VALUES ('docs', 'C:/docs', '**/*.md', datetime('now'));
        INSERT INTO kb_documents (doc_id, collection_name, rel_path, title, content_hash, token_count, indexed_at) VALUES
          ('doc-1', 'docs', 'alpha.md', 'Alpha', 'hash-1', 10, datetime('now'));
        INSERT INTO kb_chunks (chunk_id, doc_id, collection_name, ordinal, content, token_count, chunk_hash, derivation_depth) VALUES
          ('chunk-1', 'doc-1', 'docs', 0, 'sqlite architecture alpha signal', 10, 'hash-1', 0);
      `);
    } finally {
      database.close();
    }

    nowSpy.mockReturnValueOnce(100).mockReturnValueOnce(260);

    const results = await searchKnowledgeBase(resolveEngramConfig({ dbPath, kbSearchTimeoutMs: 50 }), "sqlite architecture", { limit: 2 });

    expect(results).toHaveLength(0);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("Lexical KB search exceeded timeout"));
  });
});