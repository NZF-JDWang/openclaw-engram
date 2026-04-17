import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

export type MigrationSource = {
  kind: "lossless-claw" | "qmd";
  path: string;
  sizeBytes: number;
};

export type MigrationSources = {
  sources: MigrationSource[];
};

export function detectExistingData(env: NodeJS.ProcessEnv = process.env): MigrationSources {
  const sources: MigrationSource[] = [];

  const lcmPath = resolveLcmDbPath(env);
  if (lcmPath && existsSync(lcmPath)) {
    sources.push({
      kind: "lossless-claw",
      path: lcmPath,
      sizeBytes: safeSize(lcmPath),
    });
  }

  for (const sqlitePath of resolveQmdDbPaths(env)) {
    if (existsSync(sqlitePath)) {
      sources.push({
        kind: "qmd",
        path: sqlitePath,
        sizeBytes: safeSize(sqlitePath),
      });
    }
  }

  return { sources };
}

function resolveLcmDbPath(env: NodeJS.ProcessEnv): string {
  const stateDir = env.OPENCLAW_STATE_DIR?.trim();
  if (stateDir) {
    return join(stateDir, "lcm.db");
  }
  return join(homedir(), ".openclaw", "lcm.db");
}

function resolveQmdDbPaths(env: NodeJS.ProcessEnv): string[] {
  const candidates = new Set<string>();
  const explicitCacheDir = env.QMD_CACHE_DIR?.trim();
  if (explicitCacheDir) {
    candidates.add(explicitCacheDir);
  }

  candidates.add(join(homedir(), ".cache", "qmd"));
  if (env.LOCALAPPDATA?.trim()) {
    candidates.add(join(env.LOCALAPPDATA.trim(), "qmd"));
  }

  const sqliteFiles: string[] = [];
  for (const dirPath of candidates) {
    if (!existsSync(dirPath)) {
      continue;
    }
    const entries = readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile()) {
        continue;
      }
      if (!entry.name.toLowerCase().endsWith(".sqlite")) {
        continue;
      }
      sqliteFiles.push(join(dirPath, entry.name));
    }
  }

  return sqliteFiles.sort((left, right) => basename(left).localeCompare(basename(right)));
}

function safeSize(filePath: string): number {
  try {
    return statSync(filePath).size;
  } catch {
    return 0;
  }
}