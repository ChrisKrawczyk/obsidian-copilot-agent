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
import {
  formatTaskLine,
  STRICT_DATE_REGEX,
  type TaskInput,
  type TaskFormatSource,
  type TaskPriority,
} from "./TaskFormat";
import type { VaultAwarenessSettings } from "../settings/VaultAwarenessSettings";
import {
  updateTaskImpl,
  type UpdateTaskInput,
  type UpdateTaskPatch,
} from "./UpdateTask";

/**
 * Per-call dependencies for the Phase-4/5 vault-write tools.
 *
 * Reuses `WriteToolsDeps` (vault, workspace, undoJournal) and adds the
 * `ObsidianApi` instance for richer-surface calls (createNote / modifyNote /
 * applyEditorTransform / openFile / isActiveFileReadOnly / getActiveFile),
 * plus a deterministic clock for `create_daily_note` so tests can pin time,
 * plus a vault-awareness reader so `create_task` can resolve its target.
 */
export interface WriteNoteToolsDeps extends WriteToolsDeps {
  api: ObsidianApi;
  now: () => Date;
  /** Reads the latest settings so changes to taskTargetMode etc. apply live. */
  vaultAwareness: () => VaultAwarenessSettings;
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
  // here. Phase 4 manual testing showed Obsidian's own editor surface
  // accepts inserts in reading view without issue, and the user opted
  // to keep the operation working in that case. The spec was amended
  // in final review to drop the guard (see Spec.md FR-012 amendment).
  // The `ObsidianApi.isActiveFileReadOnly()` helper is retained for
  // future tools that may need read-only detection.

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

  // Ensure the parent folder exists (F8). Obsidian's `vault.create`
  // raises if any intermediate folder is missing, which is easy to
  // hit when the user's Daily Notes config points at a folder they
  // haven't created yet (fresh vault, new sub-folder, etc.). Failure
  // here is non-fatal — `createFileImpl` will surface a clearer
  // error if it ultimately can't write.
  const slashIdx = resolved.path.lastIndexOf("/");
  if (slashIdx > 0) {
    const folder = resolved.path.slice(0, slashIdx);
    if (lookupTFile(folder, deps.vault) === null && deps.vault.createFolder) {
      try {
        await deps.vault.createFolder(folder);
      } catch {
        // Already-exists / race conditions are tolerable — the create
        // call below will fail with a descriptive error if the folder
        // really isn't usable.
      }
    }
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

// ---------------- create_task ----------------

export interface CreateTaskResult {
  ok: boolean;
  targetPath?: string;
  formatSource?: TaskFormatSource;
  /** True when the resolved target file did not exist and we created it. */
  existingTargetCreated?: boolean;
  /**
   * Undo handle for the operation. When we had to create the target
   * file, this is the create-entry id so reverting deletes the whole
   * file (the user had no task target before this call). When the
   * target already existed, this is the modify-entry id so reverting
   * just removes the appended task line.
   */
  undoId?: string;
  undoSurface?: "journal";
  /** Set when `dueDate` or `scheduledDate` is not strict YYYY-MM-DD. */
  reason?: "invalid_date_format" | "invalid_priority" | "missing_description";
  field?: "dueDate" | "scheduledDate" | "createdDate";
  /** Free-form error message for callers / users. */
  error?: string;
}

function validateTaskInput(input: TaskInput): CreateTaskResult | null {
  if (!input.description || input.description.trim().length === 0) {
    return {
      ok: false,
      reason: "missing_description",
      error: "create_task requires a non-empty `description`.",
    };
  }
  if (input.dueDate !== undefined && !STRICT_DATE_REGEX.test(input.dueDate)) {
    return {
      ok: false,
      reason: "invalid_date_format",
      field: "dueDate",
      error:
        `create_task rejected dueDate "${input.dueDate}": expected strict YYYY-MM-DD. ` +
        "Resolve relative dates (\"tomorrow\", \"Friday\") against the user's timezone " +
        "(provided in the preamble) before calling this tool.",
    };
  }
  if (
    input.scheduledDate !== undefined &&
    !STRICT_DATE_REGEX.test(input.scheduledDate)
  ) {
    return {
      ok: false,
      reason: "invalid_date_format",
      field: "scheduledDate",
      error:
        `create_task rejected scheduledDate "${input.scheduledDate}": expected strict YYYY-MM-DD.`,
    };
  }
  if (
    input.createdDate !== undefined &&
    !STRICT_DATE_REGEX.test(input.createdDate)
  ) {
    return {
      ok: false,
      reason: "invalid_date_format",
      field: "createdDate",
      error:
        `create_task rejected createdDate "${input.createdDate}": expected strict YYYY-MM-DD.`,
    };
  }
  if (
    input.priority !== undefined &&
    input.priority !== "high" &&
    input.priority !== "medium" &&
    input.priority !== "low"
  ) {
    return {
      ok: false,
      reason: "invalid_priority",
      error: `create_task rejected priority "${input.priority}": expected one of high|medium|low.`,
    };
  }
  return null;
}

/**
 * Read the configured Daily Notes template (if any) and return its
 * content so we can seed a freshly-created daily-note target with the
 * user's template. Mirrors the Phase-4 `readDailyNoteTemplate` helper,
 * duplicated here intentionally to keep the create_task pipeline from
 * re-entering the gated daily-note SDK tool.
 */
async function readDailyNoteTemplateForTask(
  deps: WriteNoteToolsDeps,
): Promise<string | null> {
  const cfg = deps.api.getDailyNotesConfig();
  if (!cfg.ok) return null;
  const tplPath = cfg.value.template;
  if (typeof tplPath !== "string" || tplPath.trim().length === 0) return null;
  const normalized = tplPath.endsWith(".md") ? tplPath : `${tplPath}.md`;
  const tplFile = lookupTFile(normalized, deps.vault);
  if (tplFile === null) return null;
  try {
    if (deps.vault.read) return await deps.vault.read(tplFile as TFileLike);
    if (deps.vault.cachedRead)
      return await deps.vault.cachedRead(tplFile as TFileLike);
  } catch {
    return null;
  }
  return null;
}

export async function createTaskImpl(
  input: TaskInput,
  deps: WriteNoteToolsDeps,
): Promise<CreateTaskResult> {
  // Default createdDate to today (from deps.now()) so the user gets a
  // Tasks-plugin ➕ / GFM (created: …) marker for free. The model may
  // override with an explicit createdDate (e.g. backdating a forgotten
  // task); validation enforces strict YYYY-MM-DD either way.
  const withCreatedDate: TaskInput = {
    ...input,
    createdDate: input.createdDate ?? formatYmd(deps.now()),
  };
  const validation = validateTaskInput(withCreatedDate);
  if (validation) return validation;

  // Determine target path from settings. Custom-path mode wins; otherwise
  // resolve today's daily-note path via the same helper as the gate so
  // create_target inside our single-approval flow is consistent.
  const settings = deps.vaultAwareness();
  let targetPath: string;
  let isDailyNoteTarget = false;
  if (
    settings.taskTargetMode === "custom-path" &&
    settings.customTaskTargetPath.trim().length > 0
  ) {
    targetPath = settings.customTaskTargetPath.trim();
  } else {
    targetPath = resolveDailyNotePath(deps.api, deps.now()).path;
    isDailyNoteTarget = true;
  }

  // Detect Tasks plugin so we pick the right line format.
  const formatSource: TaskFormatSource = deps.api.isCommunityPluginEnabled(
    "obsidian-tasks-plugin",
  )
    ? "tasks-plugin"
    : "gfm";
  const taskLine = formatTaskLine(withCreatedDate, formatSource);

  // Create-or-read target. We call createFileImpl / editFileImpl
  // DIRECTLY rather than create_note / edit_note so the entire create-
  // target + append sequence runs under create_task's single approval
  // (no re-entry into the gated SDK tool surface). See Phase 5 plan
  // line 281.
  let existingTargetCreated = false;
  // Capture the create-entry undoId when we made the target; this is
  // what we surface so a single undo deletes the whole file (the user
  // had no task target before this call). When the target already
  // existed, we surface the modify-entry undoId from the append.
  let createUndoId: string | undefined;
  const existing = lookupTFile(targetPath, deps.vault);
  if (existing === null) {
    // Same folder-ensure logic as create_daily_note (F8) — task targets
    // can sit in a daily-notes folder or a custom sub-folder the user
    // hasn't materialized yet.
    const slashIdx = targetPath.lastIndexOf("/");
    if (slashIdx > 0) {
      const folder = targetPath.slice(0, slashIdx);
      if (lookupTFile(folder, deps.vault) === null && deps.vault.createFolder) {
        try {
          await deps.vault.createFolder(folder);
        } catch {
          // Tolerate races / already-exists; createFileImpl will report
          // any genuine write failure below.
        }
      }
    }
    // Seed with daily-notes template content for daily-note targets.
    const seed = isDailyNoteTarget
      ? (await readDailyNoteTemplateForTask(deps)) ?? ""
      : "";
    const created = await createFileImpl(targetPath, seed, deps);
    if (!created.ok) {
      return {
        ok: false,
        targetPath,
        formatSource,
        error: `Failed to create task target "${targetPath}": ${created.error}`,
      };
    }
    existingTargetCreated = true;
    createUndoId = created.undoId;
  }

  // Read current content so we can append the task line. The target
  // was either pre-existing or just created above.
  const targetFile = lookupTFile(targetPath, deps.vault);
  if (targetFile === null) {
    return {
      ok: false,
      targetPath,
      formatSource,
      error: `Task target "${targetPath}" disappeared after creation.`,
    };
  }
  let current = "";
  try {
    if (deps.vault.read) {
      current = await deps.vault.read(targetFile as TFileLike);
    } else if (deps.vault.cachedRead) {
      current = await deps.vault.cachedRead(targetFile as TFileLike);
    }
  } catch (err) {
    return {
      ok: false,
      targetPath,
      formatSource,
      error: `Failed to read task target before append: ${(err as Error).message || String(err)}`,
    };
  }

  // Respect the unsaved-editor-conflict guard from edit_note: refuse
  // to overwrite when a dirty editor for this path exists.
  const conflict = await hasUnsavedEditorChanges(
    targetPath,
    current,
    deps.workspace,
  );
  if (conflict) {
    return {
      ok: false,
      targetPath,
      formatSource,
      error: `Task target "${targetPath}" has unsaved changes in an open editor. Save or discard them, then try again.`,
    };
  }

  // Ensure the inserted line stands on its own line. If the existing
  // content is non-empty and doesn't already end with `\n`, we insert
  // one before the task line.
  const separator = current.length === 0 || current.endsWith("\n") ? "" : "\n";
  const nextContent = `${current}${separator}${taskLine}\n`;

  const edited = await editFileImpl(targetPath, nextContent, deps);
  if (!edited.ok) {
    return {
      ok: false,
      targetPath,
      formatSource,
      existingTargetCreated,
      error: edited.error,
    };
  }

  // Prefer the create-entry undoId when we made the file (one click
  // reverts the entire operation). Otherwise surface the append's
  // modify-entry undoId so undo just removes the task line.
  const undoId = createUndoId ?? edited.undoId;

  return {
    ok: true,
    targetPath,
    formatSource,
    existingTargetCreated,
    undoId,
    undoSurface: "journal",
  };
}

/** Format a Date as strict `YYYY-MM-DD` in local time. */
function formatYmd(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}



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
    defineTool("create_task", {
      description:
        "Append a task line to the configured task target (today's " +
        "daily note by default, or a custom path set in Settings). " +
        "Detects the Obsidian Tasks community plugin and emits its " +
        "emoji syntax (📅 due, ⏳ scheduled, ⏫/🔼/🔽 priority); " +
        "otherwise emits GFM `- [ ]` with inline-text date metadata. " +
        "Dates MUST be strict YYYY-MM-DD — resolve relative dates " +
        "(\"tomorrow\", \"Friday\") against the user's timezone " +
        "(provided in the preamble) before invoking this tool. " +
        "Creates the target file if it doesn't exist, all under a " +
        "single approval.",
      parameters: {
        type: "object",
        properties: {
          description: { type: "string", description: "The task body text." },
          dueDate: {
            type: "string",
            description: "Optional strict YYYY-MM-DD due date.",
          },
          scheduledDate: {
            type: "string",
            description: "Optional strict YYYY-MM-DD scheduled date.",
          },
          createdDate: {
            type: "string",
            description:
              "Optional strict YYYY-MM-DD created date. Defaults to today " +
              "(the user's local date) when omitted. Override only to " +
              "backdate a forgotten task.",
          },
          priority: {
            type: "string",
            enum: ["high", "medium", "low"],
            description: "Optional task priority.",
          },
          tags: {
            type: "array",
            items: { type: "string" },
            description: "Optional list of tag names (without leading #).",
          },
        },
        required: ["description"],
        additionalProperties: false,
      },
      handler: async (args: unknown) => {
        const a = (args ?? {}) as {
          description?: unknown;
          dueDate?: unknown;
          scheduledDate?: unknown;
          createdDate?: unknown;
          priority?: unknown;
          tags?: unknown;
        };
        const input: TaskInput = {
          description: typeof a.description === "string" ? a.description : "",
          dueDate: typeof a.dueDate === "string" ? a.dueDate : undefined,
          scheduledDate:
            typeof a.scheduledDate === "string" ? a.scheduledDate : undefined,
          createdDate:
            typeof a.createdDate === "string" ? a.createdDate : undefined,
          priority:
            a.priority === "high" || a.priority === "medium" || a.priority === "low"
              ? (a.priority as TaskPriority)
              : (typeof a.priority === "string"
                  ? (a.priority as TaskPriority)
                  : undefined),
          tags: Array.isArray(a.tags)
            ? a.tags.filter((t): t is string => typeof t === "string")
            : undefined,
        };
        return await createTaskImpl(input, deps);
      },
    }),
    defineTool("update_task", {
      description:
        "Edit a single existing task line: change status, set/clear due " +
        "or scheduled date, add/remove tags, change priority, or rewrite " +
        "the description. Identifies the target by `line` (1-based, from " +
        "find_tasks) with `expectedRawLine` as a safe re-anchor — if the " +
        "line has moved or the file has changed, the entire file is " +
        "scanned for a byte-exact match. Setting status to 'done' or " +
        "'cancelled' auto-stamps today's completion/cancellation date " +
        "(preserves existing date — re-marking done is idempotent). " +
        "Status values: todo, in-progress, done, cancelled. Dates must " +
        "be strict YYYY-MM-DD; pass null to clear a date. Single " +
        "approval; reversible via the Undo button (one click reverts " +
        "the file to its prior content).",
      parameters: {
        type: "object",
        required: ["path", "line", "patch"],
        properties: {
          path: { type: "string", description: "Vault-relative path of the note." },
          line: {
            type: "number",
            description: "1-based line number of the task (from find_tasks).",
          },
          expectedRawLine: {
            type: "string",
            description:
              "EXACT raw line text from find_tasks. Required for safe " +
              "re-anchoring when the line has shifted. Always pass this.",
          },
          descriptionMatch: {
            type: "string",
            description:
              "Fallback re-anchor — substring of the task description. " +
              "Only used when expectedRawLine is absent. Fails loudly on " +
              "ambiguity (multiple matches → ambiguous_match).",
          },
          patch: {
            type: "object",
            additionalProperties: false,
            properties: {
              addTags: { type: "array", items: { type: "string" } },
              removeTags: { type: "array", items: { type: "string" } },
              setPriority: {
                type: ["string", "null"],
                enum: ["high", "medium", "low", null],
                description: "high|medium|low to set, null to clear.",
              },
              setDueDate: {
                type: ["string", "null"],
                description: "Strict YYYY-MM-DD to set, null to clear.",
              },
              setScheduledDate: {
                type: ["string", "null"],
                description: "Strict YYYY-MM-DD to set, null to clear.",
              },
              setStatus: {
                type: "string",
                enum: ["todo", "in-progress", "done", "cancelled"],
              },
              setDescription: { type: "string" },
            },
          },
        },
        additionalProperties: false,
      },
      handler: async (args: unknown) => {
        const a = (args ?? {}) as Record<string, unknown>;
        if (typeof a.path !== "string") throw new Error("`path` is required");
        if (typeof a.line !== "number") throw new Error("`line` is required");
        const p = (a.patch ?? {}) as Record<string, unknown>;
        const patch: UpdateTaskPatch = {};
        if (Array.isArray(p.addTags)) {
          patch.addTags = p.addTags.filter((t): t is string => typeof t === "string");
        }
        if (Array.isArray(p.removeTags)) {
          patch.removeTags = p.removeTags.filter((t): t is string => typeof t === "string");
        }
        if (p.setPriority === null) patch.setPriority = null;
        else if (p.setPriority === "high" || p.setPriority === "medium" || p.setPriority === "low") {
          patch.setPriority = p.setPriority;
        }
        if (p.setDueDate === null) patch.setDueDate = null;
        else if (typeof p.setDueDate === "string") patch.setDueDate = p.setDueDate;
        if (p.setScheduledDate === null) patch.setScheduledDate = null;
        else if (typeof p.setScheduledDate === "string") patch.setScheduledDate = p.setScheduledDate;
        if (
          p.setStatus === "todo" ||
          p.setStatus === "in-progress" ||
          p.setStatus === "done" ||
          p.setStatus === "cancelled"
        ) {
          patch.setStatus = p.setStatus;
        }
        if (typeof p.setDescription === "string") patch.setDescription = p.setDescription;

        const input: UpdateTaskInput = {
          path: a.path,
          line: a.line,
          patch,
        };
        if (typeof a.expectedRawLine === "string") input.expectedRawLine = a.expectedRawLine;
        if (typeof a.descriptionMatch === "string") input.descriptionMatch = a.descriptionMatch;
        return await updateTaskImpl(input, deps);
      },
    }),
  ];
}
