import { describe, expect, test } from "vitest";
import {
  formatImportConfirmText,
  formatReimportDiffText,
  renderModelForPackList,
} from "./packSettingsLogic";
import type { ImportedPackRecord, Pack, PackPreset } from "./presets/packTypes";

function pres(id: string, label = id.toUpperCase()): PackPreset {
  return {
    id,
    label,
    server: { name: label, transport: "http", url: `https://example.com/${id}` },
    credentials: { kind: "none" },
  };
}

function pack(id: string, presets: PackPreset[] = [pres("p1")], extras: Partial<Pack> = {}): Pack {
  return {
    schemaVersion: 1,
    id,
    label: extras.label ?? id.toUpperCase(),
    version: extras.version ?? "1",
    presets,
  };
}

function rec(p: Pack, sp = "/src.json", at = 1_700_000_000_000): ImportedPackRecord {
  return { recordId: `r-${p.id}`, pack: p, sourcePath: sp, importedAt: at };
}

describe("renderModelForPackList", () => {
  test("zero records → empty rows", () => {
    expect(renderModelForPackList([]).rows).toEqual([]);
  });

  test("N records → row per record with expected fields", () => {
    const model = renderModelForPackList([
      rec(pack("alpha", [pres("a"), pres("b")]), "/a.json"),
      rec(pack("beta"), "/b.json", 1_700_000_001_000),
    ]);
    expect(model.rows).toHaveLength(2);
    expect(model.rows[0]).toMatchObject({
      packId: "alpha",
      label: "ALPHA",
      version: "1",
      sourcePath: "/a.json",
      presetCount: 2,
    });
    expect(model.rows[0].importedAtIso).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(model.rows[1].packId).toBe("beta");
    expect(model.rows[1].presetCount).toBe(1);
  });
});

describe("formatImportConfirmText", () => {
  test("includes label, version, source path, preset count (singular)", () => {
    const text = formatImportConfirmText({
      kind: "confirmNew",
      pack: pack("vendor"),
      sourcePath: "/v.json",
    });
    expect(text).toContain("VENDOR");
    expect(text).toContain("version 1");
    expect(text).toContain("/v.json");
    expect(text).toMatch(/1 preset(\b|$)/);
  });

  test("plural preset count", () => {
    const text = formatImportConfirmText({
      kind: "confirmNew",
      pack: pack("vendor", [pres("a"), pres("b"), pres("c")]),
      sourcePath: "/v.json",
    });
    expect(text).toContain("3 presets");
  });

  test("appends large-pack notice when sizeWarning set", () => {
    const text = formatImportConfirmText({
      kind: "confirmNew",
      pack: pack("vendor"),
      sourcePath: "/v.json",
      sizeWarning: true,
    });
    expect(text).toMatch(/large pack/i);
  });
});

describe("formatReimportDiffText", () => {
  function emptyDiff() {
    return { added: [], removed: [], changed: [], metadataChanged: null };
  }

  test("empty diff → 'No changes.'", () => {
    const text = formatReimportDiffText({
      kind: "confirmReimport",
      pack: pack("vendor"),
      sourcePath: "/v.json",
      diff: emptyDiff(),
      metadataChanged: null,
    });
    expect(text).toContain("No changes.");
  });

  test("added + changed sections render preset ids", () => {
    const text = formatReimportDiffText({
      kind: "confirmReimport",
      pack: pack("vendor"),
      sourcePath: "/v.json",
      diff: {
        added: [pres("p2", "Preset Two")],
        removed: [],
        changed: [{ id: "p1", from: pres("p1"), to: pres("p1", "Preset One v2") }],
        metadataChanged: null,
      },
      metadataChanged: null,
    });
    expect(text).toMatch(/Added \(1\)/);
    expect(text).toContain("p2");
    expect(text).toMatch(/Changed \(1\)/);
    expect(text).toContain("p1");
  });

  test("metadataChanged renders label/version delta", () => {
    const text = formatReimportDiffText({
      kind: "confirmReimport",
      pack: pack("vendor", [pres("p1")], { label: "New", version: "2" }),
      sourcePath: "/v.json",
      diff: { ...emptyDiff(), metadataChanged: {
        from: { label: "Old", version: "1" },
        to: { label: "New", version: "2" },
      } },
      metadataChanged: { from: { label: "Old", version: "1" }, to: { label: "New", version: "2" } },
    });
    expect(text).toContain("Metadata changed");
    expect(text).toContain('"Old"');
    expect(text).toContain('"New"');
  });

  test("appends large-pack notice when sizeWarning set", () => {
    const text = formatReimportDiffText({
      kind: "confirmReimport",
      pack: pack("vendor"),
      sourcePath: "/v.json",
      diff: emptyDiff(),
      metadataChanged: null,
      sizeWarning: true,
    });
    expect(text).toMatch(/large pack/i);
  });
});
