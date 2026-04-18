import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { retryOnBusy } from "../db/connection.js";
import { computeSummaryQualityScore, sanitizeStoredContent, sanitizeSummaryContent } from "../lifecycle.js";
import { estimateTokens } from "../token-estimate.js";

export type LcmImportResult = {
  imported: boolean;
  skipped: boolean;
  sourcePath: string;
  counts: Record<string, number>;
};

type LcmConversationRow = {
  conversation_id: number;
  session_id: string;
  session_key: string | null;
  created_at: string;
};

type LcmMessageRow = {
  message_id: number;
  conversation_id: number;
  seq: number;
  role: string;
  content: string;
  token_count: number;
  created_at: string;
};

type LcmMessagePartRow = {
  part_id: string;
  message_id: number;
  session_id: string;
  part_type: string;
  ordinal: number;
  text_content: string | null;
  tool_call_id: string | null;
  tool_name: string | null;
  tool_input: string | null;
  tool_output: string | null;
  metadata: string | null;
};

type LcmSummaryRow = {
  summary_id: string;
  conversation_id: number;
  kind: string;
  depth: number;
  content: string;
  token_count: number;
  created_at: string;
};

type LcmSummaryMessageRow = {
  summary_id: string;
  message_id: number;
  ordinal: number;
};

type LcmSummaryParentRow = {
  summary_id: string;
  parent_summary_id: string;
  ordinal: number;
};

type LcmContextItemRow = {
  conversation_id: number;
  ordinal: number;
  item_type: string;
  message_id: number | null;
  summary_id: string | null;
  created_at: string;
};

type LcmLargeFileRow = {
  file_id: string;
  conversation_id: number;
  file_name: string | null;
  mime_type: string | null;
  byte_size: number | null;
  storage_uri: string;
  exploration_summary: string | null;
  created_at: string;
};

export function importFromLcm(sourcePath: string, destDb: DatabaseSync): LcmImportResult {
  if (hasExistingImport(destDb, sourcePath)) {
    return {
      imported: false,
      skipped: true,
      sourcePath,
      counts: {},
    };
  }

  const sourceDb = new DatabaseSync(sourcePath, { open: true, readOnly: true });
  try {
    const conversations = sourceDb.prepare(`SELECT conversation_id, session_id, session_key, created_at FROM conversations`).all() as LcmConversationRow[];
    const messages = sourceDb.prepare(`SELECT message_id, conversation_id, seq, role, content, token_count, created_at FROM messages`).all() as LcmMessageRow[];
    const messageParts = tableExists(sourceDb, "message_parts")
      ? (sourceDb.prepare(`SELECT part_id, message_id, session_id, part_type, ordinal, text_content, tool_call_id, tool_name, tool_input, tool_output, metadata FROM message_parts`).all() as LcmMessagePartRow[])
      : [];
    const summaries = tableExists(sourceDb, "summaries")
      ? (sourceDb.prepare(`SELECT summary_id, conversation_id, kind, depth, content, token_count, created_at FROM summaries`).all() as LcmSummaryRow[])
      : [];
    const summaryMessages = tableExists(sourceDb, "summary_messages")
      ? (sourceDb.prepare(`SELECT summary_id, message_id, ordinal FROM summary_messages`).all() as LcmSummaryMessageRow[])
      : [];
    const summaryParents = tableExists(sourceDb, "summary_parents")
      ? (sourceDb.prepare(`SELECT summary_id, parent_summary_id, ordinal FROM summary_parents`).all() as LcmSummaryParentRow[])
      : [];
    const contextItems = tableExists(sourceDb, "context_items")
      ? (sourceDb.prepare(`SELECT conversation_id, ordinal, item_type, message_id, summary_id, created_at FROM context_items`).all() as LcmContextItemRow[])
      : [];
    const largeFiles = tableExists(sourceDb, "large_files")
      ? (sourceDb.prepare(`SELECT file_id, conversation_id, file_name, mime_type, byte_size, storage_uri, exploration_summary, created_at FROM large_files`).all() as LcmLargeFileRow[])
      : [];
    const messageConversationIds = buildMessageConversationIdMap(messages);
    const summaryConversationIds = buildSummaryConversationIdMap(summaries);

    retryOnBusy(() => destDb.exec("BEGIN IMMEDIATE"));
    try {
      const insertConversation = destDb.prepare(`
        INSERT OR IGNORE INTO conversations (conversation_id, session_id, session_key, created_at)
        VALUES (?, ?, ?, ?)
      `);
      const insertMessage = destDb.prepare(`
        INSERT OR IGNORE INTO messages (message_id, conversation_id, seq, role, content, token_count, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      const insertMessagePart = destDb.prepare(`
        INSERT OR IGNORE INTO message_parts (part_id, message_id, session_id, part_type, ordinal, text_content, tool_call_id, tool_name, tool_input, tool_output, metadata)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const insertSummary = destDb.prepare(`
        INSERT OR IGNORE INTO summaries (summary_id, conversation_id, kind, depth, content, quality_score, token_count, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const insertSummaryMessage = destDb.prepare(`
        INSERT OR IGNORE INTO summary_messages (summary_id, message_id, ordinal)
        VALUES (?, ?, ?)
      `);
      const insertSummaryParent = destDb.prepare(`
        INSERT OR IGNORE INTO summary_parents (summary_id, parent_summary_id, ordinal)
        VALUES (?, ?, ?)
      `);
      const insertContextItem = destDb.prepare(`
        INSERT OR IGNORE INTO context_items (conversation_id, ordinal, item_type, message_id, summary_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      const insertLargeFile = destDb.prepare(`
        INSERT OR IGNORE INTO large_files (file_id, conversation_id, file_name, mime_type, byte_size, storage_uri, exploration_summary, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);

      for (const row of conversations) {
        insertConversation.run(mapConversationId(row.conversation_id), row.session_id, row.session_key, row.created_at);
      }
      for (const row of messages) {
        insertMessage.run(
          mapMessageId(row.conversation_id, row.message_id),
          mapConversationId(row.conversation_id),
          row.seq,
          row.role,
          sanitizeStoredContent(row.content, 32_768),
          estimateTokens(sanitizeStoredContent(row.content, 32_768)),
          row.created_at,
        );
      }
      for (const row of messageParts) {
        insertMessagePart.run(
          mapPartId(row.part_id),
          mapMessageIdFromMessage(row.message_id, messageConversationIds),
          row.session_id,
          row.part_type,
          row.ordinal,
          row.text_content == null ? null : sanitizeStoredContent(row.text_content, 32_768),
          row.tool_call_id,
          row.tool_name,
          row.tool_input == null ? null : sanitizeStoredContent(row.tool_input, 32_768),
          row.tool_output == null ? null : sanitizeStoredContent(row.tool_output, 32_768),
          row.metadata,
        );
      }
      for (const row of summaries) {
        const content = sanitizeSummaryContent(row.content);
        insertSummary.run(
          mapSummaryId(row.conversation_id, row.summary_id),
          mapConversationId(row.conversation_id),
          row.kind,
          row.depth,
          content,
          computeSummaryQualityScore(content, 50),
          estimateTokens(content),
          row.created_at,
        );
      }
      for (const row of summaryMessages) {
        const conversationId = findConversationIdForSummary(row.summary_id, summaryConversationIds);
        if (conversationId == null) {
          continue;
        }
        insertSummaryMessage.run(
          mapSummaryId(conversationId, row.summary_id),
          mapMessageId(conversationId, row.message_id),
          row.ordinal,
        );
      }
      for (const row of summaryParents) {
        const childConversationId = findConversationIdForSummary(row.summary_id, summaryConversationIds);
        const parentConversationId = findConversationIdForSummary(row.parent_summary_id, summaryConversationIds);
        if (childConversationId == null || parentConversationId == null) {
          continue;
        }
        insertSummaryParent.run(
          mapSummaryId(childConversationId, row.summary_id),
          mapSummaryId(parentConversationId, row.parent_summary_id),
          row.ordinal,
        );
      }
      for (const row of contextItems) {
        const mappedMessageId = row.message_id == null ? null : mapMessageIdFromMessage(row.message_id, messageConversationIds);
        const mappedSummaryId =
          row.summary_id == null
            ? null
            : mapSummaryIdFromSummary(row.summary_id, summaryConversationIds);
        if ((row.message_id != null && mappedMessageId == null) || (row.summary_id != null && mappedSummaryId == null)) {
          continue;
        }
        insertContextItem.run(
          mapConversationId(row.conversation_id),
          row.ordinal,
          row.item_type,
          mappedMessageId,
          mappedSummaryId,
          row.created_at,
        );
      }
      for (const row of largeFiles) {
        insertLargeFile.run(
          mapLargeFileId(row.file_id),
          mapConversationId(row.conversation_id),
          row.file_name,
          row.mime_type,
          row.byte_size,
          row.storage_uri,
          row.exploration_summary,
          row.created_at,
        );
      }

      const counts = {
        conversations: conversations.length,
        messages: messages.length,
        message_parts: messageParts.length,
        summaries: summaries.length,
        summary_messages: summaryMessages.length,
        summary_parents: summaryParents.length,
        context_items: contextItems.length,
        large_files: largeFiles.length,
      };

      destDb.prepare(`
        INSERT INTO engram_import_runs (import_id, source_kind, source_path, record_counts_json, imported_at)
        VALUES (?, 'lossless-claw', ?, ?, datetime('now'))
      `).run(randomUUID(), sourcePath, JSON.stringify(counts));

      destDb.exec("COMMIT");

      return {
        imported: true,
        skipped: false,
        sourcePath,
        counts,
      };
    } catch (error) {
      try {
        destDb.exec("ROLLBACK");
      } catch {
        // Keep original error.
      }
      throw error;
    }
  } finally {
    sourceDb.close();
  }
}

function hasExistingImport(destDb: DatabaseSync, sourcePath: string): boolean {
  const row = destDb.prepare(`
    SELECT import_id FROM engram_import_runs WHERE source_kind = 'lossless-claw' AND source_path = ? LIMIT 1
  `).get(sourcePath) as { import_id?: string } | undefined;
  return typeof row?.import_id === "string";
}

function tableExists(db: DatabaseSync, tableName: string): boolean {
  const row = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1`).get(tableName) as { name?: string } | undefined;
  return row?.name === tableName;
}

function mapConversationId(conversationId: number): string {
  return `lcm:${conversationId}`;
}

function mapMessageId(conversationId: number, messageId: number): string {
  return `lcm:${conversationId}:msg:${messageId}`;
}

function mapSummaryId(conversationId: number, summaryId: string): string {
  return `lcm:${conversationId}:sum:${summaryId}`;
}

function mapPartId(partId: string): string {
  return `lcm:part:${partId}`;
}

function mapLargeFileId(fileId: string): string {
  return `lcm:file:${fileId}`;
}

function buildMessageConversationIdMap(messages: LcmMessageRow[]): Map<number, number> {
  return new Map(messages.map((message) => [message.message_id, message.conversation_id]));
}

function buildSummaryConversationIdMap(summaries: LcmSummaryRow[]): Map<string, number> {
  return new Map(summaries.map((summary) => [summary.summary_id, summary.conversation_id]));
}

function mapMessageIdFromMessage(messageId: number, messageConversationIds: Map<number, number>): string | null {
  const conversationId = messageConversationIds.get(messageId);
  return conversationId == null ? null : mapMessageId(conversationId, messageId);
}

function mapSummaryIdFromSummary(summaryId: string, summaryConversationIds: Map<string, number>): string | null {
  const conversationId = summaryConversationIds.get(summaryId);
  return conversationId == null ? null : mapSummaryId(conversationId, summaryId);
}

function findConversationIdForSummary(summaryId: string, summaryConversationIds: Map<string, number>): number | null {
  return summaryConversationIds.get(summaryId) ?? null;
}
