import type {
  OpenClawPluginCommandDefinition,
  PluginCommandContext,
} from "openclaw/plugin-sdk/plugin-entry";
import type { EngramConfig } from "../config.js";
import { openDatabase } from "../db/connection.js";
import { dropKbCollection, indexAllSummariesIntoKB, indexPath, syncConfiguredCollections, storeExplicitFact, deleteExplicitFact, listExplicitFacts } from "../kb/indexer.js";
import { getKnowledgeDocument, searchKnowledgeBase } from "../kb/store.js";
import { formatMigrationReport, runMigration, runMigrationDryRun } from "../migrate/runner.js";
import { formatDoctorReport, runDoctor } from "./doctor.js";
import { exportMemories } from "./export.js";
import { formatMaintenanceReport, maintainDatabase, resummarizeLcmSummaries } from "./maintenance.js";
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
    || command === "migrate --index-summaries"
    || command === "migrate --drop-sessions"
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
    if (command === "migrate --index-summaries") {
      const database = openDatabase(config.dbPath);
      try {
        const report = await indexAllSummariesIntoKB(database.db, config);
        return {
          text: `Indexed summaries into __sessions KB: ${report.indexed} indexed, ${report.skipped} skipped (already indexed or empty), ${report.scanned} scanned.`,
        };
      } finally {
        database.close();
      }
    }
    if (command === "migrate --drop-sessions") {
      const database = openDatabase(config.dbPath);
      try {
        const result = dropKbCollection(database.db, "sessions");
        return {
          text: `Dropped [sessions] collection: ${result.droppedDocs} doc(s), ${result.droppedChunks} chunk(s) removed.`,
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
    const { query: cleanQuery, since, until, error: dateError } = parseSearchArgs(query);
    if (dateError) {
      return { text: dateError };
    }
    const results = await searchKnowledgeBase(config, cleanQuery, { limit: 5, since, until });
    return {
      text:
        results.length === 0
          ? `No KB results for: ${cleanQuery}`
          : [
              `KB search: ${cleanQuery}${since ? ` (since ${since})` : ""}${until ? ` (until ${until})` : ""}`,
              "",
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

  if (command.startsWith("remember ")) {
    const raw = rawArgs.slice("remember ".length).trim();
    const { content, replaces } = parseRememberArgs(raw);
    if (!content) {
      return { text: "Usage: /engram remember <text> [--replaces <factId>]" };
    }
    const database = openDatabase(config.dbPath);
    try {
      const result = await storeExplicitFact(database.db, config, { content, replaces });
      const lines = [`Remembered (ID: ${result.factId}): "${result.label}"` ];
      if (result.replacedFactId) lines.push(`Replaced: ${result.replacedFactId}`);
      if (result.conflicts.length > 0) {
        lines.push(`Warning: similar facts already stored:`);
        for (const c of result.conflicts) {
          lines.push(`  - ${c.factId}: "${c.label}" (${(c.similarity * 100).toFixed(0)}% similar)`);
        }
      }
      return { text: lines.join("\n") };
    } finally {
      database.close();
    }
  }

  if (command.startsWith("forget ")) {
    const factId = rawArgs.slice("forget ".length).trim();
    if (!factId) {
      return { text: "Usage: /engram forget <factId>" };
    }
    const database = openDatabase(config.dbPath);
    try {
      const deleted = deleteExplicitFact(database.db, factId);
      return { text: deleted ? `Deleted fact: ${factId}` : `No fact found with ID: ${factId}` };
    } finally {
      database.close();
    }
  }

  if (command === "review") {
    const database = openDatabase(config.dbPath);
    try {
      const facts = listExplicitFacts(database.db);
      if (facts.length === 0) {
        return { text: "No stored facts." };
      }
      const now = Date.now();
      const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
      const lines: string[] = [`Stored facts (${facts.length} total, stalest first):`, ""];
      for (const fact of facts) {
        const lastHitMs = fact.lastHitAt ? Date.parse(fact.lastHitAt) : null;
        const isStale = lastHitMs === null || now - lastHitMs > thirtyDaysMs;
        const staleTag = isStale ? ` [STALE — last hit: ${fact.lastHitAt ?? "never"}]` : "";
        lines.push(`${fact.factId}${staleTag}`);
        lines.push(`  ${fact.content.length > 100 ? fact.content.slice(0, 100) + "..." : fact.content}`);
        lines.push(`  Stored: ${fact.indexedAt}  Hits: ${fact.hitCount}`);
        lines.push("");
      }
      return { text: lines.join("\n") };
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
      "commands: /engram, /engram doctor, /engram migrate, /engram migrate --dry-run, /engram migrate --resummarize-lcm, /engram migrate --index-summaries, /engram migrate --drop-sessions, /engram search <query>, /engram get <id>, /engram index [path], /engram export [path], /engram compact, /engram maintain, /engram remember <text> [--replaces <id>], /engram forget <factId>, /engram review",
    ].join("\n"),
  };
}

function parseSearchArgs(raw: string): { query: string; since?: string; until?: string; error?: string } {
  let remaining = raw;
  let since: string | undefined;
  let until: string | undefined;

  const sinceMatch = /--since\s+(\S+)/.exec(remaining);
  if (sinceMatch) {
    since = sinceMatch[1];
    remaining = remaining.replace(sinceMatch[0], "").trim();
    if (!isIsoDate(since)) {
      return { query: remaining, error: `Invalid --since date: "${since}". Expected YYYY-MM-DD.` };
    }
  }

  const untilMatch = /--until\s+(\S+)/.exec(remaining);
  if (untilMatch) {
    until = untilMatch[1];
    remaining = remaining.replace(untilMatch[0], "").trim();
    if (!isIsoDate(until)) {
      return { query: remaining, error: `Invalid --until date: "${until}". Expected YYYY-MM-DD.` };
    }
  }

  return { query: remaining, since, until };
}

function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  const date = new Date(value);
  return !Number.isNaN(date.getTime());
}

function parseRememberArgs(raw: string): { content: string; replaces?: string } {
  const replacesMatch = /--replaces\s+(\S+)/.exec(raw);
  if (replacesMatch) {
    const replaces = replacesMatch[1];
    const content = raw.replace(replacesMatch[0], "").trim();
    return { content, replaces };
  }
  return { content: raw };
}

function truncate(value: string, limit: number = 160): string {
  const collapsed = value.replace(/\s+/g, " ").trim();
  return collapsed.length <= limit ? collapsed : `${collapsed.slice(0, limit - 3)}...`;
}
