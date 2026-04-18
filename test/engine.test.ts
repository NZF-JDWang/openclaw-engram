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
});