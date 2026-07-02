/**
 * Pure helpers for the "Imported preset packs" Settings subsection (Phase 3).
 *
 * - `renderModelForPackList` produces row data the DOM layer can dumbly
 *   render. Keeps the DOM-test surface small.
 * - `formatImportConfirmText` / `formatReimportDiffText` produce the
 *   confirm-dialog bodies. Tested without DOM so we can assert the exact
 *   strings the user sees.
 */

import type { ImportPackOutcome } from "./presets/packImporter";
import type { ImportedPackRecord } from "./presets/packTypes";
import type { PackPresetFieldDiff } from "./presets/packDiff";

export interface PackListRow {
  recordId: string;
  packId: string;
  label: string;
  version: string;
  sourcePath: string;
  importedAtIso: string;
  presetCount: number;
}

export interface PackListModel {
  rows: PackListRow[];
}

export function renderModelForPackList(
  records: ImportedPackRecord[],
): PackListModel {
  const rows = records.map((r) => ({
    recordId: r.recordId,
    packId: r.pack.id,
    label: r.pack.label,
    version: r.pack.version,
    sourcePath: r.sourcePath,
    importedAtIso: new Date(r.importedAt).toISOString(),
    presetCount: r.pack.presets.length,
  }));
  return { rows };
}

const LARGE_PACK_NOTE =
  "Note: this is a large pack file. Import is allowed but you may notice a brief delay.";
const MAX_REIMPORT_FIELD_LINES = 8;

/**
 * Spec P1 acceptance (Spec.md:60-61): the import-confirm body must surface
 * label, version, source path, and preset count. Tests assert each appears
 * literally.
 */
export function formatImportConfirmText(
  outcome: Extract<ImportPackOutcome, { kind: "confirmNew" }>,
): string {
  const { pack, sourcePath, sizeWarning } = outcome;
  const presetWord = pack.presets.length === 1 ? "preset" : "presets";
  const lines = [
    `Pack: ${pack.label} (version ${pack.version})`,
    `Source: ${sourcePath}`,
    `Presets: ${pack.presets.length} ${presetWord}`,
  ];
  if (sizeWarning) lines.push("", LARGE_PACK_NOTE);
  return lines.join("\n");
}

export function formatReimportDiffText(
  outcome: Extract<ImportPackOutcome, { kind: "confirmReimport" }>,
): string {
  const { pack, sourcePath, diff, metadataChanged, sizeWarning } = outcome;
  const sections: string[] = [
    `Pack: ${pack.label} (version ${pack.version})`,
    `Source: ${sourcePath}`,
  ];

  if (metadataChanged) {
    const { from, to } = metadataChanged;
    const parts: string[] = [];
    if (from.label !== to.label) parts.push(`label "${from.label}" → "${to.label}"`);
    if (from.version !== to.version) parts.push(`version "${from.version}" → "${to.version}"`);
    if (parts.length > 0) sections.push(`Metadata changed: ${parts.join("; ")}`);
  }

  const isEmpty =
    diff.added.length === 0 &&
    diff.removed.length === 0 &&
    diff.changed.length === 0 &&
    !metadataChanged;

  if (isEmpty) {
    sections.push("", "No changes.");
  } else {
    if (diff.added.length > 0) {
      sections.push("", `Added (${diff.added.length}):`);
      for (const p of diff.added) sections.push(`  + ${p.id} — ${p.label}`);
    }
    if (diff.removed.length > 0) {
      sections.push("", `Removed (${diff.removed.length}):`);
      for (const p of diff.removed) sections.push(`  - ${p.id} — ${p.label}`);
    }
    if (diff.changed.length > 0) {
      sections.push("", `Changed (${diff.changed.length}):`);
      let emittedFieldLines = 0;
      const totalFieldLines = diff.changed.reduce((sum, c) => sum + (c.fields?.length ?? 0), 0);
      for (const c of diff.changed) {
        sections.push(`  ~ ${c.id} — ${c.to.label}`);
        for (const field of c.fields ?? []) {
          if (emittedFieldLines >= MAX_REIMPORT_FIELD_LINES) continue;
          sections.push(`    ${formatFieldDiff(field)}`);
          emittedFieldLines += 1;
        }
      }
      if (totalFieldLines > emittedFieldLines) {
        sections.push(`    and ${totalFieldLines - emittedFieldLines} more changes`);
      }
    }
  }

  if (sizeWarning) sections.push("", LARGE_PACK_NOTE);
  return sections.join("\n");
}

function formatFieldDiff(field: PackPresetFieldDiff): string {
  const label = pointerLabel(field.pointer);
  if (field.secret) {
    switch (field.placeholderState) {
      case "placeholder-to-value":
        return `${label}: placeholder filled in`;
      case "value-to-placeholder":
        return `${label}: now templatized (please supply a value)`;
      case "value-to-value":
        return `${label}: secret value changed`;
      case "unchanged-placeholder":
        return `${label}: still templatized`;
      default:
        return `${label}: secret-bearing value changed`;
    }
  }
  return `${label} changed: ${formatValue(field.before)} → ${formatValue(field.after)}`;
}

function pointerLabel(pointer: string): string {
  const parts = pointer.split("/").slice(3).map(unescapePointerSegment);
  return parts.map((part) => (/^\d+$/.test(part) ? `[${part}]` : part)).reduce((acc, part) => {
    if (part.startsWith("[")) return `${acc}${part}`;
    return acc.length === 0 ? part : `${acc}.${part}`;
  }, "");
}

function formatValue(value: unknown): string {
  if (value === undefined) return "(missing)";
  if (typeof value === "string") return JSON.stringify(value);
  return JSON.stringify(value);
}

function unescapePointerSegment(segment: string): string {
  return segment.replace(/~1/g, "/").replace(/~0/g, "~");
}
