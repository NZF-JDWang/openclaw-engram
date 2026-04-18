import { homedir } from "node:os";
import { join } from "node:path";
import { Type } from "@sinclair/typebox";
import { applyConfigCompatibility } from "./migrate/config-compat.js";

export const EngramKbCollectionSchema = Type.Object({
  name: Type.String({ minLength: 1 }),
  path: Type.String({ minLength: 1 }),
  pattern: Type.String({ minLength: 1 }),
  description: Type.Optional(Type.String()),
});

export const EngramConfigSchema = Type.Object({
  enabled: Type.Optional(Type.Boolean()),
  dbPath: Type.Optional(Type.String()),
  exportPath: Type.Optional(Type.String()),
  summarizationProvider: Type.Optional(Type.String()),
  summarizationModel: Type.Optional(Type.String()),
  kbEnabled: Type.Optional(Type.Boolean()),
  kbCollections: Type.Optional(Type.Array(EngramKbCollectionSchema)),
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
  recallMaxResults: Type.Optional(Type.Integer({ minimum: 1 })),
  recallPrependMaxTokens: Type.Optional(Type.Integer({ minimum: 1 })),
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
});

export type EngramConfig = {
  enabled: boolean;
  dbPath: string;
  exportPath: string;
  summarizationProvider?: string;
  summarizationModel?: string;
  kbEnabled: boolean;
  kbCollections: EngramKbCollection[];
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
  recallMaxResults: number;
  recallPrependMaxTokens: number;
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
};

export type EngramKbCollection = {
  name: string;
  path: string;
  pattern: string;
  description?: string;
};

const DEFAULTS = {
  enabled: true,
  kbEnabled: true,
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
  recallMaxTokens: 300,
  recallMaxResults: 3,
  recallPrependMaxTokens: 300,
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
    }))
    .filter((entry) => entry.name && entry.path && entry.pattern);
}

export function defaultDbPath(env: NodeJS.ProcessEnv = process.env): string {
  const stateDir = env.OPENCLAW_STATE_DIR?.trim();
  return join(stateDir || join(homedir(), ".openclaw"), "engram.db");
}

export function defaultExportPath(env: NodeJS.ProcessEnv = process.env): string {
  const stateDir = env.OPENCLAW_STATE_DIR?.trim();
  return join(stateDir || join(homedir(), ".openclaw"), "engram-export.md");
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
    recallMaxResults: pickNumber(raw, "recallMaxResults", DEFAULTS.recallMaxResults),
    recallPrependMaxTokens: pickNumber(
      raw,
      "recallPrependMaxTokens",
      DEFAULTS.recallPrependMaxTokens,
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
  };
}
