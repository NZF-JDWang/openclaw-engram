# Proposal: Explicit Memory via `engram_remember` / `engram_forget`

---

## Problem

All memory in Engram is **incidental**. A user preference ("always use pnpm"), a hard constraint ("never modify the auth module"), or a key decision made mid-conversation only persists if:

1. It survives in a message long enough to be compacted into a summary
2. That summary gets indexed into `__sessions`
3. It clears the 0.7 collection weight + temporal decay + score threshold
4. It isn't displaced from the 3-slot recall budget by document hits

This chain is fragile. High-signal facts are treated identically to low-signal filler. There is no way to say "this matters — always surface it."

Both `engram_remember` and `engram_forget` are listed in the README as exposed tools but are not implemented.

---

## Proposed Design

### Storage

A dedicated `__facts` collection in the existing KB. Each fact is a single-chunk KB document:

```
collection:       __facts
rel_path:         <fact_id>.fact
title:            <user-supplied label or first 60 chars of content>
content:          <the fact text>
derivation_depth: 0   ← never penalized
```

No new tables. No schema migration required beyond what already exists.

Fact IDs are `randomUUID()` (already imported in `engine.ts`). Deletion is `dropKbCollection`-style surgery on a single doc + its chunks + FTS rows, wrapped in a transaction.

Each fact document stores a `superseded_by` reference in its title metadata so replacement chains are traceable without a new column — the `rel_path` encodes `<fact_id>.fact` and the `title` field carries an optional `[supersedes:<old_id>]` prefix that `engram_review` can parse.

---

### New Config Keys

| Key | Type | Default | Purpose |
|---|---|---|---|
| `recallFactsMaxResults` | `integer ≥ 0` | `1` | Max slots reserved for `__facts` hits |
| `recallFactsMinScore` | `number 0–1` | `0.45` | Min normalized score to surface a fact |

Default of `1` means at most one fact per turn, leaving the other 2 slots for sessions and documents. Setting to `0` disables the lane entirely.

---

### Recall Lane

`applySessionLane` already implements the session budget pattern. Extend it with a facts pass that runs **before** the session lane, giving explicitly stored facts priority:

```
ranked candidates
  → facts lane:   up to recallFactsMaxResults where collectionId === '__facts' && score >= recallFactsMinScore
  → session lane: fills up to recallSessionMaxResults of the REMAINING slots
  → main lane:    fills remaining slots from everything else
  → re-sort by normalizedScore
```

Facts run first because they were **deliberately stored** — they represent intent, not inference. A session summary hit, however high-scoring, is reconstructed context. If both match and there's only one slot left, the fact wins.

This differs from the original parallel-lane design. The practical effect: with `recallMaxResults: 3`, `recallFactsMaxResults: 1`, `recallSessionMaxResults: 1`, the worst case is 1 fact + 1 session + 1 document, with facts always taking the first slot when they qualify.

Facts get `sourceKind: "explicit_fact"` in the `<memory>` XML block so the model can distinguish them from derived content.

---

### Tools

#### `engram_remember`

```
parameters:
  content:   string   // the fact to store
  label?:    string   // optional short title; derived from content if omitted
  replaces?: string   // fact_id of an older fact this supersedes

returns:
  { factId, label, stored: true, replacedFactId?: string, conflicts?: ConflictHint[] }
```

**`replaces` is a first-class semantic operation, not an optional convenience.** When provided:
- The old fact is deleted atomically in the same transaction as the new one
- The new fact's title encodes `[supersedes:<old_id>]` for audit purposes
- The agent should always call `engram_remember` with `replaces` when updating an existing preference rather than storing a second contradicting fact

The tool description will explicitly instruct the model: _"If this fact updates or contradicts something you have previously remembered, pass the old fact's ID in `replaces`. Storing contradicting facts without superseding the old one will cause both to surface in recall."_

**Conflict detection is day-one behaviour.** When `embedEnabled` is true, `storeExplicitFact` computes a query embedding for the new content and checks cosine similarity against existing `__facts` embeddings before writing. Hits above 0.85 similarity are returned as `conflicts` in the response — the agent can then decide whether to pass `replaces` or proceed. When `embedEnabled` is false, a keyword overlap fallback (same tokenization used in `computeScore`) checks for high-overlap titles as a lightweight substitute.

#### `engram_forget`

```
parameters:
  factId: string

returns:
  { factId, deleted: true }
  { factId, deleted: false, reason: "not_found" }
```

#### `engram_review` _(already in README, not implemented)_

Lists all facts in `__facts` with their IDs, labels, creation dates, recall hit counts, and **last-hit date** from `recall_events`. Output is sorted by last-hit date ascending so the stalest facts appear first.

Critically, the review output includes an **explicit pruning prompt**: facts with zero hits in the last 30 days are flagged with `[STALE — last hit: <date> or never]`. The tool description instructs the model: _"Call `engram_forget` on any stale fact that no longer applies. Do not keep facts whose conditions have changed."_

This creates active pruning pressure rather than passive accumulation. The agent is expected to call `engram_review` periodically (e.g. at session start if fact count exceeds a threshold) and clean up.

---

### Commands

| Command | Behaviour |
|---|---|
| `/engram remember <text>` | Store a fact, return its ID |
| `/engram forget <factId>` | Delete a fact by ID |
| `/engram review` | List all stored facts with usage stats |

---

## Files Changed

| File | Change |
|---|---|
| `src/config.ts` | Add `recallFactsMaxResults`, `recallFactsMinScore` to schema, type, and defaults |
| `src/plugin/recall.ts` | Extend `applySessionLane` with facts budget; add `"explicit_fact"` source kind |
| `src/plugin/tools.ts` | Implement `createEngramRememberTool`, `createEngramForgetTool`, `createEngramReviewTool` |
| `src/plugin/commands.ts` | Add `remember`, `forget`, `review` subcommands |
| `src/plugin/entry.ts` | Register the three new tools |
| `src/kb/indexer.ts` | Add `storeExplicitFact(db, config, content, label?, replaces?)`, `deleteExplicitFact(db, factId)`, `listExplicitFacts(db)`, and `findConflictingFacts(db, config, content)` helpers |

No schema changes. No new migrations. No new dependencies.

---

## Context Bloat Analysis

| Scenario | Extra tokens per turn |
|---|---|
| No facts stored | 0 |
| Facts stored, none match query | 0 (lane produces 0 hits, no injection) |
| 1 fact matches, score ≥ threshold | ~50–80 tokens (single chunk, short by design) |
| `recallFactsMaxResults: 0` | 0 (feature fully disabled) |

Hard ceiling is `recallMaxTokens: 300` shared across all lanes. A fact cannot expand total recall beyond the existing budget.

---

## Open Questions

1. **Scope.** Should facts be global (survive across all sessions) or session-scoped (expire when the session ends)? Global is the primary use case but session-scoped facts could be useful for per-task constraints. Proposed default: global, with an optional `scope: "session" | "global"` parameter in `engram_remember`.

2. **Capacity limit.** Should there be a `recallMaxFacts` ceiling (e.g. 100) to prevent unbounded growth? The `engram_review` stale-flagging mechanism creates pruning pressure, but a hard ceiling adds a safety net. Proposed: warn (not block) when `__facts` count exceeds a configurable `factsWarnThreshold` (default 50).

---

## Resolved Questions _(from Claire's review)_

- **`replaces` framing:** Promoted from optional hint to first-class semantic operation. The tool description actively instructs the model to use it when updating a preference. ✓
- **`engram_review` pruning:** Stale facts (zero hits in 30 days) are explicitly flagged and the tool description directs the model to prune them. ✓
- **Conflict detection gating:** Day-one behaviour. Embedding-based when `embedEnabled`, keyword-overlap fallback otherwise. Not deferred. ✓
- **Lane priority:** Facts lane runs before session lane. Explicitly stored intent beats inferred context when slots are constrained. ✓
