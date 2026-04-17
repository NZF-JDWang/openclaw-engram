import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase } from "../src/db/connection.js";
import { formatPriorSessionBlock, readPreviousSessionArtifact, updateSessionEndArtifact } from "../src/engine/session-end.js";

const tempPaths: string[] = [];

afterEach(() => {
  while (tempPaths.length > 0) {
    const current = tempPaths.pop();
    if (current) {
      rmSync(current, { recursive: true, force: true });
    }
  }
});

describe("session-end artifacts", () => {
  it("extracts structured goal, decisions, and open questions from recent turns", () => {
    const root = mkdtempSync(join(tmpdir(), "engram-session-end-"));
    tempPaths.push(root);
    const dbPath = join(root, "engram.db");
    const database = openDatabase(dbPath);
    try {
      database.db.exec(`
        INSERT INTO conversations (conversation_id, session_id, session_key, created_at)
        VALUES ('session-1', 'session-1', 'key-1', datetime('now'));
      `);
      updateSessionEndArtifact(database.db, {
        conversationId: "session-1",
        messages: [
          { role: "user", content: "We need to finish the KB collection sync today. Should startup sync stay enabled by default?" },
          { role: "assistant", content: "We decided to keep startup sync configurable and added validation for it. The command path was also wired." },
        ],
      });

      database.db.exec(`
        INSERT INTO conversations (conversation_id, session_id, session_key, created_at)
        VALUES ('session-2', 'session-2', 'key-2', datetime('now'));
      `);
      const artifact = readPreviousSessionArtifact(database.db, "session-2");

      expect(artifact?.goal).toContain("Should startup sync stay enabled by default?");
      expect(artifact?.decisions).toContain("We decided to keep startup sync configurable");
      expect(artifact?.open_questions).toContain("Should startup sync stay enabled by default?");
      expect(formatPriorSessionBlock(artifact!)).toContain("<prior_session>");
    } finally {
      database.close();
    }
  });
});