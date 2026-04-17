import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { EngramConfig } from "../config.js";
import { estimateTokens } from "../token-estimate.js";
import { searchKnowledgeBase } from "../kb/store.js";
import { searchApprovedFacts } from "./facts.js";
import { formatPersonaBlock, readPersona } from "./persona.js";

type RecallFact = {
  kind: "fact";
  factId: string;
  memoryClass: string;
  sourceKind: string;
  score: number;
  content: string;
  createdAt?: string;
};

type RecallMemory = {
  kind: "memory";
  chunkId: string;
  collectionId: string;
  title: string;
  score: number;
  snippet: string;
  indexedAt?: string;
};

export type RecallCandidate =
  | (RecallFact & { normalizedScore: number; target: "prepend" | "append" })
  | (RecallMemory & { normalizedScore: number; target: "append" });

type StoredPrependEntry = {
  factId: string;
  memoryClass: string;
  sourceKind: string;
  score: number;
  content: string;
  createdAt?: string;
  insertedAt: number;
};

export function createBeforePromptBuildHook(config: EngramConfig) {
  const prependState = new Map<string, StoredPrependEntry[]>();

  return async function handleBeforePromptBuild(event: { prompt?: string; messages?: unknown[]; sessionId?: string; conversationId?: string }) {
    const personaBlock = formatPersonaBlock(readPersona(config));
    const sessionKey = resolveRecallSessionKey(event);

    let prependRecallBlock = renderStoredPrependBlock(prependState.get(sessionKey) ?? [], event.prompt ?? "");
    let appendSystemContext: string | undefined;

    if (config.recallEnabled && config.kbEnabled) {
      const query = extractLatestUserQuery(event);
      if (estimateSubstance(query) !== 0) {
        const factHits: RecallFact[] = searchApprovedFacts(config, query, config.recallMaxResults)
          .filter((fact) => !isDuplicateAgainstRecentContext(fact.content, event.messages ?? []))
          .map((fact) => ({
            kind: "fact",
            factId: fact.factId,
            memoryClass: fact.memoryClass,
            sourceKind: fact.sourceKind,
            score: fact.score,
            content: fact.content,
            createdAt: fact.createdAt,
          }));

        const hits: RecallMemory[] = (await searchKnowledgeBase(config, query, { limit: config.recallMaxResults }))
          .filter((hit) => hit.score > 0)
          .map((hit) => ({
            kind: "memory" as const,
            chunkId: hit.chunkId,
            collectionId: hit.collectionName,
            title: hit.title,
            score: hit.score,
            snippet: hit.content,
            indexedAt: hit.indexedAt,
          }))
          .filter((hit) => !isDuplicateAgainstRecentContext(hit.snippet, event.messages ?? []));

        const ranked = rankRecallCandidates(factHits, hits, config);
        if (shouldInjectRecall(ranked, config)) {
          const prependFacts = ranked.filter(
            (candidate): candidate is Extract<RecallCandidate, { kind: "fact" }> =>
              candidate.kind === "fact" && candidate.target === "prepend",
          );
          const appendFacts = ranked.filter(
            (candidate): candidate is Extract<RecallCandidate, { kind: "fact" }> =>
              candidate.kind === "fact" && candidate.target === "append",
          );
          const appendHits = ranked.filter(
            (candidate): candidate is Extract<RecallCandidate, { kind: "memory" }> => candidate.kind === "memory",
          );

          if (prependFacts.length > 0) {
            const nextEntries = mergePrependEntries(
              prependState.get(sessionKey) ?? [],
              prependFacts.map(toFactBlockItem),
              config.recallPrependMaxTokens,
            );
            prependState.set(sessionKey, nextEntries);
            prependRecallBlock = renderStoredPrependBlock(nextEntries, query);
          }

          if (appendFacts.length > 0 || appendHits.length > 0) {
            appendSystemContext = formatRecallBlock(
              query,
              appendHits.map(toMemoryBlockItem),
              config.recallMaxTokens,
              appendFacts.map(toFactBlockItem),
            );
          }
        }
      }
    }

    const prependSystemContext = [personaBlock, prependRecallBlock].filter(Boolean).join("\n");
    if (config.recallShadowMode && (prependSystemContext || appendSystemContext)) {
      logShadowRecall(config, {
        query: extractLatestUserQuery(event),
        prependSystemContext,
        appendSystemContext,
      });
      return prependSystemContext ? { prependSystemContext: personaBlock || undefined } : undefined;
    }

    if (!prependSystemContext && !appendSystemContext) {
      return undefined;
    }

    return {
      prependSystemContext: prependSystemContext || undefined,
      appendSystemContext,
    };
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
  hits: Array<{ chunkId: string; collectionId: string; title: string; score: number; snippet: string; indexedAt?: string }>,
  maxTokens: number = 300,
  facts: Array<{ factId: string; memoryClass: string; sourceKind: string; score: number; content: string; createdAt?: string }> = [],
): string {
  let remainingTokens = maxTokens;
  const renderedFacts: string[] = [];
  for (const fact of facts) {
    if (remainingTokens <= 0) {
      break;
    }
    const content = truncateToTokens(fact.content, remainingTokens);
    const contentTokens = estimateTokens(content);
    if (contentTokens <= 0) {
      continue;
    }
    renderedFacts.push([
      `  <fact fact_id="${escapeXml(fact.factId)}" memory_class="${escapeXml(fact.memoryClass)}" source_kind="${escapeXml(fact.sourceKind)}" score="${fact.score.toFixed(3)}"${fact.createdAt ? ` date="${escapeXml(fact.createdAt)}"` : ""}>`,
      `    <content>${escapeXml(content)}</content>`,
      `  </fact>`,
    ].join("\n"));
    remainingTokens -= contentTokens;
  }

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
    renderedHits.push([
      `  <memory chunk_id="${escapeXml(hit.chunkId)}" collection_id="${escapeXml(hit.collectionId)}" source_kind="document_derived" score="${hit.score.toFixed(3)}"${hit.indexedAt ? ` date="${escapeXml(hit.indexedAt)}"` : ""}>`,
      `    <title>${escapeXml(hit.title)}</title>`,
      `    <snippet>${escapeXml(snippet)}</snippet>`,
      `  </memory>`,
    ].join("\n"));
    remainingTokens -= snippetTokens;
  }

  return [
    `<engram_recall query="${escapeXml(query)}">`,
    ...renderedFacts,
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
  facts: RecallFact[],
  hits: RecallMemory[],
  config: Pick<EngramConfig, "recallMaxResults">,
): RecallCandidate[] {
  const rawCandidates: Array<RecallFact | RecallMemory> = [...facts, ...hits];
  const maxScore = rawCandidates.reduce((currentMax, candidate) => Math.max(currentMax, candidate.score), 0);
  if (maxScore <= 0) {
    return [];
  }

  return rawCandidates
    .map((candidate) => {
      const normalizedScore = Math.max(0, Math.min(1, candidate.score / maxScore));
      if (candidate.kind === "fact") {
        return {
          ...candidate,
          normalizedScore,
          target: candidate.memoryClass === "project" ? "prepend" : "append",
        } satisfies RecallCandidate;
      }
      return {
        ...candidate,
        normalizedScore,
        target: "append",
      } satisfies RecallCandidate;
    })
    .sort((left, right) => right.normalizedScore - left.normalizedScore || right.score - left.score)
    .slice(0, config.recallMaxResults);
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

function toFactBlockItem(fact: RecallFact | Extract<RecallCandidate, { kind: "fact" }>) {
  return {
    factId: fact.factId,
    memoryClass: fact.memoryClass,
    sourceKind: fact.sourceKind,
    score: "normalizedScore" in fact ? fact.normalizedScore : fact.score,
    content: fact.content,
    createdAt: fact.createdAt,
  };
}

function toMemoryBlockItem(hit: RecallMemory | Extract<RecallCandidate, { kind: "memory" }>) {
  return {
    chunkId: hit.chunkId,
    collectionId: hit.collectionId,
    title: hit.title,
    score: "normalizedScore" in hit ? hit.normalizedScore : hit.score,
    snippet: hit.snippet,
    indexedAt: hit.indexedAt,
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

function mergePrependEntries(
  existing: StoredPrependEntry[],
  incoming: Array<{ factId: string; memoryClass: string; sourceKind: string; score: number; content: string; createdAt?: string }>,
  maxTokens: number,
): StoredPrependEntry[] {
  const merged = [...existing];
  for (const fact of incoming) {
    const match = merged.find((entry) => entry.factId === fact.factId);
    if (match) {
      match.score = fact.score;
      match.content = fact.content;
      match.createdAt = fact.createdAt;
      match.memoryClass = fact.memoryClass;
      match.sourceKind = fact.sourceKind;
      continue;
    }
    merged.push({ ...fact, insertedAt: Date.now() });
  }

  let totalTokens = merged.reduce((sum, entry) => sum + estimateTokens(entry.content), 0);
  while (merged.length > 0 && totalTokens > maxTokens) {
    const oldestIndex = merged.reduce((bestIndex, entry, index, array) =>
      entry.insertedAt < array[bestIndex]!.insertedAt ? index : bestIndex, 0);
    totalTokens -= estimateTokens(merged[oldestIndex]!.content);
    merged.splice(oldestIndex, 1);
  }

  return merged;
}

function renderStoredPrependBlock(entries: StoredPrependEntry[], query: string): string | undefined {
  if (entries.length === 0) {
    return undefined;
  }
  return formatRecallBlock(query.trim() || "project_recall", [], Number.MAX_SAFE_INTEGER, entries);
}