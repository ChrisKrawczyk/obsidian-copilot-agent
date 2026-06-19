#!/usr/bin/env node
/**
 * Phase 3 release-assembly orchestrator.
 *
 * Usage:
 *   tsx scripts/release/assemble-assets.mjs <version> [--bootstrap] [--dry-run] [--out <dir>]
 *
 * Behavior (per Phase 3 spec lines 425-436):
 *   1. Assert build output `main.js` exists at repo root after `npm run build`.
 *   2. Assert `manifest.json` and `styles.css` exist at repo root.
 *   3. Copy all three to a fresh `release-assets/` directory (overwritten).
 *   4. Validate manifest.json `version` matches the supplied <version>.
 *   5. Validate `versions.json` has an entry for <version>.
 *   6. Enforce the exactly-three-files invariant on the staged dir.
 *
 *   --bootstrap loosens (4) + (5) for the historical v0.5.0 release path
 *   (planning-docs-review C7): if the source manifest version does not
 *   match the supplied target, a synthetic manifest.json is written to
 *   the staged directory with the target version (other fields preserved
 *   from the source manifest). The `versions.json` entry assertion is
 *   relaxed identically. All other invariants still apply.
 *
 *   --dry-run reports the asset list, manifest-match result, and
 *   versions.json result without copying any files; used by the Phase 3
 *   automated success criterion.
 */
import { readFileSync, existsSync, mkdirSync, rmSync, copyFileSync, writeFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  REQUIRED_ASSET_FILES,
  isWellFormedSourceManifest,
  validateReleaseAssets,
} from "../../src/release/releaseAssets.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, "..", "..");

function parseArgs(argv) {
  const args = argv.slice(2);
  let version;
  let bootstrap = false;
  let dryRun = false;
  let outDir = "release-assets";
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--bootstrap") bootstrap = true;
    else if (a === "--dry-run") dryRun = true;
    else if (a === "--out") {
      outDir = args[++i];
    } else if (a === "--help" || a === "-h") {
      console.log(
        "Usage: tsx scripts/release/assemble-assets.mjs <version> [--bootstrap] [--dry-run] [--out <dir>]",
      );
      process.exit(0);
    } else if (!a.startsWith("--") && !version) {
      version = a;
    } else {
      console.error(`[release:assemble] Unknown argument: ${a}`);
      process.exit(2);
    }
  }
  if (!version) {
    console.error("[release:assemble] <version> is required (e.g. 0.6.0)");
    process.exit(2);
  }
  return { version, bootstrap, dryRun, outDir };
}

function readJsonSafe(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function main() {
  const { version, bootstrap, dryRun, outDir } = parseArgs(process.argv);
  const stagedDir = resolve(repoRoot, outDir);

  // Source-tree existence checks.
  const sourcePaths = REQUIRED_ASSET_FILES.map((f) => ({ name: f, path: resolve(repoRoot, f) }));
  const missing = sourcePaths.filter((s) => !existsSync(s.path));
  if (missing.length > 0) {
    console.error(
      `[release:assemble] Missing build output(s): ${missing
        .map((m) => m.name)
        .join(", ")} — did you run \`npm run build\`?`,
    );
    process.exit(1);
  }

  const manifest = readJsonSafe(resolve(repoRoot, "manifest.json"));
  const versionsMap = readJsonSafe(resolve(repoRoot, "versions.json"));

  if (dryRun) {
    // For --dry-run we validate against the source list (no copy step),
    // which makes the result a pure function of the source tree and the
    // requested version. Phase 3 spec line: "reports asset list and
    // version-match result without copying files".
    const result = validateReleaseAssets({
      presentFiles: sourcePaths.map((s) => s.name),
      manifest,
      versionsMap,
      targetVersion: version,
      bootstrap,
    });
    console.log("[release:assemble] DRY RUN");
    console.log(`  target version: ${version}`);
    console.log(`  bootstrap mode: ${bootstrap}`);
    console.log(`  source assets : ${sourcePaths.map((s) => s.name).join(", ")}`);
    console.log(`  manifest ver  : ${manifest?.version ?? "(unreadable)"}`);
    console.log(
      `  versions.json : ${versionsMap && version in versionsMap ? "has entry" : "no entry"}`,
    );
    if (result.ok) {
      console.log("  result        : OK");
      process.exit(0);
    }
    console.error("  result        : FAILED");
    for (const e of result.errors) console.error(`    - ${e}`);
    process.exit(1);
  }

  // Stage the assets.
  rmSync(stagedDir, { recursive: true, force: true });
  mkdirSync(stagedDir, { recursive: true });
  for (const src of sourcePaths) {
    copyFileSync(src.path, join(stagedDir, src.name));
  }

  // In bootstrap mode, if the source manifest's version doesn't match
  // the target, synthesize a manifest with the target version. Other
  // fields are preserved from the source. (Phase 3 spec line 434.)
  // We only synthesize when the source manifest is itself well-formed
  // (object with a non-empty string `version` field) — otherwise we
  // would hide an invalid source manifest behind synthesis. The
  // post-stage validator catches that case for non-bootstrap, but for
  // bootstrap we must check the *source* manifest's shape here before
  // overwriting, or downstream validation would only ever see the
  // synthesized object.
  let stagedManifest = manifest;
  if (bootstrap) {
    if (!isWellFormedSourceManifest(manifest)) {
      console.error(
        "[release:assemble] --bootstrap requires a well-formed source manifest.json with a non-empty `version` field (found: " +
          JSON.stringify(manifest?.version ?? null) +
          ")",
      );
      process.exit(1);
    }
    if (manifest.version !== version) {
      stagedManifest = { ...manifest, version };
      writeFileSync(
        join(stagedDir, "manifest.json"),
        JSON.stringify(stagedManifest, null, 2) + "\n",
        "utf8",
      );
    }
  }

  const stagedFiles = readdirSync(stagedDir);
  const result = validateReleaseAssets({
    presentFiles: stagedFiles,
    manifest: stagedManifest,
    versionsMap,
    targetVersion: version,
    bootstrap,
  });

  if (!result.ok) {
    console.error("[release:assemble] validation failed:");
    for (const e of result.errors) console.error(`  - ${e}`);
    process.exit(1);
  }
  console.log(`[release:assemble] release-assets/ ready for v${version}`);
  console.log(`  files: ${stagedFiles.sort().join(", ")}`);
}

main();
