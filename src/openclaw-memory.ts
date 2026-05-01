import { existsSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import type { EngramConfig, EngramKbCollection } from "./config.js";

export const OPENCLAW_MEMORY_COLLECTION = "openclaw-memory";
export const OPENCLAW_DAILY_MEMORY_COLLECTION = "openclaw-daily-memory";
export const OPENCLAW_DREAMS_COLLECTION = "openclaw-dreams";

export function resolveOpenClawMemoryCollections(
  config: Pick<EngramConfig, "kbCollections" | "openclawCanonicalMemory" | "openclawMemoryWorkspacePath">,
): EngramKbCollection[] {
  if (!config.openclawCanonicalMemory) {
    return config.kbCollections;
  }

  const canonical = discoverCanonicalMemoryCollections(config.openclawMemoryWorkspacePath);
  const byName = new Map<string, EngramKbCollection>();
  for (const collection of [...canonical, ...config.kbCollections]) {
    byName.set(normalizeCollectionName(collection.name), collection);
  }
  return [...byName.values()];
}

export function discoverCanonicalMemoryCollections(workspacePath: string): EngramKbCollection[] {
  const collections: EngramKbCollection[] = [];
  const durableMemory = join(workspacePath, "MEMORY.md");
  const dailyMemory = join(workspacePath, "memory");
  const dreams = join(workspacePath, "DREAMS.md");

  if (existsSync(durableMemory)) {
    collections.push({
      name: OPENCLAW_MEMORY_COLLECTION,
      path: durableMemory,
      pattern: basename(durableMemory),
      description: "OpenClaw durable MEMORY.md",
      indexMode: "pointer",
      recallWeight: 1.35,
    });
  }

  if (existsSync(dailyMemory) && statSync(dailyMemory).isDirectory()) {
    collections.push({
      name: OPENCLAW_DAILY_MEMORY_COLLECTION,
      path: dailyMemory,
      pattern: "*.md",
      description: "OpenClaw daily memory notes",
      indexMode: "pointer",
      recallWeight: 1.05,
    });
  }

  if (existsSync(dreams)) {
    collections.push({
      name: OPENCLAW_DREAMS_COLLECTION,
      path: dreams,
      pattern: basename(dreams),
      description: "OpenClaw DREAMS.md review diary",
      indexMode: "pointer",
      recallWeight: 0.85,
    });
  }

  return collections;
}

export function isOpenClawEvergreenCollection(collectionName?: string): boolean {
  return collectionName === OPENCLAW_MEMORY_COLLECTION;
}

export function normalizeCollectionName(value: string): string {
  return value.trim().replace(/[^a-z0-9_-]+/gi, "-").replace(/^-+|-+$/g, "").toLowerCase() || "manual";
}
