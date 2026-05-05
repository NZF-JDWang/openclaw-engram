import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export type CommitmentRow = {
  commitmentId: string;
  content: string;
  dueAt: string | null;
  status: string;
  scope: string;
  sourceConversationId: string | null;
  createdAt: string;
};

export type DreamCandidateRow = {
  candidateId: string;
  content: string;
  sourceKind: string;
  sourceId: string;
  score: number;
  recallCount: number;
  queryCount: number;
  promoted: boolean;
  createdAt: string;
  lastSeenAt: string;
};

export function storeCommitment(
  db: DatabaseSync,
  params: { content: string; dueAt?: string; scope?: string; sourceConversationId?: string },
): CommitmentRow {
  const commitmentId = randomUUID();
  db.prepare(`
    INSERT INTO engram_commitments (
      commitment_id, content, due_at, status, scope, source_conversation_id, created_at
    )
    VALUES (?, ?, ?, 'open', ?, ?, datetime('now'))
  `).run(
    commitmentId,
    params.content,
    params.dueAt ?? null,
    params.scope ?? "session",
    params.sourceConversationId ?? null,
  );
  return listCommitments(db, { status: "open", limit: 1, commitmentId })[0]!;
}

export function listCommitments(
  db: DatabaseSync,
  options: { status?: "open" | "done"; dueBefore?: string; limit?: number; commitmentId?: string } = {},
): CommitmentRow[] {
  const clauses: string[] = [];
  const params: Array<string | number | null> = [];
  if (options.commitmentId) {
    clauses.push("commitment_id = ?");
    params.push(options.commitmentId);
  }
  if (options.status) {
    clauses.push("status = ?");
    params.push(options.status);
  }
  if (options.dueBefore) {
    clauses.push("due_at IS NOT NULL AND due_at <= ?");
    params.push(options.dueBefore);
  }
  const limit = Math.max(1, Math.min(options.limit ?? 20, 100));
  const rows = db.prepare(`
    SELECT commitment_id AS commitmentId,
           content,
           due_at AS dueAt,
           status,
           scope,
           source_conversation_id AS sourceConversationId,
           created_at AS createdAt
    FROM engram_commitments
    ${clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : ""}
    ORDER BY COALESCE(due_at, created_at) ASC
    LIMIT ${limit}
  `).all(...params) as CommitmentRow[];
  return rows;
}

export function completeCommitment(db: DatabaseSync, commitmentId: string): boolean {
  const result = db.prepare(`
    UPDATE engram_commitments
    SET status = 'done', completed_at = datetime('now')
    WHERE commitment_id = ? AND status = 'open'
  `).run(commitmentId) as { changes: number };
  return result.changes > 0;
}

export function recordMemoryClaim(
  db: DatabaseSync,
  params: { sourceKind: string; sourceId: string; content: string; confidence?: number; freshness?: string },
): string {
  const claimId = randomUUID();
  db.prepare(`
    INSERT INTO memory_claims (
      claim_id, source_kind, source_id, content, confidence, freshness, status, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, 'active', datetime('now'), datetime('now'))
  `).run(
    claimId,
    params.sourceKind,
    params.sourceId,
    params.content,
    clamp(params.confidence ?? 0.75, 0, 1),
    params.freshness ?? null,
  );
  return claimId;
}

export function stageDreamCandidate(
  db: DatabaseSync,
  params: { sourceKind: string; sourceId: string; content: string; score?: number; recallCount?: number; queryCount?: number },
): DreamCandidateRow {
  const candidateId = randomUUID();
  db.prepare(`
    INSERT INTO engram_dream_candidates (
      candidate_id, content, source_kind, source_id, score, recall_count, query_count, promoted, created_at, last_seen_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, 0, datetime('now'), datetime('now'))
  `).run(
    candidateId,
    params.content,
    params.sourceKind,
    params.sourceId,
    clamp(params.score ?? 0, 0, 1),
    Math.max(0, params.recallCount ?? 0),
    Math.max(0, params.queryCount ?? 0),
  );
  return listDreamCandidates(db, { limit: 1, candidateId })[0]!;
}

export function listDreamCandidates(
  db: DatabaseSync,
  options: { limit?: number; candidateId?: string; minScore?: number } = {},
): DreamCandidateRow[] {
  const clauses = ["promoted = 0"];
  const params: Array<string | number | null> = [];
  if (options.candidateId) {
    clauses.push("candidate_id = ?");
    params.push(options.candidateId);
  }
  if (typeof options.minScore === "number") {
    clauses.push("score >= ?");
    params.push(options.minScore);
  }
  const limit = Math.max(1, Math.min(options.limit ?? 20, 100));
  const rows = db.prepare(`
    SELECT candidate_id AS candidateId,
           content,
           source_kind AS sourceKind,
           source_id AS sourceId,
           score,
           recall_count AS recallCount,
           query_count AS queryCount,
           promoted,
           created_at AS createdAt,
           last_seen_at AS lastSeenAt
    FROM engram_dream_candidates
    WHERE ${clauses.join(" AND ")}
    ORDER BY score DESC, last_seen_at DESC
    LIMIT ${limit}
  `).all(...params) as Array<Omit<DreamCandidateRow, "promoted"> & { promoted: number }>;
  return rows.map((row) => ({ ...row, promoted: row.promoted === 1 }));
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
