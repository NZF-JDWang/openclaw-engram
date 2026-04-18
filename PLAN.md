# Engram Enhancement Plan

Five additions, strictly within scope (memory, not identity). Ordered by impact.

---

## 1. Cross-Session Conversation Recall

**Problem:** Recall only searches the KB (indexed files, session summaries as documents). It does not directly surface *past conversation context* — "you debugged this exact Postgres issue last Tuesday" is invisible even though the summary DAG contains it.

**How it works now:**
- `afterTurn` → compaction creates summaries → `indexSessionSummaryById()` indexes them into the `__sessions` KB collection
- Recall searches `__sessions` alongside other collections, but session summaries get buried under document matches, and the `__sessions` collection already has a 0.7 score penalty (`collectionWeight`)

**What changes:**

### 1a. Dedicated session-summary recall lane
- Add a second search pass in `createBeforePromptBuildHook` that queries *only* the `__sessions` collection with a higher limit (5-10 candidates)
- Apply conversation-aware scoring: boost summaries from the same session_key (same channel/surface) since they're most likely relevant
- Reserve 1-2 of the 3 recall slots for session hits when they exceed a higher confidence threshold (0.65 vs 0.55 for documents)
- This doesn't change the KB at all — the data is already indexed. It's purely a recall routing change.

### 1b. Conversation metadata in recall blocks
- When a hit comes from `__sessions`, include the `session_key` and `created_at` from the `conversations` table in the `<memory>` XML block
- This lets the model say "last Tuesday we..." instead of "a document mentions..."

**Files changed:**
- `src/plugin/recall.ts` — add session-specific search pass, metadata enrichment
- `src/kb/store.ts` — add `searchSessions()` or `searchByCollection()` helper
- No schema changes

**Complexity:** Medium. The hard part (indexing summaries) is already done. This is recall routing.

---

## 2. Recall Diversity — One Chunk Per Source

**Problem:** Top-K by score often returns 3 chunks from the same document. Waste of limited slots.

**What changes:**
- After ranking candidates, apply a diversity filter: max 1 chunk per `doc_id` (or per `collection_name + rel_path`)
- Only relax this if there aren't enough unique sources to fill the slot budget
- Simple greedy: iterate ranked list, accept first chunk per source, skip duplicates

**Files changed:**
- `src/plugin/recall.ts` — add `diversifyBySource()` filter between `rankRecallCandidates` and `shouldInjectRecall`
- No schema changes, no config changes (could add `recallDiversity` bool later)

**Complexity:** Low. ~20 lines.

---

## 3. Temporal Query Filtering

**Problem:** "What did we discuss last week about X?" — no way to constrain search by time range. The KB has temporal decay but no explicit filtering.

**What changes:**
- Add optional `since` / `until` date params to `searchKnowledgeBase()` and `engram_search` tool
- In `queryFtsRows` / `queryLikeRows`, add `AND kd.indexed_at BETWEEN ? AND ?` when provided
- In recall hook, parse temporal phrases from the user query ("last week", "yesterday", "this month") and convert to date ranges automatically
- Expose via `engram_search` tool params and `/engram search --since 2026-04-10 <query>`

**Files changed:**
- `src/kb/store.ts` — add `since`/`until` params to `searchKnowledgeBase()`
- `src/plugin/recall.ts` — add temporal phrase extraction, pass to search
- `src/plugin/tools.ts` — add `since`/`until` to `engram_search` schema
- `src/plugin/commands.ts` — add `--since`/`--until` flags to `/engram search`
- No schema changes

**Complexity:** Low-medium. Date parsing is the fiddly bit; SQL filtering is trivial.

---

## 4. Recall Feedback Loop

**Problem:** No signal on whether recalled memories are actually useful. The system injects and forgets.

**What changes:**
- Track recall injections: when a recall block is injected, log the chunk IDs and scores to a lightweight SQLite table (`recall_events`)
- Track usage: in `afterTurn`, check if the assistant response references any injected chunk IDs (simple string match on chunk_id or title keywords in the response)
- Compute a per-chunk usefulness score over time: `useful_injections / total_injections`
- Feed this back into ranking: add a `recallUsefulnessBoost` multiplier in `computeScore()` — chunks that are consistently useful rank higher, consistently ignored ones decay faster
- This is self-improving with zero human input

**New table:**
```sql
CREATE TABLE IF NOT EXISTS recall_events (
  event_id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  chunk_id TEXT NOT NULL,
  injected_score REAL NOT NULL,
  was_referenced INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (chunk_id) REFERENCES kb_chunks(chunk_id)
);
```

**Files changed:**
- `src/db/schema.ts` — add `recall_events` table
- `src/db/migration.ts` — add migration
- `src/plugin/recall.ts` — log injections, check references in `afterTurn`
- `src/kb/store.ts` — use usefulness boost in `computeScore()`
- `src/config.ts` — add `recallFeedbackEnabled` config flag

**Complexity:** Medium. New table + migration, but the logic is straightforward.

---

## 5. Incremental Vault Sync

**Problem:** `kbAutoIndexOnStart` re-scans every configured collection on startup. Fine for small vaults, but scales linearly with file count. An Obsidian vault with 10k files = slow startup.

**What changes:**
- Track file content hashes in `kb_documents` (already has `content_hash` column!)
- On sync, compare current file hashes against stored hashes
- Only re-index documents where the hash changed, delete documents where the file disappeared, add new documents
- Skip unchanged documents entirely
- Add `kbIncrementalSync` config flag (default: true)

**Files changed:**
- `src/kb/indexer.ts` — add `syncIncremental()` that diffs against stored hashes
- `src/plugin/entry.ts` — call `syncIncremental` instead of full re-index when flag is on
- `src/config.ts` — add `kbIncrementalSync` flag
- No schema changes (content_hash already exists!)

**Complexity:** Low-medium. The hash column already exists, just need the diff logic.

---

## Priority

| # | Feature | Impact | Effort | ROI |
|---|---------|--------|--------|-----|
| 1 | Cross-session conversation recall | Very high | Medium | 🔥 |
| 2 | Recall diversity (1 per source) | High | Low | 🔥 |
| 3 | Temporal query filtering | Medium | Low-Med | Good |
| 4 | Recall feedback loop | High (compounding) | Medium | Good |
| 5 | Incremental vault sync | Medium | Low-Med | Good |

**Recommended build order:** 2 → 1 → 3 → 5 → 4

Start with diversity (#2) — it's 20 lines and immediately makes the existing 3 recall slots more useful. Then conversation recall (#1) for the biggest quality win. Temporal (#3) and incremental sync (#5) are quality-of-life. Feedback loop (#4) is last because it needs the other recall improvements in place first to have clean signal.

---

## What's NOT in scope

These were considered and rejected:
- **Persona/fact injection** — removed in previous scope cut; identity is OpenClaw's job
- **Session-end artifacts** — OpenClaw has built-in `<prior_session>`; duplicating is wasteful
- **Agent-writable memory commands** — agents already write to workspace files and the KB index; a special "remember" command is a wrapper around existing capability
- **Cross-instance sync / replication** — single-node plugin, not a distributed system