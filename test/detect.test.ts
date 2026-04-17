import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { detectExistingData } from "../src/migrate/detect.js";

const tempPaths: string[] = [];

afterEach(() => {
  while (tempPaths.length > 0) {
    const current = tempPaths.pop();
    if (current) {
      rmSync(current, { recursive: true, force: true });
    }
  }
});

describe("detectExistingData", () => {
  it("finds lossless-claw and qmd databases from explicit env paths", () => {
    const root = mkdtempSync(join(tmpdir(), "engram-detect-"));
    tempPaths.push(root);

    const stateDir = join(root, "state");
    const qmdDir = join(root, "qmd");
    mkdirSync(stateDir, { recursive: true });
    mkdirSync(qmdDir, { recursive: true });

    const lcmDb = join(stateDir, "lcm.db");
    const qmdDb = join(qmdDir, "index.sqlite");
    writeFileSync(lcmDb, "lcm");
    writeFileSync(qmdDb, "qmd");

    const detected = detectExistingData({
      OPENCLAW_STATE_DIR: stateDir,
      QMD_CACHE_DIR: qmdDir,
    } as NodeJS.ProcessEnv);

    expect(detected.sources).toHaveLength(2);
    expect(detected.sources.map((source) => source.kind)).toEqual(["lossless-claw", "qmd"]);
  });

  it("returns empty when no sources exist", () => {
    const root = mkdtempSync(join(tmpdir(), "engram-detect-empty-"));
    tempPaths.push(root);

    const detected = detectExistingData({
      OPENCLAW_STATE_DIR: join(root, "missing-state"),
      QMD_CACHE_DIR: join(root, "missing-qmd"),
    } as NodeJS.ProcessEnv);

    expect(detected.sources).toHaveLength(0);
  });
});