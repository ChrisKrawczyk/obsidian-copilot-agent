import { describe, expect, it } from "vitest";
import { filterRawFsToolsIfGated } from "./domain/toolGating";
import { V01_RAW_FS_TOOL_NAMES } from "./domain/vaultToolManifest";

/**
 * v0.3 Phase 1 (FR-014): the raw-FS gating filter is the only pure
 * unit of `main.ts` we exercise here — full plugin construction
 * requires Obsidian runtime APIs and lives behind manual verification.
 *
 * The fixture mimics the structure of the SDK-bound tools array: each
 * tool is an object with a `name` field. We don't model the rest of
 * the SdkTool shape because the filter only inspects `name`.
 */

interface FakeTool {
  name: string;
}

const RAW_FS_TOOLS: FakeTool[] = V01_RAW_FS_TOOL_NAMES.map((name) => ({
  name,
}));

const VAULT_READ_TOOLS: FakeTool[] = [
  { name: "get_active_note" },
  { name: "list_recent_notes" },
  { name: "find_backlinks" },
  { name: "vault_tree" },
  { name: "vault_metadata" },
  { name: "find_tasks" },
];

const VAULT_WRITE_TOOLS: FakeTool[] = [
  { name: "create_note" },
  { name: "edit_note" },
  { name: "open_note" },
  { name: "insert_into_active_note" },
  { name: "create_daily_note" },
  { name: "create_task" },
  { name: "update_task" },
];

const ALL_TOOLS: FakeTool[] = [
  ...RAW_FS_TOOLS,
  ...VAULT_READ_TOOLS,
  ...VAULT_WRITE_TOOLS,
];

describe("filterRawFsToolsIfGated (v0.3 Phase 1)", () => {
  it("when exposeRawFsTools=false (default) drops exactly the six raw-FS tools", () => {
    const filtered = filterRawFsToolsIfGated(ALL_TOOLS, false);
    const names = filtered.map((t) => t.name);
    for (const rawFs of V01_RAW_FS_TOOL_NAMES) {
      expect(names).not.toContain(rawFs);
    }
    expect(filtered).toHaveLength(
      ALL_TOOLS.length - V01_RAW_FS_TOOL_NAMES.length,
    );
  });

  it("when exposeRawFsTools=true keeps all six raw-FS tools and all vault tools", () => {
    const filtered = filterRawFsToolsIfGated(ALL_TOOLS, true);
    const names = filtered.map((t) => t.name);
    for (const rawFs of V01_RAW_FS_TOOL_NAMES) {
      expect(names).toContain(rawFs);
    }
    expect(filtered).toHaveLength(ALL_TOOLS.length);
  });

  it("preserves the original ordering when gating is disabled", () => {
    const filtered = filterRawFsToolsIfGated(ALL_TOOLS, true);
    expect(filtered.map((t) => t.name)).toEqual(ALL_TOOLS.map((t) => t.name));
  });

  it("preserves relative ordering of the surviving vault tools when gating is enabled", () => {
    const filtered = filterRawFsToolsIfGated(ALL_TOOLS, false);
    expect(filtered.map((t) => t.name)).toEqual([
      ...VAULT_READ_TOOLS,
      ...VAULT_WRITE_TOOLS,
    ].map((t) => t.name));
  });

  it("leaves an input that contains no raw-FS tools untouched in either mode", () => {
    const onlyVault = [...VAULT_READ_TOOLS, ...VAULT_WRITE_TOOLS];
    expect(filterRawFsToolsIfGated(onlyVault, false)).toHaveLength(
      onlyVault.length,
    );
    expect(filterRawFsToolsIfGated(onlyVault, true)).toHaveLength(
      onlyVault.length,
    );
  });

  it("returns a copy, not the original array", () => {
    const filtered = filterRawFsToolsIfGated(ALL_TOOLS, true);
    expect(filtered).not.toBe(ALL_TOOLS);
  });

  it("V01_RAW_FS_TOOL_NAMES contains exactly the six v0.1 raw-FS tools (manifest invariant)", () => {
    // The filter's correctness depends on the manifest being the single
    // source of truth. If a future change adds/removes a v0.1 tool, this
    // test forces us to update the gating decision deliberately.
    expect([...V01_RAW_FS_TOOL_NAMES].sort()).toEqual([
      "create_file",
      "delete_file",
      "edit_file",
      "read_file",
      "search_content",
      "view",
    ]);
  });
});
