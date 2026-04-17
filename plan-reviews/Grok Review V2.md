# Engram Critical Review - v2

**Review of the Updated Unified OpenClaw Memory System Plan (PLAN.md)**  
**Date:** April 17, 2026  
**Reviewer:** Grok (on behalf of the team)  
**File reviewed:** PLAN.md (51,891 bytes)

This updated plan is **excellent** — a clear and substantial improvement over the first version. You have directly and thoughtfully incorporated every piece of feedback from the previous review.

**Overall score: 9.6 / 10**  
(Up from 9.2/10. This is now genuinely production-grade architectural thinking.)

---

## What’s Excellent (Keep / Celebrate These)

- **Phase 0 Migration** is now correctly placed first and is comprehensive (idempotent, dry-run, config-compat, non-destructive). This eliminates the biggest risk from the previous review.
- **System Invariants** section is outstanding — explicit, non-negotiable design contracts like this are rare and extremely valuable.
- **Memory Class Hierarchy + Lifecycle States + approval flow** perfectly address trust, provenance, and user authority over high-trust memory.
- **Session continuity** now correctly uses purpose-built `session_end_artifacts` instead of the deepest (most lossy) summary — very smart.
- **Circuit breaker** on session-summary indexing prevents the classic feedback-loop problem.
- **PersonaManager** write rules are now correctly strict (user-only direct writes, agent proposals go to pending).
- **/engram doctor** prioritization and the full chaos/integration/deterministic test suite are exactly what this system needs.
- Technical choices (binary BLOB vectors, RRF k=15, WAL + retryOnBusy, honest FTS5 fallback, per-class decay, etc.) are high-quality.
- v1 vs v2 scoping table and clear invariants show strong engineering discipline.

The philosophical grounding (invariants, memory classes, user ownership, auditability) is now very strong. This feels like the proper long-term memory substrate for OpenClaw.

---

## Remaining Concerns & Recommendations

### 1. Scope & Complexity for v1 (Biggest Remaining Risk)
v1 now includes migration system, 4 logical DB layers, full memory classes + lifecycle + approval workflow, session-end artifact builder, per-class scoring, etc.

This is ambitious. Risk: longer time-to-working-product and higher chance of subtle bugs in the governance layers.

**Recommendation:**  
Consider defining a **minimal viable v1.0** that ships the core (compaction + KB + recall + persona read + migration) and moves the full approval workflow (`/engram review`) and some lifecycle polish to v1.1. Document this clearly.

### 2. Approval Workflow UX
Requiring users to run `/engram review` and manually approve every agent-proposed fact may feel burdensome in daily use.

**Recommendation:**  
- Add quick sub-commands: `/engram approve <id>` and `/engram reject <id>`
- Add config option `autoPromoteAfterDays` (default 7–14) for non-identity classes.

### 3. session_end Hook Reliability
Heavy reliance on the `session_end` hook. We don’t know how reliably it fires in all scenarios (crashes, CLI `/new`, web UI close, etc.).

**Recommendation:**  
Ensure `bootstrap()` has robust fallback logic if no artifact exists (already partially noted — make it bulletproof).

### 4. Migration Performance
Re-chunking very large QMD collections during migration could be slow.

**Recommendation:**  
Add progress reporting and consider a "lazy" migration mode for large indexes.

### 5. Minor Polish
- Scoring logic is now complex (RRF + per-class decay + hierarchy boost + derivation penalty). Thorough tests in `scorer.test.ts` will be critical.
- Explicitly document performance budgets (e.g. "KB search < 150 ms at 10k chunks").
- Add memory-class breakdown to `/engram status`.

---

## Overall Verdict

**This is now a very mature, principled, and well-designed plan.**  
With the previous feedback fully actioned, the plan feels ready for implementation. The remaining risks are mostly about pacing and UX polish rather than fundamental flaws.

You have successfully turned three separate plugins into a coherent, auditable, user-owned, and philosophically sound memory system.

**Great work.**

---

## Next Step Recommendations

Would you like me to help with any of the following?

1. Draft a **Minimal Viable v1.0 Scope** document (recommended before coding begins).
2. Write the detailed skeleton / implementation plan for **`/engram doctor`**.
3. Create the full **Migration Runner** spec or pseudocode.
4. Anything else (e.g. specific module deep-dive, test plan refinement, etc.).

This project is in excellent shape.

---

**Save this as `ENGRAM-CRITICAL-REVIEW-v2.md`** (next to your updated `PLAN.md`).  
Copy the entire block above into a new file and you’re done.