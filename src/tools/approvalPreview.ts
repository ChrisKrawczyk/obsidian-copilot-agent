import { parseTaskPatch } from "./UpdateTask";
import { analyzeUpdateTasks, type UpdateTasksAnalysis } from "./UpdateTasks";
import { parseMoveItems, parseTaskTargets, type WriteNoteToolsDeps } from "./WriteNoteTools";
import { analyzeMoveNote, type MoveNoteAnalysis, type MoveNoteVault } from "./MoveNote";

export const MAX_PREVIEW_CHARS = 4000;

export interface ApprovalDescription {
  summary: string;
  detail: string;
}

/**
 * Join `lines` until the next one would push past `maxChars`, then add
 * an "… and N more" line for whatever was left out. An entry may span
 * several lines; it is kept or dropped as a whole.
 */
export function boundPreview(lines: readonly string[], maxChars = MAX_PREVIEW_CHARS): string {
  const out: string[] = [];
  let used = 0;
  for (let i = 0; i < lines.length; i++) {
    const cost = lines[i].length + (out.length > 0 ? 1 : 0);
    if (used + cost > maxChars) {
      out.push(`… and ${lines.length - i} more`);
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
    const links = linking > 0 ? ` — links in ${plural(linking, "note")}` : "";
    lines.push(`${p.from} → ${p.to}${kind}${links}`);
  }
  return boundPreview(lines);
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}

/** Every vault path a batch tool call would touch, or undefined for other tools. */
export function extractBatchVaultPaths(toolName: string, args: unknown): string[] | undefined {
  const a = asRecord(args);
  if (toolName === "update_tasks") {
    if (!Array.isArray(a.targets)) return undefined;
    const paths = parseTaskTargets(a.targets).map((t) => t.path).filter((p) => p.length > 0);
    return [...new Set(paths)];
  }
  if (toolName === "move_note") {
    if (!Array.isArray(a.moves)) return undefined;
    const paths = parseMoveItems(a.moves).flatMap((m) => [m.from, m.to]).filter((p) => p.length > 0);
    return [...new Set(paths)];
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
  return undefined;
}
