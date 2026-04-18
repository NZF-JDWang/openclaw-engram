import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type { EngramConfig } from "../config.js";
import { deriveSummaryDepthDistribution, readDbSizeBytes, type SummaryDepthDistribution } from "../lifecycle.js";

export type ConversationSizeRow = {
  conversationId: string;
  totalBytes: number;
};

export type EngramStatusSnapshot = {
  dbPath: string;
  dbExists: boolean;
  dbSizeBytes: number;
  dbSizeMb: number;
  dbSizeWarning: boolean;
  conversations: number;
  messages: number;
  messageParts: number;
  summaries: number;
  contextItems: number;
  rawMessageBytes: number;
  summaryBytes: number;
  compressionRatio: number | null;
  oldestUnsummarizedConversationId: string | null;
  kbCollections: number;
  kbDocuments: number;
  kbChunks: number;
  kbEmbeddings: number;
  importRuns: number;
  summaryDepthDistribution: SummaryDepthDistribution;
  topConversations: ConversationSizeRow[];
};

export function readStatus(config: EngramConfig): EngramStatusSnapshot {
  const dbExists = existsSync(config.dbPath);
  if (!dbExists) {
    return {
      dbPath: config.dbPath,
      dbExists: false,
      dbSizeBytes: 0,
      dbSizeMb: 0,
      dbSizeWarning: false,
      conversations: 0,
      messages: 0,
      messageParts: 0,
      summaries: 0,
      contextItems: 0,
      rawMessageBytes: 0,
      summaryBytes: 0,
      compressionRatio: null,
      oldestUnsummarizedConversationId: null,
      kbCollections: 0,
      kbDocuments: 0,
      kbChunks: 0,
      kbEmbeddings: 0,
      importRuns: 0,
      summaryDepthDistribution: { depth0: 0, depth1: 0, depth2: 0, depth3Plus: 0 },
      topConversations: [],
    };
  }

  const db = new DatabaseSync(config.dbPath, { open: true, readOnly: true });
  try {
    const dbSizeBytes = readDbSizeBytes(config.dbPath);
    const rawMessageBytes = contentBytes(db, "messages");
    const summaryBytes = contentBytes(db, "summaries");
    const depthRows = db.prepare(`SELECT depth FROM summaries`).all() as Array<{ depth?: number | null }>;
    return {
      dbPath: config.dbPath,
      dbExists: true,
      dbSizeBytes,
      dbSizeMb: dbSizeBytes / (1024 * 1024),
      dbSizeWarning: dbSizeBytes / (1024 * 1024) >= config.dbSizeWarningMb,
      conversations: count(db, "conversations"),
      messages: count(db, "messages"),
      messageParts: count(db, "message_parts"),
      summaries: count(db, "summaries"),
      contextItems: count(db, "context_items"),
      rawMessageBytes,
      summaryBytes,
      compressionRatio: summaryBytes > 0 ? rawMessageBytes / summaryBytes : null,
      oldestUnsummarizedConversationId: oldestUnsummarizedConversationId(db),
      kbCollections: count(db, "kb_collections"),
      kbDocuments: count(db, "kb_documents"),
      kbChunks: count(db, "kb_chunks"),
      kbEmbeddings: count(db, "kb_embeddings"),
      importRuns: count(db, "engram_import_runs"),
      summaryDepthDistribution: deriveSummaryDepthDistribution(depthRows),
      topConversations: topConversationSizes(db),
    };
  } finally {
    db.close();
  }
}

function count(db: DatabaseSync, tableName: string): number {
  const row = db.prepare(`SELECT COUNT(*) AS count FROM ${tableName}`).get() as { count?: number } | undefined;
  return row?.count ?? 0;
}

function contentBytes(db: DatabaseSync, tableName: "messages" | "summaries"): number {
  const row = db.prepare(`
    SELECT COALESCE(SUM(LENGTH(content)), 0) AS total
    FROM ${tableName}
  `).get() as { total?: number } | undefined;
  return row?.total ?? 0;
}

function oldestUnsummarizedConversationId(db: DatabaseSync): string | null {
  const row = db.prepare(`
    SELECT c.conversation_id
    FROM conversations c
    WHERE EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = c.conversation_id)
      AND NOT EXISTS (
        SELECT 1
        FROM summaries s
        WHERE s.conversation_id = c.conversation_id AND s.depth >= 1
      )
    ORDER BY c.created_at ASC
    LIMIT 1
  `).get() as { conversation_id?: string } | undefined;
  return row?.conversation_id ?? null;
}

function topConversationSizes(db: DatabaseSync): ConversationSizeRow[] {
  return (db.prepare(`
    SELECT c.conversation_id,
           COALESCE((SELECT SUM(LENGTH(m.content)) FROM messages m WHERE m.conversation_id = c.conversation_id), 0)
           + COALESCE((SELECT SUM(LENGTH(s.content)) FROM summaries s WHERE s.conversation_id = c.conversation_id), 0) AS total_bytes
    FROM conversations c
    ORDER BY total_bytes DESC, c.created_at ASC
    LIMIT 5
  `).all() as Array<{ conversation_id: string; total_bytes: number }>).map((row) => ({
    conversationId: row.conversation_id,
    totalBytes: row.total_bytes,
  }));
}

export function formatStatus(snapshot: EngramStatusSnapshot): string {
  return [
    "Engram status",
    `dbPath: ${snapshot.dbPath}`,
    `dbExists: ${snapshot.dbExists}`,
    `dbSizeMb: ${snapshot.dbSizeMb.toFixed(2)}`,
    `dbSizeWarning: ${snapshot.dbSizeWarning}`,
    `conversations: ${snapshot.conversations}`,
    `messages: ${snapshot.messages}`,
    `messageParts: ${snapshot.messageParts}`,
    `summaries: ${snapshot.summaries}`,
    `contextItems: ${snapshot.contextItems}`,
    `rawMessageBytes: ${snapshot.rawMessageBytes}`,
    `summaryBytes: ${snapshot.summaryBytes}`,
    `compressionRatio: ${snapshot.compressionRatio == null ? "n/a" : snapshot.compressionRatio.toFixed(2)}`,
    `oldestUnsummarizedConversationId: ${snapshot.oldestUnsummarizedConversationId ?? "n/a"}`,
    `summaryDepths: d0=${snapshot.summaryDepthDistribution.depth0}, d1=${snapshot.summaryDepthDistribution.depth1}, d2=${snapshot.summaryDepthDistribution.depth2}, d3+=${snapshot.summaryDepthDistribution.depth3Plus}`,
    `kbCollections: ${snapshot.kbCollections}`,
    `kbDocuments: ${snapshot.kbDocuments}`,
    `kbChunks: ${snapshot.kbChunks}`,
    `kbEmbeddings: ${snapshot.kbEmbeddings}`,
    `importRuns: ${snapshot.importRuns}`,
    ...snapshot.topConversations.map(
      (conversation, index) =>
        `topConversation${index + 1}: ${conversation.conversationId} (${conversation.totalBytes} bytes)`,
    ),
  ].join("\n");
}
