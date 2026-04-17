import { describe, expect, it } from "vitest";
import { estimateTokens } from "../src/token-estimate.js";

describe("estimateTokens", () => {
  it("stays within a 10% margin for representative prose, code, CJK, and tool JSON samples", () => {
    const samples = [
      {
        label: "prose",
        text: "Engram stores durable facts and session summaries for later recall.",
        expected: 15,
      },
      {
        label: "code",
        text: "function estimateTokens(text) {\n  return Math.ceil(text.length / 3.7);\n}\n",
        expected: 23,
      },
      {
        label: "cjk",
        text: "用户偏好简洁回答并保留迁移细节。",
        expected: 17,
      },
      {
        label: "tool-json",
        text: '{"tool":"engram_search","input":{"query":"qmd migration status","maxResults":3}}',
        expected: 26,
      },
    ];

    for (const sample of samples) {
      const estimated = estimateTokens(sample.text);
      const delta = Math.abs(estimated - sample.expected) / sample.expected;
      expect(
        delta,
        `${sample.label} expected about ${sample.expected} tokens but got ${estimated}`,
      ).toBeLessThanOrEqual(0.1);
    }
  });

  it("returns zero for empty input", () => {
    expect(estimateTokens("")).toBe(0);
  });
});
