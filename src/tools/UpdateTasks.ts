import { formatTaskLine, parseTaskLine } from "./TaskFormat";
import {
  applyPatch,
  findExpectedLine,
  formatYmd,
  validatePatch,
  type UpdateTaskCandidate,
  type UpdateTaskPatch,
  type UpdateTaskResult,
} from "./UpdateTask";
import { applyBatchModifications } from "./BatchWrite";
import { hasUnsavedEditorChanges, ProcessAbort } from "./WriteTools";
import type { WriteNoteToolsDeps } from "./WriteNoteTools";
import { lookupTFile, resolveVaultPath, toVaultRelative, VaultPathError } from "./VaultPath";
import type { TFileLike } from "./ReadTools";
import { MAX_BATCH_SNAPSHOT_BYTES } from "../domain/UndoJournal";

export const MAX_UPDATE_TASKS_TARGETS = 200;

export interface UpdateTasksTarget {
  path: string;
  /** 1-based line number from `find_tasks`. */
  line: number;
  expectedRawLine?: string;
}

export interface UpdateTasksInput {
  targets: UpdateTasksTarget[];
  patch: UpdateTaskPatch;
}

export type UpdateTasksFailureReason =
  | "invalid_target"
  | "invalid_path"
  | "not_found"
  | "read_failed"
  | "unsaved_changes"
  | "task_not_found"
  | "ambiguous_match"
  | "not_a_task"
  | "duplicate_target";

export interface UpdateTasksFailure {
  index: number;
  path: string;
  line: number;
  reason: UpdateTasksFailureReason;
  details?: string;
  candidates?: UpdateTaskCandidate[];
}

export interface UpdateTasksRow {
  path: string;
  line: number;
  before: string;
  after: string;
  changedFields: string[];
  changed: boolean;
}

type PatchError = Extract<
  UpdateTaskResult,
  { reason: "invalid_date_format" | "invalid_priority" | "invalid_status" }
>;

export type UpdateTasksResult =
  | {
      ok: true;
      changed: boolean;
      tasksChanged: number;
      notesChanged: number;
      results: UpdateTasksRow[];
      undoId?: string;
      undoSurface?: "journal";
    }
  | PatchError
  | { ok: false; reason: "no_targets" }
  | { ok: false; reason: "too_many_targets"; count: number; max: number }
  | { ok: false; reason: "validation_failed"; failures: UpdateTasksFailure[] }
  | { ok: false; reason: "snapshot_too_large"; bytes: number; max: number }
  | {
      ok: false;
      reason: "concurrent_change" | "write_failed";
      path: string;
      error: string;
      rolledBack: boolean;
      rollbackFailures: string[];
    };

interface PlannedTarget {
  row: UpdateTasksRow;
  hintLine: number;
  expectedRawLine: string;
}

export interface UpdateTasksNotePlan {
  path: string;
  content: string;
  newContent: string;
  targets: PlannedTarget[];
}

export interface UpdateTasksAnalysis {
  /** Rows in input order for targets that passed validation. */
  rows: UpdateTasksRow[];
  failures: UpdateTasksFailure[];
  notes: UpdateTasksNotePlan[];
  /** before + after bytes of every note the call would change. */
  snapshotBytes: number;
}

const encoder = new TextEncoder();

/**
 * Resolve and check every target against the current vault content and
 * compute the before → after line for each. Pure with respect to the
 * vault: reads only.
 */
export async function analyzeUpdateTasks(
  input: UpdateTasksInput,
  deps: Pick<WriteNoteToolsDeps, "vault" | "workspace" | "now">,
): Promise<UpdateTasksAnalysis> {
  const failures: UpdateTasksFailure[] = [];
  const notes = new Map<string, UpdateTasksNotePlan & { lines: string[]; taken: Set<number> }>();
  const unreadable = new Map<string, { reason: UpdateTasksFailureReason; details?: string }>();
  const today = formatYmd(deps.now());
  const rowsByIndex = new Map<number, UpdateTasksRow>();

  for (let i = 0; i < input.targets.length; i++) {
    const t = input.targets[i];
    const line = Number.isFinite(t.line) ? t.line : 0;
    const fail = (reason: UpdateTasksFailureReason, extra: Partial<UpdateTasksFailure> = {}) =>
      failures.push({ index: i, path: t.path, line, reason, ...extra });

    if (!t.path || !Number.isInteger(t.line) || t.line < 1 || typeof t.expectedRawLine !== "string") {
      fail("invalid_target", { details: "Each target needs path, a 1-based line and expectedRawLine." });
      continue;
    }

    let vaultRel: string;
    try {
      vaultRel = toVaultRelative(resolveVaultPath(t.path, deps.vault), deps.vault);
    } catch (e) {
      if (e instanceof VaultPathError) {
        fail("invalid_path", { details: e.message });
        continue;
      }
      throw e;
    }

    const blocked = unreadable.get(vaultRel);
    if (blocked) {
      fail(blocked.reason, { path: vaultRel, details: blocked.details });
      continue;
    }

    let note = notes.get(vaultRel);
    if (!note) {
      const loaded = await loadNote(vaultRel, deps);
      if (!loaded.ok) {
        unreadable.set(vaultRel, loaded);
        fail(loaded.reason, { path: vaultRel, details: loaded.details });
        continue;
      }
      note = {
        path: vaultRel,
        content: loaded.content,
        newContent: loaded.content,
        targets: [],
        lines: loaded.content.split("\n"),
        taken: new Set(),
      };
      notes.set(vaultRel, note);
    }

    const found = findExpectedLine(note.lines, t.line, t.expectedRawLine);
    if (!found.ok) {
      if (found.reason === "ambiguous_match") {
        fail("ambiguous_match", { path: vaultRel, candidates: found.candidates });
      } else {
        fail("task_not_found", { path: vaultRel });
      }
      continue;
    }
    if (note.taken.has(found.index)) {
      fail("duplicate_target", { path: vaultRel, details: `Line ${found.index + 1} is already targeted.` });
      continue;
    }
    const raw = note.lines[found.index];
    const parsed = parseTaskLine(raw);
    if (!parsed.ok) {
      fail("not_a_task", { path: vaultRel, details: raw });
      continue;
    }
    note.taken.add(found.index);
    const { patched, changedFields } = applyPatch(parsed.parsed, input.patch, today);
    const after = parsed.parsed.leadingIndent + formatTaskLine(patched, parsed.parsed.source);
    const changed = after !== raw;
    const row: UpdateTasksRow = {
      path: vaultRel,
      line: found.index + 1,
      before: raw,
      after,
      changedFields: changed ? changedFields : [],
      changed,
    };
    rowsByIndex.set(i, row);
    note.targets.push({ row, hintLine: found.index + 1, expectedRawLine: t.expectedRawLine });
  }

  let snapshotBytes = 0;
  const notePlans: UpdateTasksNotePlan[] = [];
  for (const note of notes.values()) {
    if (note.targets.length === 0) continue;
    const lines = [...note.lines];
    for (const pt of note.targets) lines[pt.row.line - 1] = pt.row.after;
    note.newContent = lines.join("\n");
    if (note.newContent !== note.content) {
      snapshotBytes += encoder.encode(note.content).length + encoder.encode(note.newContent).length;
    }
    notePlans.push({ path: note.path, content: note.content, newContent: note.newContent, targets: note.targets });
  }

  const rows = [...rowsByIndex.entries()].sort((a, b) => a[0] - b[0]).map(([, r]) => r);
  return { rows, failures, notes: notePlans, snapshotBytes };
}

async function loadNote(
  vaultRel: string,
  deps: Pick<WriteNoteToolsDeps, "vault" | "workspace">,
): Promise<{ ok: true; content: string } | { ok: false; reason: UpdateTasksFailureReason; details?: string }> {
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

/**
 * Apply one patch to many tasks with a single undo entry. Every target
 * is validated before anything is written; any failure means no writes.
 */
export async function updateTasksImpl(
  input: UpdateTasksInput,
  deps: WriteNoteToolsDeps,
): Promise<UpdateTasksResult> {
  const patchErr = validatePatch(input.patch);
  if (patchErr) return patchErr as PatchError;
  if (input.targets.length === 0) return { ok: false, reason: "no_targets" };
  if (input.targets.length > MAX_UPDATE_TASKS_TARGETS) {
    return { ok: false, reason: "too_many_targets", count: input.targets.length, max: MAX_UPDATE_TASKS_TARGETS };
  }

  const analysis = await analyzeUpdateTasks(input, deps);
  if (analysis.failures.length > 0) return { ok: false, reason: "validation_failed", failures: analysis.failures };
  if (analysis.snapshotBytes > MAX_BATCH_SNAPSHOT_BYTES) {
    return { ok: false, reason: "snapshot_too_large", bytes: analysis.snapshotBytes, max: MAX_BATCH_SNAPSHOT_BYTES };
  }

  const today = formatYmd(deps.now());
  const changedNotes = analysis.notes.filter((n) => n.newContent !== n.content);
  const write = await applyBatchModifications(
    changedNotes.map((note) => ({
      path: note.path,
      transform: (data) => reapply(data, note, input.patch, today),
    })),
    deps,
  );
  if (!write.ok) {
    return {
      ok: false,
      reason: write.aborted ? "concurrent_change" : "write_failed",
      path: write.path,
      error: write.error,
      rolledBack: write.rollbackFailures.length === 0,
      rollbackFailures: write.rollbackFailures,
    };
  }

  const tasksChanged = analysis.rows.filter((r) => r.changed).length;
  if (write.items.length === 0) {
    return { ok: true, changed: false, tasksChanged: 0, notesChanged: 0, results: analysis.rows };
  }
  const entry = deps.undoJournal.record({
    kind: "batch",
    scope: "vault",
    path: write.items[0].path,
    items: write.items,
    label: `${plural(tasksChanged, "task")} in ${plural(write.items.length, "note")}`,
  });
  return {
    ok: true,
    changed: true,
    tasksChanged,
    notesChanged: write.items.length,
    results: analysis.rows,
    undoId: entry.id,
    undoSurface: "journal",
  };
}

function reapply(data: string, note: UpdateTasksNotePlan, patch: UpdateTaskPatch, today: string): string {
  const lines = data.split("\n");
  const indices = new Set<number>();
  const located = note.targets.map((pt) => {
    const found = findExpectedLine(lines, pt.hintLine, pt.expectedRawLine);
    if (!found.ok || indices.has(found.index)) {
      throw new ProcessAbort(`"${note.path}" changed since validation (task at line ${pt.hintLine}).`);
    }
    indices.add(found.index);
    return { pt, index: found.index };
  });
  for (const { pt, index } of located) {
    const raw = lines[index];
    const parsed = parseTaskLine(raw);
    if (!parsed.ok) throw new ProcessAbort(`"${note.path}" line ${index + 1} is no longer a task.`);
    const { patched, changedFields } = applyPatch(parsed.parsed, patch, today);
    const after = parsed.parsed.leadingIndent + formatTaskLine(patched, parsed.parsed.source);
    pt.row.line = index + 1;
    pt.row.before = raw;
    pt.row.after = after;
    pt.row.changed = after !== raw;
    pt.row.changedFields = pt.row.changed ? changedFields : [];
    lines[index] = after;
  }
  return lines.join("\n");
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}
