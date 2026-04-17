import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase } from "../src/db/connection.js";
import { compactConversation } from "../src/engine/compaction.js";

const tempPaths: string[] = [];

afterEach(() => {
  while (tempPaths.length > 0) {
    const current = tempPaths.pop();
    if (current) {
      rmSync(current, { recursive: true, force: true });
    }
  }
});

describe("compactConversation", () => {
  it("replaces older raw messages with a summary while keeping the fresh tail", async () => {
    const root = mkdtempSync(join(tmpdir(), "engram-compact-"));
    tempPaths.push(root);
    const dbPath = join(root, "engram.db");
    const database = openDatabase(dbPath);
    try {
      database.db.exec(`INSERT INTO conversations (conversation_id, session_id, session_key, created_at) VALUES ('c1', 's1', 'k1', datetime('now'));`);
      for (let index = 0; index < 6; index += 1) {
        database.db.prepare(`
          INSERT INTO messages (message_id, conversation_id, seq, role, content, token_count, created_at)
          VALUES (?, 'c1', ?, 'user', ?, 10, datetime('now'))
        `).run(`m${index}`, index, `message ${index}`);
        database.db.prepare(`
          INSERT INTO context_items (conversation_id, ordinal, item_type, message_id, summary_id, created_at)
          VALUES ('c1', ?, 'message', ?, NULL, datetime('now'))
        `).run(index, `m${index}`);
      }

      const result = await compactConversation(database.db, {
        conversationId: 'c1',
        freshTailCount: 2,
        targetTokens: 20,
        condensedTargetTokens: 20,
        incrementalMaxDepth: 0,
      });

      const contextCount = (database.db.prepare(`SELECT COUNT(*) AS count FROM context_items WHERE conversation_id = 'c1'`).get() as { count: number }).count;
      const summaryCount = (database.db.prepare(`SELECT COUNT(*) AS count FROM summaries WHERE conversation_id = 'c1'`).get() as { count: number }).count;
      const newestMessageIds = database.db.prepare(`
        SELECT message_id FROM context_items WHERE conversation_id = 'c1' AND item_type = 'message' ORDER BY ordinal ASC
      `).all() as Array<{ message_id: string }>;

      expect(result.compacted).toBe(true);
      expect(result.leaf?.kind).toBe('leaf');
      expect(summaryCount).toBe(1);
      expect(contextCount).toBe(3);
      expect(newestMessageIds.map((row) => row.message_id)).toEqual(['m4', 'm5']);
    } finally {
      database.close();
    }
  });

  it("condenses contiguous same-depth summaries into a higher-depth parent", async () => {
    const root = mkdtempSync(join(tmpdir(), "engram-condense-"));
    tempPaths.push(root);
    const dbPath = join(root, "engram.db");
    const database = openDatabase(dbPath);
    try {
      database.db.exec(`
        INSERT INTO conversations (conversation_id, session_id, session_key, created_at) VALUES ('c1', 's1', 'k1', datetime('now'));
        INSERT INTO summaries (summary_id, conversation_id, kind, depth, content, token_count, created_at) VALUES
          ('sum-a', 'c1', 'leaf', 0, 'older context a', 4, datetime('now')),
          ('sum-b', 'c1', 'leaf', 0, 'older context b', 4, datetime('now')),
          ('sum-c', 'c1', 'leaf', 0, 'older context c', 4, datetime('now'));
        INSERT INTO context_items (conversation_id, ordinal, item_type, message_id, summary_id, created_at) VALUES
          ('c1', 0, 'summary', NULL, 'sum-a', datetime('now')),
          ('c1', 1, 'summary', NULL, 'sum-b', datetime('now')),
          ('c1', 2, 'summary', NULL, 'sum-c', datetime('now'));
      `);

      const result = await compactConversation(database.db, {
        conversationId: 'c1',
        freshTailCount: 2,
        targetTokens: 20,
        condensedTargetTokens: 20,
        incrementalMaxDepth: 2,
      });

      const parentLinks = (database.db.prepare(`SELECT COUNT(*) AS count FROM summary_parents`).get() as { count: number }).count;
      const summaries = database.db.prepare(`SELECT kind, depth FROM summaries`).all() as Array<{ kind: string; depth: number }>;
      const contextItems = database.db.prepare(`SELECT item_type, summary_id FROM context_items WHERE conversation_id = 'c1' ORDER BY ordinal ASC`).all() as Array<{ item_type: string; summary_id: string | null }>;

      expect(result.compacted).toBe(true);
      expect(result.leaf).toBeUndefined();
      expect(result.condensed).toHaveLength(1);
      expect(result.condensed[0]?.kind).toBe('condensed');
      expect(result.condensed[0]?.depth).toBe(1);
      expect(parentLinks).toBe(3);
      expect(summaries.some((row) => row.kind === 'condensed' && row.depth === 1)).toBe(true);
      expect(contextItems).toHaveLength(1);
      expect(contextItems[0]?.item_type).toBe('summary');
    } finally {
      database.close();
    }
  });

  it("uses an async summarizer callback when provided", async () => {
    const root = mkdtempSync(join(tmpdir(), "engram-compact-runtime-"));
    tempPaths.push(root);
    const dbPath = join(root, "engram.db");
    const database = openDatabase(dbPath);
    try {
      database.db.exec(`INSERT INTO conversations (conversation_id, session_id, session_key, created_at) VALUES ('c1', 's1', 'k1', datetime('now'));`);
      for (let index = 0; index < 4; index += 1) {
        database.db.prepare(`
          INSERT INTO messages (message_id, conversation_id, seq, role, content, token_count, created_at)
          VALUES (?, 'c1', ?, 'user', ?, 10, datetime('now'))
        `).run(`m${index}`, index, `message ${index}`);
        database.db.prepare(`
          INSERT INTO context_items (conversation_id, ordinal, item_type, message_id, summary_id, created_at)
          VALUES ('c1', ?, 'message', ?, NULL, datetime('now'))
        `).run(index, `m${index}`);
      }

      const result = await compactConversation(database.db, {
        conversationId: 'c1',
        freshTailCount: 1,
        targetTokens: 20,
        condensedTargetTokens: 20,
        incrementalMaxDepth: 0,
        summarize: async (_text, _tokens, mode) => `runtime-${mode}-summary`,
      });

      expect(result.leaf?.summaryId).toBeTruthy();
      const summaryId = result.leaf?.summaryId;
      if (!summaryId) {
        throw new Error('Expected leaf summary id to be present');
      }
      const created = database.db.prepare(`SELECT content FROM summaries WHERE summary_id = ?`).get(summaryId) as { content: string } | undefined;
      expect(created?.content).toBe('runtime-leaf-summary');
    } finally {
      database.close();
    }
  });
});