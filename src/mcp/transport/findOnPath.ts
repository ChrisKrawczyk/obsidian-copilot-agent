import fs from "node:fs";
import path from "node:path";

/**
 * Resolve a bare command name (e.g. `"az.cmd"`) to an absolute filesystem
 * path by walking the directories in `env.PATH` and returning the first
 * existing match. Returns `null` when no match is found.
 *
 * Lookup is case-insensitive on the PATH variable name (Windows tooling
 * sometimes preserves `Path` rather than `PATH`); the PATH value is
 * split on `path.win32.delimiter` (`;`) so Windows-style PATH strings
 * round-trip correctly regardless of host platform (e.g. when this code
 * is exercised from Linux CI). Each candidate is joined with the
 * platform-default `path.join` so the resulting absolute path uses the
 * correct directory separator for the host filesystem.
 *
 * Extracted from `StdioTransport.ts` so the same resolution logic can be
 * reused by `SpawnCommandRunner` without coupling credential-command
 * execution to the stdio transport module (FR-003 / Phase 3).
 */
export function findOnPath(
  command: string,
  env: Record<string, string>,
): string | null {
  const pathKey = Object.keys(env).find((key) => key.toUpperCase() === "PATH");
  const pathValue = pathKey ? env[pathKey] : "";
  for (const entry of pathValue.split(path.win32.delimiter)) {
    if (!entry) continue;
    const candidate = path.join(entry, command);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}
