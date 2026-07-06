import { defineTool, type Tool } from "@github/copilot-sdk";
import type { ReadToolsVault, TFileLike } from "./ReadTools";
import { ObsidianApi, type FileCacheLike, collectFileTagsForFallback } from "./ObsidianApi";
import { NAVIGATE_TOOL_NAMES } from "../domain/vaultToolManifest";

export { NAVIGATE_TOOL_NAMES };

/** Hard cap on `get_outlinks` entries per response. */
export const MAX_OUTLINKS = 200;
/** Hard cap on total headings + sections + blocks in `get_note_structure`. */
export const MAX_STRUCTURE_ITEMS = 500;
/** Hard cap on `related_notes` results. */
export const RELATED_NOTES_CAP = 20;
/** Weight for shared-tag overlap in the related-notes score. */
export const W_TAG = 3;
/** Weight for shared-outlink overlap in the related-notes score. */
export const W_LINK = 2;
/** Weight for shared-backlink overlap in the related-notes score. */
export const W_BACK = 1;

// ---- result shapes ---------------------------------------------------

export type ResolveLinkResult =
  | { ok: true; target: { path: string } }
  | {
      ok: false;
      reason: "unresolved" | "invalid-link" | "metadata-cache-not-ready";
    };

export interface OutlinkEntry {
  target: string;
  kind: "wikilink" | "markdown";
  resolvedPath?: string;
}

export type GetOutlinksResult =
  | {
      ok: true;
      path: string;
      outlinks: OutlinkEntry[];
      truncated: boolean;
    }
  | {
      ok: false;
      reason: "not-found" | "metadata-cache-not-ready";
    };

export interface HeadingItem {
  level: number;
  text: string;
  line: number;
}
export interface SectionItem {
  type: string;
  line: number;
}
export interface BlockItem {
  id: string;
  line: number;
}

export type GetNoteStructureResult =
  | {
      ok: true;
      path: string;
      headings: HeadingItem[];
      sections: SectionItem[];
      blocks: BlockItem[];
      truncated: boolean;
    }
  | {
      ok: false;
      reason: "not-found" | "metadata-cache-not-ready";
    };

export interface RelatedSignals {
  tag: number;
  outlink: number;
  backlink: number;
}
export interface RelatedNoteEntry {
  path: string;
  score: number;
  signals: RelatedSignals;
}
export type RelatedNotesResult =
  | {
      ok: true;
      source: string;
      related: RelatedNoteEntry[];
      truncated: boolean;
    }
  | { ok: false; reason: "not-found" | "metadata-cache-not-ready" };

// ---- factory ---------------------------------------------------------

/**
 * v0.10 Phase 2 structural navigation tools. Three read-only tools
 * driven entirely by Obsidian's resolved metadata cache — no file
 * body is ever read or returned (SC-008 anchor for
 * `get_note_structure`). All three set `skipPermission: true` per
 * FR-010.
 */
export function createNavigateTools(
  api: ObsidianApi,
  vault: ReadToolsVault,
): Tool[] {
  return [
    defineTool("resolve_link", {
      description:
        "Resolve a wikilink or markdown link (e.g. \"[[Alice's Notes]]\" " +
        "or \"folder/other\") to its target vault path. Source-aware: " +
        "matches Obsidian's own click-resolution rule, which depends on " +
        "the note the link was written in.",
      parameters: {
        type: "object",
        required: ["link", "sourcePath"],
        properties: {
          link: {
            type: "string",
            description:
              "Link text. May include or omit the '[[…]]' wrapper. Required.",
          },
          sourcePath: {
            type: "string",
            description:
              "Vault-relative path of the note the link appears in. " +
              "Required — Obsidian's resolver is source-aware.",
          },
        },
        additionalProperties: false,
      },
      skipPermission: true,
      handler: async (args: unknown) => resolveLinkImpl(args, api),
    }),

    defineTool("get_outlinks", {
      description:
        "List outgoing links (wikilinks and markdown links) plus embeds " +
        "for a note. Each entry has `target`, `kind` ('wikilink' | " +
        "'markdown'), and `resolvedPath` when the link resolves. " +
        `Capped at ${MAX_OUTLINKS} entries.`,
      parameters: {
        type: "object",
        required: ["path"],
        properties: {
          path: {
            type: "string",
            description: "Vault-relative path of the note to inspect. Required.",
          },
        },
        additionalProperties: false,
      },
      skipPermission: true,
      handler: async (args: unknown) => getOutlinksImpl(args, api, vault),
    }),

    defineTool("get_note_structure", {
      description:
        "Return a note's headings, sections, and block references with " +
        "line numbers. NO body prose is included — this is a purely " +
        "structural view. Use before `read_file` to plan a targeted read. " +
        `Capped at ${MAX_STRUCTURE_ITEMS} combined items.`,
      parameters: {
        type: "object",
        required: ["path"],
        properties: {
          path: {
            type: "string",
            description: "Vault-relative path of the note to inspect. Required.",
          },
        },
        additionalProperties: false,
      },
      skipPermission: true,
      handler: async (args: unknown) => getNoteStructureImpl(args, api, vault),
    }),

    defineTool("related_notes", {
      description:
        "Rank vault neighbours of a source note by shared tags " +
        `(weight ${W_TAG}), shared outgoing links (weight ${W_LINK}), ` +
        `and shared incoming links (weight ${W_BACK}). Returns up to ` +
        `${RELATED_NOTES_CAP} results with per-signal counts. Score-0 ` +
        "neighbours are omitted.",
      parameters: {
        type: "object",
        required: ["path"],
        properties: {
          path: {
            type: "string",
            description: "Vault-relative path of the source note. Required.",
          },
          limit: {
            type: "number",
            description: `Maximum results to return (default ${RELATED_NOTES_CAP}).`,
          },
        },
        additionalProperties: false,
      },
      skipPermission: true,
      handler: async (args: unknown) => relatedNotesImpl(args, api, vault),
    }),
  ];
}

// ---- impls (exported for unit-test use) ------------------------------

export function resolveLinkImpl(
  args: unknown,
  api: ObsidianApi,
): ResolveLinkResult {
  const parsed = (args ?? {}) as { link?: unknown; sourcePath?: unknown };
  if (typeof parsed.link !== "string" || parsed.link.length === 0) {
    return { ok: false, reason: "invalid-link" };
  }
  if (
    typeof parsed.sourcePath !== "string" ||
    parsed.sourcePath.length === 0
  ) {
    return { ok: false, reason: "invalid-link" };
  }
  // Strip a leading `[[` / trailing `]]` if the caller passed the raw
  // wikilink form. Also drop any `|display text` alias and `#heading`
  // fragment — Obsidian's resolver only cares about the target path.
  const cleaned = stripLinkFormatting(parsed.link);
  if (cleaned.length === 0) {
    return { ok: false, reason: "invalid-link" };
  }
  const r = api.resolveLinkPath(cleaned, parsed.sourcePath);
  if (r.ok) {
    return { ok: true, target: { path: r.value.path } };
  }
  if (r.reason === "metadata-cache-not-ready") {
    return { ok: false, reason: "metadata-cache-not-ready" };
  }
  // FR-014: distinguish "cache not ready yet" from "genuinely
  // unresolved". If the source note itself exists in the vault but
  // Obsidian has no cache entry for it yet, the resolver is almost
  // certainly returning null because the metadata index is still
  // warming — surface that as the retryable not-ready reason instead
  // of the terminal `unresolved`.
  if (isSourceCacheWarming(parsed.sourcePath, api)) {
    return { ok: false, reason: "metadata-cache-not-ready" };
  }
  return { ok: false, reason: "unresolved" };
}

function isSourceCacheWarming(sourcePath: string, api: ObsidianApi): boolean {
  const file = lookupFileByApi(sourcePath, api);
  if (!file) return false;
  const cacheR = api.getFileCache(file);
  // `not-found` here means the file is in the vault but the metadata
  // cache hasn't populated an entry for it yet.
  return !cacheR.ok && cacheR.reason === "not-found";
}

function lookupFileByApi(path: string, api: ObsidianApi): TFileLike | null {
  // We don't have direct vault access here, so use the resolver as a
  // path-existence probe: if getFirstLinkpathDest resolves the exact
  // path to a file, we know the file exists. When the resolver isn't
  // available, we can't tell — return null and fall back to the
  // default "unresolved" answer.
  const r = api.resolveLinkPath(path, path);
  return r.ok ? r.value : null;
}

export function getOutlinksImpl(
  args: unknown,
  api: ObsidianApi,
  vault: ReadToolsVault,
): GetOutlinksResult {
  const parsed = (args ?? {}) as { path?: unknown };
  if (typeof parsed.path !== "string" || parsed.path.length === 0) {
    return { ok: false, reason: "not-found" };
  }
  const file = lookupFile(parsed.path, vault);
  if (!file) return { ok: false, reason: "not-found" };
  const cacheR = api.getFileCache(file);
  if (!cacheR.ok) {
    // FR-014: file exists in vault but metadata cache is either
    // completely unavailable or hasn't populated this file yet.
    // Both are retryable warmup states, not terminal "not found".
    if (
      cacheR.reason === "index-unavailable" ||
      cacheR.reason === "not-found"
    ) {
      return { ok: false, reason: "metadata-cache-not-ready" };
    }
    return { ok: false, reason: "not-found" };
  }
  const cache = cacheR.value;

  const entries: OutlinkEntry[] = [];
  const pushEntry = (linkText: string, original: string) => {
    const kind: OutlinkEntry["kind"] =
      original.startsWith("[[") || original.startsWith("![[")
        ? "wikilink"
        : "markdown";
    const target = stripLinkFormatting(linkText);
    if (target.length === 0) return;
    const entry: OutlinkEntry = { target, kind };
    const resolved = api.resolveLinkPath(target, parsed.path as string);
    if (resolved.ok) {
      entry.resolvedPath = resolved.value.path;
    }
    entries.push(entry);
  };

  for (const l of cache.links ?? []) {
    pushEntry(l.link, l.original);
  }
  for (const e of cache.embeds ?? []) {
    pushEntry(e.link, e.original);
  }

  const truncated = entries.length > MAX_OUTLINKS;
  return {
    ok: true,
    path: parsed.path as string,
    outlinks: truncated ? entries.slice(0, MAX_OUTLINKS) : entries,
    truncated,
  };
}

export function getNoteStructureImpl(
  args: unknown,
  api: ObsidianApi,
  vault: ReadToolsVault,
): GetNoteStructureResult {
  const parsed = (args ?? {}) as { path?: unknown };
  if (typeof parsed.path !== "string" || parsed.path.length === 0) {
    return { ok: false, reason: "not-found" };
  }
  const file = lookupFile(parsed.path, vault);
  if (!file) return { ok: false, reason: "not-found" };
  const cacheR = api.getFileCache(file);
  if (!cacheR.ok) {
    // FR-014: same reasoning as getOutlinksImpl — a null cache for a
    // file that exists in the vault is a warmup state, not a
    // terminal miss.
    if (
      cacheR.reason === "index-unavailable" ||
      cacheR.reason === "not-found"
    ) {
      return { ok: false, reason: "metadata-cache-not-ready" };
    }
    return { ok: false, reason: "not-found" };
  }
  const cache: FileCacheLike = cacheR.value;

  const headings: HeadingItem[] = [];
  for (const h of cache.headings ?? []) {
    headings.push({
      level: h.level,
      text: h.heading,
      line: h.position?.start?.line ?? 0,
    });
  }
  const sections: SectionItem[] = [];
  for (const s of cache.sections ?? []) {
    sections.push({
      type: s.type,
      line: s.position?.start?.line ?? 0,
    });
  }
  const blocks: BlockItem[] = [];
  for (const [id, b] of Object.entries(cache.blocks ?? {})) {
    blocks.push({ id, line: b.position?.start?.line ?? 0 });
  }

  const total = headings.length + sections.length + blocks.length;
  const truncated = total > MAX_STRUCTURE_ITEMS;
  // When truncated, trim proportionally by giving priority to
  // headings > sections > blocks (headings are the highest-signal
  // structural anchors for navigation).
  if (truncated) {
    let budget = MAX_STRUCTURE_ITEMS;
    const trimmedHeadings = headings.slice(0, budget);
    budget -= trimmedHeadings.length;
    const trimmedSections = sections.slice(0, Math.max(0, budget));
    budget -= trimmedSections.length;
    const trimmedBlocks = blocks.slice(0, Math.max(0, budget));
    return {
      ok: true,
      path: parsed.path as string,
      headings: trimmedHeadings,
      sections: trimmedSections,
      blocks: trimmedBlocks,
      truncated: true,
    };
  }
  return {
    ok: true,
    path: parsed.path as string,
    headings,
    sections,
    blocks,
    truncated: false,
  };
}

// ---- helpers ---------------------------------------------------------

function lookupFile(
  path: string,
  vault: ReadToolsVault,
): TFileLike | null {
  if (typeof vault.getFileByPath === "function") {
    const f = vault.getFileByPath(path);
    if (f) return f as TFileLike;
  }
  if (typeof vault.getAbstractFileByPath === "function") {
    const f = vault.getAbstractFileByPath(path);
    if (f && typeof (f as TFileLike).path === "string") {
      return f as TFileLike;
    }
  }
  return null;
}

/**
 * Strip `[[…]]` / `[](…)` wrapper syntax, drop any `|alias` display
 * override and `#heading` / `#^blockid` fragment. Preserves the raw
 * target path only — matches what `getFirstLinkpathDest` expects.
 */
function stripLinkFormatting(link: string): string {
  let s = link.trim();
  // Markdown link: [text](target)
  const mdMatch = /^\[[^\]]*\]\(([^)]+)\)$/.exec(s);
  if (mdMatch) {
    s = mdMatch[1];
  } else {
    // Wikilink: [[target]] or [[target|alias]]
    if (s.startsWith("[[") && s.endsWith("]]")) {
      s = s.slice(2, -2);
    }
  }
  const pipe = s.indexOf("|");
  if (pipe >= 0) s = s.slice(0, pipe);
  const hash = s.indexOf("#");
  if (hash >= 0) s = s.slice(0, hash);
  return s.trim();
}

// ---- related_notes ---------------------------------------------------

export function relatedNotesImpl(
  args: unknown,
  api: ObsidianApi,
  vault: ReadToolsVault,
): RelatedNotesResult {
  const parsed = (args ?? {}) as { path?: unknown; limit?: unknown };
  if (typeof parsed.path !== "string" || parsed.path.length === 0) {
    return { ok: false, reason: "not-found" };
  }
  const sourcePath = parsed.path;
  const cap =
    typeof parsed.limit === "number" && parsed.limit > 0
      ? Math.min(Math.floor(parsed.limit), RELATED_NOTES_CAP)
      : RELATED_NOTES_CAP;

  const sourceFile = lookupFile(sourcePath, vault);
  if (!sourceFile) return { ok: false, reason: "not-found" };

  // Source cache — warmup detection mirrors get_outlinks.
  const sourceCacheR = api.getFileCache(sourceFile);
  if (!sourceCacheR.ok) {
    if (
      sourceCacheR.reason === "index-unavailable" ||
      sourceCacheR.reason === "not-found"
    ) {
      return { ok: false, reason: "metadata-cache-not-ready" };
    }
    return { ok: false, reason: "not-found" };
  }
  const sourceCache = sourceCacheR.value;

  // resolvedLinks — needed for backlinks and to resolve outlinks.
  const rlR = api.getResolvedLinks();
  if (!rlR.ok) {
    return { ok: false, reason: "metadata-cache-not-ready" };
  }
  const resolvedLinks = rlR.value;

  // Source tags.
  const sourceTags = collectFileTagsForFallback(sourceCache);

  // Source outlinks (resolved target paths).
  const sourceOutlinks = new Set<string>();
  for (const l of sourceCache.links ?? []) {
    const cleaned = stripLinkFormatting(l.link ?? l.original ?? "");
    if (!cleaned) continue;
    const r = api.resolveLinkPath(cleaned, sourcePath);
    if (r.ok) sourceOutlinks.add(r.value.path);
  }
  for (const e of sourceCache.embeds ?? []) {
    const cleaned = stripLinkFormatting(e.link ?? e.original ?? "");
    if (!cleaned) continue;
    const r = api.resolveLinkPath(cleaned, sourcePath);
    if (r.ok) sourceOutlinks.add(r.value.path);
  }

  // Source backlinks (files that link TO source).
  const sourceBacklinks = new Set<string>();
  for (const [srcPath, targets] of Object.entries(resolvedLinks)) {
    if (srcPath === sourcePath) continue;
    if (targets && targets[sourcePath]) sourceBacklinks.add(srcPath);
  }

  const files =
    (typeof vault.getMarkdownFiles === "function"
      ? vault.getMarkdownFiles()
      : []) ?? [];

  const scored: RelatedNoteEntry[] = [];
  for (const f of files) {
    if (!f || typeof f.path !== "string") continue;
    if (f.path === sourcePath) continue;

    // Candidate tags + outlinks require the candidate's file cache.
    const cR = api.getFileCache(f);
    let tagOverlap = 0;
    let outlinkOverlap = 0;
    if (cR.ok) {
      const cand = cR.value;
      const candTags = collectFileTagsForFallback(cand);
      for (const t of candTags) {
        if (sourceTags.has(t)) tagOverlap++;
      }
      const candOutlinks = new Set<string>();
      for (const l of cand.links ?? []) {
        const cleaned = stripLinkFormatting(l.link ?? l.original ?? "");
        if (!cleaned) continue;
        const r = api.resolveLinkPath(cleaned, f.path);
        if (r.ok) candOutlinks.add(r.value.path);
      }
      for (const t of candOutlinks) {
        if (sourceOutlinks.has(t)) outlinkOverlap++;
      }
    }

    // Backlink overlap: files that link to candidate AND are in source's
    // backlink set.
    let backlinkOverlap = 0;
    const candTargets = resolvedLinks[f.path] ? undefined : undefined;
    void candTargets;
    for (const [srcPath, targets] of Object.entries(resolvedLinks)) {
      if (srcPath === sourcePath) continue;
      if (srcPath === f.path) continue;
      if (!targets || !targets[f.path]) continue;
      if (sourceBacklinks.has(srcPath)) backlinkOverlap++;
    }

    const score =
      tagOverlap * W_TAG + outlinkOverlap * W_LINK + backlinkOverlap * W_BACK;
    if (score <= 0) continue;

    scored.push({
      path: f.path,
      score,
      signals: {
        tag: tagOverlap,
        outlink: outlinkOverlap,
        backlink: backlinkOverlap,
      },
    });
  }

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.path.localeCompare(b.path);
  });

  const truncated = scored.length > cap;
  return {
    ok: true,
    source: sourcePath,
    related: scored.slice(0, cap),
    truncated,
  };
}
