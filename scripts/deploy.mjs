#!/usr/bin/env node
/**
 * Deploys built plugin artifacts (main.js, manifest.json, styles.css)
 * into the Obsidian vault plugin folder so Obsidian can pick them up
 * on reload.
 *
 * Target resolution order:
 *   1. OBSIDIAN_PLUGIN_DIR environment variable (absolute path to
 *      `<vault>/.obsidian/plugins/obsidian-copilot-agent`).
 *   2. `.deploy-target` file at repo root (single line: the same path).
 *
 * The target is gitignored so each developer can point at their own
 * vault without committing local paths.
 *
 * Usage:
 *   node scripts/deploy.mjs            # copies main.js/manifest/styles
 *   npm run deploy                     # = build + this script
 *   npm run deploy:no-build            # just copy what's already built
 *
 * After deploy, reload the plugin in Obsidian:
 *   - Command palette → "Reload app without saving", OR
 *   - Settings → Community plugins → toggle Copilot Agent off + on.
 *
 * The `copilot.exe` binary is intentionally NOT redeployed every time
 * (it's ~150 MB and changes only when @github/copilot-sdk is bumped).
 * Run with `--with-binary` to force-copy the platform binary as well.
 */
import { existsSync, readFileSync, copyFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(import.meta.url), "..", "..");

function resolveTarget() {
  const fromEnv = process.env.OBSIDIAN_PLUGIN_DIR;
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();
  const targetFile = join(repoRoot, ".deploy-target");
  if (existsSync(targetFile)) {
    const v = readFileSync(targetFile, "utf8").split(/\r?\n/)[0].trim();
    if (v) return v;
  }
  return null;
}

const target = resolveTarget();
if (!target) {
  console.error(
    "deploy: no target configured.\n" +
      "  Set OBSIDIAN_PLUGIN_DIR or create `.deploy-target` at repo root\n" +
      "  with the absolute path to <vault>/.obsidian/plugins/obsidian-copilot-agent",
  );
  process.exit(2);
}

if (!existsSync(target) || !statSync(target).isDirectory()) {
  console.error(`deploy: target does not exist or is not a directory:\n  ${target}`);
  process.exit(2);
}

const withBinary = process.argv.includes("--with-binary");

const files = ["main.js", "manifest.json", "styles.css"];
if (withBinary) {
  if (process.platform === "win32") {
    files.push("node_modules/@github/copilot-win32-x64/copilot.exe");
  } else if (process.platform === "darwin") {
    const arm = "node_modules/@github/copilot-darwin-arm64/copilot";
    const x64 = "node_modules/@github/copilot-darwin-x64/copilot";
    files.push(existsSync(join(repoRoot, arm)) ? arm : x64);
  } else {
    const arm = "node_modules/@github/copilot-linux-arm64/copilot";
    const x64 = "node_modules/@github/copilot-linux-x64/copilot";
    files.push(existsSync(join(repoRoot, arm)) ? arm : x64);
  }
}

let copied = 0;
for (const rel of files) {
  const src = join(repoRoot, rel);
  if (!existsSync(src)) {
    console.error(`deploy: source missing, skipping: ${rel}`);
    continue;
  }
  const basename = rel.split(/[\\/]/).pop();
  const dst = join(target, basename);
  copyFileSync(src, dst);
  const size = statSync(dst).size;
  console.log(`  ✓ ${basename}  (${size.toLocaleString()} bytes)`);
  copied++;
}

console.log(`deploy: copied ${copied} file(s) → ${target}`);
console.log("Reload Obsidian: command palette → 'Reload app without saving'.");
