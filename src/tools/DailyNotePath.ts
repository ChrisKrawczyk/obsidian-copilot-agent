/**
 * Pure helper that resolves today's daily-note path from
 * `ObsidianApi.getDailyNotesConfig()` plus a deterministic clock.
 *
 * Used by **both** `main.ts`'s `safety.extractVaultPath` (gate side)
 * AND `WriteNoteTools.ts`'s `create_daily_note` / `create_task`
 * handlers (write side) so the gate matches what we actually write —
 * see ImplementationPlan.md Phase 4 line ~241 ("gate path === actual
 * write path").
 *
 * No filesystem access. The caller is responsible for creating the
 * folder (if the configured `folder` doesn't exist yet) before the
 * write — `vault.create` will create intermediate folders on Obsidian
 * desktop, but we don't rely on that here.
 */

import type { ObsidianApi } from "./ObsidianApi";

export interface ResolvedDailyNotePath {
  /** Vault-relative path, forward-slash separated, no leading slash. */
  path: string;
  /** `'plugin-config'` when the Daily Notes config was read; `'fallback'` otherwise. */
  source: "plugin-config" | "fallback";
}

/**
 * Format `now` according to Obsidian's Daily Notes `format` string.
 *
 * We support the moment.js-style tokens that the Daily Notes plugin
 * actually uses in default configurations: `YYYY` (4-digit year),
 * `MM` (2-digit month), `DD` (2-digit day-of-month), `YY` (2-digit
 * year), `M` (month, no pad), `D` (day, no pad). Anything else is
 * treated as a literal — including the `[escape]` brackets used by
 * moment.js to opt characters out of formatting.
 *
 * If `format` is empty / undefined / produces an empty string we
 * fall back to `YYYY-MM-DD`.
 */
export function formatDailyNoteName(now: Date, format?: string): string {
  const fmt = format && format.trim().length > 0 ? format : "YYYY-MM-DD";
  const yyyy = String(now.getFullYear()).padStart(4, "0");
  const yy = yyyy.slice(-2);
  const month = now.getMonth() + 1;
  const mm = String(month).padStart(2, "0");
  const day = now.getDate();
  const dd = String(day).padStart(2, "0");

  // Two-pass token replacement: handle moment.js literal-escape brackets
  // first by carving the string into [literal] vs format segments.
  const segments: Array<{ literal: boolean; text: string }> = [];
  let i = 0;
  while (i < fmt.length) {
    if (fmt[i] === "[") {
      const end = fmt.indexOf("]", i + 1);
      if (end === -1) {
        // Unterminated literal — treat the rest as a format segment.
        segments.push({ literal: false, text: fmt.slice(i) });
        break;
      }
      segments.push({ literal: true, text: fmt.slice(i + 1, end) });
      i = end + 1;
      continue;
    }
    let j = i;
    while (j < fmt.length && fmt[j] !== "[") j += 1;
    segments.push({ literal: false, text: fmt.slice(i, j) });
    i = j;
  }

  const out = segments
    .map((seg) => {
      if (seg.literal) return seg.text;
      // Order matters: longer tokens before shorter overlapping ones.
      return seg.text
        .replace(/YYYY/g, yyyy)
        .replace(/YY/g, yy)
        .replace(/MM/g, mm)
        .replace(/M/g, String(month))
        .replace(/DD/g, dd)
        .replace(/D/g, String(day));
    })
    .join("");
  return out.length > 0 ? out : `${yyyy}-${mm}-${dd}`;
}

/**
 * Resolve today's daily-note vault-relative path.
 *
 *   - When `api.getDailyNotesConfig()` returns ok: combine the
 *     configured folder (if any) with the formatted filename + `.md`.
 *   - Otherwise: fall back to `YYYY-MM-DD.md` at vault root.
 *
 * The returned path uses forward slashes and never starts with `/`.
 */
export function resolveDailyNotePath(
  api: ObsidianApi,
  now: Date,
): ResolvedDailyNotePath {
  const cfg = api.getDailyNotesConfig();
  if (!cfg.ok) {
    const yyyy = String(now.getFullYear()).padStart(4, "0");
    const mm = String(now.getMonth() + 1).padStart(2, "0");
    const dd = String(now.getDate()).padStart(2, "0");
    return { path: `${yyyy}-${mm}-${dd}.md`, source: "fallback" };
  }
  const filenameStem = formatDailyNoteName(now, cfg.value.format);
  const folder = (cfg.value.folder ?? "").trim().replace(/^\/+|\/+$/g, "");
  const filename = `${filenameStem}.md`;
  const path = folder.length > 0 ? `${folder}/${filename}` : filename;
  return { path, source: "plugin-config" };
}
