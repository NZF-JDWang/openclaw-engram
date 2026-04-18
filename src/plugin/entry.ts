import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { EngramContextEngine } from "../engine/engine.js";
import { resolveEngramConfig } from "../config.js";
import { initializeEngramDatabase } from "./bootstrap.js";
import { openDatabase } from "../db/connection.js";
import { createEngramCommand } from "./commands.js";
import { syncConfiguredCollections } from "../kb/indexer.js";
import { createBeforePromptBuildHook } from "./recall.js";
import { autoDetectVaultCollections, persistDetectedCollections } from "./vault-detect.js";
import {
  createEngramExportTool,
  createEngramGetTool,
  createEngramIndexTool,
  createEngramSearchTool,
  createEngramStatusTool,
} from "./tools.js";

export default definePluginEntry({
  id: "engram",
  name: "Engram",
  description: "Unified OpenClaw memory system",
  kind: "context-engine",
  configSchema: {
    parse(value: unknown) {
      return resolveEngramConfig(value, process.env);
    },
  },
  register(api: OpenClawPluginApi) {
    const config = resolveEngramConfig(api.pluginConfig, process.env);
    const autoDetected = autoDetectVaultCollections(config, process.env);
    if (autoDetected.length > 0) {
      console.warn("[engram] Scanning for Obsidian vaults...");
      config.kbCollections.push(...autoDetected.map((entry) => entry.collection));
      for (const entry of autoDetected) {
        console.warn(
          `[engram] Found vault: ${entry.vault.path} (${entry.vault.markdownFiles} markdown files). Added "${entry.collection.name}" to KB collections.`,
        );
      }
      queueMicrotask(() => {
        void persistDetectedCollections(api, autoDetected.map((entry) => entry.collection))
          .catch((error: unknown) => {
            const message = error instanceof Error ? error.message : String(error);
            console.warn(`[engram] Failed to persist auto-detected vault configuration: ${message}`);
          });
      });
    }

    const bootstrap = initializeEngramDatabase(config, process.env);
    bootstrap.database.close();

    const createEngine = () => new EngramContextEngine(openDatabase(config.dbPath), config, api.runtime);

    if (config.kbEnabled && config.kbAutoIndexOnStart && config.kbCollections.length > 0) {
      queueMicrotask(() => {
        void syncConfiguredCollections(config).catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          console.warn(`[engram] Startup KB sync failed: ${message}`);
        });
      });
    }

    api.registerContextEngine("engram", createEngine);
    api.registerContextEngine("default", createEngine);
    api.registerCommand(createEngramCommand(config));
    api.registerTool(() => createEngramStatusTool(config));
    api.registerTool(() => createEngramSearchTool(config));
    api.registerTool(() => createEngramGetTool(config));
    api.registerTool(() => createEngramIndexTool(config));
    api.registerTool(() => createEngramExportTool(config));
    api.on("before_prompt_build", createBeforePromptBuildHook(config));
  },
});
