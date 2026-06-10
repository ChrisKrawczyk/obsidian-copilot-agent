import { defineTool, type Tool } from "@github/copilot-sdk";
import {
  resolveVaultPath,
  toVaultRelative,
  lookupTFile,
  VaultPathError,
} from "./VaultPath";
import type { ReadToolsVault, TFileLike } from "./ReadTools";
import {
  ObsidianApi,
  DEFAULT_TREE_DEPTH,
  MAX_TREE_DEPTH,
} from "./ObsidianApi";
import { READ_NOTE_TOOL_NAMES } from "../domain/vaultToolManifest";
import { findTasksImpl, type FindTasksFilter } from "./FindTasks";

// Re-export so callers can construct the manifest-name list without
// reaching into `domain/`.
export { READ_NOTE_TOOL_NAMES };

/** Default list size for `list_recent_notes` (FR-014). */
const RECENT_DEFAULT = 20;
/** Hard cap on `list_recent_notes(n)` to keep model context bounded. */
const RECENT_MAX = 100;
/** Cap on per-result snippet so backlinks responses fit in one turn. */
const BACKLINK_SNIPPET_CAP = 50;

/**
 * Phase 3 read-only vault tools.
 *
 * All five tools registered here share the same defensive pattern used
 * by Phase 5's `ReadTools.ts` (see the JSDoc on `createReadTools` for
 * the full rationale + checklist):
 *
 *   1. Strict read-only — no filesystem mutation, no network, no shell.
 *   2. Path inputs validated with {@link resolveVaultPath} (rejects
 *      absolute paths, `..`, UNC paths, and symlink-escapes).
 *   3. Vault-bounded scope — resolved targets are always inside the
 *      active vault root.
 *   4. Bounded output — `list_recent_notes` capped at 100; `vault_tree`
 *      capped at `MAX_TREE_NODES` total nodes and `MAX_TREE_DEPTH`
 *      depth; `find_backlinks` capped at `BACKLINK_SNIPPET_CAP`; nothing
 *      reads binary blobs.
 *   5. Registered with `skipPermission: true` — per the FR-017 / Phase 3
 *      contract, all five auto-approve. They satisfy every item in the
 *      read-only-checklist in `ReadTools.ts:53-78`.
 *
 * `READ_NOTE_TOOL_NAMES` (re-exported above) is the single source of
 * truth — the preamble's tool-inventory coverage test asserts every
 * name here appears verbatim in the inventory string.
 */
export function createReadNoteTools(
  api: ObsidianApi,
  vault: ReadToolsVault,
): Tool[] {
  return [
    defineTool("get_active_note", {
      description:
        "Return the path and full content of the markdown note the user " +
        "is currently viewing. Returns a structured no_active_note error " +
        "if no markdown view is focused.",
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      skipPermission: true,
      handler: async () => getActiveNoteImpl(api, vault),
    }),

    defineTool("list_recent_notes", {
      description:
        `List the N most recently modified markdown notes (default ${RECENT_DEFAULT}, ` +
        `max ${RECENT_MAX}). Returns [{ path, mtime }] sorted by mtime descending.`,
      parameters: {
        type: "object",
        properties: {
          n: {
            type: "number",
            description:
              `How many notes to return. Defaults to ${RECENT_DEFAULT}; ` +
              `silently clamped to [1, ${RECENT_MAX}].`,
          },
        },
        additionalProperties: false,
      },
      skipPermission: true,
      handler: async (args: unknown) => {
        const parsed = (args ?? {}) as { n?: unknown };
        const n =
          typeof parsed.n === "number" && Number.isFinite(parsed.n)
            ? parsed.n
            : RECENT_DEFAULT;
        return listRecentNotesImpl(api, n);
      },
    }),

    defineTool("find_backlinks", {
      description:
        "List notes that contain a link to the given target note. " +
        "Each result reports `linkForm: 'wikilink' | 'markdown'` so the " +
        "model can distinguish [[wikilinks]] from [text](markdown) links. " +
        "Uses Obsidian's resolved-link index when available.",
      parameters: {
        type: "object",
        required: ["targetPath"],
        properties: {
          targetPath: {
            type: "string",
            description: "Vault-relative path of the note to find backlinks to.",
          },
        },
        additionalProperties: false,
      },
      skipPermission: true,
      handler: async (args: unknown) => {
        const parsed = (args ?? {}) as { targetPath?: unknown };
        if (typeof parsed.targetPath !== "string") {
          throw new Error("`targetPath` is required and must be a string");
        }
        return findBacklinksImpl(api, vault, parsed.targetPath);
      },
    }),

    defineTool("vault_tree", {
      description:
        `Return the folder/file hierarchy under \`folder\` (default vault root). ` +
        `\`depth\` defaults to ${DEFAULT_TREE_DEPTH} and is capped at ${MAX_TREE_DEPTH}. ` +
        `Total node count is capped — \`truncated: true\` indicates the cap was hit.`,
      parameters: {
        type: "object",
        properties: {
          folder: {
            type: "string",
            description: "Vault-relative folder. Omit for the vault root.",
          },
          depth: {
            type: "number",
            description: `How many levels to descend. Default ${DEFAULT_TREE_DEPTH}, max ${MAX_TREE_DEPTH}.`,
          },
        },
        additionalProperties: false,
      },
      skipPermission: true,
      handler: async (args: unknown) => {
        const parsed = (args ?? {}) as { folder?: unknown; depth?: unknown };
        const folder =
          typeof parsed.folder === "string" ? parsed.folder : "";
        const depth =
          typeof parsed.depth === "number" && Number.isFinite(parsed.depth)
            ? parsed.depth
            : DEFAULT_TREE_DEPTH;
        return vaultTreeImpl(api, folder, depth);
      },
    }),

    defineTool("vault_metadata", {
      description:
        "Return the metadata-cache view for a single note — tags " +
        "(inline + frontmatter, deduped), headings, frontmatter object, " +
        "outbound link targets, and file stats. Does NOT include the " +
        "note body — use `read_file` or `get_active_note` for that.",
      parameters: {
        type: "object",
        required: ["path"],
        properties: {
          path: {
            type: "string",
            description: "Vault-relative path of the note.",
          },
        },
        additionalProperties: false,
      },
      skipPermission: true,
      handler: async (args: unknown) => {
        const parsed = (args ?? {}) as { path?: unknown };
        if (typeof parsed.path !== "string") {
          throw new Error("`path` is required and must be a string");
        }
        return vaultMetadataImpl(api, vault, parsed.path);
      },
    }),

    defineTool("find_tasks", {
      description:
        "List task-list items across the vault (or a single note when " +
        "`path` is given) filtered by status, tag, due-date range, and/or " +
        "description regex. Returns up to 500 results with 1-based line " +
        "numbers, the raw line text, and the parsed task. Read-only — use " +
        "BEFORE `update_task` and pass back the `path`, `line`, AND " +
        "`expectedRawLine` from each result for safe re-anchoring.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Vault-relative path of one note to scope to. Omit for whole vault." },
          tag: { type: "string", description: "Tag (without leading #) to filter by — exact, case-insensitive." },
          status: {
            type: "string",
            enum: ["todo", "in-progress", "done", "cancelled"],
            description: "Filter by task status.",
          },
          dueBefore: { type: "string", description: "Inclusive YYYY-MM-DD upper bound on due date." },
          dueAfter: { type: "string", description: "Inclusive YYYY-MM-DD lower bound on due date." },
          descriptionRegex: { type: "string", description: "JavaScript regex tested against the task description." },
        },
        additionalProperties: false,
      },
      skipPermission: true,
      handler: async (args: unknown) => {
        const a = (args ?? {}) as Record<string, unknown>;
        const filter: FindTasksFilter = {};
        if (typeof a.path === "string") filter.path = a.path;
        if (typeof a.tag === "string") filter.tag = a.tag;
        if (
          a.status === "todo" ||
          a.status === "in-progress" ||
          a.status === "done" ||
          a.status === "cancelled"
        ) {
          filter.status = a.status;
        }
        if (typeof a.dueBefore === "string") filter.dueBefore = a.dueBefore;
        if (typeof a.dueAfter === "string") filter.dueAfter = a.dueAfter;
        if (typeof a.descriptionRegex === "string") filter.descriptionRegex = a.descriptionRegex;
        return findTasksImpl(filter, { api, vault });
      },
    }),
  ];
}

// ---- handler implementations (exported for unit-test use) ----

export type GetActiveNoteResult =
  | { ok: true; path: string; content: string }
  | { ok: false; reason: "no_active_note" };

export async function getActiveNoteImpl(
  api: ObsidianApi,
  vault: ReadToolsVault,
): Promise<GetActiveNoteResult> {
  const r = api.getActiveFile();
  if (!r.ok) {
    return { ok: false, reason: "no_active_note" };
  }
  const file = r.value;
  let content = "";
  if (typeof vault.cachedRead === "function") {
    content = await vault.cachedRead(file);
  } else if (typeof vault.read === "function") {
    content = await vault.read(file);
  }
  return { ok: true, path: file.path, content };
}

export interface RecentNoteEntry {
  path: string;
  mtime?: number;
}

export async function listRecentNotesImpl(
  api: ObsidianApi,
  n: number,
): Promise<{
  notes: RecentNoteEntry[];
  requested: number;
  returned: number;
}> {
  const r = api.listRecentlyModifiedNotes(n);
  if (!r.ok) {
    return { notes: [], requested: n, returned: 0 };
  }
  const notes = r.value.map((f) => ({
    path: f.path,
    mtime: (f as { stat?: { mtime?: number } }).stat?.mtime,
  }));
  return { notes, requested: n, returned: notes.length };
}

export interface BacklinkEntry {
  sourcePath: string;
  linkForm: "wikilink" | "markdown";
  original: string;
}

export async function findBacklinksImpl(
  api: ObsidianApi,
  vault: ReadToolsVault,
  rawTargetPath: string,
): Promise<{
  target: string;
  backlinks: BacklinkEntry[];
  usedFallback: boolean;
  truncated: boolean;
}> {
  // Validate target path. We don't require the file to exist (Obsidian
  // tracks unresolved links too), but the path must be vault-shaped.
  let target: string;
  try {
    const abs = resolveVaultPath(rawTargetPath, vault);
    target = toVaultRelative(abs, vault);
  } catch (e) {
    if (e instanceof VaultPathError) throw new Error(e.message);
    throw e;
  }

  const linksResult = api.getResolvedLinks();
  if (!linksResult.ok) {
    return fallbackBacklinks(vault, target);
  }

  const out: BacklinkEntry[] = [];
  let truncated = false;
  outer: for (const [sourcePath, targets] of Object.entries(
    linksResult.value,
  )) {
    if (!targets[target]) continue;
    // Look up the per-source file cache for the actual link strings.
    const sourceFile = lookupTFile(sourcePath, vault) as TFileLike | null;
    if (!sourceFile) continue;
    const cache = api.getFileCache(sourceFile);
    if (!cache.ok) continue;
    const links = cache.value.links ?? [];
    for (const link of links) {
      if (out.length >= BACKLINK_SNIPPET_CAP) {
        truncated = true;
        break outer;
      }
      // Match by resolved-link semantics: include any link from the
      // source whose `original` text contains the target's basename or
      // path. We err on inclusive — false positives are tolerable; the
      // sourcePath is still trustworthy.
      const original = link.original ?? link.link ?? "";
      if (!linkRefersTo(original, target)) continue;
      out.push({
        sourcePath,
        linkForm: original.trim().startsWith("[[") ? "wikilink" : "markdown",
        original,
      });
    }
  }

  return {
    target,
    backlinks: out,
    usedFallback: false,
    truncated,
  };
}

/** True if an `original` link string (from `metadataCache.links[].original`) refers to `target`. */
function linkRefersTo(original: string, target: string): boolean {
  if (!original) return false;
  const lowerOriginal = original.toLowerCase();
  const lowerTarget = target.toLowerCase();
  const targetNoExt = lowerTarget.replace(/\.md$/, "");
  const basename = targetNoExt.split("/").pop() ?? targetNoExt;
  return (
    lowerOriginal.includes(targetNoExt) ||
    lowerOriginal.includes(basename)
  );
}

/** Max files the fallback path will read (avoids unbounded vault walks). */
const FALLBACK_MAX_FILES = 500;
/** Max bytes the fallback path will read per file (matches ReadTools sizing). */
const FALLBACK_MAX_BYTES_PER_FILE = 256 * 1024;

async function fallbackBacklinks(
  vault: ReadToolsVault,
  target: string,
): Promise<{
  target: string;
  backlinks: BacklinkEntry[];
  usedFallback: boolean;
  truncated: boolean;
}> {
  // Source files come from Obsidian's tracked-files index — they are
  // already vault-scoped by construction (Obsidian itself rejects
  // out-of-vault files from its index). We additionally cap total
  // files scanned (`FALLBACK_MAX_FILES`) and per-file bytes read
  // (`FALLBACK_MAX_BYTES_PER_FILE`) so a malicious or oversized vault
  // can't pin the read-only invariant — matches the bounded-output
  // checklist (see ReadTools.ts:53-78 "data exposed to the model is
  // bounded").
  const allFiles =
    (vault.getMarkdownFiles && vault.getMarkdownFiles()) ??
    (vault.getFiles && vault.getFiles()) ??
    [];
  const all = allFiles.slice(0, FALLBACK_MAX_FILES);
  const fileCapTripped = allFiles.length > FALLBACK_MAX_FILES;
  const out: BacklinkEntry[] = [];
  let truncated = fileCapTripped;
  const targetBasename = target.split("/").pop()?.replace(/\.md$/, "") ?? "";
  const wikilinkRe = new RegExp(
    `\\[\\[([^\\]]*?${escapeReg(targetBasename)}[^\\]]*?)\\]\\]`,
    "gi",
  );
  const mdRe = new RegExp(
    `\\[([^\\]]+)\\]\\(([^)]*?${escapeReg(targetBasename)}[^)]*?)\\)`,
    "gi",
  );
  for (const f of all) {
    if (f.path === target) continue;
    // Defense-in-depth, mirroring search_content (ReadTools.ts:308-319):
    // Obsidian's known-files index *can* include a symlinked markdown
    // file whose realpath lies outside the vault root. `resolveVaultPath`
    // runs the same containment check used by `read_file` so the fallback
    // can never leak extra-vault content. Sources that fail validation
    // are silently skipped (the model shouldn't see them at all).
    try {
      resolveVaultPath(f.path, vault);
    } catch {
      continue;
    }
    if (out.length >= BACKLINK_SNIPPET_CAP) {
      truncated = true;
      break;
    }
    let body: string;
    try {
      if (typeof vault.cachedRead === "function") {
        body = await vault.cachedRead(f);
      } else if (typeof vault.read === "function") {
        body = await vault.read(f);
      } else {
        continue;
      }
    } catch {
      continue;
    }
    if (body.length > FALLBACK_MAX_BYTES_PER_FILE) {
      body = body.slice(0, FALLBACK_MAX_BYTES_PER_FILE);
      truncated = true;
    }
    let m: RegExpExecArray | null;
    while ((m = wikilinkRe.exec(body)) !== null) {
      if (out.length >= BACKLINK_SNIPPET_CAP) {
        truncated = true;
        break;
      }
      out.push({
        sourcePath: f.path,
        linkForm: "wikilink",
        original: `[[${m[1]}]]`,
      });
    }
    while ((m = mdRe.exec(body)) !== null) {
      if (out.length >= BACKLINK_SNIPPET_CAP) {
        truncated = true;
        break;
      }
      out.push({
        sourcePath: f.path,
        linkForm: "markdown",
        original: `[${m[1]}](${m[2]})`,
      });
    }
  }
  return { target, backlinks: out, usedFallback: true, truncated };
}

function escapeReg(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export type VaultTreeResult =
  | {
      ok: true;
      root: import("./ObsidianApi").TreeNode;
      nodeCount: number;
      truncated: boolean;
      truncatedAt?: string;
    }
  | { ok: false; reason: "not_found" | "not_a_folder" | "invalid_path"; message?: string };

export async function vaultTreeImpl(
  api: ObsidianApi,
  folder: string,
  depth: number,
): Promise<VaultTreeResult> {
  const r = api.getVaultTree(folder, depth);
  if (r.ok) {
    return {
      ok: true,
      root: r.value.root,
      nodeCount: r.value.nodeCount,
      truncated: r.value.truncated,
      truncatedAt: r.value.truncatedAt,
    };
  }
  if (r.reason === "not-found") return { ok: false, reason: "not_found" };
  if (r.reason === "not-a-folder") return { ok: false, reason: "not_a_folder" };
  if (r.reason === "invalid-path") {
    return {
      ok: false,
      reason: "invalid_path",
      message: typeof r.cause === "string" ? r.cause : undefined,
    };
  }
  // index-unavailable: surface as not_found so the agent retries with a known path.
  return { ok: false, reason: "not_found" };
}

export type VaultMetadataResult =
  | {
      ok: true;
      path: string;
      tags: string[];
      headings: Array<{ heading: string; level: number }>;
      frontmatter: Record<string, unknown>;
      outboundLinks: string[];
      stat: { size?: number; mtime?: number };
    }
  | { ok: false; reason: "not_found" | "invalid_path"; message?: string };

export async function vaultMetadataImpl(
  api: ObsidianApi,
  vault: ReadToolsVault,
  rawPath: string,
): Promise<VaultMetadataResult> {
  let vaultPath: string;
  try {
    const abs = resolveVaultPath(rawPath, vault);
    vaultPath = toVaultRelative(abs, vault);
  } catch (e) {
    if (e instanceof VaultPathError) {
      return { ok: false, reason: "invalid_path", message: e.message };
    }
    throw e;
  }
  const file = lookupTFile(vaultPath, vault) as
    | (TFileLike & {
        stat?: { size?: number; mtime?: number };
        children?: unknown;
        extension?: string;
      })
    | null;
  if (!file) {
    return { ok: false, reason: "not_found" };
  }
  // Defense-in-depth: `lookupTFile` resolves both TFile and TFolder.
  // Folders expose `children` but no `extension`. Treat folders as
  // "not_found" for vault_metadata since we have no metadata view for
  // a folder; callers wanting folder structure should use `vault_tree`.
  const isFolder =
    file.children !== undefined && file.extension === undefined;
  if (isFolder) {
    return { ok: false, reason: "not_found" };
  }
  const cacheResult = api.getFileCache(file);
  const cache = cacheResult.ok ? cacheResult.value : {};
  const inlineTags = (cache.tags ?? []).map((t) => normalizeTag(t.tag));
  const fmTags = collectFrontmatterTags(cache.frontmatter);
  const tags = Array.from(new Set([...inlineTags, ...fmTags])).filter(
    (t) => t.length > 0,
  );
  const headings = (cache.headings ?? []).map((h) => ({
    heading: h.heading,
    level: h.level,
  }));
  const resolved = api.getResolvedLinks();
  const outboundLinks =
    resolved.ok && resolved.value[vaultPath]
      ? Object.keys(resolved.value[vaultPath])
      : [];
  return {
    ok: true,
    path: vaultPath,
    tags,
    headings,
    frontmatter: (cache.frontmatter ?? {}) as Record<string, unknown>,
    outboundLinks,
    stat: { size: file.stat?.size, mtime: file.stat?.mtime },
  };
}

function normalizeTag(t: string): string {
  const stripped = t.trim().replace(/^#/, "");
  return stripped.length > 0 ? `#${stripped}` : "";
}

function collectFrontmatterTags(fm: Record<string, unknown> | undefined): string[] {
  if (!fm) return [];
  const raw = (fm as { tags?: unknown; tag?: unknown }).tags ??
    (fm as { tags?: unknown; tag?: unknown }).tag;
  if (raw == null) return [];
  if (typeof raw === "string") {
    return raw
      .split(/[\s,]+/)
      .map(normalizeTag)
      .filter((t) => t.length > 0);
  }
  if (Array.isArray(raw)) {
    return raw
      .filter((t): t is string => typeof t === "string")
      .map(normalizeTag)
      .filter((t) => t.length > 0);
  }
  return [];
}
