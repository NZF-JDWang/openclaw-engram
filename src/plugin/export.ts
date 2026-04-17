import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { EngramConfig } from "../config.js";
import { listFacts } from "./facts.js";
import { readPersona } from "./persona.js";

export function exportMemories(config: EngramConfig, outputPath?: string): { path: string; content: string } {
  const targetPath = outputPath?.trim() || config.exportPath;
  const persona = readPersona(config);
  const facts = listFacts(config);
  const content = [
    "# Engram Export",
    "",
    `Generated: ${new Date().toISOString()}`,
    "",
    "## Persona",
    "",
    persona || "_No persona set._",
    "",
    "## Facts",
    "",
    ...renderFacts(facts),
    "",
  ].join("\n");

  mkdirSync(dirname(targetPath), { recursive: true });
  writeFileSync(targetPath, content, "utf8");
  return { path: targetPath, content };
}

function renderFacts(
  facts: Array<{
    factId: string;
    content: string;
    memoryClass: string;
    sourceKind: string;
    sourceBasis: string;
    scope: string;
    lifecycleState: string;
    approvalState: string;
    deprecatedAt?: string | null;
    deprecatedReason?: string | null;
    expiresAt?: string | null;
    createdAt: string;
  }>,
): string[] {
  if (facts.length === 0) {
    return ["_No facts stored._"];
  }
  return facts.map(
    (fact) =>
      [
        `- ${fact.factId} | ${fact.memoryClass} | ${fact.sourceKind} | ${fact.sourceBasis} | ${fact.scope} | ${fact.lifecycleState} | ${fact.approvalState} | ${fact.createdAt}`,
        fact.expiresAt ? `  expires_at: ${fact.expiresAt}` : "",
        fact.deprecatedAt ? `  deprecated_at: ${fact.deprecatedAt}` : "",
        fact.deprecatedReason ? `  deprecated_reason: ${fact.deprecatedReason}` : "",
        `  ${fact.content}`,
      ].filter(Boolean).join("\n"),
  );
}