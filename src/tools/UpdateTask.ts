/**
 * Phase 6: `update_task` — apply a structured single-task edit to a
 * known task line. Single approval, single journal undo entry.
 *
 * Re-anchor strategy (in priority order):
 *   1. `line` (1-based) — optimistic try.
 *   2. `expectedRawLine` — if provided AND step-1 line doesn't match
 *      byte-for-byte (after trailing-whitespace trim), scan the file
 *      for an exact match. Zero matches → task_not_found. Multiple
 *      matches → ambiguous_match with candidates list, no mutation.
 *   3. `descriptionMatch` (fallback when `expectedRawLine` is absent) —
 *      scan the entire file for tasks whose description contains the
 *      substring. Zero matches → task_not_found. Multiple matches →
 *      ambiguous_match.
 *
 * Status auto-stamping:
 *   - setStatus='done'      → completedDate=today (only if currently
 *                             unset; preserves existing date so
 *                             re-marking done is idempotent on the
 *                             date); cancelledDate cleared.
 *   - setStatus='cancelled' → cancelledDate=today (same idempotence);
 *                             completedDate cleared.
 *   - setStatus='todo'|'in-progress' → both date stamps cleared.
 *
 * Idempotency: after applying the patch, if the formatted line is
 * byte-identical to the original raw line, we DO NOT call
 * `editFileImpl`; result is `{ ok: true, changed: false }`. The user
 * still sees one approval (architectural limitation — see plan).
 */

import {
  formatTaskLine,
  parseTaskLine,
  STRICT_DATE_REGEX,
  type ParsedTask,
  type TaskPriority,
  type TaskStatus,
} from "./TaskFormat";
import { editFileImpl } from "./WriteTools";
import type { WriteNoteToolsDeps } from "./WriteNoteTools";
import {
  resolveVaultPath,
  toVaultRelative,
  lookupTFile,
  VaultPathError,
} from "./VaultPath";
import type { TFileLike } from "./ReadTools";

export interface UpdateTaskInput {
  path: string;
  /** 1-based line number from `find_tasks`. */
  line: number;
  /** Preferred re-anchor — exact line text returned by find_tasks. */
  expectedRawLine?: string;
  /** Fallback re-anchor — substring of the task description. */
  descriptionMatch?: string;
  patch: UpdateTaskPatch;
}

export interface UpdateTaskPatch {
  addTags?: string[];
  removeTags?: string[];
  setPriority?: TaskPriority | null;
  setDueDate?: string | null;
  setScheduledDate?: string | null;
  setStatus?: TaskStatus;
  setDescription?: string;
}

export interface UpdateTaskCandidate {
  line: number;
  raw: string;
}

export type UpdateTaskResult =
  | {
      ok: true;
      path: string;
      line: number;
      changed: boolean;
      changedFields: string[];
      before: string;
      after: string;
      undoId?: string;
      undoSurface?: "journal";
    }
  | { ok: false; reason: "invalid_path"; details?: string }
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "read_failed"; error: string }
  | { ok: false; reason: "not_a_task"; raw: string }
  | { ok: false; reason: "task_not_found" }
  | { ok: false; reason: "ambiguous_match"; candidates: UpdateTaskCandidate[] }
  | { ok: false; reason: "invalid_date_format"; field: "setDueDate" | "setScheduledDate" }
  | { ok: false; reason: "invalid_priority" }
  | { ok: false; reason: "invalid_status" }
  | { ok: false; reason: "write_failed"; error: string };

const STATUS_VALUES: TaskStatus[] = ["todo", "in-progress", "done", "cancelled"];

export async function updateTaskImpl(
  input: UpdateTaskInput,
  deps: WriteNoteToolsDeps,
): Promise<UpdateTaskResult> {
  // Validate patch up-front so we don't read the file just to fail.
  const v = validatePatch(input.patch);
  if (v) return v;

  let vaultRel: string;
  try {
    const abs = resolveVaultPath(input.path, deps.vault);
    vaultRel = toVaultRelative(abs, deps.vault);
  } catch (e) {
    if (e instanceof VaultPathError) return { ok: false, reason: "invalid_path", details: e.message };
    throw e;
  }
  const fileUnknown = lookupTFile(vaultRel, deps.vault);
  if (!fileUnknown) return { ok: false, reason: "not_found" };
  const file = fileUnknown as TFileLike;

  let content: string;
  try {
    if (deps.vault.read) content = await deps.vault.read(file);
    else if (deps.vault.cachedRead) content = await deps.vault.cachedRead(file);
    else return { ok: false, reason: "read_failed", error: "no reader" };
  } catch (e) {
    return { ok: false, reason: "read_failed", error: (e as Error).message ?? String(e) };
  }

  const lines = content.split("\n");
  const targetIdx = identifyTargetLine(input, lines);
  if (!targetIdx.ok) return targetIdx.err;
  const idx = targetIdx.line;
  const before = lines[idx];

  const parsedR = parseTaskLine(before);
  if (!parsedR.ok) return { ok: false, reason: "not_a_task", raw: before };
  const parsed = parsedR.parsed;

  const today = formatYmd(deps.now());
  const { patched, changedFields } = applyPatch(parsed, input.patch, today);
  const newLine = parsed.leadingIndent + formatTaskLine(patched, parsed.source);

  if (newLine === before) {
    return {
      ok: true,
      path: vaultRel,
      line: idx + 1,
      changed: false,
      changedFields: [],
      before,
      after: before,
    };
  }

  lines[idx] = newLine;
  const newContent = lines.join("\n");

  const wr = await editFileImpl(vaultRel, newContent, deps);
  if (!wr.ok) return { ok: false, reason: "write_failed", error: wr.error };

  return {
    ok: true,
    path: vaultRel,
    line: idx + 1,
    changed: true,
    changedFields,
    before,
    after: newLine,
    undoId: wr.undoId,
    undoSurface: "journal",
  };
}

function validatePatch(p: UpdateTaskPatch): UpdateTaskResult | null {
  if (p.setDueDate !== undefined && p.setDueDate !== null && !STRICT_DATE_REGEX.test(p.setDueDate)) {
    return { ok: false, reason: "invalid_date_format", field: "setDueDate" };
  }
  if (
    p.setScheduledDate !== undefined &&
    p.setScheduledDate !== null &&
    !STRICT_DATE_REGEX.test(p.setScheduledDate)
  ) {
    return { ok: false, reason: "invalid_date_format", field: "setScheduledDate" };
  }
  if (
    p.setPriority !== undefined &&
    p.setPriority !== null &&
    p.setPriority !== "high" &&
    p.setPriority !== "medium" &&
    p.setPriority !== "low"
  ) {
    return { ok: false, reason: "invalid_priority" };
  }
  if (p.setStatus !== undefined && !STATUS_VALUES.includes(p.setStatus)) {
    return { ok: false, reason: "invalid_status" };
  }
  return null;
}

function identifyTargetLine(
  input: UpdateTaskInput,
  lines: string[],
):
  | { ok: true; line: number }
  | {
      ok: false;
      err: Exclude<UpdateTaskResult, { ok: true } | { ok: false; reason:
        "invalid_path" | "not_found" | "read_failed" | "not_a_task" | "invalid_date_format" | "invalid_priority" | "invalid_status" | "write_failed" }>;
    } {
  const lineIdx = (input.line | 0) - 1;
  const tryLine = lineIdx >= 0 && lineIdx < lines.length ? lines[lineIdx] : undefined;

  // Tier 1: expectedRawLine
  if (typeof input.expectedRawLine === "string") {
    const want = input.expectedRawLine.replace(/[ \t]+$/, "");
    if (tryLine !== undefined && tryLine.replace(/[ \t]+$/, "") === want) {
      return { ok: true, line: lineIdx };
    }
    const matches: number[] = [];
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].replace(/[ \t]+$/, "") === want) matches.push(i);
    }
    if (matches.length === 0) return { ok: false, err: { ok: false, reason: "task_not_found" } };
    if (matches.length === 1) return { ok: true, line: matches[0] };
    return {
      ok: false,
      err: {
        ok: false,
        reason: "ambiguous_match",
        candidates: matches.map((i) => ({ line: i + 1, raw: lines[i] })),
      },
    };
  }

  // Tier 2: descriptionMatch
  if (typeof input.descriptionMatch === "string" && input.descriptionMatch.length > 0) {
    const needle = input.descriptionMatch;
    // Try the optimistic line first.
    if (tryLine !== undefined) {
      const pr = parseTaskLine(tryLine);
      if (pr.ok && pr.parsed.description.includes(needle)) {
        return { ok: true, line: lineIdx };
      }
    }
    const matches: number[] = [];
    for (let i = 0; i < lines.length; i++) {
      const pr = parseTaskLine(lines[i]);
      if (pr.ok && pr.parsed.description.includes(needle)) matches.push(i);
    }
    if (matches.length === 0) return { ok: false, err: { ok: false, reason: "task_not_found" } };
    if (matches.length === 1) return { ok: true, line: matches[0] };
    return {
      ok: false,
      err: {
        ok: false,
        reason: "ambiguous_match",
        candidates: matches.map((i) => ({ line: i + 1, raw: lines[i] })),
      },
    };
  }

  // No re-anchor — just use the line. Must exist.
  if (tryLine === undefined) return { ok: false, err: { ok: false, reason: "task_not_found" } };
  return { ok: true, line: lineIdx };
}

function applyPatch(
  parsed: ParsedTask,
  patch: UpdateTaskPatch,
  today: string,
): { patched: ParsedTask; changedFields: string[] } {
  const out: ParsedTask = { ...parsed };
  const changed: string[] = [];

  if (typeof patch.setDescription === "string" && patch.setDescription.trim() !== parsed.description) {
    out.description = patch.setDescription.trim();
    changed.push("description");
  }

  if (patch.addTags || patch.removeTags) {
    const cur = new Set((parsed.tags ?? []).map((t) => sanitizeTag(t)).filter(Boolean));
    const before = new Set(cur);
    if (patch.addTags) {
      for (const t of patch.addTags) {
        const s = sanitizeTag(t);
        if (s) cur.add(s);
      }
    }
    if (patch.removeTags) {
      for (const t of patch.removeTags) {
        const s = sanitizeTag(t);
        if (s) cur.delete(s);
      }
    }
    if (!setsEqual(before, cur)) {
      out.tags = [...cur];
      changed.push("tags");
    }
  }

  if (patch.setPriority !== undefined) {
    if (patch.setPriority === null) {
      if (parsed.priority !== undefined) {
        delete out.priority;
        changed.push("priority");
      }
    } else if (parsed.priority !== patch.setPriority) {
      out.priority = patch.setPriority;
      changed.push("priority");
    }
  }

  if (patch.setDueDate !== undefined) {
    if (patch.setDueDate === null) {
      if (parsed.dueDate !== undefined) {
        delete out.dueDate;
        changed.push("dueDate");
      }
    } else if (parsed.dueDate !== patch.setDueDate) {
      out.dueDate = patch.setDueDate;
      changed.push("dueDate");
    }
  }

  if (patch.setScheduledDate !== undefined) {
    if (patch.setScheduledDate === null) {
      if (parsed.scheduledDate !== undefined) {
        delete out.scheduledDate;
        changed.push("scheduledDate");
      }
    } else if (parsed.scheduledDate !== patch.setScheduledDate) {
      out.scheduledDate = patch.setScheduledDate;
      changed.push("scheduledDate");
    }
  }

  if (patch.setStatus !== undefined && patch.setStatus !== parsed.status) {
    out.status = patch.setStatus;
    changed.push("status");

    if (patch.setStatus === "done") {
      if (!parsed.completedDate) {
        out.completedDate = today;
        changed.push("completedDate");
      }
      if (parsed.cancelledDate) {
        delete out.cancelledDate;
        changed.push("cancelledDate");
      }
    } else if (patch.setStatus === "cancelled") {
      if (!parsed.cancelledDate) {
        out.cancelledDate = today;
        changed.push("cancelledDate");
      }
      if (parsed.completedDate) {
        delete out.completedDate;
        changed.push("completedDate");
      }
    } else {
      // todo / in-progress
      if (parsed.completedDate) {
        delete out.completedDate;
        changed.push("completedDate");
      }
      if (parsed.cancelledDate) {
        delete out.cancelledDate;
        changed.push("cancelledDate");
      }
    }
  }

  // Dedupe changed fields
  return { patched: out, changedFields: [...new Set(changed)] };
}

function sanitizeTag(raw: string): string {
  if (typeof raw !== "string") return "";
  return raw.trim().replace(/^#+/, "").replace(/\s+/g, "-");
}

function setsEqual(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}

function formatYmd(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
