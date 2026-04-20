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

---

### New Config Keys

| Key | Type | Default | Purpose |
|---|---|---|---|
| `recallFactsMaxResults` | `integer ≥ 0` | `1` | Max slots reserved for `__facts` hits |
| `recallFactsMinScore` | `number 0–1` | `0.45` | Min normalized score to surface a fact |

Default of `1` means at most one fact per turn, leaving the other 2 slots for sessions and documents. Setting to `0` disables the lane entirely.

---

### Recall Lane

`applySessionLane` already implements the session budget pattern. Extend it with a facts pass:

```
ranked candidates
  → facts lane:   up to recallFactsMaxResults where collectionId === '__facts' && score >= recallFactsMinScore
  → session lane: up to recallSessionMaxResults where collectionId === '__sessions' && score >= recallSessionMinScore
  → main lane:    fills remaining slots from everything else
  → re-sort by normalizedScore
```

Facts also get `sourceKind: "explicit_fact"` in the `<memory>` XML block, so the model can distinguish them from derived content.

---

### Tools

#### `engram_remember`

```
parameters:
  content:   string   // the fact to store
  label?:    string   // optional short title; derived from content if omitted
  replaces?: string   // fact_id of an older fact this supersedes

returns:
  { factId, label, stored: true }
```

#### `engram_forget`

```
parameters:
  factId: string

returns:
  { factId, deleted: true }
  { factId, deleted: false, reason: "not_found" }
```

#### `engram_review` _(already in README, not implemented)_

Lists all facts in `__facts` with their IDs, labels, creation dates, and recall hit counts from `recall_events` — so the agent can identify and prune stale ones.

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
| `src/kb/indexer.ts` | Add `storeExplicitFact(db, config, content, label?)` and `deleteExplicitFact(db, factId)` helpers |

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

2. **Capacity limit.** Should there be a `recallMaxFacts` ceiling (e.g. 100) to prevent unbounded growth? The recall lane naturally suppresses irrelevant ones, but the `__facts` collection could grow large without pruning pressure.

3. **Conflict detection.** The existing `conflicts` command surfaces similar durable facts. Should `engram_remember` automatically warn if a semantically similar fact already exists? This requires embedding support to be useful and should be gated on `embedEnabled`.
