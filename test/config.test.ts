import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { defaultDbPath, defaultExportPath, resolveEngramConfig } from "../src/config.js";

describe("resolveEngramConfig", () => {
  it("uses OPENCLAW_STATE_DIR for the default DB path", () => {
    const config = resolveEngramConfig({}, { OPENCLAW_STATE_DIR: "/tmp/openclaw" } as NodeJS.ProcessEnv);
    expect(config.dbPath).toBe(join("/tmp/openclaw", "engram.db"));
  });

  it("preserves explicit config values", () => {
    const config = resolveEngramConfig({
      recallEnabled: false,
      freshTailCount: 4,
      recallMaxResults: 5,
      recallMinScore: 0.6,
      recallGapThreshold: 0.2,
      recallHighConfidenceScore: 0.9,
    });
    expect(config.recallEnabled).toBe(false);
    expect(config.freshTailCount).toBe(4);
    expect(config.recallMaxResults).toBe(5);
    expect(config.recallMinScore).toBe(0.6);
    expect(config.recallGapThreshold).toBe(0.2);
    expect(config.recallHighConfidenceScore).toBe(0.9);
    expect(config.embedApiUrl).toBe("http://localhost:11434/v1/embeddings");
    expect(config.embedApiModel).toBe("nomic-embed-text");
  });

  it("computes a fallback home-directory path", () => {
    expect(defaultDbPath({} as NodeJS.ProcessEnv)).toContain("engram.db");
  });

  it("derives default export path from the state dir", () => {
    const env = { OPENCLAW_STATE_DIR: "/tmp/openclaw" } as NodeJS.ProcessEnv;
    expect(defaultExportPath(env)).toBe(join("/tmp/openclaw", "engram-export.md"));
  });

  it("accepts explicit embedding client settings", () => {
    const config = resolveEngramConfig({
      embedEnabled: true,
      embedApiUrl: "http://localhost:9999/v1/embeddings",
      embedApiModel: "test-embed-model",
      embedApiKey: "token",
      embedBatchSize: 8,
    });

    expect(config.embedEnabled).toBe(true);
    expect(config.embedApiUrl).toBe("http://localhost:9999/v1/embeddings");
    expect(config.embedApiModel).toBe("test-embed-model");
    expect(config.embedApiKey).toBe("token");
    expect(config.embedBatchSize).toBe(8);
  });

  it("supports configured KB collections and startup indexing flags", () => {
    const config = resolveEngramConfig({
      autoDetectVaults: true,
      kbCollections: [
        {
          name: "docs",
          path: "/tmp/docs",
          pattern: "**/*.md",
          description: "Project docs",
        },
      ],
      kbAutoIndexOnStart: true,
      kbAutoIndexSessions: false,
      kbSessionIndexCircuitBreaker: false,
      maxSearchCandidates: 12,
      newSessionRetainDepth: 2,
      recallKeywordBypassMinLength: 5,
      recallKeywordBypassMaxTerms: 2,
      recallRrfK: 9,
    });

    expect(config.kbCollections).toHaveLength(1);
    expect(config.kbCollections[0]?.name).toBe("docs");
    expect(config.autoDetectVaults).toBe(true);
    expect(config.kbAutoIndexOnStart).toBe(true);
    expect(config.kbAutoIndexSessions).toBe(false);
    expect(config.kbSessionIndexCircuitBreaker).toBe(false);
    expect(config.maxSearchCandidates).toBe(12);
    expect(config.newSessionRetainDepth).toBe(2);
    expect(config.recallKeywordBypassMinLength).toBe(5);
    expect(config.recallKeywordBypassMaxTerms).toBe(2);
    expect(config.recallRrfK).toBe(9);
  });

  it("maps legacy config aliases onto engram keys", () => {
    const config = resolveEngramConfig({
      collections: [{ name: "notes", path: "/tmp/notes", pattern: "**/*.txt" }],
      autoIndexOnStart: true,
      indexSessions: false,
      sessionIndexCircuitBreaker: false,
      searchTimeoutMs: 250,
      searchCandidates: 9,
      embeddingEnabled: true,
      embeddingApiUrl: "http://localhost:1234/v1/embeddings",
      embeddingModel: "legacy-embed",
      embeddingApiKey: "secret",
      embeddingBatchSize: 4,
      summaryProvider: "provider-a",
      summaryModel: "model-a",
    }, { NODE_ENV: "test" } as NodeJS.ProcessEnv);

    expect(config.kbCollections[0]?.name).toBe("notes");
    expect(config.kbAutoIndexOnStart).toBe(true);
    expect(config.kbAutoIndexSessions).toBe(false);
    expect(config.kbSessionIndexCircuitBreaker).toBe(false);
    expect(config.kbSearchTimeoutMs).toBe(250);
    expect(config.maxSearchCandidates).toBe(9);
    expect(config.embedEnabled).toBe(true);
    expect(config.embedApiUrl).toBe("http://localhost:1234/v1/embeddings");
    expect(config.embedApiModel).toBe("legacy-embed");
    expect(config.embedApiKey).toBe("secret");
    expect(config.embedBatchSize).toBe(4);
    expect(config.summarizationProvider).toBe("provider-a");
    expect(config.summarizationModel).toBe("model-a");
    expect(config.autoDetectVaults).toBe(false);
  });
});
