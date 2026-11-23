---
date: 2026-11-20T16:19:33-08:00
git_commit: d5dc667da8bd551d1ee51eaf2d2285ea5e72ca3f
branch: feature/vault-tool-first-writes
repository: obsidian-copilot-agent
topic: "Vault Tool-First Writes — current implementation map (preamble, write tools, undo, safety, persistence, UI)"
tags: [research, codebase, PreambleAssembler, vaultToolManifest, UpdateTask, WriteTools, WriteNoteTools, UndoJournal, SafetyPolicy, AgentSession, ChatView, ToolCallBlock, persistence]
status: complete
last_updated: 2026-11-20
---

# Research: Vault Tool-First Writes — current implementation

## Research Question

Where and how does the current code implement the pieces that Spec.md
(`.paw/work/vault-tool-first-writes/Spec.md`) builds on? The spec adds
`update_tasks`, `move_note`, and `bulk_edit`, a batch undo entry, a
`{{VAULT_WRITE_RULES}}` preamble placeholder (with the default-preamble
cap going from 8 KB to 10 KB), multi-path approval previews and
allowlist checks, and out-of-band change detection. This document
covers preamble assembly, the tool manifest, task editing, write
primitives, undo journal and persistence, the safety policy, the
AgentSession permission and stream plumbing, ChatView and ToolCallBlock
rendering, `main.ts` wiring, test fakes, Obsidian API typings, and docs
conventions.

## Summary

- **Preamble.** `assemblePreamble` (`src/domain/PreambleAssembler.ts:98-134`)
  builds the default preamble from a marker, a "Vault context" block,
  the manifest-driven tool inventory (`buildToolInventoryBlock`,
  `:158-188`), and `AUTHORING_CONVENTIONS_BLOCK` (`:85-90`). Custom mode
  substitutes five placeholders (`:46-52`) with chained `replaceAll`
  calls (`:106-120`). The default preamble is about 6.9 KB today
  (measured below), under `MAX_DEFAULT_PREAMBLE_BYTES = 8*1024` (`:62`).
- **Manifest.** `src/domain/vaultToolManifest.ts` holds grouped
  `VaultToolEntry` lists. `WRITE_NOTE_TOOL_ENTRIES` (`:108-144`) ends
  with `update_task`. The manifest drives the preamble only. Tool
  registration happens in each tool factory, and SafetyPolicy
  classification uses a separate hardcoded list,
  `VAULT_WRITE_TOOL_NAMES` (`src/tools/WriteTools.ts:605-613`).
- **Task editing.** `update_task` (`src/tools/WriteNoteTools.ts:887-991`)
  calls `updateTaskImpl` (`src/tools/UpdateTask.ts:99-199`). That
  function runs inside one `processFileImpl` atomic read-modify-write.
  Errors inside the callback are signalled with `ProcessAbort`. It
  returns `{ok, path, line, changed, changedFields, before, after, undoId?, undoSurface?}`
  or a `reason`-coded error. `validatePatch`, `identifyTargetLine`, and
  `applyPatch` are module-private (`:201`, `:227`, `:295`).
- **Undo.** `UndoJournal` (`src/domain/UndoJournal.ts`) stores one
  single-path `create | modify | delete` entry per write. It has a
  50-entry cap, divergence checks (`ok | modified | missing | existed`),
  a `force` retry, and a persist callback (`add | evict | mark-undone`).
  Persistence fields are listed explicitly in four places:
  `PersistedUndoEntry`, `validateUndoEntry`, `makePersistAdapter`, and
  `ConversationsStore.recordUndo`. `validateUndoEntry` rejects unknown
  kinds, and any invalid undo entry makes `validateConversation` return
  null. The vault interface has no `rename`, `process`, or
  `createFolder`.
- **Safety.** `AgentSession.buildSafetyInput` (`src/sdk/AgentSession.ts:2556-2592`)
  maps any `custom-tool` whose name passes `isVaultWriteToolName` to
  `source: "vault"` with one `vaultRelativePath` (from
  `safety.extractVaultPath`, wired in `src/main.ts:806-828`).
  `decideSafety` (`src/domain/SafetyPolicy.ts:211-326`) tests that one
  path against the allowlist with exact-or-`entry/` prefix semantics
  (`:189-201`). The approval summary is `${toolName} ${path}`
  (`AgentSession.ts:2846-2848`). The detail is pretty-printed args JSON
  (`:2892-2893`), truncated at 4000 chars in the UI
  (`src/ui/ToolCallBlock.ts:201-204`).
- **Change detection.** No `vault.on(...)`, `registerEvent`, or
  `fileManager` usage exists anywhere in `src/`. The only event
  subscription pattern is `workspace.on("quit")` plus `this.register`
  (`src/main.ts:1151-1161`). Obsidian 1.13 typings provide
  `Vault.on('create'|'modify'|'delete'|'rename')`,
  `FileManager.renameFile`, `Vault.createFolder`, and
  `MetadataCache.resolvedLinks`.
- **Tool-call fields.** A new persisted field (for example, a change
  warning) must be added to `ToolCall` (`src/domain/types.ts:22-70`),
  `PersistedMessage.toolCalls` (`src/persistence/PersistedShape.ts:28-40`),
  `validateMessage` (`src/persistence/migrate.ts:287-305`),
  `hydrateChatState` (`src/domain/ConversationRuntime.ts:101-123`),
  `toPersistedToolCalls` (`src/ui/ChatView.ts:1921-1951`), and the
  `MessageRenderer` re-render signature
  (`src/ui/MessageRenderer.ts:338-350`).

## Documentation System

- **Framework**: plain Markdown (no docs site generator).
- **Docs Directory**: none dedicated. Docs are in root Markdown files
  plus `proposals/`.
- **Navigation Config**: N/A. `proposals/README.md` keeps a manual Index
  table.
- **Style Conventions**:
  - `README.md` is organized by "What's new in vX.Y" sections
    (`README.md:38`, `:49`, `:71`, …). There are also "Safety model"
    (`:255`), "Read-tool exemption" (`:271`), and "Tests" (`:294`)
    sections. The tool list sits under "What's new in v0.2"
    (`README.md:181-183`): read-only and mutating tool names plus a
    "Task editing" bullet that describes `find_tasks`/`update_task`.
    The Undo behavior is described at `README.md:166` (cross-restart
    undo, 50 entries, 7-day TTL, divergence prompt) and `README.md:269`.
  - README does not document preamble placeholders. They appear in the
    settings UI description (`src/settings/SettingsTab.ts:366-375`),
    which builds its text from `PREAMBLE_PLACEHOLDERS`, and in a
    CHANGELOG entry (`CHANGELOG.md:386`).
  - `CHANGELOG.md` is "loosely based on Keep a Changelog"
    (`CHANGELOG.md:4`), with `## [x.y.z] - YYYY-MM-DD` headings and
    `### Added / Changed / Fixed / Under the hood` subsections. Bullets
    start with a bold user-facing sentence and often end with
    `(\`src/...\`)` file refs (`CHANGELOG.md:10-21`).
    - There is no `## [Unreleased]` section at HEAD; the top section is
      `## [0.11.0] - 2026-11-19` (`CHANGELOG.md:6`).
    - Feature PRs add an `## [Unreleased]` heading at the top
      (`git show cc45bc6:CHANGELOG.md` line 6). Release tooling
      rewrites it with `normalizeUnreleasedHeading`
      (`src/release/changelog.ts:89-110`). `insertStubSection`
      (`:57-87`) inserts `## [version] - date` / `### Added` stubs.
  - In `proposals/`, files are named `NNNN-short-slug.md`. Each has a
    `Status:` line, and the sections are Problem / Sketch / Open
    questions (`proposals/README.md:5-16`). The Index table is a
    `| # | Title | Status |` Markdown table (`proposals/README.md:29-44`),
    with 0012 as the last row. The example header in
    `proposals/0012-undo-under-contention.md:1-7` is
    `# 0012 — Title`, then `**Status:** Draft`, `**Created:** YYYY-MM-DD`,
    `**Owner:**`, and `**Origin:**` lines, then `## Problem`.
- **Build Command**: N/A for docs.
- **Standard Files**: `README.md`, `CHANGELOG.md`, `RELEASING.md`,
  `proposals/README.md`, and `.github/copilot-instructions.md`.

## Verification Commands

From `package.json` scripts:

- **Test Command**: `npm test` (`vitest run`; `pretest` regenerates the
  pinned binary version). `vitest.config.ts` uses the `node`
  environment, `include: ["src/**/*.test.ts"]`, and aliases `obsidian`
  to `src/test/obsidianMock.ts`.
- **Lint Command**: none defined (no eslint script).
- **Build Command**: `npm run build` (`node esbuild.config.mjs production`).
- **Type Check**: `npm run typecheck` (`tsc --noEmit`).
- **Deploy (dev)**: `npm run deploy`, which builds and then copies to the
  vault through `scripts/deploy.mjs`, per `.github/copilot-instructions.md`.

## Detailed Findings

### 1. PreambleAssembler (`src/domain/PreambleAssembler.ts`)

- Line 1 imports `ALL_VAULT_TOOL_ENTRIES` and `V01_RAW_FS_TOOL_NAMES`
  from the manifest.
- `PreambleInput` (`:22-43`) has `mode`, `vaultRootAbsPath`,
  `timezone`, `todayInTimezone`, `customBody`, `excludeRawFs`, and
  `mcp`.
- `PREAMBLE_PLACEHOLDERS` (`:46-52`) has five keys:
  `VAULT_ROOT`, `VAULT_TIMEZONE`, `VAULT_TODAY`, `VAULT_TOOL_INVENTORY`,
  and `AUTHORING_CONVENTIONS`. Each maps to `"{{KEY}}"`.
- `MAX_DEFAULT_PREAMBLE_BYTES = 8 * 1024` (`:62`), with a justification
  comment at `:54-61`.
- Measured default output at HEAD (default mode, a sample Windows vault
  path, no MCP) is 6934 bytes with raw-FS tools, or 5781 bytes with
  `excludeRawFs: true`. This was measured with
  `npx tsx -e "...assemblePreamble(...)"`.
- `VAULT_TOOL_INVENTORY_BLOCK = buildToolInventoryBlock(false)` (`:71`);
  `VAULT_TOOL_INVENTORY_BLOCK_GATED = buildToolInventoryBlock(true)` (`:78`).
- `AUTHORING_CONVENTIONS_BLOCK` (`:85-90`) has four bullets: Backlinks
  (`:87`), Tags (`:88`), Tasks (`:89`), and **Editing tasks** (`:90`).
  The Editing tasks bullet tells the model to call `find_tasks` first,
  then call `update_task` once per result, passing back `path`, `line`,
  and `expectedRawLine`. It also gives the status values
  (todo/in-progress/done/cancelled), says done/cancelled auto-stamp the
  date, requires strict `YYYY-MM-DD` dates, and says null clears.
- `PREAMBLE_MARKER` (`:96`).
- `assemblePreamble` (`:98-134`):
  - Lines 101-103 choose the gated or full inventory based on `excludeRawFs`.
  - Custom mode (`:106-120`) is
    `customBody.replaceAll(PLACEHOLDER, value)`, chained once per
    placeholder. Only placeholders present in the body are affected.
  - Default mode (`:123-133`) joins the marker, a `## Vault context`
    block (root, timezone, today), the inventory, and
    `AUTHORING_CONVENTIONS_BLOCK`.
- `appendMcpInventory` (`:136-156`) appends the MCP tool list after
  either mode.
- `buildToolInventoryBlock(excludeRawFs)` (`:158-188`):
  - The header (`:159-164`) begins "Always reach for vault-specific
    tools FIRST…".
  - When raw-FS tools are not excluded, a fallback note is added
    (`:165-174`).
  - Bullets are formatted as
    `- \`name\`${readOnly ? " _(R/O)_" : ""}${fallback ? " _(fallback)_" : ""}: hint`
    (`:185`), iterating `ALL_VAULT_TOOL_ENTRIES` and skipping raw-FS
    names when gated.

**Tests** — `src/domain/PreambleAssembler.test.ts`:

- The size bound is checked with
  `Buffer.byteLength(out, "utf8") < MAX_DEFAULT_PREAMBLE_BYTES`
  (`:80-98`, long vault path, default mode) and again with
  `excludeRawFs: true` (`:352-357`).
- A lockstep test (`:100-119`) checks that every `ALL_VAULT_TOOL_ENTRIES`
  name appears as `` `name` `` in `VAULT_TOOL_INVENTORY_BLOCK`. It uses
  `WRITE_NOTE_TOOL_NAMES` at `:107` to check that write tools are not
  tagged R/O.
- Placeholder tests (`:208-248`) cover:
  - a custom body passed through verbatim;
  - substitution of only the placeholders that are present;
  - all five placeholders together, asserting the output contains
    `VAULT_TOOL_INVENTORY_BLOCK` and `AUTHORING_CONVENTIONS_BLOCK`
    (`:234-241`);
  - an empty body.
- `excludeRawFs` under custom mode (`:306-318`).
- Gated-block tests (`:264-357`), including "shorter by exactly six
  bullets" (`:296-304`, `countBullets`) and `WRITE_NOTE_TOOL_NAMES` use
  at `:280`.
- Other tests check inventory text: "vault-specific tools FIRST"
  (`:330`), R/O tagging (`:191-194`), and the absence of `_(fallback)_`
  in the gated block (`:346-347`).

**Settings UI** — `src/settings/SettingsTab.ts:12` imports
`PREAMBLE_PLACEHOLDERS`. The "Custom preamble body" description
(`:366-375`) lists each placeholder by name, followed by "Placeholders
are substituted only when present in the body." The list is
hand-enumerated; it does not iterate over the object.

### 2. Tool manifest (`src/domain/vaultToolManifest.ts`)

- `VaultToolEntry { name; hint; readOnly }` (`:19-26`). The doc comment
  says hints are at most 120 chars, but this is not enforced, and
  several existing hints are longer.
- Groups:
  - `V01_TOOL_ENTRIES` (`:32-63`)
  - `READ_NOTE_TOOL_ENTRIES` (`:71-102`, with `find_tasks` at `:97-101`)
  - `WRITE_NOTE_TOOL_ENTRIES` (`:108-144`): `create_note`, `edit_note`,
    `open_note` (readOnly), `insert_into_active_note`,
    `create_daily_note`, `create_task`, and `update_task` (`:139-143`)
  - `V03_READ_TOOL_ENTRIES` (`:150-166`)
  - `COMPOUND_TOOL_ENTRIES` (`:173-179`)
  - `NAVIGATE_TOOL_ENTRIES` (`:186-207`)
- `ALL_VAULT_TOOL_ENTRIES` (`:210-217`) is ordered read-note, v03,
  compound, navigate, write-note, v01. This order is the inventory
  bullet order.
- Name constants:
  - `READ_NOTE_TOOL_NAMES` (`:220`)
  - `V03_…` (`:223`)
  - `COMPOUND_…` (`:226`)
  - `NAVIGATE_…` (`:229`)
  - `WRITE_NOTE_TOOL_NAMES` (`:232-234`): the non-readOnly write-note entries
  - `V01_RAW_FS_TOOL_NAMES` (`:246-253`)
- Consumers:
  - `WRITE_NOTE_TOOL_NAMES` is used only in `PreambleAssembler.test.ts`
    (`:15`, `:107`, `:280`).
  - `READ_NOTE_TOOL_NAMES` is used by `src/tools/ReadNoteTools.ts:14,19`
    and `ReadNoteTools.test.ts:386-390`. That test is the only one that
    checks the manifest against actual `defineTool` names.
  - `V01_RAW_FS_TOOL_NAMES` is used by `src/ui/ChatView.ts:31` (to build
    `RAW_FS_TOOL_NAME_SET` for Undo suppression) and by
    `src/domain/toolGating.ts`.
- Tool gating: `filterRawFsToolsIfGated(tools, expose)`
  (`src/domain/toolGating.ts:16-23`) drops raw-FS names when the startup
  snapshot is false.
- `src/main.toolGating.test.ts`:
  - Builds `FakeTool` name lists: RAW_FS (`:19-21`), VAULT_READ
    (`:23-30`), and VAULT_WRITE (`:32-40`, hardcoded to include
    `update_task`).
  - Tests are at `:48-110`; the manifest invariant is at `:97-109`.
- No test checks `WRITE_NOTE_TOOL_ENTRIES`, `createWriteNoteTools`, and
  `VAULT_WRITE_TOOL_NAMES` against each other.

### 3. Task editing (`src/tools/UpdateTask.ts`, `src/tools/TaskFormat.ts`)

`UpdateTask.ts`:

- The header comment (`:1-29`) documents the re-anchor tiers
  (`line` → `expectedRawLine` → `descriptionMatch`), status
  auto-stamping, and no-op idempotency (no write and no undo entry when
  the line is unchanged).
- Imports: `processFileImpl` and `ProcessAbort` from `./WriteTools`
  (`:39`); the `WriteNoteToolsDeps` type (`:40`); `resolveVaultPath`,
  `toVaultRelative`, `lookupTFile`, and `VaultPathError` (`:41-46`).
- Exported types:
  - `UpdateTaskInput { path; line; expectedRawLine?; descriptionMatch?; patch }` (`:48-57`)
  - `UpdateTaskPatch { addTags?; removeTags?; setPriority?: P|null; setDueDate?: string|null; setScheduledDate?: string|null; setStatus?; setDescription? }` (`:59-67`)
  - `UpdateTaskCandidate { line; raw }` (`:69-72`)
  - `UpdateTaskResult` (`:74-95`):
    ```ts
    | { ok: true; path; line; changed; changedFields: string[]; before; after; undoId?; undoSurface?: "journal" }
    | { ok: false; reason: "invalid_path"; details? } | { reason: "not_found" }
    | { reason: "read_failed"; error } | { reason: "not_a_task"; raw }
    | { reason: "task_not_found" } | { reason: "ambiguous_match"; candidates }
    | { reason: "invalid_date_format"; field } | { reason: "invalid_priority" }
    | { reason: "invalid_status" } | { reason: "write_failed"; error }
    ```
- `export async function updateTaskImpl(input, deps: WriteNoteToolsDeps)` (`:99-199`):
  1. Calls `validatePatch` first (`:104-105`).
  2. Resolves the path with `resolveVaultPath` + `toVaultRelative`;
     a `VaultPathError` becomes `invalid_path` (`:107-114`).
  3. `lookupTFile` returns null → `not_found` (`:115-116`).
  4. Calls `processFileImpl(vaultRel, (content) => {...}, deps)`
     (`:130-167`). The callback splits on `"\n"`, calls
     `identifyTargetLine`, `parseTaskLine`, and `applyPatch`, then
     rebuilds the line as
     `parsed.leadingIndent + formatTaskLine(patched, parsed.source)`.
     It returns the original content on a no-op. Errors are stored in
     closure variables (`abortResult`, `idxOut`, `beforeOut`,
     `afterOut`, `changedFieldsOut`) and the callback throws
     `ProcessAbort`.
  5. Maps the outcome (`:169-198`). An abort returns `abortResult`. An
     unchanged result returns `changed: false` with no `undoId`. A
     changed result returns `undoId: wr.undoId, undoSurface: "journal"`.
  - The clock is `deps.now()` formatted by the private `formatYmd`
    (`:149`, `:415-420`).
- Private helpers (not exported):
  - `validatePatch` (`:201-225`): strict date regex for due/scheduled,
    priority enum, status enum.
  - `identifyTargetLine(input, lines)` (`:227-293`):
    - Tier 1 compares `expectedRawLine` after trimming trailing spaces
      and tabs on both sides: hinted line first, then a full-file scan.
      Zero matches → `task_not_found`; more than one →
      `ambiguous_match` with candidates.
    - Tier 2 scans every line for `descriptionMatch` substring matches
      among parsed tasks.
    - With neither anchor, it uses `line` if that line exists.
  - `applyPatch(parsed, patch, today)` (`:295-402`) returns
    `{patched, changedFields}`. Status changes stamp or clear
    `completedDate`/`cancelledDate`.
  - `sanitizeTag` (`:404-407`), `setsEqual` (`:409-413`).

`TaskFormat.ts`:

- Exports:
  - types `TaskPriority` (`:18`), `TaskStatus` (`:26`), `TaskInput` (`:28`), `TaskFormatSource` (`:59`)
  - `STRICT_DATE_REGEX` (`:89`)
  - `formatTaskLine(input, source)` (`:105-137`, tasks-plugin emoji vs
    GFM `(field: value)`, with `extras` appended verbatim)
  - `ParsedTask` (`:139-149`: `leadingIndent`, `source`, `rawStatusSymbol`, `extras`)
  - `parseTaskLine(line)` (`:163+`, using `TASK_LINE_REGEX = /^(\s*)- \[(.)\] ?(.*)$/` at `:151`)

`find_tasks` result shape: `FindTasksHit { path; line (1-based); raw; parsed }`
(`src/tools/FindTasks.ts:48-54`), `MAX_RESULTS = 500` (`:30`).
`ReadNoteTools.ts:191` tells the model to pass back `expectedRawLine`.

**Tests**:

- `src/tools/UpdateTask.test.ts` (603 lines) has three describes:
  patch application (`:110`), re-anchoring (`:352`), and F5
  descriptionMatch ambiguity (`:506`).
- Its fake world (`:27-108`) is a `Map<path, FakeFile{path, content}>`
  over a real `fs.mkdtempSync(os.tmpdir())` root (`:17-25`), so that
  `resolveVaultPath`'s realpath works.
  - `getAbstractFileByPath`, `read`, `cachedRead`, `create`, `modify`.
  - `process` serialized per path through `processChains` (`:68-84`).
  - Workspace: `getActiveFile: () => null`, `getLeavesOfType: () => []`.
- `makeDeps` builds `new ObsidianApi(app)` and `new UndoJournal(app.vault)`
  and pins `now` (`:49-104`). `TaskFormat.test.ts` is pure.

### 4. Write primitives and path validation (`src/tools/WriteTools.ts`, `src/tools/VaultPath.ts`)

- `WriteToolsVault` (`WriteTools.ts:19-46`) has:
  - `adapter.getBasePath`, `getFileByPath`, `getAbstractFileByPath`, and the read methods
  - `create`
  - optional `createFolder` (comment `:21-27`)
  - `modify`
  - optional `process(file, fn)` (`:39-42`)
  - `delete`, `trash`
- It has no `rename`.
- `WorkspaceForWrites { getLeavesOfType(type) }` (`:53-55`).
- `WriteToolsDeps { vault; workspace?; undoJournal }` (`:62-66`).
- Results:
  - `WriteResult { ok: true; kind; path; undoId }` (`:68-73`)
  - `WriteError { ok: false; error; alreadyExists? }` (`:75-87`)
  - exported aliases (`:89-91`)
- `createFileImpl` (`:95-152`) calls
  `journal.record({kind:"create", scope:"vault", path, after})` at
  `:145`.
- `hasUnsavedEditorChanges(vaultRel, diskContent, workspace)` (`:160-179`)
  iterates `workspace.getLeavesOfType("markdown")`, matches
  `view.file.path`, and compares `view.getViewData()` to the disk
  content. It is exported and used by `WriteNoteTools.ts:5`.
- `editFileImpl` (`:181-246`) records
  `{kind:"modify", scope:"vault", path, before, after}` (`:239`).
- `export class ProcessAbort extends Error` (`:260-266`) is the sentinel
  a callback throws to cancel the write without recording.
- `ProcessFileResult` (`:274-277`) is `WriteResult & { changed: boolean }`
  or `WriteError`.
- `export async function processFileImpl(rawPath, fn, deps)` (`:302-430`):
  1. Reads first and runs the dirty-editor guard (`:330-353`).
  2. Without `vault.process`, uses a legacy read → fn → modify path
     (`:359-391`, record at `:384`).
  3. Otherwise calls atomic `vault.process` (`:404`) and records
     `modify` with the observed before and after content (`:422`).
  4. Unchanged content returns `changed: false` with no record.
- `deleteFileImpl` (`:432-485`) prefers `trash` and records
  `{kind:"delete", before}` (`:479`).
- `createWriteTools(deps)` (`:502-585`) builds the raw-FS
  `create_file`/`edit_file`/`delete_file` tools with `defineTool`,
  JSON-schema `parameters`, `overridesBuiltInTool: true`, and lenient
  `(args ?? {})` parsing.
- Exports:
  - `WRITE_TOOL_NAMES` (`:590`), `isWriteToolName` (`:592`)
  - `VAULT_WRITE_TOOL_NAMES` (`:605-613`): `WRITE_TOOL_NAMES` plus
    `create_note`, `edit_note`, `insert_into_active_note`,
    `create_daily_note`, `create_task`, and `update_task`
  - `isVaultWriteToolName` (`:615-616`)
- `isVaultWriteToolName` has one consumer: `src/sdk/AgentSession.ts:11`
  (import) and `:2563` (classification). A tool missing from this set
  falls through to `source: "builtin"`, keyed by tool name
  (`AgentSession.ts:2589-2591`).

`VaultPath.ts`:

- `VaultPathError` (`:10-15`), `VaultLike` (`:23-27`).
- `resolveVaultPath(raw, vault)` (`:56-132`):
  - rejects Windows drive paths (`:70`) and UNC paths (`:78`);
  - strips leading slashes (`:88`);
  - rejects `..` segments (`:94-101`) and the empty/root path (`:102`);
  - realpaths the deepest existing ancestor (`:115-116`);
  - checks containment (`:119-129`).
- `toVaultRelative(abs, vault)` (`:139-143`).
- `lookupTFile(vaultRel, vault)` (`:150-162`) tries `getFileByPath`,
  then `getAbstractFileByPath`.
- No code rejects the config directory (`.obsidian`). The only
  `configDir` reference in `src/` is `src/main.ts:360`
  (`pluginDataDir`).
- No extension allowlist (such as `.md`/`.txt`) exists in the write
  path helpers.

### 5. Vault-native write tools (`src/tools/WriteNoteTools.ts`)

- `WriteNoteToolsDeps extends WriteToolsDeps { api: ObsidianApi; now: () => Date; vaultAwareness: () => VaultAwarenessSettings }`
  (`:36-41`).
- `NoteWriteResult` success shape (`:43-66`):
  `{ok, kind, path, undoId?, undoSurface?: "editor-native"|"journal", source?, usedFallback?, templateApplied?}`.
  Error shape is `{ok:false, error}` (`:68-71`).
- Exported impls: `createNoteImpl` (`:77`), `editNoteImpl` (`:134`),
  `openNoteImpl` (`:257`), `insertIntoActiveNoteImpl` (`:285`),
  `createDailyNoteImpl` (`:363`), `CreateTaskResult` (`:437`), and
  `createTaskImpl` (`:544`).
- `createNoteImpl` records the undo entry itself through
  `deps.undoJournal.record({kind:"create", scope:"vault", path, after})`
  (`:105-110`) when the richer API path succeeds.
- `createWriteNoteTools(deps): Tool<unknown>[]` (`:699-993`) returns
  `defineTool(name, {description, parameters, handler, skipPermission?})`
  entries:
  - `create_note` (`:701`), `edit_note` (`:722`)
  - `open_note` (`:753`, `skipPermission: true` at `:766`)
  - `insert_into_active_note` (`:773`), `create_daily_note` (`:798`),
    `create_task` (`:813`), `update_task` (`:887-991`)
  - Parameters are plain JSON Schema objects (`type: "object"`,
    `properties`, `required`, `additionalProperties: false`), not zod.
- `update_task`:
  - Description at `:888-900`. Parameters (`:901-950`): `path`, `line`
    (number), `expectedRawLine`, `descriptionMatch`, and a nested
    `patch` object. `setPriority` and the dates use
    `type: ["string","null"]`.
  - The handler (`:952-990`) throws on a missing `path` or `line`. It
    copies only recognized patch fields (invalid enum values are
    dropped silently, so `invalid_status`/`invalid_priority` are not
    reachable through the handler), then returns `updateTaskImpl(input, deps)`.
  - The handler returns the result object directly. The SDK serializes
    it, and ChatView parses it back from `tool_call_complete.content`
    with `extractUndoId` (§7).
- Assembly in `src/main.ts`: `createWriteNoteTools({vault, workspace, undoJournal: journal, api: obsidianApi, now, vaultAwareness})`
  (`:684-695`). The result is spread last into the `vaultTools` array
  (`:696-706`) along with `readTools`, `writeTools`, `readNoteTools`,
  `searchTools`, and `navigateTools`, then passed to
  `new CopilotAgentSession({ tools: vaultTools, … })` (`:772`).
  AgentSession derives `customToolNames` from `opts.tools`
  (`AgentSession.ts:724-726`).
- Tests: `src/tools/WriteNoteTools.test.ts`.
  - Its fake world (`:47-178`) supports `getAbstractFileByPath`
    (`:93`), per-path serialized `process` (`:108`), and a markdown view
    symbol with `getActiveViewOfType: (k) => k === sym ? view : null`
    (`:128-130`).
  - Dirty-editor fakes override `getLeavesOfType` with
    `getViewData: () => "DIRTY-BUFFER"` (`:307-315`, `:819`).
  - The factory describe is at `:574`; the `createTaskImpl` describe is
    at `:637`.

### 6. Undo journal and persistence chain

`src/domain/UndoJournal.ts`:

- Types:
  - `UndoKind = "create" | "modify" | "delete"` (`:29`); `UndoScope` (`:31`)
  - `UndoEntry { id; kind; scope; path; before?; after?; recordedAt; undone? }` (`:33-47`)
  - `UndoOutcome { ok; reason?; divergence?: "ok"|"modified"|"missing"|"existed" }` (`:49-70`)
  - `UndoOptions { force? }` (`:73-81`)
- `UndoJournalVault` (`:87-96`): `getFileByPath`, `getAbstractFileByPath?`,
  `read`, `cachedRead?`, `create`, `modify`, `delete?`, `trash?`. There
  is no `rename`, `process`, or `createFolder`.
- Persist ops are `"add" | "evict" | "mark-undone"` (`:113`). Options
  are `{maxEntries?, persist?, initialEntries?, loadOptions?{ttlMs, now}}`
  (`:115-136`). `DEFAULT_MAX_ENTRIES = 50` (`:138`).
- The constructor (`:156-193`) accepts a bare vault or
  `(vault, options)`, hydrates `initialEntries` without persisting, and
  evicts TTL-expired entries with an `evict` persist.
- `record(partial)` (`:206-225`) evicts the oldest entry at the cap
  (persisting `evict` first), assigns `undo-N`, stamps `recordedAt`,
  pushes the entry, and persists `add`. It returns the entry.
- `get(id)` (`:227`).
- `undo(id, {force})` (`:246-386`) has one branch per kind:
  - **create** (`:261-293`): if the file is missing, returns divergence
    `missing` unless forced, in which case it is a no-op success. If
    the content differs from `after`, returns `modified` unless forced.
    Otherwise it deletes the file.
  - **modify** (`:294-339`): if the file is missing, returns `missing`;
    when forced, it recreates the file from `before`. If the content
    differs from `after`, returns `modified`; when forced, it modifies
    to `before`.
  - **delete** (`:340-373`): if a file exists, returns `existed`; when
    forced, it modifies the existing file to `before`. Otherwise it
    creates the file from `before`.
  - On success the entry is marked `undone` and persisted as
    `mark-undone`. Errors return `"Undo failed: …"` (`:380-385`).
- `clear` (`:389`). `hydrate` (`:396-422`) advances `idCounter` past the
  highest `undo-N`. `safePersist` (`:424-431`) swallows exceptions.
- Vault helpers: `lookup` (`:435`), `readVault` (prefers `cachedRead`,
  `:442`), `createVault` (`:448`), `modifyVault` (`:453`), and
  `deleteVault` (tries trash, then delete, `:458`).

Runtime and persistence wiring:

- `makeRuntimeJournal(vault, undoEntries, persistAdapter)`
  (`src/domain/ConversationRuntime.ts:130-148`) builds
  `new UndoJournal(vault, {initialEntries, persist, loadOptions: {ttlMs: UNDO_TTL_MS}})`.
- `PersistAdapter { onJournalOp(op, entry) }` (`ConversationRuntime.ts:86-94`).
- `ConversationManager.makePersistAdapter` (`src/domain/ConversationManager.ts:734-771`):
  - `"add"` calls `store.recordUndo(convId, {id, kind, scope, path, before, after, recordedAt, undone})`
    with fields listed explicitly (`:741-750`).
  - `"mark-undone"` calls `store.markUndone` (`:752`).
  - `"evict"` calls `store.removeUndoEntry` (`:761`).
- `src/persistence/ConversationsStore.ts`:
  - Constants: `UNDO_TTL_MS` (`:98`), `UNDO_MAX_ENTRIES = 50` (`:100`),
    `SIZE_WARN_BYTES = 5 MB` (`:107`).
  - `recordUndo` (`:300-321`); `markUndone` with immediate flush
    (`:323-344`); `removeUndoEntry` (`:354-364`); `pruneOnLoad`
    (`:375-392`).
  - `cloneConversation` (`:544+`) shallow-copies undo entries `{...e}`
    (`:555`) and tool calls `{...tc}` (`:553`).
- `src/persistence/PersistedShape.ts`:
  - `PersistedMessage.toolCalls` items (`:28-40`): `id`, `kind`, `name`,
    `source`, `outcome`, `detail`, `argsPreview`, `resultContent`,
    `undoId`, `undone`.
  - `PersistedUndoEntry` (`:52-61`) mirrors `UndoEntry`.
  - `PersistedConversation` (`:99-132`).
  - `CURRENT_SCHEMA_VERSION = 2` (`:141`).
- `src/persistence/migrate.ts`:
  - `migrate` (`:48-99`): v1→v2 upcast at `:60-80`; an unknown version
    returns `recovered` (`:82-88`).
  - `validateConversation` (`:142-210`): any invalid message or undo
    entry returns null, and the conversation is recovered (dropped)
    (`:175-186`).
  - `validateMessage` tool calls (`:269-308`) copies only known fields
    (`:287-305`); unknown fields are dropped.
  - `validateUndoEntry` (`:313-331`) requires `kind` to be one of
    create/modify/delete (`:317`) and returns null otherwise.
- Hydration back into UI state: `hydrateChatState`
  (`ConversationRuntime.ts:101-123`) maps the same tool-call fields
  explicitly.

**Tests**:

- `src/domain/UndoJournal.test.ts` (165 lines): `makeFakeVault` (`:6-27`)
  with `getFileByPath`, `read`, `cachedRead`, `create`, `modify`, and
  `trash` over a `Map`.
- `UndoJournal.persistence.test.ts` (272 lines; describes at `:57-240`):
  add, mark-undone, evict ordering, hydration, a throwing persist
  callback, the cap, and the id counter.
- `UndoJournal.crossRestart.test.ts` (221 lines): TTL (`:39`) and
  divergence for each kind (`:99-207`).
- `src/persistence/migrate.test.ts` (360 lines): "strips unknown
  tool-call fields" (`:123`), the v1→v2 upcast (`:187`), and the
  safetyGrants round-trip (`:348`).
- `src/domain/ConversationRuntime.test.ts` (155 lines):
  `hydrateChatState` (`:41`) and `makeRuntimeJournal` (`:88`).

### 7. Undo UI and tool-call rendering

`src/ui/undoFlow.ts`:

- `UndoFlowResult` (`:24-29`). Deps are
  `{ journal?; confirm(title, message, confirmLabel); notify(msg) }`
  (`:31-37`).
- `runUndoFlow(undoId, deps)` (`:39-67`) calls `journal.undo(id)`. On a
  divergence it calls `confirm("Undo with divergence",
  divergenceConfirmMessage(divergence, entry.path), "Revert anyway")`
  and retries with `{force: true}`.
- `divergenceConfirmMessage(divergence, path)` (`:73-85`) takes a single
  path.
- Tests: `src/ui/undoFlow.test.ts` (152 lines). The flow describe is at
  `:49`; the message describe is at `:136`.

`src/ui/ChatView.ts`:

- `ChatViewDeps` (`:55-117`): `manager`, `auth`, `openSettings`,
  `getExposeRawFsTools`, `modelCatalog`, and optional
  `readinessGateBus`, `snapshotPendingMcp`, and `mcpServerName`. The
  constructor (`:276-287`) copies these fields. `bindActiveRuntime`
  (`:294-318`) caches `runtime.state`, `runtime.session`, and
  `runtime.journal`.
- `onOpen` builds `MessageRenderer` (`:426-430`) and
  `setToolCallHandlers` (`:435-474`): `onApprove`, `onApproveForSession`,
  `onReject`, `onUndo → handleUndoClick` (`:445`), `isUndoSuppressed`
  (raw-FS names when startup expose is off, `:453-456`), and
  `onOpenLink`. `onClose` (`:853-869`) unsubscribes listeners and
  disposes the renderer.
- Stream loop (`:1226-1344`) over `session.sendMessageStreaming(text, …)`:
  - `setStreaming(true)` is called before the loop (`:1221`).
  - Tool calls are attributed to segments through `toolOwner`/`toolTarget`
    (`:1209-1217`).
  - `tool_call_start` → `state.upsertToolCall(target, {id, kind, name, source, outcome, detail, argsPreview, resultContent, approval})`
    (`:1271-1284`).
  - `tool_call_complete` → `extractUndoId(ev.content)`, then upsert
    `{id, kind:"tool", outcome, resultContent, detail: errorMessage, undoId}`
    (`:1285-1299`).
  - `approval_prompt` (`:1300-1319`), `approval_resolved` (`:1320-1339`),
    `complete` (`:1340-1343`).
- The final tool-call merge happens at `:1419-1424`. `persistSegment`
  is at `:1463-1499`.
- `handleUndoClick(undoId)` (`:1847-1889`) runs `runUndoFlow` with a
  confirm modal and `Notice`, then upserts `undone: true` and persists
  the tool calls.
- `extractUndoId(content)` (`:1901-1912`) parses the content as JSON and
  returns `undoId` when `ok === true` and `undoId` is a string.
- `toPersistedToolCalls` (`:1921-1951`) skips `pending_approval`, lists
  the fields explicitly, and applies `sanitizePersistedMcpText`.
- `ChatState.upsertToolCall` (`src/domain/ChatState.ts:161-182`) merges
  `{...existing, ...patch}` by id.

`src/ui/ToolCallBlock.ts`:

- `ToolCallBlockHandlers` (`:15-39`).
- The pure helper `shouldRenderUndoButton(call, handlers)` (`:46-57`)
  returns true only when all of these hold: outcome is `completed`,
  `undoId` is set, source is not `mcp`, the call is not undone, an
  `onUndo` handler exists, and `isUndoSuppressed(name)` is false.
- `renderToolCallBlock` (`:81-183`):
  - It is a `<details>` element. The summary contains the icon, name,
    source label, and status pill (`statusText`, `:305-320`).
  - It shows either an Undo button or a "reverted" span (`:125-142`).
  - The body (`:146-181`) shows Arguments (`argsPreview`), Result
    (`resultContent`, or search-match rendering through
    `parseSearchToolResult`), an Error section (`detail` on
    errored/denied), "Running…" for approved calls, and the approval
    prompt.
  - No other per-call extra-info section exists.
- `renderApprovalPrompt` (`:185-242`):
  - The headline is `approval.summary` (`:194-195`).
  - The detail `<pre>` uses `truncateMcpText` for MCP calls and
    `truncate(detail, 4000)` otherwise (`:198-206`). The local
    `truncate` (`:275-277`) appends `… (N more bytes)`.
  - Help text and buttons follow (Approve Once, Approve for Session
    unless `canOfferSession === false`, and Reject).
- `makeLabeledPre` (`:261-273`) truncates every section through
  `truncateMcpText` (4096 chars plus a marker,
  `src/sdk/approvalText.ts:1-10`).
- `src/ui/MessageRenderer.ts`: `renderToolCalls` (`:240-248`) rebuilds
  all blocks when the signature changes. `toolCallsSig` (`:338-350`)
  includes the id, outcome, source, the lengths of
  resultContent/detail/argsPreview/approval.summary, `undoId`, and
  `undone`. A new rendered field outside that list does not trigger a
  re-render on its own.
- Tests: `src/ui/ToolCallBlock.test.ts` (129 lines) is DOM-free. It
  covers `shouldRenderUndoButton` (describe at `:29`, cases at `:30`
  and `:62-126`) and the MCP `approvalText` helpers (describe at
  `:34`, cases at `:35-55`).

### 8. AgentSession permission and stream plumbing (`src/sdk/AgentSession.ts`)

- `AssistantToolCall` (`:28-59`): `id`, `kind`, `name?`,
  `source?: custom|mcp|builtin`, `outcome`, `detail?`, `argsPreview?`,
  `resultContent?`, and `approval?{summary, detail?, canOfferSession}`.
- The safety dependency, `AgentSessionOptions.safety` (`:82-102`), is
  `{ config(): SafetyConfig; state: SafetyState; extractVaultPath?(req): string | undefined; getMcpToolSourceMetadata?(req) }`.
  `extractVaultPath` returns a single path.
- `StreamEvent` (`:233-275`):
  - `delta`
  - `tool_call_start{toolCall}`
  - `tool_call_complete{id, outcome, content?, errorMessage?}`
  - `approval_prompt{toolCall}`, `approval_resolved{id, choice}`
  - `follow_up_consumed`
  - `complete{content, toolCalls}`
- Turn boundaries in `sendMessageStreaming(text, options)` (`:864+`):
  - **Start**: `isStreamingFlag = true`, `toolCallsThisTurn = []`, and
    `currentStreamPush = push` (`:884-918`).
  - **End**: the terminal `yield {type:"complete"}` (`:1441-1447`),
    followed by a `finally` block (`:1448+`) that clears the timer,
    unsubscribes, sets `currentStreamPush = null`, and cancels pending
    approvals.
  - `session.idle` (`:1264-1271`) sets `idleSeen` and wakes the loop.
  - There are no separate turn-start/turn-end callbacks or events
    besides the stream's own start and `complete`.
- SDK tool events:
  - `tool.execution_start` (`:1130-1170`): `d.toolCallId`, `d.toolName`,
    `d.arguments`, and `d.mcpServerName`. The source comes from
    `classifyToolSource` (`:2787-2800`): MCP synthetic id → `mcp`;
    `customToolNames.has(name)` or `kind === "custom-tool"` → `custom`;
    otherwise `builtin`. It pushes `tool_call_start` with a copy of the
    turn's record.
  - `tool.execution_complete` (`:1175-1234`): `d.success`, `d.error`,
    and `d.result?.detailedContent ?? d.result?.content`. It pushes
    `tool_call_complete{id, outcome, content, errorMessage}`.
  - Event typings are at `:3055-3075`.
- Permission entry (`:2280-2341`) builds
  `normalised {kind, toolName, raw}` and
  `toolCallId = request.toolCallId ?? request.id ?? generated`. It
  classifies the source and calls `previewArgs` (`:2803-2835`). For
  custom tools that preview is `JSON.stringify(args)` truncated to 200
  chars (`stringifyArgsForPreview`, `:2920-2928`). When `opts.safety`
  is set it delegates.
- `handlePermissionViaSafetyPolicy` (`:2355-2547`):
  1. Short-circuits on `resolvedApprovals`.
  2. Calls `buildSafetyInput` and `decideSafety`.
  3. **Rejected** → `recordRejection` (`:2603`).
  4. **Auto-apply** → upserts an `approved` call with
     `detail: decision.reason`, pushes `tool_call_start`, and returns
     `approve-once` (`:2403-2423`).
  5. **Require-approval** → `buildApprovalSummary` and
     `buildApprovalDetail`, a `pending_approval` call, the
     `approval_prompt` event, and an await on the deferred (`:2425-2463`).
  6. After the choice: `approval_resolved`, then cancellation or
     rejection handling and MCP revalidation.
  7. `approve-for-session` grants by source: `vault` →
     `state.grantVault()`, plus extra-vault, mcp, and builtin
     (`:2517-2542`). The SDK always receives `approve-once`.
- `buildSafetyInput` (`:2556-2592`): when
  `kind === "custom-tool" && isVaultWriteToolName(toolName)`, it returns
  `{source:"vault", toolName, vaultRelativePath: extractVaultPath(req) ?? args.path}`
  (`:2563-2574`). MCP requests go through `getMcpToolSourceMetadata`
  (`:2576-2585`). Everything else becomes `builtin`, keyed by kind or by
  custom tool name (`:2589-2591`).
- `buildApprovalSummary(request, input)` (`:2842-2871`) returns
  `` `${toolName} ${vaultRelativePath}` `` for vault calls that have a
  path, otherwise a string per kind (`custom-tool` → the tool name).
- `buildApprovalDetail(request)` (`:2874-2897`) returns
  `safeJson(request.args)` (`JSON.stringify(v, null, 2)`) for
  `custom-tool`.
- `SdkPermissionRequest` (`:3182-3204`): `toolCallId?`, `kind?`,
  `toolName?`, `args?: Record<string, unknown>`, …,
  `canOfferSessionApproval?`. Custom tool args arrive as `request.args`,
  already parsed into an object.
- Tests: `src/sdk/AgentSession.test.ts` (3387 lines).
  - `makeFakeSdk` (`:54`) exposes `permissionHandler`. `makeAgent` is at
    `:143`.
  - The SafetyPolicy describe (`:1375+`) uses `makeSafetyAgent(handles, overrides)`
    (`:1376-1408`) with `safety: {config, state, getMcpToolSourceMetadata}`
    and no `extractVaultPath`.
  - The vault-write classification test iterates a hardcoded list that
    includes `update_task` (`:2079-2101`) and expects `approve-once`.

### 9. SafetyPolicy (`src/domain/SafetyPolicy.ts`)

- `SafetySource = "vault" | "extra-vault" | "mcp" | "builtin"` (`:19`);
  `SafetyMode` (`:21`); `SafetyDecision` (`:23`);
  `SafetyDecisionResult {decision, reason}` (`:25-29`).
- `SafetyPolicyInput` (`:34-48`): `source`, `toolName?`, `mcpServerId?`,
  `mcpToolName?`, `mcpTrustEpoch?`, `vaultRelativePath?` (a single
  string), and `extraVaultRoot?`.
- `SafetyConfig` (`:50-59`): `fsDefaultMode`, `vaultAllowlist: string[]`,
  `builtinAutoApprove`, and `mcpAutoApprove?`.
- `SafetyState` (`:73-167`): `grantVault`, `grantExtraVault`,
  `grantMcp`, `grantBuiltin`, matching `is*Granted` methods, `clear`,
  `snapshot`, and an `onChange` persist callback. The vault grant is
  one boolean for the whole vault.
- `normaliseAllowlistEntry(raw)` (`:170-186`) trims, rejects drive and
  UNC paths, converts `\`→`/`, strips leading and trailing slashes, and
  rejects `..`.
- `isVaultPathAllowlisted(path, allowlist)` (`:189-201`) matches when
  `target === entry` or `target.startsWith(entry + "/")`.
- `decideSafety(input, config, state)` (`:211-326`). For the vault case
  (`:227-253`), it checks in order: session grant, then the allowlist
  for `vaultRelativePath` (skipped if undefined), then default mode
  auto-apply, otherwise require-approval.
- Tests: `src/domain/SafetyPolicy.test.ts` (279 lines). Describes cover
  `normaliseAllowlistEntry` (`:27`), `isVaultPathAllowlisted` (`:45`),
  the vault source (`:66-102`), mcp (`:104`), builtin (`:205`),
  `clear` (`:236`), and persistence (`:251`).

### 10. `main.ts` wiring

- Imports (`:1-63`), including `MarkdownView`, `Notice`, and `Plugin`
  from `obsidian`.
- `onload` (`:301-320`) registers the settings tab, then
  `workspace.onLayoutReady(() => completeDeferredInit())` (`:322+`).
- Values set up here:
  - `pluginDataDir = \`${this.app.vault.configDir}/plugins/${this.manifest.id}\`` (`:360`)
  - `exposeRawFsToolsAtStartup` (`:402-403`), `vaultRoot` (`:404-406`),
    `liveRuntimes` (`:407-410`)
  - `obsidianApi = new ObsidianApi({...})` (`:509-556`): `vault`; a
    workspace wrapper with `getActiveFile`, `getActiveViewOfType`,
    `getLeaf`, and `markdownViewSymbol: MarkdownView`; `metadataCache`;
    `internalPlugins`; and `plugins`. `fileManager` is not passed in.
  - `now` (`:558`)
- `runtimeFactory(metadata, hydration, persistAdapter)` (`:642-906`):
  1. `journal` (`:654-658`).
  2. The tool factories receive `this.app.vault` and `this.app.workspace`
     cast to the narrow interfaces (`:660-695`).
  3. `vaultTools` (`:696-706`).
  4. `safetyState` (`:714-716`).
  5. `new CopilotAgentSession({...})` (`:718-846`), which receives
     `tools: vaultTools` (`:772`) and the `safety` object (`:789-829`).
     - `extractVaultPath` (`:806-828`) special-cases `create_daily_note`,
       `insert_into_active_note`, and `create_task`, then falls back to
       `args.path`.
     - The `preamble` closure (`:830-845`) calls `assemblePreamble({mode, vaultRootAbsPath, timezone, todayInTimezone, customBody, excludeRawFs, mcp})`.
  6. The runtime object (`:873-905`).
- `registerChatView(this, {manager, auth, getExposeRawFsTools, modelCatalog, openSettings, readinessGateBus, snapshotPendingMcp, mcpServerName})`
  (`:1104-1142`). In `src/ui/ChatViewRegistration.ts`, the deps
  interface is at `:7-37` and `new ChatView(leaf, deps)` is at `:43-46`.
- Event registration patterns:
  - `this.register(unsubscribe)` (`:479`).
  - `workspace.on("quit", …)` with `offref` through `this.register`
    (`:1151-1161`).
  - No `registerEvent`, no `vault.on(...)`, and no `fileManager` use
    anywhere in `src/` (grep).
- `getActiveViewOfType` is used only through the `ObsidianApi`
  workspace wrapper (`ObsidianApi.ts:576-592`, `:792-794`).
  `workspace.activeEditor` is not used.

### 11. Test fakes

- `src/test/obsidianMock.ts` (198 lines), aliased as `obsidian` in
  vitest, exports `ItemView`, `Plugin` (`register`, `addSettingTab`,
  `loadData`, `saveData`), `PluginSettingTab`, `Setting` and its
  components, `Notice`, `Modal`, `setIcon`, `Menu`, an empty
  `MarkdownView`, `FileSystemAdapter`, `App = unknown`,
  `prepareSimpleSearch`, and `prepareFuzzySearch`.
  - It has **no** `TFile`, `TFolder`, `TAbstractFile`, `Vault`,
    `FileManager`, `Events`, `registerEvent`, or `EventRef`.
- Per-suite in-memory vaults (no shared fake module):
  - `src/tools/WriteTools.test.ts:33-115` (`makeVault`):
    - `Map<path, content>` mirrored to a real temp directory (`:22-27`).
    - `getFileByPath`, `getAbstractFileByPath`, `getMarkdownFiles`,
      `getFiles`, `read`, `cachedRead`, `create` (throws if the file
      exists), `modify`.
    - Per-path chained `process` with in-flight and call-count probes
      (`:76-97`), and `trash`.
    - No `createFolder`, `rename`, or folder objects.
  - `src/tools/UpdateTask.test.ts:27-108` and
    `src/tools/WriteNoteTools.test.ts:47-178`: the same pattern, with
    `AppLike` plus `ObsidianApi`. The WriteNoteTools fake adds
    `getActiveViewOfType` and `markdownViewSymbol`.
  - `src/domain/UndoJournal.test.ts:6-27`: a minimal `UndoJournalVault`
    with no `rename`.
- Not present in any fake: `fileManager.renameFile`, `vault.rename`,
  `createFolder` (optional in the interface but not implemented in
  fakes), `TFolder`/children, `metadataCache.resolvedLinks`
  (`ObsidianApi` tests supply it ad hoc through `AppLike.metadataCache`,
  `ObsidianApi.ts:147-148`), and vault event emitters.

### 12. Obsidian API typings (`node_modules/obsidian/obsidian.d.ts`, package version 1.13.0)

- `App.fileManager: FileManager` — `:440`.
- `Component.registerEvent(eventRef: EventRef): void` — `:1895`
  (`register(cb)` at `:1889`).
- `interface EventRef` — `:2769`; `Events.offref(ref)` — `:2793`.
- `class FileManager` — `:2850`:
  - `getNewFileParent` (`:2862`)
  - `renameFile(file: TAbstractFile, newPath: string): Promise<void>` —
    `:2871`. Its doc comment says it renames or moves a file safely and
    updates all links to it according to the user's preferences.
  - `trashFile(file)` — `:2889`.
- `class MetadataCache extends Events` — `:4362`;
  `resolvedLinks: Record<string, Record<string, number>>` — `:4396`;
  `unresolvedLinks` — `:4402`.
- `TAbstractFile` — `:6845`; `TFile` — `:7021`; `TFolder` — `:7044`.
- `class Vault extends Events` — `:7229`:
  - `configDir: string` — `:7242`
  - `getFileByPath` — `:7259`, `getFolderByPath` — `:7268`,
    `getAbstractFileByPath` — `:7277`
  - `createFolder(path): Promise<TFolder>` — `:7312` (throws if the
    folder exists, since 1.4.0)
  - `rename(file, newPath)` — `:7366`
  - `process(file, fn, options?): Promise<string>` — `:7418`
  - `on('create', (file: TAbstractFile) => any)` — `:7466` (the docs say
    it also fires for every existing file on vault load unless
    registered inside `onLayoutReady`)
  - `on('modify')` — `:7472`, `on('delete')` — `:7478`,
    `on('rename', (file, oldPath) => any)` — `:7484`
- `Workspace.activeEditor: MarkdownFileInfo | null` — `:7722`;
  `getActiveViewOfType<T extends View>(type: Constructor<T>): T | null`
  — `:7897`.

### 13. Docs touchpoints

- README: the tool list is at `README.md:181-183` (v0.2 section). The
  "What's new" sections run newest first, starting at `:38`
  (v0.10). Undo is described at `:166` and `:269`, and the safety model
  at `:255-273`.
- CHANGELOG conventions are covered in Documentation System above.
- `proposals/README.md` Index is at `:29-44`; the next free number is
  0013.

## Code References

- `src/domain/PreambleAssembler.ts:46-52` - `PREAMBLE_PLACEHOLDERS`
- `src/domain/PreambleAssembler.ts:62` - `MAX_DEFAULT_PREAMBLE_BYTES = 8 * 1024`
- `src/domain/PreambleAssembler.ts:85-90` - `AUTHORING_CONVENTIONS_BLOCK` (Editing tasks bullet at `:90`)
- `src/domain/PreambleAssembler.ts:98-134` - `assemblePreamble` (custom `:106-120`, default `:123-133`)
- `src/domain/PreambleAssembler.ts:158-188` - `buildToolInventoryBlock`
- `src/domain/PreambleAssembler.test.ts:80-98,352-357` - byte-size bound tests
- `src/domain/PreambleAssembler.test.ts:100-119` - manifest↔inventory lockstep
- `src/domain/PreambleAssembler.test.ts:208-248` - placeholder substitution tests
- `src/settings/SettingsTab.ts:366-375` - placeholder list in settings UI
- `src/domain/vaultToolManifest.ts:108-144` - `WRITE_NOTE_TOOL_ENTRIES`
- `src/domain/vaultToolManifest.ts:210-234` - `ALL_VAULT_TOOL_ENTRIES`, `WRITE_NOTE_TOOL_NAMES`
- `src/main.toolGating.test.ts:32-40,97-109` - hardcoded VAULT_WRITE list, manifest invariant
- `src/tools/UpdateTask.ts:48-95` - input, patch, and result types
- `src/tools/UpdateTask.ts:99-199` - `updateTaskImpl`
- `src/tools/UpdateTask.ts:201-402` - private `validatePatch` / `identifyTargetLine` / `applyPatch`
- `src/tools/TaskFormat.ts:105-137,163` - `formatTaskLine`, `parseTaskLine`
- `src/tools/FindTasks.ts:48-54` - `FindTasksHit`
- `src/tools/WriteTools.ts:19-46` - `WriteToolsVault`
- `src/tools/WriteTools.ts:160-179` - `hasUnsavedEditorChanges`
- `src/tools/WriteTools.ts:260-266,302-430` - `ProcessAbort`, `processFileImpl`
- `src/tools/WriteTools.ts:145,239,384,422,479` - `undoJournal.record` call sites
- `src/tools/WriteTools.ts:605-616` - `VAULT_WRITE_TOOL_NAMES`, `isVaultWriteToolName`
- `src/tools/VaultPath.ts:56-162` - `resolveVaultPath`, `toVaultRelative`, `lookupTFile`
- `src/tools/WriteNoteTools.ts:36-73` - deps and result shapes
- `src/tools/WriteNoteTools.ts:699-993` - `createWriteNoteTools` (`update_task` at `:887-991`)
- `src/domain/UndoJournal.ts:29-138` - types, vault interface, persist ops, cap
- `src/domain/UndoJournal.ts:206-225,246-386` - `record`, `undo`
- `src/domain/ConversationRuntime.ts:86-148` - `PersistAdapter`, `hydrateChatState`, `makeRuntimeJournal`
- `src/domain/ConversationManager.ts:734-771` - `makePersistAdapter`
- `src/persistence/ConversationsStore.ts:300-392` - undo store ops
- `src/persistence/PersistedShape.ts:28-61,141` - persisted tool call and undo entry, schema version
- `src/persistence/migrate.ts:142-210,269-331` - conversation, message, and undo validation
- `src/domain/types.ts:22-70` - `ToolCall`
- `src/ui/ChatView.ts:55-117,276-318` - deps, constructor, runtime binding
- `src/ui/ChatView.ts:1226-1344` - stream loop
- `src/ui/ChatView.ts:1847-1951` - `handleUndoClick`, `extractUndoId`, `toPersistedToolCalls`
- `src/ui/undoFlow.ts:39-85` - `runUndoFlow`, `divergenceConfirmMessage`
- `src/ui/ToolCallBlock.ts:46-57` - `shouldRenderUndoButton`
- `src/ui/ToolCallBlock.ts:185-242,275-277` - approval prompt and 4000-char truncate
- `src/ui/MessageRenderer.ts:338-350` - `toolCallsSig`
- `src/sdk/AgentSession.ts:82-102` - `safety` options
- `src/sdk/AgentSession.ts:233-275` - `StreamEvent`
- `src/sdk/AgentSession.ts:884-918,1441-1457` - stream start and end
- `src/sdk/AgentSession.ts:1130-1234` - tool start and complete event mapping
- `src/sdk/AgentSession.ts:2355-2547` - `handlePermissionViaSafetyPolicy`
- `src/sdk/AgentSession.ts:2556-2592` - `buildSafetyInput`
- `src/sdk/AgentSession.ts:2842-2897` - `buildApprovalSummary`, `buildApprovalDetail`
- `src/domain/SafetyPolicy.ts:34-59,189-201,211-326` - input and config, allowlist match, `decideSafety`
- `src/main.ts:642-906` - `runtimeFactory`
- `src/main.ts:789-829` - safety deps, `extractVaultPath`
- `src/main.ts:1104-1161` - ChatView registration, `quit` event pattern
- `src/test/obsidianMock.ts:1-198` - obsidian module mock
- `node_modules/obsidian/obsidian.d.ts:2871,4396,7312,7418,7466-7484,7722,7897` - relevant typings
- `src/release/changelog.ts:57-110` - CHANGELOG stub and Unreleased normalization
- `proposals/README.md:29-44` - proposals index

## Architecture Documentation

- **Tool definition pattern.** Each factory
  (`createWriteTools`, `createWriteNoteTools`, …) returns
  `defineTool(name, {description, parameters: <JSON Schema>, handler: async (args: unknown) => Impl(...), skipPermission?})`.
  - Handlers coerce `args` leniently and delegate to an exported,
    unit-testable `*Impl(input, deps)` that returns a discriminated
    `{ok: true, …} | {ok: false, …}` object.
  - Impls take a `deps` object (`vault`, `workspace`, `undoJournal`,
    `api`, `now`, `vaultAwareness`), so tests inject in-memory fakes.
- **Write primitive layering.** Impls validate paths with
  `resolveVaultPath` → `toVaultRelative` → `lookupTFile`. They then
  write through `createFileImpl`, `editFileImpl`, `processFileImpl`, or
  `deleteFileImpl`, or through the `ObsidianApi` methods, and record
  undo entries. Each primitive records **one** `UndoEntry` for one path.
  `processFileImpl` gives an atomic per-file read-modify-write;
  `ProcessAbort` aborts without a write or record.
- **Three registries of tool names, kept separately.**
  - The manifest (`vaultToolManifest.ts`) drives the preamble inventory.
  - The `defineTool` names inside factories drive SDK registration and
    `customToolNames`.
  - `VAULT_WRITE_TOOL_NAMES` (`WriteTools.ts:605-613`) drives safety
    classification.
  - Tests check pieces of this pairwise:
    `PreambleAssembler.test.ts:100-119`, `ReadNoteTools.test.ts:386-390`,
    `main.toolGating.test.ts:97-109`, and `AgentSession.test.ts:2079-2101`.
- **Permission flow.** The SDK calls `onPermissionRequest(request)`.
  AgentSession builds a `SafetyPolicyInput`, and the pure
  `decideSafety` returns auto-apply, require-approval, or rejected. The
  UI events are `tool_call_start`/`approval_prompt` →
  `approval_resolved`. The SDK runs the handler; then
  `tool.execution_complete` produces `tool_call_complete{content: JSON}`,
  and ChatView extracts `undoId`. Session grants live in a per-conversation
  `SafetyState` that is persisted with the conversation.
- **Persistence of tool-call metadata.** Every layer lists fields
  explicitly: domain `ToolCall` → ChatView `toPersistedToolCalls` →
  `PersistedMessage.toolCalls` → `migrate.validateMessage` (unknown
  fields dropped) → `hydrateChatState`. Undo entries go through
  `UndoJournal.record` → `PersistAdapter.onJournalOp` →
  `ConversationManager.makePersistAdapter` → `ConversationsStore.recordUndo`
  → `migrate.validateUndoEntry` (a strict kind enum; an invalid entry
  makes the whole conversation fail validation).
- **Pure-module + DOM-free tests convention.** Logic is moved out of the
  UI into pure helpers (`shouldRenderUndoButton`, `runUndoFlow`,
  `divergenceConfirmMessage`, `chatKeydown`, `priorContextExcerpt`) and
  tested in the vitest `node` environment
  (`.github/copilot-instructions.md`, "Test environment").
- **Event subscription lifecycle.** The plugin uses `this.register(cb)`
  together with `workspace.on("quit")`/`offref`
  (`src/main.ts:479`, `:1151-1161`). ChatView unsubscribes in
  `onClose` (`ChatView.ts:853-869`). No vault event subscriptions exist
  today.

## Open Questions

None are blocking. The following points come from observation and are
recorded for planning:

- The `obsidianMock` exports no `TFile` or `TFolder` classes, and no
  test vault fake implements `rename`, `createFolder`,
  `fileManager.renameFile`, or event emitters. Any `instanceof TFolder`
  check would need a mock class.
- `update_task`'s handler strips unrecognized enum values before
  `validatePatch` runs (`WriteNoteTools.ts:964-979`), so
  `invalid_priority` and `invalid_status` are only reachable by calling
  `updateTaskImpl` directly.
