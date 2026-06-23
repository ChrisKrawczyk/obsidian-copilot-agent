/**
 * Extract a value from a nested object/array structure using a dotted path.
 *
 * Supports dotted keys only — no bracket notation, no array indices. This
 * keeps the contract small and predictable for credential-command JSON
 * outputs whose token / expiry fields are object properties (FR-004).
 *
 * Returns `undefined` when any segment is missing or when the input is not
 * an object. Leading and trailing dots are tolerated as empty segments and
 * cause the lookup to fail (returns `undefined`).
 *
 * @param obj - the parsed JSON object (or other value)
 * @param dotPath - dotted key path, e.g. `"accessToken"` or `"result.token"`
 */
export function extractAtPath(obj: unknown, dotPath: string): unknown {
  if (typeof dotPath !== "string" || dotPath.length === 0) return undefined;
  const segments = dotPath.split(".");
  // Reject leading / trailing dots (produces empty segments) — these
  // are almost certainly user typos rather than intentional keys.
  if (segments.some((segment) => segment.length === 0)) return undefined;
  let current: unknown = obj;
  for (const segment of segments) {
    if (current === null || current === undefined) return undefined;
    if (typeof current !== "object") return undefined;
    if (Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}
