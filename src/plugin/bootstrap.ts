import { existsSync } from "node:fs";
import type { EngramConfig } from "../config.js";
import { openDatabase, type EngramDatabase } from "../db/connection.js";
import { detectExistingData } from "../migrate/detect.js";
import { runMigration, type MigrationReport } from "../migrate/runner.js";

export type BootstrapDatabaseResult = {
  database: EngramDatabase;
  migrationReport?: MigrationReport;
};

export function initializeEngramDatabase(
  config: EngramConfig,
  env: NodeJS.ProcessEnv = process.env,
): BootstrapDatabaseResult {
  const databaseAlreadyExists = existsSync(config.dbPath);
  const database = openDatabase(config.dbPath);

  if (databaseAlreadyExists) {
    return { database };
  }

  const sources = detectExistingData(env).sources;
  if (sources.length === 0) {
    return { database };
  }

  try {
    const migrationReport = runMigration(database.db, env);
    return {
      database,
      migrationReport,
    };
  } catch (error) {
    database.close();
    throw error;
  }
}