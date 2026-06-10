/**
 * Single source of truth for the names + one-line usage hints of every
 * vault tool that the preamble inventory must mention.
 *
 * Phase 2 creates this file. Phase 3/4 tool factories MUST import their
 * tool names from here (`READ_NOTE_TOOL_NAMES`, `WRITE_NOTE_TOOL_NAMES`)
 * so the inventory stays in lockstep — adding a new tool means adding it
 * to this manifest, which automatically (a) keeps the preamble accurate
 * and (b) satisfies the coverage test in `PreambleAssembler.test.ts`.
 *
 * `V01_TOOL_NAMES` lists the v0.1 tools (`view`, `read_file`,
 * `search_content`, `create_file`, `edit_file`, `delete_file`) so the
 * inventory names them too. We deliberately do NOT import these names
 * from `ReadTools.ts`/`WriteTools.ts` to keep this manifest stand-alone
 * (it's loaded by both the assembler and the tool factories, and we want
 * one-way data flow).
 */

export interface VaultToolEntry {
  /** Tool name as registered with the SDK. */
  name: string;
  /** One-line usage hint surfaced in the preamble. Keep ≤120 chars. */
  hint: string;
  /** True for read-only tools — used by Phase 3 to set `skipPermission`. */
  readOnly: boolean;
}

/**
 * v0.1 tools that already exist in `ReadTools.ts` / `WriteTools.ts`.
 * Listed here so the preamble inventory can name them with a short hint.
 */
export const V01_TOOL_ENTRIES: readonly VaultToolEntry[] = [
  {
    name: "view",
    hint: "List entries of a vault folder. Use to explore directory layout.",
    readOnly: true,
  },
  {
    name: "read_file",
    hint: "Read the full text of a vault file by vault-relative path.",
    readOnly: true,
  },
  {
    name: "search_content",
    hint: "Full-text search across vault markdown for a literal phrase.",
    readOnly: true,
  },
  {
    name: "create_file",
    hint: "Create a new vault file at a path that does not already exist.",
    readOnly: false,
  },
  {
    name: "edit_file",
    hint: "Edit a vault file by replacing one literal block of text with another.",
    readOnly: false,
  },
  {
    name: "delete_file",
    hint: "Move a vault file to trash (recoverable from Obsidian's trash).",
    readOnly: false,
  },
];

/**
 * Read-only tools shipped in Phase 3. Their factories MUST construct
 * tools whose `name` matches the entries here. The assembler reads this
 * to build the inventory; the coverage test asserts every name appears
 * verbatim in the assembled preamble.
 */
export const READ_NOTE_TOOL_ENTRIES: readonly VaultToolEntry[] = [
  {
    name: "get_active_note",
    hint: "Return the path + content of the note the user has open right now.",
    readOnly: true,
  },
  {
    name: "list_recent_notes",
    hint: "List the N most recently modified notes (path + mtime).",
    readOnly: true,
  },
  {
    name: "find_backlinks",
    hint: "List notes that link to a given note, distinguishing wikilinks from markdown links.",
    readOnly: true,
  },
  {
    name: "vault_tree",
    hint: "Return the vault folder structure (depth-bounded, node-bounded). Use to discover layout.",
    readOnly: true,
  },
  {
    name: "vault_metadata",
    hint: "Return headings + tags + frontmatter for one note WITHOUT its body. Cheap structural inspection.",
    readOnly: true,
  },
  {
    name: "find_tasks",
    hint: "List task-list items across the vault (or one note) filtered by status/tag/due range/regex. Read-only.",
    readOnly: true,
  },
];

/**
 * Write/workspace tools shipped in Phase 4 + Phase 5. Their factories MUST
 * construct tools whose `name` matches the entries here.
 */
export const WRITE_NOTE_TOOL_ENTRIES: readonly VaultToolEntry[] = [
  {
    name: "create_note",
    hint: "Create a markdown note at a vault-relative path. Fails (no overwrite) on collision.",
    readOnly: false,
  },
  {
    name: "edit_note",
    hint: "Edit an existing note in append, prepend, or replace mode. Preserves unsaved-editor-conflict guard.",
    readOnly: false,
  },
  {
    name: "open_note",
    hint: "Focus an existing note in the active workspace. Navigation only — no read/write.",
    readOnly: true,
  },
  {
    name: "insert_into_active_note",
    hint: "Insert text into the currently active editor at cursor / append / prepend / replace.",
    readOnly: false,
  },
  {
    name: "create_daily_note",
    hint: "Create today's daily note using the user's configured Daily Notes template + path.",
    readOnly: false,
  },
  {
    name: "create_task",
    hint: "Append a Tasks-plugin-compatible checkbox line (with optional 📅 YYYY-MM-DD due) to the daily note or a configured path.",
    readOnly: false,
  },
  {
    name: "update_task",
    hint: "Edit a single task line (status, dates, priority, tags, description) by line + expectedRawLine. Single approval, journal-undoable. Status -> done/cancelled auto-stamps today.",
    readOnly: false,
  },
];

/** All tool entries combined, in inventory presentation order. */
export const ALL_VAULT_TOOL_ENTRIES: readonly VaultToolEntry[] = [
  ...READ_NOTE_TOOL_ENTRIES,
  ...WRITE_NOTE_TOOL_ENTRIES,
  ...V01_TOOL_ENTRIES,
];

/** Phase 3 read-only tool names — exported for `skipPermission` wiring. */
export const READ_NOTE_TOOL_NAMES = READ_NOTE_TOOL_ENTRIES.map((e) => e.name);

/** Phase 4/5 mutating + workspace tool names (excludes read-equivalent `open_note`). */
export const WRITE_NOTE_TOOL_NAMES = WRITE_NOTE_TOOL_ENTRIES.filter(
  (e) => !e.readOnly,
).map((e) => e.name);
