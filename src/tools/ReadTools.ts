import { defineTool, type Tool } from "@github/copilot-sdk";
import { prepareSimpleSearch, prepareFuzzySearch } from "obsidian";
import {
  resolveVaultPath,
  toVaultRelative,
  lookupTFile,
  VaultPathError,
} from "./VaultPath";

/**
 * Minimal vault surface our read tools depend on. Keeping this
 * narrow lets tests pass in a plain fixture instead of mocking the
 * entire Obsidian `Vault` class.
 */
export interface ReadToolsVault {
  adapter: { getBasePath?: () => string };
  getFileByPath?: (p: string) => TFileLike | null;
  getAbstractFileByPath?: (p: string) => TFileLike | null;
  getMarkdownFiles?: () => TFileLike[];
  getFiles?: () => TFileLike[];
  read?: (file: TFileLike) => Promise<string>;
  cachedRead?: (file: TFileLike) => Promise<string>;
}

/** Subset of `TFile` we touch. */
export interface TFileLike {
  path: string;
  extension?: string;
  /** File stat block. Present on Obsidian's real `TFile`; optional
   *  for test doubles that only exercise path-based logic. */
  stat?: { size?: number; mtime?: number };
}

/** Maximum entries returned by `view` to keep huge vaults from drowning the model. */
const MAX_VIEW_ENTRIES = 500;
/** Maximum bytes returned by `read_file` to keep model context bounded. */
const MAX_READ_BYTES = 256 * 1024;
/** Maximum matches surfaced from `search_content` per call. */
const MAX_SEARCH_MATCHES = 50;
/** Maximum characters of snippet around a search match. */
const SNIPPET_RADIUS = 80;

/**
 * Build the three Phase-5 read tools. The returned `Tool` objects are
 * passed verbatim to `client.createSession({ tools: [...] })`.
 *
 * All three tools share the same defensive pattern:
 *
 *   1. Validate the path with `resolveVaultPath` (absolute / `..` /
 *      symlink-escape rejected).
 *   2. Look the path up in Obsidian's known-files index so the agent
 *      can only touch files Obsidian tracks (a second line of defence
 *      against fs-level surprises).
 *   3. Delegate the actual I/O to Obsidian's `Vault` API so any
 *      pending modifications in the editor are flushed first.
 *
 * They are registered with `skipPermission: true` — i.e. they bypass
 * the universal SDK permission gate that every other tool flows
 * through. This is a deliberate exemption for read-only, vault-scoped,
 * path-validated tools. The "single deny-by-default permission gate"
 * invariant still holds for everything that mutates state (writes,
 * MCP, shell, web_fetch, view, etc.) — only side-effect-free reads
 * over a path-validated scope are exempt.
 *
 * **Checklist for future tool authors deciding whether to set
 * `skipPermission: true`** — ALL of these must be true:
 *   - Tool is strictly read-only (no filesystem, network, or external
 *     side effects whatsoever).
 *   - All inputs that select a resource are validated by something
 *     equivalent to {@link VaultPath.fromUserInput} (rejects absolute
 *     paths, `..`, symlinks-out-of-scope, and other escape vectors).
 *   - Resolved targets are guaranteed to live inside an explicit,
 *     pre-declared scope (vault root for v0.1; extra-vault roots when
 *     they land).
 *   - The data exposed to the model is bounded (no unbounded directory
 *     walks, no following symlinks out of scope, no reading binary
 *     blobs that aren't markdown/text).
 * If any checklist item is uncertain, default to NOT setting
 * `skipPermission` and let SafetyPolicy decide — the prompt is cheap,
 * and consistency with the rest of the gate is more valuable than
 * shaving a click for an edge case.
 */
export function createReadTools(vault: ReadToolsVault): Tool[] {
  return [
    defineTool("read_file", {
      description:
        "Read the full contents of a single markdown note from the " +
        "active Obsidian vault. The path is vault-relative (e.g. " +
        '"inbox/today.md"). Absolute paths and paths containing ".." ' +
        "are rejected.",
      parameters: {
        type: "object",
        required: ["path"],
        properties: {
          path: {
            type: "string",
            description: "Vault-relative path to the note.",
          },
        },
        additionalProperties: false,
      },
      overridesBuiltInTool: true,
      skipPermission: true,
      handler: async (args: unknown) => {
        const { path: rawPath } = parseArgs(args, ["path"]);
        return await readFileImpl(rawPath, vault);
      },
    }),

    defineTool("view", {
      description:
        "List files and folders in the active Obsidian vault. Pass " +
        "`directory` (or `path`) to scope the listing; omit both to " +
        "list the vault root. Paths are vault-relative; absolute " +
        "paths are rejected. Results capped at " +
        `${MAX_VIEW_ENTRIES} entries.`,
      parameters: {
        type: "object",
        properties: {
          directory: {
            type: "string",
            description:
              "Vault-relative directory to list. Omit to list the vault root.",
          },
          path: {
            type: "string",
            description:
              "Alias for `directory`. Built-in `view` callers may " +
              "pass `path` instead; both are accepted.",
          },
        },
        additionalProperties: false,
      },
      overridesBuiltInTool: true,
      skipPermission: true,
      handler: async (args: unknown) => {
        const parsed = (args ?? {}) as {
          directory?: unknown;
          path?: unknown;
        };
        const dir =
          typeof parsed.directory === "string"
            ? parsed.directory
            : typeof parsed.path === "string"
              ? parsed.path
              : "";
        return await viewImpl(dir, vault);
      },
    }),

    defineTool("search_content", {
      description:
        "Search the active Obsidian vault for text across all markdown " +
        "files. Modes: 'substring' (default; literal case-sensitive), " +
        "'regex' (JS regex source), 'simple' (whitespace-AND ranked), " +
        "'fuzzy' (character-subsequence ranked, tolerant of dropped " +
        "chars). Ranked modes include a numeric score and per-match " +
        "char spans. Returns up to 50 matches with " +
        "{ path, line, snippet } (plus score/spans for ranked modes).",
      parameters: {
        type: "object",
        required: ["query"],
        properties: {
          query: {
            type: "string",
            description: "Query text (or regex source when mode='regex').",
          },
          regex: {
            type: "boolean",
            description:
              "Legacy: when true and `mode` is omitted, treat `query` " +
              "as a JS regex source. Equivalent to mode='regex'.",
          },
          mode: {
            type: "string",
            enum: ["substring", "regex", "simple", "fuzzy"],
            description:
              "Search mode. 'substring' (default) and 'regex' preserve " +
              "the legacy behavior. 'simple' and 'fuzzy' return ranked " +
              "results with per-match spans.",
          },
        },
        additionalProperties: false,
      },
      skipPermission: true,
      handler: async (args: unknown) => {
        const parsed = (args ?? {}) as {
          query?: unknown;
          regex?: unknown;
          mode?: unknown;
        };
        if (typeof parsed.query !== "string" || parsed.query.length === 0) {
          throw new Error("`query` is required and must be a non-empty string");
        }
        const modeArg =
          typeof parsed.mode === "string" ? parsed.mode : undefined;
        if (
          modeArg !== undefined &&
          modeArg !== "substring" &&
          modeArg !== "regex" &&
          modeArg !== "simple" &&
          modeArg !== "fuzzy"
        ) {
          throw new Error(
            `Invalid mode: "${modeArg}". Expected one of substring, regex, simple, fuzzy.`,
          );
        }
        // Legacy back-compat: when `mode` is omitted, `regex: true`
        // routes to regex mode; otherwise substring mode. This
        // preserves byte-for-byte output for existing callers.
        const isRegex = Boolean(parsed.regex);
        if (modeArg === undefined) {
          return await searchContentImpl(parsed.query, isRegex, vault);
        }
        return await searchInFiles(
          (vault.getMarkdownFiles && vault.getMarkdownFiles()) ?? [],
          parsed.query,
          vault,
          { mode: modeArg },
        );
      },
    }),
  ];
}

// ---- handler implementations (exported for unit-test use) ----

export async function readFileImpl(
  rawPath: string,
  vault: ReadToolsVault,
): Promise<{ path: string; content: string; truncated?: boolean }> {
  try {
    const absPath = resolveVaultPath(rawPath, vault);
    const vaultPath = toVaultRelative(absPath, vault);

    const tFile = lookupTFile(vaultPath, vault) as TFileLike | null;
    if (!tFile) {
      throw new Error(
        `File not found in vault: "${rawPath}". Use the \`view\` tool ` +
          "to list available files.",
      );
    }

    let content: string;
    if (typeof vault.read === "function") {
      content = await vault.read(tFile);
    } else if (typeof vault.cachedRead === "function") {
      content = await vault.cachedRead(tFile);
    } else {
      throw new Error("Vault has no read method");
    }

    if (content.length > MAX_READ_BYTES) {
      return {
        path: vaultPath,
        content: content.slice(0, MAX_READ_BYTES),
        truncated: true,
      };
    }
    return { path: vaultPath, content };
  } catch (err) {
    if (err instanceof VaultPathError) {
      throw new Error(err.message);
    }
    throw err;
  }
}

export async function viewImpl(
  rawDir: string,
  vault: ReadToolsVault,
): Promise<{
  directory: string;
  entries: Array<{ path: string }>;
  totalEntries: number;
  truncated: boolean;
}> {
  const allFiles =
    (vault.getFiles && vault.getFiles()) ??
    (vault.getMarkdownFiles && vault.getMarkdownFiles()) ??
    [];

  let scoped: TFileLike[];
  let dirLabel: string;
  if (rawDir.trim().length === 0) {
    dirLabel = "";
    scoped = allFiles;
  } else {
    // Validate the directory path (we don't dereference it on disk —
    // just use it as a prefix filter on the known-files index).
    let absDir: string;
    try {
      absDir = resolveVaultPath(rawDir, vault);
    } catch (err) {
      if (err instanceof VaultPathError) throw new Error(err.message);
      throw err;
    }
    const vaultDir = toVaultRelative(absDir, vault);
    const prefix = vaultDir.endsWith("/") ? vaultDir : `${vaultDir}/`;
    dirLabel = vaultDir;
    scoped = allFiles.filter(
      (f) => f.path === vaultDir || f.path.startsWith(prefix),
    );
  }

  const truncated = scoped.length > MAX_VIEW_ENTRIES;
  const entries = (truncated ? scoped.slice(0, MAX_VIEW_ENTRIES) : scoped).map(
    (f) => ({ path: f.path }),
  );
  return {
    directory: dirLabel,
    entries,
    totalEntries: scoped.length,
    truncated,
  };
}

export async function searchContentImpl(
  query: string,
  isRegex: boolean,
  vault: ReadToolsVault,
): Promise<{
  matches: Array<{ path: string; line: number; snippet: string }>;
  totalMatches: number;
  truncated: boolean;
}> {
  const files = (vault.getMarkdownFiles && vault.getMarkdownFiles()) ?? [];

  let matcher: (line: string) => number;
  if (isRegex) {
    let re: RegExp;
    try {
      re = new RegExp(query);
    } catch (err) {
      throw new Error(
        `Invalid regex: ${(err as Error).message || String(err)}`,
      );
    }
    matcher = (line: string) => {
      const m = re.exec(line);
      return m ? m.index : -1;
    };
  } else {
    matcher = (line: string) => line.indexOf(query);
  }

  const matches: Array<{ path: string; line: number; snippet: string }> = [];
  let total = 0;
  let truncated = false;

  outer: for (const f of files) {
    // Defense-in-depth: Obsidian's known-files index can include a
    // symlinked markdown file whose realpath lies outside the vault
    // root. `resolveVaultPath` runs the same containment check used
    // by `read_file` so `search_content` can never leak extra-vault
    // content. Files that fail validation are silently skipped (the
    // model shouldn't see them at all).
    try {
      resolveVaultPath(f.path, vault);
    } catch {
      continue;
    }
    let content: string;
    try {
      if (typeof vault.cachedRead === "function") {
        content = await vault.cachedRead(f);
      } else if (typeof vault.read === "function") {
        content = await vault.read(f);
      } else {
        continue;
      }
    } catch {
      continue;
    }

    const lines = content.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const idx = matcher(lines[i]);
      if (idx < 0) continue;
      total++;
      if (matches.length < MAX_SEARCH_MATCHES) {
        const start = Math.max(0, idx - SNIPPET_RADIUS);
        const end = Math.min(
          lines[i].length,
          idx + query.length + SNIPPET_RADIUS,
        );
        matches.push({
          path: f.path,
          line: i + 1,
          snippet: lines[i].slice(start, end),
        });
      } else {
        truncated = true;
        // Don't bail entirely — keep counting so callers know how
        // under-specified the query is.
        if (total >= MAX_SEARCH_MATCHES * 4) break outer;
      }
    }
  }

  return { matches, totalMatches: total, truncated };
}

// ---- searchInFiles: new ranked/fuzzy search helper ---------------------
//
// Additive helper introduced for Phase 1 of the agent-native vault
// tools work. It sits alongside — not on top of — `searchContentImpl`
// so the legacy substring/regex path stays byte-for-byte identical
// (per SC-003). New modes ("simple", "fuzzy") return per-match
// `score` and `spans`; substring/regex modes return the same shape as
// the legacy helper. This is also the seam `search_vault` (Phase 3)
// uses to pass its own `limit`.

export interface SearchInFilesOptions {
  mode: "substring" | "regex" | "simple" | "fuzzy";
  /**
   * Maximum number of matches to keep. Defaults to
   * `MAX_SEARCH_MATCHES` (50) — the same cap `search_content` has
   * always used. Callers such as `search_vault` may pass a larger
   * limit to enforce their own cap.
   */
  limit?: number;
}

export interface SearchMatch {
  path: string;
  line: number;
  snippet: string;
  /** Present only for ranked modes ("simple", "fuzzy"). */
  score?: number;
  /**
   * Character offsets of the matched text within the returned line.
   * Present only for ranked modes.
   */
  spans?: Array<[number, number]>;
}

export interface SearchInFilesResult {
  matches: SearchMatch[];
  totalMatches: number;
  truncated: boolean;
}

export async function searchInFiles(
  files: TFileLike[],
  query: string,
  vault: ReadToolsVault,
  options: SearchInFilesOptions,
): Promise<SearchInFilesResult> {
  const limit = options.limit ?? MAX_SEARCH_MATCHES;

  if (options.mode === "substring" || options.mode === "regex") {
    return await searchInFilesUnranked(
      files,
      query,
      options.mode === "regex",
      vault,
      limit,
    );
  }
  return await searchInFilesRanked(files, query, options.mode, vault, limit);
}

async function searchInFilesUnranked(
  files: TFileLike[],
  query: string,
  isRegex: boolean,
  vault: ReadToolsVault,
  limit: number,
): Promise<SearchInFilesResult> {
  let matcher: (line: string) => number;
  if (isRegex) {
    let re: RegExp;
    try {
      re = new RegExp(query);
    } catch (err) {
      throw new Error(
        `Invalid regex: ${(err as Error).message || String(err)}`,
      );
    }
    matcher = (line: string) => {
      const m = re.exec(line);
      return m ? m.index : -1;
    };
  } else {
    matcher = (line: string) => line.indexOf(query);
  }

  const matches: SearchMatch[] = [];
  let total = 0;
  let truncated = false;

  outer: for (const f of files) {
    try {
      resolveVaultPath(f.path, vault);
    } catch {
      continue;
    }
    let content: string;
    try {
      if (typeof vault.cachedRead === "function") {
        content = await vault.cachedRead(f);
      } else if (typeof vault.read === "function") {
        content = await vault.read(f);
      } else {
        continue;
      }
    } catch {
      continue;
    }

    const lines = content.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const idx = matcher(lines[i]);
      if (idx < 0) continue;
      total++;
      if (matches.length < limit) {
        const start = Math.max(0, idx - SNIPPET_RADIUS);
        const end = Math.min(
          lines[i].length,
          idx + query.length + SNIPPET_RADIUS,
        );
        matches.push({
          path: f.path,
          line: i + 1,
          snippet: lines[i].slice(start, end),
        });
      } else {
        truncated = true;
        if (total >= limit * 4) break outer;
      }
    }
  }

  return { matches, totalMatches: total, truncated };
}

async function searchInFilesRanked(
  files: TFileLike[],
  query: string,
  mode: "simple" | "fuzzy",
  vault: ReadToolsVault,
  limit: number,
): Promise<SearchInFilesResult> {
  const prepared =
    mode === "simple" ? prepareSimpleSearch(query) : prepareFuzzySearch(query);

  const all: SearchMatch[] = [];

  for (const f of files) {
    try {
      resolveVaultPath(f.path, vault);
    } catch {
      continue;
    }
    let content: string;
    try {
      if (typeof vault.cachedRead === "function") {
        content = await vault.cachedRead(f);
      } else if (typeof vault.read === "function") {
        content = await vault.read(f);
      } else {
        continue;
      }
    } catch {
      continue;
    }

    const lines = content.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const result = prepared(line);
      if (!result || result.matches.length === 0) continue;
      const firstIdx = result.matches[0][0];
      const start = Math.max(0, firstIdx - SNIPPET_RADIUS);
      const end = Math.min(line.length, firstIdx + SNIPPET_RADIUS);
      all.push({
        path: f.path,
        line: i + 1,
        snippet: line.slice(start, end),
        score: result.score,
        spans: result.matches.map(([s, e]) => [s, e] as [number, number]),
      });
    }
  }

  // Rank by score desc; stable secondary ordering by path asc, then
  // line asc, so tests can pin an exact sequence.
  all.sort((a, b) => {
    const ds = (b.score ?? 0) - (a.score ?? 0);
    if (ds !== 0) return ds;
    if (a.path < b.path) return -1;
    if (a.path > b.path) return 1;
    return a.line - b.line;
  });

  const truncated = all.length > limit;
  return {
    matches: truncated ? all.slice(0, limit) : all,
    totalMatches: all.length,
    truncated,
  };
}

function parseArgs<K extends string>(
  args: unknown,
  required: K[],
): Record<K, string> {
  if (typeof args !== "object" || args === null) {
    throw new Error("Tool arguments must be an object");
  }
  const out: Record<string, string> = {};
  for (const key of required) {
    const v = (args as Record<string, unknown>)[key];
    if (typeof v !== "string") {
      throw new Error(`Argument \`${key}\` is required and must be a string`);
    }
    out[key] = v;
  }
  return out as Record<K, string>;
}
