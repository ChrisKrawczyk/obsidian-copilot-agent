import { defineTool, type Tool } from "@github/copilot-sdk";
import {
  createFileImpl,
  editFileImpl,
  hasUnsavedEditorChanges,
  type WriteToolsDeps,
} from "./WriteTools";
import { lookupTFile, toVaultRelative, resolveVaultPath, VaultPathError } from "./VaultPath";
import { ObsidianApi } from "./ObsidianApi";
import type { TFileLike } from "./ReadTools";
import { resolveDailyNotePath } from "./DailyNotePath";

/**
 * Per-call dependencies for the Phase-4 vault-write tools.
 *
 * Reuses `WriteToolsDeps` (vault, workspace, undoJournal) and adds the
 * `ObsidianApi` instance for richer-surface calls (createNote / modifyNote /
 * applyEditorTransform / openFile / isActiveFileReadOnly / getActiveFile),
 * plus a deterministic clock for `create_daily_note` so tests can pin time.
 */
export interface WriteNoteToolsDeps extends WriteToolsDeps {
  api: ObsidianApi;
  now: () => Date;
}

interface SuccessShape {
  ok: true;
  kind: string;
  path: string;
  /** Present only when an `UndoJournal` entry was recorded. */
  undoId?: string;
  /** `editor-native` when Ctrl+Z is owned by Obsidian, `journal` when ours. */
  undoSurface?: "editor-native" | "journal";
  /** Extra detail used by `create_daily_note` to surface its source. */
  source?: "plugin-config" | "fallback";
  /**
   * True when the richer ObsidianApi surface failed and we routed the
   * write through the lower-level vault adapter (`createFileImpl` /
   * `editFileImpl`). Useful for telemetry and for users to know their
   * write went through the safety net.
   */
  usedFallback?: boolean;
  /**
   * Set by `create_daily_note` when the configured Daily Notes
   * template was successfully read and applied as the new note's
   * initial content.
   */
  templateApplied?: boolean;
}

interface ErrorShape {
  ok: false;
  error: string;
}

export type NoteWriteResult = SuccessShape | ErrorShape;

// ---------------- create_note ----------------

export async function createNoteImpl(
  rawPath: string,
  content: string,
  deps: WriteNoteToolsDeps,
): Promise<NoteWriteResult> {
  // Validate path + collision up-front so we report the same errors
  // regardless of which surface ends up doing the write.
  let abs: string;
  try {
    abs = resolveVaultPath(rawPath, deps.vault);
  } catch (err) {
    if (err instanceof VaultPathError) return { ok: false, error: err.message };
    throw err;
  }
  const vaultRel = toVaultRelative(abs, deps.vault);
  if (lookupTFile(vaultRel, deps.vault) !== null) {
    return {
      ok: false,
      error: `Note "${vaultRel}" already exists. Use edit_note to modify it.`,
    };
  }

  // Try the richer ObsidianApi surface first. On any failure (the
  // adapter doesn't expose vault.create, or Obsidian threw), fall
  // back to createFileImpl which goes through our fully-validated
  // vault adapter wrapper.
  const richer = await deps.api.createNote(vaultRel, content);
  if (richer.ok) {
    const entry = deps.undoJournal.record({
      kind: "create",
      scope: "vault",
      path: vaultRel,
      after: content,
    });
    return {
      ok: true,
      kind: "create_note",
      path: vaultRel,
      undoId: entry.id,
      undoSurface: "journal",
      usedFallback: false,
    };
  }
  const fallback = await createFileImpl(rawPath, content, deps);
  if (!fallback.ok) return fallback;
  return {
    ok: true,
    kind: "create_note",
    path: fallback.path,
    undoId: fallback.undoId,
    undoSurface: "journal",
    usedFallback: true,
  };
}

// ---------------- edit_note ----------------

export async function editNoteImpl(
  rawPath: string,
  mode: "append" | "prepend" | "replace",
  content: string,
  deps: WriteNoteToolsDeps,
): Promise<NoteWriteResult> {
  let abs: string;
  try {
    abs = resolveVaultPath(rawPath, deps.vault);
  } catch (err) {
    if (err instanceof VaultPathError) return { ok: false, error: err.message };
    throw err;
  }
  const vaultRel = toVaultRelative(abs, deps.vault);
  const fileUnknown = lookupTFile(vaultRel, deps.vault);
  if (!fileUnknown) {
    return {
      ok: false,
      error: `Note "${vaultRel}" does not exist. Use create_note to add it.`,
    };
  }
  const file = fileUnknown as TFileLike;
  // Read current content so we can compose append/prepend/replace.
  let before: string;
  try {
    if (deps.vault.read) {
      before = await deps.vault.read(file);
    } else if (deps.vault.cachedRead) {
      before = await deps.vault.cachedRead(file);
    } else {
      return { ok: false, error: "Vault adapter does not support read()." };
    }
  } catch (err) {
    return {
      ok: false,
      error: `Read failed before edit_note: ${(err as Error).message || String(err)}`,
    };
  }

  let after: string;
  if (mode === "append") {
    after = before + content;
  } else if (mode === "prepend") {
    after = content + before;
  } else {
    after = content;
  }

  // Try the richer ObsidianApi.modifyNote surface first; if it fails
  // (`index-unavailable` or `native-failed`) fall through to
  // editFileImpl which also enforces the unsaved-editor-conflict
  // guard. We replicate the guard HERE before the richer-surface
  // attempt so a dirty open editor isn't silently overwritten on
  // the happy path either.
  const conflict = await hasUnsavedEditorChanges(
    vaultRel,
    before,
    deps.workspace,
  );
  if (conflict) {
    return {
      ok: false,
      error: `Note "${vaultRel}" has unsaved changes in an open editor. Save or discard them, then try again.`,
    };
  }
  const richer = await deps.api.modifyNote(file, after);
  if (richer.ok) {
    const entry = deps.undoJournal.record({
      kind: "modify",
      scope: "vault",
      path: vaultRel,
      before,
      after,
    });
    return {
      ok: true,
      kind: "edit_note",
      path: vaultRel,
      undoId: entry.id,
      undoSurface: "journal",
      usedFallback: false,
    };
  }
  const fallback = await editFileImpl(rawPath, after, deps);
  if (!fallback.ok) return fallback;
  return {
    ok: true,
    kind: "edit_note",
    path: fallback.path,
    undoId: fallback.undoId,
    undoSurface: "journal",
    usedFallback: true,
  };
}

// ---------------- open_note ----------------

export async function openNoteImpl(
  rawPath: string,
  deps: WriteNoteToolsDeps,
): Promise<NoteWriteResult> {
  let abs: string;
  try {
    abs = resolveVaultPath(rawPath, deps.vault);
  } catch (err) {
    if (err instanceof VaultPathError) return { ok: false, error: err.message };
    throw err;
  }
  const vaultRel = toVaultRelative(abs, deps.vault);
  const fileUnknown = lookupTFile(vaultRel, deps.vault);
  if (!fileUnknown) {
    return { ok: false, error: `Note "${vaultRel}" does not exist.` };
  }
  const r = await deps.api.openFile(fileUnknown as TFileLike);
  if (!r.ok) {
    return {
      ok: false,
      error: `Failed to open note: ${r.reason}`,
    };
  }
  return { ok: true, kind: "open_note", path: vaultRel };
}

// ---------------- insert_into_active_note ----------------

export async function insertIntoActiveNoteImpl(
  mode: "append" | "prepend" | "replace",
  content: string,
  deps: WriteNoteToolsDeps,
): Promise<NoteWriteResult> {
  // NOTE: FR-012 originally specified a read-only/preview-mode guard
  // here, but manual testing in Phase 4 showed Obsidian's own editor
  // surface accepts inserts in reading view without issue, so we
  // dropped the guard rather than block a working operation. The
  // `ObsidianApi.isActiveFileReadOnly()` helper is kept for future
  // tools that may need it.

  // Resolve the active note's path through the same single source of
  // truth that `main.ts`'s safety extractor uses, so the gate's
  // allowlist match is computed against the same path we're about to
  // write to.
  const activePath = deps.api.getActiveNotePath();
  if (activePath === null) {
    return { ok: false, error: "No active note to insert into." };
  }

  // Try the editor surface first — owns Obsidian's native undo stack.
  const editor = deps.api.getEditorForActive();
  if (editor.ok) {
    const r = deps.api.applyEditorTransform(mode, content);
    if (r.ok) {
      return {
        ok: true,
        kind: "insert_into_active_note",
        path: activePath,
        undoSurface: "editor-native",
      };
    }
    // Editor present but transform failed — fall through to disk path.
  }

  // Disk fallback: edit the active file via editNoteImpl so we DO
  // record an UndoJournal entry. This matches FR-012's split
  // (editor-buffer-authoritative when editor is present;
  // disk-backed-with-undo when editor is gone).
  return await editNoteImpl(activePath, mode, content, deps);
}

// ---------------- create_daily_note ----------------

/**
 * Read a Daily-Notes template if the plugin's `template` field points
 * to one. Returns the template body when readable, otherwise `null`
 * so the caller falls back to an empty initial note. The template is
 * a vault-relative path (the plugin allows `Templates/Daily.md` or
 * just `Daily` — we accept either).
 */
async function readDailyNoteTemplate(
  deps: WriteNoteToolsDeps,
): Promise<string | null> {
  const cfg = deps.api.getDailyNotesConfig();
  if (!cfg.ok) return null;
  const tplPath = cfg.value.template;
  if (typeof tplPath !== "string" || tplPath.trim().length === 0) {
    return null;
  }
  const normalized = tplPath.endsWith(".md") ? tplPath : `${tplPath}.md`;
  const tplFile = lookupTFile(normalized, deps.vault);
  if (tplFile === null) return null;
  try {
    if (deps.vault.read) {
      return await deps.vault.read(tplFile as TFileLike);
    }
    if (deps.vault.cachedRead) {
      return await deps.vault.cachedRead(tplFile as TFileLike);
    }
  } catch {
    return null;
  }
  return null;
}

export async function createDailyNoteImpl(
  deps: WriteNoteToolsDeps,
): Promise<NoteWriteResult> {
  const resolved = resolveDailyNotePath(deps.api, deps.now());
  // If the daily note already exists, opening it is the right behavior;
  // the user will have asked for "today's daily note" semantically.
  const existing = lookupTFile(resolved.path, deps.vault);
  if (existing !== null) {
    const r = await deps.api.openFile(existing as TFileLike);
    if (!r.ok) {
      return {
        ok: false,
        error: `Daily note exists at "${resolved.path}" but could not be opened: ${r.reason}`,
      };
    }
    return {
      ok: true,
      kind: "create_daily_note",
      path: resolved.path,
      source: resolved.source,
    };
  }

  // Pre-read the configured template (if any) so the new note has
  // sensible initial content. Failures are non-fatal — we just create
  // an empty note and report `templateApplied: false`.
  const template = await readDailyNoteTemplate(deps);
  const initialContent = template ?? "";
  const templateApplied = template !== null;

  // Reuse createNoteImpl so the rich-surface fallback story applies
  // here too (and the UndoJournal entry is recorded once).
  const result = await createNoteImpl(resolved.path, initialContent, deps);
  if (!result.ok) return result;

  // Best-effort open; ignore failure so we don't lose the create undo.
  const file = lookupTFile(result.path, deps.vault);
  if (file !== null) {
    await deps.api.openFile(file as TFileLike);
  }
  return {
    ok: true,
    kind: "create_daily_note",
    path: result.path,
    undoId: result.undoId,
    undoSurface: "journal",
    source: resolved.source,
    templateApplied,
    usedFallback: result.usedFallback,
  };
}

// ---------------- factory ----------------

/**
 * Build the four Phase-4 vault-write note tools (create_task is Phase 5):
 *   - create_note               (gated)
 *   - edit_note                 (gated)
 *   - open_note                 (skipPermission: true — navigation only)
 *   - insert_into_active_note   (gated; FR-012 read-only guarded)
 *   - create_daily_note         (gated)
 */
export function createWriteNoteTools(deps: WriteNoteToolsDeps): Tool<unknown>[] {
  return [
    defineTool("create_note", {
      description:
        "Create a new markdown note in the Obsidian vault. Path is " +
        "vault-relative; absolute paths are rejected. Fails if a note " +
        "already exists at that path — use edit_note instead.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Vault-relative path of the note to create." },
          content: { type: "string", description: "Initial note contents (may be empty)." },
        },
        required: ["path"],
        additionalProperties: false,
      },
      handler: async (args: unknown) => {
        const a = (args ?? {}) as { path?: unknown; content?: unknown };
        const path = typeof a.path === "string" ? a.path : "";
        const content = typeof a.content === "string" ? a.content : "";
        return await createNoteImpl(path, content, deps);
      },
    }),
    defineTool("edit_note", {
      description:
        "Modify an existing markdown note in the Obsidian vault by " +
        "appending, prepending, or replacing its content. Path is " +
        "vault-relative. Fails if the note does not exist or has " +
        "unsaved changes in an open editor.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          mode: { type: "string", enum: ["append", "prepend", "replace"] },
          content: { type: "string" },
        },
        required: ["path", "mode", "content"],
        additionalProperties: false,
      },
      handler: async (args: unknown) => {
        const a = (args ?? {}) as { path?: unknown; mode?: unknown; content?: unknown };
        const path = typeof a.path === "string" ? a.path : "";
        const mode =
          a.mode === "append" || a.mode === "prepend" || a.mode === "replace"
            ? a.mode
            : "replace";
        const content = typeof a.content === "string" ? a.content : "";
        return await editNoteImpl(path, mode, content, deps);
      },
    }),
    defineTool("open_note", {
      description:
        "Open a note in the active Obsidian editor leaf. Read-equivalent " +
        "navigation — does not modify vault contents.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Vault-relative path of the note to open." },
        },
        required: ["path"],
        additionalProperties: false,
      },
      // open_note is read-equivalent navigation — skip the permission gate.
      skipPermission: true,
      handler: async (args: unknown) => {
        const a = (args ?? {}) as { path?: unknown };
        const path = typeof a.path === "string" ? a.path : "";
        return await openNoteImpl(path, deps);
      },
    }),
    defineTool("insert_into_active_note", {
      description:
        "Insert text into the currently focused markdown note. Uses the " +
        "live editor surface when one is open (Obsidian Ctrl+Z handles " +
        "undo); otherwise falls back to a disk write recorded in the " +
        "Undo journal.",
      parameters: {
        type: "object",
        properties: {
          mode: { type: "string", enum: ["append", "prepend", "replace"] },
          content: { type: "string" },
        },
        required: ["mode", "content"],
        additionalProperties: false,
      },
      handler: async (args: unknown) => {
        const a = (args ?? {}) as { mode?: unknown; content?: unknown };
        const mode =
          a.mode === "append" || a.mode === "prepend" || a.mode === "replace"
            ? a.mode
            : "append";
        const content = typeof a.content === "string" ? a.content : "";
        return await insertIntoActiveNoteImpl(mode, content, deps);
      },
    }),
    defineTool("create_daily_note", {
      description:
        "Create today's daily note at the path configured by Obsidian's " +
        "Daily Notes plugin (or YYYY-MM-DD.md at vault root if the plugin " +
        "is disabled), then open it. If today's note already exists, " +
        "just opens it.",
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      handler: async () => {
        return await createDailyNoteImpl(deps);
      },
    }),
  ];
}
