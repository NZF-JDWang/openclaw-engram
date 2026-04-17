import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveEngramConfig } from "../../src/config.js";
import { openDatabase } from "../../src/db/connection.js";
import { EngramContextEngine } from "../../src/engine/engine.js";

const tempPaths: string[] = [];

afterEach(() => {
  while (tempPaths.length > 0) {
    const current = tempPaths.pop();
    if (current) {
      rmSync(current, { recursive: true, force: true });
    }
  }
});

describe("integration continuity", () => {
  it("injects the prior session artifact into a fresh session bootstrap", async () => {
    const root = mkdtempSync(join(tmpdir(), "engram-integration-continuity-"));
    tempPaths.push(root);
    const dbPath = join(root, "engram.db");
    const database = openDatabase(dbPath);
    const config = resolveEngramConfig({ dbPath });
    const engine = new EngramContextEngine(database, config);
    try {
      await engine.bootstrap({ sessionId: "session-a", sessionFile: "a.jsonl", sessionKey: "key-a" });
      await engine.afterTurn({
        sessionId: "session-a",
        sessionFile: "a.jsonl",
        messages: [
          { role: "user", content: "Finish wiring the configured KB collection sync." },
          { role: "assistant", content: "Configured KB collection sync was wired and validated." },
        ],
        prePromptMessageCount: 0,
      });

      await engine.bootstrap({ sessionId: "session-b", sessionFile: "b.jsonl", sessionKey: "key-b" });
      const assembled = await engine.assemble({
        sessionId: "session-b",
        messages: [{ role: "user", content: "continue" }],
        tokenBudget: 1000,
      });

      expect(assembled.systemPromptAddition).toContain("<prior_session>");
      expect(assembled.systemPromptAddition).toContain("Finish wiring the configured KB collection sync.");
      expect(assembled.systemPromptAddition).toContain("Configured KB collection sync was wired and validated.");
    } finally {
      await engine.dispose();
    }
  });
});