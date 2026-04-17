import { randomUUID } from "node:crypto";
import type { EngramConfig } from "../config.js";

type SubagentRuntime = {
  subagent?: {
    run: (params: {
      sessionKey: string;
      message: string;
      provider?: string;
      model?: string;
      extraSystemPrompt?: string;
      deliver?: boolean;
      lane?: string;
      idempotencyKey?: string;
    }) => Promise<{ runId: string }>;
    waitForRun: (params: { runId: string; timeoutMs?: number }) => Promise<{ status: "ok" | "error" | "timeout"; error?: string }>;
    getSessionMessages: (params: { sessionKey: string; limit?: number }) => Promise<{ messages: unknown[] }>;
    deleteSession: (params: { sessionKey: string; deleteTranscript?: boolean }) => Promise<void>;
  };
  logging?: {
    getChildLogger?: (bindings?: Record<string, unknown>) => {
      warn: (message: string, meta?: Record<string, unknown>) => void;
    };
  };
};

export type SummaryMode = "leaf" | "condensed";

export async function summarizeText(params: {
  text: string;
  mode: SummaryMode;
  targetTokens: number;
  config: EngramConfig;
  runtime?: SubagentRuntime;
  fallback: (text: string, targetTokens: number, mode: SummaryMode) => string;
}): Promise<string> {
  const runtimeSummary = await summarizeWithRuntime(params);
  if (runtimeSummary) {
    return runtimeSummary;
  }
  return params.fallback(params.text, params.targetTokens, params.mode);
}

async function summarizeWithRuntime(params: {
  text: string;
  mode: SummaryMode;
  targetTokens: number;
  config: EngramConfig;
  runtime?: SubagentRuntime;
}): Promise<string | null> {
  if (!params.runtime?.subagent) {
    return null;
  }

  const sessionKey = `engram-summarizer:${randomUUID()}`;
  try {
    const run = await params.runtime.subagent.run({
      sessionKey,
      message: buildPrompt(params.mode, params.text, params.targetTokens),
      provider: params.config.summarizationProvider,
      model: params.config.summarizationModel,
      extraSystemPrompt:
        "You summarize prior context for a memory engine. Return plain text summary content only. Do not include commentary, XML, markdown fences, or explanations.",
      deliver: false,
      lane: "memory",
      idempotencyKey: sessionKey,
    });
    const waited = await params.runtime.subagent.waitForRun({ runId: run.runId, timeoutMs: 60_000 });
    if (waited.status !== "ok") {
      warn(params.runtime, `Engram summarizer runtime call failed: ${waited.error ?? waited.status}`);
      return null;
    }
    const messages = await params.runtime.subagent.getSessionMessages({ sessionKey, limit: 20 });
    for (let index = messages.messages.length - 1; index >= 0; index -= 1) {
      const message = messages.messages[index] as { role?: string; content?: unknown } | undefined;
      if (message?.role !== "assistant") {
        continue;
      }
      const text = normalizeContent(message.content).trim();
      if (text) {
        return text;
      }
    }
    return null;
  } catch (error) {
    warn(params.runtime, `Engram summarizer runtime error: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  } finally {
    try {
      await params.runtime.subagent.deleteSession({ sessionKey, deleteTranscript: true });
    } catch {
      // cleanup best-effort
    }
  }
}

function buildPrompt(mode: SummaryMode, text: string, targetTokens: number): string {
  const instruction =
    mode === "condensed"
      ? "Condense these existing summaries into a higher-level summary while preserving the most important decisions, constraints, and open threads."
      : "Summarize these conversation turns for future context reconstruction, preserving decisions, constraints, goals, and unresolved issues.";
  return [
    instruction,
    `Target length: about ${targetTokens} tokens or less.`,
    "Return plain text only.",
    "",
    text,
  ].join("\n");
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
  return content == null ? "" : String(content);
}

function warn(runtime: SubagentRuntime, message: string): void {
  runtime.logging?.getChildLogger?.({ plugin: "engram", component: "summarizer" }).warn(message);
}