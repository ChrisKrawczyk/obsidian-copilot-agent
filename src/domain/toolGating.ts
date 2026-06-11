import { V01_RAW_FS_TOOL_NAMES } from "./vaultToolManifest";

/**
 * v0.3 Phase 1 (FR-014/FR-015): when `exposeRawFsTools` is false at
 * startup, drop the six v0.1 raw-filesystem tools from the SDK-bound
 * tools list. Filtering by tool `name` against the shared manifest in
 * `vaultToolManifest.ts` keeps the gated set in lockstep with the
 * inventory rendered in the preamble (which reads the same manifest).
 *
 * This is a pure function in its own module so unit tests can import
 * it without pulling in the Obsidian runtime via `main.ts`. `main.ts`
 * captures `exposeRawFsTools` once at plugin onload (per FR-015's
 * "next session start" rule and C2-A's frozen-snapshot guarantee) and
 * passes it here exactly once.
 */
export function filterRawFsToolsIfGated<T extends { name: string }>(
  tools: readonly T[],
  exposeRawFsTools: boolean,
): T[] {
  if (exposeRawFsTools) return [...tools];
  const gated = new Set<string>(V01_RAW_FS_TOOL_NAMES);
  return tools.filter((t) => !gated.has(t.name));
}
