import { existsSync, statfsSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { EngramConfig } from "../config.js";
import { detectExistingData } from "../migrate/detect.js";

export type DoctorStatus = "pass" | "warn" | "fail";

export type DoctorCheck = {
  key: string;
  status: DoctorStatus;
  message: string;
};

export type DoctorReport = {
  ok: boolean;
  checks: DoctorCheck[];
};

const EMBEDDING_PROBE_TIMEOUT_MS = 2000;

export async function runDoctor(config: EngramConfig): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];

  checks.push({
    key: "config.enabled",
    status: config.enabled ? "pass" : "warn",
    message: config.enabled
      ? "Plugin is enabled."
      : "Plugin is disabled; runtime registration will be skipped by host config.",
  });

  const dbDir = dirname(config.dbPath);
  checks.push({
    key: "db.directory",
    status: existsSync(dbDir) ? "pass" : "warn",
    message: existsSync(dbDir)
      ? `Database directory exists: ${dbDir}`
      : `Database directory does not exist yet: ${dbDir}`,
  });
  checks.push(inspectDiskSpace(dbDir));

  const dbExists = existsSync(config.dbPath);
  checks.push({
    key: "db.file",
    status: dbExists ? "pass" : "warn",
    message: dbExists
      ? `Database file exists: ${config.dbPath}`
      : `Database file has not been created yet: ${config.dbPath}`,
  });

  if (dbExists) {
    checks.push(...inspectDatabase(config.dbPath, config));
  } else {
    checks.push({
      key: "db.integrity",
      status: "warn",
      message: "Integrity check skipped because the database file does not exist yet.",
    });
  }

  checks.push(await inspectEmbeddingEndpoint(config));

  const migrationSources = detectExistingData();
  checks.push({
    key: "migration.sources",
    status: migrationSources.sources.length > 0 ? "warn" : "pass",
    message:
      migrationSources.sources.length > 0
        ? `Detected importable data sources: ${migrationSources.sources
            .map((source) => `${source.kind} (${source.path})`)
            .join(", ")}`
        : "No existing lossless-claw or qmd data sources detected.",
  });

  return {
    ok: checks.every((check) => check.status !== "fail"),
    checks,
  };
}

async function inspectEmbeddingEndpoint(config: EngramConfig): Promise<DoctorCheck> {
  if (!config.embedEnabled) {
    return {
      key: "kb.embeddingEndpoint",
      status: "pass",
      message: "Embedding endpoint probe skipped because embeddings are disabled.",
    };
  }

  try {
    const response = await fetch(config.embedApiUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(config.embedApiKey ? { authorization: `Bearer ${config.embedApiKey}` } : {}),
      },
      body: JSON.stringify({
        model: config.embedApiModel,
        input: ["engram embedding healthcheck"],
      }),
      signal: AbortSignal.timeout(EMBEDDING_PROBE_TIMEOUT_MS),
    });

    if (!response.ok) {
      return {
        key: "kb.embeddingEndpoint",
        status: "fail",
        message: `Embedding endpoint returned HTTP ${response.status} for model ${config.embedApiModel}.`,
      };
    }

    return {
      key: "kb.embeddingEndpoint",
      status: "pass",
      message: `Embedding endpoint responded successfully for model ${config.embedApiModel}.`,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      key: "kb.embeddingEndpoint",
      status: "fail",
      message: `Embedding endpoint probe failed: ${message}`,
    };
  }
}

function inspectDatabase(dbPath: string, config: EngramConfig): DoctorCheck[] {
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(dbPath, { open: true, readOnly: true });
    const integrityRow = db
      .prepare("PRAGMA integrity_check")
      .get() as { integrity_check?: string } | undefined;
    const tableRow = db
      .prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table'")
      .get() as { count?: number } | undefined;
    const migrationRow = db
      .prepare("SELECT MAX(version) AS version FROM engram_migrations")
      .get() as { version?: number | null } | undefined;
    const importRunsRow = db
      .prepare("SELECT COUNT(*) AS count FROM engram_import_runs")
      .get() as { count?: number } | undefined;
    const embeddingsRow = db
      .prepare("SELECT COUNT(*) AS count FROM kb_embeddings")
      .get() as { count?: number } | undefined;
    const chunksRow = db
      .prepare("SELECT COUNT(*) AS count FROM kb_chunks")
      .get() as { count?: number } | undefined;
    const ftsRow = db
      .prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'kb_chunks_fts'")
      .get() as { count?: number } | undefined;
    const pendingFactsRow = db
      .prepare("SELECT COUNT(*) AS count FROM kb_facts WHERE approval_state = 'pending'")
      .get() as { count?: number } | undefined;
    const openConflictsRow = db
      .prepare("SELECT COUNT(*) AS count FROM kb_conflicts WHERE resolution_state = 'open'")
      .get() as { count?: number } | undefined;
    const benchmark = runSearchBenchmark(db);

    return [
      {
        key: "db.integrity",
        status: integrityRow?.integrity_check === "ok" ? "pass" : "fail",
        message:
          integrityRow?.integrity_check === "ok"
            ? "SQLite integrity_check passed."
            : `SQLite integrity_check returned: ${integrityRow?.integrity_check ?? "unknown"}`,
      },
      {
        key: "db.tables",
        status: (tableRow?.count ?? 0) > 0 ? "pass" : "fail",
        message: `Database contains ${tableRow?.count ?? 0} tables.`,
      },
      {
        key: "db.schemaVersion",
        status: typeof migrationRow?.version === "number" ? "pass" : "warn",
        message:
          typeof migrationRow?.version === "number"
            ? `Latest Engram schema version: ${migrationRow.version}`
            : "No Engram schema version recorded yet.",
      },
      {
        key: "migration.imports",
        status: (importRunsRow?.count ?? 0) > 0 ? "pass" : "warn",
        message:
          (importRunsRow?.count ?? 0) > 0
            ? `Recorded ${importRunsRow?.count ?? 0} completed import run(s).`
            : "No completed import runs recorded.",
      },
      {
        key: "kb.embeddings",
        status: config.embedEnabled && (embeddingsRow?.count ?? 0) === 0 ? "warn" : "pass",
        message:
          config.embedEnabled && (embeddingsRow?.count ?? 0) === 0
            ? "Embeddings are enabled but no kb_embeddings rows are stored yet."
            : `Stored kb_embeddings rows: ${embeddingsRow?.count ?? 0}.`,
      },
      {
        key: "kb.fts",
        status: (ftsRow?.count ?? 0) > 0 ? "pass" : "warn",
        message:
          (ftsRow?.count ?? 0) > 0
            ? "FTS search table is present."
            : "FTS search table is not present; KB search is currently using the fallback lexical scan path.",
      },
      {
        key: "kb.searchReadiness",
        status: (ftsRow?.count ?? 0) === 0 && (chunksRow?.count ?? 0) > 5000 ? "warn" : "pass",
        message:
          (ftsRow?.count ?? 0) === 0 && (chunksRow?.count ?? 0) > 5000
            ? `KB contains ${chunksRow?.count ?? 0} chunks without FTS; large-collection search may be degraded.`
            : `KB search readiness looks acceptable for ${chunksRow?.count ?? 0} chunks.`,
      },
      {
        key: "kb.sessionCircuitBreaker",
        status: config.kbSessionIndexCircuitBreaker ? "pass" : "warn",
        message: config.kbSessionIndexCircuitBreaker
          ? "Session summary indexing circuit breaker is enabled."
          : "Session summary indexing circuit breaker is disabled; summary feedback loops are possible.",
      },
      {
        key: "kb.searchBenchmark",
        status: benchmark.status,
        message: benchmark.message,
      },
      {
        key: "facts.pending",
        status: (pendingFactsRow?.count ?? 0) > 0 ? "warn" : "pass",
        message:
          (pendingFactsRow?.count ?? 0) > 0
            ? `There are ${pendingFactsRow?.count ?? 0} pending fact approval(s).`
            : "No pending fact approvals.",
      },
      {
        key: "facts.conflicts",
        status: (openConflictsRow?.count ?? 0) > 0 ? "warn" : "pass",
        message:
          (openConflictsRow?.count ?? 0) > 0
            ? `There are ${openConflictsRow?.count ?? 0} open fact conflict(s).`
            : "No open fact conflicts.",
      },
    ];
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return [
      {
        key: "db.open",
        status: "fail",
        message: `Failed to inspect database: ${message}`,
      },
    ];
  } finally {
    db?.close();
  }
}

export function formatDoctorReport(report: DoctorReport): string {
  const lines = ["Engram doctor", `overall: ${report.ok ? "pass" : "fail"}`, ""];
  for (const check of report.checks) {
    lines.push(`[${check.status.toUpperCase()}] ${check.key}: ${check.message}`);
  }
  return lines.join("\n");
}

function inspectDiskSpace(dbDir: string): DoctorCheck {
  if (!existsSync(dbDir)) {
    return {
      key: "db.diskSpace",
      status: "warn",
      message: `Disk space check skipped because the database directory does not exist yet: ${dbDir}`,
    };
  }

  try {
    const stats = statfsSync(dbDir);
    const availableBytes = Number(stats.bavail) * Number(stats.bsize);
    const availableMb = Math.floor(availableBytes / (1024 * 1024));
    return {
      key: "db.diskSpace",
      status: availableMb < 100 ? "warn" : "pass",
      message:
        availableMb < 100
          ? `Low disk space near database path: ${availableMb} MiB available.`
          : `Disk space near database path: ${availableMb} MiB available.`,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      key: "db.diskSpace",
      status: "warn",
      message: `Disk space check failed: ${message}`,
    };
  }
}

function runSearchBenchmark(db: DatabaseSync): DoctorCheck {
  const sample = db.prepare(`
    SELECT content FROM kb_chunks ORDER BY rowid ASC LIMIT 1
  `).get() as { content?: string } | undefined;
  if (!sample?.content?.trim()) {
    return {
      key: "kb.searchBenchmark",
      status: "pass",
      message: "KB search benchmark skipped because no chunks are indexed yet.",
    };
  }

  const term = sample.content
    .toLowerCase()
    .split(/[^a-z0-9_-]+/i)
    .find((value) => value.length >= 4);
  if (!term) {
    return {
      key: "kb.searchBenchmark",
      status: "pass",
      message: "KB search benchmark skipped because no representative query term was found.",
    };
  }

  const startedAt = Date.now();
  const row = db.prepare(`
    SELECT COUNT(*) AS count FROM kb_chunks WHERE LOWER(content) LIKE ?
  `).get(`%${term}%`) as { count?: number } | undefined;
  const elapsedMs = Date.now() - startedAt;
  return {
    key: "kb.searchBenchmark",
    status: elapsedMs > 50 ? "warn" : "pass",
    message: `Sample KB search for '${term}' completed in ${elapsedMs}ms with ${row?.count ?? 0} hit(s).`,
  };
}