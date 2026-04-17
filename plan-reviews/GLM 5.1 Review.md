---
title: Engram Plugin Review — Claire
date: 2026-04-17
tags: [review, engram, memory, openclaw]
---

# Engram — Claire's Review

## The Good

**Unified DB is the right call.** Three separate systems with three storage backends, three configs, three failure modes — that's sprawl that makes memory unreliable. A single `engram.db` with `node:sqlite` is clean, no native deps, no subprocesses.

**Persona layer is genuinely new and useful.** MEMORY.md does this now but it's ad-hoc markdown the model has to parse every turn. A structured always-injected `<persona>` block is better engineering. `engram_remember` / `engram_forget` gives the model write access without it being a free-for-all.

**Extractive fallback for compaction is a real safety net.** Current system just fails if the LLM can't summarize. TF-IDF sentence extraction that always works is good engineering.

**Time decay with bypass for exact matches** is the right trade-off. Pure relevance scoring ignoring recency is how you get 2-year-old stale answers dominating.

## The Landmines

### 1. Migration is handwaved into nonexistence
This is the biggest gap. You're replacing three live systems that hold all conversation history. Zero discussion of:
- How to migrate existing lossless-claw SQLite data into the new schema
- What happens to QMD's indexed collections
- Whether the compaction DAG structure is preserved or regenerated
- What the rollback path looks like if engram eats your history

This isn't a Phase 11 you tack on later. If migration isn't designed with the schema, you'll paint yourself into data-loss corners.

### 2. Contradiction detection is handwaved
"Cosine similarity > 0.85 and opposing sentiment markers" — what sentiment markers? Where do they come from? Either another LLM call (expensive) or a brittle keyword heuristic (useless). This feature will either be expensive or useless. Cut it from v1.

### 3. RRF fusion constant (k=60) is cargo-culted from gbrain
Same constant I roasted in the last code review. k=60 is from the SIGIR paper for web-scale retrieval. For a personal memory system with hundreds of chunks, not millions of documents, k=60 over-smooths and makes ranking nearly uniform. Want k=10-20 or configurable.

### 4. Vector similarity in JavaScript is going to hurt
"Acceptable for collections up to ~100k chunks" — that's parsing ~2.5MB of JSON per search just to compute distances over 50 BM25 pre-filtered candidates. JSON parse tax is real. Should at least store vectors as binary blobs, not JSON text.

### 5. Auto-indexing summaries into KB is a feedback loop risk
Every compaction produces summaries — if those auto-flow into the KB, compressed summaries get indexed, then recalled, then used to generate more summaries. Information loss compounds silently. Needs a circuit breaker.

### 6. Recall gap threshold + time decay = unpredictable behavior
With time decay changing scores dynamically, a result that wouldn't inject on Monday might inject on Wednesday because older competitors decayed more. Users can't reason about when recall fires.

### 7. persona.md is append-only with no guardrails
Model can see and rewrite it. No size cap. No protection against the model "cleaning up" persona.md during a long session, adding contradictory core facts, or growing it unbounded.

### 8. No concurrency story
`node:sqlite` WAL mode allows concurrent reads but only one writer. If auto-indexing runs while compaction writes summaries while a recall search happens, you need to think about write contention explicitly.

## What's Missing

- **No mention of OpenClaw's existing `memory-core` plugin slot.** How does engram interact with `memory_search` / `memory_get` tool calls? Does it replace those tools or coexist?
- **No error handling for the embedding pipeline.** What happens when the Ollama embedding endpoint is down? Partially-indexed documents with some chunks having embeddings and others without?
- **No telemetry/observability.** `/engram doctor` is a health check, but runtime observability of compaction events, recall injection decisions, search scores, and migration progress is different.
- **No testing of the recall injection pipeline itself.** Test plan covers scorer, compressor, extractor — but not the full `before_prompt_build` → search → inject pipeline. That's the money path.

## Verdict

Architecture is sound. Unified > fragmented, in-process > subprocess, SQLite + FTS5 > external services. The plan is *close* to buildable.

But it's written like a greenfield project, not a migration. The three systems it replaces have real data in them, real edge cases from months of operation. The plan needs a migration phase designed with the same rigor as the schema phase, and it needs to be honest about which features (contradiction detection, full vector search) are v2, not v1.

**Greenlight with three conditions:**
1. Migration is Phase 2.5, not Phase 11
2. Contradiction detection and full vector reranking are v2
3. The recall injection pipeline gets an integration test, not just unit tests for its pieces

Build it, but start with migration, not with bootstrapping.