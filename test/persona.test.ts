import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveEngramConfig } from "../src/config.js";
import { openDatabase } from "../src/db/connection.js";
import { rememberFact } from "../src/plugin/facts.js";
import { createEngramReviewTool } from "../src/plugin/tools.js";
import { createBeforePromptBuildHook } from "../src/plugin/recall.js";
import { appendUserFact, formatPersonaBlock, mergePendingFacts, readPersona, writePersona } from "../src/plugin/persona.js";

const tempPaths: string[] = [];

afterEach(() => {
  while (tempPaths.length > 0) {
    const current = tempPaths.pop();
    if (current) {
      rmSync(current, { recursive: true, force: true });
    }
  }
});

describe("persona support", () => {
  it("writes and reads the persona file", () => {
    const root = mkdtempSync(join(tmpdir(), "engram-persona-"));
    tempPaths.push(root);
    const config = resolveEngramConfig({
      dbPath: join(root, "engram.db"),
      personaPath: join(root, "persona.md"),
    });

    writePersona(config, "User prefers concise, factual answers.");

    expect(readPersona(config)).toBe("User prefers concise, factual answers.");
    expect(formatPersonaBlock(readPersona(config))).toContain("<engram_persona");
  });

  it("injects persona as prependSystemContext even without recall hits", async () => {
    const root = mkdtempSync(join(tmpdir(), "engram-persona-hook-"));
    tempPaths.push(root);
    const config = resolveEngramConfig({
      dbPath: join(root, "engram.db"),
      personaPath: join(root, "persona.md"),
    });
    writePersona(config, "User prefers concise, factual answers.");

    const hook = createBeforePromptBuildHook(config);
    const result = await hook({
      prompt: "keep going",
      messages: [{ role: "user", content: "keep going" }],
    });

    expect(result?.prependSystemContext).toContain("User prefers concise, factual answers.");
    expect(result?.appendSystemContext).toBeUndefined();
  });

  it("appends explicit user facts into the user persona section", () => {
    const root = mkdtempSync(join(tmpdir(), "engram-persona-user-section-"));
    tempPaths.push(root);
    const config = resolveEngramConfig({
      dbPath: join(root, "engram.db"),
      personaPath: join(root, "persona.md"),
    });

    appendUserFact(config, "User prefers concise, factual answers.");
    appendUserFact(config, "User prefers concise, factual answers.");

    const persona = readPersona(config);
    expect(persona).toContain("<!-- USER -->");
    expect(persona.match(/User prefers concise, factual answers\./g)?.length).toBe(1);
  });

  it("merges only approved identity facts into the agent-suggested persona section", () => {
    const root = mkdtempSync(join(tmpdir(), "engram-persona-merge-"));
    tempPaths.push(root);
    const dbPath = join(root, "engram.db");
    const database = openDatabase(dbPath);
    database.close();
    const config = resolveEngramConfig({ dbPath, personaPath: join(root, "persona.md") });

    const approved = rememberFact(config, {
      content: "User prefers factual answers.",
      memoryClass: "identity",
      sourceKind: "agent_inferred",
    });
    const project = rememberFact(config, {
      content: "Use sqlite for the Engram store.",
      memoryClass: "project",
      sourceKind: "decision",
    });

    const db = openDatabase(dbPath);
    try {
      db.db.prepare("UPDATE kb_facts SET approval_state = 'approved', lifecycle_state = 'durable' WHERE fact_id = ?").run(approved.factId);
    } finally {
      db.close();
    }

    const persona = mergePendingFacts(config, [approved.factId, project.factId]);

    expect(persona).toContain("<!-- AGENT-SUGGESTED -->");
    expect(persona).toContain(approved.factId);
    expect(persona).not.toContain(project.factId);
  });

  it("merges approved identity facts into persona when reviewed through the tool", async () => {
    const root = mkdtempSync(join(tmpdir(), "engram-persona-review-tool-"));
    tempPaths.push(root);
    const dbPath = join(root, "engram.db");
    const database = openDatabase(dbPath);
    database.close();
    const config = resolveEngramConfig({ dbPath, personaPath: join(root, "persona.md") });
    const fact = rememberFact(config, {
      content: "User prefers terse updates.",
      memoryClass: "identity",
      sourceKind: "agent_inferred",
    });

    const tool = createEngramReviewTool(config);
    await tool.execute("call-1", { action: "approve", factId: fact.factId });

    expect(readPersona(config)).toContain(fact.factId);
    expect(readPersona(config)).toContain("User prefers terse updates.");
  });
});