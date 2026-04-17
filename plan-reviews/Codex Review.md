# Critical review of the `engram` unified OpenClaw memory plan

## Bottom line

This is a **strong, ambitious design**, but in its current form I would **not** treat it as implementation-ready for a vital memory substrate.

My view from first principles:

- The plan is **directionally right** about unifying memory under one plugin.
- It is **too eager to merge different memory classes** that have very different correctness requirements.
- Its biggest weakness is **epistemic hygiene**: it does not cleanly separate raw history, derived summaries, retrieved documents, and durable user facts.
- Its second biggest weakness is **operational coupling**: compaction, indexing, recall injection, persona management, and continuity are all close enough together that a fault in one layer can silently contaminate another.
- Its third biggest weakness is **trust calibration**: the system has several ways to confidently inject low-quality or stale information.

So: **good architecture sketch, unsafe as a first implementation**.

---

## What the plan gets right

## 1. It correctly identifies that these are really one memory problem

The plan is right to unify:
- conversation compression,
- searchable knowledge,
- proactive recall,

because users experience these as one thing: *“does the agent remember and use the right information at the right time?”*

That is a sound product-level insight.

## 2. Provenance is the single best idea in the whole document

The addition of provenance and source kinds is one of the strongest parts of the design. If memory is going to be trusted, the system must know whether something was:
- directly stated by the user,
- inferred by the agent,
- imported from a document,
- derived from a summary.

That instinct is excellent.

## 3. Extractive fallback is the correct failure posture

The plan is correct that memory compaction cannot simply fail because an LLM call timed out. A deterministic fallback is important.

## 4. Human review/export is the right trust mechanism

`/engram export` is one of the healthiest ideas in the plan. Memory systems become dangerous when they become invisible.

## 5. No native deps is a good constraint

For a local plugin ecosystem, fewer binary dependencies means better portability, easier installation, and fewer weird edge-case failures.

---

## The core flaw: this plan mixes four different kinds of truth

From first principles, a memory system should not ask one substrate to do too many epistemically different jobs.

This plan currently blends:

1. **Immutable event history**  
   What was actually said or observed.

2. **Derived compression artifacts**  
   Summaries of history, which are lossy and probabilistic.

3. **Searchable external/document knowledge**  
   Markdown files, exports, notes, session summaries.

4. **Durable user facts / identity / preferences**  
   Things the system should treat as stable and important.

Those are not the same thing. They should not be promoted, decayed, forgotten, contradicted, or injected using the same rules.

That distinction is only partially present in the plan.

---

## The biggest architectural risks

## 1. `persona.md` is a footgun

The plan says `persona.md` is always injected and can be written by both the user and the agent via `engram_remember`.

That is dangerous.

Why:
- Always-injected context is the highest-trust lane in the whole system.
- If the model writes to it, the model can gradually rewrite the operating assumptions of the assistant.
- A single bad memory write can persist across every future turn.
- This is exactly the wrong place for auto-promotion.

A vital rule should be:

> The highest-trust memory tier must have the hardest write path.

My recommendation:
- `persona.md` should be **read-mostly**.
- Only the **user** or an explicit admin action should write to it.
- Agent-written candidate facts should go to a **pending/promoted** table, never directly into persona.
- “Core/project/note” is not enough. You need `write_policy`, `approval_state`, and `confidence_basis`.

As written, this is the most likely source of long-lived memory corruption.

---

## 2. Session summaries should not be treated like normal KB documents

The plan auto-indexes session summaries into a `__sessions` collection and allows recall to search them.

This can work, but it creates a nasty feedback loop:

1. conversation gets summarized,
2. summary gets indexed,
3. later retrieval pulls summary text,
4. retrieved summary is injected,
5. future summarization compresses a conversation that already contains retrieved summary text.

Now the system starts remembering its own abstractions instead of the original facts.

This is one of the classic failure modes in memory systems: **self-referential drift**.

Recommendation:
- Treat session summaries as a separate retrieval class with lower priority than raw user-stated facts.
- Never let summary-derived memories auto-promote into durable fact memory.
- Carry `derivation_depth` and penalize it in ranking.
- Prefer the most primary source available:
  - user-stated fact > explicit memory > raw transcript chunk > session summary > continuity summary.

Right now the plan has provenance, but not a strong enough *source hierarchy*.

---

## 3. Contradiction detection is underspecified and likely to be noisy

The plan proposes contradiction detection using cosine similarity plus keyword match / “opposing sentiment markers.”

This is not robust enough for factual contradiction.

Examples:
- “I live in Auckland” vs “I moved to Wellington”  
  Not sentiment.
- “Use provider A by default” vs “We migrated to provider B last week”  
  Not sentiment.
- “The service runs on BSL1” vs “We are moving the service to BSL2”  
  Temporal update, not contradiction in the naive sense.

The problem is that contradiction is not just similarity with opposite words. It depends on:
- entity resolution,
- time,
- scope,
- whether the new statement supersedes the old one,
- whether both can be true in different contexts.

Recommendation:
- Do **not** ship contradiction detection in v1 as an automated gate.
- Replace it with **conflict surfacing**:
  - detect likely overlapping claims,
  - attach them as related records,
  - let higher layers decide.
- Store facts as `(subject, predicate, object, valid_from, valid_to?, source, confidence)` if you want true contradiction handling later.

As written, this feature sounds impressive but is likely to create false positives and false reassurance.

---

## 4. Time decay is useful for retrieval, but dangerous for user facts

The plan applies decay to BM25/vector scores with a 90-day half-life, bypassed for exact keyword hits.

That is reasonable for notes and project context.
It is **not** reasonable as a general retrieval policy across all memory classes.

Some old information should decay:
- transient work context,
- recent task state,
- stale plans.

Some old information should not decay at all:
- name,
- writing preferences,
- durable personal constraints,
- architectural invariants unless explicitly superseded.

Recommendation:
- Decay should be **per memory class**, not global.
- Suggested classes:
  - `identity`: no decay
  - `preference`: very slow decay or none
  - `project_state`: medium decay
  - `task_context`: aggressive decay
  - `document_reference`: decay by document freshness and collection
  - `summary`: stronger decay and source penalty

The current design has one decay concept, but memory quality depends on *type-aware retrieval*.

---

## 5. `engram_remember` is under-governed

Explicit write tools are powerful, but the proposed interface is too permissive.

Problems:
- `importance` is subjective and model-facing.
- `target?: "persona" | "kb"` gives the model too much write authority.
- No required provenance basis.
- No dedupe / canonicalization / normalization step is specified.
- No review state.
- No TTL / expiry.
- No distinction between user-requested memory and agent-inferred memory.

Recommendation:
`engram_remember` should require structured intent, something like:

```json
{
  "content": "...",
  "memory_type": "identity|preference|project_state|task_state|fact_candidate",
  "source_basis": "user_stated|agent_inferred|document_derived",
  "scope": "global|project|session",
  "expiry": "none|date|duration",
  "requires_approval": true
}
```

And the write policy should be:
- `user_stated + global identity/preference` → candidate for durable memory
- `agent_inferred` → never directly durable
- `session/task` → session store or expiring fact table
- `document_derived` → searchable KB, not persona

The current tool design is too loose for a critical system.

---

## 6. The compaction target sizes are risky

The plan uses:
- `leafChunkTokens = 20000`
- `leafTargetTokens = 2000`
- `condensedTargetTokens = 1500`

From first principles, a 20k-token chunk being collapsed to 2k is a 10:1 compression ratio. That is high for preserving action-relevant details, tool results, caveats, and user commitments.

This is especially risky if tool outputs and conversation state are mixed together.

Potential failure:
- summaries preserve themes but lose precise commitments,
- the system becomes broadly coherent but operationally unreliable.

Recommendation:
- Prefer smaller semantic compaction units.
- Separate summarization strategies for:
  - normal dialogue,
  - tool results,
  - commitments / promises / decisions,
  - unresolved questions.
- Preserve structured “decision ledger” artifacts that are not compressed the same way as freeform chat.

A memory system fails not when it forgets the vibe, but when it forgets the one thing that mattered.

---

## 7. Lightweight token estimation is a hidden reliability risk

The file tree includes `token-estimate.ts` with a “lightweight token estimator.”

That worries me.

A context engine lives or dies on budget correctness.
If token estimation is bad, you get:
- compaction too late,
- prompt overflow,
- malformed recall decisions,
- unstable behavior across providers.

Recommendation:
- Do not rely on a naive estimator for compaction triggers in a critical system.
- If the active runtime exposes tokenizer-compatible counts, use that.
- Otherwise, keep a conservative margin and test worst-case prompts.
- Store both `estimated_tokens` and `actual_tokens` when possible, then calibrate.

This sounds minor, but this kind of detail quietly wrecks reliability.

---

## 8. FTS5 fallback to `LIKE '%...%'` is operationally ugly

The plan says if FTS5 is unavailable, search falls back to SQL `LIKE`.

That is acceptable only as an emergency fallback for tiny datasets.
It is not a serious retrieval strategy.

Problems:
- poor relevance,
- poor performance,
- poor phrase handling,
- noisy matches,
- weak scalability.

If FTS5 support is uncertain across platforms, then the plan needs to explicitly define:
- minimum supported platform,
- degraded-mode expectations,
- hard cap for collections in `LIKE` mode,
- operator warnings.

Recommendation:
- If FTS5 is absent, either:
  - hard-disable KB search above a small threshold, or
  - use a tiny pure-JS inverted index instead of pretending `LIKE` is fine.

---

## 9. One SQLite DB for everything is convenient, but tightly coupled

I understand the appeal of one DB. Operational simplicity matters.

But this plan stores:
- transcript,
- summaries,
- retrieval index metadata,
- embeddings,
- explicit facts,
- conflict records,
- bootstrap state,

all in one file.

This is convenient, but it means:
- hot write paths and cold analytical paths share one store,
- one corruption or migration bug affects everything,
- backup/restore granularity is poor,
- import/export semantics become messy,
- retrieval and conversation engine lifecycles are tightly coupled.

I would not necessarily split this on day one, but I would at least separate by **logical boundaries**:
- immutable transcript layer,
- derived memory layer,
- KB/index layer,
- durable fact layer.

Even if they stay in one DB physically, the architecture should behave as though they are different stores.

Right now the schema is not opinionated enough about those boundaries.

---

## 10. Recall injection is still too permissive

The plan uses:
- query extraction,
- score thresholds,
- gap checks,
- deduplication,
- time decay,
- compression,
- injection into system context.

That is thoughtful, but I still think the retrieval-to-injection bridge is too direct.

The real question is not “is this relevant?”
It is “is this relevant **enough to deserve system-level authority**?”

System prompt injection is powerful. It should be treated as privileged memory.

Recommendation:
- Introduce **retrieval classes** and inject them differently:
  - `identity/preference` → system context
  - `project state` → assistant-visible working memory block
  - `reference docs` → tool-accessible citations or low-trust recall block
  - `session continuity` → low-priority orientation block
- Add source labels directly in injected text:
  - `user_stated`
  - `agent_inferred`
  - `document`
  - `summary_derived`
- Cap at one retrieved item per class unless confidence is very high.

Right now the plan is strong on scoring, weaker on *trust tiering*.

---

## 11. Continuity from the “highest-depth summary” is the wrong default

The plan picks the highest-depth summary from the previous session for the continuity block.

That sounds elegant, but it is not obviously correct.

The highest-depth summary is the most compressed and most abstract. That often makes it the *least safe* source for session restart, because:
- it may omit unresolved details,
- it may smooth over uncertainty,
- it may preserve themes instead of facts,
- it is furthest from the original ground truth.

Recommendation:
- Build continuity from a dedicated session-end artifact, not whichever summary is deepest.
- That artifact should have structured fields:
  - what the user was trying to do,
  - what was decided,
  - what is unresolved,
  - what must not be assumed,
  - suggested reopening context.
- If absent, prefer the **lowest sufficient abstraction**, not the deepest.

This is a subtle but important design correction.

---

## 12. The plan has too few invariants

A critical memory system needs explicit non-negotiable rules.

The plan has phases, modules, and tests, but not enough hard invariants.

I would want these stated up front:

1. **Raw transcript is immutable.**
2. **Derived summaries never overwrite raw evidence.**
3. **Agent-inferred facts never auto-promote to highest-trust memory.**
4. **Every injected memory must carry provenance and memory class.**
5. **Supersession is explicit; old facts are not silently replaced.**
6. **Forgetting hides or retires facts but does not destroy auditability.**
7. **Search ranking is type-aware.**
8. **A more-derived artifact may not outrank a less-derived artifact without a strong reason.**
9. **User-approved facts outrank model-inferred facts.**
10. **Memory write and memory recall are separately testable subsystems.**

Without these, implementation drift is likely.

---

## What is missing entirely

## 1. A memory state machine

This is the biggest omission.

Memories need lifecycle states, not just rows in tables.

For example:

- `captured`
- `candidate`
- `validated`
- `durable`
- `deprecated`
- `superseded`
- `expired`

Right now the plan has `deprecated_at`, but not a full lifecycle.
That makes governance too weak.

## 2. Supersession semantics

A lot of memory is not contradiction. It is update.

You need:
- “replace old preference”
- “new project status supersedes old status”
- “location changed”
- “old architecture note kept for history but no longer current”

Without explicit supersession, the store accumulates multiple truths.

## 3. Scope boundaries

Facts need scope:
- global,
- agent-specific,
- project-specific,
- session-specific,
- task-specific.

The plan hints at this, but does not model it strongly enough.

## 4. A separate decision ledger

The system should preserve:
- commitments,
- accepted plans,
- chosen defaults,
- explicit user constraints,

as structured artifacts, not only as summary text or persona facts.

## 5. Evaluation beyond unit tests

The test plan is good for mechanics, but weak for memory quality.

You need evaluation sets for:
- retrieval precision,
- harmful injection rate,
- continuity correctness,
- false memory creation,
- stale memory resurfacing,
- supersession handling.

A memory system can pass all unit tests and still be bad.

---

## My recommended redesign

I would keep the overall vision, but change the internal architecture.

## Use four explicit stores

## A. Event store
Immutable.
- raw messages
- tool calls
- tool outputs
- timestamps
- session boundaries

No ranking. No decay. No mutation.

## B. Derived store
Lossy and replaceable.
- summaries
- continuity notes
- compressed recall snippets

Every item must point back to source evidence.

## C. Fact store
Structured and governed.
- durable user facts
- preferences
- project state
- decision ledger
- supersession links
- lifecycle state
- provenance

This is where “memory” should really live.

## D. Document store
Search-oriented.
- indexed markdown
- chunks
- embeddings
- collection metadata

This is knowledge retrieval, not identity memory.

That separation matters more than whether they share a DB file.

---

## Use trust tiers for retrieval and injection

Instead of one relevance score, use two axes:

- **relevance**
- **trust**

Example trust ranking:
1. user-approved durable fact
2. user-stated transcript-derived fact
3. raw transcript evidence
4. external document chunk
5. summary-derived memory
6. agent-inferred candidate fact

Then only certain tiers may enter system context by default.

---

## Make memory promotion explicit

Proposed promotion path:

1. raw event captured
2. candidate fact extracted
3. dedupe/canonicalization
4. confidence + scope assignment
5. optional user/admin approval
6. durable fact
7. later superseded/deprecated/expired

That is much safer than writing straight to `persona.md`.

---

## Separate continuity from compaction

Do not derive continuity from the deepest summary.
Make a dedicated session-close artifact:

```md
Session intent:
Decisions made:
Open loops:
Current project state:
Do not assume:
```

That will outperform generic deep summaries for restart.

---

## Delay contradiction detection

Ship:
- overlap detection,
- possible conflict surfacing,
- supersession links.

Do not ship automated contradiction logic until the fact model is structured.

---

## What I would cut from v1

If this were my project and I wanted the highest chance of getting a reliable first version, I would cut or demote:

- automatic contradiction detection
- agent writes to persona
- deep continuity from highest-depth summary
- `LIKE` as a pretend full fallback for serious retrieval
- any automatic promotion from summary-derived content into durable facts

Those are the highest-risk features relative to their value.

---

## What I would build first instead

## V1: make it trustworthy, not clever

1. **Transcript + compaction**
   - immutable event store
   - summary DAG
   - deterministic fallback
   - no durable memory writes yet

2. **Document KB**
   - chunking
   - BM25
   - optional embeddings
   - no contradiction logic yet

3. **Read-only recall**
   - retrieve and inject with provenance
   - no fact promotion
   - strict trust-tier labels

4. **Structured durable fact store**
   - user-stated and user-approved facts only
   - no agent auto-promotion to persona
   - scope + lifecycle + supersession

5. **Continuity artifact**
   - dedicated session-close summary
   - not generic highest-depth summary

6. **Agent candidate memory writes**
   - only after the above is stable
   - candidates, not direct durable writes

That ordering will massively reduce the chance of building something impressive but unreliable.

---

## Concrete schema changes I would make

## Replace `persona.md` as the primary durable layer

Keep the file if you want human-editable export/import, but do not make it the canonical live store.

Use a table more like:

- `facts`
  - `fact_id`
  - `subject`
  - `predicate`
  - `object_json`
  - `memory_class`
  - `scope`
  - `source_kind`
  - `source_ref`
  - `confidence`
  - `approval_state`
  - `valid_from`
  - `valid_to`
  - `supersedes_fact_id`
  - `created_at`
  - `updated_at`
  - `deprecated_at`

Then generate `persona.md` as a view/export if desired.

## Add a decision table

- `decisions`
  - `decision_id`
  - `scope`
  - `statement`
  - `status`
  - `source_ref`
  - `created_at`
  - `superseded_by`

This will save more real-world pain than fancy contradiction detection.

## Add derivation metadata to every derived artifact

- `source_type`
- `source_ids`
- `derivation_depth`
- `generated_by`
- `generated_at`

This lets ranking penalize abstraction.

---

## My verdict by section

## Vision
Good. Keep it.

## Summarization strategy
Mostly good, but compaction needs stronger guardrails around what must never be compressed away.

## Provenance
Excellent instinct. Expand it further.

## Contradiction detection
Premature and weakly specified. Demote.

## Temporal decay
Useful, but must be type-aware.

## Persona layer
Useful idea, unsafe write policy.

## Explicit memory tools
Good concept, underdesigned governance.

## Continuity
Useful, wrong source choice.

## Export/review
Very good. Keep.

## SQLite / no-native constraint
Reasonable, but do not over-romanticize `LIKE` fallback.

## Tests
Mechanically decent, but missing system-quality evals.

---

## Final judgment

If you build this exactly as written, I think you will get:

- a system that **looks sophisticated quickly**,
- works **well enough in demos**,
- but develops **hard-to-debug trust failures** over time.

Specifically:
- stale or over-compressed context will reappear,
- the system will sometimes recall abstractions instead of ground truth,
- durable memory will be too easy for the model to contaminate,
- conflicts will be surfaced inconsistently,
- and debugging “why did it think that?” will become painful.

If you **separate memory classes more aggressively**, **tighten write authority**, and **treat durable facts as a governed store rather than a markdown file plus search**, this could become a very strong foundation.

My blunt version:

> The plan is good enough to inspire implementation, but not good enough to trust as the core memory substrate without redesigning the fact model and write path.

---

## Highest-priority changes before implementation

1. Remove agent direct writes to `persona.md`
2. Separate durable facts from summaries/documents
3. Add lifecycle + supersession model for facts
4. Treat session summaries as lower-trust derived artifacts
5. Build dedicated continuity artifacts instead of using deepest summary
6. Make retrieval ranking type-aware, not just score-based
7. Replace contradiction detection with conflict surfacing in v1
8. Treat `LIKE` fallback as degraded mode, not normal mode
9. Add evaluation harnesses for false recall / stale recall / bad promotion
10. Write explicit architectural invariants before coding

---

## Overall score

- **Product vision:** 8.5/10
- **Architecture ambition:** 9/10
- **Operational safety:** 5/10
- **Epistemic hygiene:** 5.5/10
- **V1 implementation readiness:** 6/10

My real verdict: **promising, but too unsafe to build exactly as-is**.
