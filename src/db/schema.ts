export const SCHEMA_VERSION = 7;

export const SCHEMA_STATEMENTS = [
  `
  CREATE TABLE IF NOT EXISTS engram_migrations (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL,
    description TEXT NOT NULL,
    source_path TEXT
  )
  `,
  `
  CREATE TABLE IF NOT EXISTS conversations (
    conversation_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    session_key TEXT,
    created_at TEXT NOT NULL
  )
  `,
  `
  CREATE TABLE IF NOT EXISTS messages (
    message_id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    seq INTEGER NOT NULL DEFAULT 0,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    token_count INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    FOREIGN KEY (conversation_id) REFERENCES conversations(conversation_id)
  )
  `,
  `
  CREATE TABLE IF NOT EXISTS message_parts (
    part_id TEXT PRIMARY KEY,
    message_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    part_type TEXT NOT NULL,
    ordinal INTEGER NOT NULL,
    text_content TEXT,
    tool_call_id TEXT,
    tool_name TEXT,
    tool_input TEXT,
    tool_output TEXT,
    metadata TEXT,
    FOREIGN KEY (message_id) REFERENCES messages(message_id)
  )
  `,
  `
  CREATE TABLE IF NOT EXISTS summaries (
    summary_id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    depth INTEGER NOT NULL DEFAULT 0,
    content TEXT NOT NULL,
    quality_score INTEGER NOT NULL DEFAULT 0,
    token_count INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    FOREIGN KEY (conversation_id) REFERENCES conversations(conversation_id)
  )
  `,
  `
  CREATE TABLE IF NOT EXISTS kb_collections (
    name TEXT PRIMARY KEY,
    path TEXT NOT NULL,
    pattern TEXT NOT NULL DEFAULT '**/*.md',
    description TEXT,
    auto_index INTEGER NOT NULL DEFAULT 0,
    fts5_available INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
  `,
  `
  CREATE TABLE IF NOT EXISTS kb_documents (
    doc_id TEXT PRIMARY KEY,
    collection_name TEXT NOT NULL,
    rel_path TEXT NOT NULL,
    title TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    token_count INTEGER NOT NULL DEFAULT 0,
    indexed_at TEXT NOT NULL,
    FOREIGN KEY (collection_name) REFERENCES kb_collections(name)
  )
  `,
  `
  CREATE TABLE IF NOT EXISTS kb_chunks (
    chunk_id TEXT PRIMARY KEY,
    doc_id TEXT NOT NULL,
    collection_name TEXT NOT NULL,
    ordinal INTEGER NOT NULL,
    content TEXT NOT NULL,
    token_count INTEGER NOT NULL DEFAULT 0,
    chunk_hash TEXT NOT NULL,
    derivation_depth INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (doc_id) REFERENCES kb_documents(doc_id),
    FOREIGN KEY (collection_name) REFERENCES kb_collections(name)
  )
  `,
  `
  CREATE TABLE IF NOT EXISTS kb_embeddings (
    chunk_id TEXT NOT NULL,
    model TEXT NOT NULL,
    vector BLOB,
    dimensions INTEGER,
    created_at TEXT NOT NULL,
    PRIMARY KEY (chunk_id, model),
    FOREIGN KEY (chunk_id) REFERENCES kb_chunks(chunk_id)
  )
  `,
  `
  CREATE TABLE IF NOT EXISTS summary_messages (
    summary_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    ordinal INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (summary_id, message_id),
    FOREIGN KEY (summary_id) REFERENCES summaries(summary_id),
    FOREIGN KEY (message_id) REFERENCES messages(message_id)
  )
  `,
  `
  CREATE TABLE IF NOT EXISTS summary_parents (
    summary_id TEXT NOT NULL,
    parent_summary_id TEXT NOT NULL,
    ordinal INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (summary_id, parent_summary_id),
    FOREIGN KEY (summary_id) REFERENCES summaries(summary_id),
    FOREIGN KEY (parent_summary_id) REFERENCES summaries(summary_id)
  )
  `,
  `
  CREATE TABLE IF NOT EXISTS context_items (
    conversation_id TEXT NOT NULL,
    ordinal INTEGER NOT NULL,
    item_type TEXT NOT NULL,
    message_id TEXT,
    summary_id TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (conversation_id, ordinal),
    FOREIGN KEY (conversation_id) REFERENCES conversations(conversation_id),
    FOREIGN KEY (message_id) REFERENCES messages(message_id),
    FOREIGN KEY (summary_id) REFERENCES summaries(summary_id)
  )
  `,
  `
  CREATE TABLE IF NOT EXISTS large_files (
    file_id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    file_name TEXT,
    mime_type TEXT,
    byte_size INTEGER,
    storage_uri TEXT NOT NULL,
    exploration_summary TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY (conversation_id) REFERENCES conversations(conversation_id)
  )
  `,
  `
  CREATE TABLE IF NOT EXISTS engram_import_runs (
    import_id TEXT PRIMARY KEY,
    source_kind TEXT NOT NULL,
    source_path TEXT NOT NULL,
    record_counts_json TEXT NOT NULL,
    imported_at TEXT NOT NULL,
    UNIQUE (source_kind, source_path)
  )
  `,
] as const;
