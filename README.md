# Engram

Engram is an all-in-one OpenClaw memory plugin. It replaces the old split between transcript capture, session compaction, document retrieval, and proactive recall with one SQLite-backed memory system that lives inside OpenClaw.

It does four jobs at once:

- captures conversation history into a durable local store
- compacts old context into a summary graph that can be reassembled later
- indexes files, folders, imports, and session summaries into a searchable KB
- injects persona, approved facts, and relevant recall before prompt build

## Why It Exists

OpenClaw setups often end up with separate components for:

- raw memory capture
- long-context compression
- document indexing
- proactive memory injection

Engram folds those into one plugin and one database:

- one transcript store
- one summary DAG
- one KB index
- one fact/governance layer
- one command and tool surface

That makes the system easier to run, easier to migrate, and much easier to reason about when something goes wrong.

## What Engram Does

### 1. Persistent Transcript Storage

Every turn is stored in `engram.db` using:

- `conversations`
- `messages`
- `message_parts`
- `context_items`

Engram keeps enough structure to rebuild context later instead of treating the session as a flat log file.

### 2. Multi-Level Context Compaction

Old raw messages are compacted into:

- leaf summaries
- condensed higher-depth summaries
- lineage links through `summary_messages` and `summary_parents`

Compaction can use the active OpenClaw runtime model, or fall back to a deterministic built-in summarizer if runtime subagents are unavailable.

### 3. Proactive Recall

Before prompt build, Engram can inject:

- persona
- approved durable facts
- KB hits
- session-summary recall

Recall is designed to stay useful instead of noisy. It suppresses trivial prompts, avoids repeating very recent context, and can rerank candidates with embeddings when enabled.

### 4. Knowledge Base Indexing

Engram can index:

- individual files
- directories
- configured KB collections
- imported qmd data
- compacted session summaries

That gives the agent one search path across project docs, migrated data, and session-derived memory.

### 5. Durable Fact Memory

Engram stores governed facts in `kb_facts`, with:

- memory classes
- approval state
- scope
- expiry
- deprecation history
- conflict surfacing

This is the part of Engram meant for stable, high-value memory rather than raw transcript recall.

### 6. Data Lifecycle Maintenance

Engram now includes lifecycle controls to keep the database healthy over time:

- write-time message truncation
- noisy-content sanitization
- summary quality scoring
- LCM leaf re-summarization
- maintenance runs with WAL checkpoint, `ANALYZE`, `VACUUM`, and FTS rebuild
- optional pruning of older fully summarized raw conversations
- DB size and compression reporting in status output

## Mental Model

Engram works like this:

1. A conversation turn is stored durably.
2. Older context is replaced by summaries when it is safe to do so.
3. Summaries can themselves be condensed into higher-order summaries.
4. Important files and documents are chunked and indexed into the KB.
5. Facts can be stored with governance and approval rules.
6. Before the next prompt, Engram injects only the most useful memory.

The result is a memory system that gets denser and more useful over time instead of just getting bigger.

## Key Features

- Persistent transcript storage in SQLite
- Context assembly from raw messages plus summary graph state
- Session continuity via `session_end_artifacts`
- Runtime-backed and fallback summarization
- Multi-depth compaction with summary lineage
- KB indexing for files, directories, imports, and session summaries
- Optional embedding-backed reranking
- Persona injection
- Durable facts with approval workflow
- Conflict surfacing for overlapping facts
- Migration from existing lossless-claw and qmd stores
- Lifecycle maintenance and pruning controls
- DB size, depth, and compression observability

## Commands

Engram registers `/engram` with these subcommands:

- `/engram`
- `/engram doctor`
- `/engram migrate`
- `/engram migrate --dry-run`
- `/engram migrate --resummarize-lcm`
- `/engram search <query>`
- `/engram get <id>`
- `/engram index`
- `/engram index <path>`
- `/engram review`
- `/engram conflicts`
- `/engram approve <factId>`
- `/engram reject <factId>`
- `/engram forget <factId> [reason]`
- `/engram persona`
- `/engram persona set <text>`
- `/engram export [path]`
- `/engram compact`
- `/engram maintain`

### Command Guide

- `/engram`: prints current status, config flags, and available commands
- `/engram doctor`: runs diagnostics over DB health, FTS readiness, embeddings, imports, and fact state
- `/engram migrate`: imports detected lossless-claw and qmd data
- `/engram migrate --dry-run`: shows what would be imported without changing data
- `/engram migrate --resummarize-lcm`: repairs low-quality imported LCM leaf summaries
- `/engram search`: searches KB chunks and approved facts
- `/engram get`: fetches a KB document by id, chunk id, or path
- `/engram index`: syncs configured KB collections
- `/engram index <path>`: indexes a specific file or directory
- `/engram review`: lists pending facts
- `/engram conflicts`: lists unresolved fact conflicts
- `/engram approve` and `/engram reject`: resolves pending facts
- `/engram forget`: deprecates a fact without erasing audit history
- `/engram persona`: reads the persona file
- `/engram persona set`: writes or clears the persona file
- `/engram export`: exports persona and facts to Markdown
- `/engram compact`: forces a compaction pass
- `/engram maintain`: runs lifecycle maintenance and reports the result

## Tools

Engram exposes these agent tools:

- `engram_status`
- `engram_search`
- `engram_get`
- `engram_index`
- `engram_export`
- `engram_persona`
- `engram_remember`
- `engram_forget`
- `engram_review`

### Tool Guide

- `engram_status`: returns a full status snapshot including DB metrics
- `engram_search`: searches KB content and approved facts
- `engram_get`: fetches a full KB document
- `engram_index`: indexes a file or directory
- `engram_export`: exports persona and facts
- `engram_persona`: reads or writes the persona file
- `engram_remember`: stores a governed fact
- `engram_forget`: deprecates a fact while preserving audit history
- `engram_review`: approves or rejects pending facts

## Configuration

Defaults resolve relative to `OPENCLAW_STATE_DIR` when available, otherwise `~/.openclaw`.

### Core Paths

- `enabled`
- `dbPath`
- `personaPath`
- `exportPath`

### Summarization

- `summarizationProvider`
- `summarizationModel`
- `contextThreshold`
- `freshTailCount`
- `leafChunkTokens`
- `leafTargetTokens`
- `condensedTargetTokens`
- `incrementalMaxDepth`
- `compactionMaxDepth`
- `newSessionRetainDepth`
- `summaryQualityThreshold`

### KB And Embeddings

- `kbEnabled`
- `kbCollections`
- `kbAutoIndexSessions`
- `kbSessionIndexCircuitBreaker`
- `kbAutoIndexOnStart`
- `embedEnabled`
- `embedApiUrl`
- `embedApiModel`
- `embedApiKey`
- `embedBatchSize`
- `kbSearchTimeoutMs`
- `maxSearchCandidates`

### Recall

- `recallEnabled`
- `recallMaxTokens`
- `recallMaxResults`
- `recallPrependMaxTokens`
- `recallShadowMode`
- `recallShadowLogFile`
- `recallKeywordBypassMinLength`
- `recallKeywordBypassMaxTerms`
- `recallRrfK`
- `recallMinScore`
- `recallGapThreshold`
- `recallHighConfidenceScore`

### Lifecycle And Retention

- `maxMessageContentBytes`
- `pruneSummarizedMessages`
- `pruneMinAgeDays`
- `dbSizeWarningMb`

### Legacy Aliases Still Accepted

Engram still maps older config keys onto the new schema, including:

- `personaFile`
- `summaryProvider`
- `summaryModel`
- `collections`
- `autoIndexOnStart`
- `indexSessions`
- `sessionIndexCircuitBreaker`
- `searchTimeoutMs`
- `searchCandidates`
- `embeddingEnabled`
- `embeddingApiUrl`
- `embeddingModel`
- `embeddingApiKey`
- `embeddingBatchSize`

## Example Config

```json
{
  "enabled": true,
  "dbPath": "~/.openclaw/engram.db",
  "personaPath": "~/.openclaw/engram-persona.md",
  "exportPath": "~/.openclaw/engram-export.md",
  "kbEnabled": true,
  "recallEnabled": true,
  "kbCollections": [
    {
      "name": "docs",
      "path": "/srv/project/docs",
      "pattern": "**/*.md",
      "description": "Project documentation"
    }
  ],
  "kbAutoIndexOnStart": true,
  "kbAutoIndexSessions": true,
  "embedEnabled": false,
  "freshTailCount": 8,
  "leafTargetTokens": 2000,
  "condensedTargetTokens": 1500,
  "compactionMaxDepth": 3,
  "maxMessageContentBytes": 32768,
  "summaryQualityThreshold": 50,
  "pruneSummarizedMessages": false,
  "pruneMinAgeDays": 90,
  "dbSizeWarningMb": 2000,
  "recallMaxResults": 3
}
```

## Data Lifecycle

### Sanitization

Before storing or reusing content, Engram strips noisy content such as:

- raw timestamp prefixes from imported dumps
- `Conversation info (untrusted metadata)` blocks
- `<preconscious-memory>` blocks
- base64 image blobs and inline image payloads

### Truncation

Engram can cap stored content at write time with `maxMessageContentBytes`, which is especially useful for:

- oversized tool outputs
- logs
- long API responses
- embedded binary text

### Summary Quality

Engram assigns a `quality_score` to summaries and avoids promoting obviously bad summaries into higher-level context. This helps prevent the summary tree from becoming a compressed copy of junk input.

### Re-Summarization

`/engram migrate --resummarize-lcm` revisits imported LCM leaf summaries that look like raw dumps instead of real summaries.

### Maintenance

`/engram maintain` can:

- checkpoint the WAL
- rebuild FTS indexes when present
- run `ANALYZE`
- run `VACUUM`
- prune old raw messages for fully summarized conversations when enabled

## Storage Layout

Primary files:

- `engram.db`
- `engram-persona.md`
- `engram-export.md`

Important DB areas:

- transcript: `conversations`, `messages`, `message_parts`
- compaction DAG: `summaries`, `summary_messages`, `summary_parents`, `context_items`
- KB: `kb_collections`, `kb_documents`, `kb_chunks`, `kb_embeddings`
- durable memory: `kb_facts`, `kb_conflicts`
- continuity: `session_end_artifacts`
- import audit: `engram_import_runs`

## Retrieval Behavior

Recall is not just "search everything and dump it into the prompt." Engram applies structure:

- persona is injected through `prependSystemContext`
- approved facts participate in recall alongside KB hits
- session-summary chunks are ranked below primary documents
- embeddings can rerank lexical candidates when enabled
- retrieval suppresses trivial prompts and already-present recent context
- fact and KB scoring use thresholds and gap checks to avoid noisy injections

## Migration

Engram supports migration from:

- lossless-claw
- qmd

The migration path is meant to preserve value while consolidating systems into one runtime and one database.

Typical flow:

1. Run `/engram migrate --dry-run`
2. Run `/engram migrate`
3. Re-index configured collections if needed
4. Run `/engram migrate --resummarize-lcm` for imported low-quality summaries
5. Run `/engram maintain`

## Operational Notes

### Known Tradeoff

Engram currently performs compaction inline during `afterTurn`. That keeps behavior deterministic and simple, but it can reduce prompt-cache hit rates on hosts that benefit from deferred compaction.

### Runtime Behavior

When `summarizationProvider` and `summarizationModel` are omitted, Engram uses the active OpenClaw runtime defaults.

If runtime subagents are unavailable or the summarizer call fails, Engram falls back to deterministic summarization instead of failing hard.

## Validation

Current local validation:

- `npm run typecheck`
- `npm test`

The test suite covers:

- config resolution
- migration detection and import
- KB indexing and search
- recall injection
- persona behavior
- compaction behavior
- engine lifecycle behavior
- durable fact lifecycle
- conflict surfacing
- integration flows

## At A Glance

If you only need the short version:

- Engram stores sessions durably.
- It compresses them into a summary DAG.
- It indexes docs and summaries into a KB.
- It stores governed facts.
- It injects useful memory back into the prompt.
- It now includes lifecycle controls to keep memory quality high and database growth under control.
