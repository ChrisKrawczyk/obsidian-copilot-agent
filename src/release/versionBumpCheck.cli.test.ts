import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { readFileSync } from "node:fs";

const repoRoot = process.cwd();
const script = resolve(repoRoot, "scripts", "version-bump.mjs");

function runVersionBump(args: string[]): {
  status: number | null;
  stdout: string;
  stderr: string;
} {
  const r = spawnSync("npx", ["tsx", script, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    shell: process.platform === "win32",
  });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function currentVersion(): string {
  return JSON.parse(readFileSync(resolve(repoRoot, "package.json"), "utf8")).version as string;
}

describe("scripts/version-bump.mjs --check (CLI entry point used by the release agent's preflight skill)", () => {
  it("exits 0 for a strictly greater target version", () => {
    // Anything above the current version should pass --check.
    const r = runVersionBump(["--check", "99.0.0"]);
    expect(r.status).toBe(0);
  }, 30_000);

  it("exits 0 (no-op) when the target equals the current version", () => {
    // Re-entrancy contract documented in version-bump.md skill:
    // --check returns 0 for the equal case so the bump skill can
    // safely skip when the file is already at the target.
    const r = runVersionBump(["--check", currentVersion()]);
    expect(r.status).toBe(0);
  }, 30_000);

  it("exits non-zero for a downgrade", () => {
    const r = runVersionBump(["--check", "0.0.1"]);
    expect(r.status).not.toBe(0);
    expect(r.stderr + r.stdout).toMatch(/monoton|less than|greater|downgrade/i);
  }, 30_000);

  it("exits non-zero for an invalid SemVer string", () => {
    const r = runVersionBump(["--check", "not-a-version"]);
    expect(r.status).not.toBe(0);
  }, 30_000);
});
