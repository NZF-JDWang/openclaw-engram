import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { EngramConfig } from "../config.js";

export function exportMemories(config: EngramConfig, outputPath?: string): { path: string; content: string } {
  const targetPath = outputPath?.trim() || config.exportPath;
  const content = [
    "# Engram Export",
    "",
    `Generated: ${new Date().toISOString()}`,
    "",
  ].join("\n");

  mkdirSync(dirname(targetPath), { recursive: true });
  writeFileSync(targetPath, content, "utf8");
  return { path: targetPath, content };
}