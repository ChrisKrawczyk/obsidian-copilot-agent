/**
 * Phase 5: format a task line for the configured target.
 *
 * Two output flavors:
 *  - `tasks-plugin` — the emoji syntax recognised by the Obsidian
 *    Tasks community plugin (`📅` due, `⏳` scheduled, `⏫`/`🔼`/`🔽`
 *    priority, `#tag` tags) so it shows up in Tasks query views and
 *    Calendar.
 *  - `gfm` — plain GitHub-Flavored Markdown checkbox with inline-text
 *    date metadata (`(due: …)` / `(scheduled: …)`) the user can
 *    upgrade later if they install the plugin.
 *
 * The tool layer is responsible for picking the source. This module
 * has no I/O — it's pure string formatting so it can be unit-tested
 * deterministically.
 */

export type TaskPriority = "high" | "medium" | "low";

export interface TaskInput {
  description: string;
  /** Strict `YYYY-MM-DD`. The caller has already validated this. */
  dueDate?: string;
  /** Strict `YYYY-MM-DD`. The caller has already validated this. */
  scheduledDate?: string;
  /**
   * Strict `YYYY-MM-DD`. The tool layer populates this from `deps.now()`
   * by default; callers may pass an explicit value (e.g. backdating a
   * forgotten task).
   */
  createdDate?: string;
  priority?: TaskPriority;
  /** Tags WITHOUT the leading `#`. Whitespace within a tag is stripped. */
  tags?: string[];
}

export type TaskFormatSource = "tasks-plugin" | "gfm";

const PRIORITY_EMOJI: Record<TaskPriority, string> = {
  high: "⏫",
  medium: "🔼",
  low: "🔽",
};

const PRIORITY_TEXT: Record<TaskPriority, string> = {
  high: "high",
  medium: "medium",
  low: "low",
};

/** YYYY-MM-DD strict pattern. Used by the strict-date guard in the tool. */
export const STRICT_DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Format a single task line. Output is one line WITHOUT a trailing
 * newline — the caller appends `\n` when joining onto file content.
 *
 * Field ordering is stable across calls so tests can pin the output.
 *   `- [ ] <description> [priority] [📅 due] [⏳ scheduled] [➕ created] [#tag …]`
 * for the tasks-plugin source, and:
 *   `- [ ] <description> (priority: …) (due: …) (scheduled: …) (created: …) [#tag …]`
 * for the gfm source.
 */
export function formatTaskLine(
  input: TaskInput,
  source: TaskFormatSource,
): string {
  const desc = (input.description ?? "").trim();
  const parts: string[] = ["- [ ]", desc];
  const tags = sanitizeTags(input.tags);

  if (source === "tasks-plugin") {
    if (input.priority) parts.push(PRIORITY_EMOJI[input.priority]);
    if (input.dueDate) parts.push(`📅 ${input.dueDate}`);
    if (input.scheduledDate) parts.push(`⏳ ${input.scheduledDate}`);
    if (input.createdDate) parts.push(`➕ ${input.createdDate}`);
    for (const t of tags) parts.push(`#${t}`);
  } else {
    if (input.priority) parts.push(`(priority: ${PRIORITY_TEXT[input.priority]})`);
    if (input.dueDate) parts.push(`(due: ${input.dueDate})`);
    if (input.scheduledDate) parts.push(`(scheduled: ${input.scheduledDate})`);
    if (input.createdDate) parts.push(`(created: ${input.createdDate})`);
    for (const t of tags) parts.push(`#${t}`);
  }
  return parts.join(" ");
}

function sanitizeTags(raw: string[] | undefined): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const t of raw) {
    if (typeof t !== "string") continue;
    const trimmed = t.trim().replace(/^#+/, "").replace(/\s+/g, "-");
    if (trimmed.length > 0) out.push(trimmed);
  }
  return out;
}
