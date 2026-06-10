import { ALL_VAULT_TOOL_ENTRIES } from "./vaultToolManifest";

/**
 * Phase 2: Vault-aware preamble assembler.
 *
 * Pure function — all time-dependent values (timezone, today) are inputs,
 * never read from the wall clock. This makes the output deterministic
 * (FR-021) and the function trivially unit-testable.
 *
 * The default preamble deliberately does NOT enumerate vault folder /
 * file names or recent-activity metadata (FR-007). Instead it names the
 * read-only vault tools (`vault_tree`, `vault_metadata`, etc.) so the
 * model fetches structure on demand via auto-approved tool calls
 * (FR-017). This keeps the preamble constant per vault root, cheap to
 * recompute, and bounded under 4 KB regardless of vault size.
 */

export type PreambleMode = "none" | "default" | "custom";

export interface PreambleInput {
  mode: PreambleMode;
  /** Absolute path to the vault root, e.g. `C:\Users\me\Notes`. */
  vaultRootAbsPath: string;
  /** IANA timezone, e.g. `America/Los_Angeles`. */
  timezone: string;
  /** Today's date in that timezone, formatted `YYYY-MM-DD`. */
  todayInTimezone: string;
  /** Body to emit verbatim when mode = `custom`. Supports placeholders. */
  customBody?: string;
}

/** Placeholders the custom-mode body may reference. */
export const PREAMBLE_PLACEHOLDERS = {
  VAULT_ROOT: "{{VAULT_ROOT}}",
  VAULT_TIMEZONE: "{{VAULT_TIMEZONE}}",
  VAULT_TODAY: "{{VAULT_TODAY}}",
  VAULT_TOOL_INVENTORY: "{{VAULT_TOOL_INVENTORY}}",
  AUTHORING_CONVENTIONS: "{{AUTHORING_CONVENTIONS}}",
} as const;

/**
 * Maximum size of the assembled default preamble. Spec line 157 / SC-005.
 * The default preamble is constant-sized per vault (no per-file content),
 * so this bound is structural — the test enforces it regardless of input.
 */
export const MAX_DEFAULT_PREAMBLE_BYTES = 4 * 1024;

/**
 * Vault tool inventory block — one bullet per tool. Generated from the
 * shared manifest so adding/removing a tool there updates the preamble
 * in lockstep.
 */
export const VAULT_TOOL_INVENTORY_BLOCK = buildToolInventoryBlock();

/**
 * Authoring-conventions block (FR-006a/b/c): backlinks, tags, tasks.
 * Phrased as concise guidance the model can apply when creating or
 * editing notes — not a tutorial, just the conventions this vault uses.
 */
export const AUTHORING_CONVENTIONS_BLOCK =
  "## Authoring conventions\n" +
  "- **Backlinks:** when a new note references an existing note, use Obsidian wikilink syntax `[[Note Name]]` so the graph stays connected. Create backlinks proactively whenever a related note already exists. Do NOT invent links to notes that don't exist unless the user asks for a placeholder.\n" +
  "- **Tags:** add inline tags (`#topic`, `#project/area`) sparingly — only when the tag would help the user find this note later. Reuse existing tags rather than coining new ones; call `vault_metadata` on a similar note first to see the established tag vocabulary.\n" +
  "- **Tasks:** when adding a TODO, use Tasks-plugin-compatible syntax (`- [ ] Description 📅 YYYY-MM-DD`). Resolve relative dates (\"tomorrow\", \"next Friday\") against the user's local timezone and today's date provided above, then pass the resolved `YYYY-MM-DD` to the `create_task` tool. Append tasks to today's daily note unless the user specifies otherwise.\n" +
  "- **Editing tasks:** to change a task (mark done, add a tag, reschedule, etc.), call `find_tasks` first to enumerate candidates, then call `update_task` once per result — pass back the `path`, `line`, AND `expectedRawLine` from the find result for safe re-anchoring. Status values are `todo`, `in-progress`, `done`, `cancelled`. Setting status to `done` or `cancelled` auto-stamps today's date. Dates must be strict `YYYY-MM-DD`; pass `null` to clear.";

/**
 * Marker line that introduces the preamble in the first user message.
 * Kept deliberately distinct so a future log/test can detect it.
 */
const PREAMBLE_MARKER = "<!-- copilot-agent: vault-aware preamble (v0.2) -->";

export function assemblePreamble(input: PreambleInput): string {
  if (input.mode === "none") return "";

  if (input.mode === "custom") {
    const body = input.customBody ?? "";
    return body
      .replaceAll(PREAMBLE_PLACEHOLDERS.VAULT_ROOT, input.vaultRootAbsPath)
      .replaceAll(PREAMBLE_PLACEHOLDERS.VAULT_TIMEZONE, input.timezone)
      .replaceAll(PREAMBLE_PLACEHOLDERS.VAULT_TODAY, input.todayInTimezone)
      .replaceAll(
        PREAMBLE_PLACEHOLDERS.VAULT_TOOL_INVENTORY,
        VAULT_TOOL_INVENTORY_BLOCK,
      )
      .replaceAll(
        PREAMBLE_PLACEHOLDERS.AUTHORING_CONVENTIONS,
        AUTHORING_CONVENTIONS_BLOCK,
      );
  }

  // mode === "default"
  return [
    PREAMBLE_MARKER,
    "## Vault context",
    `- Vault root: ${input.vaultRootAbsPath}`,
    `- Timezone: ${input.timezone}`,
    `- Today: ${input.todayInTimezone}`,
    "",
    VAULT_TOOL_INVENTORY_BLOCK,
    "",
    AUTHORING_CONVENTIONS_BLOCK,
  ].join("\n");
}

function buildToolInventoryBlock(): string {
  const header =
    "## Vault tools\n" +
    "Prefer these vault-specific tools over generic shell discovery. Read-only tools (marked R/O) require no approval; mutating tools route through the user's safety policy.";
  const lines = ALL_VAULT_TOOL_ENTRIES.map((entry) => {
    const tag = entry.readOnly ? " _(R/O)_" : "";
    return `- \`${entry.name}\`${tag}: ${entry.hint}`;
  });
  return [header, ...lines].join("\n");
}
