import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveEngramConfig } from "../../src/config.js";
import { openDatabase } from "../../src/db/connection.js";
import { EngramContextEngine } from "../../src/engine/engine.js";

const tempPaths: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  while (tempPaths.length > 0) {
    const current = tempPaths.pop();
    if (current) {
      rmSync(current, { recursive: true, force: true });
    }
  }
});

describe("chaos db busy", () => {
  it("retries a busy BEGIN IMMEDIATE and completes the write without corruption", async () => {
    const root = mkdtempSync(join(tmpdir(), "engram-chaos-db-busy-"));
    tempPaths.push(root);
    const dbPath = join(root, "engram.db");
    const database = openDatabase(dbPath);
    const engine = new EngramContextEngine(database, resolveEngramConfig({ dbPath }));
    const originalExec = database.db.exec.bind(database.db);
    let busyFailures = 0;

    vi.spyOn(database.db, "exec").mockImplementation((sql: string) => {
      if (sql === "BEGIN IMMEDIATE" && busyFailures === 0) {
        busyFailures += 1;
        const error = new Error("SQLITE_BUSY: database is locked") as Error & { code?: string };
        error.code = "SQLITE_BUSY";
        throw error;
      }
      return originalExec(sql);
    });

    try {
      await engine.bootstrap({ sessionId: "session-busy", sessionFile: "busy.jsonl", sessionKey: "busy-key" });
      const result = await engine.ingest({
        sessionId: "session-busy",
        sessionKey: "busy-key",
        message: { role: "user", content: "Retry the busy transaction and keep the write." },
      });

      const row = database.db.prepare(`SELECT COUNT(*) AS count FROM messages WHERE conversation_id = ?`).get("session-busy") as { count?: number } | undefined;

      expect(result.ingested).toBe(true);
      expect(busyFailures).toBe(1);
      expect(row?.count).toBe(1);
    } finally {
      await engine.dispose();
    }
  });
});