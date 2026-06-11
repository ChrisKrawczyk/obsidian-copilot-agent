import { describe, expect, it } from "vitest";
import {
  assemblePreamble,
  AUTHORING_CONVENTIONS_BLOCK,
  MAX_DEFAULT_PREAMBLE_BYTES,
  PREAMBLE_PLACEHOLDERS,
  VAULT_TOOL_INVENTORY_BLOCK,
  VAULT_TOOL_INVENTORY_BLOCK_GATED,
  type PreambleInput,
} from "./PreambleAssembler";
import {
  ALL_VAULT_TOOL_ENTRIES,
  READ_NOTE_TOOL_NAMES,
  V01_RAW_FS_TOOL_NAMES,
  WRITE_NOTE_TOOL_NAMES,
} from "./vaultToolManifest";

const baseInput: PreambleInput = {
  mode: "default",
  vaultRootAbsPath: "C:\\Users\\me\\Notes",
  timezone: "America/Los_Angeles",
  todayInTimezone: "2026-06-09",
};

describe("assemblePreamble", () => {
  it("returns empty string when mode = none", () => {
    expect(assemblePreamble({ ...baseInput, mode: "none" })).toBe("");
  });

  it("default mode includes vault root, timezone, today, tool inventory, and authoring conventions", () => {
    const out = assemblePreamble(baseInput);
    expect(out).toContain("C:\\Users\\me\\Notes");
    expect(out).toContain("America/Los_Angeles");
    expect(out).toContain("2026-06-09");
    expect(out).toContain(VAULT_TOOL_INVENTORY_BLOCK);
    expect(out).toContain(AUTHORING_CONVENTIONS_BLOCK);
  });

  it("default mode does NOT enumerate vault folders or files (FR-007)", () => {
    const out = assemblePreamble(baseInput);
    // The default preamble is constant per vault — assert the absence of
    // typical enumeration markers we explicitly opted not to include.
    expect(out).not.toMatch(/^- [^\n]+\.md$/m);
    expect(out).not.toContain("Recent notes:");
    expect(out).not.toContain("Folders:");
  });

  it("default preamble is deterministic — identical inputs produce byte-identical output (FR-021)", () => {
    const a = assemblePreamble(baseInput);
    const b = assemblePreamble({ ...baseInput });
    expect(a).toBe(b);
    expect(a.length).toBe(b.length);
  });

  it("default preamble stays under the 4 KB size bound regardless of vault contents (SC-005)", () => {
    // The preamble is constant per vault root — no per-file content — so
    // "regardless of vault size" means it doesn't grow with file count.
    // Vault root path is filesystem-bounded (Windows MAX_PATH ~260).
    const realisticLongPath = "C:\\" + "Some Long Folder Name\\".repeat(11);
    const inflated = assemblePreamble({
      ...baseInput,
      vaultRootAbsPath: realisticLongPath,
    });
    expect(Buffer.byteLength(inflated, "utf8")).toBeLessThan(
      MAX_DEFAULT_PREAMBLE_BYTES,
    );

    // The base default with a normal path should be comfortably small.
    const base = assemblePreamble(baseInput);
    expect(Buffer.byteLength(base, "utf8")).toBeLessThan(
      MAX_DEFAULT_PREAMBLE_BYTES,
    );
  });

  it("tool-inventory block names every tool in the manifest (lockstep)", () => {
    for (const entry of ALL_VAULT_TOOL_ENTRIES) {
      expect(VAULT_TOOL_INVENTORY_BLOCK).toContain(`\`${entry.name}\``);
    }
    // Defence in depth: also check the names are unique.
    const all = [
      ...READ_NOTE_TOOL_NAMES,
      ...WRITE_NOTE_TOOL_NAMES,
      "view",
      "read_file",
      "search_content",
      "create_file",
      "edit_file",
      "delete_file",
    ];
    expect(new Set(all).size).toBe(all.length);
  });

  it("read-only entries are tagged R/O in the inventory; mutating entries are not", () => {
    expect(VAULT_TOOL_INVENTORY_BLOCK).toMatch(/`vault_tree`\s+_\(R\/O\)_/);
    expect(VAULT_TOOL_INVENTORY_BLOCK).toMatch(/`get_active_note`\s+_\(R\/O\)_/);
    // create_note is mutating — must NOT have the R/O tag right after it.
    expect(VAULT_TOOL_INVENTORY_BLOCK).not.toMatch(
      /`create_note`\s+_\(R\/O\)_/,
    );
  });

  it("custom mode emits the body verbatim when no placeholders are present", () => {
    const out = assemblePreamble({
      ...baseInput,
      mode: "custom",
      customBody: "This is my custom prompt.",
    });
    expect(out).toBe("This is my custom prompt.");
  });

  it("custom mode substitutes only the placeholders that appear in the body", () => {
    const out = assemblePreamble({
      ...baseInput,
      mode: "custom",
      customBody:
        `Root is ${PREAMBLE_PLACEHOLDERS.VAULT_ROOT}, today is ${PREAMBLE_PLACEHOLDERS.VAULT_TODAY}.`,
    });
    expect(out).toBe("Root is C:\\Users\\me\\Notes, today is 2026-06-09.");
    // Tool-inventory block was NOT requested by the template, so it must NOT leak in.
    expect(out).not.toContain("Vault tools");
  });

  it("custom mode supports the timezone, tool-inventory, and authoring-conventions placeholders", () => {
    const out = assemblePreamble({
      ...baseInput,
      mode: "custom",
      customBody: [
        `TZ: ${PREAMBLE_PLACEHOLDERS.VAULT_TIMEZONE}`,
        PREAMBLE_PLACEHOLDERS.VAULT_TOOL_INVENTORY,
        PREAMBLE_PLACEHOLDERS.AUTHORING_CONVENTIONS,
      ].join("\n---\n"),
    });
    expect(out).toContain("TZ: America/Los_Angeles");
    expect(out).toContain(VAULT_TOOL_INVENTORY_BLOCK);
    expect(out).toContain(AUTHORING_CONVENTIONS_BLOCK);
  });

  it("custom mode with empty body returns empty string", () => {
    expect(
      assemblePreamble({ ...baseInput, mode: "custom", customBody: "" }),
    ).toBe("");
  });

  it("default mode treats timezone and today as distinct fields (no swap)", () => {
    const out = assemblePreamble({
      ...baseInput,
      timezone: "Asia/Tokyo",
      todayInTimezone: "2026-06-10",
    });
    expect(out).toContain("Timezone: Asia/Tokyo");
    expect(out).toContain("Today: 2026-06-10");
  });

  // ---------------------------------------------------------------
  // v0.3 Phase 1 (FR-014/FR-015): gated raw-FS tools in preamble
  // ---------------------------------------------------------------

  it("excludeRawFs=false (default) emits the FULL inventory naming all v0.1 raw-FS tools", () => {
    const out = assemblePreamble(baseInput);
    for (const rawFs of V01_RAW_FS_TOOL_NAMES) {
      expect(out).toContain(`\`${rawFs}\``);
    }
  });

  it("excludeRawFs=true omits all six v0.1 raw-FS tools from the inventory", () => {
    const out = assemblePreamble({ ...baseInput, excludeRawFs: true });
    for (const rawFs of V01_RAW_FS_TOOL_NAMES) {
      expect(out).not.toContain(`\`${rawFs}\``);
    }
  });

  it("excludeRawFs=true preserves all v0.2 vault tool entries in the inventory", () => {
    const out = assemblePreamble({ ...baseInput, excludeRawFs: true });
    for (const name of [...READ_NOTE_TOOL_NAMES, ...WRITE_NOTE_TOOL_NAMES]) {
      expect(out).toContain(`\`${name}\``);
    }
    // open_note is in WRITE_NOTE_TOOL_ENTRIES but absent from
    // WRITE_NOTE_TOOL_NAMES (read-equivalent). Verify it is still
    // mentioned in the gated inventory since it isn't a raw-FS tool.
    expect(out).toContain("`open_note`");
  });

  it("excludeRawFs=true uses the gated inventory block; default uses the full block", () => {
    const gated = assemblePreamble({ ...baseInput, excludeRawFs: true });
    expect(gated).toContain(VAULT_TOOL_INVENTORY_BLOCK_GATED);
    const full = assemblePreamble(baseInput);
    expect(full).toContain(VAULT_TOOL_INVENTORY_BLOCK);
  });

  it("excludeRawFs=true makes the inventory shorter than the un-gated variant by exactly six entries", () => {
    const fullLines = VAULT_TOOL_INVENTORY_BLOCK.split("\n").length;
    const gatedLines = VAULT_TOOL_INVENTORY_BLOCK_GATED.split("\n").length;
    expect(fullLines - gatedLines).toBe(V01_RAW_FS_TOOL_NAMES.length);
  });

  it("excludeRawFs is honored under custom mode via the VAULT_TOOL_INVENTORY placeholder", () => {
    const out = assemblePreamble({
      ...baseInput,
      mode: "custom",
      excludeRawFs: true,
      customBody: PREAMBLE_PLACEHOLDERS.VAULT_TOOL_INVENTORY,
    });
    for (const rawFs of V01_RAW_FS_TOOL_NAMES) {
      expect(out).not.toContain(`\`${rawFs}\``);
    }
    // And the v0.2 vault tools survive the substitution.
    expect(out).toContain("`vault_tree`");
  });

  it("VAULT_TOOL_INVENTORY_BLOCK_GATED tags read-only entries the same way as the full variant", () => {
    expect(VAULT_TOOL_INVENTORY_BLOCK_GATED).toMatch(
      /`vault_tree`\s+_\(R\/O\)_/,
    );
    expect(VAULT_TOOL_INVENTORY_BLOCK_GATED).not.toMatch(
      /`create_note`\s+_\(R\/O\)_/,
    );
  });

  it("default-mode preamble with excludeRawFs=true stays within the 8 KB size budget (SC-005 unchanged)", () => {
    const out = assemblePreamble({ ...baseInput, excludeRawFs: true });
    expect(Buffer.byteLength(out, "utf8")).toBeLessThan(
      MAX_DEFAULT_PREAMBLE_BYTES,
    );
  });

  it("the manifest still contains every v0.1 raw-FS tool (back-compat for historical message rendering)", () => {
    // Even when gated out of the preamble, ALL_VAULT_TOOL_ENTRIES must
    // continue to name the v0.1 tools so persisted message history
    // referencing them still renders tool names correctly (FR-016).
    const allNames = ALL_VAULT_TOOL_ENTRIES.map((e) => e.name);
    for (const rawFs of V01_RAW_FS_TOOL_NAMES) {
      expect(allNames).toContain(rawFs);
    }
  });
});
