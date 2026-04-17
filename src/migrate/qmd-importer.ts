import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { retryOnBusy } from "../db/connection.js";
import { chunkDocument } from "../kb/chunker.js";
import { estimateTokens } from "../token-estimate.js";

export type QmdImportResult = {
  imported: boolean;
  skipped: boolean;
  sourcePath: string;
  counts: Record<string, number>;
  warnings: string[];
};

type QmdCollectionRow = {
  name: string;
  path: string;
  pattern: string;
  context: string | null;
};

type QmdDocumentRow = {
  id: number;
  collection: string;
  path: string;
  title: string;
  hash: string;
  modified_at: string;
};

type QmdContentRow = {
  hash: string;
  doc: string;
};

export function importFromQmd(sourcePath: string, destDb: DatabaseSync): QmdImportResult {
  if (hasExistingImport(destDb, sourcePath)) {
    return {
      imported: false,
      skipped: true,
      sourcePath,
      counts: {},
      warnings: [],
    };
  }

  const sourceDb = new DatabaseSync(sourcePath, { open: true, readOnly: true });
  try {
    const collections = tableExists(sourceDb, "store_collections")
      ? (sourceDb.prepare(`SELECT name, path, pattern, context FROM store_collections`).all() as QmdCollectionRow[])
      : [];
    const documents = tableExists(sourceDb, "documents")
      ? (sourceDb.prepare(`SELECT id, collection, path, title, hash, modified_at FROM documents WHERE active = 1`).all() as QmdDocumentRow[])
      : [];
    const contents = tableExists(sourceDb, "content")
      ? (sourceDb.prepare(`SELECT hash, doc FROM content`).all() as QmdContentRow[])
      : [];

    const contentByHash = new Map(contents.map((row) => [row.hash, row.doc]));
    const warnings: string[] = [];
    if (!tableExists(sourceDb, "vectors_vec")) {
      warnings.push("QMD vec0 table 'vectors_vec' not found; embeddings were not imported and documents will require re-indexing for vector search.");
    } else {
      warnings.push("QMD vector rows were intentionally not imported; Engram will require re-indexing for compatible embeddings.");
    }

    retryOnBusy(() => destDb.exec("BEGIN IMMEDIATE"));
    try {
      const insertCollection = destDb.prepare(`
        INSERT OR IGNORE INTO kb_collections (name, path, pattern, description, auto_index, fts5_available, created_at)
        VALUES (?, ?, ?, ?, 0, 0, datetime('now'))
      `);
      const insertDocument = destDb.prepare(`
        INSERT OR IGNORE INTO kb_documents (doc_id, collection_name, rel_path, title, content_hash, token_count, indexed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      const insertChunk = destDb.prepare(`
        INSERT OR IGNORE INTO kb_chunks (chunk_id, doc_id, collection_name, ordinal, content, token_count, chunk_hash, derivation_depth)
        VALUES (?, ?, ?, ?, ?, ?, ?, 0)
      `);

      for (const row of collections) {
        insertCollection.run(row.name, row.path, row.pattern, row.context);
      }
      for (const row of documents) {
        const docId = mapQmdDocId(row.id, row.collection, row.path);
        const content = contentByHash.get(row.hash) ?? "";
        const tokenCount = estimateTokens(content);
        insertDocument.run(docId, row.collection, row.path, row.title, row.hash, tokenCount, row.modified_at);
        const chunks = chunkDocument(content);
        for (const [index, chunk] of chunks.entries()) {
          const chunkId = `${docId}:chunk:${index}`;
          insertChunk.run(
            chunkId,
            docId,
            row.collection,
            index,
            chunk.text,
            estimateTokens(chunk.text),
            `${row.hash}:${chunk.pos}`,
          );
        }
      }

      const counts = {
        collections: collections.length,
        documents: documents.length,
        chunks: documents.reduce((total, row) => total + chunkDocument(contentByHash.get(row.hash) ?? "").length, 0),
      };

      destDb.prepare(`
        INSERT INTO engram_import_runs (import_id, source_kind, source_path, record_counts_json, imported_at)
        VALUES (?, 'qmd', ?, ?, datetime('now'))
      `).run(randomUUID(), sourcePath, JSON.stringify(counts));

      destDb.exec("COMMIT");
      return {
        imported: true,
        skipped: false,
        sourcePath,
        counts,
        warnings,
      };
    } catch (error) {
      try {
        destDb.exec("ROLLBACK");
      } catch {
        // Preserve original failure.
      }
      throw error;
    }
  } finally {
    sourceDb.close();
  }
}

function hasExistingImport(destDb: DatabaseSync, sourcePath: string): boolean {
  const row = destDb.prepare(`
    SELECT import_id FROM engram_import_runs WHERE source_kind = 'qmd' AND source_path = ? LIMIT 1
  `).get(sourcePath) as { import_id?: string } | undefined;
  return typeof row?.import_id === "string";
}

function tableExists(db: DatabaseSync, tableName: string): boolean {
  const row = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1`).get(tableName) as { name?: string } | undefined;
  return row?.name === tableName;
}

function mapQmdDocId(id: number, collection: string, relPath: string): string {
  return `qmd:${collection}:${relPath}:${id}`;
}

