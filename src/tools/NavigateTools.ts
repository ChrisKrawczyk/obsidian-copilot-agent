import { defineTool, type Tool } from "@github/copilot-sdk";
import type { ReadToolsVault, TFileLike } from "./ReadTools";
import { ObsidianApi, type FileCacheLike } from "./ObsidianApi";
import { NAVIGATE_TOOL_NAMES } from "../domain/vaultToolManifest";

export { NAVIGATE_TOOL_NAMES };

/** Hard cap on `get_outlinks` entries per response. */
export const MAX_OUTLINKS = 200;
/** Hard cap on total headings + sections + blocks in `get_note_structure`. */
export const MAX_STRUCTURE_ITEMS = 500;

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
  return { ok: false, reason: "unresolved" };
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
    if (cacheR.reason === "index-unavailable") {
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
    if (cacheR.reason === "index-unavailable") {
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
