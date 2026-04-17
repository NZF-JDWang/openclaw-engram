# Engram Critical Review

**Review of the Unified OpenClaw Memory System Plan (PLAN.md)**  
**Date:** April 17, 2026  
**Reviewer:** Grok (on behalf of the team)

This is an exceptionally strong, production-grade plan. It’s thorough, thoughtful, and shows deep domain knowledge of the three systems it’s unifying (`lossless-claw`, `qmd`, and `precog`). The architecture is coherent, the improvements are genuinely valuable, and the phased approach with explicit reference files makes implementation low-risk.

You are not just replacing three plugins — you are building the **memory substrate** that every future OpenClaw feature will depend on. The attention to provenance, user ownership, graceful degradation, and philosophical correctness is excellent.

---

## What’s Excellent (Keep These)

- **Unification strategy** is perfect. One plugin, one DB, one exclusive `context-engine` slot. No more cross-repo drift.
- **Three-level summarization escalation** (normal → aggressive → extractive TF-IDF fallback) is bulletproof. This is the single biggest reliability win over lossless-claw.
- **Provenance, contradiction detection, temporal decay, and persona layer** are the right new primitives. These turn “memory” from a black box into something auditable and trustworthy.
- **In-process + `node:sqlite` + WAL** is the correct technical choice. No subprocesses, no native extensions, no FTS5 dependency panic.
- **Explicit agent tools** (`engram_remember`/`forget`) + `/engram export` give the user full ownership. This is philosophically correct.
- **Session-to-session continuity summary** is a subtle but high-impact UX win.
- **Reference-file mapping** in Phase 10 is gold — it will prevent re-inventing wheels.

**Overall score before fixes: 9.2/10**

---

## Critical Risks & Gaps (Must Address Before Implementation)

### 1. Data Migration Story is Missing (Biggest Gap)
Users currently have `lossless-claw.db`, qmd indexes, and precog memories.  
The plan has **zero mention** of migration. On first install, users will lose their entire memory history unless we provide a clean upgrade path.

**Recommendation:**  
Add **Phase 0 — Migration** (before bootstrap). Detect existing lossless-claw/qmd/precog data and import into the new schema. At minimum, a one-time `engram migrate` command that is idempotent and logs exactly what was imported/deprecated.

### 2. Database Concurrency & Locking
OpenClaw is single-process per session today, but many users run multiple agents/sessions or use the web UI + CLI simultaneously.  
`node:sqlite` in WAL mode is good, but the plan doesn’t discuss transaction strategy for `afterTurn()` + `before_prompt_build` hooks firing in quick succession.

**Recommendation:**  
Explicitly document transaction boundaries. Every write path (`ingest`, `compact`, `indexDocument`) must use `db.transaction()` with proper retry on `SQLITE_BUSY`.

### 3. Contradiction Detection is Currently Too Weak
Current design (cosine + keyword match) will generate tons of false positives and miss subtle contradictions.

**Recommendation:**  
Make it **two-stage**:
- Stage 1 (fast, always): cosine > 0.85 + keyword overlap → flag as “possible conflict”.
- Stage 2 (only when flagged): lightweight LLM call (same summarization model, temperature 0) with a tiny “does this contradict?” prompt. Store the LLM’s verdict and explanation in `kb_conflicts`.

### 4. Persona.md Editing Model Needs Clarification
Both user and agent can append. No mention of conflict resolution when the agent writes something the user later edits.

**Recommendation:**  
Treat `persona.md` as source-of-truth **only for the user**. Agent writes go to `kb_facts` with `target: "persona"` and are periodically merged into the file (with a clear `<!-- AGENT-ADDED -->` section). On next load, the file wins.

### 5. Token Estimation Accuracy
You have `src/token-estimate.ts` (lightweight). Good.  
But the plan never states the acceptable error margin.

**Recommendation:**  
Document ±5% is fine and add a test that compares it against the model’s actual tokenizer output (if available via `api.runtime`).

### 6. Performance Budgets Not Specified
KB search must stay < 150 ms even with 50k chunks.

**Recommendation:**  
Add to config: `kbSearchTimeoutMs`, `maxSearchCandidates`, and a benchmark command in `/engram doctor`.

### 7. Testing Coverage is Under-Specified
Unit tests listed are good but insufficient for a memory system.

**Must add:**
- Full-session integration test (compaction + recall + persona).
- Deterministic replay test (fixed JSONL → identical context).
- Chaos tests (extractive fallback, DB corruption simulation, embedding endpoint down).

---

## Minor Polish / Nice-to-Haves

- **Shadow mode logging** — When `recallShadowMode: true`, also log the *would-have-been-injected* recall block to a sidecar file or OpenClaw’s debug log.
- **Deprecation policy** — Document that `lossless-claw`, `qmd`, and `precog` should be marked deprecated in the OpenClaw plugin registry once engram is stable.
- **Telemetry hooks** — Optional `api.reportMetric()` calls for compaction frequency, recall hit rate, average summary depth.
- **Doctor command enhancements** — Disk space check, SQLite `PRAGMA integrity_check`, embedding endpoint reachability.
- **Config backward-compatibility** — Mapping from old lossless-claw/qmd/precog config keys.

---

## Overall Verdict

**This plan is 9.2/10.**  
With the migration story, stronger contradiction detection, and explicit concurrency guarantees, it becomes a **10/10** foundational piece.

**Next Step Recommendation**

Before any code is written:
1. Add **Phase 0 — Migration** (2–3 days of work, but saves months of user pain).
2. Flesh out the exact transaction and error-handling contract for the DB layer.
3. Write the `engram doctor` command first — it will surface 90% of the edge cases you’ll hit later.

---

**Would you like me to:**
- Draft the full **Phase 0 Migration** spec?
- Write the detailed two-stage contradiction detection design?
- Or start on the `engram doctor` command skeleton?

Let’s make this bulletproof. This project is important — we’re building the long-term memory for OpenClaw.