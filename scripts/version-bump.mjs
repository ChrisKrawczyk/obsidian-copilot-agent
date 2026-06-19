#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  parseSemver,
  assertMonotonic,
  VersionError,
} from "../src/release/versioning.ts";
import { addVersionEntry } from "../src/release/versionsJson.ts";
import { insertStubSection } from "../src/release/changelog.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = join(__dirname, "..");

function parseArgs(argv) {
  const args = argv.slice(2);
  let checkOnly = false;
  let version;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--check") {
      checkOnly = true;
      const next = args[i + 1];
      if (next && !next.startsWith("--")) {
        version = next;
        i++;
      }
    } else if (a === "--help" || a === "-h") {
      console.log("Usage: npm run version-bump -- <version>");
      console.log("       npm run version-bump -- --check <version>");
      process.exit(0);
    } else if (!a.startsWith("--")) {
      version = a;
    } else {
      throw new VersionError(`Unknown argument: ${a}`);
    }
  }
  if (!version) {
    throw new VersionError(
      "Target version is required. Usage: npm run version-bump -- <version>",
    );
  }
  return { version, checkOnly };
}

function todayIsoDate() {
  return new Date().toISOString().slice(0, 10);
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv);
  } catch (err) {
    console.error(`[version-bump] ${err.message}`);
    process.exit(2);
  }

  try {
    parseSemver(args.version);
  } catch (err) {
    console.error(`[version-bump] ${err.message}`);
    process.exit(2);
  }

  const pkgPath = join(repoRoot, "package.json");
  const manifestPath = join(repoRoot, "manifest.json");
  const versionsPath = join(repoRoot, "versions.json");
  const changelogPath = join(repoRoot, "CHANGELOG.md");

  const [pkgRaw, manifestRaw, versionsRaw, changelogRaw] = await Promise.all([
    readFile(pkgPath, "utf8"),
    readFile(manifestPath, "utf8"),
    readFile(versionsPath, "utf8").catch(() => ""),
    readFile(changelogPath, "utf8").catch(() => ""),
  ]);

  const pkg = JSON.parse(pkgRaw);
  const manifest = JSON.parse(manifestRaw);
  const currentVersion = pkg.version;

  if (currentVersion === args.version) {
    if (args.checkOnly) {
      console.log(
        `[version-bump] --check passed: ${args.version} is already the current version (no-op)`,
      );
      process.exit(0);
    }
    console.log(
      `[version-bump] ${args.version} is already the current version; nothing to do (idempotent no-op).`,
    );
    process.exit(0);
  }

  try {
    assertMonotonic(currentVersion, args.version);
  } catch (err) {
    console.error(`[version-bump] ${err.message}`);
    process.exit(2);
  }

  if (manifest.version !== currentVersion && manifest.version !== args.version) {
    console.error(
      `[version-bump] manifest.json version "${manifest.version}" does not match package.json "${currentVersion}" or target "${args.version}"; aborting.`,
    );
    process.exit(2);
  }

  const minAppVersion = manifest.minAppVersion;
  if (!minAppVersion) {
    console.error(`[version-bump] manifest.json is missing minAppVersion; aborting.`);
    process.exit(2);
  }

  if (args.checkOnly) {
    console.log(
      `[version-bump] --check passed: ${currentVersion} -> ${args.version} (minAppVersion=${minAppVersion})`,
    );
    process.exit(0);
  }

  // Buffer all writes in memory first; commit atomically once all transforms succeed.
  const newPkgRaw = pkgRaw.replace(
    /"version"\s*:\s*"[^"]+"/,
    `"version": "${args.version}"`,
  );
  if (newPkgRaw === pkgRaw) {
    console.error(`[version-bump] failed to update package.json version field`);
    process.exit(2);
  }

  const newManifestRaw = manifestRaw.replace(
    /"version"\s*:\s*"[^"]+"/,
    `"version": "${args.version}"`,
  );
  if (newManifestRaw === manifestRaw) {
    console.error(`[version-bump] failed to update manifest.json version field`);
    process.exit(2);
  }

  const newVersionsRaw = addVersionEntry(versionsRaw, args.version, minAppVersion);

  const today = todayIsoDate();
  const stubResult = insertStubSection(changelogRaw, args.version, today);
  const newChangelogRaw = stubResult.content;

  // Commit all writes.
  await Promise.all([
    writeFile(pkgPath, newPkgRaw, "utf8"),
    writeFile(manifestPath, newManifestRaw, "utf8"),
    writeFile(versionsPath, newVersionsRaw, "utf8"),
    writeFile(changelogPath, newChangelogRaw, "utf8"),
  ]);

  console.log(`[version-bump] ${currentVersion} -> ${args.version}`);
  console.log(`[version-bump]   package.json      updated`);
  console.log(`[version-bump]   manifest.json     updated`);
  console.log(`[version-bump]   versions.json     updated (minAppVersion=${minAppVersion})`);
  console.log(
    `[version-bump]   CHANGELOG.md      ${stubResult.inserted ? "stub inserted" : "section already present (idempotent no-op)"}`,
  );
}

main().catch((err) => {
  console.error(`[version-bump] unexpected error: ${err.stack ?? err}`);
  process.exit(1);
});
