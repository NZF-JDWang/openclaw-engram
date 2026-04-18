import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { EngramContextEngine } from "../engine/engine.js";
import { resolveEngramConfig } from "../config.js";
import { initializeEngramDatabase } from "./bootstrap.js";
import { createEngramCommand } from "./commands.js";
import { syncConfiguredCollections } from "../kb/indexer.js";
import { createBeforePromptBuildHook } from "./recall.js";
import {
  createEngramExportTool,
  createEngramForgetTool,
  createEngramGetTool,
  createEngramIndexTool,
  createEngramMemoryGetTool,
  createEngramMemorySearchTool,
  createEngramPersonaTool,
  createEngramRememberTool,
  createEngramReviewTool,
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
    const { database } = initializeEngramDatabase(config, process.env);
    const engine = new EngramContextEngine(database, config, api.runtime);

    if (config.kbEnabled && config.kbAutoIndexOnStart && config.kbCollections.length > 0) {
      queueMicrotask(() => {
        void syncConfiguredCollections(config).catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          console.warn(`[engram] Startup KB sync failed: ${message}`);
        });
      });
    }

    api.registerContextEngine("engram", () => engine);
    api.registerContextEngine("default", () => engine);
    api.registerCommand(createEngramCommand(config));
    api.registerTool(() => createEngramStatusTool(config));
    api.registerTool(() => createEngramSearchTool(config));
    api.registerTool(() => createEngramGetTool(config));
    api.registerTool(() => createEngramMemorySearchTool(config), { names: ["memory_search"] });
    api.registerTool(() => createEngramMemoryGetTool(config), { names: ["memory_get"] });
    api.registerTool(() => createEngramIndexTool(config));
    api.registerTool(() => createEngramExportTool(config));
    api.registerTool(() => createEngramPersonaTool(config));
    api.registerTool(() => createEngramRememberTool(config));
    api.registerTool(() => createEngramForgetTool(config));
    api.registerTool(() => createEngramReviewTool(config));
    api.on("before_prompt_build", createBeforePromptBuildHook(config));
    api.on("session_end", async (event) => {
      await engine.onSessionEnd({ sessionId: event.sessionId });
    });
  },
});
