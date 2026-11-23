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
    hint: "Read the text of one note by vault-relative path. Text past 256 KB is cut off (`truncated` is true).",
    readOnly: true,
  },
  {
    name: "search_content",
    hint: "Text search across vault markdown. mode: 'substring' (default, literal), 'regex', 'simple' (all words, ranked), 'fuzzy' (character subsequence, ranked). Up to 50 matches.",
    readOnly: true,
  },
  {
    name: "create_file",
    hint: "Create a new vault file with `content`. Fails if the path already exists.",
    readOnly: false,
  },
  {
    name: "edit_file",
    hint: "Overwrites the whole of an existing vault file with `content` (the complete new text). For a change inside a note use replace_in_note.",
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
    hint: "List tasks across the vault (or one note) filtered by status, tag, due range or description regex. Results feed update_task / update_tasks.",
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
    hint: "Add to an existing note with `append` or `prepend`. `replace` overwrites the whole note with `content`; never run parallel `edit_note replace` calls on one note. For a change inside a note use replace_in_note.",
    readOnly: false,
  },
  {
    name: "replace_in_note",
    hint: "One targeted literal edit inside one note (oldText → newText). Fails unless the match count equals expectedOccurrences (default 1). One approval, one Undo entry.",
    readOnly: false,
  },
  {
    name: "open_note",
    hint: "Focus an existing note in the active workspace. Navigation only — no read/write.",
    readOnly: true,
  },
  {
    name: "insert_into_active_note",
    hint: "Add `content` to the note open in the editor with `append` or `prepend`; `replace` overwrites the whole note.",
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
  {
    name: "update_tasks",
    hint: "Apply one patch to many tasks (targets from find_tasks). Validates all first; one approval, one Undo entry.",
    readOnly: false,
  },
  {
    name: "move_note",
    hint: "Move or rename notes, attachments or folders (list of {from, to}); updates links. One approval, one Undo entry.",
    readOnly: false,
  },
  {
    name: "bulk_edit",
    hint: "One find/replace (literal or regex) across many notes, previewed with per-note counts. One approval, one Undo entry.",
    readOnly: false,
  },
];

/**
 * v0.3 Phase 2 read-only search tools. All three are auto-approved
 * under the FR-017 read-only gate (`skipPermission: true`).
 */
export const V03_READ_TOOL_ENTRIES: readonly VaultToolEntry[] = [
  {
    name: "search_by_tag",
    hint: "Find every note tagged with the given tag (with or without leading '#'). Capped at 200 results.",
    readOnly: true,
  },
  {
    name: "search_by_name",
    hint: "Find notes by file basename. Ranks exact > prefix > substring (case-insensitive). Capped at 50.",
    readOnly: true,
  },
  {
    name: "list_all_tags",
    hint: "List every distinct tag in the vault paired with its occurrence count, sorted by count desc.",
    readOnly: true,
  },
];

/**
 * v0.10 Phase 3 compound-query tool. Registered separately from the
 * v0.3 read-only search entries so downstream consumers (tests,
 * preamble) can distinguish "old" from "new" search surface.
 */
export const COMPOUND_TOOL_ENTRIES: readonly VaultToolEntry[] = [
  {
    name: "search_vault",
    hint: "Compound query: AND-combine tag / folder / modifiedSinceMs / text filters in one call. Skips body reads when structural filters exclude every note. Capped at 100 results.",
    readOnly: true,
  },
];

/**
 * v0.10 Phase 2 + Phase 4 structural navigation tools. All read-only,
 * `skipPermission: true`. Hint text refined in Phase 5 for the
 * session-start preamble inventory (FR-011 / SC-011).
 */
export const NAVIGATE_TOOL_ENTRIES: readonly VaultToolEntry[] = [
  {
    name: "resolve_link",
    hint: "Resolve a wikilink or markdown link to its target path the way Obsidian's click does (source-aware). Pass the raw link text directly; no need to pre-scan.",
    readOnly: true,
  },
  {
    name: "get_outlinks",
    hint: "List a note's outgoing links and embeds (wikilink vs. markdown kind, resolved path when known). Capped at 200. Call directly; a missing note is reported, not thrown.",
    readOnly: true,
  },
  {
    name: "get_note_structure",
    hint: "Return a note's headings, sections and block IDs with line numbers, without body text. Use before read_file on long notes. Capped at 500 items.",
    readOnly: true,
  },
  {
    name: "related_notes",
    hint: "Rank a note's neighbours by shared tags (weight 3), outlinks (2) and backlinks (1). Up to 20 results with per-signal counts.",
    readOnly: true,
  },
];

/** All tool entries combined, in inventory presentation order. */
export const ALL_VAULT_TOOL_ENTRIES: readonly VaultToolEntry[] = [
  ...READ_NOTE_TOOL_ENTRIES,
  ...V03_READ_TOOL_ENTRIES,
  ...COMPOUND_TOOL_ENTRIES,
  ...NAVIGATE_TOOL_ENTRIES,
  ...WRITE_NOTE_TOOL_ENTRIES,
  ...V01_TOOL_ENTRIES,
];

/** Phase 3 read-only tool names — exported for `skipPermission` wiring. */
export const READ_NOTE_TOOL_NAMES = READ_NOTE_TOOL_ENTRIES.map((e) => e.name);

/** v0.3 Phase 2 read-only search-tool names. */
export const V03_READ_TOOL_NAMES = V03_READ_TOOL_ENTRIES.map((e) => e.name);

/** v0.10 Phase 3 compound-query tool names. */
export const COMPOUND_TOOL_NAMES = COMPOUND_TOOL_ENTRIES.map((e) => e.name);

/** v0.10 Phase 2 structural navigation tool names. */
export const NAVIGATE_TOOL_NAMES = NAVIGATE_TOOL_ENTRIES.map((e) => e.name);

/** Phase 4/5 mutating + workspace tool names (excludes read-equivalent `open_note`). */
export const WRITE_NOTE_TOOL_NAMES = WRITE_NOTE_TOOL_ENTRIES.filter(
  (e) => !e.readOnly,
).map((e) => e.name);

/**
 * v0.3 Phase 1: the six v0.1 raw-filesystem tool names. The
 * "Expose v0.1 raw-filesystem tools" setting (default ON; users can
 * opt OUT for a strictly vault-only agent) gates whether these are
 * filtered out of the SDK-bound tools list and the preamble inventory
 * at plugin startup. The constant lives here (not in `ReadTools.ts` /
 * `WriteTools.ts`) so `main.ts`, `PreambleAssembler.ts`, and the chat
 * renderer (Phase 6 — historical entry rendering) can import a single
 * source of truth without re-declaring the list.
 */
export const V01_RAW_FS_TOOL_NAMES = [
  "view",
  "read_file",
  "search_content",
  "create_file",
  "edit_file",
  "delete_file",
] as const;
