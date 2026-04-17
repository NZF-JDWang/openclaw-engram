const LEGACY_KEY_MAPPINGS = [
  ["personaFile", "personaPath"],
  ["summaryProvider", "summarizationProvider"],
  ["summaryModel", "summarizationModel"],
  ["collections", "kbCollections"],
  ["autoIndexOnStart", "kbAutoIndexOnStart"],
  ["indexSessions", "kbAutoIndexSessions"],
  ["sessionIndexCircuitBreaker", "kbSessionIndexCircuitBreaker"],
  ["searchTimeoutMs", "kbSearchTimeoutMs"],
  ["searchCandidates", "maxSearchCandidates"],
  ["embeddingEnabled", "embedEnabled"],
  ["embeddingApiUrl", "embedApiUrl"],
  ["embeddingModel", "embedApiModel"],
  ["embeddingApiKey", "embedApiKey"],
  ["embeddingBatchSize", "embedBatchSize"],
] as const;

export function applyConfigCompatibility(raw: Record<string, unknown>): Record<string, unknown> {
  const next = { ...raw };
  for (const [legacyKey, nextKey] of LEGACY_KEY_MAPPINGS) {
    if (next[nextKey] !== undefined || next[legacyKey] === undefined) {
      continue;
    }
    next[nextKey] = next[legacyKey];
    warnDeprecatedKey(legacyKey, nextKey);
  }
  return next;
}

function warnDeprecatedKey(legacyKey: string, nextKey: string): void {
  if (process.env.NODE_ENV === "test") {
    return;
  }
  console.warn(`[engram] Config key '${legacyKey}' is deprecated. Use '${nextKey}' instead.`);
}