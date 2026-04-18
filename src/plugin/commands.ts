import type {
  OpenClawPluginCommandDefinition,
  PluginCommandContext,
} from "openclaw/plugin-sdk/plugin-entry";
import type { EngramConfig } from "../config.js";
import { openDatabase } from "../db/connection.js";
import { indexPath, syncConfiguredCollections } from "../kb/indexer.js";
import { getKnowledgeDocument, searchKnowledgeBase } from "../kb/store.js";
import { formatMigrationReport, runMigration, runMigrationDryRun } from "../migrate/runner.js";
import { formatDoctorReport, runDoctor } from "./doctor.js";
import { exportMemories } from "./export.js";
import {
  approveFact,
  forgetFact,
  formatPendingFacts,
  listOpenConflicts,
  listPendingFacts,
  rejectFact,
  searchApprovedFacts,
} from "./facts.js";
import { formatMaintenanceReport, maintainDatabase, resummarizeLcmSummaries } from "./maintenance.js";
import { mergePendingFacts, readPersona, writePersona } from "./persona.js";
import { formatStatus, readStatus } from "./status.js";

export function createEngramCommand(config: EngramConfig): OpenClawPluginCommandDefinition {
  return {
    name: "engram",
    description: "Show Engram status and basic diagnostics",
    acceptsArgs: true,
    handler: async (ctx) => handleEngramCommand(ctx, config),
  };
}

async function handleEngramCommand(
  ctx: PluginCommandContext,
  config: EngramConfig,
): Promise<{ text: string }> {
  const rawArgs = (ctx.args ?? "status").trim();
  const command = rawArgs.toLowerCase();
  if (command === "doctor") {
    return {
      text: formatDoctorReport(await runDoctor(config)),
    };
  }

  if (
    command === "migrate"
    || command === "migrate --dry-run"
    || command === "migrate --dryrun"
    || command === "migrate --resummarize-lcm"
  ) {
    if (command === "migrate") {
      const database = openDatabase(config.dbPath);
      try {
        return {
          text: formatMigrationReport(runMigration(database.db, process.env)),
        };
      } finally {
        database.close();
      }
    }
    if (command === "migrate --resummarize-lcm") {
      const database = openDatabase(config.dbPath);
      try {
        const report = await resummarizeLcmSummaries(database.db, config);
        return {
          text: `Re-summarized ${report.updated} imported LCM leaf summary(s) out of ${report.scanned} scanned.`,
        };
      } finally {
        database.close();
      }
    }
    return {
      text: formatMigrationReport(runMigrationDryRun(process.env)),
    };
  }

  if (command.startsWith("search ")) {
    const query = rawArgs.slice("search ".length).trim();
    const results = await searchKnowledgeBase(config, query, { limit: 5 });
    const factResults = searchApprovedFacts(config, query, 5);
    return {
      text:
        results.length === 0 && factResults.length === 0
          ? `No KB results for: ${query}`
          : [
              `KB search: ${query}`,
              "",
              ...factResults.map(
                (fact) =>
                  `- [fact:${fact.memoryClass}] ${fact.factId} (score ${fact.score}): ${truncate(fact.content)}`,
              ),
              ...results.map(
                (result) =>
                  `- [${result.collectionName}] ${result.relPath} (source_kind ${result.sourceKind}, score ${result.score}): ${truncate(result.content)}`,
              ),
            ].join("\n"),
    };
  }

  if (command.startsWith("get ")) {
    const id = rawArgs.slice("get ".length).trim();
    const document = getKnowledgeDocument(config, id);
    return {
      text:
        document == null
          ? `No KB document found for: ${id}`
          : [`${document.collectionName}/${document.relPath}`, "", document.content].join("\n"),
    };
  }

  if (command === "index") {
    const result = await syncConfiguredCollections(config);
    return {
      text:
        result.collections.length === 0
          ? "No configured KB collections to sync."
          : [
              `Synced ${result.collections.length} configured collection(s).`,
              "",
              ...result.collections.map(
                (collection) =>
                  `- [${collection.collectionName}] ${collection.indexedDocuments} document(s), ${collection.indexedChunks} chunk(s)${collection.skippedFiles.length > 0 ? `, skipped ${collection.skippedFiles.length}` : ""}`,
              ),
            ].join("\n"),
    };
  }

  if (command.startsWith("index ")) {
    const targetPath = rawArgs.slice("index ".length).trim();
    const result = await indexPath(config, targetPath);
    return {
      text: [
        `Indexed ${result.indexedDocuments} document(s) into [${result.collectionName}] with ${result.indexedChunks} chunk(s).`,
        result.skippedFiles.length > 0 ? `Skipped: ${result.skippedFiles.length}` : "",
      ].filter(Boolean).join("\n"),
    };
  }

  if (command === "review") {
    return {
      text: formatPendingFacts(listPendingFacts(config)),
    };
  }

  if (command === "conflicts") {
    const conflicts = listOpenConflicts(config);
    return {
      text:
        conflicts.length === 0
          ? "No open conflicts."
          : [
              "Open conflicts",
              "",
              ...conflicts.map(
                (conflict) =>
                  `- ${conflict.conflictId} (${conflict.similarityScore.toFixed(2)})\n  A: ${conflict.factContent}\n  B: ${conflict.conflictingContent}`,
              ),
            ].join("\n"),
    };
  }

  if (command.startsWith("approve ")) {
    const factId = rawArgs.slice("approve ".length).trim();
    const fact = approveFact(config, factId);
    if (fact?.memoryClass === "identity" && fact.approvalState === "approved") {
      mergePendingFacts(config, [factId]);
    }
    return {
      text: fact ? `Approved fact ${factId}.` : `Fact not found: ${factId}`,
    };
  }

  if (command.startsWith("reject ")) {
    const factId = rawArgs.slice("reject ".length).trim();
    const fact = rejectFact(config, factId);
    return {
      text: fact ? `Rejected fact ${factId}.` : `Fact not found: ${factId}`,
    };
  }

  if (command.startsWith("forget ")) {
    const rest = rawArgs.slice("forget ".length).trim();
    const [factId, ...reasonParts] = rest.split(/\s+/);
    const fact = forgetFact(config, factId ?? "", reasonParts.join(" "));
    return {
      text: fact ? `Forgot fact ${factId}.` : `Fact not found: ${factId}`,
    };
  }

  if (command === "persona") {
    const persona = readPersona(config);
    return {
      text: persona || "No persona set.",
    };
  }

  if (command.startsWith("persona set ")) {
    const content = rawArgs.slice("persona set ".length);
    writePersona(config, content);
    return {
      text: content.trim() ? `Updated persona at ${config.personaPath}.` : `Cleared persona at ${config.personaPath}.`,
    };
  }

  if (command === "export" || command.startsWith("export ")) {
    const targetPath = command === "export" ? undefined : rawArgs.slice("export ".length).trim();
    const result = exportMemories(config, targetPath);
    return {
      text: `Exported Engram memories to ${result.path}.`,
    };
  }

  if (command === "compact") {
    const database = openDatabase(config.dbPath);
    try {
      const engine = new (await import("../engine/engine.js")).EngramContextEngine(database, config);
      const result = await engine.compact({ sessionId: ctx.sessionId ?? "", tokenBudget: undefined });
      return {
        text: result.compacted
          ? `Compacted conversation ${ctx.sessionId ?? "unknown"} into summary ${String(result.result?.summary ?? "unknown")}.`
          : `No compaction performed: ${result.reason ?? "not needed"}`,
      };
    } finally {
      database.close();
    }
  }

  if (command === "maintain") {
    const database = openDatabase(config.dbPath);
    try {
      return {
        text: formatMaintenanceReport(maintainDatabase(database.db, config)),
      };
    } finally {
      database.close();
    }
  }

  return {
    text: [
      formatStatus(readStatus(config)),
      "",
      `sessionId: ${ctx.sessionId ?? "n/a"}`,
      `sessionKey: ${ctx.sessionKey ?? "n/a"}`,
      `kbEnabled: ${config.kbEnabled}`,
      `recallEnabled: ${config.recallEnabled}`,
      "commands: /engram, /engram doctor, /engram migrate, /engram migrate --dry-run, /engram migrate --resummarize-lcm, /engram search <query>, /engram get <id>, /engram index [path], /engram review, /engram conflicts, /engram approve <factId>, /engram reject <factId>, /engram forget <factId> [reason], /engram persona, /engram persona set <text>, /engram export [path], /engram compact, /engram maintain",
    ].join("\n"),
  };
}

function truncate(value: string, limit: number = 160): string {
  const collapsed = value.replace(/\s+/g, " ").trim();
  return collapsed.length <= limit ? collapsed : `${collapsed.slice(0, limit - 3)}...`;
}
