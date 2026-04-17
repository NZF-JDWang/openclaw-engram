---
title: Engram Plugin Review v2 — Claire, Kimi, Minimax
date: 2026-04-17
tags: [review, engram, memory, openclaw]
---

# Engram v2 — Three-Reviewer Consensus

Reviewers: Claire (GLM-5.1), Kimi K2.5, Minimax M2.7
Date: 2026-04-17

---

## What Changed (v1 → v2)

The updated plan directly addresses the biggest concerns from our v1 reviews:

| v1 Landmine | v2 Status |
|---|---|
| **No migration strategy** | ✅ Phase 0 added. Idempotent import from `lcm.db` and QMD. Auto-migrate on first launch. Config backward-compat mapping included. |
| **Contradiction detection was vaporware** | ✅ Split into v1 (fast cosine flag-only, doesn't block indexing) and v2 (LLM verification). v1 is honest about limitations. |
| **RRF k=60 was cargo-culted** | ✅ Changed to k=15 with `recallRrfK` config. Correct for personal memory scale. |
| **Vectors stored as JSON text** | ✅ Changed to BLOB (binary float32). 6KB vs 2.5MB per search. |
| **Session summary feedback loop** | ✅ Circuit breaker added: `derivation_depth > 1` summaries are not indexed. |
| **Persona.md had no write guards** | ✅ Agent cannot write directly to persona. `engram_remember --class identity` → pending approval. User-only write path. |
| **Continuity used deepest (most lossy) summary** | ✅ Changed to `session_end_artifact` — purpose-built re-orientation record. Fallback to shallowest summary if unavailable. |
| **No v1/v2 scope separation** | ✅ Explicit v1 vs v2 feature table added. Full vector k-NN, LLM contradiction detection, entity resolution all deferred. |
| **No integration tests for recall pipeline** | ✅ Added `recall-pipeline.test.ts` ("the money path") and chaos tests for LLM timeout, embed failure, DB contention, FTS5 unavailable. |
| **`compactUntilUnder` had no max rounds** | ✅ Implicitly addressed by escalation path — extractive fallback always succeeds. But still no explicit `maxRounds` cap. |
| **Shadow mode had no verification path** | ✅ `recallShadowLogFile` config added for persisting shadow logs. |

That's a serious response. The author didn't just add a migration section — they designed it as Phase 0, made it idempotent, added dry-run mode, and auto-migration on first launch. That's how you do it.

---

## What's Still Open (Our Remaining Concerns)

### P0 — Migration Integrity

The migration design is good on paper but needs validation against real data:

- **Large file handling:** lossless-claw stores large file content in a `large_files` table. The v2 plan maps this but doesn't discuss whether large blobs will slow the import or whether they should be streamed.
- **Schema drift:** lossless-claw has had schema migrations itself. What if the source `lcm.db` is on an older schema version than the importer expects? The plan says "direct mapping" but doesn't handle version mismatches.
- **QMD vector format mismatch:** The plan acknowledges that QMD vectors may not be compatible and says "user must re-index with `engram embed`." This is fine but should be surfaced prominently in migration output, not just a warning.

**Verdict:** Phase 0 is well-structured. Add a schema version check on source DBs and fail fast with a clear message if the version is unknown.

### P1 — Cache-Aware Compaction (Still Missing)

This was flagged by all three reviewers and is **not addressed** in v2. Lossless-claw's current `main` has cache-aware deferred compaction that preserves hot prompt cache windows. Engram does inline compaction in `afterTurn`, which destroys Anthropic cache hits and increases cost.

This is a real cost issue for anyone running Anthropic models. The plan should either:
1. Add deferred compaction with cache-awareness (follow lossless-claw's approach), or
2. Explicitly document that engram will cost more on Anthropic until this is implemented.

### P1 — Extractive Fallback Is Still Underspecified

v2 adds a marker (`[Summarized — extractive fallback]`) and a test, but doesn't address the core questions:
- Where does the IDF corpus come from? The chunk corpus changes every compaction.
- Sentence tokenization — which language? What library?
- What happens when the extractive output exceeds the token budget? The v1 review flagged O(n²) behavior.

The TF-IDF fallback is described as a safety net, but a safety net that doesn't specify its core algorithm isn't reliable.

**Verdict:** Needs at least a `src/engine/extractive.ts` design note specifying: use the current session's messages as the IDF corpus, sentence-split on `(?<=[.!?])\s+`, and cap at 2x `leafTargetTokens` before truncation. Don't leave this for implementation time.

### P1 — Concurrent Session Writes

v2 adds `retryOnBusy` with exponential backoff, which handles `SQLITE_BUSY`. But it doesn't address the logical race condition: if session A compacts and rewrites `context_items` while session B is assembling context from the same conversation, session B could see a partially-updated state.

The transaction strategy section says "ingest and compact must never run concurrently for the same conversation_id — guarded by retryOnBusy." This handles SQLite write contention but not the application-level read-your-writes consistency across sessions.

**Verdict:** Add a note that `context_items` reads are snapshot-consistent within a single SQLite WAL read transaction. If two sessions share a conversation (rare but possible with subagents), the assembler should use an explicit read transaction.

### P1 — System Invariants Are Excellent But Need Enforcement

The 10 system invariants are the strongest part of v2. But they're stated as rules without enforcement mechanisms:
- Invariant #2 (raw evidence never overwritten) — needs a DB trigger or CHECK constraint
- Invariant #3 (agent facts never auto-promote) — needs to be enforced in `engram_remember` tool handler, not just documented
- Invariant #7 (search ranking is memory-class-aware) — needs a test that proves source hierarchy is applied

**Verdict:** Each invariant should have a corresponding test in `test/invariants.test.ts` (not listed in the test plan). An invariant without a test is a wish.

### P2 — Persona Size Cap Still Missing

v2 fixes the write authority (user-only, agent proposals go to pending), but doesn't address unbounded growth. If the user keeps approving facts, `persona.md` grows indefinitely and eats context window budget.

**Verdict:** Add a `personaMaxTokens` config (default: 500) with oldest-facts-eviction when exceeded.

### P2 — Memory Lifecycle State Machine Is Ambitious

The 7-state lifecycle (`captured → candidate → validated → durable / deprecated / superseded / expired`) is well-designed but v2 only commits to implementing 4 states (captured/validated/durable/deprecated). The full state machine is v1.5. This is fine, but the schema already has columns for all 7 states, which means the code will need to handle states it doesn't yet produce. This is a maintenance trap.

**Verdict:** Only create columns for the 4 v1 states. Add the other 3 in v1.5 when the transitions are actually implemented. YAGNI.

### P2 — Session End Artifact Requires LLM Call

`SessionEndArtifactBuilder` uses LLM (or extractive fallback) on `session_end`. But `session_end` is a hook event — is there a timeout? If the LLM is slow or down, does the session hang on close? The plan says "on failure: writes a minimal artifact with the final summary text and a `[partial]` flag" — good, but needs an explicit timeout (e.g., 30 seconds).

### P2 — `kbSessionIndexCircuitBreaker` Is Well-Designed

The `derivation_depth > 1` circuit breaker for summary indexing is exactly right. Only leaf summaries (depth 0) carry real information; condensed summaries are already compressed. This prevents the feedback loop we flagged.

One concern: the config key is `kbSessionIndexCircuitBreaker` (default: `true`), which means it's toggleable. If a user disables it, they'll get the feedback loop. Consider making this non-configurable, or at least warn loudly in `/engram doctor`.

---

## Consensus Verdict

**v2 is a substantially better plan.** The migration phase, system invariants, memory class hierarchy, v1/v2 scope split, and circuit breakers all address real concerns from v1.

### Remaining blockers for v1 ship:
1. **Cache-aware compaction** — must be addressed or explicitly documented as a known cost regression
2. **Extractive fallback spec** — needs a concrete algorithm description, not just "TF-IDF sentence scoring"
3. **Invariant enforcement** — needs tests, not just documentation

### Nice-to-haves that shouldn't block v1:
4. Persona size cap
5. Schema alignment (only create v1 columns)
6. Session end artifact timeout
7. Concurrent session read consistency note

### What we'd cut from v1 to reduce risk:
- Memory lifecycle states — ship with `active` / `deprecated` only, add the full machine in v1.5
- Conflict surfacing — even v1's cosine flagging adds complexity; defer to v2
- Decision ledger — nice idea, but adds schema and indexing complexity for marginal v1 value

**Bottom line:** This plan is now buildable. The author took the reviews seriously and addressed the hardest problems first. Ship it with the three blockers resolved and you'll have something better than what we have today.