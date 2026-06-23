import fs from "node:fs";
import path from "node:path";
import { findOnPath } from "../mcp/transport/findOnPath";

/**
 * Phase 5 (FR-018): does `command` resolve to an executable on the system
 * PATH? On Windows the preset preflight specifies bare names like `az`,
 * but the real installed file is typically `az.cmd`. This helper walks
 * `process.env.PATH` exactly like `findOnPath` and additionally probes
 * common Windows executable extensions when the bare name fails.
 *
 * Returns `true` when any candidate exists. Never throws — used by the
 * settings UI to show a non-blocking install hint, so a transient I/O
 * failure should not break the form.
 */
export function isCommandOnPath(command: string): boolean {
  try {
    const env = process.env as Record<string, string>;
    if (findOnPath(command, env)) return true;
    if (path.extname(command)) return false;
    const exts = (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";");
    for (const ext of exts) {
      const candidate = command + ext.toLowerCase();
      if (findOnPath(candidate, env)) return true;
    }
    // POSIX fallback: split on ':' too in case we are not on Windows.
    const pathValue = env.PATH ?? "";
    for (const entry of pathValue.split(":")) {
      if (!entry) continue;
      if (fs.existsSync(path.join(entry, command))) return true;
    }
    return false;
  } catch {
    return false;
  }
}
