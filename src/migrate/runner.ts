import { DatabaseSync } from "node:sqlite";
import { basename } from "node:path";
import { detectExistingData, type MigrationSource } from "./detect.js";
import { importFromLcm, type LcmImportResult } from "./lcm-importer.js";
import { importFromQmd, type QmdImportResult } from "./qmd-importer.js";

export type MigrationTableCount = {
  table: string;
  count: number;
};

export type MigrationInspection = {
  kind: MigrationSource["kind"];
  path: string;
  sizeBytes: number;
  counts: MigrationTableCount[];
  warnings: string[];
};

export type MigrationReport = {
  dryRun: boolean;
  inspections: MigrationInspection[];
  imports?: Array<LcmImportResult | QmdImportResult>;
};

const LCM_COUNT_QUERIES = [
  "conversations",
  "messages",
  "message_parts",
  "summaries",
  "summary_messages",
  "summary_parents",
  "context_items",
  "large_files",
  "conversation_bootstrap_state",
] as const;

const QMD_COUNT_QUERIES = [
  "documents",
  "content",
  "content_vectors",
  "store_collections",
] as const;

export function runMigrationDryRun(env: NodeJS.ProcessEnv = process.env): MigrationReport {
  const inspections = detectExistingData(env).sources.map((source) => inspectSource(source));
  return {
    dryRun: true,
    inspections,
  };
}

export function runMigration(destDb: DatabaseSync, env: NodeJS.ProcessEnv = process.env): MigrationReport {
  const sources = detectExistingData(env).sources;
  const imports: Array<LcmImportResult | QmdImportResult> = [];
  for (const source of sources) {
    if (source.kind === "lossless-claw") {
      imports.push(importFromLcm(source.path, destDb));
      continue;
    }
    if (source.kind === "qmd") {
      imports.push(importFromQmd(source.path, destDb));
    }
  }
  return {
    dryRun: false,
    inspections: sources.map((source) => inspectSource(source)),
    imports,
  };
}

function inspectSource(source: MigrationSource): MigrationInspection {
  const warnings: string[] = [];
  let db: DatabaseSync | null = null;

  try {
    db = new DatabaseSync(source.path, { open: true, readOnly: true });
    const counts =
      source.kind === "lossless-claw"
        ? collectCounts(db, LCM_COUNT_QUERIES)
        : collectCounts(db, QMD_COUNT_QUERIES, {
            documents: "SELECT COUNT(*) AS count FROM documents WHERE active = 1",
          });

    if (source.kind === "qmd") {
      const vectorVecExists = tableExists(db, "vectors_vec");
      if (!vectorVecExists) {
        warnings.push("QMD vec0 table 'vectors_vec' not found; vector reuse will be skipped and re-indexing will be required.");
      }
    }

    return {
      kind: source.kind,
      path: source.path,
      sizeBytes: source.sizeBytes,
      counts,
      warnings,
    };
  } catch (error) {
    return {
      kind: source.kind,
      path: source.path,
      sizeBytes: source.sizeBytes,
      counts: [],
      warnings: [`Failed to inspect source DB: ${error instanceof Error ? error.message : String(error)}`],
    };
  } finally {
    db?.close();
  }
}

function collectCounts(
  db: DatabaseSync,
  tableNames: readonly string[],
  overrides: Partial<Record<string, string>> = {},
): MigrationTableCount[] {
  const counts: MigrationTableCount[] = [];
  for (const tableName of tableNames) {
    if (!tableExists(db, tableName)) {
      counts.push({ table: tableName, count: 0 });
      continue;
    }
    const sql = overrides[tableName] ?? `SELECT COUNT(*) AS count FROM ${tableName}`;
    const row = db.prepare(sql).get() as { count?: number } | undefined;
    counts.push({ table: tableName, count: row?.count ?? 0 });
  }
  return counts;
}

function tableExists(db: DatabaseSync, tableName: string): boolean {
  const row = db
    .prepare(`SELECT name FROM sqlite_master WHERE type IN ('table', 'view') AND name = ? LIMIT 1`)
    .get(tableName) as { name?: string } | undefined;
  return row?.name === tableName;
}

export function formatMigrationReport(report: MigrationReport): string {
  const lines = [report.dryRun ? "Engram migration dry-run" : "Engram migration", ""];

  if (report.inspections.length === 0) {
    lines.push("No existing lossless-claw or qmd databases detected.");
    return lines.join("\n");
  }

  for (const inspection of report.inspections) {
    lines.push(`${inspection.kind}: ${basename(inspection.path)}`);
    lines.push(`path: ${inspection.path}`);
    lines.push(`sizeBytes: ${inspection.sizeBytes}`);
    for (const count of inspection.counts) {
      lines.push(`  - ${count.table}: ${count.count}`);
    }
    for (const warning of inspection.warnings) {
      lines.push(`  - warning: ${warning}`);
    }
    lines.push("");
  }

  if (!report.dryRun) {
    if ((report.imports?.length ?? 0) === 0) {
      lines.push("No import actions were performed.");
    } else {
      lines.push("imports:");
      for (const entry of report.imports ?? []) {
        lines.push(`  - ${entry.skipped ? "skipped" : "imported"}: ${entry.sourcePath}`);
        for (const [key, value] of Object.entries(entry.counts)) {
          lines.push(`      ${key}: ${value}`);
        }
          for (const warning of "warnings" in entry ? entry.warnings : []) {
            lines.push(`      warning: ${warning}`);
          }
      }
    }
  }

  return lines.join("\n").trimEnd();
}