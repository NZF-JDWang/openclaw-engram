import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveEngramConfig } from "../../src/config.js";
import { openDatabase } from "../../src/db/connection.js";
import { EngramContextEngine } from "../../src/engine/engine.js";
import { createBeforePromptBuildHook } from "../../src/plugin/recall.js";
import { readStatus } from "../../src/plugin/status.js";

const tempPaths: string[] = [];

afterEach(() => {
  while (tempPaths.length > 0) {
    const current = tempPaths.pop();
    if (current) {
      rmSync(current, { recursive: true, force: true });
    }
  }
});

describe("integration full session", () => {
  it("runs compaction, session-summary recall, and status reporting in one flow", async () => {
    const root = mkdtempSync(join(tmpdir(), "engram-integration-full-session-"));
    tempPaths.push(root);
    const dbPath = join(root, "engram.db");
    const config = resolveEngramConfig({
      dbPath,
      freshTailCount: 4,
      leafTargetTokens: 40,
      condensedTargetTokens: 30,
      recallMaxResults: 2,
    });
    const database = openDatabase(dbPath);
    const engine = new EngramContextEngine(database, config);
    const messages = [
      { role: "user", content: "We need the migration runner to preserve qmd chunk metadata in every import pass." },
      { role: "assistant", content: "I will preserve qmd chunk metadata and write migration audit trails for every import pass." },
      { role: "user", content: "Make the importer idempotent so repeated runs do not duplicate imported records." },
      { role: "assistant", content: "The importer will be idempotent and reuse migration audit trails instead of duplicating records." },
      { role: "user", content: "Keep the summary index searchable so follow-up recall can find migration decisions." },
      { role: "assistant", content: "Session summary indexing will keep migration decisions searchable for recall." },
      { role: "user", content: "We also need the doctor command to check the embedding endpoint before indexing." },
      { role: "assistant", content: "The doctor command will probe the embedding endpoint before indexing starts." },
      { role: "user", content: "Do not let qmd metadata disappear during compaction or migration cleanup." },
      { role: "assistant", content: "Compaction will retain qmd metadata decisions in the summary path." },
      { role: "user", content: "Make sure the migration audit trail remains visible in status and exports." },
      { role: "assistant", content: "Status and export output will retain the migration audit trail details." },
      { role: "user", content: "We should keep repeating the qmd chunk metadata rule so recall has a stable signal." },
      { role: "assistant", content: "Confirmed: preserve qmd chunk metadata, preserve qmd chunk metadata, and preserve migration audit trails." },
      { role: "user", content: "Store the final migration decisions in memory for the next session." },
      { role: "assistant", content: "The final migration decisions will be stored in session-end artifacts and searchable summaries." },
      { role: "user", content: "Before we wrap up, keep sqlite as the storage choice and preserve qmd metadata." },
      { role: "assistant", content: "Sqlite remains the storage choice, and qmd metadata preservation stays mandatory." },
      { role: "user", content: "Wrap the migration plan with qmd metadata retention and audit trail continuity." },
      { role: "assistant", content: "The migration plan is wrapped with qmd metadata retention and audit trail continuity." },
    ] as const;

    try {
      await engine.bootstrap({ sessionId: "session-full", sessionFile: "session-full.jsonl", sessionKey: "full-key" });
      await engine.ingestBatch({ sessionId: "session-full", sessionKey: "full-key", messages: [...messages] });
      await engine.afterTurn({
        sessionId: "session-full",
        sessionKey: "full-key",
        sessionFile: "session-full.jsonl",
        messages: [...messages.slice(-2)],
        prePromptMessageCount: messages.length - 2,
      });

      const assembled = await engine.assemble({
        sessionId: "session-full",
        messages: [{ role: "user", content: "Continue with the migration work." }],
        tokenBudget: 1200,
      });
      const status = readStatus(config);
      const hook = createBeforePromptBuildHook(config);
      const recall = await hook({
        sessionId: "session-full",
        messages: [{ role: "user", content: "What did we decide about qmd chunk metadata retention in migration imports?" }],
      });

      expect(assembled.systemPromptAddition).toContain("<engram_status");
      expect(assembled.estimatedTokens).toBeGreaterThan(0);
      expect(status.conversations).toBe(1);
      expect(status.messages).toBe(20);
      expect(status.summaries).toBeGreaterThan(0);
      expect(status.contextItems).toBeLessThan(status.messages);
      expect(status.kbCollections).toBeGreaterThan(0);
      expect(status.kbDocuments).toBeGreaterThan(0);
      expect(status.kbChunks).toBeGreaterThan(0);
      expect(recall?.appendSystemContext).toContain("<engram_recall");
      expect(recall?.appendSystemContext).toContain("qmd chunk metadata");
      expect(recall?.appendSystemContext).toMatch(/source_kind="(document_derived|session_summary)"/);
    } finally {
      await engine.dispose();
    }
  });
});
