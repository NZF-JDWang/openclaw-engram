import { existsSync } from "node:fs";
import type { EngramConfig } from "../config.js";
import {
  getKnowledgeDocument,
  getKnowledgeDocumentByLocation,
  searchKnowledgeBase,
} from "../kb/store.js";
import { readStatus } from "./status.js";
import type {
  MemoryPluginRuntime,
  OpenClawConfig,
} from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import type {
  MemoryEmbeddingProbeResult,
  MemoryProviderStatus,
  MemoryReadResult,
  MemorySearchManager,
  MemorySearchResult,
  MemorySearchRuntimeDebug,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";

const DEFAULT_READ_LINES = 80;

export function createEngramMemoryRuntime(config: EngramConfig): MemoryPluginRuntime {
  return {
    async getMemorySearchManager(_params: {
      cfg: OpenClawConfig;
      agentId: string;
      purpose?: "default" | "status";
    }) {
      if (!shouldEnableMemoryRuntime(config)) {
        return { manager: null };
      }
      return {
        manager: createEngramMemorySearchManager(config),
      };
    },
    resolveMemoryBackendConfig() {
      return shouldEnableMemoryRuntime(config)
        ? { backend: "qmd" as const }
        : { backend: "builtin" as const };
    },
    async closeAllMemorySearchManagers() {
      return;
    },
  };
}

export function createEngramMemorySearchManager(config: EngramConfig): MemorySearchManager {
  return new EngramMemorySearchManager(config);
}

class EngramMemorySearchManager implements MemorySearchManager {
  constructor(private readonly config: EngramConfig) {}

  async search(
    query: string,
    opts?: {
      maxResults?: number;
      minScore?: number;
      sessionKey?: string;
      qmdSearchModeOverride?: "query" | "search" | "vsearch";
      onDebug?: (debug: MemorySearchRuntimeDebug) => void;
    },
  ): Promise<MemorySearchResult[]> {
    opts?.onDebug?.({
      backend: "qmd",
      configuredMode: "engram",
      effectiveMode: "engram",
    });

    const rows = await searchKnowledgeBase(this.config, query, {
      limit: opts?.maxResults ?? 10,
    });

    return rows
      .map((row) => toMemorySearchResult(this.config, row.collectionName, row.relPath, row.content, row.score))
      .filter((result): result is MemorySearchResult => result != null)
      .filter((result) => (opts?.minScore == null ? true : result.score >= opts.minScore));
  }

  async readFile(params: {
    relPath: string;
    from?: number;
    lines?: number;
  }): Promise<MemoryReadResult> {
    const location = parseMemoryPath(params.relPath);
    const document =
      location == null
        ? getKnowledgeDocument(this.config, params.relPath)
        : getKnowledgeDocumentByLocation(this.config, location.collectionName, location.relPath);

    if (!document) {
      throw new Error(`Engram memory path not found: ${params.relPath}`);
    }

    const allLines = splitLines(document.content);
    const from = Math.max(1, params.from ?? 1);
    const lines = Math.max(1, params.lines ?? DEFAULT_READ_LINES);
    const startIndex = Math.max(0, from - 1);
    const selected = allLines.slice(startIndex, startIndex + lines);

    return {
      text: selected.join("\n"),
      path: buildMemoryPath(document.collectionName, document.relPath),
      from,
      lines: selected.length,
      ...(startIndex + selected.length < allLines.length
        ? { nextFrom: startIndex + selected.length + 1, truncated: true }
        : {}),
    };
  }

  status(): MemoryProviderStatus {
    const snapshot = readStatus(this.config);
    const hasSessions = snapshot.kbDocuments > 0;
    return {
      backend: "qmd",
      provider: "engram",
      model: this.config.embedEnabled ? this.config.embedApiModel : undefined,
      dbPath: snapshot.dbPath,
      files: snapshot.kbDocuments,
      chunks: snapshot.kbChunks,
      sources: hasSessions ? ["memory", "sessions"] : ["memory"],
      sourceCounts: [
        {
          source: "memory",
          files: snapshot.kbDocuments,
          chunks: snapshot.kbChunks,
        },
      ],
      fts: {
        enabled: true,
        available: snapshot.kbChunks > 0,
      },
      vector: {
        enabled: this.config.embedEnabled,
        available: this.config.embedEnabled && snapshot.kbEmbeddings > 0,
      },
      custom: {
        engine: "engram",
        kbEnabled: this.config.kbEnabled,
        facts: snapshot.facts,
        pendingFacts: snapshot.pendingFacts,
      },
    };
  }

  async probeEmbeddingAvailability(): Promise<MemoryEmbeddingProbeResult> {
    if (!this.config.embedEnabled) {
      return {
        ok: false,
        error: "Embeddings are disabled in Engram config.",
      };
    }

    return {
      ok: true,
    };
  }

  async probeVectorAvailability(): Promise<boolean> {
    if (!this.config.embedEnabled) {
      return false;
    }
    return readStatus(this.config).kbEmbeddings > 0;
  }

  async close(): Promise<void> {
    return;
  }
}

function shouldEnableMemoryRuntime(config: EngramConfig): boolean {
  return config.enabled && config.kbEnabled && existsSync(config.dbPath);
}

function toMemorySearchResult(
  config: EngramConfig,
  collectionName: string,
  relPath: string,
  snippet: string,
  score: number,
): MemorySearchResult | null {
  const document = getKnowledgeDocumentByLocation(config, collectionName, relPath);
  if (!document) {
    return null;
  }

  const lineRange = resolveLineRange(document.content, snippet);
  return {
    path: buildMemoryPath(collectionName, relPath),
    startLine: lineRange.startLine,
    endLine: lineRange.endLine,
    score,
    snippet,
    source: collectionName === "__sessions" ? "sessions" : "memory",
    citation: `${collectionName}/${relPath}`,
  };
}

function buildMemoryPath(collectionName: string, relPath: string): string {
  return `${collectionName}:${relPath}`;
}

function parseMemoryPath(path: string): { collectionName: string; relPath: string } | null {
  const separatorIndex = path.indexOf(":");
  if (separatorIndex <= 0 || separatorIndex === path.length - 1) {
    return null;
  }
  return {
    collectionName: path.slice(0, separatorIndex),
    relPath: path.slice(separatorIndex + 1),
  };
}

function resolveLineRange(content: string, snippet: string): { startLine: number; endLine: number } {
  const snippetIndex = content.indexOf(snippet);
  if (snippetIndex === -1) {
    const totalLines = splitLines(content).length;
    return {
      startLine: 1,
      endLine: Math.max(1, totalLines),
    };
  }

  const prefix = content.slice(0, snippetIndex);
  const snippetLines = splitLines(snippet);
  const startLine = countLines(prefix) + 1;
  return {
    startLine,
    endLine: startLine + Math.max(0, snippetLines.length - 1),
  };
}

function splitLines(value: string): string[] {
  return value.split(/\r?\n/);
}

function countLines(value: string): number {
  if (!value) {
    return 0;
  }
  return value.split(/\r?\n/).length - 1;
}
