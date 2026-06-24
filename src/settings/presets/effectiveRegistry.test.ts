import { describe, expect, test } from "vitest";
import { BUILT_IN_PACK } from "./BuiltInPacks";
import {
  buildEffectiveRegistry,
  getEffectivePresetById,
} from "./effectiveRegistry";
import { M365_GRAPH_PRESET_ID } from "./McpServerPresets";
import type { ImportedPackRecord, Pack, PackPreset } from "./packTypes";

function preset(
  id: string,
  label = id,
): PackPreset {
  return {
    id,
    label,
    server: { name: label, transport: "http", url: "https://example.org/mcp" },
    credentials: { kind: "none" },
  };
}

function pack(id: string, presets: PackPreset[], label = id): Pack {
  return { schemaVersion: 1, id, label, version: "1", presets };
}

function rec(p: Pack, importedAt: number): ImportedPackRecord {
  return { pack: p, importedAt, sourcePath: `${p.id}.json` };
}

describe("buildEffectiveRegistry — FR-013 namespacing", () => {
  test("no imported packs → registry contains exactly the built-ins; none namespaced (FR-014)", () => {
    const registry = buildEffectiveRegistry();
    expect(registry).toHaveLength(BUILT_IN_PACK.presets.length);
    expect(registry.every((e) => !e.namespaced)).toBe(true);
    expect(registry.every((e) => e.sourcePackId === BUILT_IN_PACK.id)).toBe(true);
  });

  test("one imported pack, no collisions → bare ids retained, labels NOT suffixed", () => {
    const p = pack("vendor", [preset("special", "Special")]);
    const registry = buildEffectiveRegistry(BUILT_IN_PACK, [rec(p, 1)]);
    const entry = registry.find((e) => e.sourcePackId === "vendor")!;
    expect(entry.effectiveId).toBe("special");
    expect(entry.displayLabel).toBe("Special");
    expect(entry.namespaced).toBe(false);
  });

  test("imported preset colliding with built-in M365 → imported namespaced; built-in unchanged (FR-013a)", () => {
    const colliding = pack("vendor", [
      preset(M365_GRAPH_PRESET_ID, "Vendor M365"),
    ]);
    const registry = buildEffectiveRegistry(BUILT_IN_PACK, [rec(colliding, 1)]);
    const builtin = registry.find(
      (e) => e.sourcePackId === BUILT_IN_PACK.id && e.preset.id === M365_GRAPH_PRESET_ID,
    )!;
    const imported = registry.find((e) => e.sourcePackId === "vendor")!;
    expect(builtin.effectiveId).toBe(M365_GRAPH_PRESET_ID);
    expect(builtin.namespaced).toBe(false);
    expect(imported.effectiveId).toBe(`vendor.${M365_GRAPH_PRESET_ID}`);
    expect(imported.displayLabel).toBe("Vendor M365 (from vendor)");
    expect(imported.namespaced).toBe(true);
  });

  test("two imported packs sharing a preset id → BOTH namespaced (FR-013b)", () => {
    const a = pack("alpha", [preset("mail", "Alpha Mail")]);
    const b = pack("beta", [preset("mail", "Beta Mail")]);
    const registry = buildEffectiveRegistry(BUILT_IN_PACK, [
      rec(a, 1),
      rec(b, 2),
    ]);
    const alphaMail = registry.find((e) => e.sourcePackId === "alpha")!;
    const betaMail = registry.find((e) => e.sourcePackId === "beta")!;
    expect(alphaMail.effectiveId).toBe("alpha.mail");
    expect(betaMail.effectiveId).toBe("beta.mail");
    expect(alphaMail.namespaced).toBe(true);
    expect(betaMail.namespaced).toBe(true);
  });

  test("built-in dotted id wins over imported derived id; import is suffixed", () => {
    const builtins = pack(BUILT_IN_PACK.id, [
      preset("foo.bar", "Built-in Dotted"),
    ]);
    const imported = pack("foo", [preset("bar", "Imported Bar")]);

    const registry = buildEffectiveRegistry(builtins, [rec(imported, 1)]);

    const builtin = registry.find((e) => e.sourcePackId === BUILT_IN_PACK.id)!;
    const importedEntry = registry.find((e) => e.sourcePackId === "foo")!;
    expect(builtin.effectiveId).toBe("foo.bar");
    expect(builtin.namespaced).toBe(false);
    expect(importedEntry.effectiveId).toBe("foo.bar-2");
    expect(importedEntry.namespaced).toBe(true);
  });

  test("two imported packs sharing a derived effective id suffix the later import", () => {
    const builtins = pack(BUILT_IN_PACK.id, []);
    const first = pack("foo", [preset("bar", "First")], "Foo First");
    const second = pack("foo", [preset("bar", "Second")], "Foo Second");

    const registry = buildEffectiveRegistry(builtins, [
      rec(second, 2),
      rec(first, 1),
    ]);

    const importedEntries = registry.filter((e) => e.sourcePackId === "foo");
    expect(importedEntries.map((e) => e.effectiveId)).toEqual([
      "foo.bar",
      "foo.bar-2",
    ]);
    expect(importedEntries.map((e) => e.preset.label)).toEqual([
      "First",
      "Second",
    ]);
  });

  test("effective IDs are unique so UI Map lookups do not collapse presets", () => {
    const builtins = pack(BUILT_IN_PACK.id, [
      preset("foo.bar", "Built-in Dotted"),
    ]);
    const imported = pack("foo", [preset("bar", "Imported Bar")]);

    const registry = buildEffectiveRegistry(builtins, [rec(imported, 1)]);
    const byEffectiveId = new Map(registry.map((entry) => [entry.effectiveId, entry]));

    expect(byEffectiveId.size).toBe(registry.length);
    expect(byEffectiveId.get("foo.bar")?.sourcePackId).toBe(BUILT_IN_PACK.id);
    expect(byEffectiveId.get("foo.bar-2")?.sourcePackId).toBe("foo");
  });

  test("determinism: same inputs → same output ordering across runs", () => {
    const a = pack("alpha", [preset("x")]);
    const b = pack("beta", [preset("y")]);
    const r1 = buildEffectiveRegistry(BUILT_IN_PACK, [rec(a, 10), rec(b, 5)]);
    const r2 = buildEffectiveRegistry(BUILT_IN_PACK, [rec(a, 10), rec(b, 5)]);
    expect(r1.map((e) => e.effectiveId)).toEqual(r2.map((e) => e.effectiveId));
    // Earlier import comes first.
    const order = r1
      .filter((e) => e.sourcePackId !== BUILT_IN_PACK.id)
      .map((e) => e.sourcePackId);
    expect(order).toEqual(["beta", "alpha"]);
  });

  test("case sensitivity: Mail and mail treated as distinct (Edge Cases)", () => {
    const a = pack("alpha", [preset("Mail")]);
    const b = pack("beta", [preset("mail")]);
    const registry = buildEffectiveRegistry(BUILT_IN_PACK, [
      rec(a, 1),
      rec(b, 2),
    ]);
    const alphaMail = registry.find((e) => e.sourcePackId === "alpha")!;
    const betaMail = registry.find((e) => e.sourcePackId === "beta")!;
    expect(alphaMail.namespaced).toBe(false);
    expect(betaMail.namespaced).toBe(false);
    expect(alphaMail.effectiveId).toBe("Mail");
    expect(betaMail.effectiveId).toBe("mail");
  });

  test("getEffectivePresetById round-trip", () => {
    const a = pack("alpha", [preset("x", "X")]);
    const registry = buildEffectiveRegistry(BUILT_IN_PACK, [rec(a, 1)]);
    expect(getEffectivePresetById(registry, "x")?.sourcePackId).toBe("alpha");
    expect(getEffectivePresetById(registry, "no-such")).toBeUndefined();
  });

  test("imported preset order within a pack is preserved", () => {
    const a = pack("alpha", [preset("first"), preset("second"), preset("third")]);
    const registry = buildEffectiveRegistry(BUILT_IN_PACK, [rec(a, 1)]);
    const ids = registry
      .filter((e) => e.sourcePackId === "alpha")
      .map((e) => e.preset.id);
    expect(ids).toEqual(["first", "second", "third"]);
  });
});
