import { defineTool, type Tool } from "@github/copilot-sdk";
import type { ReadToolsVault, TFileLike } from "./ReadTools";
import { searchInFiles } from "./ReadTools";
import {
  ObsidianApi,
  collectFileTagsForFallback,
  normalizeTagKey,
} from "./ObsidianApi";
import { V03_READ_TOOL_NAMES } from "../domain/vaultToolManifest";

// Re-export so callers can construct the manifest-name list without
// reaching into `domain/` (mirrors the ReadNoteTools pattern).
export { V03_READ_TOOL_NAMES };

/** Hard cap on `search_by_tag` matches — keeps the tool result bounded. */
export const SEARCH_BY_TAG_CAP = 200;
/** Hard cap on `search_by_name` matches — names are short, so a smaller cap fits one model turn. */
export const SEARCH_BY_NAME_CAP = 50;
/** Hard cap on `search_vault` compound-query matches. Larger than the
 *  per-file cap because compound queries can legitimately span many
 *  notes. Overrides the Phase 1 `searchInFiles` default (50) when
 *  `search_vault` calls the helper. */
export const SEARCH_VAULT_CAP = 100;

/**
 * v0.3 Phase 2 read-only search tools.
 *
 * All three tools registered here share the FR-017 read-only contract
 * (matching the checklist in `ReadTools.ts:53-78`):
 *
 *   1. Strict read-only — no filesystem mutation, no network, no shell.
 *   2. Path/tag inputs are normalized via small pure helpers; nothing
 *      escapes vault scope (results come from Obsidian's metadata
 *      cache or `vault.getMarkdownFiles()`, both already vault-bounded).
 *   3. Bounded output — tag matches capped at {@link SEARCH_BY_TAG_CAP},
 *      name matches at {@link SEARCH_BY_NAME_CAP}, list_all_tags has no
 *      cap because tag inventories are inherently small (vault-wide).
 *   4. Registered with `skipPermission: true` — auto-approved per the
 *      v0.2 read-only gate. The SDK never invokes `buildSafetyInput`
 *      for these tools, so they cannot be denied by a tightened
 *      safety policy.
 *
 * Result shapes are stable and discoverable: each tool returns
 * `{ ok: true, ... }` on success and `{ ok: false, reason }` on a
 * recoverable index-state issue (e.g. metadata cache still warming
 * up). The MessageRenderer (Phase 2 / FR-018) detects the result
 * shape and renders matched paths as clickable note links.
 */
export function createSearchTools(
  api: ObsidianApi,
  vault: ReadToolsVault,
): Tool[] {
  return [
    defineTool("search_by_tag", {
      description:
        "Find every markdown note tagged with the given tag. Input may " +
        "include or omit the leading '#'. Tag matching is exact and " +
        "case-sensitive on the post-'#' string (Obsidian preserves case). " +
        `Results capped at ${SEARCH_BY_TAG_CAP}; the response sets ` +
        "`truncated: true` if the cap was hit.",
      parameters: {
        type: "object",
        properties: {
          tag: {
            type: "string",
            description:
              "Tag to match (e.g. 'project' or '#project'). Required.",
          },
        },
        required: ["tag"],
        additionalProperties: false,
      },
      skipPermission: true,
      handler: async (args: unknown) => {
        const a = (args ?? {}) as { tag?: unknown };
        const tag = typeof a.tag === "string" ? a.tag : "";
        return searchByTagImpl(api, tag);
      },
    }),

    defineTool("search_by_name", {
      description:
        "Find markdown notes whose file basename matches the query. " +
        "Ranking buckets: exact-match > prefix-match > substring-match, " +
        "all case-insensitive. Within a bucket, results are alphabetical. " +
        `Capped at ${SEARCH_BY_NAME_CAP} results.`,
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description:
              "Substring or full name to search for. Case-insensitive. Required.",
          },
        },
        required: ["query"],
        additionalProperties: false,
      },
      skipPermission: true,
      handler: async (args: unknown) => {
        const a = (args ?? {}) as { query?: unknown };
        const query = typeof a.query === "string" ? a.query : "";
        return searchByNameImpl(vault, query);
      },
    }),

    defineTool("list_all_tags", {
      description:
        "List every distinct tag in the vault paired with its occurrence " +
        "count, sorted by count descending (ties broken alphabetically). " +
        "Tag keys retain the leading '#' so the output matches Obsidian's " +
        "metadata-cache shape exactly.",
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      skipPermission: true,
      handler: async () => listAllTagsImpl(api),
    }),

    defineTool("search_vault", {
      description:
        "Compound vault query: AND-combine tag, folder-prefix, " +
        "modified-since, and free-text filters in a single call. Short-" +
        "circuits (returns matches:[] with shortCircuited:true) when a " +
        "structural filter excludes every note — no file bodies are read " +
        "in that case. When `text` is supplied, ranks results via the " +
        `chosen \`textMode\`. Capped at ${SEARCH_VAULT_CAP} matches.`,
      parameters: {
        type: "object",
        properties: {
          tag: {
            type: "string",
            description: "Tag to filter by (with or without '#').",
          },
          folder: {
            type: "string",
            description:
              "Vault-relative folder prefix. Matches notes whose path starts with this prefix.",
          },
          modifiedSinceMs: {
            type: "number",
            description:
              "Unix epoch (ms). Include notes with `stat.mtime >= modifiedSinceMs`.",
          },
          text: {
            type: "string",
            description:
              "Free-text query. When absent, the tool returns metadata for the filtered note set (no body reads).",
          },
          textMode: {
            type: "string",
            enum: ["substring", "simple", "fuzzy"],
            description:
              "Text-match algorithm (default 'substring'). 'simple' and 'fuzzy' rank results with score + spans.",
          },
          limit: {
            type: "number",
            description: `Maximum matches to return (default ${SEARCH_VAULT_CAP}). Capped at ${SEARCH_VAULT_CAP}.`,
          },
        },
        additionalProperties: false,
      },
      skipPermission: true,
      handler: async (args: unknown) => searchVaultImpl(args, api, vault),
    }),
  ];
}

// ---- result shapes ---------------------------------------------------

export interface SearchMatch {
  /** Vault-relative path. */
  path: string;
  /** Display name (file basename without `.md`). */
  displayName: string;
}

export type SearchByTagResult =
  | {
      ok: true;
      tag: string;
      matches: SearchMatch[];
      total: number;
      truncated: boolean;
    }
  | { ok: false; reason: "metadata-cache-not-ready" | "invalid-tag" };

export type SearchByNameResult =
  | {
      ok: true;
      query: string;
      matches: SearchMatch[];
      total: number;
      truncated: boolean;
    }
  | { ok: false; reason: "invalid-query" };

export interface TagCount {
  tag: string;
  count: number;
}
export type ListAllTagsResult =
  | { ok: true; tags: TagCount[] }
  | { ok: false; reason: "metadata-cache-not-ready" };

// ---- impl helpers (exported for unit-test use) -----------------------

function basename(path: string): string {
  const last = path.split("/").pop() ?? path;
  return last.endsWith(".md") ? last.slice(0, -3) : last;
}

function toMatch(file: TFileLike): SearchMatch {
  return { path: file.path, displayName: basename(file.path) };
}

export async function searchByTagImpl(
  api: ObsidianApi,
  rawTag: string,
): Promise<SearchByTagResult> {
  const norm = normalizeTagKey(rawTag);
  if (!norm) {
    return { ok: false, reason: "invalid-tag" };
  }
  const r = api.findFilesByTag(norm);
  if (!r.ok) {
    if (r.reason === "metadata-cache-not-ready") {
      return { ok: false, reason: "metadata-cache-not-ready" };
    }
    if (r.reason === "invalid-path") {
      return { ok: false, reason: "invalid-tag" };
    }
    // native-failed / index-unavailable / not-found / etc. — surface as
    // not-ready so the agent can retry or recover.
    return { ok: false, reason: "metadata-cache-not-ready" };
  }
  const total = r.value.length;
  const truncated = total > SEARCH_BY_TAG_CAP;
  const matches = r.value.slice(0, SEARCH_BY_TAG_CAP).map(toMatch);
  // Stable alphabetical sort within the cap so the same vault state
  // produces the same response regardless of file-iteration order.
  matches.sort((a, b) => a.path.localeCompare(b.path));
  return { ok: true, tag: norm, matches, total, truncated };
}

export async function searchByNameImpl(
  vault: ReadToolsVault,
  rawQuery: string,
): Promise<SearchByNameResult> {
  const query = rawQuery.trim();
  if (!query) {
    return { ok: false, reason: "invalid-query" };
  }
  if (typeof vault.getMarkdownFiles !== "function") {
    return {
      ok: true,
      query,
      matches: [],
      total: 0,
      truncated: false,
    };
  }
  const lower = query.toLowerCase();
  const exact: TFileLike[] = [];
  const prefix: TFileLike[] = [];
  const substring: TFileLike[] = [];
  for (const file of vault.getMarkdownFiles()) {
    const name = basename(file.path).toLowerCase();
    if (name === lower) {
      exact.push(file);
    } else if (name.startsWith(lower)) {
      prefix.push(file);
    } else if (name.includes(lower)) {
      substring.push(file);
    }
  }
  const sortByPath = (a: TFileLike, b: TFileLike) =>
    a.path.localeCompare(b.path);
  exact.sort(sortByPath);
  prefix.sort(sortByPath);
  substring.sort(sortByPath);
  const ordered = [...exact, ...prefix, ...substring];
  const total = ordered.length;
  const truncated = total > SEARCH_BY_NAME_CAP;
  const matches = ordered.slice(0, SEARCH_BY_NAME_CAP).map(toMatch);
  return { ok: true, query, matches, total, truncated };
}

export async function listAllTagsImpl(
  api: ObsidianApi,
): Promise<ListAllTagsResult> {
  const r = api.listAllTags();
  if (!r.ok) {
    return { ok: false, reason: "metadata-cache-not-ready" };
  }
  const entries: TagCount[] = Object.entries(r.value).map(([tag, count]) => ({
    tag,
    count,
  }));
  entries.sort((a, b) => {
    if (b.count !== a.count) return b.count - a.count;
    return a.tag.localeCompare(b.tag);
  });
  return { ok: true, tags: entries };
}

// Re-export the cache-tag helper for tests that exercise the fallback
// path without going through the full ObsidianApi surface.
export { collectFileTagsForFallback };

// ---- search_vault (Phase 3) ------------------------------------------

export type SearchVaultTextMode = "substring" | "simple" | "fuzzy";

export interface SearchVaultMatch {
  path: string;
  displayName: string;
  /** Present iff the caller supplied a `text` filter. */
  line?: number;
  snippet?: string;
  score?: number;
  spans?: Array<[number, number]>;
}

export type SearchVaultResult =
  | {
      ok: true;
      matches: SearchVaultMatch[];
      total: number;
      truncated: boolean;
      /** True iff a structural filter reduced the working set to zero
       *  BEFORE any body reads were attempted (SC-005). */
      shortCircuited: boolean;
    }
  | { ok: false; reason: "metadata-cache-not-ready" | "invalid-args" };

export async function searchVaultImpl(
  args: unknown,
  api: ObsidianApi,
  vault: ReadToolsVault,
): Promise<SearchVaultResult> {
  const parsed = (args ?? {}) as {
    tag?: unknown;
    folder?: unknown;
    modifiedSinceMs?: unknown;
    text?: unknown;
    textMode?: unknown;
    limit?: unknown;
  };

  const tag =
    typeof parsed.tag === "string" && parsed.tag.length > 0
      ? parsed.tag
      : undefined;
  const folder =
    typeof parsed.folder === "string" && parsed.folder.length > 0
      ? parsed.folder
      : undefined;
  const modifiedSinceMs =
    typeof parsed.modifiedSinceMs === "number" &&
    Number.isFinite(parsed.modifiedSinceMs)
      ? parsed.modifiedSinceMs
      : undefined;
  const text =
    typeof parsed.text === "string" && parsed.text.length > 0
      ? parsed.text
      : undefined;

  let textMode: SearchVaultTextMode = "substring";
  if (typeof parsed.textMode === "string") {
    if (
      parsed.textMode !== "substring" &&
      parsed.textMode !== "simple" &&
      parsed.textMode !== "fuzzy"
    ) {
      return { ok: false, reason: "invalid-args" };
    }
    textMode = parsed.textMode;
  }

  let limit = SEARCH_VAULT_CAP;
  if (typeof parsed.limit === "number" && Number.isFinite(parsed.limit)) {
    if (parsed.limit < 1) {
      return { ok: false, reason: "invalid-args" };
    }
    limit = Math.min(SEARCH_VAULT_CAP, Math.floor(parsed.limit));
  }

  // Step 1: candidate files (tag or full markdown list).
  let candidates: TFileLike[];
  if (tag) {
    const norm = normalizeTagKey(tag);
    if (!norm) return { ok: false, reason: "invalid-args" };
    const r = api.findFilesByTag(norm);
    if (!r.ok) {
      // FR-014 / SC-014: cache-not-populated surfaces structurally,
      // not as a thrown error.
      return { ok: false, reason: "metadata-cache-not-ready" };
    }
    candidates = r.value;
  } else {
    if (typeof vault.getMarkdownFiles !== "function") {
      candidates = [];
    } else {
      candidates = vault.getMarkdownFiles();
    }
  }

  // Step 2: folder-prefix filter.
  if (folder) {
    const prefix = folder.endsWith("/") ? folder : `${folder}/`;
    candidates = candidates.filter((f) => f.path.startsWith(prefix));
  }

  // Step 3: modified-since filter.
  if (modifiedSinceMs !== undefined) {
    candidates = candidates.filter((f) => {
      const m = f.stat?.mtime;
      return typeof m === "number" && m >= modifiedSinceMs;
    });
  }

  // Step 4: short-circuit when structural filters emptied the set and
  // a `text` filter would otherwise have kicked off body reads.
  const anyStructuralFilter =
    tag !== undefined ||
    folder !== undefined ||
    modifiedSinceMs !== undefined;
  if (text !== undefined && anyStructuralFilter && candidates.length === 0) {
    return {
      ok: true,
      matches: [],
      total: 0,
      truncated: false,
      shortCircuited: true,
    };
  }

  // Step 5: text filter (delegates to the Phase 1 ranked/fuzzy helper).
  if (text !== undefined) {
    const r = await searchInFiles(candidates, text, vault, {
      mode: textMode,
      limit,
    });
    const matches: SearchVaultMatch[] = r.matches.map((m) => ({
      path: m.path,
      displayName: basename(m.path),
      line: m.line,
      snippet: m.snippet,
      score: m.score,
      spans: m.spans,
    }));
    return {
      ok: true,
      matches,
      total: r.totalMatches,
      truncated: r.truncated,
      shortCircuited: false,
    };
  }

  // No text filter: return metadata-only matches for the filtered set.
  const total = candidates.length;
  const truncated = total > limit;
  const kept = truncated ? candidates.slice(0, limit) : candidates;
  const matches: SearchVaultMatch[] = kept
    .map(toMatch)
    .map((m) => ({ path: m.path, displayName: m.displayName }));
  matches.sort((a, b) => a.path.localeCompare(b.path));
  return {
    ok: true,
    matches,
    total,
    truncated,
    shortCircuited: false,
  };
}
