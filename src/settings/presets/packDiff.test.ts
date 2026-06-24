import { describe, expect, test } from "vitest";
import { diffPacks } from "./packDiff";
import { SECRET_PLACEHOLDER } from "./packSecretPolicy";
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
      url: "https://example.org/mcp",
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
    expect(result.changed[0].fields.map((field) => field.pointer)).toEqual(["/presets/0/label"]);
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
    expect(result.changed[0].fields[0]).toMatchObject({
      pointer: "/presets/0/label",
      before: "Old",
      after: "New",
    });
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

  test("server command args and env changes use incoming preset index pointers", () => {
    const before = pack([
      preset("a", {
        server: {
          name: "internal-mcp-cli",
          transport: "stdio",
          command: "internal-mcp-cli",
          args: ["one"],
          env: { MCP_LOG_LEVEL: "info" },
        },
      }),
    ]);
    const after = pack([
      preset("a", {
        server: {
          name: "internal-mcp-cli",
          transport: "stdio",
          command: "internal-mcp-cli",
          args: ["two"],
          env: { MCP_LOG_LEVEL: "debug" },
        },
      }),
    ]);
    const result = diffPacks(before, after);
    expect(result.changed[0].fields.map((field) => field.pointer)).toEqual([
      "/presets/0/server/args/0",
      "/presets/0/server/env/MCP_LOG_LEVEL",
    ]);
  });

  test("preflight changes are emitted as field-level diffs", () => {
    const before = pack([preset("a", { preflight: { type: "findOnPath", command: "internal-mcp-cli" } })]);
    const after = pack([
      preset("a", {
        preflight: {
          type: "findOnPath",
          command: "internal-mcp-cli",
          installHint: "Install internal-mcp-cli from example.org.",
        },
      }),
    ]);
    const result = diffPacks(before, after);
    expect(result.changed[0].fields).toEqual([
      {
        pointer: "/presets/0/preflight/installHint",
        before: undefined,
        after: "Install internal-mcp-cli from example.org.",
      },
    ]);
  });

  test("secret placeholders on both sides are suppressed", () => {
    const before = pack([
      preset("a", { credentials: { kind: "static-bearer", token: SECRET_PLACEHOLDER } }),
    ]);
    const after = pack([
      preset("a", {
        label: "A2",
        credentials: { kind: "static-bearer", token: SECRET_PLACEHOLDER },
      }),
    ]);
    const result = diffPacks(before, after);
    expect(result.changed[0].fields.map((field) => field.pointer)).toEqual(["/presets/0/label"]);
  });

  test("secret placeholder transitions are marked without exposing values", () => {
    const before = pack([
      preset("a", { credentials: { kind: "static-bearer", token: SECRET_PLACEHOLDER } }),
    ]);
    const after = pack([
      preset("a", { credentials: { kind: "static-bearer", token: "filled-value" } }),
    ]);
    const result = diffPacks(before, after);
    expect(result.changed[0].fields).toEqual([
      {
        pointer: "/presets/0/credentials/token",
        before: undefined,
        after: undefined,
        secret: true,
        placeholderState: "placeholder-to-value",
      },
    ]);
    const serializedFields = JSON.stringify(result.changed[0].fields);
    expect(serializedFields).not.toContain("filled-value");
  });

  test("secret value to placeholder transitions are marked as templatized", () => {
    const before = pack([
      preset("a", { credentials: { kind: "static-bearer", token: "filled-value" } }),
    ]);
    const after = pack([
      preset("a", { credentials: { kind: "static-bearer", token: SECRET_PLACEHOLDER } }),
    ]);
    const result = diffPacks(before, after);
    expect(result.changed[0].fields[0]).toMatchObject({
      pointer: "/presets/0/credentials/token",
      secret: true,
      placeholderState: "value-to-placeholder",
    });
  });
});
