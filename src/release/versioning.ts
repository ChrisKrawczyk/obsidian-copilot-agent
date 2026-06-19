export interface SemverParts {
  major: number;
  minor: number;
  patch: number;
  preRelease?: string;
  build?: string;
}

const SEMVER_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

export class VersionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VersionError";
  }
}

export function parseSemver(v: string): SemverParts {
  if (typeof v !== "string" || v.length === 0) {
    throw new VersionError("Version is empty");
  }
  if (v.startsWith("v") || v.startsWith("V")) {
    throw new VersionError(
      `Version "${v}" must not have a leading "v"; pass "${v.slice(1)}" instead`,
    );
  }
  const m = SEMVER_RE.exec(v);
  if (!m) {
    throw new VersionError(`Version "${v}" is not a valid semver MAJOR.MINOR.PATCH[-PRERELEASE][+BUILD]`);
  }
  const [, maj, min, pat, pre, build] = m;
  return {
    major: Number(maj),
    minor: Number(min),
    patch: Number(pat),
    preRelease: pre,
    build,
  };
}

function comparePreRelease(a: string | undefined, b: string | undefined): -1 | 0 | 1 {
  if (a === b) return 0;
  if (a === undefined) return 1;
  if (b === undefined) return -1;
  const aIds = a.split(".");
  const bIds = b.split(".");
  const n = Math.max(aIds.length, bIds.length);
  for (let i = 0; i < n; i++) {
    const ax = aIds[i];
    const bx = bIds[i];
    if (ax === undefined) return -1;
    if (bx === undefined) return 1;
    const aNum = /^\d+$/.test(ax);
    const bNum = /^\d+$/.test(bx);
    if (aNum && bNum) {
      const na = Number(ax);
      const nb = Number(bx);
      if (na < nb) return -1;
      if (na > nb) return 1;
    } else if (aNum) {
      return -1;
    } else if (bNum) {
      return 1;
    } else {
      if (ax < bx) return -1;
      if (ax > bx) return 1;
    }
  }
  return 0;
}

export function compareSemver(a: SemverParts | string, b: SemverParts | string): -1 | 0 | 1 {
  const pa = typeof a === "string" ? parseSemver(a) : a;
  const pb = typeof b === "string" ? parseSemver(b) : b;
  if (pa.major !== pb.major) return pa.major < pb.major ? -1 : 1;
  if (pa.minor !== pb.minor) return pa.minor < pb.minor ? -1 : 1;
  if (pa.patch !== pb.patch) return pa.patch < pb.patch ? -1 : 1;
  return comparePreRelease(pa.preRelease, pb.preRelease);
}

export function assertMonotonic(currentVersion: string, targetVersion: string): void {
  const cmp = compareSemver(currentVersion, targetVersion);
  if (cmp === 0) {
    throw new VersionError(
      `Target version "${targetVersion}" is equal to the current version; it must be strictly greater`,
    );
  }
  if (cmp > 0) {
    throw new VersionError(
      `Target version "${targetVersion}" is less than the current version "${currentVersion}"; it must be strictly greater`,
    );
  }
}

export type VersionsMap = Record<string, string>;

export function mergeVersionsMap(
  existing: VersionsMap,
  version: string,
  minAppVersion: string,
): VersionsMap {
  parseSemver(version);
  if (!minAppVersion || typeof minAppVersion !== "string") {
    throw new VersionError(`minAppVersion must be a non-empty string`);
  }
  const out: VersionsMap = {};
  const merged: VersionsMap = { ...existing, [version]: minAppVersion };
  const sortedKeys = Object.keys(merged);
  sortedKeys.sort((a, b) => compareSemver(a, b));
  for (const k of sortedKeys) {
    out[k] = merged[k];
  }
  return out;
}
