import { homedir } from "node:os";
import { join } from "node:path";
import { Type } from "@sinclair/typebox";
import { applyConfigCompatibility } from "./migrate/config-compat.js";

export const EngramKbCollectionSchema = Type.Object({
  name: Type.String({ minLength: 1 }),
  path: Type.String({ minLength: 1 }),
  pattern: Type.String({ minLength: 1 }),
  description: Type.Optional(Type.String()),
  indexMode: Type.Optional(Type.Union([Type.Literal("full"), Type.Literal("pointer") ])),
  recallWeight: Type.Optional(Type.Number({ minimum: 0 })),
});

export const EngramConfigSchema = Type.Object({
  enabled: Type.Optional(Type.Boolean()),
  dbPath: Type.Optional(Type.String()),
  exportPath: Type.Optional(Type.String()),
  summarizationProvider: Type.Optional(Type.String()),
  summarizationModel: Type.Optional(Type.String()),
  kbEnabled: Type.Optional(Type.Boolean()),
  kbCollections: Type.Optional(Type.Array(EngramKbCollectionSchema)),
  openclawMemoryCompat: Type.Optional(Type.Boolean()),
  openclawMemoryWorkspacePath: Type.Optional(Type.String()),
  openclawCanonicalMemory: Type.Optional(Type.Boolean()),
  kbAutoIndexSessions: Type.Optional(Type.Boolean()),
  kbSessionIndexCircuitBreaker: Type.Optional(Type.Boolean()),
  kbAutoIndexOnStart: Type.Optional(Type.Boolean()),
  recallEnabled: Type.Optional(Type.Boolean()),
  embedEnabled: Type.Optional(Type.Boolean()),
  embedApiUrl: Type.Optional(Type.String()),
  embedApiModel: Type.Optional(Type.String()),
  embedApiKey: Type.Optional(Type.String()),
  embedBatchSize: Type.Optional(Type.Integer({ minimum: 1 })),
  contextThreshold: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
  freshTailCount: Type.Optional(Type.Integer({ minimum: 1 })),
  leafChunkTokens: Type.Optional(Type.Integer({ minimum: 1000 })),
  leafTargetTokens: Type.Optional(Type.Integer({ minimum: 100 })),
  condensedTargetTokens: Type.Optional(Type.Integer({ minimum: 100 })),
  incrementalMaxDepth: Type.Optional(Type.Integer({ minimum: -1 })),
  compactionMaxDepth: Type.Optional(Type.Integer({ minimum: -1 })),
  newSessionRetainDepth: Type.Optional(Type.Integer({ minimum: -1 })),
  maxMessageContentBytes: Type.Optional(Type.Integer({ minimum: 256 })),
  pruneSummarizedMessages: Type.Optional(Type.Boolean()),
  pruneMinAgeDays: Type.Optional(Type.Integer({ minimum: 0 })),
  dbSizeWarningMb: Type.Optional(Type.Integer({ minimum: 1 })),
  summaryQualityThreshold: Type.Optional(Type.Integer({ minimum: 1 })),
  kbSearchTimeoutMs: Type.Optional(Type.Integer({ minimum: 1 })),
  maxSearchCandidates: Type.Optional(Type.Integer({ minimum: 1 })),
  recallMaxTokens: Type.Optional(Type.Integer({ minimum: 1 })),
  recallMaxSnippetChars: Type.Optional(Type.Integer({ minimum: 40 })),
  recallMaxResults: Type.Optional(Type.Integer({ minimum: 1 })),
  recallPrependMaxTokens: Type.Optional(Type.Integer({ minimum: 1 })),
  activeRecallEnabled: Type.Optional(Type.Boolean()),
  activeRecallMinQueryChars: Type.Optional(Type.Integer({ minimum: 1 })),
  activeRecallMaxSummaryChars: Type.Optional(Type.Integer({ minimum: 40 })),
  recallShadowMode: Type.Optional(Type.Boolean()),
  recallShadowLogFile: Type.Optional(Type.String()),
  recallKeywordBypassMinLength: Type.Optional(Type.Integer({ minimum: 1 })),
  recallKeywordBypassMaxTerms: Type.Optional(Type.Integer({ minimum: 1 })),
  recallRrfK: Type.Optional(Type.Integer({ minimum: 1 })),
  recallMinScore: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
  recallGapThreshold: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
  recallHighConfidenceScore: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
  kbIncrementalSync: Type.Optional(Type.Boolean()),
  recallSessionMaxResults: Type.Optional(Type.Integer({ minimum: 0 })),
  recallSessionMinScore: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
  recallFeedbackEnabled: Type.Optional(Type.Boolean()),
  recallFactsMaxResults: Type.Optional(Type.Integer({ minimum: 0 })),
  recallFactsMinScore: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
});

export type EngramConfig = {
  enabled: boolean;
  dbPath: string;
  exportPath: string;
  summarizationProvider?: string;
  summarizationModel?: string;
  kbEnabled: boolean;
  kbCollections: EngramKbCollection[];
  openclawMemoryCompat: boolean;
  openclawMemoryWorkspacePath: string;
  openclawCanonicalMemory: boolean;
  kbAutoIndexSessions: boolean;
  kbSessionIndexCircuitBreaker: boolean;
  kbAutoIndexOnStart: boolean;
  recallEnabled: boolean;
  embedEnabled: boolean;
  embedApiUrl: string;
  embedApiModel: string;
  embedApiKey?: string;
  embedBatchSize: number;
  contextThreshold: number;
  freshTailCount: number;
  leafChunkTokens: number;
  leafTargetTokens: number;
  condensedTargetTokens: number;
  incrementalMaxDepth: number;
  compactionMaxDepth: number;
  newSessionRetainDepth: number;
  maxMessageContentBytes: number;
  pruneSummarizedMessages: boolean;
  pruneMinAgeDays: number;
  dbSizeWarningMb: number;
  summaryQualityThreshold: number;
  kbSearchTimeoutMs: number;
  maxSearchCandidates: number;
  recallMaxTokens: number;
  recallMaxSnippetChars: number;
  recallMaxResults: number;
  recallPrependMaxTokens: number;
  activeRecallEnabled: boolean;
  activeRecallMinQueryChars: number;
  activeRecallMaxSummaryChars: number;
  recallShadowMode: boolean;
  recallShadowLogFile?: string;
  recallKeywordBypassMinLength: number;
  recallKeywordBypassMaxTerms: number;
  recallRrfK: number;
  recallMinScore: number;
  recallGapThreshold: number;
  recallHighConfidenceScore: number;
  kbIncrementalSync: boolean;
  recallSessionMaxResults: number;
  recallSessionMinScore: number;
  recallFeedbackEnabled: boolean;
  recallFactsMaxResults: number;
  recallFactsMinScore: number;
};

export type EngramKbCollection = {
  name: string;
  path: string;
  pattern: string;
  description?: string;
  indexMode?: "full" | "pointer";
  recallWeight?: number;
};

const DEFAULTS = {
  enabled: true,
  kbEnabled: true,
  openclawMemoryCompat: true,
  openclawCanonicalMemory: true,
  kbAutoIndexSessions: true,
  kbSessionIndexCircuitBreaker: true,
  kbAutoIndexOnStart: false,
  recallEnabled: true,
  embedEnabled: false,
  embedApiUrl: "http://localhost:11434/v1/embeddings",
  embedApiModel: "nomic-embed-text",
  embedBatchSize: 20,
  contextThreshold: 0.8,
  freshTailCount: 8,
  leafChunkTokens: 20_000,
  leafTargetTokens: 2_000,
  condensedTargetTokens: 1_500,
  incrementalMaxDepth: 1,
  compactionMaxDepth: 3,
  newSessionRetainDepth: -1,
  maxMessageContentBytes: 32_768,
  pruneSummarizedMessages: false,
  pruneMinAgeDays: 90,
  dbSizeWarningMb: 2_000,
  summaryQualityThreshold: 50,
  kbSearchTimeoutMs: 150,
  maxSearchCandidates: 50,
  recallMaxTokens: 80,
  recallMaxSnippetChars: 220,
  recallMaxResults: 1,
  recallPrependMaxTokens: 80,
  activeRecallEnabled: true,
  activeRecallMinQueryChars: 12,
  activeRecallMaxSummaryChars: 220,
  recallShadowMode: false,
  recallKeywordBypassMinLength: 4,
  recallKeywordBypassMaxTerms: 3,
  recallRrfK: 15,
  recallMinScore: 0.4,
  recallGapThreshold: 0.08,
  recallHighConfidenceScore: 0.75,
  kbIncrementalSync: true,
  recallSessionMaxResults: 2,
  recallSessionMinScore: 0.55,
  recallFeedbackEnabled: false,
  recallFactsMaxResults: 1,
  recallFactsMinScore: 0.45,
} as const;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function pickBoolean(record: Record<string, unknown>, key: string, fallback: boolean): boolean {
  return typeof record[key] === "boolean" ? (record[key] as boolean) : fallback;
}

function pickNumber(record: Record<string, unknown>, key: string, fallback: number): number {
  return typeof record[key] === "number" && Number.isFinite(record[key])
    ? (record[key] as number)
    : fallback;
}

function pickString(record: Record<string, unknown>, key: string): string | undefined {
  return typeof record[key] === "string" && record[key].trim().length > 0
    ? (record[key] as string)
    : undefined;
}

function pickCollections(record: Record<string, unknown>, key: string): EngramKbCollection[] {
  const value = record[key];
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => asRecord(entry))
    .map((entry) => ({
      name: pickString(entry, "name") || "",
      path: pickString(entry, "path") || "",
      pattern: pickString(entry, "pattern") || "",
      description: pickString(entry, "description"),
      indexMode: pickCollectionIndexMode(entry),
      recallWeight: typeof entry.recallWeight === "number" && Number.isFinite(entry.recallWeight)
        ? Math.max(0, entry.recallWeight)
        : undefined,
    }))
    .filter((entry) => entry.name && entry.path && entry.pattern);
}

function pickCollectionIndexMode(record: Record<string, unknown>): EngramKbCollection["indexMode"] {
  return record.indexMode === "pointer" || record.indexMode === "full"
    ? record.indexMode
    : undefined;
}

export function defaultDbPath(env: NodeJS.ProcessEnv = process.env): string {
  const stateDir = env.OPENCLAW_STATE_DIR?.trim();
  return join(stateDir || join(homedir(), ".openclaw"), "engram.db");
}

export function defaultExportPath(env: NodeJS.ProcessEnv = process.env): string {
  const stateDir = env.OPENCLAW_STATE_DIR?.trim();
  return join(stateDir || join(homedir(), ".openclaw"), "engram-export.md");
}

export function defaultOpenClawMemoryWorkspacePath(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.OPENCLAW_WORKSPACE_DIR?.trim() || env.OPENCLAW_WORKSPACE?.trim();
  if (explicit) {
    return explicit;
  }
  const stateDir = env.OPENCLAW_STATE_DIR?.trim();
  return join(stateDir || join(homedir(), ".openclaw"), "workspace");
}

export function resolveEngramConfig(
  value: unknown,
  env: NodeJS.ProcessEnv = process.env,
): EngramConfig {
  const raw = applyConfigCompatibility(asRecord(value));
  return {
    enabled: pickBoolean(raw, "enabled", DEFAULTS.enabled),
    dbPath: pickString(raw, "dbPath") || defaultDbPath(env),
    exportPath: pickString(raw, "exportPath") || defaultExportPath(env),
    summarizationProvider: pickString(raw, "summarizationProvider"),
    summarizationModel: pickString(raw, "summarizationModel"),
    kbEnabled: pickBoolean(raw, "kbEnabled", DEFAULTS.kbEnabled),
    kbCollections: pickCollections(raw, "kbCollections"),
    openclawMemoryCompat: pickBoolean(raw, "openclawMemoryCompat", DEFAULTS.openclawMemoryCompat),
    openclawMemoryWorkspacePath:
      pickString(raw, "openclawMemoryWorkspacePath") || defaultOpenClawMemoryWorkspacePath(env),
    openclawCanonicalMemory: pickBoolean(
      raw,
      "openclawCanonicalMemory",
      DEFAULTS.openclawCanonicalMemory,
    ),
    kbAutoIndexSessions: pickBoolean(raw, "kbAutoIndexSessions", DEFAULTS.kbAutoIndexSessions),
    kbSessionIndexCircuitBreaker: pickBoolean(
      raw,
      "kbSessionIndexCircuitBreaker",
      DEFAULTS.kbSessionIndexCircuitBreaker,
    ),
    kbAutoIndexOnStart: pickBoolean(raw, "kbAutoIndexOnStart", DEFAULTS.kbAutoIndexOnStart),
    recallEnabled: pickBoolean(raw, "recallEnabled", DEFAULTS.recallEnabled),
    embedEnabled: pickBoolean(raw, "embedEnabled", DEFAULTS.embedEnabled),
    embedApiUrl: pickString(raw, "embedApiUrl") || DEFAULTS.embedApiUrl,
    embedApiModel: pickString(raw, "embedApiModel") || DEFAULTS.embedApiModel,
    embedApiKey: pickString(raw, "embedApiKey"),
    embedBatchSize: pickNumber(raw, "embedBatchSize", DEFAULTS.embedBatchSize),
    contextThreshold: pickNumber(raw, "contextThreshold", DEFAULTS.contextThreshold),
    freshTailCount: pickNumber(raw, "freshTailCount", DEFAULTS.freshTailCount),
    leafChunkTokens: pickNumber(raw, "leafChunkTokens", DEFAULTS.leafChunkTokens),
    leafTargetTokens: pickNumber(raw, "leafTargetTokens", DEFAULTS.leafTargetTokens),
    condensedTargetTokens: pickNumber(
      raw,
      "condensedTargetTokens",
      DEFAULTS.condensedTargetTokens,
    ),
    incrementalMaxDepth: pickNumber(
      raw,
      "incrementalMaxDepth",
      DEFAULTS.incrementalMaxDepth,
    ),
    compactionMaxDepth: pickNumber(raw, "compactionMaxDepth", DEFAULTS.compactionMaxDepth),
    newSessionRetainDepth: pickNumber(
      raw,
      "newSessionRetainDepth",
      DEFAULTS.newSessionRetainDepth,
    ),
    maxMessageContentBytes: pickNumber(
      raw,
      "maxMessageContentBytes",
      DEFAULTS.maxMessageContentBytes,
    ),
    pruneSummarizedMessages: pickBoolean(
      raw,
      "pruneSummarizedMessages",
      DEFAULTS.pruneSummarizedMessages,
    ),
    pruneMinAgeDays: pickNumber(raw, "pruneMinAgeDays", DEFAULTS.pruneMinAgeDays),
    dbSizeWarningMb: pickNumber(raw, "dbSizeWarningMb", DEFAULTS.dbSizeWarningMb),
    summaryQualityThreshold: pickNumber(
      raw,
      "summaryQualityThreshold",
      DEFAULTS.summaryQualityThreshold,
    ),
    kbSearchTimeoutMs: pickNumber(raw, "kbSearchTimeoutMs", DEFAULTS.kbSearchTimeoutMs),
    maxSearchCandidates: pickNumber(raw, "maxSearchCandidates", DEFAULTS.maxSearchCandidates),
    recallMaxTokens: pickNumber(raw, "recallMaxTokens", DEFAULTS.recallMaxTokens),
    recallMaxSnippetChars: pickNumber(raw, "recallMaxSnippetChars", DEFAULTS.recallMaxSnippetChars),
    recallMaxResults: pickNumber(raw, "recallMaxResults", DEFAULTS.recallMaxResults),
    recallPrependMaxTokens: pickNumber(
      raw,
      "recallPrependMaxTokens",
      DEFAULTS.recallPrependMaxTokens,
    ),
    activeRecallEnabled: pickBoolean(raw, "activeRecallEnabled", DEFAULTS.activeRecallEnabled),
    activeRecallMinQueryChars: pickNumber(
      raw,
      "activeRecallMinQueryChars",
      DEFAULTS.activeRecallMinQueryChars,
    ),
    activeRecallMaxSummaryChars: pickNumber(
      raw,
      "activeRecallMaxSummaryChars",
      DEFAULTS.activeRecallMaxSummaryChars,
    ),
    recallShadowMode: pickBoolean(raw, "recallShadowMode", DEFAULTS.recallShadowMode),
    recallShadowLogFile: pickString(raw, "recallShadowLogFile"),
    recallKeywordBypassMinLength: pickNumber(
      raw,
      "recallKeywordBypassMinLength",
      DEFAULTS.recallKeywordBypassMinLength,
    ),
    recallKeywordBypassMaxTerms: pickNumber(
      raw,
      "recallKeywordBypassMaxTerms",
      DEFAULTS.recallKeywordBypassMaxTerms,
    ),
    recallRrfK: pickNumber(raw, "recallRrfK", DEFAULTS.recallRrfK),
    recallMinScore: pickNumber(raw, "recallMinScore", DEFAULTS.recallMinScore),
    recallGapThreshold: pickNumber(raw, "recallGapThreshold", DEFAULTS.recallGapThreshold),
    recallHighConfidenceScore: pickNumber(
      raw,
      "recallHighConfidenceScore",
      DEFAULTS.recallHighConfidenceScore,
    ),
    kbIncrementalSync: pickBoolean(raw, "kbIncrementalSync", DEFAULTS.kbIncrementalSync),
    recallSessionMaxResults: pickNumber(raw, "recallSessionMaxResults", DEFAULTS.recallSessionMaxResults),
    recallSessionMinScore: pickNumber(raw, "recallSessionMinScore", DEFAULTS.recallSessionMinScore),
    recallFeedbackEnabled: pickBoolean(raw, "recallFeedbackEnabled", DEFAULTS.recallFeedbackEnabled),
    recallFactsMaxResults: pickNumber(raw, "recallFactsMaxResults", DEFAULTS.recallFactsMaxResults),
    recallFactsMinScore: pickNumber(raw, "recallFactsMinScore", DEFAULTS.recallFactsMinScore),
  };
}
