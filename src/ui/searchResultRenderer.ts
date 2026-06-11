/**
 * v0.3 Phase 2 (FR-018, MF-3): pure parser that converts a search-tool
 * `resultContent` JSON string into a typed shape the DOM-rendering code
 * in {@link ToolCallBlock} can iterate.
 *
 * Lives in its own module (matching the `chatKeydown.ts` convention)
 * so it can be unit-tested without a DOM — `vitest.config.ts` runs the
 * `node` environment and has no jsdom shim. The DOM construction for
 * rendering matches lives in ToolCallBlock.
 *
 * Recognised shapes (anything else returns `null` so the caller falls
 * back to plain-text rendering — old persisted entries and future
 * result variants must not break the renderer):
 *
 *   - search_by_tag / search_by_name → `{ ok: true, matches: [{path, displayName}, ...], total?, truncated? }`
 *   - list_all_tags                  → `{ ok: true, tags: [{tag, count}, ...] }`
 *
 * `{ ok: false, ... }` payloads are deliberately not parsed here —
 * they're diagnostic and read better as the plain `<pre>` fallback.
 */

export interface SearchMatchView {
  path: string;
  displayName: string;
}

export interface TagCountView {
  tag: string;
  count: number;
}

export type SearchResultShape =
  | {
      kind: "matches";
      matches: SearchMatchView[];
      total: number;
      truncated: boolean;
    }
  | {
      kind: "tags";
      tags: TagCountView[];
    };

const MATCHES_TOOLS = new Set<string>(["search_by_tag", "search_by_name"]);
const TAGS_TOOLS = new Set<string>(["list_all_tags"]);

export function parseSearchToolResult(
  toolName: string | undefined,
  resultJson: string,
): SearchResultShape | null {
  if (!toolName) return null;
  if (!MATCHES_TOOLS.has(toolName) && !TAGS_TOOLS.has(toolName)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(resultJson);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;
  if (obj.ok !== true) return null;

  if (MATCHES_TOOLS.has(toolName)) {
    const raw = obj.matches;
    if (!Array.isArray(raw)) return null;
    const matches: SearchMatchView[] = [];
    for (const m of raw) {
      if (
        m &&
        typeof m === "object" &&
        typeof (m as { path?: unknown }).path === "string" &&
        typeof (m as { displayName?: unknown }).displayName === "string"
      ) {
        matches.push({
          path: (m as { path: string }).path,
          displayName: (m as { displayName: string }).displayName,
        });
      }
    }
    const total =
      typeof obj.total === "number" && Number.isFinite(obj.total)
        ? obj.total
        : matches.length;
    const truncated = obj.truncated === true;
    return { kind: "matches", matches, total, truncated };
  }

  // list_all_tags
  const rawTags = obj.tags;
  if (!Array.isArray(rawTags)) return null;
  const tags: TagCountView[] = [];
  for (const t of rawTags) {
    if (
      t &&
      typeof t === "object" &&
      typeof (t as { tag?: unknown }).tag === "string" &&
      typeof (t as { count?: unknown }).count === "number" &&
      Number.isFinite((t as { count: number }).count)
    ) {
      tags.push({
        tag: (t as { tag: string }).tag,
        count: (t as { count: number }).count,
      });
    }
  }
  return { kind: "tags", tags };
}
