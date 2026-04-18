import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveEngramConfig } from "../src/config.js";
import {
  autoDetectVaultCollections,
  detectObsidianVaults,
  persistDetectedCollections,
} from "../src/plugin/vault-detect.js";

const tempPaths: string[] = [];

afterEach(() => {
  while (tempPaths.length > 0) {
    const current = tempPaths.pop();
    if (current) {
      rmSync(current, { recursive: true, force: true });
    }
  }
});

describe("vault detection", () => {
  it("detects vaults in common paths and Obsidian settings", () => {
    const root = mkdtempSync(join(tmpdir(), "engram-vault-detect-"));
    tempPaths.push(root);
    const home = join(root, "home");
    const commonVault = join(home, "Obsidian", "MainVault");
    const settingsVault = join(home, "vaults", "ConfigVault");
    mkdirSync(join(commonVault, ".obsidian"), { recursive: true });
    mkdirSync(join(settingsVault, ".obsidian"), { recursive: true });
    writeFileSync(join(commonVault, "a.md"), "# A");
    writeFileSync(join(commonVault, "nested.txt"), "x");
    mkdirSync(join(commonVault, "notes"), { recursive: true });
    writeFileSync(join(commonVault, "notes", "b.MD"), "# B");
    writeFileSync(join(settingsVault, "c.md"), "# C");

    const obsidianConfigDir = join(home, ".config", "obsidian");
    mkdirSync(obsidianConfigDir, { recursive: true });
    writeFileSync(
      join(obsidianConfigDir, "obsidian.json"),
      JSON.stringify({
        vaults: {
          one: { path: settingsVault },
        },
      }),
    );

    const detected = detectObsidianVaults({
      HOME: home,
      USERPROFILE: home,
    } as NodeJS.ProcessEnv);

    expect(detected.map((entry) => entry.path)).toEqual([commonVault, settingsVault]);
    expect(detected[0]?.markdownFiles).toBe(2);
    expect(detected[1]?.markdownFiles).toBe(1);
  });

  it("adds detected vault collections when kb collections are empty", () => {
    const root = mkdtempSync(join(tmpdir(), "engram-vault-auto-"));
    tempPaths.push(root);
    const home = join(root, "home");
    const vault = join(home, "obsidian-vaults", "Notes");
    mkdirSync(join(vault, ".obsidian"), { recursive: true });
    writeFileSync(join(vault, "note.md"), "# note");

    const config = resolveEngramConfig({
      kbCollections: [],
      autoDetectVaults: false,
    });
    const detected = autoDetectVaultCollections(config, { HOME: home, USERPROFILE: home } as NodeJS.ProcessEnv);
    expect(detected).toHaveLength(1);
    expect(detected[0]?.collection.path).toBe(vault);
    expect(detected[0]?.collection.pattern).toBe("**/*.md");
  });

  it("persists detected collections through runtime config when available", async () => {
    const mockWriteConfigFile = vi.fn<(cfg: OpenClawConfig) => Promise<void>>(async () => undefined);
    const loadConfig = vi.fn(() => ({
      plugins: {
        entries: {
          engram: {
            config: {
              kbCollections: [],
            },
          },
        },
      },
    }));

    const api = {
      id: "engram",
      pluginConfig: {},
      runtime: {
        config: {
          loadConfig,
          writeConfigFile: mockWriteConfigFile,
        },
      },
    };

    const persisted = await persistDetectedCollections(
      api,
      [{ name: "obsidian", path: "/tmp/vault", pattern: "**/*.md" }],
    );

    expect(persisted).toBe(true);
    expect(mockWriteConfigFile).toHaveBeenCalledTimes(1);
    const configObject = mockWriteConfigFile.mock.calls[0]?.[0] as Record<string, unknown>;
    const pluginConfig = ((configObject.plugins as Record<string, unknown>)?.entries as Record<string, unknown>)
      ?.engram as Record<string, unknown>;
    const kbCollections = ((pluginConfig?.config as Record<string, unknown>)?.kbCollections ?? []) as Array<
      Record<string, unknown>
    >;
    expect(kbCollections[0]?.path).toBe("/tmp/vault");
  });
});
