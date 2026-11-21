import { lookupTFile } from "./VaultPath";
import { hasUnsavedEditorChanges, ProcessAbort, type WorkspaceForWrites, type WriteToolsVault } from "./WriteTools";
import type { TFileLike } from "./ReadTools";
import type { UndoBatchItem } from "../domain/UndoJournal";

/**
 * One file in a batch write. `path` must already be a resolved
 * vault-relative path. `transform` runs inside the atomic section and
 * must re-verify whatever the caller validated; throw `ProcessAbort` to
 * abort the whole batch.
 */
export interface BatchModifyPlan {
  path: string;
  transform: (content: string) => string;
}

export type BatchWriteResult =
  | { ok: true; items: Extract<UndoBatchItem, { op: "modify" }>[] }
  | {
      ok: false;
      path: string;
      error: string;
      aborted: boolean;
      /** Paths whose rollback could not be applied because they changed again. */
      rollbackFailures: string[];
    };

/**
 * Apply `plans` in order with no per-file undo entries. On the first
 * failure every file already written is restored to the content it had
 * before this call (only if it still holds what we wrote), and the
 * failure is returned. On success the caller records one batch entry
 * from `items`; unchanged files are omitted.
 */
export async function applyBatchModifications(
  plans: readonly BatchModifyPlan[],
  deps: { vault: WriteToolsVault },
): Promise<BatchWriteResult> {
  const written: Extract<UndoBatchItem, { op: "modify" }>[] = [];
  for (const plan of plans) {
    const r = await writeOne(plan, deps.vault);
    if (!r.ok) {
      const rollbackFailures = await rollback(written, deps.vault);
      return { ok: false, path: plan.path, error: r.error, aborted: r.aborted, rollbackFailures };
    }
    if (r.before !== r.after) {
      written.push({ op: "modify", path: plan.path, before: r.before, after: r.after });
    }
  }
  return { ok: true, items: written };
}

type WriteOneResult =
  | { ok: true; before: string; after: string }
  | { ok: false; error: string; aborted: boolean };

async function writeOne(plan: BatchModifyPlan, vault: WriteToolsVault): Promise<WriteOneResult> {
  const file = lookupTFile(plan.path, vault) as TFileLike | null;
  if (!file) return { ok: false, error: `File "${plan.path}" no longer exists.`, aborted: false };

  let before = "";
  let after = "";
  try {
    if (typeof vault.process === "function") {
      await vault.process(file, (data) => {
        before = data;
        after = plan.transform(data);
        return after;
      });
    } else if (vault.modify && (vault.read || vault.cachedRead)) {
      before = vault.read ? await vault.read(file) : await vault.cachedRead!(file);
      after = plan.transform(before);
      if (after !== before) await vault.modify(file, after);
    } else {
      return { ok: false, error: "Vault adapter does not support process() or modify().", aborted: false };
    }
  } catch (err) {
    if (err instanceof ProcessAbort) return { ok: false, error: err.message, aborted: true };
    return { ok: false, error: `Write failed: ${(err as Error).message || String(err)}`, aborted: false };
  }
  return { ok: true, before, after };
}

async function rollback(
  written: readonly Extract<UndoBatchItem, { op: "modify" }>[],
  vault: WriteToolsVault,
): Promise<string[]> {
  const failures: string[] = [];
  for (const item of [...written].reverse()) {
    const r = await writeOne(
      {
        path: item.path,
        transform: (data) => {
          if (data !== item.after) throw new ProcessAbort("changed_since_write");
          return item.before;
        },
      },
      vault,
    );
    if (!r.ok) failures.push(item.path);
  }
  return failures;
}

export type LoadNoteResult =
  | { ok: true; content: string }
  | { ok: false; reason: "not_found" | "read_failed" | "unsaved_changes"; details?: string };

/** Read a note for a batch tool, refusing notes with unsaved editor changes. */
export async function loadNoteForBatch(
  vaultRel: string,
  deps: { vault: WriteToolsVault; workspace?: WorkspaceForWrites },
): Promise<LoadNoteResult> {
  const file = lookupTFile(vaultRel, deps.vault) as TFileLike | null;
  if (!file) return { ok: false, reason: "not_found" };
  let content: string;
  try {
    if (deps.vault.read) content = await deps.vault.read(file);
    else if (deps.vault.cachedRead) content = await deps.vault.cachedRead(file);
    else return { ok: false, reason: "read_failed", details: "Vault adapter does not support read()." };
  } catch (e) {
    return { ok: false, reason: "read_failed", details: (e as Error).message || String(e) };
  }
  if (await hasUnsavedEditorChanges(vaultRel, content, deps.workspace)) {
    return { ok: false, reason: "unsaved_changes", details: "Save or discard the open editor's changes first." };
  }
  return { ok: true, content };
}
