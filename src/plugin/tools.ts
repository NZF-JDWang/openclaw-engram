import { Type } from "@sinclair/typebox";
import type { AnyAgentTool } from "openclaw/plugin-sdk";
import type { EngramConfig } from "../config.js";
import { deleteExplicitFact, findConflictingFacts, indexPath, listExplicitFacts, storeExplicitFact } from "../kb/indexer.js";
import { getKnowledgeDocument, searchKnowledgeBase } from "../kb/store.js";
import { openDatabase } from "../db/connection.js";
import { exportMemories } from "./export.js";
import {
  completeCommitment,
  listCommitments,
  listDreamCandidates,
  stageDreamCandidate,
  storeCommitment,
} from "./memory-layers.js";
import { formatStatus, readStatus } from "./status.js";

export function createEngramStatusTool(config: EngramConfig): AnyAgentTool {
  return {
    name: "engram_status",
    label: "Engram Status",
    description: "Return the current Engram bootstrap status",
    parameters: Type.Object({}),
    async execute() {
      try {
        const snapshot = readStatus(config);
        return {
          content: [
            {
              type: "text",
              text: formatStatus(snapshot),
            },
          ],
          details: snapshot,
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Status check failed: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          details: { error: String(error) },
        };
      }
    },
  };
}

export function createEngramSearchTool(config: EngramConfig): AnyAgentTool {
  return createSearchTool(config, {
    name: "engram_search",
    label: "Engram Search",
    description: "Search imported and indexed Engram knowledge base chunks",
    compactOutput: false,
  });
}

export function createMemorySearchTool(config: EngramConfig): AnyAgentTool {
  return createSearchTool(config, {
    name: "memory_search",
    label: "Memory Search",
    description: "OpenClaw-compatible memory search backed by Engram",
    compactOutput: true,
  });
}

export function createMemoryRecallTool(config: EngramConfig): AnyAgentTool {
  return createSearchTool(config, {
    name: "memory_recall",
    label: "Memory Recall",
    description: "OpenClaw-compatible memory recall backed by Engram; returns compact relevant memory snippets",
    compactOutput: true,
  });
}

function createSearchTool(
  config: EngramConfig,
  tool: { name: string; label: string; description: string; compactOutput: boolean },
): AnyAgentTool {
  return {
    name: tool.name,
    label: tool.label,
    description: tool.description,
    parameters: Type.Object({
      query: Type.String(),
      maxResults: Type.Optional(Type.Number({ minimum: 1, maximum: 20 })),
      collections: Type.Optional(Type.Array(Type.String())),
      collection: Type.Optional(Type.String()),
      minScore: Type.Optional(Type.Number({ minimum: 0 })),
      since: Type.Optional(Type.String({ description: "ISO date string (YYYY-MM-DD). Only return chunks indexed on or after this date." })),
      until: Type.Optional(Type.String({ description: "ISO date string (YYYY-MM-DD). Only return chunks indexed on or before this date." })),
    }),
    async execute(_toolCallId, input) {
      try {
        const query = String(input.query ?? "").trim();
        const maxResults = typeof input.maxResults === "number" ? input.maxResults : 5;
        const collections = Array.isArray(input.collections)
          ? input.collections.filter((value: unknown): value is string => typeof value === "string" && value.trim().length > 0)
          : [];
        const collection = typeof input.collection === "string" ? input.collection : undefined;
        const minScore = typeof input.minScore === "number" ? input.minScore : 0;
        const sinceRaw = typeof input.since === "string" ? input.since.trim() : undefined;
        const untilRaw = typeof input.until === "string" ? input.until.trim() : undefined;
        if (sinceRaw && !isIsoDate(sinceRaw)) {
          return { content: [{ type: "text", text: `Invalid 'since' date: "${sinceRaw}". Expected YYYY-MM-DD.` }], details: { error: "invalid_date" } };
        }
        if (untilRaw && !isIsoDate(untilRaw)) {
          return { content: [{ type: "text", text: `Invalid 'until' date: "${untilRaw}". Expected YYYY-MM-DD.` }], details: { error: "invalid_date" } };
        }
        const since = sinceRaw || undefined;
        const until = untilRaw || undefined;
        const requestedCollections = collections.length > 0 ? collections : collection ? [collection] : [];
        const results = (await searchKnowledgeBase(config, query, {
          limit: requestedCollections.length > 0 ? Math.max(maxResults * 3, maxResults) : maxResults,
          since,
          until,
        }))
          .filter((result) => requestedCollections.length === 0 || requestedCollections.includes(result.collectionName))
          .filter((result) => result.score >= minScore)
          .slice(0, maxResults);
        return {
          content: [
            {
              type: "text",
              text:
                results.length === 0
                  ? `No memory results for: ${query}`
                  : results
                      .map(
                        (result) =>
                          tool.compactOutput
                            ? `${result.chunkId} [${result.collectionName}] ${result.relPath} score=${result.score.toFixed(3)}\n${truncate(result.content, 160)}`
                            : `[${result.collectionName}] ${result.relPath} (source_kind ${result.sourceKind}, score ${result.score})\n${truncate(result.content, 200)}`,
                      )
                      .join("\n\n"),
            },
          ],
          details: { query, collections: requestedCollections, minScore, results },
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Search failed: ${error instanceof Error ? error.message : String(error)}` }],
          details: { error: String(error) },
        };
      }
    },
  };
}

export function createEngramGetTool(config: EngramConfig): AnyAgentTool {
  return createGetTool(config, {
    name: "engram_get",
    label: "Engram Get",
    description: "Fetch the full content of an Engram KB document by doc id, chunk id, or relative path",
  });
}

export function createMemoryGetTool(config: EngramConfig): AnyAgentTool {
  return createGetTool(config, {
    name: "memory_get",
    label: "Memory Get",
    description: "OpenClaw-compatible memory fetch backed by Engram; accepts document id, chunk id, or relative path",
  });
}

function createGetTool(
  config: EngramConfig,
  tool: { name: string; label: string; description: string },
): AnyAgentTool {
  return {
    name: tool.name,
    label: tool.label,
    description: tool.description,
    parameters: Type.Object({
      id: Type.String(),
    }),
    async execute(_toolCallId, input) {
      try {
        const id = String(input.id ?? "").trim();
        const document = getKnowledgeDocument(config, id);
        return {
          content: [
            {
              type: "text",
              text:
                document == null
                  ? `No KB document found for: ${id}`
                  : `${document.collectionName}/${document.relPath}\n\n${document.content}`,
            },
          ],
          details: { id, document },
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Get failed: ${error instanceof Error ? error.message : String(error)}` }],
          details: { error: String(error) },
        };
      }
    },
  };
}

export function createEngramIndexTool(config: EngramConfig): AnyAgentTool {
  return {
    name: "engram_index",
    label: "Engram Index",
    description: "Index a file or directory into the Engram knowledge base",
    parameters: Type.Object({
      path: Type.String(),
      collection: Type.Optional(Type.String()),
    }),
    async execute(_toolCallId, input) {
      try {
        const result = await indexPath(
          config,
          String(input.path ?? "").trim(),
          typeof input.collection === "string" ? input.collection : undefined,
        );
        return {
          content: [
            {
              type: "text",
              text: `Indexed ${result.indexedDocuments} document(s) into [${result.collectionName}] with ${result.indexedChunks} chunk(s).`,
            },
          ],
          details: result,
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Index failed: ${error instanceof Error ? error.message : String(error)}` }],
          details: { error: String(error) },
        };
      }
    },
  };
}

export function createEngramExportTool(config: EngramConfig): AnyAgentTool {
  return {
    name: "engram_export",
    label: "Engram Export",
    description: "Export Engram knowledge base to markdown",
    parameters: Type.Object({
      path: Type.Optional(Type.String()),
    }),
    async execute(_toolCallId, input) {
      try {
        const result = exportMemories(
          config,
          typeof input.path === "string" ? input.path : undefined,
        );
        return {
          content: [{ type: "text", text: `Exported Engram memories to ${result.path}.` }],
          details: result,
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Export failed: ${error instanceof Error ? error.message : String(error)}` }],
          details: { error: String(error) },
        };
      }
    },
  };
}

function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  const date = new Date(value);
  return !Number.isNaN(date.getTime());
}

export function createEngramRememberTool(config: EngramConfig): AnyAgentTool {
  return {
    name: "engram_remember",
    label: "Engram Remember",
    description: [
      "Store an explicit fact, preference, or constraint into persistent memory.",
      "Use this when the user states something that should be recalled in future sessions.",
      "IMPORTANT: If this fact updates or contradicts something you have previously remembered, pass the old fact's ID in 'replaces'.",
      "Storing contradicting facts without superseding the old one will cause both to surface in recall.",
      "Call engram_review to see existing facts before storing new ones on the same topic.",
    ].join(" "),
    parameters: Type.Object({
      content: Type.String({ description: "The fact, preference, or constraint to remember." }),
      label: Type.Optional(Type.String({ description: "Short descriptive title. Derived from content if omitted." })),
      replaces: Type.Optional(Type.String({ description: "Fact ID of an older fact this supersedes. Deletes the old fact atomically." })),
    }),
    async execute(_toolCallId, input) {
      try {
        const content = String(input.content ?? "").trim();
        if (!content) {
          return { content: [{ type: "text", text: "content is required." }], details: { error: "empty_content" } };
        }
        const label = typeof input.label === "string" && input.label.trim() ? input.label.trim() : undefined;
        const replaces = typeof input.replaces === "string" && input.replaces.trim() ? input.replaces.trim() : undefined;
        const database = openDatabase(config.dbPath);
        try {
          const result = await storeExplicitFact(database.db, config, { content, label, replaces });
          const lines: string[] = [`Remembered: "${result.label}" (ID: ${result.factId})`];
          if (result.replacedFactId) {
            lines.push(`Replaced: ${result.replacedFactId}`);
          }
          if (result.conflicts.length > 0) {
            lines.push(`Warning: similar facts already stored (consider using 'replaces'):`);
            for (const conflict of result.conflicts) {
              lines.push(`  - ${conflict.factId}: "${conflict.label}" (similarity: ${(conflict.similarity * 100).toFixed(0)}%, method: ${conflict.detectionMethod})`);
            }
          }
          return { content: [{ type: "text", text: lines.join("\n") }], details: result };
        } finally {
          database.close();
        }
      } catch (error) {
        return {
          content: [{ type: "text", text: `Remember failed: ${error instanceof Error ? error.message : String(error)}` }],
          details: { error: String(error) },
        };
      }
    },
  };
}

export function createEngramForgetTool(config: EngramConfig): AnyAgentTool {
  return {
    name: "engram_forget",
    label: "Engram Forget",
    description: "Delete an explicitly stored fact from persistent memory by its fact ID. Get IDs from engram_review.",
    parameters: Type.Object({
      factId: Type.String({ description: "The ID of the fact to delete." }),
    }),
    async execute(_toolCallId, input) {
      try {
        const factId = String(input.factId ?? "").trim();
        if (!factId) {
          return { content: [{ type: "text", text: "factId is required." }], details: { error: "empty_id" } };
        }
        const database = openDatabase(config.dbPath);
        try {
          const deleted = deleteExplicitFact(database.db, factId);
          return {
            content: [{ type: "text", text: deleted ? `Deleted fact: ${factId}` : `No fact found with ID: ${factId}` }],
            details: { factId, deleted },
          };
        } finally {
          database.close();
        }
      } catch (error) {
        return {
          content: [{ type: "text", text: `Forget failed: ${error instanceof Error ? error.message : String(error)}` }],
          details: { error: String(error) },
        };
      }
    },
  };
}

export function createEngramReviewTool(config: EngramConfig): AnyAgentTool {
  return {
    name: "engram_review",
    label: "Engram Review",
    description: [
      "List all explicitly stored facts, sorted stalest first.",
      "Facts flagged [STALE] have not been recalled in 30+ days.",
      "Call engram_forget on any stale fact that no longer applies.",
      "Do not keep facts whose conditions have changed.",
    ].join(" "),
    parameters: Type.Object({}),
    async execute() {
      try {
        const database = openDatabase(config.dbPath);
        try {
          const facts = listExplicitFacts(database.db);
          if (facts.length === 0) {
            return { content: [{ type: "text", text: "No stored facts." }], details: { facts: [] } };
          }
          const now = Date.now();
          const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
          const lines: string[] = [`Stored facts (${facts.length} total, stalest first):`, ""];
          for (const fact of facts) {
            const lastHitMs = fact.lastHitAt ? Date.parse(fact.lastHitAt) : null;
            const isStale = lastHitMs === null || now - lastHitMs > thirtyDaysMs;
            const staleTag = isStale ? ` [STALE — last hit: ${fact.lastHitAt ?? "never"}]` : "";
            lines.push(`${fact.factId}${staleTag}`);
            lines.push(`  Label:   ${fact.label}`);
            lines.push(`  Content: ${fact.content.length > 120 ? fact.content.slice(0, 120) + "..." : fact.content}`);
            lines.push(`  Stored:  ${fact.indexedAt}  Hits: ${fact.hitCount}`);
            lines.push("");
          }
          return { content: [{ type: "text", text: lines.join("\n") }], details: { facts } };
        } finally {
          database.close();
        }
      } catch (error) {
        return {
          content: [{ type: "text", text: `Review failed: ${error instanceof Error ? error.message : String(error)}` }],
          details: { error: String(error) },
        };
      }
    },
  };
}

export function createEngramConflictsTool(config: EngramConfig): AnyAgentTool {
  return {
    name: "engram_conflicts",
    label: "Engram Conflicts",
    description: "Check if a piece of text conflicts with any existing stored facts. Returns similar facts above the similarity threshold.",
    parameters: Type.Object({
      content: Type.String({ description: "Text to check for conflicts against stored facts." }),
    }),
    async execute(_toolCallId, input) {
      try {
        const content = String(input.content ?? "").trim();
        if (!content) {
          return { content: [{ type: "text", text: "content is required." }], details: { error: "empty_content" } };
        }
        const database = openDatabase(config.dbPath);
        try {
          const conflicts = await findConflictingFacts(database.db, config, content);
          if (conflicts.length === 0) {
            return { content: [{ type: "text", text: "No conflicting facts found." }], details: { conflicts: [] } };
          }
          const lines = [`Found ${conflicts.length} similar fact(s):`, ""];
          for (const c of conflicts) {
            lines.push(`${c.factId}: "${c.label}" (similarity: ${(c.similarity * 100).toFixed(0)}%, method: ${c.detectionMethod})`);
          }
          return { content: [{ type: "text", text: lines.join("\n") }], details: { conflicts } };
        } finally {
          database.close();
        }
      } catch (error) {
        return {
          content: [{ type: "text", text: `Conflicts check failed: ${error instanceof Error ? error.message : String(error)}` }],
          details: { error: String(error) },
        };
      }
    },
  };
}

export function createEngramCommitmentTool(config: EngramConfig): AnyAgentTool {
  return {
    name: "engram_commitment",
    label: "Engram Commitment",
    description: "Store, list, or complete short-lived follow-up commitments without adding them to durable memory.",
    parameters: Type.Object({
      action: Type.Optional(Type.Union([Type.Literal("store"), Type.Literal("list"), Type.Literal("due"), Type.Literal("complete")])),
      content: Type.Optional(Type.String()),
      dueAt: Type.Optional(Type.String({ description: "Optional ISO date/datetime for when the commitment is due." })),
      commitmentId: Type.Optional(Type.String()),
      sourceConversationId: Type.Optional(Type.String()),
      limit: Type.Optional(Type.Number({ minimum: 1, maximum: 50 })),
    }),
    async execute(_toolCallId, input) {
      const action = typeof input.action === "string" ? input.action : "list";
      const database = openDatabase(config.dbPath);
      try {
        if (action === "store") {
          const content = typeof input.content === "string" ? input.content.trim() : "";
          if (!content) {
            return { content: [{ type: "text", text: "content is required for action=store." }], details: { error: "empty_content" } };
          }
          const row = storeCommitment(database.db, {
            content,
            dueAt: typeof input.dueAt === "string" && input.dueAt.trim() ? input.dueAt.trim() : undefined,
            sourceConversationId:
              typeof input.sourceConversationId === "string" && input.sourceConversationId.trim()
                ? input.sourceConversationId.trim()
                : undefined,
          });
          return { content: [{ type: "text", text: `Stored commitment ${row.commitmentId}: ${row.content}` }], details: row };
        }

        if (action === "complete") {
          const commitmentId = typeof input.commitmentId === "string" ? input.commitmentId.trim() : "";
          if (!commitmentId) {
            return { content: [{ type: "text", text: "commitmentId is required for action=complete." }], details: { error: "empty_id" } };
          }
          const completed = completeCommitment(database.db, commitmentId);
          return {
            content: [{ type: "text", text: completed ? `Completed commitment ${commitmentId}.` : `No open commitment found: ${commitmentId}` }],
            details: { commitmentId, completed },
          };
        }

        const rows = listCommitments(database.db, {
          status: "open",
          dueBefore: action === "due" ? new Date().toISOString() : undefined,
          limit: typeof input.limit === "number" ? input.limit : 20,
        });
        return {
          content: [{
            type: "text",
            text: rows.length === 0
              ? "No matching commitments."
              : rows.map((row) => `${row.commitmentId}${row.dueAt ? ` due=${row.dueAt}` : ""}: ${row.content}`).join("\n"),
          }],
          details: { commitments: rows },
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Commitment operation failed: ${error instanceof Error ? error.message : String(error)}` }],
          details: { error: String(error) },
        };
      } finally {
        database.close();
      }
    },
  };
}

export function createEngramDreamsTool(config: EngramConfig): AnyAgentTool {
  return {
    name: "engram_dreams",
    label: "Engram Dreams",
    description: "Stage or list reviewable dream candidates for later durable-memory promotion.",
    parameters: Type.Object({
      action: Type.Optional(Type.Union([Type.Literal("stage"), Type.Literal("list")])),
      content: Type.Optional(Type.String()),
      sourceKind: Type.Optional(Type.String()),
      sourceId: Type.Optional(Type.String()),
      score: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
      minScore: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
      limit: Type.Optional(Type.Number({ minimum: 1, maximum: 50 })),
    }),
    async execute(_toolCallId, input) {
      const action = typeof input.action === "string" ? input.action : "list";
      const database = openDatabase(config.dbPath);
      try {
        if (action === "stage") {
          const content = typeof input.content === "string" ? input.content.trim() : "";
          if (!content) {
            return { content: [{ type: "text", text: "content is required for action=stage." }], details: { error: "empty_content" } };
          }
          const row = stageDreamCandidate(database.db, {
            content,
            sourceKind: typeof input.sourceKind === "string" && input.sourceKind.trim() ? input.sourceKind.trim() : "manual",
            sourceId: typeof input.sourceId === "string" && input.sourceId.trim() ? input.sourceId.trim() : "manual",
            score: typeof input.score === "number" ? input.score : 0.5,
          });
          return { content: [{ type: "text", text: `Staged dream candidate ${row.candidateId}: ${truncate(row.content, 160)}` }], details: row };
        }
        const rows = listDreamCandidates(database.db, {
          limit: typeof input.limit === "number" ? input.limit : 20,
          minScore: typeof input.minScore === "number" ? input.minScore : undefined,
        });
        return {
          content: [{
            type: "text",
            text: rows.length === 0
              ? "No dream candidates."
              : rows.map((row) => `${row.candidateId} score=${row.score.toFixed(2)} ${row.sourceKind}:${row.sourceId}\n${truncate(row.content, 180)}`).join("\n\n"),
          }],
          details: { candidates: rows },
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Dream operation failed: ${error instanceof Error ? error.message : String(error)}` }],
          details: { error: String(error) },
        };
      } finally {
        database.close();
      }
    },
  };
}

function truncate(value: string, limit: number): string {
  const collapsed = value.replace(/\s+/g, " ").trim();
  return collapsed.length <= limit ? collapsed : `${collapsed.slice(0, limit - 3)}...`;
}
