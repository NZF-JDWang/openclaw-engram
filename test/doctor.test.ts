import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveEngramConfig } from "../src/config.js";
import { openDatabase } from "../src/db/connection.js";
import { formatDoctorReport, runDoctor } from "../src/plugin/doctor.js";

const tempPaths: string[] = [];

afterEach(() => {
  while (tempPaths.length > 0) {
    const current = tempPaths.pop();
    if (current) {
      rmSync(current, { recursive: true, force: true });
    }
  }
  vi.unstubAllGlobals();
});

describe("runDoctor", () => {
  it("warns when the database file does not exist yet", async () => {
    const root = mkdtempSync(join(tmpdir(), "engram-doctor-missing-"));
    tempPaths.push(root);
    const config = resolveEngramConfig({ dbPath: join(root, "engram.db") });

    const report = await runDoctor(config);

    expect(report.ok).toBe(true);
    expect(report.checks.find((check) => check.key === "db.file")?.status).toBe("warn");
    expect(report.checks.find((check) => check.key === "kb.embeddingEndpoint")?.status).toBe("pass");
  });

  it("passes integrity and schema checks for a bootstrapped database", async () => {
    const root = mkdtempSync(join(tmpdir(), "engram-doctor-db-"));
    tempPaths.push(root);
    mkdirSync(root, { recursive: true });
    const dbPath = join(root, "engram.db");
    const db = openDatabase(dbPath);
    db.close();

    const report = await runDoctor(resolveEngramConfig({ dbPath }));

    expect(report.ok).toBe(true);
    expect(report.checks.find((check) => check.key === "db.diskSpace")?.status).toBe("pass");
    expect(report.checks.find((check) => check.key === "db.integrity")?.status).toBe("pass");
    expect(report.checks.find((check) => check.key === "db.schemaVersion")?.status).toBe("pass");
    expect(report.checks.find((check) => check.key === "migration.imports")?.status).toBe("warn");
    expect(formatDoctorReport(report)).toContain("Engram doctor");
  });


  it("surfaces embedding coverage, import runs, and endpoint reachability", async () => {
    const root = mkdtempSync(join(tmpdir(), "engram-doctor-embeds-"));
    tempPaths.push(root);
    const dbPath = join(root, "engram.db");
    const db = openDatabase(dbPath);
    try {
      db.db.exec(`
        INSERT INTO engram_import_runs (import_id, source_kind, source_path, record_counts_json, imported_at)
        VALUES ('import-1', 'qmd', 'C:/qmd/index.sqlite', '{"documents":1}', datetime('now'));
        INSERT INTO kb_collections (name, path, pattern, created_at) VALUES ('docs', 'C:/docs', '**/*.md', datetime('now'));
        INSERT INTO kb_documents (doc_id, collection_name, rel_path, title, content_hash, token_count, indexed_at)
        VALUES ('d1', 'docs', 'a.md', 'A', 'hash', 1, datetime('now'));
        INSERT INTO kb_chunks (chunk_id, doc_id, collection_name, ordinal, content, token_count, chunk_hash, derivation_depth)
        VALUES ('ch1', 'd1', 'docs', 0, 'body', 1, 'hash', 0);
        INSERT INTO kb_embeddings (chunk_id, model, vector, dimensions, created_at)
        VALUES ('ch1', 'nomic-embed-text', X'00000000', 1, datetime('now'));
      `);
    } finally {
      db.close();
    }

    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200 })));

    const report = await runDoctor(resolveEngramConfig({ dbPath, embedEnabled: true }));

    expect(report.checks.find((check) => check.key === "migration.imports")?.status).toBe("pass");
    expect(report.checks.find((check) => check.key === "kb.embeddings")?.status).toBe("pass");
    expect(report.checks.find((check) => check.key === "kb.embeddingEndpoint")?.status).toBe("pass");
  });

  it("warns when FTS is unavailable for a large KB", async () => {
    const root = mkdtempSync(join(tmpdir(), "engram-doctor-kb-fts-"));
    tempPaths.push(root);
    const dbPath = join(root, "engram.db");
    const db = openDatabase(dbPath);
    try {
      db.db.exec(`DROP TABLE IF EXISTS kb_chunks_fts;`);
      db.db.exec(`
        INSERT INTO kb_collections (name, path, pattern, created_at) VALUES ('docs', 'C:/docs', '**/*.md', datetime('now'));
      `);

      const insertDocument = db.db.prepare(`
        INSERT INTO kb_documents (doc_id, collection_name, rel_path, title, content_hash, token_count, indexed_at)
        VALUES (?, 'docs', ?, ?, ?, 1, datetime('now'))
      `);
      const insertChunk = db.db.prepare(`
        INSERT INTO kb_chunks (chunk_id, doc_id, collection_name, ordinal, content, token_count, chunk_hash, derivation_depth)
        VALUES (?, ?, 'docs', 0, 'body', 1, ?, 0)
      `);

      for (let index = 0; index < 5001; index += 1) {
        insertDocument.run(`d${index}`, `doc-${index}.md`, `Doc ${index}`, `hash-${index}`);
        insertChunk.run(`ch${index}`, `d${index}`, `chunk-hash-${index}`);
      }
    } finally {
      db.close();
    }

    const report = await runDoctor(resolveEngramConfig({ dbPath }));

    expect(report.checks.find((check) => check.key === "kb.fts")?.status).toBe("warn");
    expect(report.checks.find((check) => check.key === "kb.searchReadiness")?.status).toBe("warn");
  });

  it("reports circuit breaker and benchmark status for indexed KB data", async () => {
    const root = mkdtempSync(join(tmpdir(), "engram-doctor-benchmark-"));
    tempPaths.push(root);
    const dbPath = join(root, "engram.db");
    const db = openDatabase(dbPath);
    try {
      db.db.exec(`
        INSERT INTO kb_collections (name, path, pattern, created_at) VALUES ('docs', 'C:/docs', '**/*.md', datetime('now'));
        INSERT INTO kb_documents (doc_id, collection_name, rel_path, title, content_hash, token_count, indexed_at)
        VALUES ('doc-1', 'docs', 'guide.md', 'Guide', 'hash-1', 1, datetime('now'));
        INSERT INTO kb_chunks (chunk_id, doc_id, collection_name, ordinal, content, token_count, chunk_hash, derivation_depth)
        VALUES ('chunk-1', 'doc-1', 'docs', 0, 'sqlite architecture benchmark data', 1, 'hash-1', 0);
      `);
    } finally {
      db.close();
    }

    const report = await runDoctor(resolveEngramConfig({ dbPath, kbSessionIndexCircuitBreaker: false }));

    expect(report.checks.find((check) => check.key === "kb.sessionCircuitBreaker")?.status).toBe("warn");
    expect(report.checks.find((check) => check.key === "kb.searchBenchmark")?.message).toContain("completed in");
  });

  it("fails when the embedding endpoint probe errors while embeddings are enabled", async () => {
    const root = mkdtempSync(join(tmpdir(), "engram-doctor-endpoint-fail-"));
    tempPaths.push(root);
    const dbPath = join(root, "engram.db");
    const db = openDatabase(dbPath);
    db.close();

    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("connect ECONNREFUSED");
    }));

    const report = await runDoctor(resolveEngramConfig({ dbPath, embedEnabled: true }));

    expect(report.ok).toBe(false);
    expect(report.checks.find((check) => check.key === "kb.embeddingEndpoint")?.status).toBe("fail");
  });
});