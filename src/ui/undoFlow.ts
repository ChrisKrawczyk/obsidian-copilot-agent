import type { UndoJournal, UndoOutcome } from "../domain/UndoJournal";

/**
 * v0.3 Phase 6 (FR-012): orchestrator for the Undo button flow,
 * extracted from `ChatView.handleUndoClick` so the divergence-aware
 * confirm/retry path can be unit-tested without standing up a DOM or
 * an `ItemView` instance. The view passes its `confirm`/`notify`
 * callbacks (typically wrapping `confirmDestructive` and `new Notice`)
 * and the helper handles the rest.
 *
 * Behaviour:
 *  - If the journal returns `ok:true`, return `{ result: "success",
 *    entry }`. The view then marks the corresponding ToolCall as
 *    `undone: true`.
 *  - If the journal returns `ok:false` with a divergence code
 *    (`modified` / `missing` / `existed`), prompt the user. On
 *    confirm, re-run with `{ force: true }`. On decline, return
 *    `{ result: "cancelled" }`.
 *  - On any other `ok:false`, surface `outcome.reason` via `notify`
 *    and return `{ result: "failed" }`.
 *  - If the journal has no record of `undoId`, return
 *    `{ result: "missing-entry" }` after notifying.
 */
export type UndoFlowResult =
  | { result: "success"; entry: ReturnType<UndoJournal["get"]> & {} }
  | { result: "cancelled" }
  | { result: "failed" }
  | { result: "missing-entry" }
  | { result: "no-journal" };

export interface UndoFlowDeps {
  journal: Pick<UndoJournal, "get" | "undo"> | undefined;
  /** Returns true if the user accepts the divergence prompt. */
  confirm: (title: string, body: string, ctaLabel: string) => Promise<boolean>;
  /** Shows a user-facing error/info message. */
  notify: (message: string) => void;
}

export async function runUndoFlow(
  undoId: string,
  deps: UndoFlowDeps,
): Promise<UndoFlowResult> {
  if (!deps.journal) {
    deps.notify("Undo is not available in this build.");
    return { result: "no-journal" };
  }
  const entry = deps.journal.get(undoId);
  if (!entry) {
    deps.notify("Cannot undo: no journal entry for this action.");
    return { result: "missing-entry" };
  }
  let outcome: UndoOutcome = await deps.journal.undo(entry.id);
  if (!outcome.ok && outcome.divergence && outcome.divergence !== "ok") {
    const accepted = await deps.confirm(
      "Undo with divergence",
      outcome.divergentPaths && outcome.divergentPaths.length > 0
        ? batchDivergenceConfirmMessage(outcome.divergentPaths)
        : divergenceConfirmMessage(outcome.divergence, entry.path),
      "Revert anyway",
    );
    if (!accepted) return { result: "cancelled" };
    outcome = await deps.journal.undo(entry.id, { force: true });
  }
  if (!outcome.ok) {
    deps.notify(outcome.reason ?? "Undo failed.");
    return { result: "failed" };
  }
  if (outcome.skippedPaths && outcome.skippedPaths.length > 0) {
    deps.notify(skippedPathsMessage(outcome.skippedPaths));
  }
  return { result: "success", entry } as UndoFlowResult;
}

/**
 * v0.3 Phase 6 (FR-012): user-facing copy for each divergence kind.
 * Exported so tests can assert the prompt text without duplicating it.
 */
export function divergenceConfirmMessage(
  divergence: "modified" | "missing" | "existed",
  path: string,
): string {
  switch (divergence) {
    case "modified":
      return `"${path}" has been modified outside the agent since this action ran. Revert to the recorded snapshot anyway?`;
    case "missing":
      return `"${path}" no longer exists. Recreate it from the recorded snapshot?`;
    case "existed":
      return `A file already exists at "${path}". Overwrite it with the recorded snapshot?`;
  }
}

const MAX_LISTED_PATHS = 10;

function listPaths(paths: readonly string[]): string {
  const shown = paths.slice(0, MAX_LISTED_PATHS).map((p) => `- "${p}"`);
  if (paths.length > MAX_LISTED_PATHS) shown.push(`- and ${paths.length - MAX_LISTED_PATHS} more`);
  return shown.join("\n");
}

/** Batch entries: one prompt naming every diverged path. */
export function batchDivergenceConfirmMessage(paths: readonly string[]): string {
  if (paths.length === 1) {
    return `"${paths[0]}" has changed outside the agent since this action ran. Revert every item in this action to the recorded snapshot anyway?`;
  }
  return `${paths.length} paths have changed outside the agent since this action ran:\n${listPaths(paths)}\nRevert every item in this action to the recorded snapshot anyway?`;
}

export function skippedPathsMessage(paths: readonly string[]): string {
  return `Undo finished, but ${paths.length === 1 ? "1 item was" : `${paths.length} items were`} left in place because moving back would overwrite another file or the item is gone:\n${listPaths(paths)}`;
}
