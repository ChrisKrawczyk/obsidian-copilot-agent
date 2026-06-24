import { describe, expect, test } from "vitest";
import { diffPacks } from "./packDiff";
import type { Pack, PackPreset } from "./packTypes";

function preset(
  id: string,
  overrides: Partial<PackPreset> = {},
): PackPreset {
  return {
    id,
    label: overrides.label ?? id,
    server: overrides.server ?? {
      name: id,
      transport: "http",
      url: "https://example.com/mcp",
    },
    credentials: overrides.credentials ?? { kind: "none" },
    ...(overrides.description ? { description: overrides.description } : {}),
    ...(overrides.preflight ? { preflight: overrides.preflight } : {}),
  };
}

function pack(presets: PackPreset[], meta: { label?: string; version?: string } = {}): Pack {
  return {
    schemaVersion: 1,
    id: "p",
    label: meta.label ?? "P",
    version: meta.version ?? "1",
    presets,
  };
}

describe("diffPacks", () => {
  test("identical canonical → empty diff (SC-007)", () => {
    const a = pack([preset("a"), preset("b")]);
    const result = diffPacks(a, a);
    expect(result.added).toEqual([]);
    expect(result.removed).toEqual([]);
    expect(result.changed).toEqual([]);
    expect(result.metadataChanged).toBeNull();
  });

  test("changed canonical → non-empty diff (SC-007)", () => {
    const before = pack([preset("a")]);
    const after = pack([preset("a", { label: "A!" })]);
    const result = diffPacks(before, after);
    expect(result.changed).toHaveLength(1);
    expect(result.changed[0].id).toBe("a");
  });

  test("added/removed/changed detection", () => {
    const before = pack([preset("a"), preset("b")]);
    const after = pack([preset("a", { label: "A2" }), preset("c")]);
    const result = diffPacks(before, after);
    expect(result.added.map((p) => p.id)).toEqual(["c"]);
    expect(result.removed.map((p) => p.id)).toEqual(["b"]);
    expect(result.changed.map((p) => p.id)).toEqual(["a"]);
  });

  test("label change for a preset flagged as 'changed' for that id", () => {
    const before = pack([preset("a", { label: "Old" })]);
    const after = pack([preset("a", { label: "New" })]);
    const result = diffPacks(before, after);
    expect(result.changed).toHaveLength(1);
    expect(result.changed[0].from.label).toBe("Old");
    expect(result.changed[0].to.label).toBe("New");
  });

  test("reorder-only yields empty deltas (SC-008)", () => {
    const before = pack([preset("a"), preset("b")]);
    const after = pack([preset("b"), preset("a")]);
    const result = diffPacks(before, after);
    expect(result.added).toEqual([]);
    expect(result.removed).toEqual([]);
    expect(result.changed).toEqual([]);
  });

  test("metadata-only change populates metadataChanged", () => {
    const before = pack([preset("a")], { label: "Old", version: "1" });
    const after = pack([preset("a")], { label: "New", version: "2" });
    const result = diffPacks(before, after);
    expect(result.added).toEqual([]);
    expect(result.removed).toEqual([]);
    expect(result.changed).toEqual([]);
    expect(result.metadataChanged).toEqual({
      from: { label: "Old", version: "1" },
      to: { label: "New", version: "2" },
    });
  });

  test("preset id match is case-sensitive (Edge Cases)", () => {
    const before = pack([preset("Mail")]);
    const after = pack([preset("mail")]);
    const result = diffPacks(before, after);
    expect(result.added.map((p) => p.id)).toEqual(["mail"]);
    expect(result.removed.map((p) => p.id)).toEqual(["Mail"]);
    expect(result.changed).toEqual([]);
  });

  test("only label/version differences populate metadataChanged", () => {
    const before = pack([preset("a")], { label: "L", version: "1" });
    // Top-level description change does NOT surface (FR-021 scope).
    const after: Pack = { ...pack([preset("a")], { label: "L", version: "1" }), description: "added" };
    const result = diffPacks(before, after);
    expect(result.metadataChanged).toBeNull();
  });
});
