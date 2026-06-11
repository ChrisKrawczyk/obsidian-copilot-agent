/**
 * ObsidianApi — narrow, test-friendly wrapper around the bits of the
 * Obsidian `App` surface that Phase 3 (read-only) and Phase 4 (mutating)
 * tools depend on. We avoid `import { App } from "obsidian"` here for
 * two reasons:
 *
 *   1. The `obsidian` module is not resolvable at unit-test time (vitest
 *      runs in Node — Obsidian provides the symbol at plugin-load time).
 *   2. Each test can pass a hand-rolled fixture that returns the exact
 *      `{ ok: true, value }` / `{ ok: false, reason }` shape we want to
 *      exercise, without having to mock the whole `App` class.
 *
 * Phase 3 (this file) implements only the read-side surface. Phase 4
 * will extend the class with `openFile`, `getEditorForActive`,
 * `applyEditorTransform`, `getDailyNotesConfig`, `isCommunityPluginEnabled`,
 * `createNote`, and `modifyNote`.
 *
 * Every method returns a discriminated union — never throws — so callers
 * (the tool handlers) can translate the union into a structured tool
 * error response without wrapping every call in `try`/`catch`.
 */

import { resolveVaultPath, toVaultRelative, VaultPathError } from "./VaultPath";
import type { ReadToolsVault, TFileLike } from "./ReadTools";

/** Discriminated-union result type — every ObsidianApi method returns this. */
export type ApiResult<T> =
  | { ok: true; value: T }
  | {
      ok: false;
      reason:
        | "no-active-note"
        | "no-editor"
        | "plugin-not-enabled"
        | "native-failed"
        | "index-unavailable"
        | "not-found"
        | "not-a-folder"
        | "invalid-path"
        | "metadata-cache-not-ready";
      cause?: unknown;
    };

/** Per-file metadata cache shape — the parts Phase 3 actually reads. */
export interface FileCacheLike {
  tags?: Array<{ tag: string; position?: unknown }>;
  headings?: Array<{ heading: string; level: number; position?: unknown }>;
  frontmatter?: Record<string, unknown>;
  links?: Array<{
    link: string;
    original: string;
    position?: unknown;
  }>;
  /**
   * Tasks/list items discovered by Obsidian's metadata cache. `task`
   * is the status char inside `[ ]` (e.g. `' '`, `'/'`, `'x'`, `'-'`)
   * when the list item is a task; absent for plain bullets.
   * `position.start.line` is **0-based** (Obsidian convention).
   */
  listItems?: Array<{
    position: { start: { line: number }; end?: { line: number } };
    task?: string;
  }>;
}

/** Editor-like surface used by Phase 4 mutating tools. */
export interface EditorLike {
  getValue(): string;
  setValue?(text: string): void;
  replaceRange?(text: string, from: EditorPos, to?: EditorPos): void;
  getCursor?(): EditorPos;
  setCursor?(pos: EditorPos): void;
}
export interface EditorPos {
  line: number;
  ch: number;
}

/** Daily Notes plugin config as exposed by the internal plugin. */
export interface DailyNotesConfig {
  folder?: string;
  format?: string;
  template?: string;
}

/**
 * Narrow App-like surface. Every field is optional so tests can supply
 * exactly the pieces a given assertion needs.
 */
export interface AppLike {
  vault: ReadToolsVault & {
    create?: (path: string, data: string) => Promise<unknown>;
    modify?: (file: TFileLike, data: string) => Promise<void>;
  };
  workspace?: {
    getActiveFile?: () => TFileLike | null;
    getActiveViewOfType?: (kind: unknown) => {
      editor?: EditorLike;
      file?: TFileLike;
    } | null;
    getLeaf?: (newLeaf?: boolean) => {
      openFile: (file: TFileLike) => Promise<void>;
    } | null;
    /**
     * v0.3 Phase 2 (FR-018): open a note by its link text (path or
     * basename). The third argument is `newLeaf` — pass `false` to
     * reuse the active leaf. Optional because older builds and test
     * doubles may not implement it; the renderer treats absence as
     * "best-effort no-op."
     */
    openLinkText?: (
      linktext: string,
      sourcePath: string,
      newLeaf?: boolean,
    ) => void | Promise<void>;
    /** Symbol to pass to getActiveViewOfType; supplied by `obsidian` at runtime. */
    markdownViewSymbol?: unknown;
  };
  metadataCache?: {
    resolvedLinks?: Record<string, Record<string, number>>;
    getFileCache?: (file: TFileLike) => FileCacheLike | null;
    /**
     * Native Obsidian: returns a record mapping tag-strings (WITH the
     * leading `#`, e.g. `"#project/work"`) to the number of times that
     * tag occurs across the vault. Optional because older Obsidian
     * builds and our test doubles don't always implement it; the
     * `listAllTags()` wrapper falls back to scanning `getFileCache()`
     * per markdown file when this is absent. Both code paths produce
     * the same `Record<"#tag", number>` shape.
     */
    getTags?: () => Record<string, number>;
  };
  /** `app.internalPlugins.plugins['daily-notes']?.instance?.options`. */
  internalPlugins?: {
    plugins?: Record<
      string,
      { instance?: { options?: DailyNotesConfig } } | undefined
    >;
  };
  /** `app.plugins.plugins[id]`. */
  plugins?: {
    plugins?: Record<string, unknown>;
  };
}

/** Node returned by `getVaultTree`. */
export interface TreeNode {
  name: string;
  path: string;
  kind: "file" | "folder";
  size?: number;
  mtime?: number;
  children?: TreeNode[];
}

/** A folder/file pair returned from `app.vault.getAbstractFileByPath`. */
interface AbstractFileLike {
  path: string;
  name?: string;
  children?: AbstractFileLike[];
  stat?: { size?: number; mtime?: number };
  /** Discriminator: `extension` is only set on files; folders have `children`. */
  extension?: string;
}

/** Maximum nodes a single `getVaultTree` call may return. */
export const MAX_TREE_NODES = 500;
/** Hard cap on the `depth` parameter accepted by `getVaultTree`. */
export const MAX_TREE_DEPTH = 5;
/** Default `depth` when the caller omits it. */
export const DEFAULT_TREE_DEPTH = 2;

export class ObsidianApi {
  constructor(private readonly app: AppLike) {}

  /**
   * The note currently focused in the active markdown editor — or
   * `{ ok: false, reason: 'no-active-note' }` if no markdown view is
   * focused. **Non-markdown active files (PDF, canvas, image, etc.)
   * are treated as no-active-note** so the read-only contract for
   * `get_active_note` cannot be tricked into reading binary blobs.
   */
  getActiveFile(): ApiResult<TFileLike> {
    let file: TFileLike | null = null;
    try {
      file = this.app.workspace?.getActiveFile?.() ?? null;
    } catch (e) {
      return { ok: false, reason: "native-failed", cause: e };
    }
    if (!file) {
      return { ok: false, reason: "no-active-note" };
    }
    const ext = (file as { extension?: string }).extension;
    const lowerPath = file.path.toLowerCase();
    const isMarkdown =
      (typeof ext === "string" && ext.toLowerCase() === "md") ||
      lowerPath.endsWith(".md");
    if (!isMarkdown) {
      return { ok: false, reason: "no-active-note" };
    }
    return { ok: true, value: file };
  }

  /**
   * Up to `maxN` markdown files sorted by `TFile.stat.mtime` descending.
   * `maxN` is clamped to [1, 100]. Falls back gracefully when `stat` is
   * missing (preserves insertion order for those entries).
   */
  listRecentlyModifiedNotes(maxN: number): ApiResult<TFileLike[]> {
    if (typeof this.app.vault.getMarkdownFiles !== "function") {
      return { ok: false, reason: "index-unavailable" };
    }
    const n = Math.max(1, Math.min(100, Math.floor(maxN) || 20));
    try {
      const files = this.app.vault.getMarkdownFiles();
      const sorted = [...files].sort((a, b) => {
        const am = (a as { stat?: { mtime?: number } }).stat?.mtime ?? 0;
        const bm = (b as { stat?: { mtime?: number } }).stat?.mtime ?? 0;
        return bm - am;
      });
      return { ok: true, value: sorted.slice(0, n) };
    } catch (e) {
      return { ok: false, reason: "native-failed", cause: e };
    }
  }

  /**
   * `metadataCache.resolvedLinks` — a record `sourcePath → { targetPath: count }`.
   * Used by `find_backlinks` as the primary index.
   */
  getResolvedLinks(): ApiResult<Record<string, Record<string, number>>> {
    try {
      const rl = this.app.metadataCache?.resolvedLinks;
      if (!rl) {
        return { ok: false, reason: "index-unavailable" };
      }
      return { ok: true, value: rl };
    } catch (e) {
      return { ok: false, reason: "native-failed", cause: e };
    }
  }

  /**
   * Per-file cache: tags, headings, frontmatter, links (with `original`
   * for link-form discrimination). Required by `find_backlinks` to
   * distinguish wikilinks from markdown links, and by `vault_metadata`.
   */
  getFileCache(file: TFileLike): ApiResult<FileCacheLike> {
    const mc = this.app.metadataCache;
    if (!mc || typeof mc.getFileCache !== "function") {
      return { ok: false, reason: "index-unavailable" };
    }
    try {
      // Call as a method so Obsidian's `this`-sensitive native impl works.
      const cache = mc.getFileCache(file);
      if (!cache) {
        return { ok: false, reason: "not-found" };
      }
      return { ok: true, value: cache };
    } catch (e) {
      return { ok: false, reason: "native-failed", cause: e };
    }
  }

  /**
   * v0.3 Phase 2: list every distinct tag in the vault, paired with its
   * occurrence count. Native Obsidian exposes `metadataCache.getTags()`
   * which already returns a `Record<"#tag", number>` shape; when that
   * call is missing (older Obsidian builds / some test doubles) we
   * fall back to scanning `getFileCache()` for each markdown file and
   * tallying both the inline `cache.tags` and frontmatter `tags`/`tag`
   * fields. Both code paths produce the SAME shape (keys retain the
   * leading `#`) so callers don't need to branch on which path ran.
   *
   * Returns `metadata-cache-not-ready` only when both the native API
   * is absent AND the file-cache fallback can't run (no markdown
   * file iterator, or `getFileCache` is missing). This lets the agent
   * retry per the "metadata cache populating" risk in the spec.
   */
  listAllTags(): ApiResult<Record<string, number>> {
    const mc = this.app.metadataCache;
    if (mc && typeof mc.getTags === "function") {
      try {
        const raw = mc.getTags();
        if (raw && typeof raw === "object") {
          // Trust Obsidian's shape but defensively normalise: keys
          // missing the `#` get one prepended; non-numeric counts
          // coerce to 0; empty keys drop out.
          const out: Record<string, number> = {};
          for (const [k, v] of Object.entries(raw)) {
            const norm = normalizeTagKey(k);
            if (!norm) continue;
            const count = typeof v === "number" && Number.isFinite(v) ? v : 0;
            out[norm] = (out[norm] ?? 0) + count;
          }
          return { ok: true, value: out };
        }
      } catch (e) {
        return { ok: false, reason: "native-failed", cause: e };
      }
    }
    // Fallback: walk all markdown files, tally tags via getFileCache.
    if (
      typeof this.app.vault.getMarkdownFiles !== "function" ||
      !mc ||
      typeof mc.getFileCache !== "function"
    ) {
      return { ok: false, reason: "metadata-cache-not-ready" };
    }
    try {
      const tally: Record<string, number> = {};
      const files = this.app.vault.getMarkdownFiles();
      for (const file of files) {
        const cache = mc.getFileCache(file);
        if (!cache) continue;
        for (const t of collectFileTagsForFallback(cache)) {
          tally[t] = (tally[t] ?? 0) + 1;
        }
      }
      return { ok: true, value: tally };
    } catch (e) {
      return { ok: false, reason: "native-failed", cause: e };
    }
  }

  /**
   * v0.3 Phase 2: every markdown file whose metadata cache reports the
   * given tag (matching is exact and case-sensitive on the post-`#`
   * string — Obsidian itself preserves case in its cache). Input may
   * include or omit a leading `#`. Falls back to scanning `getFileCache`
   * per markdown file, since Obsidian doesn't expose a single bulk
   * "files-with-tag" call.
   */
  findFilesByTag(rawTag: string): ApiResult<TFileLike[]> {
    const target = normalizeTagKey(rawTag);
    if (!target) {
      return { ok: false, reason: "invalid-path", cause: "empty tag" };
    }
    const mc = this.app.metadataCache;
    if (
      typeof this.app.vault.getMarkdownFiles !== "function" ||
      !mc ||
      typeof mc.getFileCache !== "function"
    ) {
      return { ok: false, reason: "metadata-cache-not-ready" };
    }
    try {
      const files = this.app.vault.getMarkdownFiles();
      const matches: TFileLike[] = [];
      for (const file of files) {
        const cache = mc.getFileCache(file);
        if (!cache) continue;
        const fileTags = collectFileTagsForFallback(cache);
        if (fileTags.has(target)) {
          matches.push(file);
        }
      }
      return { ok: true, value: matches };
    } catch (e) {
      return { ok: false, reason: "native-failed", cause: e };
    }
  }

  /**
   * Recursive walk of the vault folder at `folder` (vault-relative;
   * empty string == root), bounded by `depth` and `MAX_TREE_NODES`.
   *
   * Validates `folder` with `resolveVaultPath` so symlink/.. escapes are
   * rejected even when the caller supplies a hostile path. Returns
   * `not-found` if Obsidian doesn't know about the path, and
   * `not-a-folder` if it resolves to a file.
   */
  getVaultTree(
    folder: string,
    depth: number = DEFAULT_TREE_DEPTH,
  ): ApiResult<{
    root: TreeNode;
    nodeCount: number;
    truncated: boolean;
    truncatedAt?: string;
  }> {
    // Folder may be empty → vault root. Anything else must validate.
    let folderVaultPath = "";
    if (folder.trim().length > 0) {
      try {
        const abs = resolveVaultPath(folder, this.app.vault);
        folderVaultPath = toVaultRelative(abs, this.app.vault);
      } catch (e) {
        if (e instanceof VaultPathError) {
          return { ok: false, reason: "invalid-path", cause: e.message };
        }
        return { ok: false, reason: "invalid-path", cause: e };
      }
    }

    const getter = this.app.vault.getAbstractFileByPath;
    if (typeof getter !== "function") {
      return { ok: false, reason: "index-unavailable" };
    }

    // Vault root lookup: many Obsidian APIs accept `""` for root; some
    // accept `"/"`. We try `""` first, then `"/"`, then fall back to
    // `getMarkdownFiles()` only as a last resort.
    let abstract: AbstractFileLike | null = null;
    try {
      if (folderVaultPath === "") {
        abstract =
          (getter("") as AbstractFileLike | null) ??
          (getter("/") as AbstractFileLike | null);
        // Synthesize a root with `children` from `getMarkdownFiles` when
        // the abstract API doesn't model the vault root (test fixtures).
        if (
          !abstract &&
          typeof this.app.vault.getMarkdownFiles === "function"
        ) {
          const files = this.app.vault.getMarkdownFiles();
          abstract = {
            path: "",
            name: "",
            children: files.map((f) => ({
              path: f.path,
              name: f.path.split("/").pop() ?? f.path,
              extension: f.extension,
              stat: (f as { stat?: { size?: number; mtime?: number } }).stat,
            })),
          };
        }
      } else {
        abstract = getter(folderVaultPath) as AbstractFileLike | null;
      }
    } catch (e) {
      return { ok: false, reason: "native-failed", cause: e };
    }

    if (!abstract) {
      return { ok: false, reason: "not-found" };
    }
    if (abstract.extension !== undefined && !abstract.children) {
      return { ok: false, reason: "not-a-folder" };
    }

    const clampedDepth = Math.max(
      0,
      Math.min(MAX_TREE_DEPTH, Math.floor(depth)),
    );
    const counter = { count: 0, truncatedAt: undefined as string | undefined };

    const root: TreeNode = walkFolder(abstract, clampedDepth, counter);
    return {
      ok: true,
      value: {
        root,
        nodeCount: counter.count,
        truncated: counter.truncatedAt !== undefined,
        truncatedAt: counter.truncatedAt,
      },
    };
  }

  // ----- Phase 4 helper methods -----
  //
  // These are wired up here in Phase 3 so the ObsidianApi surface is
  // complete (per ImplementationPlan.md Phase 3 spec). The Phase 4
  // mutating tools that consume them land in `WriteNoteTools.ts` later.
  // Each method follows the same discriminated-union contract.

  /**
   * Open a file in the active workspace pane (no new leaf). Phase 4's
   * `open_note` tool wraps this. Returns `native-failed` if the workspace
   * has no leaf available (rare on desktop, possible during shutdown).
   */
  async openFile(file: TFileLike): Promise<ApiResult<void>> {
    const ws = this.app.workspace;
    if (!ws || typeof ws.getLeaf !== "function") {
      return { ok: false, reason: "native-failed", cause: "no getLeaf" };
    }
    try {
      // Call as a method on `workspace` so Obsidian's `this`-sensitive
      // native impl is invoked correctly when no shim is interposed.
      const leaf = ws.getLeaf(false);
      if (!leaf) {
        return { ok: false, reason: "native-failed", cause: "no leaf" };
      }
      await leaf.openFile(file);
      return { ok: true, value: undefined };
    } catch (e) {
      return { ok: false, reason: "native-failed", cause: e };
    }
  }

  /**
   * Return the active markdown editor surface, or `no-editor` when no
   * markdown view is focused. Phase 4's `insert_into_active_note`
   * consumes this via `applyEditorTransform`.
   */
  getEditorForActive(): ApiResult<{ editor: EditorLike; file: TFileLike }> {
    const ws = this.app.workspace;
    if (!ws || typeof ws.getActiveViewOfType !== "function") {
      return { ok: false, reason: "no-editor" };
    }
    const sym = ws.markdownViewSymbol;
    try {
      // Call as a method so Obsidian's `this`-sensitive native impl works.
      const view = ws.getActiveViewOfType(sym);
      if (!view || !view.editor || !view.file) {
        return { ok: false, reason: "no-editor" };
      }
      return { ok: true, value: { editor: view.editor, file: view.file } };
    } catch (e) {
      return { ok: false, reason: "native-failed", cause: e };
    }
  }

  /**
   * Apply an `append`/`prepend`/`replace` transform to the active editor
   * with the cursor behavior specified by FR-012:
   *
   *   - append:  insert at end-of-document; cursor stays at its existing
   *              position.
   *   - prepend: insert at (0, 0); cursor shifts forward by the count
   *              of inserted lines/columns.
   *   - replace: overwrite the entire buffer; cursor moves to the end
   *              of the inserted content.
   *
   * Uses `Editor.replaceRange` (not `setValue`) so Obsidian records the
   * change in its native undo stack and so any active selections /
   * marks survive where applicable.
   */
  applyEditorTransform(
    mode: "append" | "prepend" | "replace",
    content: string,
  ): ApiResult<{ value: string; cursor: EditorPos }> {
    const ed = this.getEditorForActive();
    if (!ed.ok) return ed;
    try {
      const editor = ed.value.editor;
      if (typeof editor.replaceRange !== "function") {
        return { ok: false, reason: "no-editor" };
      }
      const existing = editor.getValue();
      const existingLines = existing.split("\n");
      const endLine = existingLines.length - 1;
      const endCh = existingLines[endLine]?.length ?? 0;
      const priorCursor =
        typeof editor.getCursor === "function"
          ? editor.getCursor()
          : { line: 0, ch: 0 };

      let next: string;
      let nextCursor: EditorPos;
      if (mode === "append") {
        editor.replaceRange(content, { line: endLine, ch: endCh });
        next = existing + content;
        nextCursor = priorCursor;
      } else if (mode === "prepend") {
        editor.replaceRange(content, { line: 0, ch: 0 });
        next = content + existing;
        const insertedLines = content.split("\n");
        const insertedLineCount = insertedLines.length - 1;
        if (insertedLineCount === 0) {
          // Single-line prepend: shift column right.
          nextCursor = {
            line: priorCursor.line,
            ch: priorCursor.ch + content.length,
          };
        } else {
          // Multi-line prepend: shift down by the inserted line count;
          // column is only adjusted on the original first line.
          nextCursor = {
            line: priorCursor.line + insertedLineCount,
            ch:
              priorCursor.line === 0
                ? insertedLines[insertedLineCount].length + priorCursor.ch
                : priorCursor.ch,
          };
        }
      } else {
        // replace
        editor.replaceRange(
          content,
          { line: 0, ch: 0 },
          { line: endLine, ch: endCh },
        );
        next = content;
        const nextLines = content.split("\n");
        const lastLine = nextLines.length - 1;
        nextCursor = {
          line: lastLine,
          ch: nextLines[lastLine].length,
        };
      }
      if (typeof editor.setCursor === "function") {
        editor.setCursor(nextCursor);
      }
      return { ok: true, value: { value: next, cursor: nextCursor } };
    } catch (e) {
      return { ok: false, reason: "native-failed", cause: e };
    }
  }

  /**
   * Read the Daily Notes core-plugin config. Returns `plugin-not-enabled`
   * when the user has not enabled Daily Notes — Phase 4's
   * `create_daily_note` falls back to `YYYY-MM-DD.md` at vault root in
   * that case.
   */
  getDailyNotesConfig(): ApiResult<DailyNotesConfig> {
    const plugin = this.app.internalPlugins?.plugins?.["daily-notes"];
    if (!plugin) return { ok: false, reason: "plugin-not-enabled" };
    try {
      const options = plugin.instance?.options;
      if (!options) {
        return { ok: false, reason: "plugin-not-enabled" };
      }
      return { ok: true, value: options };
    } catch (e) {
      return { ok: false, reason: "native-failed", cause: e };
    }
  }

  /**
   * True if a community plugin with the given id is currently enabled.
   * Phase 4's `create_task` uses this to detect the Tasks plugin.
   */
  isCommunityPluginEnabled(id: string): boolean {
    try {
      return this.app.plugins?.plugins?.[id] != null;
    } catch {
      return false;
    }
  }

  /**
   * Create a markdown note via Obsidian's `vault.create`. Phase 4's
   * `create_note` calls this as the **richer surface**; on
   * `native-failed` the caller falls back to `createFileImpl` from
   * `WriteTools.ts` so we still record an `UndoJournal` entry. Returns
   * `index-unavailable` if the vault adapter doesn't expose `create`,
   * which the caller treats as a reason to take the fallback path.
   */
  async createNote(
    vaultRelPath: string,
    content: string,
  ): Promise<ApiResult<TFileLike>> {
    const vault = this.app.vault;
    if (!vault || typeof vault.create !== "function") {
      return { ok: false, reason: "index-unavailable" };
    }
    try {
      const file = (await vault.create(vaultRelPath, content)) as TFileLike;
      return { ok: true, value: file };
    } catch (e) {
      return { ok: false, reason: "native-failed", cause: e };
    }
  }

  /**
   * Modify an existing markdown note via `vault.modify`. Phase 4's
   * `edit_note` calls this as the **richer surface**; the caller pre-
   * composes the full post-write content (append/prepend/replace) so
   * we don't second-guess the mode here.
   */
  async modifyNote(
    file: TFileLike,
    content: string,
  ): Promise<ApiResult<void>> {
    const vault = this.app.vault;
    if (!vault || typeof vault.modify !== "function") {
      return { ok: false, reason: "index-unavailable" };
    }
    try {
      await vault.modify(file, content);
      return { ok: true, value: undefined };
    } catch (e) {
      return { ok: false, reason: "native-failed", cause: e };
    }
  }

  /**
   * Path of the note the user is currently focused on, used by both
   * `insert_into_active_note`'s handler AND `main.ts`'s
   * `safety.extractVaultPath` so the gate matches the actual write
   * target. Prefers the active editor's file (which is what the
   * editor-surface write path mutates) and falls back to
   * `getActiveFile` (which is what the disk-fallback write path uses).
   * Returns `null` when no markdown note is in focus.
   */
  getActiveNotePath(): string | null {
    const ed = this.getEditorForActive();
    if (ed.ok) {
      const p = (ed.value.file as { path?: string } | null)?.path;
      if (typeof p === "string") return p;
    }
    const af = this.getActiveFile();
    if (af.ok) {
      const p = (af.value as { path?: string } | null)?.path;
      if (typeof p === "string") return p;
    }
    return null;
  }

  /**
   * FR-012 read-only guard. True when the active markdown leaf is in
   * preview/read-only mode, OR the active note's frontmatter declares
   * a `cssclasses` entry that signals read-only (the community
   * convention is the literal string `readonly`). Returns `false`
   * defensively when no view is detectable so the caller can take the
   * no-active-note path without an extra branch.
   */
  isActiveFileReadOnly(): boolean {
    const ws = this.app.workspace;
    if (ws && typeof ws.getActiveViewOfType === "function") {
      try {
        const view = ws.getActiveViewOfType(ws.markdownViewSymbol) as
          | {
              getMode?: () => string;
              getState?: () => { mode?: string; source?: boolean };
            }
          | null;
        if (view) {
          const state = view.getState?.();
          const modeFromMethod =
            typeof view.getMode === "function" ? view.getMode() : undefined;
          const modeFromState = state?.mode;
          if (modeFromMethod === "preview") return true;
          if (modeFromState === "preview") return true;
          // Obsidian markdown leaf state has `source: false` when in
          // reading view even if `mode` is undefined on some versions.
          if (state && state.source === false) return true;
        }
      } catch {
        // Fall through to frontmatter check.
      }
    }
    // Frontmatter cssclasses signal — Obsidian community convention.
    const af = this.getActiveFile();
    if (af.ok) {
      const cache = this.getFileCache(af.value as TFileLike);
      if (cache.ok) {
        const fm = cache.value.frontmatter as
          | { cssclasses?: unknown; cssclass?: unknown }
          | undefined;
        const classes = collectCssClasses(fm);
        if (classes.includes("readonly")) return true;
      }
    }
    return false;
  }
}

/** Normalize Obsidian's `cssclasses` (array OR space/comma string). */
function collectCssClasses(
  fm: { cssclasses?: unknown; cssclass?: unknown } | undefined,
): string[] {
  if (!fm) return [];
  const out: string[] = [];
  const collect = (v: unknown): void => {
    if (Array.isArray(v)) {
      for (const item of v) {
        if (typeof item === "string") out.push(item.trim());
      }
    } else if (typeof v === "string") {
      for (const item of v.split(/[\s,]+/)) {
        if (item.length > 0) out.push(item);
      }
    }
  };
  collect(fm.cssclasses);
  collect(fm.cssclass);
  return out;
}

function walkFolder(
  node: AbstractFileLike,
  remainingDepth: number,
  counter: { count: number; truncatedAt: string | undefined },
): TreeNode {
  counter.count += 1;
  const isFile =
    node.extension !== undefined || node.children === undefined;
  const name = node.name ?? node.path.split("/").pop() ?? node.path;
  if (isFile) {
    return {
      name,
      path: node.path,
      kind: "file",
      size: node.stat?.size,
      mtime: node.stat?.mtime,
    };
  }
  const tree: TreeNode = {
    name,
    path: node.path,
    kind: "folder",
    children: [],
  };
  if (remainingDepth <= 0) {
    return tree;
  }
  const childArray = node.children ?? [];
  // Sort folders-before-files, then alphabetical, for stable output.
  const sorted = [...childArray].sort((a, b) => {
    const aFolder = a.children !== undefined && a.extension === undefined;
    const bFolder = b.children !== undefined && b.extension === undefined;
    if (aFolder !== bFolder) return aFolder ? -1 : 1;
    return (a.name ?? a.path).localeCompare(b.name ?? b.path);
  });
  for (const child of sorted) {
    if (counter.count >= MAX_TREE_NODES) {
      counter.truncatedAt = child.path;
      break;
    }
    tree.children!.push(walkFolder(child, remainingDepth - 1, counter));
  }
  return tree;
}

/**
 * v0.3 Phase 2 tag helpers.
 * Tag keys throughout this module retain the leading `#` so the shape
 * matches Obsidian's native `metadataCache.getTags()` exactly. `#` is
 * lowercased away from the key (it's the literal hash character, not
 * tag content); the rest of the string is left as-is so case-sensitive
 * tag comparisons remain meaningful (Obsidian preserves case).
 */
export function normalizeTagKey(raw: unknown): string {
  if (typeof raw !== "string") return "";
  const stripped = raw.trim().replace(/^#+/, "");
  return stripped.length > 0 ? `#${stripped}` : "";
}

/** Returns the set of `#tag` keys (with leading `#`) referenced by a file's cache. */
export function collectFileTagsForFallback(
  cache: FileCacheLike,
): Set<string> {
  const out = new Set<string>();
  for (const t of cache.tags ?? []) {
    const norm = normalizeTagKey(t.tag);
    if (norm) out.add(norm);
  }
  const fm = cache.frontmatter as
    | { tags?: unknown; tag?: unknown }
    | undefined;
  if (fm) {
    const raw = fm.tags ?? fm.tag;
    if (typeof raw === "string") {
      for (const piece of raw.split(/[\s,]+/)) {
        const norm = normalizeTagKey(piece);
        if (norm) out.add(norm);
      }
    } else if (Array.isArray(raw)) {
      for (const piece of raw) {
        const norm = normalizeTagKey(piece);
        if (norm) out.add(norm);
      }
    }
  }
  return out;
}
