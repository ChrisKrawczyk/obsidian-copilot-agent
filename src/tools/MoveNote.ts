import { resolveVaultPath, toVaultRelative, VaultPathError, type VaultLike } from "./VaultPath";
import type { UndoBatchItem, UndoJournal } from "../domain/UndoJournal";

export const MAX_MOVE_NOTE_ITEMS = 100;

export interface MoveNoteVault extends VaultLike {
  createFolder?: (path: string) => Promise<unknown>;
  getAllLoadedFiles?: () => unknown[];
}

export interface MoveNoteFileManager {
  renameFile: (file: unknown, newPath: string) => Promise<void>;
}

export interface MoveNoteDeps {
  vault: MoveNoteVault;
  fileManager?: MoveNoteFileManager;
  configDir?: string;
  undoJournal: UndoJournal;
}

export interface MoveNoteItem {
  from: string;
  to: string;
}

export type MoveNoteFailureReason =
  | "invalid_item"
  | "invalid_path"
  | "not_found"
  | "same_path"
  | "target_exists"
  | "parent_is_file"
  | "folder_case_mismatch"
  | "duplicate_source"
  | "duplicate_destination"
  | "overlapping_items"
  | "into_own_subtree"
  | "config_dir";

export interface MoveNoteFailure {
  index: number;
  from: string;
  to: string;
  reason: MoveNoteFailureReason;
  details?: string;
}

export interface MoveNotePlan {
  from: string;
  to: string;
  kind: "file" | "folder";
}

export interface MoveNoteAnalysis {
  plans: MoveNotePlan[];
  failures: MoveNoteFailure[];
}

export type MoveNoteResult =
  | {
      ok: true;
      moved: MoveNotePlan[];
      undoId: string;
      undoSurface: "journal";
      links: string;
    }
  | { ok: false; reason: "unavailable"; error: string }
  | { ok: false; reason: "no_items" }
  | { ok: false; reason: "too_many_items"; count: number; max: number }
  | { ok: false; reason: "validation_failed"; failures: MoveNoteFailure[] }
  | {
      ok: false;
      reason: "move_failed";
      index: number;
      from: string;
      to: string;
      error: string;
      rolledBack: boolean;
      rollbackFailures: string[];
    };

const LINKS_NOTE =
  "Links to moved items were updated according to Obsidian's \"Automatically update internal links\" setting.";

export function isFolderLike(file: unknown): boolean {
  return !!file && typeof file === "object" && "children" in file;
}

function lookup(vault: VaultLike, path: string): unknown | null {
  return vault.getAbstractFileByPath?.(path) ?? vault.getFileByPath?.(path) ?? null;
}

function parentOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? "" : path.slice(0, i);
}

function isWithin(path: string, folder: string): boolean {
  return path.toLowerCase().startsWith(folder.toLowerCase() + "/");
}

function sameIgnoringCase(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/** Create every missing ancestor folder of `path`, tolerating races with folders that appear meanwhile. */
export async function ensureParentFolder(vault: MoveNoteVault, path: string): Promise<void> {
  const parent = parentOf(path);
  if (!parent) return;
  const parts = parent.split("/");
  for (let i = 1; i <= parts.length; i++) {
    const folder = parts.slice(0, i).join("/");
    const existing = lookup(vault, folder);
    if (existing) {
      if (!isFolderLike(existing)) throw new Error(`"${folder}" is a file, not a folder.`);
      continue;
    }
    if (!vault.createFolder) throw new Error("Vault adapter cannot create folders.");
    try {
      await vault.createFolder(folder);
    } catch (e) {
      if (!lookup(vault, folder)) throw e;
    }
  }
}

/** Link-aware move of the item at `from` to `to`, creating missing parent folders. */
export async function moveVaultItem(
  vault: MoveNoteVault,
  fileManager: MoveNoteFileManager,
  from: string,
  to: string,
): Promise<void> {
  const file = lookup(vault, from);
  if (!file) throw new Error(`"${from}" no longer exists.`);
  await ensureParentFolder(vault, to);
  await fileManager.renameFile(file, to);
}

function normalize(input: string, vault: VaultLike): string {
  return toVaultRelative(resolveVaultPath(input, vault), vault);
}

/** Read-only validation of every move; nothing is moved. */
export function analyzeMoveNote(
  items: readonly MoveNoteItem[],
  deps: Pick<MoveNoteDeps, "vault" | "configDir">,
): MoveNoteAnalysis {
  const failures: MoveNoteFailure[] = [];
  const resolved: Array<{ index: number; from: string; to: string; kind: "file" | "folder" } | null> = [];
  const lowerIndex = buildLowerCaseIndex(deps.vault);
  const configDir = deps.configDir?.replace(/\/+$/, "");

  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const fail = (reason: MoveNoteFailureReason, from: string, to: string, details?: string) => {
      failures.push({ index: i, from, to, reason, ...(details ? { details } : {}) });
      resolved.push(null);
    };
    if (!it.from || !it.to) {
      fail("invalid_item", it.from, it.to, "Each item needs non-empty from and to paths.");
      continue;
    }
    let from: string;
    let to: string;
    try {
      from = normalize(it.from, deps.vault);
      to = normalize(it.to, deps.vault);
    } catch (e) {
      if (e instanceof VaultPathError) {
        fail("invalid_path", it.from, it.to, e.message);
        continue;
      }
      throw e;
    }
    if (configDir && [from, to].some((p) => sameIgnoringCase(p, configDir) || isWithin(p, configDir))) {
      fail("config_dir", from, to, `Items inside "${configDir}" can't be moved.`);
      continue;
    }
    if (from === to) {
      fail("same_path", from, to);
      continue;
    }
    const source = lookup(deps.vault, from);
    if (!source) {
      fail("not_found", from, to);
      continue;
    }
    const kind = isFolderLike(source) ? "folder" : "file";
    if (kind === "folder" && isWithin(to, from)) {
      fail("into_own_subtree", from, to);
      continue;
    }
    const atTo = lookup(deps.vault, to);
    const occupied = sameIgnoringCase(from, to)
      ? atTo !== null && atTo !== source
      : atTo !== null || lowerIndex?.has(to.toLowerCase()) === true;
    if (occupied) {
      fail("target_exists", from, to);
      continue;
    }
    const parent = checkParent(deps.vault, lowerIndex, to);
    if (parent) {
      fail(parent.reason, from, to, parent.details);
      continue;
    }
    resolved.push({ index: i, from, to, kind });
  }

  const valid = resolved.filter((r): r is NonNullable<typeof r> => r !== null);
  const conflicts = new Map<number, { reason: MoveNoteFailureReason; details: string }>();
  for (const a of valid) {
    for (const b of valid) {
      if (a === b || conflicts.has(a.index)) continue;
      const earlier = b.index < a.index;
      if (sameIgnoringCase(a.from, b.from) && earlier) {
        conflicts.set(a.index, { reason: "duplicate_source", details: `Same source as item ${b.index + 1}.` });
      } else if (sameIgnoringCase(a.to, b.to) && earlier) {
        conflicts.set(a.index, { reason: "duplicate_destination", details: `Same destination as item ${b.index + 1}.` });
      } else if (b.kind === "folder" && [a.from, a.to].some((p) => isWithin(p, b.from) || isWithin(p, b.to))) {
        conflicts.set(a.index, { reason: "overlapping_items", details: `Overlaps folder move ${b.index + 1}; move the folder or its contents, not both.` });
      } else if (b.kind === "file" && isWithin(a.to, b.to)) {
        conflicts.set(a.index, { reason: "parent_is_file", details: `Item ${b.index + 1} moves a file to "${b.to}", which this destination needs as a folder.` });
      }
    }
  }
  for (const r of valid) {
    const c = conflicts.get(r.index);
    if (c) failures.push({ index: r.index, from: r.from, to: r.to, reason: c.reason, details: c.details });
  }
  failures.sort((x, y) => x.index - y.index);
  return {
    plans: valid.filter((r) => !conflicts.has(r.index)).map(({ from, to, kind }) => ({ from, to, kind })),
    failures,
  };
}

function buildLowerCaseIndex(vault: MoveNoteVault): Map<string, string> | null {
  if (typeof vault.getAllLoadedFiles !== "function") return null;
  const out = new Map<string, string>();
  for (const f of vault.getAllLoadedFiles()) {
    const p = (f as { path?: unknown })?.path;
    if (typeof p === "string" && p.length > 0) out.set(p.toLowerCase(), p);
  }
  return out;
}

function checkParent(
  vault: VaultLike,
  lowerIndex: Map<string, string> | null,
  path: string,
): { reason: MoveNoteFailureReason; details: string } | null {
  let parent = parentOf(path);
  while (parent) {
    const f = lookup(vault, parent);
    if (f) return isFolderLike(f) ? null : { reason: "parent_is_file", details: `"${parent}" is a file, not a folder.` };
    const existing = lowerIndex?.get(parent.toLowerCase());
    if (existing) {
      return {
        reason: "folder_case_mismatch",
        details: `Folder "${existing}" already exists with different letter case; use that spelling.`,
      };
    }
    parent = parentOf(parent);
  }
  return null;
}

/**
 * Move or rename many vault items with Obsidian's link-aware rename.
 * Every item is validated first; a mid-call failure moves the completed
 * items back. One Undo entry covers the whole call.
 */
export async function moveNoteImpl(items: readonly MoveNoteItem[], deps: MoveNoteDeps): Promise<MoveNoteResult> {
  const fileManager = deps.fileManager;
  if (!fileManager) return { ok: false, reason: "unavailable", error: "Link-aware moves are not available." };
  if (items.length === 0) return { ok: false, reason: "no_items" };
  if (items.length > MAX_MOVE_NOTE_ITEMS) {
    return { ok: false, reason: "too_many_items", count: items.length, max: MAX_MOVE_NOTE_ITEMS };
  }
  const { plans, failures } = analyzeMoveNote(items, deps);
  if (failures.length > 0) return { ok: false, reason: "validation_failed", failures };

  const done: MoveNotePlan[] = [];
  for (let i = 0; i < plans.length; i++) {
    const p = plans[i];
    try {
      await moveVaultItem(deps.vault, fileManager, p.from, p.to);
      done.push(p);
    } catch (e) {
      const rollbackFailures: string[] = [];
      for (let k = done.length - 1; k >= 0; k--) {
        try {
          await moveVaultItem(deps.vault, fileManager, done[k].to, done[k].from);
        } catch {
          rollbackFailures.push(done[k].to);
        }
      }
      return {
        ok: false,
        reason: "move_failed",
        index: i,
        from: p.from,
        to: p.to,
        error: (e as Error).message || String(e),
        rolledBack: rollbackFailures.length === 0,
        rollbackFailures,
      };
    }
  }

  const undoItems: UndoBatchItem[] = done.map((p) => ({ op: "move", from: p.from, to: p.to }));
  const entry = deps.undoJournal.record({
    kind: "batch",
    scope: "vault",
    path: done[0].to,
    items: undoItems,
    label: done.length === 1 ? `${done[0].from} → ${done[0].to}` : `${done.length} items`,
  });
  return { ok: true, moved: done, undoId: entry.id, undoSurface: "journal", links: LINKS_NOTE };
}
