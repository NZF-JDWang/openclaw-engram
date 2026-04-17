import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type { EngramConfig } from "../config.js";

export type MemoryClass = "identity" | "project" | "task" | "reference";
export type SourceKind = "user_stated" | "agent_inferred" | "document_derived" | "decision";
export type MemoryScope = "global" | "agent" | "session";

export type StoredFact = {
  factId: string;
  content: string;
  memoryClass: MemoryClass;
  sourceKind: SourceKind;
  sourceBasis: SourceKind;
  scope: MemoryScope;
  lifecycleState: string;
  approvalState: string;
  supersededBy?: string | null;
  deprecatedAt?: string | null;
  deprecatedReason?: string | null;
  expiresAt?: string | null;
  createdAt: string;
  updatedAt?: string;
};

export type FactSearchResult = StoredFact & {
  score: number;
};

export type FactConflict = {
  conflictId: string;
  factId: string;
  conflictingFactId: string;
  similarityScore: number;
  resolutionState: string;
  createdAt: string;
  factContent: string;
  conflictingContent: string;
};

export function rememberFact(
  config: EngramConfig,
  input: {
    content: string;
    memoryClass: MemoryClass;
    sourceKind?: SourceKind;
    sourceBasis?: SourceKind;
    scope?: MemoryScope;
    expiry?: string;
  },
): StoredFact {
  const db = new DatabaseSync(config.dbPath);
  try {
    const now = new Date().toISOString();
    const factId = randomUUID();
    const sourceBasis = input.sourceBasis ?? input.sourceKind ?? "user_stated";
    const sourceKind = sourceBasis;
    const scope = input.scope ?? "session";
    const approvalState =
      input.memoryClass === "identity" || sourceBasis === "agent_inferred" || sourceBasis === "document_derived"
        ? "pending"
        : "approved";
    const lifecycleState = resolveLifecycleState(input.memoryClass, sourceBasis, approvalState);
    const expiresAt = resolveExpiryTimestamp(now, input.expiry);

    db.prepare(`
      INSERT INTO kb_facts (
        fact_id,
        content,
        memory_class,
        source_kind,
        source_basis,
        scope,
        lifecycle_state,
        approval_state,
        expires_at,
        created_at,
        updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      factId,
      input.content,
      input.memoryClass,
      sourceKind,
      sourceBasis,
      scope,
      lifecycleState,
      approvalState,
      expiresAt,
      now,
      now,
    );
    flagPotentialConflicts(db, {
      factId,
      content: input.content,
      memoryClass: input.memoryClass,
      createdAt: now,
    });

    return {
      factId,
      content: input.content,
      memoryClass: input.memoryClass,
      sourceKind,
      sourceBasis,
      scope,
      lifecycleState,
      approvalState,
      expiresAt,
      createdAt: now,
    };
  } finally {
    db.close();
  }
}

export function listPendingFacts(config: EngramConfig): StoredFact[] {
  if (!existsSync(config.dbPath)) {
    return [];
  }
  const db = new DatabaseSync(config.dbPath, { open: true, readOnly: true });
  try {
    return db.prepare(`
      SELECT
        fact_id AS factId,
        content,
        memory_class AS memoryClass,
        source_kind AS sourceKind,
        COALESCE(source_basis, source_kind) AS sourceBasis,
        scope,
        lifecycle_state AS lifecycleState,
        approval_state AS approvalState,
        superseded_by AS supersededBy,
        deprecated_at AS deprecatedAt,
        deprecated_reason AS deprecatedReason,
        expires_at AS expiresAt,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM kb_facts
      WHERE approval_state = 'pending'
      ORDER BY created_at DESC
    `).all() as StoredFact[];
  } finally {
    db.close();
  }
}

export function listFacts(config: EngramConfig): StoredFact[] {
  if (!existsSync(config.dbPath)) {
    return [];
  }
  const db = new DatabaseSync(config.dbPath, { open: true, readOnly: true });
  try {
    return db.prepare(`
      SELECT
        fact_id AS factId,
        content,
        memory_class AS memoryClass,
        source_kind AS sourceKind,
        COALESCE(source_basis, source_kind) AS sourceBasis,
        scope,
        lifecycle_state AS lifecycleState,
        approval_state AS approvalState,
        superseded_by AS supersededBy,
        deprecated_at AS deprecatedAt,
        deprecated_reason AS deprecatedReason,
        expires_at AS expiresAt,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM kb_facts
      ORDER BY created_at DESC
    `).all() as StoredFact[];
  } finally {
    db.close();
  }
}

export function searchApprovedFacts(
  config: EngramConfig,
  query: string,
  limit: number = 3,
): FactSearchResult[] {
  if (!existsSync(config.dbPath)) {
    return [];
  }
  const tokens = tokenize(query);
  if (tokens.length === 0) {
    return [];
  }
  const db = new DatabaseSync(config.dbPath, { open: true, readOnly: true });
  try {
    const rows = db.prepare(`
      SELECT
        fact_id AS factId,
        content,
        memory_class AS memoryClass,
        source_kind AS sourceKind,
        COALESCE(source_basis, source_kind) AS sourceBasis,
        scope,
        lifecycle_state AS lifecycleState,
        approval_state AS approvalState,
        superseded_by AS supersededBy,
        deprecated_at AS deprecatedAt,
        deprecated_reason AS deprecatedReason,
        expires_at AS expiresAt,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM kb_facts
      WHERE approval_state = 'approved'
        AND lifecycle_state NOT IN ('deprecated', 'expired', 'superseded')
        AND deprecated_at IS NULL
        AND (expires_at IS NULL OR julianday(expires_at) > julianday('now'))
    `).all() as StoredFact[];

    return rows
      .map((row) => ({
        ...row,
        score: computeFactScore(row, query, tokens, config),
      }))
      .filter((row) => row.score > 0)
      .sort((left, right) => right.score - left.score || left.createdAt.localeCompare(right.createdAt))
      .slice(0, limit);
  } finally {
    db.close();
  }
}

export function listOpenConflicts(config: EngramConfig): FactConflict[] {
  if (!existsSync(config.dbPath)) {
    return [];
  }
  const db = new DatabaseSync(config.dbPath, { open: true, readOnly: true });
  try {
    return db.prepare(`
      SELECT
        c.conflict_id AS conflictId,
        c.fact_id AS factId,
        c.conflicting_fact_id AS conflictingFactId,
        c.similarity_score AS similarityScore,
        c.resolution_state AS resolutionState,
        c.created_at AS createdAt,
        left_fact.content AS factContent,
        right_fact.content AS conflictingContent
      FROM kb_conflicts c
      JOIN kb_facts left_fact ON left_fact.fact_id = c.fact_id
      JOIN kb_facts right_fact ON right_fact.fact_id = c.conflicting_fact_id
      WHERE c.resolution_state = 'open'
      ORDER BY c.similarity_score DESC, c.created_at DESC
    `).all() as FactConflict[];
  } finally {
    db.close();
  }
}

export function approveFact(config: EngramConfig, factId: string): StoredFact | null {
  return updateFactState(config, factId, (existing) => ({
    approvalState: "approved",
    lifecycleState: existing.memoryClass === "identity" || existing.sourceKind === "decision" ? "durable" : "validated",
    deprecatedAt: null,
    deprecatedReason: null,
  }));
}

export function rejectFact(config: EngramConfig, factId: string): StoredFact | null {
  return updateFactState(config, factId, () => ({
    approvalState: "rejected",
    lifecycleState: "deprecated",
    deprecatedAt: new Date().toISOString(),
    deprecatedReason: "Rejected during review",
  }));
}

export function forgetFact(config: EngramConfig, factId: string, reason?: string): StoredFact | null {
  return updateFactState(config, factId, (existing) => ({
    approvalState: existing.approvalState,
    lifecycleState: "deprecated",
    deprecatedAt: new Date().toISOString(),
    deprecatedReason: reason?.trim() || "Forgotten by explicit request",
  }));
}

export function formatPendingFacts(facts: StoredFact[]): string {
  if (facts.length === 0) {
    return "No pending facts.";
  }
  return [
    "Pending facts",
    "",
    ...facts.map(
      (fact) =>
        `- ${fact.factId} [${fact.memoryClass}] [${fact.sourceKind}] ${fact.content}`,
    ),
  ].join("\n");
}

function updateFactState(
  config: EngramConfig,
  factId: string,
  resolveNext: (existing: StoredFact) => {
    approvalState: string;
    lifecycleState: string;
    deprecatedAt?: string | null;
    deprecatedReason?: string | null;
  },
): StoredFact | null {
  if (!existsSync(config.dbPath)) {
    return null;
  }
  const db = new DatabaseSync(config.dbPath);
  try {
    const existing = db.prepare(`
      SELECT
        fact_id AS factId,
        content,
        memory_class AS memoryClass,
        source_kind AS sourceKind,
        COALESCE(source_basis, source_kind) AS sourceBasis,
        scope,
        lifecycle_state AS lifecycleState,
        approval_state AS approvalState,
        superseded_by AS supersededBy,
        deprecated_at AS deprecatedAt,
        deprecated_reason AS deprecatedReason,
        expires_at AS expiresAt,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM kb_facts
      WHERE fact_id = ?
      LIMIT 1
    `).get(factId) as StoredFact | undefined;

    if (!existing) {
      return null;
    }

    const next = resolveNext(existing);
    const updatedAt = new Date().toISOString();
    db.prepare(`
      UPDATE kb_facts
      SET approval_state = ?, lifecycle_state = ?, deprecated_at = ?, deprecated_reason = ?, updated_at = ?
      WHERE fact_id = ?
    `).run(
      next.approvalState,
      next.lifecycleState,
      next.deprecatedAt ?? null,
      next.deprecatedReason ?? null,
      updatedAt,
      factId,
    );

    return {
      ...existing,
      approvalState: next.approvalState,
      lifecycleState: next.lifecycleState,
      deprecatedAt: next.deprecatedAt ?? null,
      deprecatedReason: next.deprecatedReason ?? null,
      updatedAt,
    };
  } finally {
    db.close();
  }
}

function computeFactScore(
  fact: StoredFact,
  query: string,
  tokens: string[],
  config: Pick<EngramConfig, "recallKeywordBypassMinLength" | "recallKeywordBypassMaxTerms">,
): number {
  const haystack = fact.content.toLowerCase();
  const fullQuery = query.trim().toLowerCase();
  let rawScore = 0;
  for (const token of tokens) {
    rawScore += countOccurrences(haystack, token) * 2;
  }
  if (fullQuery && haystack.includes(fullQuery)) {
    rawScore += 6;
  }
  const weighted = rawScore + memoryClassWeight(fact.memoryClass) + sourceKindWeight(fact.sourceKind);
  if (fullQuery && haystack.includes(fullQuery)) {
    return weighted;
  }
  if (matchesKeywordBypass(haystack, query, config)) {
    return weighted;
  }
  return weighted * factDecayWeight(fact.memoryClass, fact.createdAt);
}

function matchesKeywordBypass(
  haystack: string,
  query: string,
  config: Pick<EngramConfig, "recallKeywordBypassMinLength" | "recallKeywordBypassMaxTerms">,
): boolean {
  const bypassTerms = [...new Set(tokenize(query))]
    .filter((term) => term.length >= config.recallKeywordBypassMinLength)
    .slice(0, config.recallKeywordBypassMaxTerms);
  return bypassTerms.some((term) => new RegExp(`\\b${escapeRegex(term)}\\b`, "i").test(haystack));
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function memoryClassWeight(memoryClass: MemoryClass): number {
  switch (memoryClass) {
    case "identity":
      return 6;
    case "project":
      return 5;
    case "task":
      return 3;
    case "reference":
      return 2;
  }
}

function sourceKindWeight(sourceKind: SourceKind): number {
  switch (sourceKind) {
    case "decision":
      return 4;
    case "user_stated":
      return 3;
    case "document_derived":
      return 2;
    case "agent_inferred":
      return 1;
  }
}

function factDecayWeight(memoryClass: MemoryClass, createdAt: string): number {
  const halfLifeDays = halfLifeForMemoryClass(memoryClass);
  if (halfLifeDays == null) {
    return 1;
  }
  const createdMs = Date.parse(createdAt);
  if (!Number.isFinite(createdMs)) {
    return 1;
  }
  const ageDays = Math.max(0, (Date.now() - createdMs) / (1000 * 60 * 60 * 24));
  const lambda = Math.log(2) / halfLifeDays;
  return Math.exp(-lambda * ageDays);
}

function halfLifeForMemoryClass(memoryClass: MemoryClass): number | null {
  switch (memoryClass) {
    case "identity":
      return null;
    case "project":
      return 180;
    case "task":
      return 7;
    case "reference":
      return 90;
  }
}

function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9_-]+/i)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3)
    .slice(0, 12);
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) {
    return 0;
  }
  let count = 0;
  let start = 0;
  while (true) {
    const index = haystack.indexOf(needle, start);
    if (index === -1) {
      return count;
    }
    count += 1;
    start = index + needle.length;
  }
}

function flagPotentialConflicts(
  db: DatabaseSync,
  fact: { factId: string; content: string; memoryClass: MemoryClass; createdAt: string },
): void {
  const currentTokens = new Set(tokenize(fact.content));
  if (currentTokens.size === 0) {
    return;
  }
  const existingFacts = db.prepare(`
    SELECT fact_id AS factId, content, memory_class AS memoryClass
    FROM kb_facts
    WHERE fact_id != ?
  `).all(fact.factId) as Array<{ factId: string; content: string; memoryClass: MemoryClass }>;

  for (const existing of existingFacts) {
    if (existing.memoryClass !== fact.memoryClass) {
      continue;
    }
    const similarity = jaccardSimilarity(currentTokens, new Set(tokenize(existing.content)));
    if (similarity < 0.5) {
      continue;
    }
    const [leftId, rightId] = [fact.factId, existing.factId].sort();
    db.prepare(`
      INSERT OR IGNORE INTO kb_conflicts (
        conflict_id, fact_id, conflicting_fact_id, similarity_score, resolution_state, created_at
      ) VALUES (?, ?, ?, ?, 'open', ?)
    `).run(`conflict:${leftId}:${rightId}`, leftId, rightId, similarity, fact.createdAt);
  }
}

function jaccardSimilarity(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 || right.size === 0) {
    return 0;
  }
  let intersection = 0;
  for (const token of left) {
    if (right.has(token)) {
      intersection += 1;
    }
  }
  const union = new Set([...left, ...right]).size;
  return union === 0 ? 0 : intersection / union;
}

function resolveLifecycleState(
  memoryClass: MemoryClass,
  sourceBasis: SourceKind,
  approvalState: string,
): string {
  if (sourceBasis === "decision") {
    return "durable";
  }
  if (sourceBasis === "agent_inferred" || sourceBasis === "document_derived") {
    return "captured";
  }
  if (approvalState === "pending" || memoryClass === "identity") {
    return "candidate";
  }
  return "validated";
}

function resolveExpiryTimestamp(nowIso: string, expiry?: string): string | null {
  const normalized = expiry?.trim();
  if (!normalized || normalized.toLowerCase() === "none") {
    return null;
  }
  const durationMatch = normalized.match(/^(\d+)d$/i);
  if (durationMatch) {
    const days = Number(durationMatch[1]);
    if (!Number.isFinite(days) || days <= 0) {
      return null;
    }
    return new Date(Date.parse(nowIso) + days * 24 * 60 * 60 * 1000).toISOString();
  }
  const timestamp = Date.parse(normalized);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}