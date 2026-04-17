import { describe, expect, it, vi } from "vitest";
import { resolveEngramConfig } from "../src/config.js";
import { summarizeText } from "../src/engine/summarizer.js";

describe("summarizeText", () => {
  it("uses the runtime subagent when available", async () => {
    const runtime = {
      subagent: {
        run: vi.fn(async () => ({ runId: 'run-1' })),
        waitForRun: vi.fn(async () => ({ status: 'ok' as const })),
        getSessionMessages: vi.fn(async () => ({
          messages: [
            { role: 'assistant', content: 'runtime summary result' },
          ],
        })),
        deleteSession: vi.fn(async () => undefined),
      },
      logging: {
        getChildLogger: vi.fn(() => ({ warn: vi.fn() })),
      },
    };

    const result = await summarizeText({
      text: 'long source text',
      mode: 'leaf',
      targetTokens: 100,
      config: resolveEngramConfig({ dbPath: '/tmp/engram.db', summarizationProvider: 'test-provider', summarizationModel: 'test-model' }),
      runtime,
      fallback: () => 'fallback summary',
    });

    expect(result).toBe('runtime summary result');
  });

  it("falls back when runtime is unavailable", async () => {
    const result = await summarizeText({
      text: 'long source text',
      mode: 'leaf',
      targetTokens: 100,
      config: resolveEngramConfig({ dbPath: '/tmp/engram.db' }),
      fallback: () => 'fallback summary',
    });

    expect(result).toBe('fallback summary');
  });
});