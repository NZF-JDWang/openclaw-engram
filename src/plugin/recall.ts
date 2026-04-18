import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { EngramConfig } from "../config.js";
import { openDatabase } from "../db/connection.js";
import { estimateTokens } from "../token-estimate.js";
import { SESSION_COLLECTION_NAME } from "../kb/indexer.js";
import { lookupSessionMetadata, searchKnowledgeBase } from "../kb/store.js";

type RecallMemory = {
  kind: "memory";
  chunkId: string;
  docId: string;
  collectionId: string;
  relPath: string;
  title: string;
  score: number;
  snippet: string;
  indexedAt?: string;
  sessionKey?: string;
  sessionCreatedAt?: string;
};

export type RecallCandidate = RecallMemory & { normalizedScore: number };

export function createBeforePromptBuildHook(config: EngramConfig) {
  return async function handleBeforePromptBuild(event: { prompt?: string; messages?: unknown[]; sessionId?: string; conversationId?: string }) {
    try {
      if (!(config.recallEnabled && config.kbEnabled)) {
        return undefined;
      }
      const query = extractLatestUserQuery(event);
      if (estimateSubstance(query) === 0) {
        return undefined;
      }

      // Main search (all collections)
      const mainHits: RecallMemory[] = (await searchKnowledgeBase(config, query, { limit: config.recallMaxResults * 4 }))
        .filter((hit) => hit.score > 0)
        .map((hit) => ({
          kind: "memory" as const,
          chunkId: hit.chunkId,
          docId: hit.docId,
          collectionId: hit.collectionName,
          relPath: hit.relPath,
          title: hit.title,
          score: hit.score,
          snippet: hit.content,
          indexedAt: hit.indexedAt,
        }))
        .filter((hit) => !isDuplicateAgainstRecentContext(hit.snippet, event.messages ?? []));

      // Session-only search (separate lane to avoid 0.7 weight penalty)
      let sessionLaneHits: RecallMemory[] = [];
      if (config.recallSessionMaxResults > 0) {
        sessionLaneHits = (await searchKnowledgeBase(config, query, {
          limit: config.recallSessionMaxResults * 4,
          collection: SESSION_COLLECTION_NAME,
        }))
          .filter((hit) => hit.score > 0)
          .map((hit) => ({
            kind: "memory" as const,
            chunkId: hit.chunkId,
            docId: hit.docId,
            collectionId: hit.collectionName,
            relPath: hit.relPath,
            title: hit.title,
            score: hit.score,
            snippet: hit.content,
            indexedAt: hit.indexedAt,
          }))
          .filter((hit) => !isDuplicateAgainstRecentContext(hit.snippet, event.messages ?? []));
      }

      // Merge by chunkId — session lane score takes priority for __sessions chunks
      const mergedMap = new Map<string, RecallMemory>();
      for (const hit of mainHits) {
        mergedMap.set(hit.chunkId, hit);
      }
      for (const hit of sessionLaneHits) {
        const existing = mergedMap.get(hit.chunkId);
        if (!existing || hit.score > existing.score) {
          mergedMap.set(hit.chunkId, hit);
        }
      }
      const allHits = [...mergedMap.values()];

      // Enrich session hits with conversation metadata
      if (config.recallSessionMaxResults > 0) {
        const sessionHitsList = allHits.filter((h) => h.collectionId === SESSION_COLLECTION_NAME);
        const conversationIds = [...new Set(
          sessionHitsList.map((h) => h.relPath.split("/")[0]).filter(Boolean),
        )] as string[];
        if (conversationIds.length > 0) {
          const metaMap = lookupSessionMetadata(config, conversationIds);
          for (const hit of sessionHitsList) {
            const convId = hit.relPath.split("/")[0];
            const meta = convId ? metaMap.get(convId) : undefined;
            if (meta) {
              hit.sessionKey = meta.sessionKey;
              hit.sessionCreatedAt = meta.createdAt;
            }
          }
        }
      }

      // Rank with a wider pool, then apply session budget
      const ranked = rankRecallCandidates(allHits, config, config.recallMaxResults * 2);
      const budgeted = applySessionLane(ranked, config);
      const diversified = diversifyBySource(budgeted, config.recallMaxResults);

      if (!shouldInjectRecall(diversified, config)) {
        return undefined;
      }

      const appendSystemContext = formatRecallBlock(
        query,
        diversified.map(toMemoryBlockItem),
        config.recallMaxTokens,
      );
      if (!appendSystemContext) {
        return undefined;
      }

      if (config.recallShadowMode) {
        logShadowRecall(config, { query, prependSystemContext: undefined, appendSystemContext });
        return undefined;
      }

      if (config.recallFeedbackEnabled) {
        const conversationId = resolveRecallSessionKey(event);
        logRecallEvents(config, conversationId, diversified);
      }

      return { appendSystemContext };
    } catch (error) {
      console.warn(`[engram] before_prompt_build failed: ${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    }
  };
}

export function extractLatestUserQuery(event: { prompt?: string; messages?: unknown[] }): string {
  if (Array.isArray(event.messages)) {
    for (let index = event.messages.length - 1; index >= 0; index -= 1) {
      const message = event.messages[index] as { role?: string; content?: unknown } | undefined;
      if (message?.role !== "user") {
        continue;
      }
      const text = stripMetadata(normalizeContent(message.content));
      if (text.trim()) {
        return augmentFollowUpQuery(text.trim(), event.messages, index);
      }
    }
  }

  const fallback = typeof event.prompt === "string" ? stripMetadata(event.prompt).trim() : "";
  return augmentFollowUpQuery(fallback, event.messages ?? [], -1);
}

export function formatRecallBlock(
  query: string,
  hits: Array<{ chunkId: string; collectionId: string; title: string; score: number; snippet: string; indexedAt?: string; sessionKey?: string; sessionCreatedAt?: string }>,
  maxTokens: number = 300,
): string {
  let remainingTokens = maxTokens;
  const renderedHits: string[] = [];
  for (const hit of hits) {
    if (remainingTokens <= 0) {
      break;
    }
    const snippet = truncateToTokens(hit.snippet, remainingTokens);
    const snippetTokens = estimateTokens(snippet);
    if (snippetTokens <= 0) {
      continue;
    }
    const isSession = hit.collectionId === SESSION_COLLECTION_NAME;
    const sourceKind = isSession ? "session_summary" : "document_derived";
    const sessionKeyAttr = hit.sessionKey ? ` session_key="${escapeXml(hit.sessionKey)}"` : "";
    const sessionDateAttr = hit.sessionCreatedAt ? ` session_date="${escapeXml(hit.sessionCreatedAt)}"` : "";
    renderedHits.push([
      `  <memory chunk_id="${escapeXml(hit.chunkId)}" collection_id="${escapeXml(hit.collectionId)}" source_kind="${sourceKind}" score="${hit.score.toFixed(3)}"${hit.indexedAt ? ` date="${escapeXml(hit.indexedAt)}"` : ""}${sessionKeyAttr}${sessionDateAttr}>`,
      `    <title>${escapeXml(hit.title)}</title>`,
      `    <snippet>${escapeXml(snippet)}</snippet>`,
      `  </memory>`,
    ].join("\n"));
    remainingTokens -= snippetTokens;
  }

  return [
    `<engram_recall query="${escapeXml(query)}">`,
    ...renderedHits,
    `</engram_recall>`,
  ].join("\n");
}

export function estimateSubstance(query: string): 0 | 0.5 | 1 {
  const normalized = query.trim().toLowerCase();
  if (!normalized || normalized.length < 12) {
    return 0;
  }
  if (/^(hi|hello|thanks|thank you|ok|okay|continue|carry on|keep going)[!. ]*$/i.test(normalized)) {
    return 0;
  }
  if (normalized.split(/\s+/).length < 4) {
    return 0.5;
  }
  return 1;
}

export function rankRecallCandidates(
  hits: RecallMemory[],
  config: Pick<EngramConfig, "recallMaxResults">,
  limitOverride?: number,
): RecallCandidate[] {
  const maxScore = hits.reduce((currentMax, hit) => Math.max(currentMax, hit.score), 0);
  if (maxScore <= 0) {
    return [];
  }

  const limit = limitOverride ?? config.recallMaxResults;
  return hits
    .map((hit) => ({
      ...hit,
      normalizedScore: Math.max(0, Math.min(1, hit.score / maxScore)),
    }))
    .sort((left, right) => right.normalizedScore - left.normalizedScore || right.score - left.score)
    .slice(0, limit);
}

function applySessionLane(
  ranked: RecallCandidate[],
  config: Pick<EngramConfig, "recallMaxResults" | "recallSessionMaxResults" | "recallSessionMinScore">,
): RecallCandidate[] {
  const sessionHits = ranked
    .filter((h) => h.collectionId === SESSION_COLLECTION_NAME && h.normalizedScore >= config.recallSessionMinScore)
    .slice(0, config.recallSessionMaxResults);
  const mainHits = ranked.filter((h) => h.collectionId !== SESSION_COLLECTION_NAME);
  const slotsForMain = Math.max(0, config.recallMaxResults - sessionHits.length);
  return [...sessionHits, ...mainHits.slice(0, slotsForMain)]
    .sort((a, b) => b.normalizedScore - a.normalizedScore || b.score - a.score);
}

function diversifyBySource(candidates: RecallCandidate[], maxResults: number): RecallCandidate[] {
  const seenDocIds = new Set<string>();
  const diverse: RecallCandidate[] = [];
  const overflow: RecallCandidate[] = [];

  for (const candidate of candidates) {
    if (!seenDocIds.has(candidate.docId)) {
      seenDocIds.add(candidate.docId);
      diverse.push(candidate);
    } else {
      overflow.push(candidate);
    }
  }

  // Relax deduplication if not enough unique sources
  for (const candidate of overflow) {
    if (diverse.length >= maxResults) break;
    diverse.push(candidate);
  }

  return diverse.slice(0, maxResults);
}

function logRecallEvents(config: EngramConfig, conversationId: string, candidates: RecallCandidate[]): void {
  try {
    const database = openDatabase(config.dbPath);
    try {
      const insert = database.db.prepare(
        `INSERT OR IGNORE INTO recall_events (event_id, conversation_id, chunk_id, injected_score, created_at)
         VALUES (?, ?, ?, ?, datetime('now'))`,
      );
      for (const candidate of candidates) {
        insert.run(
          `re:${candidate.chunkId}:${Date.now()}`,
          conversationId,
          candidate.chunkId,
          candidate.normalizedScore,
        );
      }
    } finally {
      database.close();
    }
  } catch (error) {
    console.warn(`[engram] Failed to log recall events: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function shouldInjectRecall(
  candidates: Array<Pick<RecallCandidate, "normalizedScore">>,
  config: Pick<EngramConfig, "recallMinScore" | "recallGapThreshold" | "recallHighConfidenceScore">,
): boolean {
  if (candidates.length === 0) {
    return false;
  }
  const topScore = candidates[0]?.normalizedScore ?? 0;
  if (topScore < config.recallMinScore) {
    return false;
  }
  if (topScore >= config.recallHighConfidenceScore || candidates.length === 1) {
    return true;
  }
  const secondScore = candidates[1]?.normalizedScore ?? 0;
  return topScore - secondScore >= config.recallGapThreshold;
}

export function isDuplicateAgainstRecentContext(snippet: string, messages: unknown[]): boolean {
  const recentSentences = messages
    .slice(-6)
    .filter((message) => (message as { role?: string } | undefined)?.role !== "user")
    .flatMap((message) => splitSentences(normalizeContent((message as { content?: unknown } | undefined)?.content))
      .map((sentence) => tokenizeSentence(sentence))
      .filter((tokens) => tokens.length > 0));
  if (recentSentences.length === 0) {
    return false;
  }
  const snippetSentences = splitSentences(snippet)
    .map((sentence) => tokenizeSentence(sentence))
    .filter((tokens) => tokens.length > 0);
  if (snippetSentences.length === 0) {
    return false;
  }
  return snippetSentences.every((snippetSentence) =>
    recentSentences.some((recentSentence) => sentenceOverlap(snippetSentence, recentSentence) >= 0.6),
  );
}

function augmentFollowUpQuery(query: string, messages: unknown[], userMessageIndex: number): string {
  const normalized = query.trim();
  if (!normalized) {
    return "";
  }
  if (!shouldAugmentFollowUp(normalized)) {
    return normalized;
  }
  const assistantContext = extractPriorAssistantText(messages, userMessageIndex);
  return assistantContext ? `${normalized}\n\nContext: ${assistantContext}` : normalized;
}

function shouldAugmentFollowUp(query: string): boolean {
  return query.length < 20 || /\b(based on|the above|that error|how do i fix|explain that|what did you mean|why is that)\b/i.test(query);
}

function extractPriorAssistantText(messages: unknown[], userMessageIndex: number): string {
  if (!Array.isArray(messages)) {
    return "";
  }
  const start = userMessageIndex >= 0 ? userMessageIndex - 1 : messages.length - 1;
  for (let index = start; index >= 0; index -= 1) {
    const message = messages[index] as { role?: string; content?: unknown } | undefined;
    if (message?.role !== "assistant") {
      continue;
    }
    const text = normalizeContent(message.content)
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    return text.length <= 400 ? text : text.slice(0, 400).trimEnd();
  }
  return "";
}

function normalizeContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === "string") {
          return item;
        }
        if (item && typeof item === "object" && "text" in item && typeof item.text === "string") {
          return item.text;
        }
        return "";
      })
      .join("\n")
      .trim();
  }
  if (content == null) {
    return "";
  }
  return String(content);
}

function stripMetadata(value: string): string {
  return value
    .replace(/^##\s+(Ambient Context|Heartbeat State|Compact Context|Inbound Context|Group Chat Context).*$/gim, "")
    .replace(/^Conversation info \(untrusted metadata\).*$/gim, "")
    .replace(/^System:\s*\[.*$/gim, "")
    .replace(/^\[media attached:.*$/gim, "")
    .trim();
}

function truncateToTokens(value: string, maxTokens: number): string {
  const maxChars = Math.max(maxTokens * 4, 0);
  const collapsed = value.replace(/\s+/g, " ").trim();
  if (collapsed.length <= maxChars) {
    return collapsed;
  }
  return `${collapsed.slice(0, Math.max(maxChars - 3, 0)).trimEnd()}...`;
}

function toMemoryBlockItem(hit: RecallMemory | RecallCandidate) {
  return {
    chunkId: hit.chunkId,
    collectionId: hit.collectionId,
    title: hit.title,
    score: "normalizedScore" in hit ? hit.normalizedScore : hit.score,
    snippet: hit.snippet,
    indexedAt: hit.indexedAt,
    sessionKey: hit.sessionKey,
    sessionCreatedAt: hit.sessionCreatedAt,
  };
}

function logShadowRecall(
  config: Pick<EngramConfig, "recallShadowLogFile">,
  payload: { query: string; prependSystemContext?: string; appendSystemContext?: string },
): void {
  if (!config.recallShadowLogFile) {
    return;
  }
  mkdirSync(dirname(config.recallShadowLogFile), { recursive: true });
  appendFileSync(
    config.recallShadowLogFile,
    [
      `timestamp: ${new Date().toISOString()}`,
      `query: ${payload.query}`,
      payload.prependSystemContext ? `prepend: ${payload.prependSystemContext}` : "prepend:",
      payload.appendSystemContext ? `append: ${payload.appendSystemContext}` : "append:",
      "---",
    ].join("\n") + "\n",
    "utf8",
  );
}

function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9_-]+/i)
    .map((token) => token.trim())
    .filter((token) => token.length >= 4);
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function splitSentences(value: string): string[] {
  return value
    .split(/(?<=[.!?])\s+|\n+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

function tokenizeSentence(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9_\-]+/i)
    .map((part) => part.trim())
    .filter((part) => part.length >= 2);
}

function sentenceOverlap(left: string[], right: string[]): number {
  if (left.length === 0 || right.length === 0) {
    return 0;
  }
  let overlapping = 0;
  for (const token of left) {
    if (right.includes(token)) {
      overlapping += 1;
    }
  }
  return overlapping / left.length;
}

function resolveRecallSessionKey(event: { sessionId?: string; conversationId?: string }): string {
  return event.sessionId?.trim() || event.conversationId?.trim() || "__default";
}