/**
 * Pure validation logic for the release-assets bundle.
 *
 * The orchestration script (`scripts/release/assemble-assets.mjs`) wires
 * these validators to concrete filesystem probes. Keeping the logic pure
 * (string- and array-only inputs) lets us exhaustively unit-test the
 * exactly-three-files invariant, manifest/version match, and
 * missing-asset detection without touching disk.
 */

export const REQUIRED_ASSET_FILES = ["main.js", "manifest.json", "styles.css"] as const;
export type RequiredAssetFile = (typeof REQUIRED_ASSET_FILES)[number];

export interface ReleaseAssetsValidationResult {
  ok: boolean;
  errors: string[];
}

/**
 * Validate that `presentFiles` (an unordered list of file basenames found
 * in the build output or in a staged `release-assets/` directory) contains
 * exactly the three required release files and no others.
 *
 * Per FR (Phase 3 spec line 451): the gh-release step uploads
 * `release-assets/main.js release-assets/manifest.json release-assets/styles.css`
 * and the spec calls out "exactly-three-files invariant" — extra files
 * are a hard error so we never accidentally publish a stray artifact.
 */
export function validateRequiredAssetSet(presentFiles: string[]): ReleaseAssetsValidationResult {
  const errors: string[] = [];
  const present = new Set(presentFiles);
  for (const required of REQUIRED_ASSET_FILES) {
    if (!present.has(required)) {
      errors.push(`Missing required asset: ${required}`);
    }
  }
  const unexpected = presentFiles.filter(
    (f) => !(REQUIRED_ASSET_FILES as readonly string[]).includes(f),
  );
  if (unexpected.length > 0) {
    errors.push(
      `Unexpected asset(s) in release bundle: ${unexpected.sort().join(", ")} (release must contain exactly main.js, manifest.json, styles.css)`,
    );
  }
  return { ok: errors.length === 0, errors };
}

/**
 * Validate that the version embedded in a parsed `manifest.json` matches
 * the supplied target version. Returns ok=false with a descriptive error
 * when they diverge — matches the "fails with a clear message on mismatch
 * (FR-012 + spec validation)" requirement at Phase 3 spec line 432.
 *
 * `manifest` is the parsed JSON object; pass `null` or a non-object value
 * to represent "manifest unreadable" — handled with its own error.
 */
export function validateManifestVersion(
  manifest: unknown,
  targetVersion: string,
): ReleaseAssetsValidationResult {
  const errors: string[] = [];
  if (manifest === null || typeof manifest !== "object") {
    errors.push("manifest.json is missing or not a JSON object");
    return { ok: false, errors };
  }
  const version = (manifest as { version?: unknown }).version;
  if (typeof version !== "string" || version.length === 0) {
    errors.push("manifest.json is missing a string `version` field");
    return { ok: false, errors };
  }
  if (version !== targetVersion) {
    errors.push(
      `manifest.json version ${version} does not match target release version ${targetVersion}`,
    );
  }
  return { ok: errors.length === 0, errors };
}

/**
 * Validate that the parsed `versions.json` map contains an entry for the
 * supplied target version. Pure twin of the FR-012 plumbing established
 * in Phase 1 (`src/release/versionsJson.ts`).
 */
export function validateVersionsJsonEntry(
  versionsMap: unknown,
  targetVersion: string,
): ReleaseAssetsValidationResult {
  const errors: string[] = [];
  if (versionsMap === null || typeof versionsMap !== "object") {
    errors.push("versions.json is missing or not a JSON object");
    return { ok: false, errors };
  }
  if (!(targetVersion in (versionsMap as Record<string, unknown>))) {
    errors.push(
      `versions.json has no entry for ${targetVersion} (run \`npm run version-bump -- ${targetVersion}\` first)`,
    );
  }
  return { ok: errors.length === 0, errors };
}

/**
 * Compose the three primary validations into one bundle.
 *
 * `presentFiles` is the list of basenames staged in the release directory;
 * `manifest` is the parsed manifest object (or null if unreadable);
 * `versionsMap` is the parsed versions.json object.
 *
 * `bootstrap` mode (Phase 3 spec line 434 / planning-docs-review C7)
 * relaxes the manifest-version assertion (because the tip-of-main
 * manifest will not match a historical bootstrap target) and the
 * versions.json entry assertion (the historical entry is permitted to
 * be absent). All other invariants — exactly-three-files, manifest
 * shape if present — still apply.
 */
export function validateReleaseAssets(input: {
  presentFiles: string[];
  manifest: unknown;
  versionsMap: unknown;
  targetVersion: string;
  bootstrap?: boolean;
}): ReleaseAssetsValidationResult {
  const errors: string[] = [];
  errors.push(...validateRequiredAssetSet(input.presentFiles).errors);
  if (input.bootstrap) {
    if (input.manifest !== null && typeof input.manifest === "object") {
      const v = (input.manifest as { version?: unknown }).version;
      if (typeof v !== "string" || v.length === 0) {
        errors.push("manifest.json is missing a string `version` field");
      }
    } else {
      errors.push("manifest.json is missing or not a JSON object");
    }
  } else {
    errors.push(...validateManifestVersion(input.manifest, input.targetVersion).errors);
    errors.push(...validateVersionsJsonEntry(input.versionsMap, input.targetVersion).errors);
  }
  return { ok: errors.length === 0, errors };
}
