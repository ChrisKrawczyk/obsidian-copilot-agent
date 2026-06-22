/**
 * Parse an expiry value into a numeric epoch in **milliseconds**, or `null`
 * when the value is missing / unparseable.
 *
 * Accepts:
 * - ISO-8601 strings (e.g. `"2026-01-15T18:30:00Z"`)
 * - Unix epoch numbers (seconds or milliseconds detected by magnitude:
 *   values < 1e12 are treated as seconds, values >= 1e12 as milliseconds)
 * - Azure CLI's `"YYYY-MM-DD HH:mm:ss.SSSSSS"` form (no timezone designator
 *   — Azure CLI emits this in the caller's local timezone, which we
 *   treat as the local timezone here; over-precision microseconds are
 *   truncated to millisecond resolution which is fine for refresh
 *   scheduling)
 *
 * Returns `null` for `undefined`, `null`, empty strings, NaN, non-finite
 * numbers, and unrecognized string formats.
 */
export function parseExpiry(value: unknown): number | null {
  if (value === undefined || value === null) return null;

  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    // < 1e12 -> seconds; >= 1e12 -> milliseconds. 1e12 ms = year ~33658,
    // 1e12 s would be year ~33658, so the boundary is safely unambiguous
    // for any realistic credential expiry timestamp.
    return value >= 1e12 ? Math.floor(value) : Math.floor(value * 1000);
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length === 0) return null;

    // Try native Date parsing first — handles ISO-8601 with timezone.
    const direct = Date.parse(trimmed);
    if (Number.isFinite(direct)) return direct;

    // Azure CLI format: `YYYY-MM-DD HH:mm:ss.SSSSSS` (space separator,
    // no timezone). Convert to ISO-ish `YYYY-MM-DDTHH:mm:ss.SSS` (truncating
    // microseconds beyond millisecond precision) and re-parse. Treated as
    // local time per Azure CLI's emission convention.
    const azureMatch =
      /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?$/.exec(
        trimmed,
      );
    if (azureMatch) {
      const [, y, mo, d, h, mi, s, frac] = azureMatch;
      const ms = frac ? frac.padEnd(3, "0").slice(0, 3) : "000";
      const iso = `${y}-${mo}-${d}T${h}:${mi}:${s}.${ms}`;
      const parsed = Date.parse(iso);
      if (Number.isFinite(parsed)) return parsed;
    }

    return null;
  }

  return null;
}
