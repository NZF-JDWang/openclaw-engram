import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type { EngramConfig } from "../config.js";
import { EmbeddingClient, decodeEmbedding } from "./embeddings.js";

const LIKE_FALLBACK_MAX_CHUNKS = 5_000;

export type KBSearchRow = {
  chunkId: string;
  docId: string;
  collectionName: string;
  relPath: string;
  title: string;
  content: string;
  score: number;
  indexedAt: string;
  derivationDepth: number;
  memoryClass: "task" | "reference";
  sourceKind: "document_derived";
};

export type KBDocumentRow = {
  docId: string;
  collectionName: string;
  relPath: string;
  title: string;
  content: string;
};

export async function searchKnowledgeBase(
  config: EngramConfig,
  query: string,
  options: { limit?: number; collection?: string } = {},
): Promise<KBSearchRow[]> {
  if (!existsSync(config.dbPath)) {
    return [];
  }

  const tokens = tokenize(query);
  if (tokens.length === 0) {
    return [];
  }

  const db = new DatabaseSync(config.dbPath, { open: true, readOnly: true });
  const searchStartedAt = Date.now();
  try {
    const rows = queryLexicalRows(db, tokens, options.collection);

    const elapsedAfterLexical = Date.now() - searchStartedAt;
    if (elapsedAfterLexical > config.kbSearchTimeoutMs) {
      warnSearchTimeout(
        `Lexical KB search exceeded timeout (${elapsedAfterLexical}ms > ${config.kbSearchTimeoutMs}ms); returning no results.`,
      );
      return [];
    }

    const lexicalResults = rows
      .map((row) => ({
        ...row,
        score: computeScore(row, tokens, query, config),
        memoryClass: deriveMemoryClass(row.collectionName),
        sourceKind: "document_derived" as const,
      }))
      .sort((left, right) => right.score - left.score || left.relPath.localeCompare(right.relPath))
      .slice(0, config.maxSearchCandidates);

    const remainingBudgetMs = Math.max(0, config.kbSearchTimeoutMs - elapsedAfterLexical);
    const reranked = await rerankWithEmbeddings(db, config, query, lexicalResults, remainingBudgetMs);
    return reranked.slice(0, options.limit ?? 5);
  } finally {
    db.close();
  }
}

export function getKnowledgeDocument(config: EngramConfig, idOrPath: string): KBDocumentRow | null {
  if (!existsSync(config.dbPath)) {
    return null;
  }

  const db = new DatabaseSync(config.dbPath, { open: true, readOnly: true });
  try {
    const document = db
      .prepare(`
        SELECT doc_id AS docId, collection_name AS collectionName, rel_path AS relPath, title
        FROM kb_documents
        WHERE doc_id = ? OR rel_path = ?
        LIMIT 1
      `)
      .get(idOrPath, idOrPath) as
      | { docId: string; collectionName: string; relPath: string; title: string }
      | undefined;

    if (!document) {
      const chunk = db
        .prepare(`
          SELECT kd.doc_id AS docId, kd.collection_name AS collectionName, kd.rel_path AS relPath, kd.title
          FROM kb_chunks kc
          JOIN kb_documents kd ON kd.doc_id = kc.doc_id
          WHERE kc.chunk_id = ?
          LIMIT 1
        `)
        .get(idOrPath) as
        | { docId: string; collectionName: string; relPath: string; title: string }
        | undefined;
      if (!chunk) {
        return null;
      }
      return {
        ...chunk,
        content: fetchDocumentContent(db, chunk.docId),
      };
    }

    return {
      ...document,
      content: fetchDocumentContent(db, document.docId),
    };
  } finally {
    db.close();
  }
}

function queryLexicalRows(
  db: DatabaseSync,
  tokens: string[],
  collection?: string,
): Array<{
  chunkId: string;
  docId: string;
  collectionName: string;
  relPath: string;
  title: string;
  content: string;
  indexedAt: string;
  derivationDepth: number;
}> {
  const availability = readCollectionAvailability(db, collection);
  const rows: Array<{
    chunkId: string;
    docId: string;
    collectionName: string;
    relPath: string;
    title: string;
    content: string;
    indexedAt: string;
    derivationDepth: number;
  }> = [];

  if (hasFtsTable(db) && availability.ftsCollections.length > 0) {
    rows.push(...queryFtsRows(db, tokens, availability.ftsCollections));
  }

  if (availability.fallbackCollections.length > 0) {
    if (availability.fallbackChunkCount > LIKE_FALLBACK_MAX_CHUNKS) {
      throw new Error(
        `FTS5 is unavailable for collection${availability.fallbackCollections.length === 1 ? "" : "s"} ${availability.fallbackCollections.join(", ")} and LIKE fallback is disabled above ${LIKE_FALLBACK_MAX_CHUNKS} chunks.`,
      );
    }
    warnSearchTimeout(
      `KB FTS5 unavailable; using LIKE fallback for ${availability.fallbackChunkCount} chunk${availability.fallbackChunkCount === 1 ? "" : "s"}.`,
    );
    rows.push(...queryLikeRows(db, tokens, availability.fallbackCollections));
  }

  return rows;
}

function queryFtsRows(
  db: DatabaseSync,
  tokens: string[],
  collections: string[],
): Array<{
  chunkId: string;
  docId: string;
  collectionName: string;
  relPath: string;
  title: string;
  content: string;
  indexedAt: string;
  derivationDepth: number;
}> {
  const params: string[] = [tokens.map(escapeFtsToken).join(" OR ")];
  let sql = `
    SELECT
      kc.chunk_id AS chunkId,
      kd.doc_id AS docId,
      kd.collection_name AS collectionName,
      kd.rel_path AS relPath,
      kd.title AS title,
      kc.content AS content,
      kd.indexed_at AS indexedAt,
      kc.derivation_depth AS derivationDepth
    FROM kb_chunks_fts
    JOIN kb_chunks kc ON kc.chunk_id = kb_chunks_fts.chunk_id
    JOIN kb_documents kd ON kd.doc_id = kc.doc_id
    WHERE kb_chunks_fts MATCH ?
  `;
  if (collections.length > 0) {
    sql += ` AND kd.collection_name IN (${collections.map(() => "?").join(", ")})`;
    params.push(...collections);
  }
  sql += ` ORDER BY bm25(kb_chunks_fts), kd.indexed_at DESC, kc.ordinal ASC`;
  return db.prepare(sql).all(...params) as Array<{
    chunkId: string;
    docId: string;
    collectionName: string;
    relPath: string;
    title: string;
    content: string;
    indexedAt: string;
    derivationDepth: number;
  }>;
}

function queryLikeRows(
  db: DatabaseSync,
  tokens: string[],
  collections: string[],
): Array<{
  chunkId: string;
  docId: string;
  collectionName: string;
  relPath: string;
  title: string;
  content: string;
  indexedAt: string;
  derivationDepth: number;
}> {
  const whereClauses = tokens.map(() => `LOWER(kc.content) LIKE ?`).join(" OR ");
  const params: string[] = tokens.map((token) => `%${token}%`);
  let sql = `
    SELECT
      kc.chunk_id AS chunkId,
      kd.doc_id AS docId,
      kd.collection_name AS collectionName,
      kd.rel_path AS relPath,
      kd.title AS title,
      kc.content AS content,
      kd.indexed_at AS indexedAt,
      kc.derivation_depth AS derivationDepth
    FROM kb_chunks kc
    JOIN kb_documents kd ON kd.doc_id = kc.doc_id
    WHERE (${whereClauses})
  `;
  if (collections.length > 0) {
    sql += ` AND kd.collection_name IN (${collections.map(() => "?").join(", ")})`;
    params.push(...collections);
  }
  sql += ` ORDER BY kd.indexed_at DESC, kc.ordinal ASC`;
  return db.prepare(sql).all(...params) as Array<{
    chunkId: string;
    docId: string;
    collectionName: string;
    relPath: string;
    title: string;
    content: string;
    indexedAt: string;
    derivationDepth: number;
  }>;
}

function readCollectionAvailability(
  db: DatabaseSync,
  collection?: string,
): {
  ftsCollections: string[];
  fallbackCollections: string[];
  fallbackChunkCount: number;
} {
  const hasFts = hasFtsTable(db);
  const rows = db.prepare(`
    SELECT
      c.name AS name,
      c.fts5_available AS fts5Available,
      COALESCE(k.chunkCount, 0) AS chunkCount
    FROM kb_collections c
    LEFT JOIN (
      SELECT collection_name, COUNT(*) AS chunkCount
      FROM kb_chunks
      GROUP BY collection_name
    ) k ON k.collection_name = c.name
    ${collection ? "WHERE c.name = ?" : ""}
    ORDER BY c.name ASC
  `).all(...(collection ? [collection] : [])) as Array<{
    name: string;
    fts5Available: number;
    chunkCount: number;
  }>;

  if (rows.length === 0) {
    return {
      ftsCollections: collection && hasFts ? [collection] : [],
      fallbackCollections: collection && !hasFts ? [collection] : [],
      fallbackChunkCount: collection ? countChunksForCollections(db, [collection]) : 0,
    };
  }

  return rows.reduce(
    (accumulator, row) => {
      if (hasFts && row.fts5Available === 1) {
        accumulator.ftsCollections.push(row.name);
      } else {
        accumulator.fallbackCollections.push(row.name);
        accumulator.fallbackChunkCount += row.chunkCount;
      }
      return accumulator;
    },
    {
      ftsCollections: [] as string[],
      fallbackCollections: [] as string[],
      fallbackChunkCount: 0,
    },
  );
}

function countChunksForCollections(db: DatabaseSync, collections: string[]): number {
  if (collections.length === 0) {
    return 0;
  }
  const row = db.prepare(`
    SELECT COUNT(*) AS count
    FROM kb_chunks
    WHERE collection_name IN (${collections.map(() => "?").join(", ")})
  `).get(...collections) as { count?: number } | undefined;
  return row?.count ?? 0;
}

function fetchDocumentContent(db: DatabaseSync, docId: string): string {
  const chunks = db
    .prepare(`
      SELECT content
      FROM kb_chunks
      WHERE doc_id = ?
      ORDER BY ordinal ASC
    `)
    .all(docId) as Array<{ content: string }>;
  return chunks.map((row) => row.content).join("\n\n");
}

function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9_\-]+/i)
    .map((part) => part.trim())
    .filter((part) => part.length >= 2)
    .slice(0, 12);
}

function computeScore(
  row: { relPath: string; title: string; content: string; collectionName?: string; indexedAt: string; derivationDepth: number },
  tokens: string[],
  query: string,
  config: Pick<EngramConfig, "recallKeywordBypassMinLength" | "recallKeywordBypassMaxTerms">,
): number {
  const content = row.content.toLowerCase();
  const title = row.title.toLowerCase();
  const relPath = row.relPath.toLowerCase();
  let rawScore = 0;

  for (const token of tokens) {
    rawScore += countOccurrences(content, token);
    rawScore += countOccurrences(title, token) * 4;
    rawScore += countOccurrences(relPath, token) * 2;
  }

  const exactMatch = tokens.join(" ").trim();
  const exactBoost = exactMatch && (content.includes(exactMatch) || title.includes(exactMatch) || relPath.includes(exactMatch)) ? 1.25 : 1;
  const bypassDecay = matchesKeywordBypass([content, title, relPath].join(" "), query, config);
  return rawScore * exactBoost * collectionWeight(row.collectionName) * derivationWeight(row.derivationDepth) * (bypassDecay ? 1 : decayWeight(row.indexedAt, row.collectionName));
}

function collectionWeight(collectionName?: string): number {
  return collectionName === "__sessions" ? 0.7 : 1;
}

function derivationWeight(derivationDepth: number): number {
  return Math.max(0.45, 1 - derivationDepth * 0.2);
}

function decayWeight(indexedAt: string, collectionName?: string): number {
  if (collectionName === "__sessions") {
    return halfLifeWeight(indexedAt, 7);
  }
  return halfLifeWeight(indexedAt, 90);
}

function halfLifeWeight(timestamp: string, halfLifeDays: number): number {
  const indexedMs = Date.parse(timestamp);
  if (!Number.isFinite(indexedMs)) {
    return 1;
  }
  const ageDays = Math.max(0, (Date.now() - indexedMs) / (1000 * 60 * 60 * 24));
  const lambda = Math.log(2) / halfLifeDays;
  return Math.exp(-lambda * ageDays);
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

async function rerankWithEmbeddings(
  db: DatabaseSync,
  config: EngramConfig,
  query: string,
  rows: KBSearchRow[],
  remainingBudgetMs: number,
): Promise<KBSearchRow[]> {
  if (!config.embedEnabled || rows.length === 0) {
    return rows;
  }

  if (remainingBudgetMs <= 0) {
    warnSearchTimeout("KB vector reranking skipped because no timeout budget remained after lexical search.");
    return rows;
  }

  const queryVector = await embedQueryWithBudget(config, query, remainingBudgetMs);
  if (!queryVector) {
    return rows;
  }

  const placeholders = rows.map(() => "?").join(", ");
  const embeddingRows = db.prepare(`
    SELECT chunk_id AS chunkId, vector, dimensions
    FROM kb_embeddings
    WHERE model = ? AND chunk_id IN (${placeholders})
  `).all(config.embedApiModel, ...rows.map((row) => row.chunkId)) as Array<{
    chunkId: string;
    vector: Uint8Array;
    dimensions: number | null;
  }>;
  if (embeddingRows.length === 0) {
    return rows;
  }

  const vectorByChunkId = new Map(
    embeddingRows.map((row) => [row.chunkId, decodeEmbedding(row.vector, row.dimensions)]),
  );
  const lexicalRanks = new Map(rows.map((row, index) => [row.chunkId, index + 1]));
  const semanticRows = rows
    .map((row) => ({
      chunkId: row.chunkId,
      semanticScore: (() => {
        const chunkVector = vectorByChunkId.get(row.chunkId);
        return chunkVector ? Math.max(0, cosineSimilarity(queryVector, chunkVector)) : -1;
      })(),
    }))
      .filter((row) => row.semanticScore >= 0)
      .sort((left, right) => right.semanticScore - left.semanticScore || left.chunkId.localeCompare(right.chunkId));
  const semanticRanks = new Map(semanticRows.map((row, index) => [row.chunkId, index + 1]));
  const semanticScores = new Map(semanticRows.map((row) => [row.chunkId, row.semanticScore]));

  return rows
    .map((row) => {
      const lexicalRank = lexicalRanks.get(row.chunkId);
      const semanticRank = semanticRanks.get(row.chunkId);
      return {
        ...row,
        score: rrfScore(lexicalRank, config.recallRrfK) + rrfScore(semanticRank, config.recallRrfK),
        semanticScore: semanticScores.get(row.chunkId) ?? 0,
      };
    })
    .sort((left, right) => right.score - left.score || right.semanticScore - left.semanticScore || left.relPath.localeCompare(right.relPath))
    .map(({ semanticScore: _semanticScore, ...row }) => row);
}

function rrfScore(rank: number | undefined, k: number): number {
  return typeof rank === "number" ? 1 / (k + rank) : 0;
}

function cosineSimilarity(left: number[], right: number[]): number {
  if (left.length === 0 || right.length === 0 || left.length !== right.length) {
    return 0;
  }
  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index]! * right[index]!;
    leftMagnitude += left[index]! * left[index]!;
    rightMagnitude += right[index]! * right[index]!;
  }
  if (leftMagnitude === 0 || rightMagnitude === 0) {
    return 0;
  }
  return dot / Math.sqrt(leftMagnitude * rightMagnitude);
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

function deriveMemoryClass(collectionName: string): "task" | "reference" {
  return collectionName === "__sessions" ? "task" : "reference";
}

function escapeFtsToken(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

async function embedQueryWithBudget(
  config: EngramConfig,
  query: string,
  remainingBudgetMs: number,
): Promise<number[] | null> {
  try {
    const result = await Promise.race([
      new EmbeddingClient(config).embed([query]).then((vectors) => vectors[0] ?? null),
      new Promise<null>((resolve) => {
        const handle = setTimeout(() => resolve(null), remainingBudgetMs);
        if (typeof handle === "object" && handle && "unref" in handle && typeof handle.unref === "function") {
          handle.unref();
        }
      }),
    ]);
    if (!result && config.embedEnabled) {
      warnSearchTimeout(
        `KB vector reranking exceeded timeout budget (${remainingBudgetMs}ms); using lexical results only.`,
      );
    }
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    warnSearchTimeout(`KB vector reranking failed: ${message}. Using lexical results only.`);
    return null;
  }
}

function warnSearchTimeout(message: string): void {
  console.warn(`[engram] ${message}`);
}

function hasFtsTable(db: DatabaseSync): boolean {
  const row = db.prepare(`
    SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'kb_chunks_fts'
  `).get() as { count?: number } | undefined;
  return (row?.count ?? 0) > 0;
}