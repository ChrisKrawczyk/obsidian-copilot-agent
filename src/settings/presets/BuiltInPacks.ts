import { BUILT_IN_PRESETS } from "./McpServerPresets";
import { validatePack } from "./packValidator";
import type { Pack, PackPreset } from "./packTypes";

/**
 * Synthetic in-memory pack id for the built-in presets shipped with the
 * plugin. Reserved by `packValidator` — imported packs cannot use this id.
 */
export const BUILTIN_PACK_ID = "builtin";

/**
 * Built-in pack metadata version. Intentionally NOT tied to
 * `manifest.json` — bumping the plugin should not cause spurious
 * `metadataChanged` diffs on every release. Bump this constant only when
 * the built-in pack contents change meaningfully.
 */
export const BUILTIN_PACK_VERSION = "1";

function buildBuiltInPack(): Pack {
  const presets: PackPreset[] = BUILT_IN_PRESETS.map((preset) => {
    const built = preset.build();
    const out: PackPreset = {
      id: preset.id,
      label: preset.label,
      ...(preset.description ? { description: preset.description } : {}),
      server: built.server,
      credentials: built.credentials,
      ...(built.preflight ? { preflight: built.preflight } : {}),
    };
    return out;
  });
  return {
    schemaVersion: 1,
    id: BUILTIN_PACK_ID,
    label: "Built-in",
    version: BUILTIN_PACK_VERSION,
    presets,
  };
}

/**
 * Build-and-validate the built-in pack. Throws at module load if the
 * built-in fails validation — later phases rely on the invariant that
 * every preset everywhere conforms to `PackPreset`.
 *
 * NOTE: the validator rejects pack id "builtin"; this helper bypasses
 * that rule via `bypassReservedIdCheck = true` and is the only legitimate
 * caller allowed to produce a pack with the reserved id.
 */
export function getBuiltInPack(): Pack {
  const candidate = buildBuiltInPack();
  // Validate everything EXCEPT the reserved-id rule, which is the whole
  // point of the synthetic built-in pack.
  const validateInput: unknown = { ...candidate, id: "__builtin_validate__" };
  const result = validatePack(validateInput);
  if (!result.ok) {
    throw new Error(
      `Built-in preset pack failed validation at ${result.error?.pointer}: ${result.error?.message}`,
    );
  }
  return candidate;
}

// Eager invariant check at module load.
const BUILT_IN_PACK: Pack = getBuiltInPack();
Object.freeze(BUILT_IN_PACK);
export { BUILT_IN_PACK };
