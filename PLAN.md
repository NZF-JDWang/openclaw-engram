# engram — Unified OpenClaw Memory System

## Vision

A single standalone OpenClaw plugin that replaces `lossless-claw`, `qmd`, and `precog` with one unified, in-process memory system. No native binaries, no subprocesses, no cross-repo dependencies.

**Three layers, one plugin:**

| Layer | Replaces | What it does |
|---|---|---|
| Context Engine | lossless-claw | DAG-based conversation compression so no history is ever lost |
| Knowledge Base | qmd | Index + search markdown files and session summaries with BM25 + optional vectors |
| Proactive Recall | precog | Automatically inject relevant memories before each model turn |

Registers as `kind: "context-engine"` — the same exclusive slot as lossless-claw. Installing engram replaces it.

---

## Summarization & LLM Usage

Compaction (history compression) requires an LLM to produce useful summaries. Engram reuses the **model already configured in OpenClaw** via `api.runtime` — no second model is needed. An optional `summarizationModel` / `summarizationProvider` config lets power users route compaction to a cheaper/faster model to save cost.

**Three-level escalation ensures compaction never catastrophically fails:**

1. **Normal** — standard summarization prompt, temperature 0.2
2. **Aggressive** — tighter prompt, lower target tokens, temperature 0.1
3. **Extractive fallback** — no LLM required; TF-IDF sentence scoring keeps the highest-information sentences within token budget, appends `[Summarized — extractive fallback]` marker. Always succeeds.

---

## System Invariants

These rules are non-negotiable and must be upheld by every module. Implementation decisions that violate these require an explicit override with justification.

1. **Raw transcript is immutable.** Messages, once written to `messages` + `message_parts`, are never modified or deleted — only `context_items` pointers change during compaction.
2. **Derived artifacts never overwrite raw evidence.** A summary that covers messages M1–M10 does not delete M1–M10; it replaces only their `context_items` entries.
3. **Agent-inferred facts never auto-promote to highest-trust memory.** Only the user or an explicit admin action may write to `persona.md`. Agent writes go to `kb_facts` with `approval_state: "pending"`.
4. **Every injected memory must carry provenance.** The `<recall>` and `<persona>` blocks injected into context must include `source_kind` and originating date.
5. **Supersession is explicit; old facts are not silently replaced.** When a fact is superseded, the old row gets `superseded_by` set and `lifecycle_state` set to `"superseded"`. It remains queryable for audit.
6. **Forgetting hides but does not destroy.** `engram_forget` sets `deprecated_at` and removes from search results; the row is retained for audit. Permanent deletion is a separate admin operation.
7. **Search ranking is memory-class-aware.** A session summary may not outrank a user-stated fact without a large relevance margin. The source hierarchy (§ Memory Class Hierarchy) is enforced in scoring.
8. **A more-derived artifact does not outrank a less-derived one without strong justification.** Continuity summaries rank below session summaries rank below raw KB documents rank below explicit user-stated facts.
9. **Highest-trust memory has the hardest write path.** The `persona.md` read path is fast and always-on; the write path requires user approval or explicit `/engram persona set` command.
10. **Memory write and memory recall are independently testable.** No module that handles recall injection should also trigger writes.

---

## Memory Class Hierarchy

Engram distinguishes four memory classes. Each class has different write rules, decay behaviour, and injection trust level.

| Class | Examples | Write path | Decay | Injection tier |
|---|---|---|---|---|
| **Identity / Preference** | name, communication style, hard constraints | User only (or explicit `engram_remember --class identity`) | None | System context (always injected) |
| **Project / Domain State** | current project, architectural decisions, chosen defaults | Agent-proposed → user-approved | Slow (180-day half-life) | Working memory block |
| **Task / Session Context** | what we were doing last turn, current plan | Agent-written, session-scoped | Aggressive (7-day half-life) | Low-priority recall block |
| **Reference / Document** | indexed markdown files, session summaries | Auto (indexing) or agent | Medium (90-day half-life, bypassed for exact keywords) | Citation block (low trust) |

The `memory_class` field is stored on every `kb_facts` row and every KB chunk. Scoring, injection, and decay all branch on this value.

---

## Memory Lifecycle States

Every fact in `kb_facts` (and eventually KB chunks) follows this state machine:

```
captured → candidate → validated → durable
                                      ↓
                                 deprecated (hidden from search, retained for audit)
                                      ↓
                                 superseded (replaced by newer fact, old row kept)
                                      ↓
                                   expired (TTL elapsed)
```

| State | Who sets it | Search visible? |
|---|---|---|
| `captured` | Auto on write | No (pending review) |
| `candidate` | Auto after dedup/conflict check | No |
| `validated` | Agent or user confirmation | Yes |
| `durable` | User explicit approval or time passage | Yes (boosted) |
| `deprecated` | `engram_forget` | No |
| `superseded` | Explicit supersession | No (but audit-queryable) |
| `expired` | TTL elapsed | No |

Agent-inferred facts start at `captured`. Only user-stated facts may start at `candidate` and skip straight to `validated`.

---

## Improvements Over Existing Repos

New capabilities not present in any of the three source repos:

### 1. Memory Provenance & Confidence
Every stored memory tracks its source: which conversation, which date, and whether it was user-stated, agent-inferred, or document-derived. Injected context carries this attribution so the model can reason about reliability.

### 2. Conflict Surfacing (v1) / Contradiction Detection (v2)
**v1:** When indexing new information, engram runs a fast similarity check against existing entries. Pairs with cosine similarity > 0.80 are written to `kb_conflicts` as "possible conflicts" for the user to review — but indexing is not blocked.  
**v2 (deferred):** A lightweight LLM call with a `"does this contradict?"` prompt is run on flagged pairs and the verdict stored. This is deferred because cosine + sentiment markers alone produce too many false positives to be useful, and adding an LLM call per-index is expensive.

### 3. Temporal Decay Scoring (Per Memory Class)
Decay is applied per memory class, not globally. Identity facts never decay. Reference documents decay at 90 days. Session context decays at 7 days. Exact keyword matches bypass decay regardless of class.

**Formula:** `finalScore = rawScore * exp(-λ * daysSinceIndexed)` where `λ = ln(2) / halfLifeDays`.

### 4. Persona / Identity Layer
A `persona.md` file — configurable path, defaults to `~/.openclaw/engram-persona.md` — holds user identity, preferences, and hard constraints. Always injected at the top of context without going through search. **User writes only.** The agent proposes facts via `engram_remember --class identity`; these go to `kb_facts` with `approval_state: "pending"` and surface in `/engram review` for the user to approve or reject.

### 5. Structured Explicit Memory Tools
`engram_remember` requires structured intent — memory class, source basis, scope, and optional TTL. This prevents the model from freely writing to high-trust memory tiers. See Phase 7 for the full interface.

### 6. Session-to-Session Continuity via Session-End Artifact
When a session ends cleanly, engram creates a structured `session_end_artifact` — not just the deepest summary, but a purpose-built orientation record with: what the user was trying to do, decisions made, open questions, and suggested re-entry context. The *next* session bootstrap uses this artifact (not the deepest summary, which is the most abstract and the least safe for restart).

### 7. Memory Export / Human Review
`/engram export` writes all memories to a structured markdown file. The file is a valid KB collection — user edits are re-indexed on next `/engram index`. Full ownership and transparency.

### 8. Decision Ledger
Structured preservation of commitments, chosen defaults, accepted plans, and explicit user constraints — as rows in `kb_facts` with `memory_class: "project"` and `source_basis: "decision"`. These are never compressed away during compaction and are prioritised in recall injection.

---

## v1 Scope vs. v2 Deferred Features

This table prevents scope creep and sets clear expectations.

| Feature | Scope | Notes |
|---|---|---|
| Context engine (LCM compaction) | **v1** | Core; replaces lossless-claw |
| KB indexing + BM25 search | **v1** | Core; replaces qmd |
| Proactive recall injection | **v1** | Core; replaces precog |
| Persona layer (read-always, user-write) | **v1** | |
| Memory lifecycle states | **v1** (captured/validated/durable/deprecated) | Full 7-state machine is v1.5 |
| Temporal decay (per memory class) | **v1** | |
| Data migration from lossless-claw/qmd | **v1 (Phase 0)** | Must happen before user adoption |
| Conflict surfacing (fast cosine flag) | **v1** | |
| Session-end artifact for continuity | **v1** | |
| Decision ledger | **v1** | |
| Conflict detection with LLM verification | **v2** | |
| Full vector k-NN search | **v2** | v1 uses BM25-pre-filter + JS cosine over candidates |
| Entity resolution | **v2** | |
| Scope-aware fact federation | **v2** | (global/agent/project/session scopes) |

---

## Phases

### Phase 0 — Migration

*This phase must be designed and implemented before any other code touches data. Migration is not a Phase 11 afterthought — if the schema is locked in without migration paths, we paint ourselves into data-loss corners.*

**The problem:** Users currently have live data in:
- `~/.openclaw/lcm.db` — lossless-claw's SQLite DB (conversations, messages, summaries, context_items, large_files)
- `~/.cache/qmd/index.sqlite` (or named variants) — QMD's document index (documents, content, content_vectors, vectors_vec)
- Precog has no persistent state (it was stateless)

**Migration strategy:** One-time idempotent import on first launch, plus a standalone `engram migrate` CLI command.

**`src/migrate/detect.ts`** — `detectExistingData(): MigrationSources`
- Checks for `lcm.db` at `OPENCLAW_STATE_DIR` or `~/.openclaw/`
- Checks for QMD index at `~/.cache/qmd/*.sqlite`
- Returns a manifest of what was found, with sizes and record counts
- Non-destructive — never opens found DBs for write

**`src/migrate/lcm-importer.ts`** — `importFromLcm(srcDb, destDb): LcmImportResult`
- Opens source `lcm.db` read-only
- Maps lossless-claw schema → engram schema:
  - `conversations` → `conversations` (direct mapping, add `agent_id` from session_key prefix)
  - `messages` → `messages` (direct)
  - `message_parts` → `message_parts` (direct)
  - `summaries` → `summaries` (direct; add `lifecycle_state: "durable"`, `memory_class: "task"`)
  - `summary_messages` → `summary_messages` (direct)
  - `summary_parents` → `summary_parents` (direct)
  - `context_items` → `context_items` (direct)
  - `large_files` → `large_files` (direct)
  - `conversation_bootstrap_state` → `engram_bootstrap_state`
- Runs inside a single DB transaction; on failure rolls back entirely
- Writes import record to `engram_migrations` with source path, record counts, timestamp
- Idempotent: checks for existing import record before running

**`src/migrate/qmd-importer.ts`** — `importFromQmd(srcDb, destDb): QmdImportResult`
- Opens source QMD SQLite read-only
- Maps QMD schema → engram KB schema:
  - `documents` → `kb_documents` (map `hash` → `doc_id`, `collection` → `collection_name`, `path` → `rel_path`)
  - `content` (full text) → re-chunks via `chunkDocument()`, inserts into `kb_chunks` + `kb_chunks_fts`
  - `store_collections` → `kb_collections`
  - Vectors in `vectors_vec` / `content_vectors`: exported as binary blobs into `kb_embeddings` if schema is compatible; skipped with a warning if not (user must re-index with `engram embed`)
- Also idempotent via `engram_migrations` record

**`src/migrate/runner.ts`** — `runMigration(opts): MigrationReport`
- Orchestrates `detect()` → `importFromLcm()` → `importFromQmd()`
- Dry-run mode: prints what would be imported without writing
- Progress reporting via callback (used by both CLI and auto-migrate on first launch)
- On completion: prints summary of records imported, warnings for skipped data

**`src/plugin/commands.ts`** addition:** `/engram migrate [--dry-run]`**

**Auto-migration on first launch:** In `src/plugin/entry.ts`, during `register()`: if `engram.db` does not yet exist and migration sources are detected, run migration before opening the new DB. Log the result. This is non-interactive — it always runs. The user can see the report via `/engram migrate --dry-run` beforehand.

**Config backward-compatibility:** `src/migrate/config-compat.ts` maps old lossless-claw / qmd / precog config keys to their engram equivalents. Applied during `resolveConfig()` with deprecation warnings.

---

### Phase 1 — Project Bootstrap

1. `package.json` — TypeScript ESM, `"type": "module"`, Node 22.16`+`; dev: `typescript`, `vitest`; peer: `openclaw/plugin-sdk`; no native runtime deps
2. `tsconfig.json` — `strict`, `module: "NodeNext"`, `target: "ES2022"`, `moduleResolution: "NodeNext"`
3. `openclaw.plugin.json` — `id: "engram"`, `kind: "context-engine"`, `configSchema`, `uiHints`
4. `index.ts` — re-exports `src/plugin/entry.ts` default
5. `vitest.config.ts` — mirrors lossless-claw's vitest config

---

### Phase 2 — Database Schema & Migrations

*All storage in a single `~/.openclaw/engram.db` via `node:sqlite` built-in (Node 22+). No native extensions required. The schema is physically one file but logically layered — four distinct responsibility zones that do not share write paths.*

**Logical layers (all in one DB, but treated as separate stores in code):**
- **Layer A — Immutable Transcript** (`conversations`, `messages`, `message_parts`): append-only after ingest
- **Layer B — Derived Compression DAG** (`summaries`, `summary_messages`, `summary_parents`, `context_items`): written only by compaction
- **Layer C — Knowledge Base Index** (`kb_collections`, `kb_documents`, `kb_chunks`, `kb_chunks_fts`, `kb_embeddings`): written only by the KB indexer
- **Layer D — Durable Facts** (`kb_facts`, `kb_conflicts`, `session_end_artifacts`): written only through the governed fact write path

**`src/db/schema.ts`** — SQL DDL constants:

**Layer A — Immutable Transcript:**

| Table | Key columns |
|---|---|
| `conversations` | `conversation_id`, `session_id`, `session_key`, `agent_id`, `title`, `bootstrapped_at`, `created_at` |
| `messages` | `message_id`, `conversation_id`, `seq`, `role`, `content`, `token_count`, `created_at` |
| `message_parts` | `part_id`, `message_id`, `part_type`, `ordinal`, `text_content`, `tool_call_id`, `tool_name`, `tool_input`, `tool_output` |

**Layer B — Derived Compression DAG:**

| Table | Key columns |
|---|---|
| `summaries` | `summary_id`, `conversation_id`, `kind` (leaf/condensed), `depth`, `content`, `token_count`, `earliest_at`, `latest_at`, `descendant_count`, `model`, `memory_class`, `lifecycle_state`, `created_at` |
| `summary_messages` | `summary_id`, `message_id` |
| `summary_parents` | `child_id`, `parent_id` |
| `context_items` | `conversation_id`, `ordinal`, `item_type` (message/summary), `message_id`, `summary_id` |
| `session_end_artifacts` | `artifact_id`, `conversation_id`, `agent_id`, `goal`, `decisions`, `open_questions`, `reentry_context`, `created_at` |

**Layer C — Knowledge Base Index:**

| Table | Key columns |
|---|---|
| `kb_collections` | `name`, `path`, `pattern`, `description`, `auto_index`, `fts5_available`, `created_at` |
| `kb_documents` | `doc_id` (content hash), `collection_name`, `rel_path`, `title`, `content_hash`, `token_count`, `indexed_at` |
| `kb_chunks` | `chunk_id`, `doc_id`, `collection_name`, `ordinal`, `content`, `token_count`, `chunk_hash`, `derivation_depth` (0=primary, 1=summary-derived) |
| `kb_chunks_fts` | FTS5 virtual table on `kb_chunks(content)` |
| `kb_embeddings` | `chunk_id`, `model`, `vector` (BLOB — binary float32 array, little-endian), `dimensions`, `created_at` |

> **Note on FTS5 fallback:** If FTS5 is unavailable (detected at migration time), KB search is limited to collections with fewer than 5,000 chunks and uses parameterised `LIKE` queries. Above that threshold, the collection is marked `fts5_required: true` and search is disabled with a clear error message from `/engram doctor`. FTS5 availability is stored in `kb_collections.fts5_available` at index time. The LIKE fallback is never silently used for large datasets.

> **Note on vector storage:** Vectors are stored as `BLOB` (binary float32 little-endian), not JSON text. The per-search read cost of parsing JSON across 50+ candidates is measurable and unnecessary.

**Layer D — Durable Facts:**

| Table | Key columns |
|---|---|
| `kb_facts` | `fact_id`, `content`, `memory_class` (identity/project/task/reference), `source_kind` (user_stated/agent_inferred/document_derived/decision), `source_basis`, `scope` (global/agent/project/session), `lifecycle_state`, `approval_state` (approved/pending/rejected), `superseded_by`, `deprecated_at`, `deprecated_reason`, `expires_at`, `created_at`, `updated_at` |
| `kb_conflicts` | `conflict_id`, `chunk_id_a`, `chunk_id_b`, `similarity_score`, `detected_at`, `resolved_at`, `resolution` |

**Meta:**

| Table | Key columns |
|---|---|
| `engram_migrations` | `version`, `applied_at`, `description`, `source_path` (for import records) |
| `engram_bootstrap_state` | `conversation_id`, `last_jsonl_offset`, `updated_at` |

**`src/db/connection.ts`** — `openDatabase(dbPath): DatabaseSync`
- Opens DB, calls `runMigrations()`, sets `PRAGMA journal_mode=WAL`, `PRAGMA foreign_keys=ON`, `PRAGMA synchronous=NORMAL`
- Returns wrapper with `db.transaction(fn)` helper and `retryOnBusy(fn, maxRetries=5)` — retries on `SQLITE_BUSY` with 10ms exponential backoff

**`src/db/migration.ts`** — `runMigrations(db)`: versioned additive migrations, attempts FTS5 creation, records `fts5_available` global flag

**Transaction strategy:**
- Every write path (`ingest`, `compact`, `indexDocument`, `writeFact`) wraps its SQL in `db.transaction()`
- `ingest` and `compact` must never run concurrently for the same `conversation_id` — guarded by `retryOnBusy`
- KB indexing (Layer C) and compaction (Layer B) write to different tables; no cross-layer transaction needed
- Layer D writes are always single-row operations; no transaction necessary beyond the implicit one

---

### Phase 3 — Config

**`src/config.ts`** — `EngramConfig` (TypeBox schema) + `resolveConfig(pluginConfig, env)`:

**Context engine (LCM):**
| Key | Default | Description |
|---|---|---|
| `contextThreshold` | `0.80` | Fraction of context window that triggers compaction |
| `freshTailCount` | `8` | Recent messages protected from compaction |
| `leafChunkTokens` | `20000` | Max source tokens per leaf compaction chunk |
| `leafTargetTokens` | `2000` | Target tokens for leaf summaries |
| `condensedTargetTokens` | `1500` | Target tokens for condensed summaries |
| `incrementalMaxDepth` | `1` | Depth cap for after-turn incremental compaction |
| `summarizationModel` | `""` | Override model for compaction (blank = use active model) |
| `summarizationProvider` | `""` | Override provider for compaction |
| `newSessionRetainDepth` | `-1` | Depth to retain on `/new` (-1 = all) |

**Knowledge base:**
| Key | Default | Description |
|---|---|---|
| `kbEnabled` | `true` | Enable KB indexing and search |
| `kbCollections` | `[]` | Array of `{name, path, pattern, description}` |
| `kbAutoIndexSessions` | `true` | Auto-index conversation summaries into `__sessions` collection |
| `kbSessionIndexCircuitBreaker` | `true` | Halt session summary indexing if derivation_depth > 1 (prevents feedback loops) |
| `kbAutoIndexOnStart` | `false` | Re-sync all collections on plugin load |
| `personaFile` | `""` | Path to `persona.md`; blank = `~/.openclaw/engram-persona.md` |
| `kbSearchTimeoutMs` | `150` | Hard timeout for KB search (ms) |
| `maxSearchCandidates` | `50` | BM25 candidates passed to JS vector re-rank |

**Recall injection:**
| Key | Default | Description |
|---|---|---|
| `recallEnabled` | `true` | Enable proactive recall injection |
| `recallMaxTokens` | `300` | Token budget for `appendSystemContext` recall block |
| `recallPrependMaxTokens` | `300` | Hard cap on total tokens accumulated in `prependSystemContext` across turns. When exceeded, oldest project-class injections are evicted. Prevents unbounded accumulation. |
| `recallMinScore` | `0.40` | Hard minimum normalised score [0,1] for injection. See scoring note below. |
| `recallMaxResults` | `3` | Max results to consider |
| `recallShadowMode` | `false` | Log but do not inject (calibration mode) |
| `recallShadowLogFile` | `""` | If set, append shadow log to this file (in addition to openclaw debug log) |
| `recallDecayHalfLifeDays` | See class table | Per-class overrides; class defaults apply |
| `recallGapThreshold` | `0.08` | Top normalised score must beat #2 by this margin |
| `recallHighConfidenceScore` | `0.75` | Bypasses gap check. Calibrated against normalised [0,1] range — see scoring note. |
| `recallRrfK` | `15` | RRF constant — k=15 is appropriate for personal memory scale (not k=60 which is web-scale) |
| `recallKeywordBypassMinLength` | `4` | Minimum characters for a query term to trigger decay bypass. Prevents common short words from defeating recency scoring. |
| `recallKeywordBypassMaxTerms` | `3` | Max number of query terms that can trigger decay bypass simultaneously. |

**Embeddings:**
| Key | Default | Description |
|---|---|---|
| `embedEnabled` | `false` | Enable vector embeddings (requires API endpoint) |
| `embedApiUrl` | `"http://localhost:11434/v1/embeddings"` | OpenAI-compatible embeddings endpoint |
| `embedApiModel` | `"nomic-embed-text"` | Model name passed in request body |
| `embedApiKey` | `""` | Bearer token (empty = no auth header) |
| `embedBatchSize` | `20` | Texts per embedding request |

*All paths resolved with `path.join()` / `os.homedir()` — no hardcoded Unix paths.*

---

### Phase 4 — Knowledge Base Engine

*Depends on Phase 2. Runs parallel with Phase 5.*

**`src/kb/chunker.ts`** — `chunkDocument(content, opts): Chunk[]`
- Heading-aware break-point scoring: `h1=100`, `h2=90`, `h3=80`, `blank-line=20`, `newline=1`
- Code-fence detection — never splits inside ` ``` ` block
- Target: 900 tokens / 135-token overlap
- Returns `{ordinal, content, startOffset, endOffset, tokenCount}`

**`src/kb/embeddings.ts`** — `EmbeddingClient`
- `embed(texts: string[]): Promise<number[][]>` — POST to `embedApiUrl`, OpenAI-compatible body
- Batching (respects `embedBatchSize`), 3-retry exponential backoff
- Returns `null` for each text if `embedEnabled: false` — chunks without embeddings are indexed for BM25 only, not marked as errors
- On partial failure (some batches succeed, some fail): successfully embedded chunks are stored; failed chunks get `embedding: null` — indexing is never aborted for embedding failures alone. Status visible in `/engram doctor`.

**`src/kb/store.ts`** — `KnowledgeBaseStore`
- `indexDocument(filePath, collectionName)` — read, chunk, hash-diff (skip unchanged chunks), FTS5 insert, optional embed; all in one DB transaction per document
- `indexCollection(collection)` — glob walk, only re-index changed documents (content-hash diff)
- `search(query, opts): Promise<KBSearchResult[]>`
  - BM25: FTS5 `MATCH` query (or `LIKE` fallback with explicit size check; disabled above `maxSearchCandidates` if FTS5 unavailable)
  - Vector (if enabled): embed query → cosine similarity in JS over the `maxSearchCandidates` BM25 pre-filtered results
  - **RRF fusion:** `score = Σ(1 / (k + rank_i))` where `k = recallRrfK` (default 15, not 60)
  - **Per-class time decay** applied after fusion
  - **Source hierarchy enforcement:** user-stated facts score-boosted by 1.5×; summary-derived chunks penalised by `0.7 * (1 / (1 + derivation_depth))`
  - Returns `{chunkId, docId, relPath, content, score, collectionName, memoryClass, sourceKind, indexedAt}`
- `flagConflicts(newChunkId)` — fast cosine check against top-20 similar existing chunks; write pairs with score > 0.80 to `kb_conflicts`. Does not block indexing.
- `getChunk(chunkId)` — full chunk content
- `getDocument(docIdOrPath)` — reassembles chunks in ordinal order
- `deleteCollection(name)` — removes all docs + chunks + embeddings for collection
- `status(): KBStatus` — collection counts, chunk totals, FTS5 status, partial embedding coverage, conflict count

**`src/kb/indexer.ts`** — `KBAutoIndexer`
- `syncAll(config)` — indexes all configured `kbCollections`
- `indexSessionSummary(summary, conversationId)`:
  - Only runs if `kbAutoIndexSessions: true`
  - **Circuit breaker:** reads `summary.derivation_depth` — if > 1 (i.e., summary of summaries), skips indexing. This prevents the feedback loop where the system starts recalling its own abstractions.
  - Inserts with `derivation_depth = summary.depth + 1` and `memory_class: "task"` 
- Called from `engine.afterTurn()` after every compaction that produces new summaries

---

### Phase 5 — Context Engine (LCM)

*Depends on Phase 2. Runs parallel with Phase 4.*

**`src/engine/assembler.ts`** — `ContextAssembler`
- `assemble(params): Promise<AssembleResult>`
  - Fetch all `context_items` for `sessionId`, ordered by `ordinal`
  - Protected fresh tail: last `freshTailCount` raw messages — always included
  - Evictable prefix: fill remaining budget newest-first
  - Summaries → XML user messages in lossless-claw-compatible format:
    ```xml
    <summary id="sum_abc123" kind="leaf" depth="0"
             earliest_at="2026-01-01T09:00:00" latest_at="2026-01-01T10:30:00">
      <content>...</content>
    </summary>
    ```
  - Messages → reconstructed from `message_parts`
  - Returns `{messages: AgentMessage[], estimatedTokens, systemPromptAddition?}`

**`src/engine/compaction.ts`** — `CompactionEngine`
- `runLeafPass(conversationId, opts)` — finds oldest raw messages outside fresh tail, prepends `previous_context`, calls LLM (or extractive fallback), persists `SummaryRecord`, replaces N `context_items` with 1 summary entry
- `runCondensedPass(conversationId, depth, opts)` — finds contiguous same-depth summaries, concatenates with time-range headers, calls LLM, persists at `depth+1`
- `shouldCompact(conversationId, tokenBudget): boolean` — raw token count > `contextThreshold × tokenBudget`
- **Three-level escalation:**
  1. Normal prompt, temperature 0.2
  2. Aggressive prompt (tighter instruction, lower target tokens), temperature 0.1
  3. **Extractive TF-IDF fallback** — no LLM call; scores sentences by term frequency × inverse document frequency across the chunk corpus, keeps top sentences within `leafTargetTokens`, appends `[Summarized — extractive fallback]`
- `compactUntilUnder(conversationId, tokenBudget, maxRounds)` — repeated full sweeps for overflow recovery

**`src/engine/summarizer.ts`** — `Summarizer`
- `summarize(params): Promise<SummarizeResult>` — wraps `api.runtime` LLM call with configurable model/provider override, timeout, and retry
- Falls through escalation levels on failure or timeout
- `buildLeafPrompt(messages, previousContext)` / `buildCondensedPrompt(summaries, depth)`
- **Note:** Exact `api.runtime` LLM call path must be confirmed against `openclaw-main/src/plugins/runtime/types-core.ts` before this file is implemented. The reference is `lossless-claw-main/src/summarize.ts`.

**`src/engine/session-end.ts`** — `SessionEndArtifactBuilder`
- `buildArtifact(conversationId, messages, summaries): SessionEndArtifact` — called on `session_end` hook
- Uses LLM (or extractive fallback) to produce structured fields: `goal`, `decisions`, `open_questions`, `reentry_context`
- Persists to `session_end_artifacts`
- On failure: writes a minimal artifact with the final summary text and a `[partial]` flag

**`src/engine/engine.ts`** — `EngramContextEngine implements ContextEngine`
- `info: { id: "engram", name: "Engram", ownsCompaction: true }`
- `bootstrap({sessionId, sessionKey, sessionFile})` — reconcile JSONL transcript with DB via byte-offset tracking in `engram_bootstrap_state`; backfill missing messages; on first session for agent: load prior session's `session_end_artifact` for continuity injection
- `ingest({sessionId, message})` — persist to Layer A (`messages` + `message_parts`), append `context_items`
- `ingestBatch({sessionId, messages})` — bulk import
- `assemble(params)` — delegate to `ContextAssembler`; prepend continuity block (from `session_end_artifact`, not deepest summary) on first turn of new session
- `afterTurn({sessionId, sessionFile})` — `shouldCompact()`? → leaf pass + up to `incrementalMaxDepth` condensed passes → `KBAutoIndexer.indexSessionSummary()` for new summaries
- `compact(params)` — full sweep: repeated leaf → repeated condensed
- `dispose()` — close DB

---

### Phase 6 — Proactive Recall & Persona

*Depends on Phase 4. Runs parallel with Phase 5.*

**`src/recall/extractor.ts`** — `extractQuery(messages): string | null`
- Finds last `role: "user"` message in `event.messages`
- String content → strip OpenClaw metadata sections (`<system>`, `<context>`, `---` dividers)
- Array content → join `type: "text"` blocks
- Returns null if: length < 15, matches heartbeat patterns, matches skip patterns
- **Follow-up detection fallback:** If the stripped query is < 20 characters, or matches follow-up reference patterns (`based on`, `the above`, `that error`, `how do I fix`, `explain that`, `what did you mean`), the extracted query is augmented with the prior assistant turn's plain text (first 400 chars, stripped of XML). This prevents vague follow-ups from producing useless recall. The augmented flag is noted in shadow logs.

**`src/recall/scorer.ts`**
- `estimateSubstance(query): 0 | 0.5 | 1` — 0 for trivial/greeting, 0.5 for short conversational, 1.0 for substantive; modulates token budget
- **Score normalization:** After RRF fusion, raw RRF scores are normalised to [0,1] using the max score in the result set as the denominator. Source hierarchy boosts (1.5× for user-stated, 0.7× decay for derived) and time decay are applied **after** normalisation as multiplicative factors on the normalised value. Final score is always ∈ [0,1]. The `recallMinScore` and `recallHighConfidenceScore` thresholds operate on this normalised composite — they are therefore calibratable and meaningful.
- `shouldInject(results, config): boolean`
  - Hard floor: `recallMinScore` (on normalised score)
  - Gap check: top score beats #2 by > `recallGapThreshold` OR top ≥ `recallHighConfidenceScore`
- `deduplicateAgainstContext(results, messages): KBSearchResult[]`
  - Removes results where **every sentence** in the recall chunk has > 60% word overlap with a sentence already in the last 20 messages. Sentence-level check — the chunk must add **no new sentences** to be filtered.
  - A result that is topically adjacent but contains at least one novel sentence (e.g. a detail not present in recent context) **is not filtered**. This is a deliberate design choice: the dedup should prevent verbatim repetition, not prevent adding information on a familiar topic.
- `applyTimeDecay(results, config): KBSearchResult[]` — re-sorts; **exact keyword hits bypass decay** under the following precise rule: case-insensitive whole-word boundary match (`\bterm\b`) on query terms of ≥ `recallKeywordBypassMinLength` characters (default: 4), capped at `recallKeywordBypassMaxTerms` terms (default: 3). Common short words (`the`, `how`, `fix`) never trigger bypass regardless of length.

**Trust tiering — results are injected differently by memory class:**
- `identity` → only via `PersonaManager` (always-on, not through recall scorer)
- `project` → `prependSystemContext` (cache-friendly, persists across turns) — **capped by `recallPrependMaxTokens`; oldest entries evicted when cap exceeded**
- `task` / `reference` → `appendSystemContext` (per-turn, lower trust)
- Each injected block carries `source_kind` and date attribution

**`src/recall/compressor.ts`** — `compressResults(results, maxTokens): string`
- Extractive sentence-level compression to fit token budget
- Preserves source attribution
- Output format:
  ```xml
  <recall>
  <result score="0.82" source="docs/architecture.md" date="2026-03-15" source_kind="document">
  ...sentence...</result>
  </recall>
  ```

**`src/recall/persona.ts`** — `PersonaManager`
- `load(): Promise<string>` — reads `personaFile`, returns content (empty if file doesn't exist); result cached, invalidated on write
- `getSystemSection(): Promise<string>` — formats as `<persona>...</persona>` for system prompt injection
- `appendUserFact(fact: string): Promise<void>` — **user write path only**; appends to `personaFile` under `<!-- USER -->`
- `mergePendingFacts(approvedIds: string[]): Promise<void>` — merges approved `kb_facts` rows into `personaFile` under `<!-- AGENT-SUGGESTED -->` section; the file wins on next load
- Agent-proposed facts go to `kb_facts` with `approval_state: "pending"` — never directly to `personaFile`

**`src/recall/continuity.ts`** — `ContinuitySummarizer`
- `getLastSessionArtifact(agentId): Promise<SessionEndArtifact | null>` — reads most recent `session_end_artifact` for this agent (excluding current session)
- `formatContinuityBlock(artifact): string` — structured `<prior_session>` block with `goal`, `decisions`, `open_questions`, `reentry_context` fields. Falls back to last session's deepest summary text only if no artifact exists and is clearly labelled `[summary-only — artifact unavailable]`

**`src/recall/injector.ts`** — `RecallInjector`
- `handle(event, config): Promise<PluginHookBeforePromptBuildResult>`
  - `extractQuery()` → null → return `{}`
  - `estimateSubstance()` → 0 → return `{}`
  - `kbStore.search(query)` in-process (no subprocess), with staged timeout:
    - `kbSearchTimeoutMs` applies to the **vector reranking step only**. BM25 results already computed before the deadline are returned as-is. If BM25 itself exceeds the deadline, return `{}` and log a `warn` — this is a silent failure mode that must be visible, not swallowed.
  - `applyTimeDecay()` → `deduplicateAgainstContext()` → `shouldInject()`?
  - Yes → split by memory class → `compressResults()` per tier → assemble injection:
    - **Prepend cap enforcement:** before calling `prependSystemContext` with project-class facts, check accumulated prepend tokens for this conversation. If adding the new block would exceed `recallPrependMaxTokens`, evict the oldest prepend entry (lowest score at time of injection) until there is room. This is tracked in `session_state.injected_prepend_entries` (in-memory per engine instance, not persisted).
    - Return `{ prependSystemContext: projectBlock, appendSystemContext: referenceBlock }`
  - `recallShadowMode: true` → log the block (to openclaw debug log + optional `recallShadowLogFile`), return `{}`

**Persona injection** is always-on in `assembler.ts` via `systemPromptAddition`, separate from the recall pipeline.

---

### Injection Pipeline Design Notes

*These decisions address known failure modes in the injection pipeline. Each one has a corresponding test.*

**The full pipeline:**
```
before_prompt_build
  → extractQuery()          [extractor.ts]
  → estimateSubstance()     [scorer.ts]
  → kbStore.search()        [store.ts — staged timeout]
  → applyTimeDecay()        [scorer.ts — normalised scores, defined bypass rule]
  → deduplicateAgainstContext()  [scorer.ts — sentence-level, not topic-level]
  → shouldInject()          [scorer.ts — normalised thresholds]
  → compressResults()       [compressor.ts — per trust tier]
  → prepend cap enforcement [injector.ts — evict oldest on overflow]
  → inject
```

**Design decision 1 — Score normalisation (prevents arbitrary thresholds)**
Raw RRF scores are non-intuitive fractional values. All boosts and decay are applied after normalising to [0,1]. The `recallMinScore` and `recallHighConfidenceScore` config keys therefore describe a meaningful [0,1] range rather than an arbitrary number that depends on how boosts stack.

**Design decision 2 — Sentence-level deduplication (not word-overlap on the whole chunk)**
The dedup guard checks whether the recall result adds **at least one novel sentence** to context. If yes, it passes through — even if the topic is familiar. If every sentence in the chunk is already substantially present in recent context, it is filtered. This prevents "recall of novel information about a known topic" from being killed by proximity to the known topic.

**Design decision 3 — Prepend cap with oldest-eviction (prevents context window leak)**
Project-class facts injected via `prependSystemContext` accumulate across turns without limit. The `recallPrependMaxTokens` cap (default: 300) is enforced by the injector before each turn. When adding a new project block would exceed the cap, the lowest-scored previously-injected entry is evicted. This is tracked in memory per engine instance — it is not persisted, so it resets at session restart (acceptable: a fresh session also re-evaluates what's relevant).

**Design decision 4 — Staged search timeout (BM25 results on vector timeout)**
The `kbSearchTimeoutMs` budget is staged:
1. BM25 search runs first. If BM25 completes in time, its results are available.
2. Vector reranking runs on BM25 candidates. If the deadline passes mid-rerank, return the BM25-only results without vector reranking. This is the expected degraded mode.
3. If BM25 itself does not complete before the deadline, return empty results and log a `WARN` — this should be visible and trigger investigation, not silently return nothing.

**Design decision 5 — Exact keyword bypass has a precise definition**
"Exact keyword bypass" means: case-insensitive whole-word boundary match (`\bterm\b`) on query terms that are ≥ `recallKeywordBypassMinLength` characters (default: 4) AND not in a common-word exclusion list. At most `recallKeywordBypassMaxTerms` (default: 3) terms may trigger bypass per query. This prevents a query containing common words like "how" or "the" from making all matching facts decay-immune.

**Design decision 6 — Follow-up query augmentation**
When the extracted query is < 20 characters or matches a follow-up reference pattern, the extractor appends the first 400 chars of the prior assistant turn (plain text, XML stripped). This prevents queries like "how do I fix it?" from producing zero-quality recall due to insufficient query signal.

---

### Phase 7 — Agent Tools

**`src/plugin/tools.ts`** — registered via `api.registerTool()`:

| Tool | Parameters | Description |
|---|---|---|
| `engram_search` | `query, maxResults?, collections?, minScore?` | Hybrid BM25 + vector KB search |
| `engram_get` | `id` (chunkId or file path) | Full document or chunk content |
| `engram_remember` | See interface below | Explicitly store a fact with governed write path |
| `engram_forget` | `id, reason?` | Deprecate a KB entry; sets `deprecated_at`, logs reason |
| `engram_index` | `path, collection?` | Index a file or directory into the KB |
| `engram_status` | — | Session, message, summary, KB, embedding, pending-approval stats |

**`engram_remember` full interface:**
```typescript
{
  content: string,
  memory_class: "identity" | "project" | "task" | "reference",
  source_basis: "user_stated" | "agent_inferred" | "document_derived" | "decision",
  scope: "global" | "agent" | "session",
  expiry?: "none" | ISO8601date | "7d" | "30d" | "90d",
}
```
Write policy enforced in the tool handler:
- `identity` class → always `approval_state: "pending"`, never written to `persona.md` directly
- `agent_inferred` source → `lifecycle_state: "captured"`, `approval_state: "pending"`
- `user_stated` source → `lifecycle_state: "candidate"`, `approval_state: "approved"`
- `decision` source → `lifecycle_state: "durable"`, added to decision ledger view

---

### Phase 8 — Slash Commands

**`src/plugin/commands.ts`** — registered via `api.registerCommand()`:

| Command | Description |
|---|---|
| `/engram` | Print `engram_status` as formatted text |
| `/engram compact` | Force full compaction of current session |
| `/engram index [path]` | Re-sync all KB collections (or index a specific path) |
| `/engram search <query>` | Run KB search and print formatted results with scores + source_kind |
| `/engram export [path]` | Export all memories to markdown, organised by date + memory class |
| `/engram persona` | Print current `persona.md` content |
| `/engram review` | List `kb_facts` with `approval_state: "pending"` — approve/reject with follow-up |
| `/engram migrate [--dry-run]` | Run or preview data migration from lossless-claw/qmd |
| `/engram doctor` | Diagnostic check — build this first (see note below) |

**`/engram doctor` — build first:**

Per the review feedback, `/engram doctor` should be built in Phase 1 (before the full engine is wired) and grown incrementally. It surfaces the edge cases you'll hit in every other phase:

- DB integrity: `PRAGMA integrity_check`
- FTS5 available for each collection
- Embedding endpoint reachable (HEAD or small test request)
- Disk space available at DB path
- Any `kb_collections` with `fts5_available: false` and chunk count > 5000 (warns)
- Any `kb_facts` with `approval_state: "pending"` (count)
- Any open `kb_conflicts` (count)
- Session summary indexing circuit breaker status
- Performance benchmark: KB search over current index (reports ms)
- Migration status: whether lossless-claw/qmd data has been imported
- Conflict with lossless-claw: warns if lossless-claw is installed in the same openclaw instance

---

### Phase 9 — Plugin Entry Wiring

**`src/plugin/entry.ts`** — `definePluginEntry({ id: "engram", kind: "context-engine", ... })`

`register(api)` wiring order:
1. `resolveConfig(api.pluginConfig, process.env)` → `config`
2. `resolveDbPath(config)` — checks `OPENCLAW_STATE_DIR` then `~/.openclaw/`
3. If `engram.db` does not exist and migration sources detected → `runMigration(opts)` (auto-migrate)
4. `openDatabase(dbPath)` → `db`
5. `new KnowledgeBaseStore(db, config)` → `kbStore`
6. `new KBAutoIndexer(kbStore, config)` → `indexer`
7. `new PersonaManager(config)` → `persona`
8. `new ContinuitySummarizer(db)` → `continuity`
9. `new RecallInjector(kbStore, persona, config)` → `injector`
10. `new Summarizer(api, config)` → `summarizer`
11. `new EngramContextEngine(db, kbStore, indexer, injector, persona, continuity, summarizer, config)` → `engine`
12. `api.registerContextEngine("engram", () => engine)`
13. `api.on("before_prompt_build", (event) => injector.handle(event, config))`
14. `api.on("session_end", (event) => engine.onSessionEnd(event))` — triggers `SessionEndArtifactBuilder`
15. `registerTools(api, engine, kbStore, persona)` — Phase 7 tools
16. `registerCommands(api, engine, kbStore, indexer, persona)` — Phase 8 commands
17. If `kbAutoIndexOnStart`: `setImmediate(() => indexer.syncAll(config))` — non-blocking

`dispose()` — `engine.dispose()` → `db.close()`

---

### Phase 10 — Token Estimation

**`src/token-estimate.ts`** — lightweight character-based estimator
- Formula: `Math.ceil(text.length / 3.7)` (conservative — errs high)
- **Acceptable error margin: ±10%** for compaction triggers. If the active runtime exposes exact tokenizer counts via `api.runtime`, use those and store the comparison in `engram_migrations` for calibration.
- Tests in `test/token-estimate.test.ts` must include worst-case prompts: code blocks (dense tokens), CJK text (different byte/token ratio), tool call JSON

---

### Phase 11 — Tests

**`test/`** — vitest unit tests + integration tests:

| Test file | What it covers |
|---|---|
| `test/chunker.test.ts` | Heading boundary detection, code-fence safety, overlap correctness |
| `test/scorer.test.ts` | `shouldInject` logic, per-class decay formula, **normalised score range [0,1]**, deduplication (novel-sentence not word-overlap), trust tiering, keyword bypass rules |
| `test/compressor.test.ts` | Token-budget compliance, source attribution, trust tier labelling |
| `test/migration.test.ts` | Migration idempotency, FTS5 fallback detection, DB transaction rollback on failure |
| `test/compaction.test.ts` | Leaf pass structure, escalation path (normal → aggressive → extractive), extractive fallback correctness |
| `test/assembler.test.ts` | Fresh-tail protection, budget filling, summary XML format, invariant #2 (raw evidence not deleted) |
| `test/extractor.test.ts` | Metadata stripping, heartbeat skip, content block joining, **follow-up augmentation (short query + reference patterns)** |
| `test/persona.test.ts` | Agent-proposed facts go to pending; user writes go directly; `mergePendingFacts` only touches approved ids |
| `test/token-estimate.test.ts` | ±10% margin on code, prose, CJK, tool JSON |
| `test/facts.test.ts` | Lifecycle state transitions, `engram_remember` write policy enforcement, `engram_forget` audit retention |

**Integration tests (separate suite, `test/integration/`):**

| Test | What it covers |
|---|---|
| `full-session.test.ts` | Full pipeline: ingest 20 turns → compaction → recall injection → persona → status. Validates no invariant violations. |
| `recall-pipeline.test.ts` | `before_prompt_build` → search → inject → verify system prompt output. The "money path". Includes: BM25 timeout returns partial results not empty, prepend cap eviction, follow-up query augmentation, novel-sentence dedup allows topically-adjacent-but-novel recall. |
| `continuity.test.ts` | End session 1 → start session 2 → verify `<prior_session>` block present and sourced from `session_end_artifact` |
| `migration.test.ts` | Copy real lossless-claw DB fixture → migrate → verify record counts, no data loss |

**Chaos tests (`test/chaos/`):**

| Test | What it covers |
|---|---|
| `extractive-fallback.test.ts` | LLM call times out → extractive fallback runs → summary written correctly |
| `embed-down.test.ts` | Embedding endpoint 500s mid-index → successful chunks stored, failed chunks BM25-only, no abort |
| `db-busy.test.ts` | Concurrent write attempt → `retryOnBusy` resolves, no data corruption |
| `fts5-unavailable.test.ts` | Build with FTS5 disabled → LIKE fallback active below threshold, error above threshold |

**Deterministic replay test:**
- `test/integration/deterministic.test.ts` — load a fixed JSONL transcript, run the full pipeline twice with the same seed, verify identical context output (compaction is deterministic for the extractive path)

---

## File Tree

```
engram/
├── PLAN.md                         ← this file
├── index.ts                        ← re-exports src/plugin/entry.ts
├── openclaw.plugin.json            ← plugin manifest
├── package.json
├── tsconfig.json
├── vitest.config.ts
├── src/
│   ├── config.ts                   ← EngramConfig + resolveConfig()
│   ├── token-estimate.ts           ← lightweight token estimator (±10% target)
│   ├── db/
│   │   ├── schema.ts               ← SQL DDL constants (4 logical layers)
│   │   ├── migration.ts            ← runMigrations()
│   │   └── connection.ts           ← openDatabase() + retryOnBusy()
│   ├── migrate/
│   │   ├── detect.ts               ← detectExistingData()
│   │   ├── lcm-importer.ts         ← importFromLcm()
│   │   ├── qmd-importer.ts         ← importFromQmd()
│   │   ├── config-compat.ts        ← old config key mapping
│   │   └── runner.ts               ← runMigration() orchestrator
│   ├── kb/
│   │   ├── chunker.ts              ← heading-aware document chunking
│   │   ├── embeddings.ts           ← EmbeddingClient (HTTP, OpenAI-compat, binary blobs)
│   │   ├── store.ts                ← KnowledgeBaseStore (RRF k=15, per-class decay, source hierarchy)
│   │   └── indexer.ts              ← KBAutoIndexer (circuit breaker for summary feedback loop)
│   ├── engine/
│   │   ├── assembler.ts            ← ContextAssembler
│   │   ├── compaction.ts           ← CompactionEngine (3-level escalation)
│   │   ├── summarizer.ts           ← Summarizer (LLM + extractive TF-IDF fallback)
│   │   ├── session-end.ts          ← SessionEndArtifactBuilder
│   │   └── engine.ts               ← EngramContextEngine implements ContextEngine
│   ├── recall/
│   │   ├── extractor.ts            ← extractQuery()
│   │   ├── scorer.ts               ← shouldInject(), per-class decay, trust tiering
│   │   ├── compressor.ts           ← compressResults() with source_kind attribution
│   │   ├── persona.ts              ← PersonaManager (user-write-only, pending merge)
│   │   ├── continuity.ts           ← ContinuitySummarizer (session_end_artifact, not deepest summary)
│   │   └── injector.ts             ← RecallInjector (before_prompt_build handler)
│   └── plugin/
│       ├── entry.ts                ← definePluginEntry() — wires everything + auto-migration
│       ├── tools.ts                ← engram_search/get/remember/forget/index/status
│       └── commands.ts             ← /engram slash commands (doctor first)
└── test/
    ├── chunker.test.ts
    ├── scorer.test.ts
    ├── compressor.test.ts
    ├── migration.test.ts
    ├── compaction.test.ts
    ├── assembler.test.ts
    ├── extractor.test.ts
    ├── persona.test.ts
    ├── facts.test.ts
    ├── token-estimate.test.ts
    ├── integration/
    │   ├── full-session.test.ts
    │   ├── recall-pipeline.test.ts  ← the "money path"
    │   ├── continuity.test.ts
    │   └── migration.test.ts
    └── chaos/
        ├── extractive-fallback.test.ts
        ├── embed-down.test.ts
        ├── db-busy.test.ts
        └── fts5-unavailable.test.ts
```

---

## Reference Files (Templates from Existing Repos)

| engram module | reference file |
|---|---|
| `src/db/migration.ts` | `lossless-claw-main/src/db/migration.ts` — `node:sqlite` migration pattern |
| `src/db/connection.ts` | `lossless-claw-main/src/db/connection.ts` — DB path resolution, `OPENCLAW_STATE_DIR` |
| `src/migrate/lcm-importer.ts` | `lossless-claw-main/src/db/migration.ts` — schema reference for import mapping |
| `src/migrate/qmd-importer.ts` | `qmd-main/src/store.ts` — QMD schema and collection structure |
| `src/engine/assembler.ts` | `lossless-claw-main/src/assembler.ts` — summary XML format, fresh-tail algorithm |
| `src/engine/compaction.ts` | `lossless-claw-main/src/compaction.ts` — leaf pass, condensed pass, chunk selection |
| `src/engine/engine.ts` | `lossless-claw-main/src/engine.ts` — ContextEngine lifecycle, bootstrap offset tracking |
| `src/engine/summarizer.ts` | `lossless-claw-main/src/summarize.ts` — `api.runtime` LLM call pattern, timeout wrapping |
| `src/kb/chunker.ts` | `qmd-main/src/store.ts` — `findBestCutoff()`, `findCodeFences()`, heading scoring |
| `src/kb/store.ts` | `qmd-main/src/store.ts` — hash-diff re-indexing; RRF (fix k to 15 not 60) |
| `src/recall/extractor.ts` | `openclaw-precog-main/src/handler.ts` — `stripMetadata()`, content block joining |
| `src/recall/scorer.ts` | `openclaw-precog-main/src/threshold.ts` — `shouldInject()`, `deduplicateAgainstContext()` |
| `src/plugin/entry.ts` | `openclaw-main/extensions/memory-core/index.ts` — `definePluginEntry` context-engine pattern |
| `ContextEngine` interface | `openclaw-main/src/context-engine/types.ts` |
| `OpenClawPluginApi` types | `openclaw-main/src/plugins/types.ts` |
| hook event types | `openclaw-main/src/plugins/hook-before-agent-start.types.ts` |

---

## Implementation Notes

### Build `/engram doctor` First
Before building the full engine, build `doctor` as a standalone command that checks: DB reachability, FTS5 availability, embedding endpoint, disk space, pending approvals, open conflicts, lossless-claw conflict detection. It will surface 90% of edge cases encountered in subsequent phases.

### Summarization LLM Access
The exact `api.runtime` path for a direct LLM completion must be confirmed against `openclaw-main/src/plugins/runtime/types-core.ts`. The reference is `lossless-claw-main/src/summarize.ts`. **Confirm before implementing `src/engine/summarizer.ts`.**

### Exclusive Slot Conflict
If lossless-claw is installed alongside engram, only one `context-engine` plugin activates. `/engram doctor` warns about this. The user must uninstall lossless-claw or disable it.

### Windows Path Safety
All path construction uses `path.join()` and `os.homedir()`. No hardcoded Unix paths. `OPENCLAW_STATE_DIR` env var takes precedence over default.

### FTS5 Fallback Honesty
The LIKE fallback is only used for collections with < 5,000 chunks, and `/engram doctor` makes the limitation visible. Collections above that threshold require FTS5 and report a clear error. FTS5 availability is per-collection, recorded at index time.

### RRF k Value
The plan uses `k=15` (configurable via `recallRrfK`). k=60 is from the SIGIR paper for web-scale retrieval with millions of documents. For a personal memory system with hundreds to low-thousands of chunks, k=15 gives better rank discrimination.

### Vector Storage
Embeddings are stored as `BLOB` (binary float32 little-endian), not JSON text. JS cosine similarity over 50 BM25 pre-filtered candidates reads ~6KB of binary data vs. ~2.5MB of JSON per search.

### Session Summary Feedback Loop Circuit Breaker
`kbAutoIndexSessions` is gated by `derivation_depth` — only depth-0 (leaf) summaries are indexed into `__sessions`. Condensed summaries (depth > 0) are not indexed. This prevents the feedback loop: condensed summaries recalled → re-summarized → more condensed summaries → information loss compounds.

### Persona Write Authority
The agent may never write directly to `persona.md`. `engram_remember` with `memory_class: "identity"` always creates a `kb_facts` row with `approval_state: "pending"`. The user reviews these via `/engram review` and can merge them into `persona.md`. This is Invariant #3 and #9 in concrete form.

### Continuity Source
Session continuity uses `session_end_artifacts`, not the highest-depth summary. The deepest summary is the most abstract and most information-lossy — precisely the wrong source for re-orienting a new session. If no artifact exists (e.g. session crashed), the system falls back to the shallowest available summary and labels it `[summary-only — session-end artifact unavailable]`.

### Deprecation Policy
Once engram is stable (v1.0), `lossless-claw`, `qmd`, and `precog` should be marked deprecated in the OpenClaw plugin registry with a migration notice pointing to engram.

---

## Verification Checklist

- [x] `npm install && npx tsc --noEmit` — zero TypeScript errors
- [ ] `/engram doctor` runs before full engine is wired — surface environment issues early
- [ ] `openclaw plugins install ./engram` — installs, no errors in openclaw log
- [ ] `/engram migrate --dry-run` — detects existing lossless-claw/qmd data correctly
- [ ] `/engram migrate` — imports data, idempotent on re-run
- [ ] New session starts — `[engram] context engine activated` in log
- [x] After 10+ turns — `engram.db` contains rows in `summaries` table, Layer A messages intact
- [x] `/engram status` — prints session + KB stats including pending approvals
- [ ] Add markdown collection in config, run `/engram index` — BM25 search returns results within 150ms
- [x] Ask a question about indexed content — recall XML appears in system prompt with source_kind attribution
- [x] Configure Ollama `embedApiUrl`, re-index — `kb_embeddings` rows populated as binary blobs
- [ ] `/engram compact` — forced compaction, new summary rows created, context_items updated
- [x] `engram_remember` with `memory_class: "identity"` — fact appears in `kb_facts` with `approval_state: "pending"`, NOT in `persona.md`
- [x] `/engram review` — shows pending fact, approve it, verify it appears in `persona.md`
- [x] `engram_forget` — entry has `deprecated_at` set, disappears from search, row still exists for audit
- [ ] `/engram export` — markdown file written, re-indexable
- [x] Start second session — `<prior_session>` block sources from `session_end_artifact`, not deepest summary
- [x] Chaos: LLM timeout during compaction → extractive fallback runs → summary with `[Summarized — extractive fallback]` written
- [x] Chaos: embedding endpoint down mid-index → partial index completed, no crash, doctor shows partial coverage
- [x] All unit tests pass: `npm test`
- [x] Integration test: `full-session.test.ts` and `recall-pipeline.test.ts` pass

Host-level install and smoke checks remain blocked in this workspace because the `openclaw` CLI is not installed.
