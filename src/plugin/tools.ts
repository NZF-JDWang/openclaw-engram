import { Type } from "@sinclair/typebox";
import type { AnyAgentTool } from "openclaw/plugin-sdk";
import type { EngramConfig } from "../config.js";
import { indexPath } from "../kb/indexer.js";
import { getKnowledgeDocument, searchKnowledgeBase } from "../kb/store.js";
import { exportMemories } from "./export.js";
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
      try {
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
        return {
          content: [
            {
              type: "text",
              text:
                results.length === 0
                  ? `No KB results for: ${query}`
                  : results
                      .map(
                        (result) =>
                          `[${result.collectionName}] ${result.relPath} (source_kind ${result.sourceKind}, score ${result.score})\n${truncate(result.content, 200)}`,
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
  return {
    name: "engram_get",
    label: "Engram Get",
    description: "Fetch the full content of an Engram KB document by doc id, chunk id, or relative path",
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

function truncate(value: string, limit: number): string {
  const collapsed = value.replace(/\s+/g, " ").trim();
  return collapsed.length <= limit ? collapsed : `${collapsed.slice(0, limit - 3)}...`;
}
