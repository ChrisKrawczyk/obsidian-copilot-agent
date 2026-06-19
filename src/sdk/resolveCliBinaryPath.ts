import type { Plugin } from "obsidian";
import { FileSystemAdapter } from "obsidian";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";

/**
 * Locate the platform-specific Copilot CLI single-executable binary.
 *
 * Why not let the SDK auto-discover?
 *   1. Obsidian.exe has the `ELECTRON_RUN_AS_NODE` fuse disabled, so it
 *      cannot interpret `@github/copilot/index.js`.
 *   2. The plugin ships as a single bundled `main.js` — there is no sibling
 *      `node_modules/@github/copilot-<platform>/` for the SDK to find.
 *
 * Resolution: `<plugin-dir>/copilot.exe` (or `copilot` on POSIX). User
 * copies the binary in once; documented in README.
 */
export function resolveCliBinaryPath(plugin: Plugin): string {
  const platform = os.platform();
  const binaryName = platform === "win32" ? "copilot.exe" : "copilot";

  const pluginDir = getAbsolutePluginDir(plugin);
  if (!pluginDir) {
    throw new Error(
      "[copilot-agent] Could not determine the absolute plugin directory. " +
        "Is this an Obsidian Desktop install?",
    );
  }

  const candidate = path.join(pluginDir, binaryName);
  if (fs.existsSync(candidate)) {
    return candidate;
  }

  throw new Error(
    `[copilot-agent] Copilot CLI binary not found at:\n  ${candidate}\n\n` +
      `Phase 2 install steps:\n` +
      `  1. Copy node_modules/@github/copilot-${platformPkgSuffix(platform)}/${binaryName}\n` +
      `     into the plugin directory above.\n` +
      `  2. Reload Obsidian.\n\n` +
      `See README "Installing the Copilot CLI binary" for details.`,
  );
}

/** Absolute filesystem path to <vault>/.obsidian/plugins/<plugin-id>/. */
export function getAbsolutePluginDir(plugin: Plugin): string | null {
  const adapter = plugin.app.vault.adapter;
  if (!(adapter instanceof FileSystemAdapter)) return null;
  const vaultRoot = adapter.getBasePath();
  const rel = plugin.manifest.dir;
  if (!rel) return null;
  return path.join(vaultRoot, rel);
}

function platformPkgSuffix(platform: NodeJS.Platform): string {
  const arch = process.arch;
  if (platform === "win32") return `win32-${arch}`;
  if (platform === "darwin") return `darwin-${arch}`;
  if (platform === "linux") return `linux-${arch}`;
  return `${platform}-${arch}`;
}
