import { compileFind, MAX_BULK_EDIT_REPLACEMENTS, NOTE_EXTENSIONS, replaceAllCounted } from "./BulkEdit";
import { loadNoteForBatch } from "./BatchWrite";
import { ProcessAbort, processFileImpl } from "./WriteTools";
import type { WriteNoteToolsDeps } from "./WriteNoteTools";
import { resolveVaultPath, toVaultRelative, VaultPathError } from "./VaultPath";

export const MAX_REPLACE_IN_NOTE_OCCURRENCES = MAX_BULK_EDIT_REPLACEMENTS;
export const REPLACE_DIFF_CONTEXT_LINES = 2;
const MAX_DIFF_LINE_CHARS = 200;

export interface ReplaceInNoteInput {
  path: string;
  oldText: string;
  newText: string;
  expectedOccurrences: number;
}

export function parseReplaceInNoteArgs(args: unknown): ReplaceInNoteInput {
  const a = (args ?? {}) as Record<string, unknown>;
  if (typeof a.path !== "string") throw new Error("`path` is required");
  if (typeof a.oldText !== "string") throw new Error("`oldText` is required");
  if (typeof a.newText !== "string") throw new Error("`newText` is required");
  return {
    path: a.path,
    oldText: a.oldText,
    newText: a.newText,
    expectedOccurrences:
      a.expectedOccurrences === undefined || a.expectedOccurrences === null
        ? 1
        : typeof a.expectedOccurrences === "number"
          ? a.expectedOccurrences
          : Number.NaN,
  };
}

/** Argument problems that make the call fail before the note is read. */
export function validateReplaceInNoteInput(input: ReplaceInNoteInput): string | undefined {
  if (input.oldText.length === 0) return "oldText must not be empty.";
  if (input.oldText === input.newText) return "oldText and newText are identical; nothing to change.";
  const n = input.expectedOccurrences;
  if (!Number.isInteger(n) || n < 1 || n > MAX_REPLACE_IN_NOTE_OCCURRENCES) {
    return `expectedOccurrences must be a whole number from 1 to ${MAX_REPLACE_IN_NOTE_OCCURRENCES}.`;
  }
  return undefined;
}

export type ReplaceInNotePlan =
  | { ok: true; content: string; count: number }
  | { ok: false; reason: "no_match" | "count_mismatch"; found: number; error: string };

/** Literal, case-sensitive, non-overlapping replacement that must match exactly `expectedOccurrences` times. */
export function planReplaceInNote(content: string, input: ReplaceInNoteInput, path = input.path): ReplaceInNotePlan {
  const compiled = compileFind({ find: input.oldText });
  if (!compiled.ok) return { ok: false, reason: "no_match", found: 0, error: compiled.error };
  const r = replaceAllCounted(content, compiled, input.newText, MAX_REPLACE_IN_NOTE_OCCURRENCES);
  if (!r.ok) return { ok: false, reason: "no_match", found: 0, error: r.error };
  if (r.count === 0) {
    const crlf =
      content.includes("\r\n") && input.oldText.includes("\n") && !input.oldText.includes("\r\n")
        ? " The note uses CRLF (\\r\\n) line endings."
        : "";
    return {
      ok: false,
      reason: "no_match",
      found: 0,
      error:
        `oldText was not found in "${path}" (0 matches). Nothing was written. ` +
        `Re-read the note and copy the text exactly, including whitespace and line breaks.${crlf}`,
    };
  }
  if (r.count !== input.expectedOccurrences) {
    const found = r.overLimit ? `more than ${MAX_REPLACE_IN_NOTE_OCCURRENCES}` : String(r.count);
    return {
      ok: false,
      reason: "count_mismatch",
      found: r.count,
      error:
        `Found ${found} matches of oldText in "${path}", expected ${input.expectedOccurrences}. Nothing was written. ` +
        (input.expectedOccurrences === 1
          ? "Include more surrounding text in oldText so it matches exactly once" +
            (r.overLimit ? "." : `, or pass expectedOccurrences: ${r.count} to replace every match.`)
          : "Re-read the note and adjust oldText or expectedOccurrences."),
    };
  }
  return { ok: true, content: r.content, count: r.count };
}

function matchOffsets(content: string, needle: string): number[] {
  const out: number[] = [];
  let i = content.indexOf(needle);
  while (i >= 0 && out.length < MAX_REPLACE_IN_NOTE_OCCURRENCES) {
    out.push(i);
    i = content.indexOf(needle, i + needle.length);
  }
  return out;
}

function clipLine(line: string): string {
  const s = line.endsWith("\r") ? line.slice(0, -1) : line;
  return s.length > MAX_DIFF_LINE_CHARS ? `${s.slice(0, MAX_DIFF_LINE_CHARS - 1)}…` : s;
}

/**
 * One hunk per group of matches sharing lines: the changed lines as
 * removed/added, with up to `context` unchanged lines either side.
 */
export function formatReplaceDiffHunks(
  content: string,
  oldText: string,
  newText: string,
  context = REPLACE_DIFF_CONTEXT_LINES,
): string[] {
  const offsets = matchOffsets(content, oldText);
  if (offsets.length === 0) return [];
  const lines = content.split("\n");
  const lineStarts: number[] = [];
  let pos = 0;
  for (const l of lines) {
    lineStarts.push(pos);
    pos += l.length + 1;
  }
  const lineOf = (offset: number) => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };

  const groups: Array<{ first: number; last: number; matches: number[] }> = [];
  for (const off of offsets) {
    const first = lineOf(off);
    const last = lineOf(off + oldText.length);
    const g = groups[groups.length - 1];
    if (g && first <= g.last) {
      g.last = Math.max(g.last, last);
      g.matches.push(off);
    } else {
      groups.push({ first, last, matches: [off] });
    }
  }

  return groups.map((g) => {
    const segStart = lineStarts[g.first];
    const segEnd = lineStarts[g.last] + lines[g.last].length;
    let after = "";
    let cursor = segStart;
    for (const off of g.matches) {
      after += content.slice(cursor, off) + newText;
      cursor = off + oldText.length;
    }
    after += content.slice(cursor, segEnd);
    const added = after.split("\n");
    let first = g.first;
    let last = g.last;
    while (first <= last && added.length > 0 && lines[first] === added[0]) {
      first++;
      added.shift();
    }
    while (first <= last && added.length > 0 && lines[last] === added[added.length - 1]) {
      last--;
      added.pop();
    }
    const out = [`@@ line ${first + 1} @@`];
    for (let i = Math.max(0, first - context); i < first; i++) out.push(`  ${clipLine(lines[i])}`);
    for (let i = first; i <= last; i++) out.push(`- ${clipLine(lines[i])}`);
    for (const l of added) out.push(`+ ${clipLine(l)}`);
    for (let i = last + 1; i <= Math.min(lines.length - 1, last + context); i++) out.push(`  ${clipLine(lines[i])}`);
    return out.join("\n");
  });
}

export type ReplaceInNoteFailureReason =
  | "invalid_args"
  | "invalid_path"
  | "not_a_note"
  | "not_found"
  | "read_failed"
  | "unsaved_changes"
  | "no_match"
  | "count_mismatch";

export type ReplaceInNoteAnalysis =
  | { ok: true; path: string; content: string; newContent: string; count: number }
  | { ok: false; reason: ReplaceInNoteFailureReason; error: string; path?: string; found?: number };

export type ReplaceInNoteResult =
  | { ok: true; path: string; replacements: number; undoId?: string; undoSurface: "journal" }
  | { ok: false; reason: ReplaceInNoteFailureReason | "write_failed"; error: string; path?: string; found?: number };

function noteVaultPath(
  rawPath: string,
  vault: WriteNoteToolsDeps["vault"],
): { ok: true; path: string } | { ok: false; reason: "invalid_path" | "not_a_note"; error: string } {
  let vaultRel: string;
  try {
    vaultRel = toVaultRelative(resolveVaultPath(rawPath, vault), vault);
  } catch (e) {
    if (e instanceof VaultPathError) return { ok: false, reason: "invalid_path", error: e.message };
    throw e;
  }
  if (!NOTE_EXTENSIONS.some((ext) => vaultRel.toLowerCase().endsWith(ext))) {
    return { ok: false, reason: "not_a_note", error: `"${vaultRel}" is not a .md or .txt note.` };
  }
  return { ok: true, path: vaultRel };
}

/** Read-only validation and dry run, shared by the approval preview and the write. */
export async function analyzeReplaceInNote(
  input: ReplaceInNoteInput,
  deps: Pick<WriteNoteToolsDeps, "vault" | "workspace">,
): Promise<ReplaceInNoteAnalysis> {
  const invalid = validateReplaceInNoteInput(input);
  if (invalid) return { ok: false, reason: "invalid_args", error: invalid };
  const target = noteVaultPath(input.path, deps.vault);
  if (!target.ok) return target;
  const loaded = await loadNoteForBatch(target.path, deps);
  if (!loaded.ok) {
    const error =
      loaded.reason === "not_found"
        ? `"${target.path}" does not exist.`
        : loaded.reason === "unsaved_changes"
          ? `"${target.path}" has unsaved changes in an open editor. Save or discard them, then try again.`
          : `Could not read "${target.path}": ${loaded.details ?? "unknown error"}`;
    return { ok: false, reason: loaded.reason, error, path: target.path };
  }
  const plan = planReplaceInNote(loaded.content, input, target.path);
  if (!plan.ok) return { ok: false, reason: plan.reason, error: plan.error, path: target.path, found: plan.found };
  return { ok: true, path: target.path, content: loaded.content, newContent: plan.content, count: plan.count };
}

/** One targeted literal replacement inside one note, written atomically with one Undo entry. */
export async function replaceInNoteImpl(input: ReplaceInNoteInput, deps: WriteNoteToolsDeps): Promise<ReplaceInNoteResult> {
  const analysis = await analyzeReplaceInNote(input, deps);
  if (!analysis.ok) return analysis;
  const path = analysis.path;

  let failure: Extract<ReplaceInNotePlan, { ok: false }> | undefined;
  let count = 0;
  const r = await processFileImpl(
    path,
    (data) => {
      const plan = planReplaceInNote(data, input, path);
      if (!plan.ok) {
        failure = plan;
        throw new ProcessAbort(plan.error);
      }
      count = plan.count;
      return plan.content;
    },
    deps,
  );
  if (failure) return { ok: false, reason: failure.reason, error: failure.error, path, found: failure.found };
  if (!r.ok) return { ok: false, reason: "write_failed", error: r.error, path };
  return { ok: true, path, replacements: count, ...(r.changed ? { undoId: r.undoId } : {}), undoSurface: "journal" };
}
