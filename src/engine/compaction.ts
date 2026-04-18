import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { retryOnBusy } from "../db/connection.js";
import {
  computeSummaryQualityScore,
  isSummaryEligibleForCompaction,
  sanitizeSummaryContent,
} from "../lifecycle.js";
import { estimateTokens } from "../token-estimate.js";
import type { SummaryMode } from "./summarizer.js";

export type CompactionOutcome = {
  compacted: boolean;
  summaryId?: string;
  replacedItems?: number;
  tokensBefore: number;
  tokensAfter?: number;
  kind?: "leaf" | "condensed";
  depth?: number;
};

export type CompactionPipelineOutcome = {
  compacted: boolean;
  leaf?: CompactionOutcome;
  condensed: CompactionOutcome[];
  latestSummaryId?: string;
  tokensBefore: number;
  tokensAfter?: number;
  replacedItems: number;
};

type ContextItemRow = {
  ordinal: number;
  item_type: string;
  message_id: string | null;
  summary_id: string | null;
};

type MessageRow = {
  message_id: string;
  role: string;
  content: string;
  token_count: number;
};

type SummaryRow = {
  summary_id: string;
  depth: number;
  content: string;
  quality_score: number;
  token_count: number;
};

export async function compactConversation(
  db: DatabaseSync,
  params: {
    conversationId: string;
    freshTailCount: number;
    targetTokens: number;
    condensedTargetTokens?: number;
    incrementalMaxDepth?: number;
    summaryQualityThreshold?: number;
    summarize?: (text: string, targetTokens: number, mode: SummaryMode) => Promise<string>;
  },
): Promise<CompactionPipelineOutcome> {
  const tokensBefore = totalContextTokens(db, params.conversationId);
  const leaf = await compactLeafWindow(
    db,
    params.conversationId,
    params.freshTailCount,
    params.targetTokens,
    params.summaryQualityThreshold ?? 50,
    params.summarize,
  );
  const condensed: CompactionOutcome[] = [];

  if (leaf.compacted) {
    const depthBudget = params.incrementalMaxDepth ?? 0;
    const maxCondensedPasses = depthBudget < 0 ? Number.POSITIVE_INFINITY : depthBudget;
    let passes = 0;
    while (passes < maxCondensedPasses) {
      const outcome = await compactSummaryWindow(
        db,
        params.conversationId,
        params.condensedTargetTokens ?? params.targetTokens,
        params.summaryQualityThreshold ?? 50,
        params.summarize,
      );
      if (!outcome.compacted) {
        break;
      }
      condensed.push(outcome);
      passes += 1;
    }
  } else {
    const condensedOnly = await compactSummaryWindow(
      db,
      params.conversationId,
      params.condensedTargetTokens ?? params.targetTokens,
      params.summaryQualityThreshold ?? 50,
      params.summarize,
    );
    if (condensedOnly.compacted) {
      condensed.push(condensedOnly);
    }
  }

  return {
    compacted: leaf.compacted || condensed.length > 0,
    leaf: leaf.compacted ? leaf : undefined,
    condensed,
    latestSummaryId: condensed.at(-1)?.summaryId ?? leaf.summaryId,
    tokensBefore,
    tokensAfter: leaf.compacted || condensed.length > 0 ? totalContextTokens(db, params.conversationId) : undefined,
    replacedItems: [leaf, ...condensed].reduce((total, outcome) => total + (outcome.replacedItems ?? 0), 0),
  };
}

async function compactLeafWindow(
  db: DatabaseSync,
  conversationId: string,
  freshTailCount: number,
  targetTokens: number,
  summaryQualityThreshold: number,
  summarize?: (text: string, targetTokens: number, mode: SummaryMode) => Promise<string>,
): Promise<CompactionOutcome> {
  const items = readContextItems(db, conversationId);
  const messageItems = items.filter((item) => item.item_type === "message" && item.message_id);
  const tokensBefore = sumMessageTokens(db, messageItems.map((item) => item.message_id!).filter(Boolean));

  if (messageItems.length <= freshTailCount + 1) {
    return { compacted: false, tokensBefore };
  }

  const protectedMessageIds = new Set(
    messageItems.slice(-freshTailCount).map((item) => item.message_id!).filter(Boolean),
  );
  const compactableItems = items.filter(
    (item) => item.item_type === "message" && item.message_id && !protectedMessageIds.has(item.message_id),
  );
  if (compactableItems.length === 0) {
    return { compacted: false, tokensBefore };
  }

  const compactableMessages = compactableItems
    .map((item) => getMessage(db, item.message_id!))
    .filter((row): row is MessageRow => row != null);
  const fallbackText = buildMessageSummary(compactableMessages, targetTokens);
  const generatedText = summarize
    ? await summarize(compactableMessages.map((message) => `${message.role}: ${collapseWhitespace(message.content)}`).join("\n"), targetTokens, "leaf")
    : fallbackText;
  const summaryText = selectSummaryText(generatedText, fallbackText, summaryQualityThreshold);
  const summaryId = `sum:${randomUUID()}`;
  const firstOrdinal = compactableItems[0]!.ordinal;

  retryOnBusy(() => db.exec("BEGIN IMMEDIATE"));
  try {
    insertSummary(db, {
      summaryId,
      conversationId,
      kind: "leaf",
      depth: 0,
      content: summaryText,
      summaryQualityThreshold,
    });

    const linkStmt = db.prepare(`
      INSERT INTO summary_messages (summary_id, message_id, ordinal)
      VALUES (?, ?, ?)
    `);
    compactableMessages.forEach((message, index) => {
      linkStmt.run(summaryId, message.message_id, index);
    });

    replaceContextItems(db, conversationId, items, compactableItems, {
      ordinal: firstOrdinal,
      item_type: "summary",
      message_id: null,
      summary_id: summaryId,
    });

    db.exec("COMMIT");
    return {
      compacted: true,
      summaryId,
      replacedItems: compactableItems.length,
      tokensBefore,
      tokensAfter: estimateTokens(summaryText),
      kind: "leaf",
      depth: 0,
    };
  } catch (error) {
    rollback(db);
    throw error;
  }
}

async function compactSummaryWindow(
  db: DatabaseSync,
  conversationId: string,
  targetTokens: number,
  summaryQualityThreshold: number,
  summarize?: (text: string, targetTokens: number, mode: SummaryMode) => Promise<string>,
): Promise<CompactionOutcome> {
  const items = readContextItems(db, conversationId);
  const existingSummaries = items
    .filter((item) => item.item_type === "summary" && item.summary_id)
    .map((item) => getSummary(db, item.summary_id!))
    .filter((row): row is SummaryRow => row != null);
  const tokensBefore = existingSummaries.reduce((total, row) => total + row.token_count, 0);

  const window = findCondensableSummaryWindow(items, db);
  if (window.length < 2) {
    return { compacted: false, tokensBefore };
  }

  const summaries = window
    .map((item) => getSummary(db, item.summary_id!))
    .filter((row): row is SummaryRow => row != null);
  if (summaries.some((summary) => !isSummaryEligibleForCompaction(summary.content, summaryQualityThreshold))) {
    return { compacted: false, tokensBefore };
  }

  const nextDepth = Math.max(...summaries.map((summary) => summary.depth)) + 1;
  const condensedInput = summaries
    .map(
      (summary) => `<previous_context depth="${summary.depth}" summary_id="${summary.summary_id}">${collapseWhitespace(summary.content)}</previous_context>`,
    )
    .join("\n");
  const fallbackText = truncateText(condensedInput, targetTokens);
  const generatedText = summarize ? await summarize(condensedInput, targetTokens, "condensed") : fallbackText;
  const summaryText = selectSummaryText(generatedText, fallbackText, summaryQualityThreshold);
  const summaryId = `sum:${randomUUID()}`;
  const firstOrdinal = window[0]!.ordinal;

  retryOnBusy(() => db.exec("BEGIN IMMEDIATE"));
  try {
    insertSummary(db, {
      summaryId,
      conversationId,
      kind: "condensed",
      depth: nextDepth,
      content: summaryText,
      summaryQualityThreshold,
    });

    const parentStmt = db.prepare(`
      INSERT INTO summary_parents (summary_id, parent_summary_id, ordinal)
      VALUES (?, ?, ?)
    `);
    summaries.forEach((summary, index) => {
      parentStmt.run(summary.summary_id, summaryId, index);
    });

    replaceContextItems(db, conversationId, items, window, {
      ordinal: firstOrdinal,
      item_type: "summary",
      message_id: null,
      summary_id: summaryId,
    });

    db.exec("COMMIT");
    return {
      compacted: true,
      summaryId,
      replacedItems: window.length,
      tokensBefore,
      tokensAfter: estimateTokens(summaryText),
      kind: "condensed",
      depth: nextDepth,
    };
  } catch (error) {
    rollback(db);
    throw error;
  }
}

function replaceContextItems(
  db: DatabaseSync,
  conversationId: string,
  items: ContextItemRow[],
  replacedItems: ContextItemRow[],
  insertedItem: ContextItemRow,
): void {
  const replacedOrdinals = new Set(replacedItems.map((item) => item.ordinal));
  const rebuilt = [
    ...items.filter((item) => item.ordinal < insertedItem.ordinal),
    insertedItem,
    ...items.filter((item) => item.ordinal > insertedItem.ordinal && !replacedOrdinals.has(item.ordinal)),
  ];

  db.prepare(`DELETE FROM context_items WHERE conversation_id = ?`).run(conversationId);
  const insertContext = db.prepare(`
    INSERT INTO context_items (conversation_id, ordinal, item_type, message_id, summary_id, created_at)
    VALUES (?, ?, ?, ?, ?, datetime('now'))
  `);
  rebuilt.forEach((item, index) => {
    insertContext.run(conversationId, index, item.item_type, item.message_id, item.summary_id);
  });
}

function insertSummary(
  db: DatabaseSync,
  params: {
    summaryId: string;
    conversationId: string;
    kind: "leaf" | "condensed";
    depth: number;
    content: string;
    summaryQualityThreshold: number;
  },
): void {
  const content = sanitizeSummaryContent(params.content);
  const qualityScore = computeSummaryQualityScore(content, params.summaryQualityThreshold);
  db.prepare(`
    INSERT INTO summaries (summary_id, conversation_id, kind, depth, content, quality_score, token_count, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `).run(
    params.summaryId,
    params.conversationId,
    params.kind,
    params.depth,
    content,
    qualityScore,
    estimateTokens(content),
  );
}

function findCondensableSummaryWindow(items: ContextItemRow[], db: DatabaseSync): ContextItemRow[] {
  let current: ContextItemRow[] = [];
  let currentDepth: number | null = null;

  for (const item of items) {
    if (item.item_type !== "summary" || !item.summary_id) {
      if (current.length >= 2) {
        return current;
      }
      current = [];
      currentDepth = null;
      continue;
    }

    const summary = getSummary(db, item.summary_id);
    if (!summary) {
      if (current.length >= 2) {
        return current;
      }
      current = [];
      currentDepth = null;
      continue;
    }

    if (currentDepth == null || currentDepth === summary.depth) {
      current.push(item);
      currentDepth = summary.depth;
      continue;
    }

    if (current.length >= 2) {
      return current;
    }

    current = [item];
    currentDepth = summary.depth;
  }

  return current.length >= 2 ? current : [];
}

function readContextItems(db: DatabaseSync, conversationId: string): ContextItemRow[] {
  return db.prepare(`
    SELECT ordinal, item_type, message_id, summary_id
    FROM context_items
    WHERE conversation_id = ?
    ORDER BY ordinal ASC
  `).all(conversationId) as ContextItemRow[];
}

function getMessage(db: DatabaseSync, messageId: string): MessageRow | null {
  return (
    (db.prepare(`
      SELECT message_id, role, content, token_count
      FROM messages
      WHERE message_id = ?
    `).get(messageId) as MessageRow | undefined) ?? null
  );
}

function getSummary(db: DatabaseSync, summaryId: string): SummaryRow | null {
  return (
    (db.prepare(`
      SELECT summary_id, depth, content, token_count
      , quality_score
      FROM summaries
      WHERE summary_id = ?
    `).get(summaryId) as SummaryRow | undefined) ?? null
  );
}

function totalContextTokens(db: DatabaseSync, conversationId: string): number {
  const items = readContextItems(db, conversationId);
  return items.reduce((total, item) => {
    if (item.item_type === "message" && item.message_id) {
      return total + (getMessage(db, item.message_id)?.token_count ?? 0);
    }
    if (item.item_type === "summary" && item.summary_id) {
      return total + (getSummary(db, item.summary_id)?.token_count ?? 0);
    }
    return total;
  }, 0);
}

function sumMessageTokens(db: DatabaseSync, messageIds: string[]): number {
  return messageIds.reduce((total, messageId) => {
    const row = getMessage(db, messageId);
    return total + (row?.token_count ?? 0);
  }, 0);
}

function buildMessageSummary(messages: MessageRow[], targetTokens: number): string {
  const lines = messages.map((message) => `${message.role}: ${collapseWhitespace(message.content)}`);
  return truncateText(lines.join("\n"), targetTokens);
}

function selectSummaryText(
  generatedText: string,
  fallbackText: string,
  summaryQualityThreshold: number,
): string {
  const sanitizedGenerated = sanitizeSummaryContent(generatedText);
  return isSummaryEligibleForCompaction(sanitizedGenerated, summaryQualityThreshold)
    ? sanitizedGenerated
    : sanitizeSummaryContent(fallbackText);
}

function truncateText(value: string, targetTokens: number): string {
  const maxChars = Math.max(targetTokens * 4, 200);
  return value.length <= maxChars ? value : `${value.slice(0, maxChars - 3).trimEnd()}...`;
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function rollback(db: DatabaseSync): void {
  try {
    db.exec("ROLLBACK");
  } catch {
    // preserve original error
  }
}
