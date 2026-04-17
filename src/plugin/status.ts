import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type { EngramConfig } from "../config.js";

export type EngramStatusSnapshot = {
  dbPath: string;
  dbExists: boolean;
  conversations: number;
  messages: number;
  messageParts: number;
  summaries: number;
  contextItems: number;
  kbCollections: number;
  kbDocuments: number;
  kbChunks: number;
  kbEmbeddings: number;
  facts: number;
  pendingFacts: number;
  conflicts: number;
  importRuns: number;
};

export function readStatus(config: EngramConfig): EngramStatusSnapshot {
  const dbExists = existsSync(config.dbPath);
  if (!dbExists) {
    return {
      dbPath: config.dbPath,
      dbExists: false,
      conversations: 0,
      messages: 0,
      messageParts: 0,
      summaries: 0,
      contextItems: 0,
      kbCollections: 0,
      kbDocuments: 0,
      kbChunks: 0,
      kbEmbeddings: 0,
      facts: 0,
      pendingFacts: 0,
      conflicts: 0,
      importRuns: 0,
    };
  }

  const db = new DatabaseSync(config.dbPath, { open: true, readOnly: true });
  try {
    return {
      dbPath: config.dbPath,
      dbExists: true,
      conversations: count(db, "conversations"),
      messages: count(db, "messages"),
      messageParts: count(db, "message_parts"),
      summaries: count(db, "summaries"),
      contextItems: count(db, "context_items"),
      kbCollections: count(db, "kb_collections"),
      kbDocuments: count(db, "kb_documents"),
      kbChunks: count(db, "kb_chunks"),
      kbEmbeddings: count(db, "kb_embeddings"),
      facts: count(db, "kb_facts"),
      pendingFacts: countWhere(db, "kb_facts", "approval_state = 'pending'"),
      conflicts: count(db, "kb_conflicts"),
      importRuns: count(db, "engram_import_runs"),
    };
  } finally {
    db.close();
  }
}

function count(db: DatabaseSync, tableName: string): number {
  const row = db.prepare(`SELECT COUNT(*) AS count FROM ${tableName}`).get() as { count?: number } | undefined;
  return row?.count ?? 0;
}

function countWhere(db: DatabaseSync, tableName: string, whereClause: string): number {
  const row = db
    .prepare(`SELECT COUNT(*) AS count FROM ${tableName} WHERE ${whereClause}`)
    .get() as { count?: number } | undefined;
  return row?.count ?? 0;
}

export function formatStatus(snapshot: EngramStatusSnapshot): string {
  return [
    "Engram status",
    `dbPath: ${snapshot.dbPath}`,
    `dbExists: ${snapshot.dbExists}`,
    `conversations: ${snapshot.conversations}`,
    `messages: ${snapshot.messages}`,
    `messageParts: ${snapshot.messageParts}`,
    `summaries: ${snapshot.summaries}`,
    `contextItems: ${snapshot.contextItems}`,
    `kbCollections: ${snapshot.kbCollections}`,
    `kbDocuments: ${snapshot.kbDocuments}`,
    `kbChunks: ${snapshot.kbChunks}`,
    `kbEmbeddings: ${snapshot.kbEmbeddings}`,
    `facts: ${snapshot.facts}`,
    `pendingFacts: ${snapshot.pendingFacts}`,
    `conflicts: ${snapshot.conflicts}`,
    `importRuns: ${snapshot.importRuns}`,
  ].join("\n");
}