import { applyBatchModifications, loadNoteForBatch } from "./BatchWrite";
import { ProcessAbort } from "./WriteTools";
import type { WriteNoteToolsDeps } from "./WriteNoteTools";
import { resolveVaultPath, toVaultRelative, VaultPathError } from "./VaultPath";
import { MAX_BATCH_SNAPSHOT_BYTES } from "../domain/UndoJournal";

export const MAX_BULK_EDIT_NOTES = 50;
export const MAX_BULK_EDIT_REPLACEMENTS = 5000;
export const MAX_BULK_EDIT_SAMPLES = 3;
const MAX_SAMPLE_CHARS = 160;
const SAMPLE_LEAD_CHARS = 40;
const NOTE_EXTENSIONS = [".md", ".txt"];

export interface BulkEditInput {
  paths: string[];
  find: string;
  replace: string;
  regex?: boolean;
  ignoreCase?: boolean;
}

export type CompiledFind =
  | { ok: true; re: RegExp; literal: boolean }
  | { ok: false; reason: "invalid_find"; error: string };

export function compileFind(input: Pick<BulkEditInput, "find" | "regex" | "ignoreCase">): CompiledFind {
  if (typeof input.find !== "string" || input.find.length === 0) {
    return { ok: false, reason: "invalid_find", error: "find must not be empty." };
  }
  const flags = `gm${input.ignoreCase ? "i" : ""}`;
  if (!input.regex) {
    return { ok: true, re: new RegExp(input.find.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), flags), literal: true };
  }
  let re: RegExp;
  try {
    re = new RegExp(input.find, flags);
  } catch (e) {
    return { ok: false, reason: "invalid_find", error: `Invalid regular expression: ${(e as Error).message}` };
  }
  if (new RegExp(input.find, flags.replace("g", "")).test("")) {
    return { ok: false, reason: "invalid_find", error: "The pattern can match an empty string; make it match at least one character." };
  }
  return { ok: true, re, literal: false };
}

export interface BulkEditSample {
  before: string;
  after: string;
}

export type ReplaceOutcome =
  | { ok: true; content: string; count: number; samples: BulkEditSample[]; overLimit?: true }
  | { ok: false; error: string };

/**
 * Replace every match of `compiled` in `content`. Literal mode inserts
 * `replacement` verbatim; regex mode uses native `$1` / `$<name>` / `$$`
 * expansion. Samples show up to three changed lines. Once more than
 * `limit` matches are found, counting stops and nothing is replaced.
 */
export function replaceAllCounted(
  content: string,
  compiled: Extract<CompiledFind, { ok: true }>,
  replacement: string,
  limit = Number.POSITIVE_INFINITY,
): ReplaceOutcome {
  const re = new RegExp(compiled.re.source, compiled.re.flags);
  const matches: RegExpMatchArray[] = [];
  for (const m of content.matchAll(re)) {
    if (m[0].length === 0) {
      return { ok: false, error: "The pattern matched an empty string; make it match at least one character." };
    }
    matches.push(m);
    if (matches.length > limit) return { ok: true, content, count: matches.length, samples: [], overLimit: true };
  }
  if (matches.length === 0) return { ok: true, content, count: 0, samples: [] };
  const next = compiled.literal ? content.replace(re, () => replacement) : content.replace(re, replacement);

  const lineEndAt = (i: number) => {
    const nl = content.indexOf("\n", i);
    return nl < 0 ? content.length : nl;
  };
  const samples: BulkEditSample[] = [];
  let k = 0;
  while (k < matches.length && samples.length < MAX_BULK_EDIT_SAMPLES) {
    const first = matches[k].index ?? 0;
    const lineStart = content.lastIndexOf("\n", first - 1) + 1;
    const from = Math.max(lineStart, first - SAMPLE_LEAD_CHARS);
    const lead = from > lineStart ? "…" : "";
    let lineEnd = lineEndAt(first + matches[k][0].length);
    let after = "";
    let cursor = from;
    // Every match that starts on the sampled line(s) is replaced, so the
    // sample shows what the line will actually become.
    while (k < matches.length && (matches[k].index ?? 0) <= lineEnd) {
      const start = matches[k].index ?? 0;
      const end = start + matches[k][0].length;
      const replaced = compiled.literal ? replacement : replaceOneAt(content, compiled.re, start, replacement, end);
      after += content.slice(cursor, start) + replaced;
      cursor = end;
      lineEnd = Math.max(lineEnd, lineEndAt(end));
      k++;
    }
    after += content.slice(cursor, lineEnd);
    samples.push({ before: clip(lead + content.slice(from, lineEnd)), after: clip(lead + after) });
  }
  return { ok: true, content: next, count: matches.length, samples };
}

function replaceOneAt(content: string, re: RegExp, start: number, replacement: string, end: number): string {
  const sticky = new RegExp(re.source, re.flags.replace("g", "") + "y");
  sticky.lastIndex = start;
  const out = content.replace(sticky, replacement);
  return out.slice(start, out.length - (content.length - end));
}

function clip(raw: string): string {
  const s = raw.replace(/\r?\n/g, "⏎");
  return s.length > MAX_SAMPLE_CHARS ? `${s.slice(0, MAX_SAMPLE_CHARS - 1)}…` : s;
}

export type BulkEditFailureReason =
  | "invalid_path"
  | "not_found"
  | "not_a_note"
  | "read_failed"
  | "unsaved_changes"
  | "duplicate_path"
  | "match_error";

export interface BulkEditFailure {
  index: number;
  path: string;
  reason: BulkEditFailureReason;
  details?: string;
}

export interface BulkEditNotePlan {
  path: string;
  content: string;
  newContent: string;
  replacements: number;
  samples: BulkEditSample[];
}

export type BulkEditAnalysis =
  | { ok: false; reason: "invalid_find"; error: string }
  | {
      ok: true;
      failures: BulkEditFailure[];
      /** One entry per valid path, in input order, including zero-match notes. */
      notes: BulkEditNotePlan[];
      totalReplacements: number;
      snapshotBytes: number;
      /** Analysis stopped early because the replacement cap was exceeded. */
      overLimit?: true;
    };

const encoder = new TextEncoder();

/** Read-only validation and dry run of a bulk edit. */
export async function analyzeBulkEdit(
  input: BulkEditInput,
  deps: Pick<WriteNoteToolsDeps, "vault" | "workspace">,
): Promise<BulkEditAnalysis> {
  const compiled = compileFind(input);
  if (!compiled.ok) return compiled;
  const failures: BulkEditFailure[] = [];
  const notes: BulkEditNotePlan[] = [];
  const seen = new Set<string>();
  let totalReplacements = 0;
  let snapshotBytes = 0;

  for (let i = 0; i < input.paths.length; i++) {
    const raw = input.paths[i];
    const fail = (reason: BulkEditFailureReason, path: string, details?: string) =>
      failures.push({ index: i, path, reason, ...(details ? { details } : {}) });
    let vaultRel: string;
    try {
      vaultRel = toVaultRelative(resolveVaultPath(raw, deps.vault), deps.vault);
    } catch (e) {
      if (e instanceof VaultPathError) {
        fail("invalid_path", raw, e.message);
        continue;
      }
      throw e;
    }
    if (seen.has(vaultRel)) {
      fail("duplicate_path", vaultRel);
      continue;
    }
    seen.add(vaultRel);
    if (!NOTE_EXTENSIONS.some((ext) => vaultRel.toLowerCase().endsWith(ext))) {
      fail("not_a_note", vaultRel, "Only .md and .txt notes can be bulk-edited.");
      continue;
    }
    const loaded = await loadNoteForBatch(vaultRel, deps);
    if (!loaded.ok) {
      fail(loaded.reason, vaultRel, loaded.details);
      continue;
    }
    const r = replaceAllCounted(loaded.content, compiled, input.replace, MAX_BULK_EDIT_REPLACEMENTS - totalReplacements);
    if (!r.ok) {
      fail("match_error", vaultRel, r.error);
      continue;
    }
    totalReplacements += r.count;
    if (r.overLimit) return { ok: true, failures, notes, totalReplacements, snapshotBytes, overLimit: true };
    if (r.content !== loaded.content) {
      snapshotBytes += encoder.encode(loaded.content).length + encoder.encode(r.content).length;
    }
    notes.push({
      path: vaultRel,
      content: loaded.content,
      newContent: r.content,
      replacements: r.count,
      samples: r.samples,
    });
  }
  return { ok: true, failures, notes, totalReplacements, snapshotBytes };
}

export type BulkEditResult =
  | {
      ok: true;
      changed: boolean;
      totalReplacements: number;
      notesChanged: number;
      results: Array<{ path: string; replacements: number }>;
      undoId?: string;
      undoSurface?: "journal";
    }
  | { ok: false; reason: "invalid_find"; error: string }
  | { ok: false; reason: "no_paths" }
  | { ok: false; reason: "too_many_paths"; count: number; max: number }
  | { ok: false; reason: "validation_failed"; failures: BulkEditFailure[] }
  | { ok: false; reason: "too_many_replacements"; count: number; max: number }
  | { ok: false; reason: "snapshot_too_large"; bytes: number; max: number }
  | {
      ok: false;
      reason: "concurrent_change" | "write_failed";
      path: string;
      error: string;
      rolledBack: boolean;
      rollbackFailures: string[];
    };

/**
 * One find/replace across many notes with a single undo entry. Every
 * note is validated and dry-run first; any failure means no writes.
 */
export async function bulkEditImpl(input: BulkEditInput, deps: WriteNoteToolsDeps): Promise<BulkEditResult> {
  const compiled = compileFind(input);
  if (!compiled.ok) return compiled;
  if (input.paths.length === 0) return { ok: false, reason: "no_paths" };
  if (input.paths.length > MAX_BULK_EDIT_NOTES) {
    return { ok: false, reason: "too_many_paths", count: input.paths.length, max: MAX_BULK_EDIT_NOTES };
  }
  const analysis = await analyzeBulkEdit(input, deps);
  if (!analysis.ok) return analysis;
  if (analysis.failures.length > 0 && !analysis.overLimit) {
    return { ok: false, reason: "validation_failed", failures: analysis.failures };
  }
  if (analysis.overLimit || analysis.totalReplacements > MAX_BULK_EDIT_REPLACEMENTS) {
    return {
      ok: false,
      reason: "too_many_replacements",
      count: analysis.totalReplacements,
      max: MAX_BULK_EDIT_REPLACEMENTS,
    };
  }
  if (analysis.snapshotBytes > MAX_BATCH_SNAPSHOT_BYTES) {
    return { ok: false, reason: "snapshot_too_large", bytes: analysis.snapshotBytes, max: MAX_BATCH_SNAPSHOT_BYTES };
  }

  const results = analysis.notes.map((n) => ({ path: n.path, replacements: n.replacements }));
  const changed = analysis.notes.filter((n) => n.newContent !== n.content);
  if (changed.length === 0) {
    return { ok: true, changed: false, totalReplacements: analysis.totalReplacements, notesChanged: 0, results };
  }
  const write = await applyBatchModifications(
    changed.map((note) => ({
      path: note.path,
      transform: (data) => {
        if (data !== note.content) throw new ProcessAbort(`"${note.path}" changed since it was checked.`);
        return note.newContent;
      },
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
  const entry = deps.undoJournal.record({
    kind: "batch",
    scope: "vault",
    path: write.items[0].path,
    items: write.items,
    label: `${plural(analysis.totalReplacements, "replacement")} in ${plural(write.items.length, "note")}`,
  });
  return {
    ok: true,
    changed: true,
    totalReplacements: analysis.totalReplacements,
    notesChanged: write.items.length,
    results,
    undoId: entry.id,
    undoSurface: "journal",
  };
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}
