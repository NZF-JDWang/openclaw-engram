import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { readdir } from "node:fs/promises";
import type { DatabaseSync } from "node:sqlite";
import { basename, extname, relative, resolve } from "node:path";
import type { EngramConfig, EngramKbCollection } from "../config.js";
import { openDatabase, retryOnBusy } from "../db/connection.js";
import { estimateTokens } from "../token-estimate.js";
import { chunkDocument } from "./chunker.js";
import { EmbeddingClient, encodeEmbedding } from "./embeddings.js";

export const SESSION_COLLECTION_NAME = "__sessions";

const TEXT_EXTENSIONS = new Set([
  ".md",
  ".txt",
  ".json",
  ".yml",
  ".yaml",
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".toml",
  ".ini",
  ".cfg",
]);

export type IndexPathResult = {
  collectionName: string;
  indexedDocuments: number;
  indexedChunks: number;
  skippedFiles: string[];
};

export type IndexSummaryResult = {
  docId: string;
  chunkCount: number;
  collectionName: string;
};

export type SyncCollectionsResult = {
  collections: IndexPathResult[];
};

type UpsertDocumentResult = {
  chunkCount: number;
  chunks: Array<{ chunkId: string; text: string }>;
};

export async function indexPath(
  config: EngramConfig,
  targetPath: string,
  collectionName?: string,
): Promise<IndexPathResult> {
  const resolvedPath = resolve(targetPath);
  if (!existsSync(resolvedPath)) {
    throw new Error(`Path does not exist: ${resolvedPath}`);
  }

  const stats = statSync(resolvedPath);
  const rootPath = stats.isDirectory() ? resolvedPath : resolve(resolvedPath, "..");
  const normalizedCollectionName = normalizeCollectionName(
    collectionName || basename(stats.isDirectory() ? resolvedPath : rootPath) || "manual",
  );

  return indexResolvedCollection(config, {
    name: normalizedCollectionName,
    path: rootPath,
    pattern: stats.isDirectory() ? "**/*" : basename(resolvedPath),
    description: "Manual Engram index",
    manualTargetPath: resolvedPath,
    autoIndex: false,
  });
}

export async function syncConfiguredCollections(config: EngramConfig): Promise<SyncCollectionsResult> {
  const collections: IndexPathResult[] = [];
  for (const collection of config.kbCollections) {
    collections.push(
      await indexResolvedCollection(config, {
        ...collection,
        autoIndex: true,
      }),
    );
  }
  return { collections };
}

async function indexResolvedCollection(
  config: EngramConfig,
  params: EngramKbCollection & { manualTargetPath?: string; autoIndex: boolean },
): Promise<IndexPathResult> {
  const resolvedPath = resolve(params.manualTargetPath ?? params.path);
  if (!existsSync(resolvedPath)) {
    throw new Error(`Path does not exist: ${resolvedPath}`);
  }

  const stats = statSync(resolvedPath);
  const rootPath = stats.isDirectory() ? resolvedPath : resolve(resolvedPath, "..");
  const files = stats.isDirectory() ? await listIndexableFiles(resolvedPath) : [resolvedPath];
  const database = openDatabase(config.dbPath);
  const embeddingClient = new EmbeddingClient(config);
  try {
    ensureCollection(database.db, {
      name: normalizeCollectionName(params.name),
      path: params.path,
      pattern: params.pattern,
      description: params.description ?? "Configured Engram collection",
      autoIndex: params.autoIndex,
    });

    let indexedDocuments = 0;
    let indexedChunks = 0;
    const skippedFiles: string[] = [];
    const knownRelPaths = new Set<string>();

    for (const filePath of files) {
      if (!isIndexableFile(filePath)) {
        skippedFiles.push(filePath);
        continue;
      }
      const relPath = normalizeRelPath(relative(rootPath, filePath) || basename(filePath));
      if (stats.isDirectory() && !matchesPattern(relPath, params.pattern)) {
        continue;
      }
      const content = readTextFile(filePath);
      if (!content) {
        skippedFiles.push(filePath);
        continue;
      }
      knownRelPaths.add(relPath);
      if (isDocumentUnchanged(database.db, normalizeCollectionName(params.name), relPath, content)) {
        continue;
      }
      const upserted = upsertDocument(database.db, {
        collectionName: normalizeCollectionName(params.name),
        relPath,
        title: deriveTitle(filePath),
        content,
      });
      await storeEmbeddings(database.db, embeddingClient, config, upserted.chunks);
      indexedDocuments += 1;
      indexedChunks += upserted.chunkCount;
    }

    if (config.kbIncrementalSync && stats.isDirectory()) {
      pruneStaleDocuments(database.db, normalizeCollectionName(params.name), knownRelPaths);
    }

    return {
      collectionName: normalizeCollectionName(params.name),
      indexedDocuments,
      indexedChunks,
      skippedFiles,
    };
  } finally {
    database.close();
  }
}

export async function indexSessionSummaryById(
  db: DatabaseSync,
  config: EngramConfig,
  params: { conversationId: string; summaryId: string },
): Promise<IndexSummaryResult | null> {
  if (!config.kbAutoIndexSessions) {
    return null;
  }

  const summary = db.prepare(`
    SELECT content, depth FROM summaries WHERE summary_id = ? AND conversation_id = ?
  `).get(params.summaryId, params.conversationId) as { content?: string; depth?: number } | undefined;

  if (!summary?.content) {
    throw new Error(`Summary not found: ${params.summaryId}`);
  }
  if (config.kbSessionIndexCircuitBreaker && (summary.depth ?? 0) > 0) {
    return null;
  }

  ensureCollection(db, {
    name: SESSION_COLLECTION_NAME,
    path: "engram://sessions",
    pattern: "*.summary",
    description: "Compacted Engram session summaries",
    autoIndex: true,
  });

  const upserted = upsertDocument(db, {
    collectionName: SESSION_COLLECTION_NAME,
    relPath: `${params.conversationId}/${params.summaryId}.summary`,
    title: `Session summary ${params.summaryId}`,
    content: summary.content,
    docId: `summary:${params.summaryId}`,
    derivationDepth: (summary.depth ?? 0) + 1,
  });
  await storeEmbeddings(db, new EmbeddingClient(config), config, upserted.chunks);

  return {
    docId: `summary:${params.summaryId}`,
    chunkCount: upserted.chunkCount,
    collectionName: SESSION_COLLECTION_NAME,
  };
}

export type IndexAllSummariesResult = {
  scanned: number;
  indexed: number;
  skipped: number;
};

export async function indexAllSummariesIntoKB(
  db: DatabaseSync,
  config: EngramConfig,
): Promise<IndexAllSummariesResult> {
  ensureCollection(db, {
    name: SESSION_COLLECTION_NAME,
    path: "engram://sessions",
    pattern: "*.summary",
    description: "Compacted Engram session summaries",
    autoIndex: true,
  });

  const summaries = db.prepare(`
    SELECT s.summary_id, s.conversation_id, s.content, s.depth
    FROM summaries s
    WHERE s.depth = 0
    ORDER BY s.created_at ASC
  `).all() as Array<{ summary_id: string; conversation_id: string; content: string; depth: number }>;

  const embeddingClient = new EmbeddingClient(config);
  let indexed = 0;
  let skipped = 0;

  for (const summary of summaries) {
    if (!summary.content) {
      skipped += 1;
      continue;
    }

    const docId = `summary:${summary.summary_id}`;
    const existing = db.prepare(`SELECT doc_id FROM kb_documents WHERE doc_id = ? LIMIT 1`).get(docId) as
      | { doc_id: string }
      | undefined;
    if (existing) {
      skipped += 1;
      continue;
    }

    const upserted = upsertDocument(db, {
      collectionName: SESSION_COLLECTION_NAME,
      relPath: `${summary.conversation_id}/${summary.summary_id}.summary`,
      title: `Session summary ${summary.summary_id}`,
      content: summary.content,
      docId,
      derivationDepth: 1,
    });
    await storeEmbeddings(db, embeddingClient, config, upserted.chunks);
    indexed += 1;
  }

  return { scanned: summaries.length, indexed, skipped };
}

export type DropCollectionResult = {
  collectionName: string;
  droppedDocs: number;
  droppedChunks: number;
};

export function dropKbCollection(db: DatabaseSync, collectionName: string): DropCollectionResult {
  const ftsAvailable = hasFtsTable(db);

  const docCount = (db.prepare(`SELECT COUNT(*) AS n FROM kb_documents WHERE collection_name = ?`).get(collectionName) as { n: number } | undefined)?.n ?? 0;
  const chunkCount = (db.prepare(`SELECT COUNT(*) AS n FROM kb_chunks WHERE collection_name = ?`).get(collectionName) as { n: number } | undefined)?.n ?? 0;

  if (docCount === 0 && chunkCount === 0) {
    db.prepare(`DELETE FROM kb_collections WHERE name = ?`).run(collectionName);
    return { collectionName, droppedDocs: 0, droppedChunks: 0 };
  }

  retryOnBusy(() => db.exec("BEGIN IMMEDIATE"));
  try {
    db.prepare(`
      DELETE FROM kb_embeddings
      WHERE chunk_id IN (SELECT chunk_id FROM kb_chunks WHERE collection_name = ?)
    `).run(collectionName);
    if (ftsAvailable) {
      db.prepare(`DELETE FROM kb_chunks_fts WHERE collection_name = ?`).run(collectionName);
    }
    db.prepare(`DELETE FROM kb_chunks WHERE collection_name = ?`).run(collectionName);
    db.prepare(`DELETE FROM kb_documents WHERE collection_name = ?`).run(collectionName);
    db.prepare(`DELETE FROM kb_collections WHERE name = ?`).run(collectionName);
    db.exec("COMMIT");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // preserve original error
    }
    throw error;
  }

  return { collectionName, droppedDocs: docCount, droppedChunks: chunkCount };
}

function upsertDocument(
  db: DatabaseSync,
  params: {
    collectionName: string;
    relPath: string;
    title: string;
    content: string;
    docId?: string;
    derivationDepth?: number;
  },
): UpsertDocumentResult {
  const docId = params.docId ?? `doc:${hash(`${params.collectionName}\0${params.relPath}`)}`;
  const contentHash = hash(params.content);
  const tokenCount = estimateTokens(params.content);
  const chunks = chunkDocument(params.content);
  const indexedChunks: Array<{ chunkId: string; text: string }> = [];
  const ftsAvailable = hasFtsTable(db);

  retryOnBusy(() => db.exec("BEGIN IMMEDIATE"));
  try {
    db.prepare(`DELETE FROM kb_embeddings WHERE chunk_id IN (SELECT chunk_id FROM kb_chunks WHERE doc_id = ?)`)
      .run(docId);
    if (ftsAvailable) {
      db.prepare(`DELETE FROM kb_chunks_fts WHERE doc_id = ?`).run(docId);
    }
    db.prepare(`DELETE FROM kb_chunks WHERE doc_id = ?`).run(docId);
    db.prepare(`
      INSERT INTO kb_documents (doc_id, collection_name, rel_path, title, content_hash, token_count, indexed_at)
      VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(doc_id) DO UPDATE SET
        collection_name = excluded.collection_name,
        rel_path = excluded.rel_path,
        title = excluded.title,
        content_hash = excluded.content_hash,
        token_count = excluded.token_count,
        indexed_at = excluded.indexed_at
    `).run(docId, params.collectionName, params.relPath, params.title, contentHash, tokenCount);

    const insertChunk = db.prepare(`
      INSERT INTO kb_chunks (chunk_id, doc_id, collection_name, ordinal, content, token_count, chunk_hash, derivation_depth)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertFtsChunk = ftsAvailable
      ? db.prepare(`
          INSERT INTO kb_chunks_fts (chunk_id, doc_id, collection_name, rel_path, title, content)
          VALUES (?, ?, ?, ?, ?, ?)
        `)
      : null;
    chunks.forEach((chunk, index) => {
      const chunkId = `chunk:${hash(`${docId}\0${index}\0${chunk.text}`)}`;
      insertChunk.run(
        chunkId,
        docId,
        params.collectionName,
        index,
        chunk.text,
        estimateTokens(chunk.text),
        hash(chunk.text),
        params.derivationDepth ?? 0,
      );
      insertFtsChunk?.run(chunkId, docId, params.collectionName, params.relPath, params.title, chunk.text);
      indexedChunks.push({ chunkId, text: chunk.text });
    });
    db.exec("COMMIT");
    return {
      chunkCount: chunks.length,
      chunks: indexedChunks,
    };
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // preserve original error
    }
    throw error;
  }
}

function ensureCollection(
  db: DatabaseSync,
  params: { name: string; path: string; pattern: string; description: string; autoIndex: boolean },
): void {
  const ftsAvailable = hasFtsTable(db);
  db.prepare(`
    INSERT INTO kb_collections (name, path, pattern, description, auto_index, fts5_available, created_at)
    VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(name) DO UPDATE SET
      path = excluded.path,
      pattern = excluded.pattern,
      description = excluded.description,
      auto_index = excluded.auto_index,
      fts5_available = excluded.fts5_available
  `).run(params.name, params.path, params.pattern, params.description, params.autoIndex ? 1 : 0, ftsAvailable ? 1 : 0);
}

async function listIndexableFiles(rootPath: string): Promise<string[]> {
  const entries = await readdir(rootPath, { withFileTypes: true, recursive: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }
    const parentPath = "path" in entry && typeof entry.path === "string" ? entry.path : rootPath;
    files.push(resolve(parentPath, entry.name));
  }
  return files;
}

function isIndexableFile(filePath: string): boolean {
  return TEXT_EXTENSIONS.has(extname(filePath).toLowerCase());
}

function readTextFile(filePath: string): string {
  try {
    const content = readFileSync(filePath, "utf8");
    if (content.includes("\u0000")) {
      return "";
    }
    return content;
  } catch {
    return "";
  }
}

function deriveTitle(filePath: string): string {
  return basename(filePath, extname(filePath)) || basename(filePath);
}

function normalizeCollectionName(value: string): string {
  return value.trim().replace(/[^a-z0-9_-]+/gi, "-").replace(/^-+|-+$/g, "").toLowerCase() || "manual";
}

function normalizeRelPath(value: string): string {
  return value.replace(/\\/g, "/");
}

function pruneStaleDocuments(
  db: DatabaseSync,
  collectionName: string,
  knownRelPaths: Set<string>,
): void {
  const existing = db
    .prepare(`SELECT doc_id AS docId, rel_path AS relPath FROM kb_documents WHERE collection_name = ?`)
    .all(collectionName) as Array<{ docId: string; relPath: string }>;

  const stale = existing.filter((row) => !knownRelPaths.has(row.relPath));
  if (stale.length === 0) {
    return;
  }

  const ftsAvailable = hasFtsTable(db);
  retryOnBusy(() => db.exec("BEGIN IMMEDIATE"));
  try {
    for (const row of stale) {
      db.prepare(`DELETE FROM kb_embeddings WHERE chunk_id IN (SELECT chunk_id FROM kb_chunks WHERE doc_id = ?)`).run(row.docId);
      if (ftsAvailable) {
        db.prepare(`DELETE FROM kb_chunks_fts WHERE doc_id = ?`).run(row.docId);
      }
      db.prepare(`DELETE FROM kb_chunks WHERE doc_id = ?`).run(row.docId);
      db.prepare(`DELETE FROM kb_documents WHERE doc_id = ?`).run(row.docId);
    }
    db.exec("COMMIT");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // preserve original error
    }
    throw error;
  }
}

function isDocumentUnchanged(  db: DatabaseSync,
  collectionName: string,
  relPath: string,
  content: string,
): boolean {
  const row = db.prepare(`
    SELECT content_hash AS contentHash
    FROM kb_documents
    WHERE collection_name = ? AND rel_path = ?
    LIMIT 1
  `).get(collectionName, relPath) as { contentHash?: string } | undefined;
  return !!row?.contentHash && row.contentHash === hash(content);
}

function matchesPattern(relPath: string, pattern: string): boolean {
  if (!pattern || pattern === "**/*") {
    return true;
  }
  const normalizedPath = normalizeRelPath(relPath).toLowerCase();
  const normalizedPattern = normalizeRelPath(pattern).toLowerCase();
  const regex = new RegExp(`^${globToRegexSource(normalizedPattern)}$`);
  return regex.test(normalizedPath);
}

function globToRegexSource(pattern: string): string {
  let result = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    const next = pattern[index + 1];
    if (char === "*" && next === "*" && pattern[index + 2] === "/") {
      result += "(?:.*/)?";
      index += 2;
      continue;
    }
    if (char === "*" && next === "*") {
      result += ".*";
      index += 1;
      continue;
    }
    if (char === "*") {
      result += "[^/]*";
      continue;
    }
    if (char === "?") {
      result += ".";
      continue;
    }
    result += char.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
  }
  return result;
}

function hasFtsTable(db: DatabaseSync): boolean {
  try {
    const row = db.prepare(`
      SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'kb_chunks_fts'
    `).get() as { count?: number } | undefined;
    return (row?.count ?? 0) > 0;
  } catch {
    return false;
  }
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function storeEmbeddings(
  db: DatabaseSync,
  client: EmbeddingClient,
  config: EngramConfig,
  chunks: Array<{ chunkId: string; text: string }>,
): Promise<void> {
  if (!config.embedEnabled || chunks.length === 0) {
    return;
  }

  const vectors = await client.embed(chunks.map((chunk) => chunk.text));
  const insertEmbedding = db.prepare(`
    INSERT INTO kb_embeddings (chunk_id, model, vector, dimensions, created_at)
    VALUES (?, ?, ?, ?, datetime('now'))
    ON CONFLICT(chunk_id, model) DO UPDATE SET
      vector = excluded.vector,
      dimensions = excluded.dimensions,
      created_at = excluded.created_at
  `);

  vectors.forEach((vector, index) => {
    if (!vector || vector.length === 0) {
      return;
    }
    const chunk = chunks[index];
    if (!chunk) {
      return;
    }
    insertEmbedding.run(
      chunk.chunkId,
      config.embedApiModel,
      Buffer.from(encodeEmbedding(vector)),
      vector.length,
    );
  });
}