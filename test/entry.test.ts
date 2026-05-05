import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { ContextEngineFactory } from "openclaw/plugin-sdk";
import plugin from "../src/plugin/entry.js";

const tempPaths: string[] = [];

afterEach(() => {
  while (tempPaths.length > 0) {
    const current = tempPaths.pop();
    if (current) {
      rmSync(current, { recursive: true, force: true });
    }
  }
});

describe("plugin entry", () => {
  it("declares and registers OpenClaw tool contracts by explicit name", () => {
    const root = mkdtempSync(join(tmpdir(), "engram-entry-tools-"));
    tempPaths.push(root);
    const dbPath = join(root, "engram.db");
    const registeredToolNames: string[] = [];

    plugin.register({
      pluginConfig: { dbPath, openclawMemoryCompat: true },
      runtime: {} as never,
      registerContextEngine() {},
      registerCommand() {},
      registerTool(_tool: unknown, opts?: { name?: string; names?: string[] }) {
        registeredToolNames.push(...(opts?.names ?? []), ...(opts?.name ? [opts.name] : []));
      },
      on() {},
    } as unknown as OpenClawPluginApi);

    const manifest = JSON.parse(readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf8")) as {
      contracts?: { tools?: string[] };
    };
    const declaredToolNames = manifest.contracts?.tools ?? [];

    expect(declaredToolNames).toEqual([
      "engram_status",
      "engram_search",
      "engram_get",
      "memory_recall",
      "engram_index",
      "engram_export",
      "engram_remember",
      "engram_forget",
      "engram_review",
      "engram_commitment",
      "engram_dreams",
    ]);
    expect(registeredToolNames).toEqual([
      "engram_status",
      "engram_search",
      "engram_get",
      "memory_search",
      "memory_get",
      "memory_recall",
      "engram_index",
      "engram_export",
      "engram_remember",
      "engram_forget",
      "engram_review",
      "engram_commitment",
      "engram_dreams",
    ]);
    expect(declaredToolNames.every((name) => registeredToolNames.includes(name))).toBe(true);
  });

  it("creates a fresh context engine per factory call after prior dispose", async () => {
    const root = mkdtempSync(join(tmpdir(), "engram-entry-"));
    tempPaths.push(root);
    const dbPath = join(root, "engram.db");
    const contextFactories = new Map<string, ContextEngineFactory>();
    const eventHandlers = new Map<string, (event: { sessionId: string }) => Promise<void>>();

    plugin.register({
      pluginConfig: { dbPath },
      runtime: {} as never,
      registerContextEngine(id: string, factory: ContextEngineFactory) {
        contextFactories.set(id, factory);
      },
      registerCommand() {},
      registerTool() {},
      on(event: string, handler: unknown) {
        if (event === "session_end") {
          eventHandlers.set(event, handler as (event: { sessionId: string }) => Promise<void>);
        }
      },
    } as unknown as OpenClawPluginApi);

    const factory = contextFactories.get("engram");
    expect(factory).toBeTypeOf("function");

    const firstEngine = factory!() as {
      bootstrap(params: { sessionId: string; sessionFile: string; sessionKey?: string }): Promise<unknown>;
      ingest(params: { sessionId: string; sessionKey?: string; message: { role?: string; content?: unknown } }): Promise<unknown>;
      dispose(): Promise<void>;
    };
    const secondEngine = factory!() as typeof firstEngine;

    expect(firstEngine).not.toBe(secondEngine);

    await firstEngine.bootstrap({ sessionId: "session-1", sessionFile: "session-1.jsonl", sessionKey: "key-1" });
    await firstEngine.ingest({
      sessionId: "session-1",
      sessionKey: "key-1",
      message: { role: "user", content: "first session" },
    });
    await firstEngine.dispose();

    await secondEngine.bootstrap({ sessionId: "session-2", sessionFile: "session-2.jsonl", sessionKey: "key-2" });
    await secondEngine.ingest({
      sessionId: "session-2",
      sessionKey: "key-2",
      message: { role: "user", content: "second session" },
    });
    await secondEngine.dispose();

    await eventHandlers.get("session_end")?.({ sessionId: "session-2" });
  });
});
