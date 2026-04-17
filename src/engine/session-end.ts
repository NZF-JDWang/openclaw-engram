import type { DatabaseSync } from "node:sqlite";

export function updateSessionEndArtifact(
  db: DatabaseSync,
  params: {
    conversationId: string;
    messages: Array<{ role?: string; content?: unknown }>;
  },
): void {
  const goal = extractGoal(params.messages);
  const reentryContext = summarizeRecentMessages(params.messages);
  const decisions = extractDecisions(params.messages);
  const openQuestions = extractOpenQuestions(params.messages, goal);

  db.prepare(`
    INSERT INTO session_end_artifacts (artifact_id, conversation_id, goal, decisions, open_questions, reentry_context, created_at)
    VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(artifact_id) DO UPDATE SET
      goal = excluded.goal,
      decisions = excluded.decisions,
      open_questions = excluded.open_questions,
      reentry_context = excluded.reentry_context,
      created_at = excluded.created_at
  `).run(`artifact:${params.conversationId}`, params.conversationId, goal, decisions, openQuestions, reentryContext);
}

export function readPreviousSessionArtifact(
  db: DatabaseSync,
  conversationId: string,
): { goal: string | null; decisions: string | null; open_questions: string | null; reentry_context: string | null } | null {
  const row = db.prepare(`
    SELECT goal, decisions, open_questions, reentry_context
    FROM session_end_artifacts
    WHERE conversation_id != ?
    ORDER BY created_at DESC
    LIMIT 1
  `).get(conversationId) as
    | { goal: string | null; decisions: string | null; open_questions: string | null; reentry_context: string | null }
    | undefined;
  return row ?? null;
}

export function formatPriorSessionBlock(artifact: {
  goal: string | null;
  decisions: string | null;
  open_questions: string | null;
  reentry_context: string | null;
}): string {
  return [
    `<prior_session>`,
    artifact.goal ? `  <goal>${escapeXml(artifact.goal)}</goal>` : "",
    artifact.decisions ? `  <decisions>${escapeXml(artifact.decisions)}</decisions>` : "",
    artifact.open_questions ? `  <open_questions>${escapeXml(artifact.open_questions)}</open_questions>` : "",
    artifact.reentry_context ? `  <reentry_context>${escapeXml(artifact.reentry_context)}</reentry_context>` : "",
    `</prior_session>`,
  ].filter(Boolean).join("\n");
}

function extractLastText(messages: Array<{ role?: string; content?: unknown }>, role: string): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== role) {
      continue;
    }
    const text = normalizeContent(message.content);
    if (text) {
      return text.slice(0, 500);
    }
  }
  return "";
}

function summarizeRecentMessages(messages: Array<{ role?: string; content?: unknown }>): string {
  return messages
    .slice(-6)
    .map((message) => `${message.role ?? "unknown"}: ${normalizeContent(message.content).slice(0, 140)}`)
    .join(" | ");
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

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function extractGoal(messages: Array<{ role?: string; content?: unknown }>): string {
  return extractLastSentence(extractLastText(messages, "user")) || extractLastText(messages, "user");
}

function extractDecisions(messages: Array<{ role?: string; content?: unknown }>): string {
  const decisionSentences = collectRecentSentences(messages, "assistant").filter((sentence) =>
    /\b(decided|choose|chose|use|using|wired|completed|added|switched|configured|validated|implemented|fixed|synced|indexed|preserve|record)\b/i.test(sentence),
  );
  if (decisionSentences.length > 0) {
    return decisionSentences.slice(-2).join(" ").slice(0, 500);
  }
  return extractLastText(messages, "assistant");
}

function extractOpenQuestions(messages: Array<{ role?: string; content?: unknown }>, goal: string): string {
  const userQuestions = collectRecentSentences(messages, "user").filter((sentence) => sentence.includes("?"));
  if (userQuestions.length > 0) {
    return userQuestions.slice(-2).join(" ").slice(0, 500);
  }
  if (goal) {
    return `Resume from: ${goal}`;
  }
  return "";
}

function collectRecentSentences(
  messages: Array<{ role?: string; content?: unknown }>,
  role: string,
): string[] {
  return messages
    .filter((message) => message.role === role)
    .flatMap((message) => splitSentences(normalizeContent(message.content)))
    .filter(Boolean);
}

function extractLastSentence(value: string): string {
  const sentences = splitSentences(value);
  return sentences[sentences.length - 1] ?? "";
}

function splitSentences(value: string): string[] {
  return value
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}