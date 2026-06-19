#!/usr/bin/env node
/**
 * Phase 5 retroactive bootstrap for the v0.5.0 GitHub Release.
 *
 * v0.5.0 (commit 22f660d) shipped before the release tooling existed,
 * so it was never published as a GitHub Release. BRAT users pinning
 * v0.5.0 currently fail because there is no Release for that tag.
 *
 * This script publishes v0.5.0 retroactively by:
 *   1. Verifying the workspace is clean and `gh` is authenticated.
 *   2. Adding a git worktree at the v0.5.0 commit (default: 22f660d).
 *   3. Running `npm ci && npm run build` in the worktree.
 *   4. Calling `assemble-assets.mjs 0.5.0 --bootstrap` (the bootstrap
 *      flag synthesizes a manifest.json with version: 0.5.0 from the
 *      well-formed source manifest at the worktree).
 *   5. Extracting the [0.5.0] section from CURRENT main's CHANGELOG.md
 *      (the worktree's CHANGELOG predates the format).
 *   6. Appending the spec-mandated historical-completeness notice.
 *   7. Creating an annotated tag v0.5.0 on the historical commit and
 *      pushing it.
 *   8. Creating the GitHub Release with the three staged assets
 *      (`gh release create --target <sha>` so the Release points at
 *      the historical commit, NOT main's tip).
 *   9. Cleaning up the worktree.
 *
 * IMPORTANT: This script does NOT create any new commit in the
 * worktree. It only tags the historical commit. Pushing the v0.5.0
 * tag does NOT trigger .github/workflows/release.yml (the workflow
 * file does not exist at 22f660d). The Release is created directly
 * via `gh release create`.
 *
 * Usage:
 *   npx tsx scripts/release/bootstrap-v0.5.0.mjs [--dry-run] [--sha <commit>] [--worktree <path>]
 *
 *   --dry-run   Print every command but do not execute side-effects.
 *   --sha       Override the historical commit sha (default: 22f660d).
 *   --worktree  Override the worktree path (default: ../v0.5.0-build).
 *
 * Exit codes: 0 = success, 1 = preflight or step failure, 2 = bad args.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, copyFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_HISTORICAL_SHA,
  REQUIRED_RELEASE_ASSETS,
  buildAssetPaths,
  buildBootstrapReleaseBody,
  resolveHistoricalSha,
} from "../../src/release/bootstrapRelease.ts";
import {
  isWellFormedSourceManifest,
  validateReleaseAssets,
} from "../../src/release/releaseAssets.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, "..", "..");

const DEFAULT_SHA = DEFAULT_HISTORICAL_SHA;
const DEFAULT_WORKTREE = resolve(repoRoot, "..", "v0.5.0-build");
const TARGET_VERSION = "0.5.0";

function parseArgs(argv) {
  const args = argv.slice(2);
  let dryRun = false;
  let sha = DEFAULT_SHA;
  let worktree = DEFAULT_WORKTREE;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--dry-run") dryRun = true;
    else if (a === "--sha") sha = args[++i];
    else if (a === "--worktree") worktree = resolve(args[++i]);
    else if (a === "--help" || a === "-h") {
      console.log(
        "Usage: npx tsx scripts/release/bootstrap-v0.5.0.mjs [--dry-run] [--sha <commit>] [--worktree <path>]",
      );
      process.exit(0);
    } else {
      console.error(`[bootstrap-v0.5.0] Unknown argument: ${a}`);
      process.exit(2);
    }
  }
  return { dryRun, sha: resolveHistoricalSha(sha), worktree };
}

function run(cmd, args, opts = {}) {
  const { dryRun, cwd, allowFailure } = opts;
  const display = `${cmd} ${args.join(" ")}`;
  if (dryRun) {
    console.log(`  [dry-run] ${display}${cwd ? `  (cwd: ${cwd})` : ""}`);
    return "";
  }
  console.log(`  $ ${display}${cwd ? `  (cwd: ${cwd})` : ""}`);
  try {
    return execFileSync(cmd, args, {
      cwd: cwd ?? repoRoot,
      stdio: ["ignore", "pipe", "inherit"],
      encoding: "utf8",
      shell: process.platform === "win32",
    });
  } catch (err) {
    if (allowFailure) return "";
    console.error(`[bootstrap-v0.5.0] command failed: ${display}`);
    process.exit(1);
  }
}

function preflight(dryRun) {
  console.log("[bootstrap-v0.5.0] preflight");
  const status = execFileSync("git", ["status", "--porcelain"], { cwd: repoRoot, encoding: "utf8" });
  if (status.trim().length > 0) {
    console.error("[bootstrap-v0.5.0] working tree is not clean — commit or stash before running.");
    if (!dryRun) process.exit(1);
  }
  try {
    execFileSync("gh", ["auth", "status"], { cwd: repoRoot, stdio: "ignore" });
  } catch {
    console.error("[bootstrap-v0.5.0] `gh auth status` failed — run `gh auth login` first.");
    if (!dryRun) process.exit(1);
  }
}

function main() {
  const { dryRun, sha, worktree } = parseArgs(process.argv);
  console.log(`[bootstrap-v0.5.0] target: v${TARGET_VERSION} @ ${sha}`);
  console.log(`[bootstrap-v0.5.0] worktree: ${worktree}`);
  if (dryRun) console.log("[bootstrap-v0.5.0] DRY RUN — no side effects will be performed.");

  preflight(dryRun);

  // 1. Extract the [0.5.0] section from CURRENT main's CHANGELOG.md.
  console.log("[bootstrap-v0.5.0] extracting release notes from current CHANGELOG.md");
  const notesPath = join(repoRoot, ".bootstrap-v0.5.0-notes.md");
  let changelogSection = "";
  if (dryRun) {
    console.log(`  [dry-run] npx tsx scripts/release/extract-release-notes.mjs ${TARGET_VERSION}`);
    changelogSection = "(dry-run placeholder for [0.5.0] section)";
  } else {
    changelogSection = execFileSync(
      process.platform === "win32" ? "npx.cmd" : "npx",
      ["tsx", "scripts/release/extract-release-notes.mjs", TARGET_VERSION],
      {
        cwd: repoRoot,
        encoding: "utf8",
        shell: process.platform === "win32",
      },
    );
  }
  const releaseBody = buildBootstrapReleaseBody(changelogSection);
  if (!dryRun) writeFileSync(notesPath, releaseBody, "utf8");

  // 2. Create the worktree at the historical sha.
  console.log("[bootstrap-v0.5.0] creating worktree");
  if (!dryRun && existsSync(worktree)) {
    console.error(`[bootstrap-v0.5.0] worktree path already exists: ${worktree}`);
    process.exit(1);
  }
  run("git", ["worktree", "add", worktree, sha], { dryRun });

  // 3. Build the historical commit.
  console.log("[bootstrap-v0.5.0] installing + building historical commit");
  run(process.platform === "win32" ? "npm.cmd" : "npm", ["ci"], { dryRun, cwd: worktree });
  run(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "build"], { dryRun, cwd: worktree });

  // 4. Assemble assets inline (read built files from worktree; synthesize
  //    manifest with version 0.5.0; write into <worktree>/release-assets/;
  //    validate via the shared validator). We do this inline rather than
  //    chaining to scripts/release/assemble-assets.mjs because that script
  //    resolves repoRoot from its own __dirname, so invoking it from the
  //    worktree's cwd would still write to the source repo and pull in
  //    the source repo's (wrong, tip-of-branch) main.js.
  console.log("[bootstrap-v0.5.0] assembling release-assets in worktree");
  const stagedDir = join(worktree, "release-assets");
  if (dryRun) {
    console.log(`  [dry-run] mkdir ${stagedDir}; copy main.js, manifest.json (synthesized v${TARGET_VERSION}), styles.css`);
  } else {
    const worktreeManifestPath = join(worktree, "manifest.json");
    const worktreeManifest = JSON.parse(readFileSync(worktreeManifestPath, "utf8"));
    if (!isWellFormedSourceManifest(worktreeManifest)) {
      console.error(
        `[bootstrap-v0.5.0] worktree manifest.json is not well-formed (found version: ${JSON.stringify(
          worktreeManifest?.version ?? null,
        )})`,
      );
      process.exit(1);
    }
    const synthesizedManifest = { ...worktreeManifest, version: TARGET_VERSION };

    rmSync(stagedDir, { recursive: true, force: true });
    mkdirSync(stagedDir, { recursive: true });
    copyFileSync(join(worktree, "main.js"), join(stagedDir, "main.js"));
    copyFileSync(join(worktree, "styles.css"), join(stagedDir, "styles.css"));
    writeFileSync(
      join(stagedDir, "manifest.json"),
      JSON.stringify(synthesizedManifest, null, 2) + "\n",
      "utf8",
    );

    const versionsMap = JSON.parse(readFileSync(join(repoRoot, "versions.json"), "utf8"));
    const result = validateReleaseAssets({
      presentFiles: readdirSync(stagedDir),
      manifest: synthesizedManifest,
      versionsMap,
      targetVersion: TARGET_VERSION,
      bootstrap: true,
    });
    if (!result.ok) {
      console.error("[bootstrap-v0.5.0] release-assets validation failed:");
      for (const e of result.errors) console.error(`  - ${e}`);
      process.exit(1);
    }
    console.log(`  staged: ${readdirSync(stagedDir).sort().join(", ")}`);
  }

  // 5. Tag the historical commit (annotated) using the release notes file.
  console.log("[bootstrap-v0.5.0] tagging historical commit");
  run("git", ["tag", "--annotate", `v${TARGET_VERSION}`, sha, "--file", notesPath], { dryRun });

  // 6. Push the tag.
  console.log("[bootstrap-v0.5.0] pushing tag");
  run("git", ["push", "origin", `v${TARGET_VERSION}`], { dryRun });

  // 7. Create the GitHub Release pointing at the historical sha.
  console.log("[bootstrap-v0.5.0] creating GitHub Release");
  const assetPaths = buildAssetPaths(stagedDir);
  run(
    "gh",
    [
      "release",
      "create",
      `v${TARGET_VERSION}`,
      "--target", sha,
      "--title", `v${TARGET_VERSION}`,
      "--notes-file", notesPath,
      ...assetPaths,
    ],
    { dryRun },
  );

  // 8. Cleanup: worktree + notes scratch file.
  console.log("[bootstrap-v0.5.0] cleanup");
  run("git", ["worktree", "remove", worktree], { dryRun, allowFailure: true });
  if (!dryRun) {
    try { rmSync(notesPath, { force: true }); } catch { /* ignore */ }
  }

  console.log(`[bootstrap-v0.5.0] done — v${TARGET_VERSION} published${dryRun ? " (dry-run)" : ""}.`);
}

if (import.meta.url === `file://${process.argv[1].replace(/\\/g, "/")}` ||
    process.argv[1].endsWith("bootstrap-v0.5.0.mjs")) {
  main();
}
