import { afterEach, beforeEach, describe, expect, test } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { isCommandOnPath } from "./isCommandOnPath";

describe("isCommandOnPath", () => {
  let tmpDir: string;
  let originalPath: string | undefined;
  let originalPathExt: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "is-cmd-"));
    originalPath = process.env.PATH;
    originalPathExt = process.env.PATHEXT;
  });

  afterEach(() => {
    process.env.PATH = originalPath;
    process.env.PATHEXT = originalPathExt;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("returns true for bare command present on PATH", () => {
    fs.writeFileSync(path.join(tmpDir, "mytool"), "");
    process.env.PATH = tmpDir;
    expect(isCommandOnPath("mytool")).toBe(true);
  });

  test("returns true when only .cmd extension exists (Windows PATHEXT)", () => {
    fs.writeFileSync(path.join(tmpDir, "az.cmd"), "");
    process.env.PATH = tmpDir;
    process.env.PATHEXT = ".COM;.EXE;.BAT;.CMD";
    expect(isCommandOnPath("az")).toBe(true);
  });

  test("returns false when no candidate exists on PATH", () => {
    process.env.PATH = tmpDir;
    expect(isCommandOnPath("definitely-not-here-xyz")).toBe(false);
  });

  test("returns false for empty PATH without throwing", () => {
    // Clear both PATH and Path (Windows may have both).
    for (const key of Object.keys(process.env)) {
      if (key.toUpperCase() === "PATH") delete process.env[key];
    }
    process.env.PATH = "";
    expect(isCommandOnPath("definitely-not-on-empty-path-xyz")).toBe(false);
  });
});
