/**
 * Pure helpers for the v0.5.0 bootstrap script.
 * Kept separate from `scripts/release/bootstrap-v0.5.0.mjs` so the
 * orchestration script can stay side-effectful while the helpers
 * remain unit-testable.
 */

export const DEFAULT_HISTORICAL_SHA = "22f660d";

export const REQUIRED_RELEASE_ASSETS = [
  "main.js",
  "manifest.json",
  "styles.css",
] as const;

const HISTORICAL_NOTICE =
  "\n\n---\n\n" +
  "_v0.5.0 is published for historical completeness so the tag resolves " +
  "to a GitHub Release. It predates the in-plugin binary fetcher and " +
  "BRAT install path shipped in v0.6.0; first-time BRAT users should " +
  "pin v0.6.0 or later._\n";

export function buildBootstrapReleaseBody(changelogSection: string): string {
  if (typeof changelogSection !== "string") {
    throw new TypeError("buildBootstrapReleaseBody: changelogSection must be a string");
  }
  const trimmed = changelogSection.replace(/[\s\r\n]+$/, "");
  return trimmed + HISTORICAL_NOTICE;
}

export function resolveHistoricalSha(arg: string | undefined | null): string {
  if (arg === undefined || arg === null || arg === "") return DEFAULT_HISTORICAL_SHA;
  if (typeof arg !== "string") {
    throw new TypeError("resolveHistoricalSha: sha must be a string");
  }
  if (!/^[0-9a-f]{7,40}$/i.test(arg)) {
    throw new Error(`resolveHistoricalSha: invalid sha "${arg}"`);
  }
  return arg.toLowerCase();
}

export function buildAssetPaths(stagedDir: string): string[] {
  const sep = stagedDir.includes("\\") && !stagedDir.includes("/") ? "\\" : "/";
  const trimmed = stagedDir.replace(/[\\/]+$/, "");
  return REQUIRED_RELEASE_ASSETS.map((f) => `${trimmed}${sep}${f}`);
}
