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

describe("integration deterministic replay", () => {
  it("produces identical assembled context for the same transcript on repeated extractive runs", async () => {
    const transcript = [
      { role: "user", content: "Preserve qmd chunk metadata during every migration import." },
      { role: "assistant", content: "Every migration import will preserve qmd chunk metadata." },
      { role: "user", content: "Keep audit trails so repeated imports remain idempotent and debuggable." },
      { role: "assistant", content: "Audit trails will make repeated imports idempotent and debuggable." },
      { role: "user", content: "Index compacted summaries so recall can find migration decisions later." },
      { role: "assistant", content: "Compacted summaries will be indexed for later recall." },
      { role: "user", content: "Probe the embedding endpoint before indexing begins." },
      { role: "assistant", content: "The embedding endpoint will be probed before indexing begins." },
      { role: "user", content: "Keep sqlite as the storage backend and preserve qmd metadata again." },
      { role: "assistant", content: "Sqlite stays the storage backend and qmd metadata stays preserved." },
      { role: "user", content: "Wrap up the migration work with metadata retention and audit continuity." },
      { role: "assistant", content: "The migration work is wrapped with metadata retention and audit continuity." },
    ] as const;

    const first = await runDeterministicPipeline("engram-deterministic-a", transcript);
    const second = await runDeterministicPipeline("engram-deterministic-b", transcript);

    expect(first).toEqual(second);
  });
});

async function runDeterministicPipeline(
  prefix: string,
  transcript: readonly { role: string; content: string }[],
): Promise<{
  assembledMessages: Array<{ role: string; content: string }>;
  estimatedTokens: number;
  summaries: Array<{ kind: string; depth: number; content: string }>;
  systemPromptAddition: string;
}> {
  const root = mkdtempSync(join(tmpdir(), `${prefix}-`));
  tempPaths.push(root);
  const dbPath = join(root, "engram.db");
  const database = openDatabase(dbPath);
  const config = resolveEngramConfig({
    dbPath,
    freshTailCount: 4,
    leafTargetTokens: 40,
    condensedTargetTokens: 30,
  });
  const engine = new EngramContextEngine(database, config);

  try {
    await engine.bootstrap({ sessionId: "session-deterministic", sessionFile: "deterministic.jsonl", sessionKey: "deterministic-key" });
    await engine.ingestBatch({ sessionId: "session-deterministic", sessionKey: "deterministic-key", messages: [...transcript] });
    await engine.afterTurn({
      sessionId: "session-deterministic",
      sessionKey: "deterministic-key",
      sessionFile: "deterministic.jsonl",
      messages: [...transcript.slice(-2)],
      prePromptMessageCount: transcript.length - 2,
    });

    const assembled = await engine.assemble({
      sessionId: "session-deterministic",
      messages: [{ role: "user", content: "Continue the migration work." }],
      tokenBudget: 1200,
    });
    const summaries = database.db.prepare(`
      SELECT kind, depth, content
      FROM summaries
      WHERE conversation_id = ?
      ORDER BY depth ASC, kind ASC, content ASC
    `).all("session-deterministic") as Array<{ kind: string; depth: number; content: string }>;

    return {
      assembledMessages: (assembled.messages as Array<{ role?: string; content?: string }>).map((message) => ({
        role: message.role ?? "user",
        content: normalizeSummaryIds(message.content ?? ""),
      })),
      estimatedTokens: assembled.estimatedTokens,
      summaries,
      systemPromptAddition: assembled.systemPromptAddition ?? "",
    };
  } finally {
    await engine.dispose();
  }
}

function normalizeSummaryIds(value: string): string {
  return value.replace(/id="[^"]+"/g, 'id="summary:deterministic"');
}