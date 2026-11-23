import { compileFind, MAX_BULK_EDIT_REPLACEMENTS, NOTE_EXTENSIONS, replaceAllCounted } from "./BulkEdit";
import { loadNoteForBatch } from "./BatchWrite";
import { editorBufferDiffers, ProcessAbort, processFileImpl } from "./WriteTools";
import type { WriteNoteToolsDeps } from "./WriteNoteTools";
import { resolveVaultPath, toVaultRelative, VaultPathError } from "./VaultPath";

export const MAX_REPLACE_IN_NOTE_OCCURRENCES = MAX_BULK_EDIT_REPLACEMENTS;
export const REPLACE_DIFF_CONTEXT_LINES = 2;
const MAX_DIFF_LINE_CHARS = 200;
const DIFF_LEAD_CHARS = 40;
const MAX_HUNK_SIDE_LINES = 12;
const MAX_HUNK_SIDE_CHARS = 1500;

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
    const found = r.overLimit ? countOccurrences(content, input.oldText) : r.count;
    const replaceAll =
      found <= MAX_REPLACE_IN_NOTE_OCCURRENCES ? ` Pass expectedOccurrences: ${found} only if every match should change.` : "";
    return {
      ok: false,
      reason: "count_mismatch",
      found,
      error:
        `Found ${found} matches of oldText in "${path}", expected ${input.expectedOccurrences}. Nothing was written. ` +
        (input.expectedOccurrences === 1
          ? `Include more surrounding text in oldText so it matches exactly once.${replaceAll}`
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

function countOccurrences(content: string, needle: string): number {
  let n = 0;
  for (let i = content.indexOf(needle); i >= 0; i = content.indexOf(needle, i + needle.length)) n++;
  return n;
}

/** Lines with their terminators, so line-ending and end-of-file changes stay visible. */
function splitLinesKeep(s: string): string[] {
  return s.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

function lineBody(line: string): string {
  return line.replace(/\r?\n$/, "").replace(/\r$/, "");
}

/** A window of at most MAX_DIFF_LINE_CHARS around `from`, so a change far along a long line stays visible. */
function clipAround(text: string, from = 0): string {
  if (text.length <= MAX_DIFF_LINE_CHARS) return text;
  const width = MAX_DIFF_LINE_CHARS - 1;
  const start = from > width - DIFF_LEAD_CHARS ? Math.min(from - DIFF_LEAD_CHARS, text.length - width) : 0;
  return `${start > 0 ? "…" : ""}${text.slice(start, start + width)}${start + width < text.length ? "…" : ""}`;
}

function renderChangedSide(sign: "-" | "+", side: string[], other: string[]): string[] {
  const out: string[] = [];
  let used = 0;
  let shown = 0;
  for (; shown < Math.min(side.length, MAX_HUNK_SIDE_LINES); shown++) {
    const line = side[shown];
    const counterpart = other[shown] ?? "";
    let text = lineBody(line);
    const otherText = lineBody(counterpart);
    if (text === otherText && line.endsWith("\r\n") && !counterpart.endsWith("\r\n")) text += "␍";
    let p = 0;
    while (p < text.length && p < otherText.length && text[p] === otherText[p]) p++;
    const rendered = `${sign} ${clipAround(text, p)}`;
    if (shown > 0 && used + rendered.length > MAX_HUNK_SIDE_CHARS) break;
    out.push(rendered);
    used += rendered.length + 1;
  }
  if (side.length > shown) out.push(`${sign} … ${side.length - shown} more lines`);
  const lacksNewline = (l: string[]) => l.length > 0 && !l[l.length - 1].endsWith("\n");
  if (lacksNewline(side) && !lacksNewline(other) && other.length > 0) out.push("\\ No newline at end of file");
  return out;
}

interface LineChange {
  first: number;
  last: number;
  added: string[];
}

/**
 * Diff hunks for replacing every `oldText` with `newText`: removed and
 * added lines with up to `context` unchanged lines either side. Changes
 * whose context would touch are merged into one hunk.
 */
export function formatReplaceDiffHunks(
  content: string,
  oldText: string,
  newText: string,
  context = REPLACE_DIFF_CONTEXT_LINES,
): string[] {
  const offsets = matchOffsets(content, oldText);
  if (offsets.length === 0) return [];
  const lines = splitLinesKeep(content);
  const lineStarts: number[] = [];
  let pos = 0;
  for (const l of lines) {
    lineStarts.push(pos);
    pos += l.length;
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
    const last = lineOf(Math.min(off + oldText.length, content.length - 1));
    const g = groups[groups.length - 1];
    if (g && first <= g.last) {
      g.last = Math.max(g.last, last);
      g.matches.push(off);
    } else {
      groups.push({ first, last, matches: [off] });
    }
  }

  const changes: LineChange[] = [];
  for (const g of groups) {
    const segStart = lineStarts[g.first];
    const segEnd = lineStarts[g.last] + lines[g.last].length;
    let after = "";
    let cursor = segStart;
    for (const off of g.matches) {
      after += content.slice(cursor, off) + newText;
      cursor = off + oldText.length;
    }
    after += content.slice(cursor, segEnd);
    const added = splitLinesKeep(after);
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
    if (first <= last || added.length > 0) changes.push({ first, last, added });
  }

  const clusters: LineChange[][] = [];
  for (const c of changes) {
    const cluster = clusters[clusters.length - 1];
    const prev = cluster?.[cluster.length - 1];
    if (prev && c.first - (prev.last + 1) <= 2 * context) cluster.push(c);
    else clusters.push([c]);
  }

  const contextLine = (i: number) => `  ${clipAround(lineBody(lines[i]))}`;
  return clusters.map((cluster) => {
    const head = cluster[0];
    const tail = cluster[cluster.length - 1];
    const out = [`@@ line ${head.first + 1} @@`];
    for (let i = Math.max(0, head.first - context); i < head.first; i++) out.push(contextLine(i));
    cluster.forEach((c, k) => {
      const removed = lines.slice(c.first, c.last + 1);
      out.push(...renderChangedSide("-", removed, c.added), ...renderChangedSide("+", c.added, removed));
      const next = cluster[k + 1];
      if (next) for (let i = c.last + 1; i < next.first; i++) out.push(contextLine(i));
    });
    for (let i = tail.last + 1; i <= Math.min(lines.length - 1, tail.last + context); i++) out.push(contextLine(i));
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

  const unsavedError = `"${path}" has unsaved changes in an open editor. Save or discard them, then try again.`;
  let failure: { reason: ReplaceInNoteFailureReason; error: string; found?: number } | undefined;
  let count = 0;
  const r = await processFileImpl(
    path,
    (data) => {
      if (editorBufferDiffers(path, data, deps.workspace)) {
        failure = { reason: "unsaved_changes", error: unsavedError };
        throw new ProcessAbort(unsavedError);
      }
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
  if (failure) {
    return { ok: false, reason: failure.reason, error: failure.error, path, ...(failure.found !== undefined ? { found: failure.found } : {}) };
  }
  if (!r.ok) {
    const unsaved = /has unsaved changes in an open editor/.test(r.error);
    return unsaved
      ? { ok: false, reason: "unsaved_changes", error: unsavedError, path }
      : { ok: false, reason: "write_failed", error: r.error, path };
  }
  return { ok: true, path, replacements: count, ...(r.changed ? { undoId: r.undoId } : {}), undoSurface: "journal" };
}
