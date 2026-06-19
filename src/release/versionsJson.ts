import { mergeVersionsMap, type VersionsMap } from "./versioning";

export function parseVersionsJson(raw: string): VersionsMap {
  if (typeof raw !== "string" || raw.trim() === "") {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`versions.json is not valid JSON: ${(err as Error).message}`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`versions.json must be a JSON object mapping "X.Y.Z" -> "minAppVersion"`);
  }
  const out: VersionsMap = {};
  for (const [k, v] of Object.entries(parsed)) {
    if (typeof v !== "string") {
      throw new Error(`versions.json entry "${k}" must map to a string minAppVersion`);
    }
    out[k] = v;
  }
  return out;
}

export function stringifyVersionsJson(map: VersionsMap): string {
  return JSON.stringify(map, null, 2) + "\n";
}

export function addVersionEntry(
  raw: string,
  version: string,
  minAppVersion: string,
): string {
  const existing = parseVersionsJson(raw);
  const merged = mergeVersionsMap(existing, version, minAppVersion);
  return stringifyVersionsJson(merged);
}
