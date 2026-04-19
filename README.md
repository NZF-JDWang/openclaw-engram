# Engram

Engram is a standalone OpenClaw memory plugin that gives an agent persistent recall, structured knowledge, and persona continuity — all backed by a single SQLite database.

It combines three roles in one package:

- **Context engine** — persistent transcript storage with multi-level compaction, so conversations survive context window limits
- **Knowledge base** — searchable index over imported documents, indexed directories, and compacted session summaries
- **Proactive recall** — injects persona, approved facts, and relevant KB results into context before the prompt is built

No external services required. No separate databases to manage. One plugin, one store.

## Current Features

- Persistent transcript storage in `engram.db`
- Context assembly from `messages`, `summaries`, and `context_items`
- Session continuity via `session_end_artifacts`
- Runtime-backed leaf and condensed compaction when plugin runtime subagents are available, with deterministic fallback and `summary_parents` lineage
- Searchable KB indexing for files, directories, and compacted session summaries
- Configured KB collections can be synced automatically on plugin startup
- Optional embedding generation and `kb_embeddings` storage during indexing
- Persona file injection via `prependSystemContext`
- Approved fact storage, review, export, search, and recall
- Lightweight conflict surfacing for similar durable facts
- Migration from existing legacy memory stores

## Commands

Engram registers the `/engram` command with these subcommands:

- `/engram`
- `/engram doctor`
- `/engram migrate`
- `/engram migrate --dry-run`
- `/engram search <query>`
- `/engram get <id>`
- `/engram index <path>`
- `/engram review`
- `/engram conflicts`
- `/engram approve <factId>`
- `/engram reject <factId>`
- `/engram persona`
- `/engram persona set <text>`
- `/engram export [path]`
- `/engram compact`

## Tools

Engram currently exposes these tools:

- `engram_status`
- `engram_search`
- `engram_get`
- `engram_index`
- `engram_export`
- `engram_persona`
- `engram_remember`
- `engram_forget`
- `engram_review`

## Config

Supported plugin config keys:

- `enabled`
- `dbPath`
- `personaPath`
- `exportPath`
- `summarizationProvider`
- `summarizationModel`
- `kbEnabled`
- `kbCollections`
- `kbAutoIndexSessions`
- `kbSessionIndexCircuitBreaker`
- `kbAutoIndexOnStart`
- `recallEnabled`
- `embedEnabled`
- `embedApiUrl`
- `embedApiModel`
- `embedApiKey`
- `embedBatchSize`
- `contextThreshold`
- `freshTailCount`
- `leafChunkTokens`
- `leafTargetTokens`
- `condensedTargetTokens`
- `incrementalMaxDepth`
- `newSessionRetainDepth`
- `kbSearchTimeoutMs`
- `maxSearchCandidates`
- `recallMaxTokens`
- `recallMaxResults`
- `recallPrependMaxTokens`
- `recallMinScore`
- `recallGapThreshold`
- `recallHighConfidenceScore`

Defaults are resolved relative to `OPENCLAW_STATE_DIR` when available, otherwise `~/.openclaw`.

Legacy config aliases are still accepted and mapped onto current keys.

When `summarizationProvider` and `summarizationModel` are omitted, Engram uses the active OpenClaw runtime defaults. If runtime subagents are unavailable or the summarizer call fails, compaction falls back to the built-in deterministic summarizer.

## Known Tradeoff

Engram currently performs compaction inline in `afterTurn`. That keeps the implementation simple and deterministic, but it can reduce prompt-cache hit rates on hosts that benefit from deferred or cache-aware compaction strategies. This is a known performance tradeoff, not a data-integrity issue.

## Storage Layout

Primary files:

- `engram.db`: main SQLite store
- `engram-persona.md`: always-injected persona file
- `engram-export.md`: markdown export of persona and facts

Important logical areas inside the database:

- transcript: `conversations`, `messages`, `message_parts`
- compaction DAG: `summaries`, `summary_messages`, `summary_parents`, `context_items`
- KB: `kb_collections`, `kb_documents`, `kb_chunks`, `kb_embeddings`
- durable memory: `kb_facts`, `kb_conflicts`, `session_end_artifacts`

## Retrieval Behavior

- Persona is injected first through `prependSystemContext`
- Approved facts are searched alongside KB results
- Stored embeddings can rerank lexical KB candidates when embedding search is enabled
- Configured collection sync respects each collection's declared glob pattern before indexing
- Session-summary chunks in `__sessions` are ranked below primary documents
- Retrieval applies temporal decay by memory type
- The recall hook suppresses trivial prompts and snippets already present in recent non-user context

## Validation

Current local validation status:

- `npm run typecheck`
- `npm test`

The current suite covers config resolution, migration detection/import, KB search and indexing, recall injection, persona injection, compaction, engine behavior, fact lifecycle, and conflict surfacing.