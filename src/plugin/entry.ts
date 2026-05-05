import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { EngramContextEngine } from "../engine/engine.js";
import { resolveEngramConfig } from "../config.js";
import { initializeEngramDatabase } from "./bootstrap.js";
import { openDatabase } from "../db/connection.js";
import { createEngramCommand } from "./commands.js";
import { syncConfiguredCollections } from "../kb/indexer.js";
import { createBeforePromptBuildHook } from "./recall.js";
import {
  createEngramExportTool,
  createEngramForgetTool,
  createEngramGetTool,
  createEngramIndexTool,
  createEngramCommitmentTool,
  createEngramDreamsTool,
  createEngramRememberTool,
  createEngramReviewTool,
  createEngramSearchTool,
  createEngramStatusTool,
  createMemoryGetTool,
  createMemoryRecallTool,
  createMemorySearchTool,
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
    const bootstrap = initializeEngramDatabase(config, process.env);
    bootstrap.database.close();

    const createEngine = () => new EngramContextEngine(openDatabase(config.dbPath), config, api.runtime);

    if (
      config.kbEnabled
      && config.kbAutoIndexOnStart
      && (config.kbCollections.length > 0 || config.openclawCanonicalMemory)
    ) {
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
    api.registerTool(() => createEngramStatusTool(config), { name: "engram_status" });
    api.registerTool(() => createEngramSearchTool(config), { name: "engram_search" });
    api.registerTool(() => createEngramGetTool(config), { name: "engram_get" });
    if (config.openclawMemoryCompat) {
      api.registerTool(() => createMemorySearchTool(config), { name: "memory_search" });
      api.registerTool(() => createMemoryGetTool(config), { name: "memory_get" });
      api.registerTool(() => createMemoryRecallTool(config), { name: "memory_recall" });
    }
    api.registerTool(() => createEngramIndexTool(config), { name: "engram_index" });
    api.registerTool(() => createEngramExportTool(config), { name: "engram_export" });
    api.registerTool(() => createEngramRememberTool(config), { name: "engram_remember" });
    api.registerTool(() => createEngramForgetTool(config), { name: "engram_forget" });
    api.registerTool(() => createEngramReviewTool(config), { name: "engram_review" });
    api.registerTool(() => createEngramCommitmentTool(config), { name: "engram_commitment" });
    api.registerTool(() => createEngramDreamsTool(config), { name: "engram_dreams" });
    api.on("before_prompt_build", createBeforePromptBuildHook(config));
  },
});
