import { type Dirent, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { EngramConfig, EngramKbCollection } from "../config.js";

export type AutoDetectedVault = {
  name: string;
  path: string;
  markdownFiles: number;
};

export type AutoDetectedCollection = {
  collection: EngramKbCollection;
  vault: AutoDetectedVault;
};

export function autoDetectVaultCollections(
  config: EngramConfig,
  env: NodeJS.ProcessEnv = process.env,
): AutoDetectedCollection[] {
  if (config.kbCollections.length > 0 && !config.autoDetectVaults) {
    return [];
  }

  const existingPaths = new Set(config.kbCollections.map((collection) => resolve(collection.path)));
  const usedNames = new Set(config.kbCollections.map((collection) => collection.name));
  const detectedCollections: AutoDetectedCollection[] = [];

  for (const vault of detectObsidianVaults(env)) {
    const vaultPath = resolve(vault.path);
    if (existingPaths.has(vaultPath)) {
      continue;
    }
    existingPaths.add(vaultPath);
    const collectionName = uniqueCollectionName(vault.name, usedNames);
    usedNames.add(collectionName);
    detectedCollections.push({
      vault,
      collection: {
        name: collectionName,
        path: vaultPath,
        pattern: "**/*.md",
        description: "Auto-detected Obsidian vault",
      },
    });
  }

  return detectedCollections;
}

export async function persistDetectedCollections(
  api: OpenClawPluginApi,
  collections: EngramKbCollection[],
): Promise<boolean> {
  if (collections.length === 0) {
    return false;
  }

  const pluginConfig = asRecord(api.pluginConfig);
  const runtimeConfig = api.runtime?.config;
  if (typeof runtimeConfig?.loadConfig !== "function" || typeof runtimeConfig.writeConfigFile !== "function") {
    pluginConfig.kbCollections = mergeCollections(pluginConfig.kbCollections, collections);
    return false;
  }

  const nextConfig = asRecord(runtimeConfig.loadConfig());
  const plugins = ensureRecord(nextConfig, "plugins");
  const entries = ensureRecord(plugins, "entries");
  const currentEntry = ensureRecord(entries, api.id);
  const nextPluginConfig = ensureRecord(currentEntry, "config");
  nextPluginConfig.kbCollections = mergeCollections(nextPluginConfig.kbCollections, collections);
  await runtimeConfig.writeConfigFile(nextConfig as never);
  return true;
}

export function detectObsidianVaults(env: NodeJS.ProcessEnv = process.env): AutoDetectedVault[] {
  const home = env.HOME || env.USERPROFILE || homedir();
  const candidates = new Set<string>();
  for (const path of commonVaultCandidates(home)) {
    collectVaultsFromRoot(path, candidates);
  }
  for (const path of vaultPathsFromObsidianSettings(home, env)) {
    candidates.add(resolve(path));
  }

  const vaults: AutoDetectedVault[] = [];
  for (const candidatePath of candidates) {
    if (!isObsidianVault(candidatePath)) {
      continue;
    }
    vaults.push({
      name: basename(candidatePath) || "obsidian-vault",
      path: resolve(candidatePath),
      markdownFiles: countMarkdownFiles(candidatePath),
    });
  }

  vaults.sort((left, right) => left.path.localeCompare(right.path));
  return vaults;
}

function commonVaultCandidates(home: string): string[] {
  return [
    join(home, "obsidian-vaults"),
    join(home, "Obsidian"),
    join(home, "Documents", "Obsidian"),
  ];
}

function collectVaultsFromRoot(rootPath: string, candidates: Set<string>): void {
  if (!isDirectory(rootPath)) {
    return;
  }
  if (isObsidianVault(rootPath)) {
    candidates.add(resolve(rootPath));
  }
  for (const entry of safeReadDir(rootPath)) {
    if (!entry.isDirectory()) {
      continue;
    }
    const candidatePath = join(rootPath, entry.name);
    if (isObsidianVault(candidatePath)) {
      candidates.add(resolve(candidatePath));
    }
  }
}

function vaultPathsFromObsidianSettings(home: string, env: NodeJS.ProcessEnv): string[] {
  const configPaths = [
    join(home, ".config", "obsidian", "obsidian.json"),
    join(home, "Library", "Application Support", "obsidian", "obsidian.json"),
    env.APPDATA ? join(env.APPDATA, "obsidian", "obsidian.json") : undefined,
  ].filter((path): path is string => Boolean(path));

  const paths = new Set<string>();
  for (const configPath of configPaths) {
    if (!existsSync(configPath)) {
      continue;
    }
    try {
      const parsed = JSON.parse(readFileSync(configPath, "utf8")) as unknown;
      const vaultEntries = asRecord(asRecord(parsed).vaults);
      for (const vault of Object.values(vaultEntries)) {
        const vaultPath = asRecord(vault).path;
        if (typeof vaultPath === "string" && vaultPath.trim().length > 0) {
          paths.add(resolve(vaultPath));
        }
      }
    } catch {
      continue;
    }
  }
  return [...paths];
}

function isObsidianVault(path: string): boolean {
  return isDirectory(path) && isDirectory(join(path, ".obsidian"));
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function safeReadDir(path: string): Dirent[] {
  try {
    return readdirSync(path, { encoding: "utf8", withFileTypes: true });
  } catch {
    return [];
  }
}

function countMarkdownFiles(rootPath: string): number {
  let count = 0;
  const queue = [rootPath];
  while (queue.length > 0) {
    const current = queue.pop();
    if (!current) {
      continue;
    }
    for (const entry of safeReadDir(current)) {
      const fullPath = join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== ".obsidian") {
          queue.push(fullPath);
        }
        continue;
      }
      if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
        count += 1;
      }
    }
  }
  return count;
}

function uniqueCollectionName(baseName: string, usedNames: Set<string>): string {
  const normalized = baseName.trim() || "obsidian-vault";
  if (!usedNames.has(normalized)) {
    return normalized;
  }
  let suffix = 2;
  while (usedNames.has(`${normalized}-${suffix}`)) {
    suffix += 1;
  }
  return `${normalized}-${suffix}`;
}

function mergeCollections(currentValue: unknown, additions: EngramKbCollection[]): EngramKbCollection[] {
  const currentCollections: EngramKbCollection[] = Array.isArray(currentValue)
    ? currentValue
      .map((entry) => asRecord(entry))
      .map((entry) => ({
        name: stringOrUndefined(entry.name) || "",
        path: stringOrUndefined(entry.path) || "",
        pattern: stringOrUndefined(entry.pattern) || "",
        description: stringOrUndefined(entry.description),
      }))
      .filter((entry) => entry.name.length > 0 && entry.path.length > 0 && entry.pattern.length > 0)
    : [];

  const existingPaths = new Set(currentCollections.map((collection) => resolve(collection.path)));
  const merged = [...currentCollections];
  for (const collection of additions) {
    if (existingPaths.has(resolve(collection.path))) {
      continue;
    }
    existingPaths.add(resolve(collection.path));
    merged.push(collection);
  }
  return merged;
}

function ensureRecord(container: Record<string, unknown>, key: string): Record<string, unknown> {
  const current = asRecord(container[key]);
  container[key] = current;
  return current;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}
