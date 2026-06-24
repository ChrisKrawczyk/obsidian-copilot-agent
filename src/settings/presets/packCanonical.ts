import type { Pack, PackPreset } from "./packTypes";

/**
 * Canonical JSON serializer for packs.
 *
 * - Keys at every object depth sorted lexicographically.
 * - No insignificant whitespace.
 * - Arrays preserve declaration order (preset order is part of a pack).
 *
 * Implemented as a small recursive serializer rather than relying on
 * JSON.stringify replacer tricks.
 */
export function canonicalizePack(pack: Pack): string {
  return canonicalStringify(pack);
}

export function canonicalizePreset(preset: PackPreset): string {
  return canonicalStringify(preset);
}

export function packsCanonicalEqual(a: Pack, b: Pack): boolean {
  return canonicalizePack(a) === canonicalizePack(b);
}

export function canonicalStringify(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return "null";
    return JSON.stringify(value);
  }
  if (typeof value === "boolean") return value ? "true" : "false";
  if (Array.isArray(value)) {
    return "[" + value.map(canonicalStringify).join(",") + "]";
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj)
      .filter((k) => obj[k] !== undefined)
      .sort();
    const parts: string[] = [];
    for (const key of keys) {
      parts.push(JSON.stringify(key) + ":" + canonicalStringify(obj[key]));
    }
    return "{" + parts.join(",") + "}";
  }
  // undefined, function, symbol → drop by emitting null (caller filters).
  return "null";
}
