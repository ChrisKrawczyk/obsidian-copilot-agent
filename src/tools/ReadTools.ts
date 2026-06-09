import { defineTool, type Tool } from "@github/copilot-sdk";
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
 * They are registered with `skipPermission: true`. The Phase-2
 * universal permission gate (`denyAll`) still rejects all
 * SDK-managed tool requests; our custom read tools are vault-scoped,
 * path-validated, and read-only — so it's safe to bypass the prompt
 * for v0.1. Phase 6 introduces the SafetyPolicy that will gate
 * writes; Phase 5 keeps the read story simple to make the
 * "agent reads my notes" demo work end-to-end.
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
        "Search the active Obsidian vault for a substring (or regex) " +
        "across all markdown files. Returns up to 50 matches with " +
        "{ path, line, snippet }.",
      parameters: {
        type: "object",
        required: ["query"],
        properties: {
          query: {
            type: "string",
            description: "Substring or regex to find.",
          },
          regex: {
            type: "boolean",
            description: "When true, treat `query` as a JS regex source.",
          },
        },
        additionalProperties: false,
      },
      skipPermission: true,
      handler: async (args: unknown) => {
        const parsed = (args ?? {}) as { query?: unknown; regex?: unknown };
        if (typeof parsed.query !== "string" || parsed.query.length === 0) {
          throw new Error("`query` is required and must be a non-empty string");
        }
        return await searchContentImpl(
          parsed.query,
          Boolean(parsed.regex),
          vault,
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

// ---- arg parsing ----

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
