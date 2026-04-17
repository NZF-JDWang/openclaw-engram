Yeah, there are a few real issues in the injection pipeline. Let me think through the actual flow:

before_prompt_build → extract query → substance gate → KB search → time decay → dedup → shouldInject → compress → inject

1. Dedup fights relevance. The 60% word-overlap check against the last 20 messages will kill the most relevant recalls. If you just asked about "Docker networking on BSL1" and the top recall is about Docker networking on BSL1, it gets deduped — even though the recall might contain details you don't currently have in context. The dedup protects against obvious redundancy but also prevents the recall from adding information that's topically adjacent but factually distinct.

2. The score space is incoherent. RRF fusion produces small fractional scores. Then source hierarchy boosts multiply by 1.5×. Then time decay applies an exponential. These are different mathematical operations on different scales with no normalization step. A recallMinScore: 0.65 threshold on this composite score is basically arbitrary — you can't reason about whether 0.65 is the right number because the score has no defined range. The recallHighConfidenceScore: 0.85 bypass might never trigger, or might always trigger, depending on how the boosts stack.

3. prependSystemContext accumulates. Project-class facts get injected via prependSystemContext, described as "cache-friendly, persists across turns." That means project facts never get evicted. If the model writes 5 project facts across 10 turns, they all sit in the system prompt forever, eating budget. There's no eviction, no cap, no TTL enforcement on what's already injected. It's a context window memory leak.

4. The 150ms timeout has no partial result handling. If BM25 takes 120ms and vector reranking hasn't started, does the timeout kill the whole search and return nothing? Or return the BM25 results without reranking? The plan says kbSearchTimeoutMs: 150 but doesn't specify behavior on timeout. For a system where recall injection is supposed to be fast and reliable, silently returning zero results on timeout is a silent failure mode.

5. "Exact keyword match bypasses decay" is undefined. What counts as exact? Full-word match? Stemmed match? Substring? If "docker" appears in the query and a 2-year-old fact mentions "Docker," does that bypass the 90-day decay? This creates a loophole where any common term in the query makes all matching facts immune to recency scoring, regardless of whether the fact is actually still relevant.

6. The extractor can lose query context. It strips <system> and <context> blocks. But users often ask follow-ups that reference injected context: "based on the error above, how do I fix it?" The extractor would strip the error context and leave just "how do I fix it?" — a query too vague to produce useful recall.

The core tension: the pipeline is designed to be conservative (don't inject noise), but the safeguards (dedup, gap threshold, substance gate) stack up to make it too conservative. The most relevant recalls are the ones most likely to overlap with current context, and they're the ones that get killed first.