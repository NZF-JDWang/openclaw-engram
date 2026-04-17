import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { runMigrations } from "./migration.js";

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