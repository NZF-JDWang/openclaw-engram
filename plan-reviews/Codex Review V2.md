# Critical review of the updated `engram` unified OpenClaw memory plan

## Bottom line

Yes — this is a **much stronger plan**.

The biggest improvement is that it now has actual **governing principles**, not just mechanisms. The new invariants, memory classes, lifecycle states, restricted persona write path, dedicated session-end artifacts, and explicit migration phase all address the most dangerous weaknesses in the first draft.

My revised verdict:

**This is now architecturally credible.**  
But I still would not call it implementation-ready without tightening a few areas that are still underspecified or optimistic.

---

## What is now clearly better

The strongest fixes are:

- **System invariants** are now explicit, especially immutable raw transcript, no auto-promotion of agent-inferred facts, explicit supersession, and separation of write vs recall paths. That is exactly the kind of discipline a memory substrate needs.
- **Memory class hierarchy** is a major improvement. Decay, write path, and injection trust now vary by class instead of pretending all memory behaves the same.
- **`persona.md` is no longer agent-writable**, which removes one of the highest-risk trust failures from the original design. Agent suggestions now go through pending approval instead.
- **Continuity now comes from a purpose-built session-end artifact**, not the deepest summary. That is the right correction.
- **Migration is now first-class**, which is good architecture hygiene and also realistic product thinking.
- **FTS5 fallback is now honest**, instead of pretending `LIKE` is a real substitute at scale.
- **The session-summary feedback loop is partially addressed** with derivation depth and a circuit breaker. That is a meaningful improvement.

So the plan has moved from “good vision, unsafe core” to “good architecture with some risky edges.”

---

## What still worries me

### 1. The fact model is still too unstructured

`kb_facts` is better than before, but it still stores `content` as a blob of text rather than a more structured claim model. That means supersession, dedupe, conflict surfacing, and approval workflows will all be harder and noisier than they need to be.

If you want this system to stay sane over time, durable facts should eventually move toward something more like:
- subject
- predicate
- object / value
- scope
- valid_from
- valid_to
- source
- confidence

Right now, you’ve improved governance, but not fully improved **fact shape**.

### 2. Lifecycle states are good, but the transition rules are still fuzzy

The lifecycle model is much better, but there is still ambiguity around what upgrades a fact from:
- `captured` → `candidate`
- `candidate` → `validated`
- `validated` → `durable`

The table says “user explicit approval or time passage” for durable in places, and that makes me nervous. Durable memory should not happen because enough time passed unless that rule is extremely narrow and explicit.

I would want hard rules like:
- agent-inferred facts never become durable without approval
- user-stated identity/preferences may become validated immediately
- project/task facts may expire rather than become durable unless promoted

### 3. Scope is present, but still underpowered

You now have `global/agent/project/session` in parts of the schema and tool interface, which is good. But I still don’t think the retrieval side is fully specified around scope precedence.

You need explicit ranking rules like:
- current session beats agent/global for task context
- project scope beats global for project-state queries
- expired or superseded facts never participate in normal recall
- scope mismatch should be a hard penalty

Otherwise the schema supports scope, but behavior won’t.

### 4. The decision ledger is a good idea, but still feels bolted on

Calling decisions rows in `kb_facts` with `memory_class: "project"` and `source_basis: "decision"` is workable, but it still feels like a special case hidden inside a generic table.

Decisions are unusually important because they are the things users get most annoyed about when forgotten. I would seriously consider a dedicated `decisions` table or at least a strict view/interface over `kb_facts` so decisions can be:
- listed separately
- preserved separately
- ranked separately
- superseded separately

### 5. Compaction is still probably too coarse

The trust model is much better, but the actual compaction strategy still looks aggressive:
- 20k source tokens
- 2k leaf target
- 1.5k condensed target

That may be fine for casual thematic memory, but not for preserving exact commitments, tool outcomes, and unresolved technical constraints. I still think the plan needs a concept of **protected structured residues** that are not compressed like normal chat:
- decisions made
- unresolved questions
- explicit user constraints
- promised follow-ups
- tool results that changed system state

Without that, the summary DAG may stay coherent while losing the operational details that actually matter.

### 6. Token estimation is still a weak point

The plan now acknowledges the estimator is conservative and should be calibrated, which is good. But a character-based estimator with an “acceptable error margin” of ±10% is still a lot for a context engine.

That might be survivable if you build in enough headroom, but this should be treated as a temporary approximation, not a stable subsystem.

### 7. Auto-migration is convenient but dangerous

Auto-migrating on first launch if sources are detected is convenient, but it is also the kind of thing that can make users very unhappy if:
- the source schema version is unexpected,
- import partially succeeds,
- imported data is structurally valid but semantically wrong,
- the user wanted inspection before mutation.

I know the plan says it is non-destructive and idempotent, but I would still strongly prefer:
- automatic **detection**
- optional or clearly logged **execution**
- backup snapshot before import
- migration report persisted somewhere human-readable

### 8. Summary indexing is improved, but not fully safe

The derivation-depth circuit breaker is smart. But `kbAutoIndexSessions` is still dangerous enough that I would consider shipping it disabled by default until you have evaluation data.

Even depth-0 summaries are still abstractions. They are safer than condensed summaries, but they are not primary evidence.

My instinct:
- keep it
- default it off or “shadow only” in early builds
- turn it on after recall quality testing

### 9. Recall trust tiering is much better, but scoring is still doing too much

The new trust-tiered injection path is a major improvement. But the design still relies heavily on scoring heuristics to decide what gets injected where.

I would want explicit hard gates in addition to score:
- never inject pending facts
- never inject superseded/deprecated/expired facts
- cap one result per class unless exact-match override
- never inject summary-derived content if a user-stated or document-primary source exists for the same subject

That’s the difference between “good ranking” and “safe recall.”

---

## My blunt read now

The first version felt like:

**“smart ideas, dangerous coupling.”**

This version feels like:

**“good architecture, but still needs sharper operational rules.”**

That is a big improvement.

---

## What I would still change before coding

If this were my project, I would make these last changes before implementation:

1. **Tighten lifecycle transition rules** so durable memory cannot happen vaguely.
2. **Add stronger scope precedence rules** on retrieval and injection.
3. **Separate decisions more clearly** from generic facts.
4. **Add protected structured residues** so compaction cannot lose commitments and unresolved items.
5. **Make migration safer** with automatic backup/export and explicit reporting.
6. **Consider shipping session-summary indexing off by default** until validated.
7. **Treat token estimation as provisional** and build in a larger safety margin.
8. **Define hard recall exclusion rules** beyond score-based ranking.

---

## Final verdict

I would now score it roughly like this:

- **Product vision:** 9/10
- **Architecture:** 8.5/10
- **Trust model:** 8/10
- **Operational safety:** 7/10
- **Implementation readiness:** 7.5/10

So:

**This is now good enough to proceed into design-to-build transition, but not good enough to skip a final hardening pass.**

The original big conceptual problems are mostly fixed. What remains is the kind of stuff that causes pain in production rather than embarrassment on paper.
