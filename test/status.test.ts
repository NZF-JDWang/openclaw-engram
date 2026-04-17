import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveEngramConfig } from "../src/config.js";
import { openDatabase } from "../src/db/connection.js";
import { formatStatus, readStatus } from "../src/plugin/status.js";

const tempPaths: string[] = [];

afterEach(() => {
  while (tempPaths.length > 0) {
    const current = tempPaths.pop();
    if (current) {
      rmSync(current, { recursive: true, force: true });
    }
  }
});

describe("readStatus", () => {
  it("reports zero counts when the database does not exist", () => {
    const root = mkdtempSync(join(tmpdir(), "engram-status-missing-"));
    tempPaths.push(root);
    const config = resolveEngramConfig({ dbPath: join(root, "missing.db") });

    const snapshot = readStatus(config);

    expect(snapshot.dbExists).toBe(false);
    expect(snapshot.messages).toBe(0);
  });

  it("reports actual table counts from an existing database", () => {
    const root = mkdtempSync(join(tmpdir(), "engram-status-db-"));
    tempPaths.push(root);
    const dbPath = join(root, "engram.db");
    const db = openDatabase(dbPath);
    try {
      db.db.exec(`
        INSERT INTO conversations (conversation_id, session_id, session_key, created_at) VALUES ('c1', 's1', 'k1', datetime('now'));
        INSERT INTO messages (message_id, conversation_id, role, content, created_at) VALUES ('m1', 'c1', 'user', 'hello', datetime('now'));
        INSERT INTO kb_collections (name, path, pattern, created_at) VALUES ('docs', 'C:/docs', '**/*.md', datetime('now'));
        INSERT INTO kb_documents (doc_id, collection_name, rel_path, title, content_hash, token_count, indexed_at) VALUES ('d1', 'docs', 'a.md', 'A', 'hash', 1, datetime('now'));
        INSERT INTO kb_chunks (chunk_id, doc_id, collection_name, ordinal, content, token_count, chunk_hash, derivation_depth) VALUES ('ch1', 'd1', 'docs', 0, 'body', 1, 'hash', 0);
        INSERT INTO kb_embeddings (chunk_id, model, vector, dimensions, created_at) VALUES ('ch1', 'nomic-embed-text', X'00000000', 1, datetime('now'));
        INSERT INTO kb_facts (fact_id, content, memory_class, source_kind, source_basis, scope, lifecycle_state, approval_state, created_at, updated_at)
        VALUES ('f1', 'pending memory review', 'task', 'agent_inferred', 'agent_inferred', 'session', 'captured', 'pending', datetime('now'), datetime('now'));
      `);
    } finally {
      db.close();
    }

    const snapshot = readStatus(resolveEngramConfig({ dbPath }));

    expect(snapshot.dbExists).toBe(true);
    expect(snapshot.conversations).toBe(1);
    expect(snapshot.kbDocuments).toBe(1);
    expect(snapshot.kbEmbeddings).toBe(1);
    expect(snapshot.pendingFacts).toBe(1);
    expect(formatStatus(snapshot)).toContain("kbChunks: 1");
    expect(formatStatus(snapshot)).toContain("kbEmbeddings: 1");
    expect(formatStatus(snapshot)).toContain("pendingFacts: 1");
  });
});