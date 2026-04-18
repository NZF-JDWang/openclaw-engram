import type { DatabaseSync } from "node:sqlite";
import type { EngramConfig } from "../config.js";
import {
  computeSummaryQualityScore,
  looksLikeRawTimestampedDump,
  sanitizeStoredContent,
  sanitizeSummaryContent,
} from "../lifecycle.js";
import { estimateTokens } from "../token-estimate.js";
import { summarizeText } from "../engine/summarizer.js";
import { readStatus, type EngramStatusSnapshot } from "./status.js";

type RuntimeLike = Parameters<typeof summarizeText>[0]["runtime"];

export type MaintenanceReport = {
  walCheckpoint: string;
  vacuumed: boolean;
  analyzed: boolean;
  ftsRebuilt: boolean;
  prunedConversations: number;
  prunedMessages: number;
  status: EngramStatusSnapshot;
};

export type ResummarizeReport = {
  scanned: number;
  updated: number;
};

export function maintainDatabase(db: DatabaseSync, config: EngramConfig): MaintenanceReport {
  const pruneResult = config.pruneSummarizedMessages
    ? pruneSummarizedConversations(db, config)
    : { conversations: 0, messages: 0 };

  const checkpointRow = db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get() as
    | { busy?: number; log?: number; checkpointed?: number }
    | undefined;
  const ftsRebuilt = hasTable(db, "kb_chunks_fts");
  if (ftsRebuilt) {
    db.exec(`INSERT INTO kb_chunks_fts(kb_chunks_fts) VALUES('rebuild')`);
  }
  db.exec("ANALYZE");
  db.exec("VACUUM");

  return {
    walCheckpoint: `busy=${checkpointRow?.busy ?? 0}, log=${checkpointRow?.log ?? 0}, checkpointed=${checkpointRow?.checkpointed ?? 0}`,
    vacuumed: true,
    analyzed: true,
    ftsRebuilt,
    prunedConversations: pruneResult.conversations,
    prunedMessages: pruneResult.messages,
    status: readStatus(config),
  };
}

export async function resummarizeLcmSummaries(
  db: DatabaseSync,
  config: EngramConfig,
  runtime?: RuntimeLike,
): Promise<ResummarizeReport> {
  const candidates = db.prepare(`
    SELECT summary_id, content
    FROM summaries
    WHERE depth = 0
      AND conversation_id LIKE 'lcm:%'
  `).all() as Array<{ summary_id: string; content: string }>;

  let updated = 0;
  const update = db.prepare(`
    UPDATE summaries
    SET content = ?, quality_score = ?, token_count = ?
    WHERE summary_id = ?
  `);

  for (const candidate of candidates) {
    const currentScore = computeSummaryQualityScore(candidate.content, config.summaryQualityThreshold);
    if (currentScore >= config.summaryQualityThreshold && !looksLikeRawTimestampedDump(candidate.content)) {
      continue;
    }

    const sourceRows = db.prepare(`
      SELECT m.role, m.content
      FROM summary_messages sm
      JOIN messages m ON m.message_id = sm.message_id
      WHERE sm.summary_id = ?
      ORDER BY sm.ordinal ASC
    `).all(candidate.summary_id) as Array<{ role: string; content: string }>;

    const sourceText =
      sourceRows.length > 0
        ? sourceRows
            .map((row) => `${row.role}: ${sanitizeStoredContent(row.content, config.maxMessageContentBytes)}`)
            .join("\n")
        : sanitizeSummaryContent(candidate.content);

    const fallback = truncateText(sourceText, config.leafTargetTokens);
    const nextText = await summarizeText({
      text: sourceText,
      mode: "leaf",
      targetTokens: config.leafTargetTokens,
      config,
      runtime,
      fallback: (text, targetTokens) => truncateText(text, targetTokens),
    });
    const content = sanitizeSummaryContent(
      computeSummaryQualityScore(nextText, config.summaryQualityThreshold) >= config.summaryQualityThreshold
        ? nextText
        : fallback,
    );

    update.run(
      content,
      computeSummaryQualityScore(content, config.summaryQualityThreshold),
      estimateTokens(content),
      candidate.summary_id,
    );
    updated += 1;
  }

  return {
    scanned: candidates.length,
    updated,
  };
}

export function formatMaintenanceReport(report: MaintenanceReport): string {
  return [
    "Engram maintenance",
    `walCheckpoint: ${report.walCheckpoint}`,
    `vacuumed: ${report.vacuumed}`,
    `analyzed: ${report.analyzed}`,
    `ftsRebuilt: ${report.ftsRebuilt}`,
    `prunedConversations: ${report.prunedConversations}`,
    `prunedMessages: ${report.prunedMessages}`,
    "",
    readStatusLines(report.status),
  ].join("\n");
}

function pruneSummarizedConversations(
  db: DatabaseSync,
  config: EngramConfig,
): { conversations: number; messages: number } {
  const candidates = db.prepare(`
    SELECT c.conversation_id,
           COUNT(m.message_id) AS message_count,
           (
             SELECT s.summary_id
             FROM summaries s
             WHERE s.conversation_id = c.conversation_id
             ORDER BY s.depth DESC, s.created_at DESC
             LIMIT 1
           ) AS retained_summary_id
    FROM conversations c
    JOIN messages m ON m.conversation_id = c.conversation_id
    WHERE datetime(m.created_at) <= datetime('now', ?)
      AND EXISTS (
        SELECT 1
        FROM summaries s
        WHERE s.conversation_id = c.conversation_id AND s.depth >= 1
      )
    GROUP BY c.conversation_id
  `).all(`-${config.pruneMinAgeDays} days`) as Array<{
    conversation_id: string;
    message_count: number;
    retained_summary_id: string | null;
  }>;

  const deleteParts = db.prepare(`
    DELETE FROM message_parts
    WHERE message_id IN (SELECT message_id FROM messages WHERE conversation_id = ?)
  `);
  const deleteLinks = db.prepare(`
    DELETE FROM summary_messages
    WHERE message_id IN (SELECT message_id FROM messages WHERE conversation_id = ?)
  `);
  const deleteContext = db.prepare(`DELETE FROM context_items WHERE conversation_id = ?`);
  const insertContext = db.prepare(`
    INSERT INTO context_items (conversation_id, ordinal, item_type, message_id, summary_id, created_at)
    VALUES (?, 0, 'summary', NULL, ?, datetime('now'))
  `);
  const deleteMessages = db.prepare(`DELETE FROM messages WHERE conversation_id = ?`);

  let conversations = 0;
  let messages = 0;
  for (const candidate of candidates) {
    deleteParts.run(candidate.conversation_id);
    deleteLinks.run(candidate.conversation_id);
    deleteContext.run(candidate.conversation_id);
    if (candidate.retained_summary_id) {
      insertContext.run(candidate.conversation_id, candidate.retained_summary_id);
    }
    deleteMessages.run(candidate.conversation_id);
    conversations += 1;
    messages += candidate.message_count;
  }

  return { conversations, messages };
}

export function pruneSummarizedConversationsForCurrentConfig(
  db: DatabaseSync,
  config: EngramConfig,
  conversationId: string,
): { conversations: number; messages: number } {
  if (!config.pruneSummarizedMessages) {
    return { conversations: 0, messages: 0 };
  }

  const row = db.prepare(`
    SELECT c.conversation_id,
           COUNT(m.message_id) AS message_count,
           (
             SELECT s.summary_id
             FROM summaries s
             WHERE s.conversation_id = c.conversation_id
             ORDER BY s.depth DESC, s.created_at DESC
             LIMIT 1
           ) AS retained_summary_id
    FROM conversations c
    JOIN messages m ON m.conversation_id = c.conversation_id
    WHERE c.conversation_id = ?
      AND datetime(m.created_at) <= datetime('now', ?)
      AND EXISTS (
        SELECT 1 FROM summaries s WHERE s.conversation_id = c.conversation_id AND s.depth >= 1
      )
    GROUP BY c.conversation_id
  `).get(conversationId, `-${config.pruneMinAgeDays} days`) as
    | { conversation_id: string; message_count: number; retained_summary_id: string | null }
    | undefined;

  if (!row) {
    return { conversations: 0, messages: 0 };
  }

  const deleteParts = db.prepare(`
    DELETE FROM message_parts
    WHERE message_id IN (SELECT message_id FROM messages WHERE conversation_id = ?)
  `);
  const deleteLinks = db.prepare(`
    DELETE FROM summary_messages
    WHERE message_id IN (SELECT message_id FROM messages WHERE conversation_id = ?)
  `);
  const deleteContext = db.prepare(`DELETE FROM context_items WHERE conversation_id = ?`);
  const insertContext = db.prepare(`
    INSERT INTO context_items (conversation_id, ordinal, item_type, message_id, summary_id, created_at)
    VALUES (?, 0, 'summary', NULL, ?, datetime('now'))
  `);
  const deleteMessages = db.prepare(`DELETE FROM messages WHERE conversation_id = ?`);

  deleteParts.run(conversationId);
  deleteLinks.run(conversationId);
  deleteContext.run(conversationId);
  if (row.retained_summary_id) {
    insertContext.run(conversationId, row.retained_summary_id);
  }
  deleteMessages.run(conversationId);
  return { conversations: 1, messages: row.message_count };
}

function readStatusLines(status: EngramStatusSnapshot): string {
  return [
    `dbSizeMb: ${status.dbSizeMb.toFixed(2)}`,
    `messages: ${status.messages}`,
    `summaries: ${status.summaries}`,
    `compressionRatio: ${status.compressionRatio == null ? "n/a" : status.compressionRatio.toFixed(2)}`,
  ].join("\n");
}

function hasTable(db: DatabaseSync, tableName: string): boolean {
  const row = db.prepare(`
    SELECT name
    FROM sqlite_master
    WHERE name = ?
    LIMIT 1
  `).get(tableName) as { name?: string } | undefined;
  return row?.name === tableName;
}

function truncateText(value: string, targetTokens: number): string {
  const maxChars = Math.max(targetTokens * 4, 200);
  return value.length <= maxChars ? value : `${value.slice(0, maxChars - 3).trimEnd()}...`;
}
