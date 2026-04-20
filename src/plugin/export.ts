import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { EngramConfig } from "../config.js";

export function exportMemories(config: EngramConfig, outputPath?: string): { path: string; content: string } {
  const targetPath = outputPath?.trim() || config.exportPath;
  const lines: string[] = [
    "# Engram Export",
    "",
    `Generated: ${new Date().toISOString()}`,
    `Database: ${config.dbPath}`,
    "",
  ];

  if (existsSync(config.dbPath)) {
    const db = new DatabaseSync(config.dbPath, { open: true, readOnly: true });
    try {
      appendConversationSummary(db, lines);
      appendKbCollections(db, lines);
    } finally {
      db.close();
    }
  } else {
    lines.push("_No database found — nothing to export._", "");
  }

  const content = lines.join("\n");
  mkdirSync(dirname(targetPath), { recursive: true });
  writeFileSync(targetPath, content, "utf8");
  return { path: targetPath, content };
}

function appendConversationSummary(db: DatabaseSync, lines: string[]): void {
  const conversations = (db.prepare("SELECT COUNT(*) AS count FROM conversations").get() as { count?: number })?.count ?? 0;
  const messages = (db.prepare("SELECT COUNT(*) AS count FROM messages").get() as { count?: number })?.count ?? 0;
  const summaries = (db.prepare("SELECT COUNT(*) AS count FROM summaries").get() as { count?: number })?.count ?? 0;

  lines.push("## Conversation Store", "");
  lines.push(`- Conversations: ${conversations}`);
  lines.push(`- Messages: ${messages}`);
  lines.push(`- Summaries: ${summaries}`);
  lines.push("");

  const recentConvs = db.prepare(
    `SELECT conversation_id AS id, session_key AS sessionKey, created_at AS createdAt
     FROM conversations ORDER BY created_at DESC LIMIT 10`,
  ).all() as Array<{ id: string; sessionKey?: string; createdAt: string }>;

  if (recentConvs.length > 0) {
    lines.push("### Recent Conversations (last 10)", "");
    for (const conv of recentConvs) {
      lines.push(`- \`${conv.id}\`${conv.sessionKey ? ` (${conv.sessionKey})` : ""} — ${conv.createdAt}`);
    }
    lines.push("");
  }
}

function appendKbCollections(db: DatabaseSync, lines: string[]): void {
  const collections = db.prepare(
    `SELECT c.name, c.path, c.description,
            COUNT(DISTINCT d.doc_id) AS docCount,
            COUNT(DISTINCT k.chunk_id) AS chunkCount
     FROM kb_collections c
     LEFT JOIN kb_documents d ON d.collection_name = c.name
     LEFT JOIN kb_chunks k ON k.collection_name = c.name
     GROUP BY c.name ORDER BY c.name`,
  ).all() as Array<{ name: string; path: string; description?: string; docCount: number; chunkCount: number }>;

  lines.push("## Knowledge Base", "");
  if (collections.length === 0) {
    lines.push("_No collections indexed._", "");
    return;
  }

  for (const col of collections) {
    lines.push(`### \`${col.name}\``);
    lines.push(`- Path: ${col.path}`);
    if (col.description) lines.push(`- Description: ${col.description}`);
    lines.push(`- Documents: ${col.docCount}, Chunks: ${col.chunkCount}`);
    lines.push("");

    const docs = db.prepare(
      `SELECT rel_path AS relPath, title, indexed_at AS indexedAt
       FROM kb_documents WHERE collection_name = ? ORDER BY indexed_at DESC LIMIT 50`,
    ).all(col.name) as Array<{ relPath: string; title: string; indexedAt: string }>;
    for (const doc of docs) {
      lines.push(`  - ${doc.relPath} — _${doc.title}_ (${doc.indexedAt})`);
    }
    lines.push("");
  }
}
