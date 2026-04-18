import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { runMigrations } from "./migration.js";

const DEFAULT_BUSY_RETRIES = 5;
const DEFAULT_BUSY_WAIT_MS = 100;
const DEFAULT_BUSY_TIMEOUT_MS = 5_000;

export type EngramDatabase = {
  db: DatabaseSync;
  close: () => void;
};

export function openDatabase(dbPath: string): EngramDatabase {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  retryOnBusy(() => db.exec(`PRAGMA busy_timeout=${DEFAULT_BUSY_TIMEOUT_MS}`));
  retryOnBusy(() => db.exec("PRAGMA journal_mode=WAL"));
  retryOnBusy(() => db.exec("PRAGMA foreign_keys=ON"));
  retryOnBusy(() => db.exec("PRAGMA synchronous=NORMAL"));
  retryOnBusy(() => runMigrations(db));
  return {
    db,
    close: () => db.close(),
  };
}

export function retryOnBusy<T>(operation: () => T, maxRetries: number = DEFAULT_BUSY_RETRIES): T {
  let attempt = 0;
  while (true) {
    try {
      return operation();
    } catch (error) {
      if (!isBusyError(error) || attempt >= maxRetries) {
        throw error;
      }
      attempt += 1;
      sleepMs(DEFAULT_BUSY_WAIT_MS * attempt);
    }
  }
}

function sleepMs(durationMs: number): void {
  const waitMs = Math.max(0, Math.floor(durationMs));
  if (waitMs === 0) {
    return;
  }

  const buffer = new SharedArrayBuffer(4);
  const view = new Int32Array(buffer);
  Atomics.wait(view, 0, 0, waitMs);
}

function isBusyError(error: unknown): boolean {
  const candidate = error as { code?: string; message?: string } | undefined;
  const code = candidate?.code ?? "";
  const message = candidate?.message ?? "";
  return code === "SQLITE_BUSY" || code === "SQLITE_LOCKED" || /SQLITE_(BUSY|LOCKED)|database is locked/i.test(message);
}
