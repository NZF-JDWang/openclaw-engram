import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveEngramConfig } from "../src/config.js";
import { openDatabase } from "../src/db/connection.js";
import { EngramContextEngine } from "../src/engine/engine.js";

const tempPaths: string[] = [];

afterEach(() => {
  while (tempPaths.length > 0) {
    const current = tempPaths.pop();
    if (current) {
      rmSync(current, { recursive: true, force: true });
    }
  }
});

describe("EngramContextEngine", () => {
  it("assembles stored context items and renders summaries as XML", async () => {
    const root = mkdtempSync(join(tmpdir(), "engram-engine-"));
    tempPaths.push(root);
    const dbPath = join(root, "engram.db");
    const database = openDatabase(dbPath);
    const config = resolveEngramConfig({ dbPath });
    const engine = new EngramContextEngine(database, config);
    try {
      database.db.exec(`
        INSERT INTO conversations (conversation_id, session_id, session_key, created_at) VALUES ('c1', 's1', 'k1', datetime('now'));
        INSERT INTO messages (message_id, conversation_id, seq, role, content, token_count, created_at) VALUES ('m1', 'c1', 0, 'user', 'hello', 1, datetime('now'));
        INSERT INTO summaries (summary_id, conversation_id, kind, depth, content, token_count, created_at) VALUES ('sum1', 'c1', 'leaf', 0, 'older context', 2, datetime('now'));
        INSERT INTO context_items (conversation_id, ordinal, item_type, message_id, summary_id, created_at) VALUES
          ('c1', 0, 'summary', NULL, 'sum1', datetime('now')),
          ('c1', 1, 'message', 'm1', NULL, datetime('now'));
      `);

      const assembled = await engine.assemble({ sessionId: 'c1', messages: [], tokenBudget: 1000 });

      expect(assembled.messages).toHaveLength(2);
      expect(String((assembled.messages[0] as { content: string }).content)).toContain('<summary id="sum1"');
      expect(String((assembled.messages[1] as { content: string }).content)).toContain('hello');
    } finally {
      await engine.dispose();
    }
  });

  it("manual compaction uses a smaller protected tail than afterTurn compaction", async () => {
    const root = mkdtempSync(join(tmpdir(), "engram-engine-manual-compact-"));
    tempPaths.push(root);
    const dbPath = join(root, "engram.db");
    const database = openDatabase(dbPath);
    const config = resolveEngramConfig({ dbPath, freshTailCount: 8, leafTargetTokens: 20, condensedTargetTokens: 20 });
    const engine = new EngramContextEngine(database, config);
    try {
      database.db.exec(`INSERT INTO conversations (conversation_id, session_id, session_key, created_at) VALUES ('c1', 'c1', 'k1', datetime('now'));`);
      for (let index = 0; index < 9; index += 1) {
        database.db.prepare(`
          INSERT INTO messages (message_id, conversation_id, seq, role, content, token_count, created_at)
          VALUES (?, 'c1', ?, 'user', ?, 100, datetime('now'))
        `).run(`m${index}`, index, `message ${index}`);
        database.db.prepare(`
          INSERT INTO context_items (conversation_id, ordinal, item_type, message_id, summary_id, created_at)
          VALUES ('c1', ?, 'message', ?, NULL, datetime('now'))
        `).run(index, `m${index}`);
      }

      const result = await engine.compact({ sessionId: 'c1' });
      const contextItems = database.db.prepare(`
        SELECT item_type, message_id, summary_id
        FROM context_items
        WHERE conversation_id = 'c1'
        ORDER BY ordinal ASC
      `).all() as Array<{ item_type: string; message_id: string | null; summary_id: string | null }>;
      const details = result.result?.details as { replacedItems?: number } | undefined;

      expect(result.compacted).toBe(true);
      expect(details?.replacedItems).toBe(7);
      expect(contextItems).toHaveLength(3);
      expect(contextItems[0]?.item_type).toBe('summary');
      expect(contextItems.slice(1).map((item) => item.message_id)).toEqual(['m7', 'm8']);
    } finally {
      await engine.dispose();
    }
  });

  it("persists new turn messages from afterTurn so UUID sessions can compact and recall", async () => {
    const root = mkdtempSync(join(tmpdir(), "engram-engine-afterturn-ingest-"));
    tempPaths.push(root);
    const dbPath = join(root, "engram.db");
    const database = openDatabase(dbPath);
    const config = resolveEngramConfig({
      dbPath,
      freshTailCount: 2,
      leafTargetTokens: 20,
      condensedTargetTokens: 20,
    });
    const engine = new EngramContextEngine(database, config);
    const transcript = [
      { role: "user", content: "Preserve qmd chunk metadata during every migration import." },
      { role: "assistant", content: "Every migration import will preserve qmd chunk metadata." },
      { role: "user", content: "Keep audit trails so repeated imports remain idempotent." },
      { role: "assistant", content: "Audit trails will keep repeated imports idempotent." },
      { role: "user", content: "Index compacted summaries so recall can find decisions later." },
      { role: "assistant", content: "Compacted summaries will stay searchable for later recall." },
    ];

    try {
      await engine.bootstrap({ sessionId: "uuid-session", sessionFile: "uuid-session.jsonl", sessionKey: "uuid-key" });

      for (let index = 2; index <= transcript.length; index += 2) {
        await engine.afterTurn({
          sessionId: "uuid-session",
          sessionKey: "uuid-key",
          sessionFile: "uuid-session.jsonl",
          messages: transcript.slice(0, index),
          prePromptMessageCount: index - 2,
        });
      }

      const messageCount = (
        database.db.prepare("SELECT COUNT(*) AS count FROM messages WHERE conversation_id = 'uuid-session'").get() as { count: number }
      ).count;
      const summaryCount = (
        database.db.prepare("SELECT COUNT(*) AS count FROM summaries WHERE conversation_id = 'uuid-session'").get() as { count: number }
      ).count;
      const assembled = await engine.assemble({
        sessionId: "uuid-session",
        messages: [{ role: "user", content: "What did we decide?" }],
        tokenBudget: 1000,
      });

      expect(messageCount).toBe(transcript.length);
      expect(summaryCount).toBeGreaterThan(0);
      expect(assembled.estimatedTokens).toBeGreaterThan(0);
    } finally {
      await engine.dispose();
    }
  });

  it("afterTurn scans the assistant response and marks recall events as referenced", async () => {
    const root = mkdtempSync(join(tmpdir(), "engram-engine-feedback-"));
    tempPaths.push(root);
    const dbPath = join(root, "engram.db");
    const database = openDatabase(dbPath);
    const config = resolveEngramConfig({ dbPath, recallFeedbackEnabled: true });
    const engine = new EngramContextEngine(database, config);
    try {
      database.db.exec(`
        INSERT INTO conversations (conversation_id, session_id, session_key, created_at) VALUES ('sess-1', 'sess-1', 'key-1', datetime('now'));
        INSERT INTO kb_collections (name, path, pattern, description, auto_index, fts5_available, created_at) VALUES ('docs', '.', '**/*.md', 'Docs', 0, 0, datetime('now'));
        INSERT INTO kb_documents (doc_id, collection_name, rel_path, title, content_hash, token_count, indexed_at) VALUES ('doc-1', 'docs', 'notes/qmd-migration.md', 'QMD Migration Notes', 'abc', 10, datetime('now'));
        INSERT INTO kb_chunks (chunk_id, doc_id, collection_name, ordinal, content, token_count, chunk_hash, derivation_depth) VALUES ('chunk-1', 'doc-1', 'docs', 0, 'qmd migration import process', 10, 'chunk-abc', 0);
        INSERT INTO recall_events (event_id, conversation_id, chunk_id, injected_score, was_referenced, created_at) VALUES ('evt-1', 'sess-1', 'chunk-1', 0.85, 0, datetime('now'));
        INSERT INTO messages (message_id, conversation_id, seq, role, content, token_count, created_at) VALUES ('m1', 'sess-1', 0, 'user', 'how does qmd migration work?', 5, datetime('now'));
        INSERT INTO context_items (conversation_id, ordinal, item_type, message_id, summary_id, created_at) VALUES ('sess-1', 0, 'message', 'm1', NULL, datetime('now'));
      `);

      await engine.afterTurn({
        sessionId: "sess-1",
        sessionKey: "key-1",
        sessionFile: "/tmp/sess.json",
        messages: [
          { role: "user", content: "how does qmd migration work?" },
          { role: "assistant", content: "The qmd migration notes describe how the import process handles duplicate runs and tracks state." },
        ],
        prePromptMessageCount: 1,
      });

      const row = database.db.prepare(
        "SELECT was_referenced FROM recall_events WHERE event_id = 'evt-1'",
      ).get() as { was_referenced: number };
      expect(row.was_referenced).toBe(1);
    } finally {
      await engine.dispose();
    }
  });

  it("afterTurn does not scan recall events when recallFeedbackEnabled is false", async () => {
    const root = mkdtempSync(join(tmpdir(), "engram-engine-nofeedback-"));
    tempPaths.push(root);
    const dbPath = join(root, "engram.db");
    const database = openDatabase(dbPath);
    const config = resolveEngramConfig({ dbPath, recallFeedbackEnabled: false });
    const engine = new EngramContextEngine(database, config);
    try {
      database.db.exec(`
        INSERT INTO conversations (conversation_id, session_id, session_key, created_at) VALUES ('sess-2', 'sess-2', 'key-2', datetime('now'));
        INSERT INTO kb_collections (name, path, pattern, description, auto_index, fts5_available, created_at) VALUES ('docs', '.', '**/*.md', 'Docs', 0, 0, datetime('now'));
        INSERT INTO kb_documents (doc_id, collection_name, rel_path, title, content_hash, token_count, indexed_at) VALUES ('doc-1', 'docs', 'notes/qmd-migration.md', 'QMD Migration Notes', 'abc', 10, datetime('now'));
        INSERT INTO kb_chunks (chunk_id, doc_id, collection_name, ordinal, content, token_count, chunk_hash, derivation_depth) VALUES ('chunk-1', 'doc-1', 'docs', 0, 'qmd migration import process', 10, 'chunk-abc', 0);
        INSERT INTO recall_events (event_id, conversation_id, chunk_id, injected_score, was_referenced, created_at) VALUES ('evt-2', 'sess-2', 'chunk-1', 0.85, 0, datetime('now'));
        INSERT INTO messages (message_id, conversation_id, seq, role, content, token_count, created_at) VALUES ('m1', 'sess-2', 0, 'user', 'question', 1, datetime('now'));
        INSERT INTO context_items (conversation_id, ordinal, item_type, message_id, summary_id, created_at) VALUES ('sess-2', 0, 'message', 'm1', NULL, datetime('now'));
      `);

      await engine.afterTurn({
        sessionId: "sess-2",
        sessionKey: "key-2",
        sessionFile: "/tmp/sess2.json",
        messages: [
          { role: "user", content: "question" },
          { role: "assistant", content: "The qmd migration notes explain the import process in detail." },
        ],
        prePromptMessageCount: 1,
      });

      const row = database.db.prepare(
        "SELECT was_referenced FROM recall_events WHERE event_id = 'evt-2'",
      ).get() as { was_referenced: number };
      expect(row.was_referenced).toBe(0);
    } finally {
      await engine.dispose();
    }
  });
});
