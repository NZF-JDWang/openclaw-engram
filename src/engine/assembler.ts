import type { DatabaseSync } from "node:sqlite";
import { estimateTokens } from "../token-estimate.js";

export type AssembledContext = {
  messages: Array<{ role: "user" | "assistant"; content: string; timestamp: number }>;
  estimatedTokens: number;
};

type ContextItemRow = {
  item_type: string;
  ordinal: number;
  message_id: string | null;
  summary_id: string | null;
};

type MessageRow = {
  role: string;
  content: string;
  created_at: string;
};

type SummaryRow = {
  summary_id: string;
  kind: string;
  depth: number;
  content: string;
  created_at: string;
};

export function assembleConversationContext(
  db: DatabaseSync,
  conversationId: string,
  tokenBudget?: number,
): AssembledContext {
  const items = db.prepare(`
    SELECT item_type, ordinal, message_id, summary_id
    FROM context_items
    WHERE conversation_id = ?
    ORDER BY ordinal ASC
  `).all(conversationId) as ContextItemRow[];

  const assembled = items.map((item) => {
    if (item.item_type === "message" && item.message_id) {
      const row = db.prepare(`
        SELECT role, content, created_at
        FROM messages
        WHERE message_id = ?
      `).get(item.message_id) as MessageRow | undefined;
      if (!row) {
        return null;
      }
      return {
        role: normalizeRole(row.role),
        content: row.content,
        timestamp: Date.parse(row.created_at) || Date.now(),
      };
    }

    if (item.item_type === "summary" && item.summary_id) {
      const row = db.prepare(`
        SELECT summary_id, kind, depth, content, created_at
        FROM summaries
        WHERE summary_id = ?
      `).get(item.summary_id) as SummaryRow | undefined;
      if (!row) {
        return null;
      }
      return {
        role: "user" as const,
        content: renderSummaryXml(row),
        timestamp: Date.parse(row.created_at) || Date.now(),
      };
    }

    return null;
  }).filter((item): item is { role: "user" | "assistant"; content: string; timestamp: number } => item != null);

  const trimmed = trimToTokenBudget(assembled, tokenBudget);

  return {
    messages: trimmed,
    estimatedTokens: trimmed.reduce((total, message) => total + estimateTokens(message.content), 0),
  };
}

export function renderSummaryXml(row: {
  summary_id: string;
  kind: string;
  depth: number;
  content: string;
}): string {
  return [
    `<summary id="${escapeXml(row.summary_id)}" kind="${escapeXml(row.kind)}" depth="${row.depth}">`,
    `  <content>${escapeXml(row.content)}</content>`,
    `</summary>`,
  ].join("\n");
}

function trimToTokenBudget<T extends { content: string }>(messages: T[], tokenBudget?: number): T[] {
  if (!tokenBudget || tokenBudget <= 0) {
    return messages;
  }
  let total = 0;
  const kept: T[] = [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    const tokens = estimateTokens(message.content);
    if (kept.length > 0 && total + tokens > tokenBudget) {
      continue;
    }
    kept.push(message);
    total += tokens;
  }
  return kept.reverse();
}

function normalizeRole(role: string): "user" | "assistant" {
  return role === "assistant" || role === "tool" ? "assistant" : "user";
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}