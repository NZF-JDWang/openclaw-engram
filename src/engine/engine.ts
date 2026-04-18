import { randomUUID } from "node:crypto";
import type {
  AssembleResult,
  BootstrapResult,
  CompactResult,
  ContextEngine,
  ContextEngineRuntimeContext,
  IngestBatchResult,
  IngestResult,
  PluginRuntime,
} from "openclaw/plugin-sdk";
import type { EngramConfig } from "../config.js";
import { retryOnBusy, type EngramDatabase } from "../db/connection.js";
import { indexSessionSummaryById } from "../kb/indexer.js";
import { sanitizeStoredContent } from "../lifecycle.js";
import { pruneSummarizedConversationsForCurrentConfig } from "../plugin/maintenance.js";
import { estimateTokens } from "../token-estimate.js";
import { assembleConversationContext } from "./assembler.js";
import { compactConversation } from "./compaction.js";
import { summarizeText } from "./summarizer.js";

export class EngramContextEngine implements ContextEngine {
  readonly info = {
    id: "engram",
    name: "Engram",
    ownsCompaction: true,
  } as const;

  constructor(
    private readonly database: EngramDatabase,
    private readonly config: EngramConfig,
    private readonly runtime?: PluginRuntime,
  ) {}

  async bootstrap(params: {
    sessionId: string;
    sessionKey?: string;
    sessionFile: string;
  }): Promise<BootstrapResult> {
    const statement = this.database.db.prepare(`
      INSERT OR IGNORE INTO conversations (conversation_id, session_id, session_key, created_at)
      VALUES (?, ?, ?, datetime('now'))
    `);
    statement.run(params.sessionId, params.sessionId, params.sessionKey ?? null);
    return { bootstrapped: true, importedMessages: 0 };
  }

  async ingest(params: {
    sessionId: string;
    sessionKey?: string;
    message: { role?: string; content?: unknown };
  }): Promise<IngestResult> {
    const role = typeof params.message.role === "string" ? params.message.role : "unknown";
    const content = sanitizeStoredContent(
      normalizeContent(params.message.content),
      this.config.maxMessageContentBytes,
    );
    const messageId = randomUUID();
    const seq = this.nextSequence(params.sessionId);
    const ordinal = this.nextContextOrdinal(params.sessionId);
    retryOnBusy(() => this.database.db.exec("BEGIN IMMEDIATE"));
    try {
      this.database.db.prepare(`
        INSERT INTO messages (message_id, conversation_id, seq, role, content, token_count, created_at)
        VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
      `).run(messageId, params.sessionId, seq, role, content, estimateTokens(content));
      this.database.db.prepare(`
        INSERT INTO context_items (conversation_id, ordinal, item_type, message_id, summary_id, created_at)
        VALUES (?, ?, 'message', ?, NULL, datetime('now'))
      `).run(params.sessionId, ordinal, messageId);
      this.database.db.exec("COMMIT");
    } catch (error) {
      try {
        this.database.db.exec("ROLLBACK");
      } catch {
        // preserve original error
      }
      throw error;
    }
    return { ingested: true };
  }

  async ingestBatch(params: {
    sessionId: string;
    sessionKey?: string;
    messages: Array<{ role?: string; content?: unknown }>;
  }): Promise<IngestBatchResult> {
    let ingestedCount = 0;
    for (const message of params.messages) {
      const result = await this.ingest({ ...params, message });
      if (result.ingested) {
        ingestedCount += 1;
      }
    }
    return { ingestedCount };
  }

  async assemble(params: {
    sessionId: string;
    messages: unknown[];
    tokenBudget?: number;
  }): Promise<AssembleResult> {
    const storedCount = this.countMessages(params.sessionId);
    if (storedCount === 0) {
      return {
        messages: params.messages as AssembleResult["messages"],
        estimatedTokens: 0,
        systemPromptAddition: this.buildSystemPromptAddition(),
      };
    }

    const assembled = assembleConversationContext(
      this.database.db,
      params.sessionId,
      params.tokenBudget,
    );

    return {
      messages: assembled.messages as AssembleResult["messages"],
      estimatedTokens: assembled.estimatedTokens,
      systemPromptAddition: this.buildSystemPromptAddition(),
    };
  }

  async afterTurn(params: {
    sessionId: string;
    sessionKey?: string;
    sessionFile: string;
    messages: Array<{ role?: string; content?: unknown }>;
    prePromptMessageCount: number;
    autoCompactionSummary?: string;
    isHeartbeat?: boolean;
    tokenBudget?: number;
    runtimeContext?: ContextEngineRuntimeContext;
  }): Promise<void> {
    try {
      const result = await compactConversation(this.database.db, {
        conversationId: params.sessionId,
        freshTailCount: this.config.freshTailCount,
        targetTokens: this.config.leafTargetTokens,
        condensedTargetTokens: this.config.condensedTargetTokens,
        incrementalMaxDepth: this.config.compactionMaxDepth ?? this.config.incrementalMaxDepth,
        summaryQualityThreshold: this.config.summaryQualityThreshold,
        summarize: (text, targetTokens, mode) =>
          summarizeText({
            text,
            mode,
            targetTokens,
            config: this.config,
            runtime: this.runtime,
            fallback: (fallbackText, fallbackTargetTokens, fallbackMode) =>
              fallbackMode === "leaf"
                ? truncateSummaryText(fallbackText, fallbackTargetTokens)
                : truncateSummaryText(fallbackText, fallbackTargetTokens),
          }),
      });
      if (this.config.kbEnabled && result.latestSummaryId) {
        await indexSessionSummaryById(this.database.db, this.config, {
          conversationId: params.sessionId,
          summaryId: result.latestSummaryId,
        });
      }
      if (this.config.pruneSummarizedMessages) {
        pruneSummarizedConversationsForCurrentConfig(this.database.db, this.config, params.sessionId);
      }
    } catch (error) {
      console.warn(`[engram] afterTurn compaction failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async compact(_: { sessionId: string; tokenBudget?: number }): Promise<CompactResult> {
    const result = await compactConversation(this.database.db, {
      conversationId: _.sessionId,
      freshTailCount: this.config.freshTailCount,
      targetTokens: this.config.leafTargetTokens,
      condensedTargetTokens: this.config.condensedTargetTokens,
      incrementalMaxDepth: this.config.compactionMaxDepth ?? this.config.incrementalMaxDepth,
      summaryQualityThreshold: this.config.summaryQualityThreshold,
      summarize: (text, targetTokens, mode) =>
        summarizeText({
          text,
          mode,
          targetTokens,
          config: this.config,
          runtime: this.runtime,
          fallback: (fallbackText, fallbackTargetTokens) => truncateSummaryText(fallbackText, fallbackTargetTokens),
        }),
    });
    if (this.config.kbEnabled && result.latestSummaryId) {
      await indexSessionSummaryById(this.database.db, this.config, {
        conversationId: _.sessionId,
        summaryId: result.latestSummaryId,
      });
    }
    return {
      ok: true,
      compacted: result.compacted,
      reason: result.compacted ? undefined : "No compactable message window found.",
      result: {
        summary: result.latestSummaryId,
        tokensBefore: result.tokensBefore,
        tokensAfter: result.tokensAfter,
        details: {
          replacedItems: result.replacedItems,
          leafSummary: result.leaf?.summaryId,
          condensedSummaries: result.condensed.map((outcome) => outcome.summaryId),
        },
      },
    };
  }

  async dispose(): Promise<void> {
    this.database.close();
  }

  private countMessages(conversationId: string): number {
    const row = this.database.db.prepare(`
      SELECT COUNT(*) AS count FROM messages WHERE conversation_id = ?
    `).get(conversationId) as { count?: number } | undefined;
    return row?.count ?? 0;
  }

  private nextSequence(conversationId: string): number {
    const row = this.database.db.prepare(`
      SELECT COALESCE(MAX(seq), -1) AS maxSeq FROM messages WHERE conversation_id = ?
    `).get(conversationId) as { maxSeq?: number } | undefined;
    return (row?.maxSeq ?? -1) + 1;
  }

  private nextContextOrdinal(conversationId: string): number {
    const row = this.database.db.prepare(`
      SELECT COALESCE(MAX(ordinal), -1) AS maxOrdinal FROM context_items WHERE conversation_id = ?
    `).get(conversationId) as { maxOrdinal?: number } | undefined;
    return (row?.maxOrdinal ?? -1) + 1;
  }

  private buildSystemPromptAddition(): string {
    return `<engram_status kb_enabled="${this.config.kbEnabled}" recall_enabled="${this.config.recallEnabled}" />`;
  }
}

function truncateSummaryText(value: string, targetTokens: number): string {
  const maxChars = Math.max(targetTokens * 4, 200);
  return value.length <= maxChars ? value : `${value.slice(0, maxChars - 3).trimEnd()}...`;
}

function normalizeContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === "string") {
          return item;
        }
        if (item && typeof item === "object" && "text" in item && typeof item.text === "string") {
          return item.text;
        }
        return JSON.stringify(item);
      })
      .join("\n");
  }
  if (content == null) {
    return "";
  }
  return typeof content === "object" ? JSON.stringify(content) : String(content);
}
