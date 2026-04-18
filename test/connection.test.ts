import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openDatabase, retryOnBusy } from "../src/db/connection.js";

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

describe("retryOnBusy", () => {
  it("retries SQLITE_BUSY failures until the operation succeeds", () => {
    const operation = vi
      .fn<() => string>()
      .mockImplementationOnce(() => {
        const error = new Error("SQLITE_BUSY: database is locked") as Error & { code?: string };
        error.code = "SQLITE_BUSY";
        throw error;
      })
      .mockImplementationOnce(() => {
        const error = new Error("database is locked") as Error & { code?: string };
        error.code = "SQLITE_LOCKED";
        throw error;
      })
      .mockImplementation(() => "ok");

    expect(retryOnBusy(operation, 3)).toBe("ok");
    expect(operation).toHaveBeenCalledTimes(3);
  });

  it("rethrows non-busy failures immediately", () => {
    const operation = vi.fn<() => void>().mockImplementation(() => {
      throw new Error("boom");
    });

    expect(() => retryOnBusy(operation, 3)).toThrow("boom");
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it("lets openDatabase recover from a transient busy startup pragma", () => {
    const root = mkdtempSync(join(tmpdir(), "engram-connection-busy-"));
    tempPaths.push(root);
    const dbPath = join(root, "engram.db");
    let busyFailures = 0;
    const originalExec = DatabaseSync.prototype.exec;

    vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function (this: DatabaseSync, sql: string) {
      if (sql === "PRAGMA journal_mode=WAL" && busyFailures === 0) {
        busyFailures += 1;
        const error = new Error("SQLITE_BUSY: database is locked") as Error & { code?: string };
        error.code = "SQLITE_BUSY";
        throw error;
      }
      return originalExec.call(this, sql);
    });

    const database = openDatabase(dbPath);
    try {
      const row = database.db
        .prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'engram_migrations'")
        .get() as { count?: number } | undefined;

      expect(busyFailures).toBe(1);
      expect(row?.count).toBe(1);
    } finally {
      database.close();
    }
  });
});
