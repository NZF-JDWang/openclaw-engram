import { Type } from "@sinclair/typebox";
import type { AnyAgentTool } from "openclaw/plugin-sdk";
import type { EngramConfig } from "../config.js";
import { indexPath } from "../kb/indexer.js";
import { getKnowledgeDocument, searchKnowledgeBase } from "../kb/store.js";
import { exportMemories } from "./export.js";
import { approveFact, forgetFact, rejectFact, rememberFact, searchApprovedFacts } from "./facts.js";
import { mergePendingFacts, readPersona, writePersona } from "./persona.js";
import { formatStatus, readStatus } from "./status.js";

export function createEngramStatusTool(config: EngramConfig): AnyAgentTool {
  return {
    name: "engram_status",
    label: "Engram Status",
    description: "Return the current Engram bootstrap status",
    parameters: Type.Object({}),
    async execute() {
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
    },
  };
}

export function createEngramRememberTool(config: EngramConfig): AnyAgentTool {
  return {
    name: "engram_remember",
    label: "Engram Remember",
    description: "Store a governed Engram fact with class-aware approval rules",
    parameters: Type.Object({
      content: Type.String(),
      memory_class: Type.Union([
        Type.Literal("identity"),
        Type.Literal("project"),
        Type.Literal("task"),
        Type.Literal("reference"),
      ]),
      source_basis: Type.Optional(
        Type.Union([
          Type.Literal("user_stated"),
          Type.Literal("agent_inferred"),
          Type.Literal("document_derived"),
          Type.Literal("decision"),
        ]),
      ),
      source_kind: Type.Optional(
        Type.Union([
          Type.Literal("user_stated"),
          Type.Literal("agent_inferred"),
          Type.Literal("document_derived"),
          Type.Literal("decision"),
        ]),
      ),
      scope: Type.Optional(
        Type.Union([Type.Literal("global"), Type.Literal("agent"), Type.Literal("session")]),
      ),
      expiry: Type.Optional(Type.String()),
    }),
    async execute(_toolCallId, input) {
      const fact = rememberFact(config, {
        content: String(input.content ?? "").trim(),
        memoryClass: input.memory_class as "identity" | "project" | "task" | "reference",
        sourceBasis: (input.source_basis ?? input.source_kind) as
          | "user_stated"
          | "agent_inferred"
          | "document_derived"
          | "decision"
          | undefined,
        sourceKind: input.source_kind as
          | "user_stated"
          | "agent_inferred"
          | "document_derived"
          | "decision"
          | undefined,
        scope: input.scope as "global" | "agent" | "session" | undefined,
        expiry: typeof input.expiry === "string" ? input.expiry : undefined,
      });
      return {
        content: [
          {
            type: "text",
            text: `Stored fact ${fact.factId} [${fact.memoryClass}] with ${fact.approvalState} approval.`,
          },
        ],
        details: fact,
      };
    },
  };
}

export function createEngramForgetTool(config: EngramConfig): AnyAgentTool {
  return {
    name: "engram_forget",
    label: "Engram Forget",
    description: "Deprecate a stored Engram fact without deleting its audit history",
    parameters: Type.Object({
      id: Type.String(),
      reason: Type.Optional(Type.String()),
    }),
    async execute(_toolCallId, input) {
      const factId = String(input.id ?? "").trim();
      const fact = forgetFact(
        config,
        factId,
        typeof input.reason === "string" ? input.reason : undefined,
      );
      return {
        content: [{ type: "text", text: fact ? `Forgot fact ${factId}.` : `Fact not found: ${factId}` }],
        details: { fact },
      };
    },
  };
}

export function createEngramSearchTool(config: EngramConfig): AnyAgentTool {
  return {
    name: "engram_search",
    label: "Engram Search",
    description: "Search imported and indexed Engram knowledge base chunks",
    parameters: Type.Object({
      query: Type.String(),
      maxResults: Type.Optional(Type.Number({ minimum: 1, maximum: 20 })),
      collections: Type.Optional(Type.Array(Type.String())),
      collection: Type.Optional(Type.String()),
      minScore: Type.Optional(Type.Number({ minimum: 0 })),
    }),
    async execute(_toolCallId, input) {
      const query = String(input.query ?? "").trim();
      const maxResults = typeof input.maxResults === "number" ? input.maxResults : 5;
      const collections = Array.isArray(input.collections)
        ? input.collections.filter((value: unknown): value is string => typeof value === "string" && value.trim().length > 0)
        : [];
      const collection = typeof input.collection === "string" ? input.collection : undefined;
      const minScore = typeof input.minScore === "number" ? input.minScore : 0;
      const requestedCollections = collections.length > 0 ? collections : collection ? [collection] : [];
      const results = (await searchKnowledgeBase(config, query, {
        limit: requestedCollections.length > 0 ? Math.max(maxResults * 3, maxResults) : maxResults,
      }))
        .filter((result) => requestedCollections.length === 0 || requestedCollections.includes(result.collectionName))
        .filter((result) => result.score >= minScore)
        .slice(0, maxResults);
      const factResults = searchApprovedFacts(config, query, maxResults)
        .filter((fact) => fact.score >= minScore);
      return {
        content: [
          {
            type: "text",
            text:
              results.length === 0 && factResults.length === 0
                ? `No KB results for: ${query}`
                : [
                    ...factResults.map(
                      (fact) =>
                        `[fact:${fact.memoryClass}] ${fact.factId} (score ${fact.score})\n${truncate(fact.content, 200)}`,
                    ),
                    ...results.map(
                      (result) =>
                        `[${result.collectionName}] ${result.relPath} (source_kind ${result.sourceKind}, score ${result.score})\n${truncate(result.content, 200)}`,
                    ),
                  ].join("\n\n"),
          },
        ],
        details: { query, collections: requestedCollections, minScore, factResults, results },
      };
    },
  };
}

export function createEngramGetTool(config: EngramConfig): AnyAgentTool {
  return {
    name: "engram_get",
    label: "Engram Get",
    description: "Fetch the full content of an Engram KB document by doc id, chunk id, or relative path",
    parameters: Type.Object({
      id: Type.String(),
    }),
    async execute(_toolCallId, input) {
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
    },
  };
}

export function createEngramExportTool(config: EngramConfig): AnyAgentTool {
  return {
    name: "engram_export",
    label: "Engram Export",
    description: "Export persona and stored facts to markdown",
    parameters: Type.Object({
      path: Type.Optional(Type.String()),
    }),
    async execute(_toolCallId, input) {
      const result = exportMemories(
        config,
        typeof input.path === "string" ? input.path : undefined,
      );
      return {
        content: [{ type: "text", text: `Exported Engram memories to ${result.path}.` }],
        details: result,
      };
    },
  };
}

export function createEngramPersonaTool(config: EngramConfig): AnyAgentTool {
  return {
    name: "engram_persona",
    label: "Engram Persona",
    description: "Read or explicitly set the Engram persona file",
    parameters: Type.Object({
      action: Type.Union([Type.Literal("get"), Type.Literal("set")]),
      content: Type.Optional(Type.String()),
    }),
    async execute(_toolCallId, input) {
      if (input.action === "set") {
        const content = writePersona(config, String(input.content ?? ""));
        return {
          content: [{ type: "text", text: content ? "Updated persona file." : "Cleared persona file." }],
          details: { path: config.personaPath, content },
        };
      }
      const content = readPersona(config);
      return {
        content: [{ type: "text", text: content || "No persona set." }],
        details: { path: config.personaPath, content },
      };
    },
  };
}

export function createEngramReviewTool(config: EngramConfig): AnyAgentTool {
  return {
    name: "engram_review",
    label: "Engram Review",
    description: "Approve or reject a pending Engram fact",
    parameters: Type.Object({
      action: Type.Union([Type.Literal("approve"), Type.Literal("reject")]),
      factId: Type.String(),
    }),
    async execute(_toolCallId, input) {
      const factId = String(input.factId ?? "").trim();
      const fact = input.action === "approve" ? approveFact(config, factId) : rejectFact(config, factId);
      if (input.action === "approve" && fact?.memoryClass === "identity" && fact.approvalState === "approved") {
        mergePendingFacts(config, [factId]);
      }
      return {
        content: [{ type: "text", text: fact ? `${input.action}d fact ${factId}.` : `Fact not found: ${factId}` }],
        details: { fact },
      };
    },
  };
}

function truncate(value: string, limit: number): string {
  const collapsed = value.replace(/\s+/g, " ").trim();
  return collapsed.length <= limit ? collapsed : `${collapsed.slice(0, limit - 3)}...`;
}
