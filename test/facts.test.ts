import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveEngramConfig } from "../src/config.js";
import { openDatabase } from "../src/db/connection.js";
import { exportMemories } from "../src/plugin/export.js";
import {
  approveFact,
  forgetFact,
  formatPendingFacts,
  listFacts,
  listOpenConflicts,
  listPendingFacts,
  rejectFact,
  rememberFact,
  searchApprovedFacts,
} from "../src/plugin/facts.js";

const tempPaths: string[] = [];

afterEach(() => {
  while (tempPaths.length > 0) {
    const current = tempPaths.pop();
    if (current) {
      rmSync(current, { recursive: true, force: true });
    }
  }
});

describe("rememberFact", () => {
  it("stores identity facts as pending", () => {
    const root = mkdtempSync(join(tmpdir(), "engram-facts-"));
    tempPaths.push(root);
    const dbPath = join(root, "engram.db");
    const database = openDatabase(dbPath);
    database.close();
    const config = resolveEngramConfig({ dbPath });

    const fact = rememberFact(config, {
      content: "User prefers concise answers.",
      memoryClass: "identity",
    });

    expect(fact.approvalState).toBe("pending");
    expect(fact.lifecycleState).toBe("candidate");
    expect(listPendingFacts(config)).toHaveLength(1);
  });

  it("stores decisions as durable approved facts", () => {
    const root = mkdtempSync(join(tmpdir(), "engram-facts-decision-"));
    tempPaths.push(root);
    const dbPath = join(root, "engram.db");
    const database = openDatabase(dbPath);
    database.close();
    const config = resolveEngramConfig({ dbPath });

    const fact = rememberFact(config, {
      content: "Use sqlite for the Engram store.",
      memoryClass: "project",
      sourceKind: "decision",
    });

    expect(fact.approvalState).toBe("approved");
    expect(fact.lifecycleState).toBe("durable");
    expect(formatPendingFacts(listPendingFacts(config))).toBe("No pending facts.");
    expect(fact.scope).toBe("session");
  });

  it("stores governed remember metadata including scope and expiry", () => {
    const root = mkdtempSync(join(tmpdir(), "engram-facts-metadata-"));
    tempPaths.push(root);
    const dbPath = join(root, "engram.db");
    const database = openDatabase(dbPath);
    database.close();
    const config = resolveEngramConfig({ dbPath });

    const fact = rememberFact(config, {
      content: "Keep migration notes for this agent only.",
      memoryClass: "task",
      sourceBasis: "user_stated",
      scope: "agent",
      expiry: "7d",
    });

    expect(fact.sourceBasis).toBe("user_stated");
    expect(fact.scope).toBe("agent");
    expect(fact.expiresAt).toBeTruthy();
  });

  it("keeps agent-inferred facts pending instead of auto-promoting them", () => {
    const root = mkdtempSync(join(tmpdir(), "engram-facts-agent-inferred-"));
    tempPaths.push(root);
    const dbPath = join(root, "engram.db");
    const database = openDatabase(dbPath);
    database.close();
    const config = resolveEngramConfig({ dbPath });

    const fact = rememberFact(config, {
      content: "Use sqlite for the Engram store.",
      memoryClass: "project",
      sourceKind: "agent_inferred",
    });

    expect(fact.approvalState).toBe("pending");
    expect(listPendingFacts(config).map((entry) => entry.factId)).toContain(fact.factId);
    expect(searchApprovedFacts(config, "sqlite engram store", 5)).toHaveLength(0);
  });

  it("approves or rejects pending facts and exports the resulting ledger", () => {
    const root = mkdtempSync(join(tmpdir(), "engram-facts-review-"));
    tempPaths.push(root);
    const dbPath = join(root, "engram.db");
    const exportPath = join(root, "engram-export.md");
    const database = openDatabase(dbPath);
    database.close();
    const config = resolveEngramConfig({ dbPath, exportPath });

    const keep = rememberFact(config, {
      content: "User prefers terse status updates.",
      memoryClass: "identity",
      sourceKind: "agent_inferred",
    });
    const drop = rememberFact(config, {
      content: "User prefers verbose narration.",
      memoryClass: "identity",
      sourceKind: "agent_inferred",
    });

    const approved = approveFact(config, keep.factId);
    const rejected = rejectFact(config, drop.factId);
    const exportResult = exportMemories(config);
    const facts = listFacts(config);

    expect(approved?.approvalState).toBe("approved");
    expect(approved?.lifecycleState).toBe("durable");
    expect(rejected?.approvalState).toBe("rejected");
    expect(rejected?.lifecycleState).toBe("deprecated");
    expect(facts).toHaveLength(2);
    expect(exportResult.content).toContain("User prefers terse status updates.");
    expect(exportResult.content).toContain("deprecated");
    expect(exportResult.content).toContain("deprecated_reason: Rejected during review");
  });

  it("forgets approved facts without deleting audit history", () => {
    const root = mkdtempSync(join(tmpdir(), "engram-facts-forget-"));
    tempPaths.push(root);
    const dbPath = join(root, "engram.db");
    const database = openDatabase(dbPath);
    database.close();
    const config = resolveEngramConfig({ dbPath });

    const fact = rememberFact(config, {
      content: "This temporary plan is obsolete.",
      memoryClass: "task",
      sourceBasis: "user_stated",
    });

    const forgotten = forgetFact(config, fact.factId, "Task completed");
    const allFacts = listFacts(config);
    const searchResults = searchApprovedFacts(config, "temporary plan obsolete", 5);

    expect(forgotten?.lifecycleState).toBe("deprecated");
    expect(forgotten?.deprecatedReason).toBe("Task completed");
    expect(allFacts).toHaveLength(1);
    expect(searchResults).toHaveLength(0);
  });

  it("searches approved facts with decision and identity weighting", () => {
    const root = mkdtempSync(join(tmpdir(), "engram-facts-search-"));
    tempPaths.push(root);
    const dbPath = join(root, "engram.db");
    const database = openDatabase(dbPath);
    database.close();
    const config = resolveEngramConfig({ dbPath });

    rememberFact(config, {
      content: "Use sqlite for the Engram store.",
      memoryClass: "project",
      sourceKind: "decision",
    });
    const pending = rememberFact(config, {
      content: "User prefers detailed prose.",
      memoryClass: "identity",
      sourceKind: "agent_inferred",
    });
    approveFact(config, pending.factId);

    const results = searchApprovedFacts(config, "engram store sqlite", 5);

    expect(results).toHaveLength(2);
    expect(results[0]?.content).toContain("sqlite");
    expect(results[0]?.sourceKind).toBe("decision");
  });

  it("flags similar facts as open conflicts for review", () => {
    const root = mkdtempSync(join(tmpdir(), "engram-facts-conflicts-"));
    tempPaths.push(root);
    const dbPath = join(root, "engram.db");
    const database = openDatabase(dbPath);
    database.close();
    const config = resolveEngramConfig({ dbPath });

    rememberFact(config, {
      content: "Use sqlite for the Engram durable store.",
      memoryClass: "project",
      sourceKind: "decision",
    });
    rememberFact(config, {
      content: "Use sqlite for the Engram memory store.",
      memoryClass: "project",
      sourceKind: "decision",
    });

    const conflicts = listOpenConflicts(config);

    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]?.similarityScore).toBeGreaterThanOrEqual(0.5);
  });

  it("applies faster decay to task facts than to project decisions", () => {
    const root = mkdtempSync(join(tmpdir(), "engram-facts-decay-"));
    tempPaths.push(root);
    const dbPath = join(root, "engram.db");
    const database = openDatabase(dbPath);
    try {
      database.db.exec(`
        INSERT INTO kb_facts (
          fact_id, content, memory_class, source_kind, source_basis, scope, lifecycle_state, approval_state, created_at, updated_at
        ) VALUES
          ('task-1', 'remember the current migration todo', 'task', 'user_stated', 'user_stated', 'session', 'validated', 'approved', datetime('now', '-30 day'), datetime('now', '-30 day')),
          ('project-1', 'remember the current migration todo', 'project', 'decision', 'decision', 'session', 'durable', 'approved', datetime('now', '-30 day'), datetime('now', '-30 day'));
      `);
    } finally {
      database.close();
    }

    const config = resolveEngramConfig({ dbPath });
    const results = searchApprovedFacts(config, 'current migration todo', 5);

    expect(results[0]?.factId).toBe('project-1');
    expect(results[0]?.score).toBeGreaterThan(results[1]?.score ?? 0);
  });

  it("bypasses fact decay for configured whole-word keyword matches", () => {
    const root = mkdtempSync(join(tmpdir(), "engram-facts-bypass-"));
    tempPaths.push(root);
    const dbPath = join(root, "engram.db");
    const database = openDatabase(dbPath);
    try {
      database.db.exec(`
        INSERT INTO kb_facts (
          fact_id, content, memory_class, source_kind, source_basis, scope, lifecycle_state, approval_state, created_at, updated_at
        ) VALUES
          ('old-identity', 'sqlite preference remains important', 'identity', 'user_stated', 'user_stated', 'session', 'durable', 'approved', datetime('now', '-400 day'), datetime('now', '-400 day')),
          ('fresh-project', 'preference remains important', 'project', 'decision', 'decision', 'session', 'durable', 'approved', datetime('now'), datetime('now'));
      `);
    } finally {
      database.close();
    }

    const results = searchApprovedFacts(resolveEngramConfig({ dbPath }), 'sqlite preference', 5);

    expect(results[0]?.factId).toBe('old-identity');
  });
});