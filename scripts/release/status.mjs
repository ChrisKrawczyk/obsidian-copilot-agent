#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import { deriveReleaseStatus } from "../../src/release/releaseStatus.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = join(__dirname, "..", "..");

function parseArgs(argv) {
  const args = argv.slice(2);
  let version;
  let json = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--version") {
      version = args[i + 1];
      i++;
    } else if (a === "--json") {
      json = true;
    } else if (a === "--help" || a === "-h") {
      console.log("Usage: npm run release:status -- --version <version> [--json]");
      process.exit(0);
    }
  }
  if (!version) {
    console.error("[release:status] --version <version> is required");
    process.exit(2);
  }
  return { version, json };
}

function tryExec(cmd, args) {
  try {
    return execFileSync(cmd, args, {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
    }).trim();
  } catch {
    return null;
  }
}

async function probe(version) {
  const tag = `v${version}`;

  const branch = tryExec("git", ["rev-parse", "--abbrev-ref", "HEAD"]) ?? "unknown";
  const statusOut = tryExec("git", ["status", "--porcelain"]) ?? "";
  const treeDirty = statusOut.length > 0;

  const pkgRaw = await readFile(join(repoRoot, "package.json"), "utf8").catch(() => "");
  const manifestRaw = await readFile(join(repoRoot, "manifest.json"), "utf8").catch(() => "");
  const versionsRaw = await readFile(join(repoRoot, "versions.json"), "utf8").catch(() => "");
  const pkg = pkgRaw ? JSON.parse(pkgRaw) : {};
  const manifest = manifestRaw ? JSON.parse(manifestRaw) : {};
  let versions = {};
  try {
    versions = versionsRaw ? JSON.parse(versionsRaw) : {};
  } catch {
    versions = {};
  }
  const filesAtTargetVersion =
    pkg.version === version &&
    manifest.version === version &&
    Object.prototype.hasOwnProperty.call(versions, version);

  const bumpCommit = tryExec("git", [
    "log",
    "--format=%H",
    "-n",
    "1",
    `--grep=^chore(release): ${tag}$`,
  ]);
  const bumpCommitPresent = !!bumpCommit;

  const localTag = tryExec("git", ["tag", "--list", tag]);
  const localTagPresent = localTag === tag;

  const remoteTagRaw = tryExec("git", ["ls-remote", "--tags", "origin", tag]);
  const remoteTagPresent = !!remoteTagRaw && remoteTagRaw.includes(tag);

  let workflowRun;
  const ghOut = tryExec("gh", [
    "run",
    "list",
    "--workflow=release.yml",
    "--limit",
    "5",
    "--json",
    "headBranch,headSha,status,conclusion,displayTitle",
  ]);
  if (ghOut) {
    try {
      const runs = JSON.parse(ghOut);
      const match = runs.find(
        (r) =>
          (typeof r.displayTitle === "string" && r.displayTitle.includes(tag)) ||
          r.headBranch === tag,
      );
      if (match) {
        workflowRun = { status: match.status, conclusion: match.conclusion ?? null };
      }
    } catch {
      // ignore parse errors; treat as no run
    }
  }

  const releaseOut = tryExec("gh", ["release", "view", tag, "--json", "name,isDraft"]);
  let releasePublished = false;
  if (releaseOut) {
    try {
      const rel = JSON.parse(releaseOut);
      releasePublished = !!rel.name && !rel.isDraft;
    } catch {
      releasePublished = false;
    }
  }

  return {
    branch,
    treeDirty,
    filesAtTargetVersion,
    bumpCommitPresent,
    localTagPresent,
    remoteTagPresent,
    workflowRun,
    releasePublished,
  };
}

async function main() {
  const args = parseArgs(process.argv);
  const p = await probe(args.version);
  const status = deriveReleaseStatus(args.version, p);
  if (args.json) {
    console.log(JSON.stringify(status));
  } else {
    console.log(`Release status for v${status.version}`);
    console.log(`  step:        ${status.step}`);
    console.log(`  next_action: ${status.next_action}`);
    if (status.blockers.length > 0) {
      console.log(`  blockers:`);
      for (const b of status.blockers) console.log(`    - ${b}`);
    }
    console.log(`  branch:      ${p.branch}${p.treeDirty ? " (dirty)" : ""}`);
  }
}

main().catch((err) => {
  console.error(`[release:status] unexpected error: ${err.stack ?? err}`);
  process.exit(1);
});
