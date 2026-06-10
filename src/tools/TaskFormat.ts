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

/**
 * Status canonicals follow the Tasks plugin's status collection convention:
 *   `- [ ]` todo, `- [/]` in-progress, `- [x]` done, `- [-]` cancelled.
 * (`/` for in-progress is the canonical mark per Minimal Theme + SlRvb's
 * Alternate Checkboxes status collections.)
 */
export type TaskStatus = "todo" | "in-progress" | "done" | "cancelled";

export interface TaskInput {
  description: string;
  /** Defaults to `"todo"` when omitted. */
  status?: TaskStatus;
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
  /** Strict `YYYY-MM-DD`. Tasks-plugin renders as `✅ <date>`. */
  completedDate?: string;
  /** Strict `YYYY-MM-DD`. Tasks-plugin renders as `❌ <date>`. */
  cancelledDate?: string;
  priority?: TaskPriority;
  /** Tags WITHOUT the leading `#`. Whitespace within a tag is stripped. */
  tags?: string[];
  /**
   * Unmodeled trailing metadata captured verbatim by `parseTaskLine` —
   * recurrence (`🔁 every Sunday`), start date (`🛫 ...`), block IDs
   * (`^abc123`), custom emoji, arbitrary trailing text. `formatTaskLine`
   * appends this at the very end of the line, after tags, so re-emission
   * round-trips it losslessly.
   */
  extras?: string;
}

export type TaskFormatSource = "tasks-plugin" | "gfm";

const STATUS_SYMBOL: Record<TaskStatus, string> = {
  todo: " ",
  "in-progress": "/",
  done: "x",
  cancelled: "-",
};

const SYMBOL_TO_STATUS: Record<string, TaskStatus> = {
  " ": "todo",
  "/": "in-progress",
  x: "done",
  X: "done",
  "-": "cancelled",
};

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
 *   `- [<status>] <description> [priority] [📅 due] [⏳ scheduled] [➕ created] [✅ completed] [❌ cancelled] [#tag …] [extras]`
 * for the tasks-plugin source, and:
 *   `- [<status>] <description> (priority: …) (due: …) (scheduled: …) (created: …) (completed: …) (cancelled: …) [#tag …] [extras]`
 * for the gfm source.
 *
 * `extras` is appended verbatim at the very end so unmodeled metadata
 * captured by `parseTaskLine` (recurrence, block IDs, custom emoji)
 * round-trips losslessly.
 */
export function formatTaskLine(
  input: TaskInput,
  source: TaskFormatSource,
): string {
  const desc = (input.description ?? "").trim();
  const status = input.status ?? "todo";
  const checkbox = `- [${STATUS_SYMBOL[status]}]`;
  const parts: string[] = [checkbox, desc];
  const tags = sanitizeTags(input.tags);

  if (source === "tasks-plugin") {
    if (input.priority) parts.push(PRIORITY_EMOJI[input.priority]);
    if (input.dueDate) parts.push(`📅 ${input.dueDate}`);
    if (input.scheduledDate) parts.push(`⏳ ${input.scheduledDate}`);
    if (input.createdDate) parts.push(`➕ ${input.createdDate}`);
    if (input.completedDate) parts.push(`✅ ${input.completedDate}`);
    if (input.cancelledDate) parts.push(`❌ ${input.cancelledDate}`);
    for (const t of tags) parts.push(`#${t}`);
  } else {
    if (input.priority) parts.push(`(priority: ${PRIORITY_TEXT[input.priority]})`);
    if (input.dueDate) parts.push(`(due: ${input.dueDate})`);
    if (input.scheduledDate) parts.push(`(scheduled: ${input.scheduledDate})`);
    if (input.createdDate) parts.push(`(created: ${input.createdDate})`);
    if (input.completedDate) parts.push(`(completed: ${input.completedDate})`);
    if (input.cancelledDate) parts.push(`(cancelled: ${input.cancelledDate})`);
    for (const t of tags) parts.push(`#${t}`);
  }

  const extras = (input.extras ?? "").trim();
  if (extras.length > 0) parts.push(extras);

  return parts.join(" ");
}

export interface ParsedTask extends TaskInput {
  status: TaskStatus;
  /** Whitespace before the `- [` checkbox marker. */
  leadingIndent: string;
  /** Which flavor we detected, so re-emission preserves it. */
  source: TaskFormatSource;
  /** Raw status symbol as it appeared in source (e.g. `"X"` vs `"x"`). */
  rawStatusSymbol: string;
  /** Unmodeled trailing tokens, joined by single spaces. */
  extras: string;
}

const TASK_LINE_REGEX = /^(\s*)- \[(.)\] ?(.*)$/;
const GFM_META_REGEX = /\((priority|due|scheduled|created|completed|cancelled):\s*([^)]+)\)/g;

/**
 * Tolerant parser for a single task line. Recognizes both flavors
 * (tasks-plugin emoji and our gfm `(field: value)`). Non-task lines
 * return `{ ok: false }`.
 *
 * Round-trip invariant (post-normalization):
 *   parseTaskLine(formatTaskLine(input, src)).parsed
 *   == normalize(input)   // trim description, sanitize tags
 */
export function parseTaskLine(
  line: string,
): { ok: true; parsed: ParsedTask } | { ok: false } {
  const m = TASK_LINE_REGEX.exec(line);
  if (!m) return { ok: false };
  const [, leadingIndent, sym, rest] = m;
  const status = SYMBOL_TO_STATUS[sym];
  if (status === undefined) return { ok: false };

  let priority: TaskPriority | undefined;
  let dueDate: string | undefined;
  let scheduledDate: string | undefined;
  let createdDate: string | undefined;
  let completedDate: string | undefined;
  let cancelledDate: string | undefined;
  let source: TaskFormatSource = "gfm";
  let sawGfmMeta = false;
  const GFM_SENTINEL = "\u0000GFM\u0000";

  // Replace gfm `(field: value)` clauses with a sentinel — they emit as
  // a single visual unit but whitespace tokenization would split them.
  const restNoGfm = rest.replace(GFM_META_REGEX, (full, field: string, value: string) => {
    const v = value.trim();
    if (field === "priority" && (v === "high" || v === "medium" || v === "low")) {
      priority = v; sawGfmMeta = true; return ` ${GFM_SENTINEL} `;
    }
    if (field === "due" && STRICT_DATE_REGEX.test(v)) { dueDate = v; sawGfmMeta = true; return ` ${GFM_SENTINEL} `; }
    if (field === "scheduled" && STRICT_DATE_REGEX.test(v)) { scheduledDate = v; sawGfmMeta = true; return ` ${GFM_SENTINEL} `; }
    if (field === "created" && STRICT_DATE_REGEX.test(v)) { createdDate = v; sawGfmMeta = true; return ` ${GFM_SENTINEL} `; }
    if (field === "completed" && STRICT_DATE_REGEX.test(v)) { completedDate = v; sawGfmMeta = true; return ` ${GFM_SENTINEL} `; }
    if (field === "cancelled" && STRICT_DATE_REGEX.test(v)) { cancelledDate = v; sawGfmMeta = true; return ` ${GFM_SENTINEL} `; }
    // Unrecognized — collapse whitespace so it tokenizes as one extras chunk.
    return ` ${full.replace(/\s+/g, "_")} `;
  });

  const tokens = restNoGfm.split(/\s+/).filter((t) => t.length > 0);
  const descParts: string[] = [];
  const tags: string[] = [];
  const extras: string[] = [];
  let descClosed = false;
  if (sawGfmMeta) source = "gfm";

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    const next = tokens[i + 1];

    if (tok === GFM_SENTINEL) { descClosed = true; continue; }

    // Tags are extracted regardless of descClosed state — Tasks plugin
    // treats any `#tag` token as a tag, not as description content.
    if (/^#[^\s#]+$/.test(tok)) {
      tags.push(tok.slice(1));
      descClosed = true;
      continue;
    }

    if (tok === "📅" && next && STRICT_DATE_REGEX.test(next)) {
      dueDate = next; i++; descClosed = true; source = "tasks-plugin"; continue;
    }
    if (tok === "⏳" && next && STRICT_DATE_REGEX.test(next)) {
      scheduledDate = next; i++; descClosed = true; source = "tasks-plugin"; continue;
    }
    if (tok === "➕" && next && STRICT_DATE_REGEX.test(next)) {
      createdDate = next; i++; descClosed = true; source = "tasks-plugin"; continue;
    }
    if (tok === "✅" && next && STRICT_DATE_REGEX.test(next)) {
      completedDate = next; i++; descClosed = true; source = "tasks-plugin"; continue;
    }
    if (tok === "❌" && next && STRICT_DATE_REGEX.test(next)) {
      cancelledDate = next; i++; descClosed = true; source = "tasks-plugin"; continue;
    }
    if (tok === "⏫") { priority = "high"; descClosed = true; source = "tasks-plugin"; continue; }
    if (tok === "🔼") { priority = "medium"; descClosed = true; source = "tasks-plugin"; continue; }
    if (tok === "🔽") { priority = "low"; descClosed = true; source = "tasks-plugin"; continue; }

    // Known Tasks-plugin "extension" emoji whose VALUES we don't model
    // (start date 🛫, recurrence 🔁, id 🆔, highest/lowest priority
    // alternates 🔺/⏬). They mark the end of description and consume
    // their payload into `extras` so re-emission preserves them.
    if (tok === "🛫" || tok === "🔁" || tok === "🆔" || tok === "🔺" || tok === "⏬") {
      descClosed = true;
      source = "tasks-plugin";
      extras.push(tok);
      continue;
    }

    if (descClosed && /^#[^\s#]+$/.test(tok)) {
      tags.push(tok.slice(1));
      continue;
    }

    if (!descClosed) {
      descParts.push(tok);
    } else {
      extras.push(tok);
    }
  }

  void descClosed;

  const parsed: ParsedTask = {
    description: descParts.join(" "),
    status,
    leadingIndent,
    source,
    rawStatusSymbol: sym,
    extras: extras.join(" "),
  };
  if (priority) parsed.priority = priority;
  if (dueDate) parsed.dueDate = dueDate;
  if (scheduledDate) parsed.scheduledDate = scheduledDate;
  if (createdDate) parsed.createdDate = createdDate;
  if (completedDate) parsed.completedDate = completedDate;
  if (cancelledDate) parsed.cancelledDate = cancelledDate;
  if (tags.length > 0) parsed.tags = tags;
  return { ok: true, parsed };
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
