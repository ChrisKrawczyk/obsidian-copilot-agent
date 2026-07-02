import { describe, expect, test } from "vitest";
import { BUILT_IN_PACK, BUILTIN_PACK_ID, BUILTIN_PACK_VERSION } from "./BuiltInPacks";
import { M365_GRAPH_PRESET_ID } from "./McpServerPresets";

describe("BuiltInPacks", () => {
  test("BUILT_IN_PACK has reserved id 'builtin' and pinned label", () => {
    expect(BUILT_IN_PACK.id).toBe(BUILTIN_PACK_ID);
    expect(BUILT_IN_PACK.id).toBe("builtin");
    expect(BUILT_IN_PACK.label).toBe("Built-in");
  });

  test("BUILT_IN_PACK version is divorced from manifest.json", () => {
    expect(BUILT_IN_PACK.version).toBe(BUILTIN_PACK_VERSION);
    expect(BUILTIN_PACK_VERSION).toBe("1");
  });

  test("BUILT_IN_PACK validates (eager invariant)", () => {
    // If module load failed validation it would have thrown — reaching this
    // test asserts the invariant holds.
    expect(BUILT_IN_PACK.schemaVersion).toBe(1);
    expect(BUILT_IN_PACK.presets.length).toBeGreaterThan(0);
  });

  test("M365 Graph preset is present", () => {
    const ids = BUILT_IN_PACK.presets.map((p) => p.id);
    expect(ids).toContain(M365_GRAPH_PRESET_ID);
  });
});
