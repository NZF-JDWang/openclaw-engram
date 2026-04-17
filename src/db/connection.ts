import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { runMigrations } from "./migration.js";

const DEFAULT_BUSY_RETRIES = 5;

export type EngramDatabase = {
  db: DatabaseSync;
  close: () => void;
};

export function openDatabase(dbPath: string): EngramDatabase {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode=WAL");
  db.exec("PRAGMA foreign_keys=ON");
  db.exec("PRAGMA synchronous=NORMAL");
  runMigrations(db);
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
    }
  }
}

function isBusyError(error: unknown): boolean {
  const candidate = error as { code?: string; message?: string } | undefined;
  const code = candidate?.code ?? "";
  const message = candidate?.message ?? "";
  return code === "SQLITE_BUSY" || code === "SQLITE_LOCKED" || /SQLITE_(BUSY|LOCKED)|database is locked/i.test(message);
}