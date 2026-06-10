/**
 * Format `now` as YYYY-MM-DD in the supplied IANA timezone using
 * `en-CA` (which produces ISO-style ordering). Shared by the preamble
 * callback in main.ts and the Settings preview in SettingsTab.ts so
 * both render the same date for a given vault TZ (FR-006, FR-008).
 */
export function formatTodayInTimezone(now: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const y = parts.find((p) => p.type === "year")?.value ?? "0000";
  const m = parts.find((p) => p.type === "month")?.value ?? "01";
  const d = parts.find((p) => p.type === "day")?.value ?? "01";
  return `${y}-${m}-${d}`;
}
