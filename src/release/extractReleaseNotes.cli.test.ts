import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

// Vitest runs from the repo root (see vitest.config.ts); use cwd as
// the anchor rather than import.meta.url so this works in both ESM
// and any CJS interop path.
const repoRoot = process.cwd();
const script = resolve(repoRoot, "scripts", "release", "extract-release-notes.mjs");

function runExtract(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync("npx", ["tsx", script, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    shell: process.platform === "win32",
  });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

describe("scripts/release/extract-release-notes.mjs (CLI)", () => {
  it("prints the section verbatim for an existing CHANGELOG version", () => {
    const r = runExtract(["0.5.0"]);
    expect(r.status).toBe(0);
    // First line should be the heading for the requested version.
    expect(r.stdout.split(/\r?\n/)[0]).toBe("## [0.5.0] - 2026-06-18");
  }, 30_000);

  it("exits non-zero with a clear message when the version is missing", () => {
    const r = runExtract(["99.99.99"]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("No section found for version 99.99.99");
  }, 30_000);

  it("prints usage and exits non-zero when no version is supplied", () => {
    const r = runExtract([]);
    expect(r.status).not.toBe(0);
  }, 30_000);
});
