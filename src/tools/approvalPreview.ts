import { parseTaskPatch } from "./UpdateTask";
import { analyzeUpdateTasks, MAX_UPDATE_TASKS_TARGETS, type UpdateTasksAnalysis } from "./UpdateTasks";
import { parseBulkEditArgs, parseMoveItems, parseTaskTargets, type WriteNoteToolsDeps } from "./WriteNoteTools";
import { analyzeBulkEdit, MAX_BULK_EDIT_NOTES, MAX_BULK_EDIT_REPLACEMENTS, type BulkEditAnalysis, type BulkEditInput } from "./BulkEdit";
import { analyzeMoveNote, type MoveNoteAnalysis, type MoveNoteVault } from "./MoveNote";
import {
  analyzeReplaceInNote,
  formatReplaceDiffHunks,
  parseReplaceInNoteArgs,
  type ReplaceInNoteInput,
} from "./ReplaceInNote";

export const MAX_PREVIEW_CHARS = 4000;

export interface ApprovalDescription {
  summary: string;
  detail: string;
}

/**
 * Join `lines` until the next one would push past `maxChars`, then add
 * an "… and N more" line for whatever was left out. An entry may span
 * several lines; it is kept or dropped as a whole, and the result never
 * exceeds `maxChars`.
 */
export function boundPreview(lines: readonly string[], maxChars = MAX_PREVIEW_CHARS): string {
  const whole = lines.join("\n");
  if (whole.length <= maxChars) return whole;
  const marker = (left: number) => `… and ${left} more`;
  const out: string[] = [];
  let used = 0;
  for (let i = 0; i < lines.length; i++) {
    const cost = lines[i].length + (out.length > 0 ? 1 : 0);
    const reserve = marker(lines.length - i - 1).length + 1;
    if (used + cost + reserve > maxChars) {
      out.push(marker(lines.length - i));
      break;
    }
    out.push(lines[i]);
    used += cost;
  }
  return out.join("\n");
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

export function formatUpdateTasksPreview(analysis: Pick<UpdateTasksAnalysis, "rows" | "failures">): string {
  const lines: string[] = [];
  for (const f of analysis.failures) {
    lines.push(`✗ ${f.path}:${f.line} — ${f.reason}${f.details ? ` (${f.details})` : ""}`);
  }
  for (const r of analysis.rows) {
    if (!r.changed) {
      lines.push(`${r.path}:${r.line} (no change)  ${r.before.trim()}`);
      continue;
    }
    lines.push(`${r.path}:${r.line}\n  - ${r.before.trim()}\n  + ${r.after.trim()}`);
  }
  return boundPreview(lines);
}

/** `metadataCache.resolvedLinks`: source path → target path → link count. */
export interface LinkIndex {
  resolvedLinks?: Record<string, Record<string, number>>;
}

/** Notes outside `path` that link to it (or, for a folder, to anything under it). */
export function countLinkingNotes(index: LinkIndex | undefined, path: string, kind: "file" | "folder"): number {
  const links = index?.resolvedLinks;
  if (!links) return 0;
  const prefix = path + "/";
  const inside = (p: string) => (kind === "folder" ? p.startsWith(prefix) : p === path);
  let n = 0;
  for (const [source, targets] of Object.entries(links)) {
    if (inside(source) || !targets) continue;
    if (Object.keys(targets).some((t) => inside(t) && targets[t] > 0)) n++;
  }
  return n;
}

export function formatMoveNotePreview(analysis: MoveNoteAnalysis, index?: LinkIndex): string {
  const lines: string[] = [];
  for (const f of analysis.failures) {
    lines.push(`✗ ${f.from} → ${f.to} — ${f.reason}${f.details ? ` (${f.details})` : ""}`);
  }
  for (const p of analysis.plans) {
    const linking = countLinkingNotes(index, p.from, p.kind);
    const kind = p.kind === "folder" ? " (folder)" : "";
    const links = index?.resolvedLinks ? ` — links in ${plural(linking, "note")}` : "";
    lines.push(`${p.from} → ${p.to}${kind}${links}`);
  }
  return boundPreview(lines);
}

export function formatBulkEditPreview(analysis: Extract<BulkEditAnalysis, { ok: true }>): string {
  const lines: string[] = [];
  for (const f of analysis.failures) {
    lines.push(`✗ ${f.path} — ${f.reason}${f.details ? ` (${f.details})` : ""}`);
  }
  const unmatched: string[] = [];
  for (const n of analysis.notes) {
    if (n.replacements === 0) {
      unmatched.push(n.path);
      continue;
    }
    const samples = n.samples.map((s) => `\n  - ${s.before.trim()}\n  + ${s.after.trim()}`).join("");
    lines.push(`${n.path} — ${plural(n.replacements, "replacement")}${samples}`);
  }
  for (const p of unmatched) lines.push(`${p} (no matches)`);
  const matched = analysis.notes.length - unmatched.length;
  const total = `Total: ${plural(analysis.totalReplacements, "replacement")} in ${plural(matched, "note")}`;
  return lines.length > 0 ? `${boundPreview(lines, MAX_PREVIEW_CHARS - total.length - 1)}\n${total}` : total;
}

export function formatReplaceInNotePreview(content: string, input: Pick<ReplaceInNoteInput, "oldText" | "newText">): string {
  return boundPreview(formatReplaceDiffHunks(content, input.oldText, input.newText).flatMap((hunk) => hunk.split("\n")));
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}

/**
 * Every vault path a batch tool call would touch, or undefined for other
 * tools. Empty or non-string entries are kept as "" so a malformed call
 * can never be covered by the allowlist.
 */
export function extractBatchVaultPaths(toolName: string, args: unknown): string[] | undefined {
  const a = asRecord(args);
  if (toolName === "update_tasks") {
    if (!Array.isArray(a.targets)) return undefined;
    return [...new Set(parseTaskTargets(a.targets).map((t) => t.path))];
  }
  if (toolName === "bulk_edit") {
    if (!Array.isArray(a.paths)) return undefined;
    return [...new Set(a.paths.map((p) => (typeof p === "string" ? p : "")))];
  }
  if (toolName === "move_note") {
    if (!Array.isArray(a.moves)) return undefined;
    return [...new Set(parseMoveItems(a.moves).flatMap((m) => [m.from, m.to]))];
  }
  return undefined;
}

/**
 * Approval text for the batch vault tools, computed from current vault
 * content. Returns undefined for tools it doesn't know so the caller
 * keeps its default summary.
 */
export async function describeVaultBatchApproval(
  toolName: string,
  args: unknown,
  deps: Pick<WriteNoteToolsDeps, "vault" | "workspace" | "now" | "configDir"> & { metadataCache?: LinkIndex },
): Promise<ApprovalDescription | undefined> {
  const a = asRecord(args);
  if (toolName === "update_tasks") {
    if (!Array.isArray(a.targets)) return undefined;
    const targets = parseTaskTargets(a.targets);
    if (targets.length > MAX_UPDATE_TASKS_TARGETS) return undefined;
    const analysis = await analyzeUpdateTasks({ targets, patch: parseTaskPatch(a.patch) }, deps);
    const notes = new Set([...analysis.rows.map((r) => r.path), ...analysis.failures.map((f) => f.path)]);
    return {
      summary: `update_tasks: ${plural(targets.length, "task")} in ${plural(notes.size, "note")}`,
      detail: formatUpdateTasksPreview(analysis),
    };
  }
  if (toolName === "move_note") {
    if (!Array.isArray(a.moves)) return undefined;
    const items = parseMoveItems(a.moves);
    const analysis = analyzeMoveNote(items, { vault: deps.vault as MoveNoteVault, configDir: deps.configDir });
    return {
      summary: `move_note: ${plural(items.length, "item")}`,
      detail: formatMoveNotePreview(analysis, deps.metadataCache),
    };
  }
  if (toolName === "bulk_edit") {
    let input: BulkEditInput;
    try {
      input = parseBulkEditArgs(args);
    } catch {
      return undefined;
    }
    if (input.paths.length > MAX_BULK_EDIT_NOTES) return undefined;
    const analysis = await analyzeBulkEdit(input, deps);
    if (!analysis.ok) return { summary: "bulk_edit: invalid find", detail: analysis.error };
    if (analysis.overLimit) {
      return {
        summary: `bulk_edit: more than ${MAX_BULK_EDIT_REPLACEMENTS} replacements`,
        detail: `The edit matches more than ${MAX_BULK_EDIT_REPLACEMENTS} times and will be rejected without changes.`,
      };
    }
    const matched = analysis.notes.filter((n) => n.replacements > 0).length;
    return {
      summary: `bulk_edit: ${plural(analysis.totalReplacements, "replacement")} in ${plural(matched, "note")}`,
      detail: formatBulkEditPreview(analysis),
    };
  }
  if (toolName === "replace_in_note") {
    let input: ReplaceInNoteInput;
    try {
      input = parseReplaceInNoteArgs(args);
    } catch (e) {
      const path = typeof asRecord(args).path === "string" ? (asRecord(args).path as string) : "(no path)";
      return { summary: `replace_in_note: ${path} — will fail (invalid_args)`, detail: (e as Error).message };
    }
    const analysis = await analyzeReplaceInNote(input, deps);
    if (!analysis.ok) {
      return {
        summary: `replace_in_note: ${analysis.path ?? input.path} — will fail (${analysis.reason})`,
        detail: analysis.error,
      };
    }
    return {
      summary: `replace_in_note: ${plural(analysis.count, "replacement")} in ${analysis.path}`,
      detail: formatReplaceInNotePreview(analysis.content, input),
    };
  }
  return undefined;
}
