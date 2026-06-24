import { BUILT_IN_PACK, BUILTIN_PACK_ID } from "./BuiltInPacks";
import type { ImportedPackRecord, Pack, PackPreset } from "./packTypes";

/**
 * Resolved view of a preset as exposed to the rest of the plugin. Carries
 * both the original `preset.id` (pack-local) and the `effectiveId` after
 * applying the FR-013 namespacing rules.
 */
export interface EffectivePreset {
  /**
   * Final id used to look up the preset across the whole plugin (e.g. from
   * the Add Server dropdown). Either `preset.id` (no collision) or
   * `<packId>.<presetId>` (collision per FR-013 a/b).
   */
  effectiveId: string;
  sourcePackId: typeof BUILTIN_PACK_ID | string;
  sourcePackLabel: string;
  preset: PackPreset;
  /** Display label rendered in UI; suffixed when namespaced (FR-013d). */
  displayLabel: string;
  namespaced: boolean;
}

/**
 * Materialize the effective preset registry by combining the synthetic
 * built-in pack with the imported packs in import order (ascending
 * `importedAt`).
 *
 * Namespacing per FR-013:
 *   (a) collision with built-in → imported gets `<packId>.<presetId>`;
 *       built-in keeps its bare id.
 *   (b) two imported packs share an id → BOTH get `<packId>.<presetId>`.
 *   (c) duplicate within one pack → already rejected by validator.
 *   (d) display labels suffixed with " (from <packLabel>)" when namespaced.
 */
export function buildEffectiveRegistry(
  builtins: Pack = BUILT_IN_PACK,
  imported: ImportedPackRecord[] = [],
): EffectivePreset[] {
  const sortedImports = [...imported].sort(
    (a, b) => a.importedAt - b.importedAt,
  );

  // Build the multiset of preset ids across imported packs (NOT including
  // the built-in pack — collisions with built-in are FR-013(a), handled
  // separately so the built-in keeps its bare id.)
  const importedIdCounts = new Map<string, number>();
  for (const rec of sortedImports) {
    for (const p of rec.pack.presets) {
      importedIdCounts.set(p.id, (importedIdCounts.get(p.id) ?? 0) + 1);
    }
  }

  const builtinIds = new Set(builtins.presets.map((p) => p.id));

  const out: EffectivePreset[] = [];

  for (const preset of builtins.presets) {
    out.push({
      effectiveId: preset.id,
      sourcePackId: builtins.id,
      sourcePackLabel: builtins.label,
      preset,
      displayLabel: preset.label,
      namespaced: false,
    });
  }

  for (const rec of sortedImports) {
    for (const preset of rec.pack.presets) {
      const collidesWithBuiltin = builtinIds.has(preset.id);
      const collidesWithOtherImport =
        (importedIdCounts.get(preset.id) ?? 0) >= 2;
      const namespaced = collidesWithBuiltin || collidesWithOtherImport;
      const effectiveId = namespaced
        ? `${rec.pack.id}.${preset.id}`
        : preset.id;
      out.push({
        effectiveId,
        sourcePackId: rec.pack.id,
        sourcePackLabel: rec.pack.label,
        preset,
        displayLabel: namespaced
          ? `${preset.label} (from ${rec.pack.label})`
          : preset.label,
        namespaced,
      });
    }
  }

  return out;
}

export function getEffectivePresetById(
  registry: EffectivePreset[],
  effectiveId: string,
): EffectivePreset | undefined {
  return registry.find((entry) => entry.effectiveId === effectiveId);
}
