import { defineTool, type Tool } from "@github/copilot-sdk";
import {
  resolveVaultPath,
  toVaultRelative,
  lookupTFile,
  VaultPathError,
} from "./VaultPath";
import type { UndoJournal, UndoEntry } from "../domain/UndoJournal";
import type { ReadToolsVault, TFileLike } from "./ReadTools";

/**
 * Vault surface used by our write tools. A superset of `ReadToolsVault`
 * with the write-side methods we delegate to Obsidian for.
 *
 * `getLeavesOfType` and friends are used for unsaved-editor-conflict
 * detection on `edit_file`. We keep the surface narrow so tests can
 * pass a plain fixture.
 */
export interface WriteToolsVault extends ReadToolsVault {
  create?: (path: string, content: string) => Promise<unknown>;
  /**
   * Create a folder (and any missing intermediates). Obsidian's vault
   * adapter accepts `/`-separated paths. Optional because not every
   * fake vault in tests bothers to implement it; callers must
   * defensively check before invoking.
   */
  createFolder?: (path: string) => Promise<unknown>;
  modify?: (file: TFileLike, content: string) => Promise<unknown>;
  /**
   * Atomic read-modify-write on a note. Obsidian's `Vault.process`
   * primitive (`@since 1.1.0`) — reads the current file content,
   * invokes `fn` synchronously with that content, then atomically
   * writes the returned string back. Concurrent `process` calls
   * against the same file are serialized by the host, eliminating
   * lost-update races when multiple tool calls target the same note
   * in parallel. Optional so exotic test fakes can omit it; the
   * higher-level helpers fall back to legacy `read` + `modify` when
   * absent.
   */
  process?: (
    file: TFileLike,
    fn: (data: string) => string,
  ) => Promise<string>;
  delete?: (file: TFileLike, system?: boolean) => Promise<void>;
  trash?: (file: TFileLike, system?: boolean) => Promise<void>;
}

/**
 * Workspace helper used only by `edit_file` for the unsaved-editor
 * conflict check. Tests pass a fake; in production this is
 * `this.app.workspace`.
 */
export interface WorkspaceForWrites {
  getLeavesOfType?: (type: string) => Array<{ view: unknown }>;
}

/**
 * Per-call dependencies — passed in by `AgentSession` so the tool
 * handlers can record undo entries against the live journal and
 * inspect open Obsidian markdown editors.
 */
export interface WriteToolsDeps {
  vault: WriteToolsVault;
  workspace?: WorkspaceForWrites;
  undoJournal: UndoJournal;
}

interface WriteResult<T extends "create" | "modify" | "delete"> {
  ok: true;
  kind: T;
  path: string;
  undoId: string;
}

interface WriteError {
  ok: false;
  error: string;
}

export type CreateFileResult = WriteResult<"create"> | WriteError;
export type EditFileResult = WriteResult<"modify"> | WriteError;
export type DeleteFileResult = WriteResult<"delete"> | WriteError;

// ---------------- pure-ish impls (testable without the SDK) ----------------

export async function createFileImpl(
  rawPath: string,
  content: string,
  deps: WriteToolsDeps,
): Promise<CreateFileResult> {
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
      error: `File "${vaultRel}" already exists. Use edit_file to modify it.`,
    };
  }
  if (!deps.vault.create) {
    return { ok: false, error: "Vault adapter does not support create()." };
  }
  try {
    await deps.vault.create(vaultRel, content ?? "");
  } catch (err) {
    return {
      ok: false,
      error: `Create failed: ${(err as Error).message || String(err)}`,
    };
  }
  const entry: UndoEntry = deps.undoJournal.record({
    kind: "create",
    scope: "vault",
    path: vaultRel,
    after: content ?? "",
  });
  return { ok: true, kind: "create", path: vaultRel, undoId: entry.id };
}

/**
 * Detect whether an open Obsidian markdown editor for `vaultRel` has
 * unsaved changes vs the on-disk content of `file`. Returns true iff
 * a dirty buffer exists. If no editor is open for the file, returns
 * false (safe to write).
 */
export async function hasUnsavedEditorChanges(
  vaultRel: string,
  diskContent: string,
  workspace: WorkspaceForWrites | undefined,
): Promise<boolean> {
  if (!workspace?.getLeavesOfType) return false;
  const leaves = workspace.getLeavesOfType("markdown") ?? [];
  for (const leaf of leaves) {
    const view = leaf.view as
      | {
          file?: { path?: string } | null;
          getViewData?: () => string;
        }
      | undefined;
    if (!view || !view.file || view.file.path !== vaultRel) continue;
    const buf = typeof view.getViewData === "function" ? view.getViewData() : "";
    if (buf !== diskContent) return true;
  }
  return false;
}

export async function editFileImpl(
  rawPath: string,
  content: string,
  deps: WriteToolsDeps,
): Promise<EditFileResult> {
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
      error: `File "${vaultRel}" does not exist. Use create_file to add it.`,
    };
  }
  const file = fileUnknown as TFileLike;
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
      error: `Read failed before edit: ${(err as Error).message || String(err)}`,
    };
  }
  const conflict = await hasUnsavedEditorChanges(
    vaultRel,
    before,
    deps.workspace,
  );
  if (conflict) {
    return {
      ok: false,
      error: `File "${vaultRel}" has unsaved changes in an open editor. Save or discard them, then try again.`,
    };
  }
  if (!deps.vault.modify) {
    return { ok: false, error: "Vault adapter does not support modify()." };
  }
  try {
    await deps.vault.modify(file, content ?? "");
  } catch (err) {
    return {
      ok: false,
      error: `Modify failed: ${(err as Error).message || String(err)}`,
    };
  }
  const entry = deps.undoJournal.record({
    kind: "modify",
    scope: "vault",
    path: vaultRel,
    before,
    after: content ?? "",
  });
  return { ok: true, kind: "modify", path: vaultRel, undoId: entry.id };
}

/**
 * Sentinel error thrown from inside a `processFileImpl` callback to
 * abort the atomic RMW cleanly. The write is not performed and no
 * undo entry is recorded. `processFileImpl` catches this error and
 * returns `{ ok: false, aborted: true, error: <reason> }`.
 *
 * Callers use this when a mid-computation invariant fails (target
 * line disappeared, content became unparseable, etc.) so the outer
 * tool can surface a structured error without leaving a stale write
 * or a bogus undo entry on the journal.
 */
export class ProcessAbort extends Error {
  readonly _processAbort = true;
  constructor(message: string) {
    super(message);
    this.name = "ProcessAbort";
  }
}

/**
 * Result shape for `processFileImpl`. `ok: true, changed: false`
 * indicates the callback returned unchanged content (no-op) — no
 * write occurred and no undo entry was recorded. `ok: false,
 * aborted: true` indicates the callback threw a `ProcessAbort`.
 */
export type ProcessFileResult =
  | { ok: true; kind: "modify"; path: string; changed: true; undoId: string }
  | { ok: true; kind: "modify"; path: string; changed: false }
  | { ok: false; error: string; aborted?: boolean };

/**
 * Atomic read-modify-write via Obsidian's `Vault.process` primitive.
 * The callback runs synchronously inside the atomic section; async
 * pre-write work (path resolution, dirty-editor guard) happens
 * before entering the atomic section.
 *
 * Semantics:
 * - Callback signature: `(data: string) => string`. `data` is the
 *   current on-disk content observed atomically.
 * - Return the same string unchanged for a no-op; no write, no undo.
 * - Throw `new ProcessAbort(reason)` to abort with no write and no
 *   undo; the outer result is `{ ok: false, aborted: true, error }`.
 * - Any other throw is surfaced as a native failure.
 *
 * Undo `before` is the value passed into the callback (captured
 * inside the atomic section); `after` is the string the callback
 * returns. This guarantees the undo entry reflects the exact
 * transition that landed on disk, even under contention.
 *
 * Falls back to the legacy `editFileImpl` path when the vault does
 * not expose `process` — a defense-in-depth for exotic fakes;
 * production always has it.
 */
export async function processFileImpl(
  rawPath: string,
  fn: (data: string) => string,
  deps: WriteToolsDeps,
): Promise<ProcessFileResult> {
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
      error: `File "${vaultRel}" does not exist. Use create_file to add it.`,
    };
  }
  const file = fileUnknown as TFileLike;

  // Pre-atomic dirty-editor guard. Snapshot the current on-disk
  // content once for the comparison; the atomic section that follows
  // will re-observe it anyway, but the guard runs on the pre-atomic
  // snapshot so we don't need an async check inside the sync
  // callback (which `Vault.process` doesn't allow).
  let preSnapshot: string;
  try {
    if (deps.vault.read) {
      preSnapshot = await deps.vault.read(file);
    } else if (deps.vault.cachedRead) {
      preSnapshot = await deps.vault.cachedRead(file);
    } else {
      return { ok: false, error: "Vault adapter does not support read()." };
    }
  } catch (err) {
    return {
      ok: false,
      error: `Read failed before process: ${(err as Error).message || String(err)}`,
    };
  }
  const conflict = await hasUnsavedEditorChanges(
    vaultRel,
    preSnapshot,
    deps.workspace,
  );
  if (conflict) {
    return {
      ok: false,
      error: `File "${vaultRel}" has unsaved changes in an open editor. Save or discard them, then try again.`,
    };
  }

  // Fallback to legacy read+modify when the host lacks `process`.
  // Correctness under parallel calls is not guaranteed on this path,
  // but production always has `process`, so this is only for exotic
  // test fakes that opt into the legacy behavior.
  if (typeof deps.vault.process !== "function") {
    if (!deps.vault.modify) {
      return { ok: false, error: "Vault adapter does not support process() or modify()." };
    }
    let nextContent: string;
    try {
      nextContent = fn(preSnapshot);
    } catch (err) {
      if (err instanceof ProcessAbort) {
        return { ok: false, error: err.message, aborted: true };
      }
      throw err;
    }
    if (nextContent === preSnapshot) {
      return { ok: true, kind: "modify", path: vaultRel, changed: false };
    }
    try {
      await deps.vault.modify(file, nextContent);
    } catch (err) {
      return {
        ok: false,
        error: `Modify failed: ${(err as Error).message || String(err)}`,
      };
    }
    const entry = deps.undoJournal.record({
      kind: "modify",
      scope: "vault",
      path: vaultRel,
      before: preSnapshot,
      after: nextContent,
    });
    return { ok: true, kind: "modify", path: vaultRel, changed: true, undoId: entry.id };
  }

  // Atomic RMW via Obsidian's Vault.process. Capture before/after
  // inside the callback so the undo entry reflects the exact
  // transition that landed on disk.
  let observedBefore = "";
  let observedAfter = "";
  let aborted: ProcessAbort | null = null;
  try {
    await deps.vault.process(file, (data) => {
      observedBefore = data;
      try {
        const next = fn(data);
        observedAfter = next;
        return next;
      } catch (err) {
        if (err instanceof ProcessAbort) {
          aborted = err;
          // Return unchanged to avoid a spurious write; the outer
          // catch handles the abort.
          observedAfter = data;
          return data;
        }
        throw err;
      }
    });
  } catch (err) {
    return {
      ok: false,
      error: `Process failed: ${(err as Error).message || String(err)}`,
    };
  }
  if (aborted !== null) {
    return { ok: false, error: (aborted as ProcessAbort).message, aborted: true };
  }
  if (observedAfter === observedBefore) {
    return { ok: true, kind: "modify", path: vaultRel, changed: false };
  }
  const entry = deps.undoJournal.record({
    kind: "modify",
    scope: "vault",
    path: vaultRel,
    before: observedBefore,
    after: observedAfter,
  });
  return { ok: true, kind: "modify", path: vaultRel, changed: true, undoId: entry.id };
}

export async function deleteFileImpl(
  rawPath: string,
  deps: WriteToolsDeps,
): Promise<DeleteFileResult> {
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
    return { ok: false, error: `File "${vaultRel}" does not exist.` };
  }
  const file = fileUnknown as TFileLike;
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
      error: `Read failed before delete: ${(err as Error).message || String(err)}`,
    };
  }
  try {
    // Prefer trash (recoverable in Obsidian) over delete.
    if (deps.vault.trash) {
      await deps.vault.trash(file, true);
    } else if (deps.vault.delete) {
      await deps.vault.delete(file, true);
    } else {
      return { ok: false, error: "Vault adapter does not support delete()." };
    }
  } catch (err) {
    return {
      ok: false,
      error: `Delete failed: ${(err as Error).message || String(err)}`,
    };
  }
  const entry = deps.undoJournal.record({
    kind: "delete",
    scope: "vault",
    path: vaultRel,
    before,
  });
  return { ok: true, kind: "delete", path: vaultRel, undoId: entry.id };
}

// ---------------- tool definitions ----------------

/**
 * Build the three Phase-6 write tools. These are registered alongside
 * Phase 5's read tools in `main.ts`. Unlike read tools, write tools
 * do NOT pass `skipPermission: true` — every call routes through
 * `AgentSession.handlePermission` → `SafetyPolicy.decideSafety`.
 *
 * `overridesBuiltInTool: true` is set on `edit_file` because it
 * conflicts with the SDK's built-in `edit_file`. `create_file` and
 * `delete_file` may or may not clash; we set the flag defensively so
 * the SDK doesn't reject session creation if a future built-in lands
 * with the same name.
 */
export function createWriteTools(deps: WriteToolsDeps): Tool<unknown>[] {
  return [
    defineTool("create_file", {
      description:
        "Create a new file in the Obsidian vault. Path is " +
        "vault-relative; absolute paths are rejected. Fails if the " +
        "file already exists — use edit_file instead.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Vault-relative path of the file to create.",
          },
          content: {
            type: "string",
            description: "File contents to write.",
          },
        },
        required: ["path"],
        additionalProperties: false,
      },
      overridesBuiltInTool: true,
      handler: async (args: unknown) => {
        const parsed = (args ?? {}) as { path?: unknown; content?: unknown };
        const path = typeof parsed.path === "string" ? parsed.path : "";
        const content =
          typeof parsed.content === "string" ? parsed.content : "";
        return await createFileImpl(path, content, deps);
      },
    }),
    defineTool("edit_file", {
      description:
        "Overwrite an existing file in the Obsidian vault with new " +
        "content. Path is vault-relative; absolute paths are " +
        "rejected. Fails if the file does not exist or has unsaved " +
        "changes in an open editor.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Vault-relative path of the file to edit.",
          },
          content: {
            type: "string",
            description: "Full new content for the file.",
          },
        },
        required: ["path", "content"],
        additionalProperties: false,
      },
      overridesBuiltInTool: true,
      handler: async (args: unknown) => {
        const parsed = (args ?? {}) as { path?: unknown; content?: unknown };
        const path = typeof parsed.path === "string" ? parsed.path : "";
        const content =
          typeof parsed.content === "string" ? parsed.content : "";
        return await editFileImpl(path, content, deps);
      },
    }),
    defineTool("delete_file", {
      description:
        "Delete (move to Obsidian's trash) an existing file in the " +
        "vault. Path is vault-relative; absolute paths are rejected. " +
        "Use the Undo button in chat to restore.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Vault-relative path of the file to delete.",
          },
        },
        required: ["path"],
        additionalProperties: false,
      },
      overridesBuiltInTool: true,
      handler: async (args: unknown) => {
        const parsed = (args ?? {}) as { path?: unknown };
        const path = typeof parsed.path === "string" ? parsed.path : "";
        return await deleteFileImpl(path, deps);
      },
    }),
  ];
}

/** Names of the tools we register, for SafetyPolicy classification. */
export const WRITE_TOOL_NAMES = ["create_file", "edit_file", "delete_file"] as const;
export type WriteToolName = (typeof WRITE_TOOL_NAMES)[number];
export function isWriteToolName(name: string): name is WriteToolName {
  return (WRITE_TOOL_NAMES as readonly string[]).includes(name);
}

/**
 * Names of every mutating tool that targets the **vault** (file paths,
 * editor buffer, etc.) — superset of `WRITE_TOOL_NAMES` plus the
 * Phase 4/5 note-write tools. `AgentSession.buildSafetyInput` uses this
 * to classify a tool call as `source: 'vault'` for the SafetyPolicy.
 *
 * `open_note` is NOT included even though it changes the workspace —
 * it's read-equivalent navigation and skips the permission gate.
 */
export const VAULT_WRITE_TOOL_NAMES = [
  ...WRITE_TOOL_NAMES,
  "create_note",
  "edit_note",
  "insert_into_active_note",
  "create_daily_note",
  "create_task",
  "update_task",
] as const;
export type VaultWriteToolName = (typeof VAULT_WRITE_TOOL_NAMES)[number];
export function isVaultWriteToolName(name: string): name is VaultWriteToolName {
  return (VAULT_WRITE_TOOL_NAMES as readonly string[]).includes(name);
}
