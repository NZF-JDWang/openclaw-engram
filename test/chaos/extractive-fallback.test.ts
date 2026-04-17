import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PluginRuntime } from "openclaw/plugin-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
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

describe("chaos extractive fallback", () => {
  it("writes an extractive fallback marker when runtime summarization times out", async () => {
    const root = mkdtempSync(join(tmpdir(), "engram-chaos-extractive-fallback-"));
    tempPaths.push(root);
    const dbPath = join(root, "engram.db");
    const database = openDatabase(dbPath);
    const runtime = {
      subagent: {
        run: vi.fn(async () => ({ runId: "run-1" })),
        waitForRun: vi.fn(async () => ({ status: "timeout" as const })),
        getSessionMessages: vi.fn(async () => ({ messages: [] })),
        deleteSession: vi.fn(async () => undefined),
      },
      logging: {
        getChildLogger: vi.fn(() => ({ warn: vi.fn() })),
      },
    } as unknown as PluginRuntime;
    const engine = new EngramContextEngine(
      database,
      resolveEngramConfig({ dbPath, freshTailCount: 2, leafTargetTokens: 20, condensedTargetTokens: 20 }),
      runtime,
    );

    try {
      await engine.bootstrap({ sessionId: "session-a", sessionFile: "a.jsonl", sessionKey: "key-a" });
      await engine.ingestBatch({
        sessionId: "session-a",
        sessionKey: "key-a",
        messages: [
          { role: "user", content: "Preserve qmd chunk metadata during imports." },
          { role: "assistant", content: "Qmd chunk metadata will be preserved." },
          { role: "user", content: "Keep audit trails so imports remain idempotent." },
          { role: "assistant", content: "Audit trails will keep imports idempotent." },
        ],
      });
      await engine.afterTurn({
        sessionId: "session-a",
        sessionKey: "key-a",
        sessionFile: "a.jsonl",
        messages: [
          { role: "user", content: "Wrap up the migration decisions." },
          { role: "assistant", content: "The migration decisions are wrapped up." },
        ],
        prePromptMessageCount: 4,
      });

      const summaries = database.db.prepare(`SELECT content FROM summaries WHERE conversation_id = ?`).all("session-a") as Array<{ content: string }>;

      expect(summaries.length).toBeGreaterThan(0);
      expect(summaries.some((row) => row.content.includes("[Summarized — extractive fallback]"))).toBe(true);
    } finally {
      await engine.dispose();
    }
  });
});