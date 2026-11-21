# Vault Tool-First Writes Implementation Plan

## Overview
Make shell-based vault mutation unnecessary and less tempting, without blocking it. Four parts:
1. Add batch-capable vault tools: `update_tasks`, `move_note` and `bulk_edit`. Each takes one approval with a human-readable preview and records one atomic Undo entry.
2. Add a hard "Vault writes" rule to the preamble.
3. Show a non-blocking warning on a shell or MCP tool call when vault files change while it runs and the plugin's own tools did not cause the change.
4. Make no change to how shell permissions are decided (Spec FR-044).

## Current State Analysis
Facts from CodeResearch.md:
- **Undo journal.** `UndoJournal` stores only single-path entries of kind `create | modify | delete` (`src/domain/UndoJournal.ts:29-47`). Its vault interface has no rename (`:87-96`).
  - Persistence lists every field explicitly at each layer: `PersistedUndoEntry` (`src/persistence/PersistedShape.ts:52-61`), `validateUndoEntry` (`src/persistence/migrate.ts:313-331`, which rejects unknown kinds and drops the whole conversation), `makePersistAdapter` (`src/domain/ConversationManager.ts:734-771`) and `ConversationsStore.recordUndo` (`:300-321`).
- **Write primitive.** `processFileImpl` (`src/tools/WriteTools.ts:302-430`) gives an atomic per-file read-modify-write that can be aborted with `ProcessAbort`. It always records its own `modify` entry.
- **`update_task` helpers.** `validatePatch`, `identifyTargetLine` and `applyPatch` are private in `src/tools/UpdateTask.ts:201-402`.
- **Tool names live in three registries:**
  - the manifest, which feeds the preamble (`src/domain/vaultToolManifest.ts`);
  - the factory `defineTool` names (`src/tools/WriteNoteTools.ts:699-993`);
  - `VAULT_WRITE_TOOL_NAMES`, which drives safety classification (`src/tools/WriteTools.ts:605-616`, `src/sdk/AgentSession.ts:2563`).

  Some tests hardcode write-tool lists: `src/main.toolGating.test.ts:32-40` and `src/sdk/AgentSession.test.ts:2079-2101`.
- **Safety is single-path.**
  - `SafetyPolicyInput.vaultRelativePath` (`src/domain/SafetyPolicy.ts:34-48`) and the `extractVaultPath` hook (`src/main.ts:806-828`) each carry one path.
  - The approval summary is the tool name plus that path, and the detail is pretty-printed args JSON (`AgentSession.ts:2842-2897`). The UI truncates the detail at 4000 characters (`src/ui/ToolCallBlock.ts:198-206`).
- **Not present yet.** There are no vault event listeners and no `fileManager` usage (`src/main.ts` grep). The obsidian mock has no `TFile` or `TFolder` (`src/test/obsidianMock.ts`), and no test fakes implement `rename` or `createFolder`.
- **Tool-call fields are listed explicitly** in `ToolCall` (`src/domain/types.ts:22-70`), `PersistedMessage.toolCalls`, `validateMessage` (`migrate.ts:287-305`), `hydrateChatState` (`src/domain/ConversationRuntime.ts:101-123`), `toPersistedToolCalls` (`src/ui/ChatView.ts:1921-1951`) and `toolCallsSig` (`src/ui/MessageRenderer.ts:338-350`).
- **Preamble size.** The default preamble is about 6.9 KB against `MAX_DEFAULT_PREAMBLE_BYTES = 8 KB` (`src/domain/PreambleAssembler.ts:62`). Placeholders are substituted with chained `replaceAll` (`:106-120`). The settings UI enumerates placeholders by hand (`src/settings/SettingsTab.ts:366-375`).

## Desired End State
- `update_tasks`, `move_note` and `bulk_edit` are registered in the manifest, the factory and `VAULT_WRITE_TOOL_NAMES`, and a test enforces that the three stay in sync.
  - Each validates all inputs before writing, rolls back on a failure during writing, and records exactly one batch Undo entry.
  - Each shows a preview approval whose summary carries the scale (FR-010–FR-043).
- Batch Undo entries undo atomically and persist across reloads. Divergence prompts name the affected paths (FR-050–FR-053).
- The default preamble contains the hard rule and the updated guidance, and `{{VAULT_WRITE_RULES}}` works in custom mode. The size bound is 10 KB (FR-001–FR-005).
- A pure `VaultChangeDetector` attributes out-of-band vault events to running builtin or MCP tool calls. The warning renders on that tool call and persists (FR-060–FR-065).
- README, CHANGELOG `[Unreleased]`, proposal 0013 and Docs.md are updated.
- Verification: `npm test` is green and `npx tsc --noEmit` is clean at every phase.

## What We're NOT Doing
- Any shell guard. No rejection, approval gating or classification change for shell or builtin requests (FR-044).
- Sending detected out-of-band changes to the model.
- Per-target patches in `update_tasks`, and the description-substring fallback for it.
- Operation-aware (line-level) undo (proposal 0012).
- Standalone folder create or delete tools. Removing folders created during a move on undo.
- Bumping the persistence schema version. The new fields are additive optional fields on v2.
- Cutting a release or editing versions.

## Phase Status
- [x] **Phase 1: Batch undo entries** - Journal batch kind (modify/create/delete/move items) with atomic divergence check, forced undo and rollback, plus persistence, migration and batch-aware undo-flow wording. Also adds proposal 0013.
- [x] **Phase 2: `update_tasks` + multi-path safety + approval previews** - Batch write primitive, the batch task tool, registry lockstep, the multi-path allowlist and the preview hook.
- [x] **Phase 3: `move_note`** - Link-aware batched move/rename through `fileManager.renameFile`, with folder creation, validation, rollback, journal move undo and preview.
- [x] **Phase 4: `bulk_edit`** - Literal/regex find-replace across notes, with preview, rollback and a single undo entry.
- [ ] **Phase 5: Out-of-band change warning** - Pure detector, plugin vault-event wiring, self-write exclusion, the tool-call warning UI and persistence.
- [ ] **Phase 6: Preamble hard rule** - Rule block, placeholder, updated guidance, 10 KB bound and settings text.
- [ ] **Phase 7: Documentation** - Docs.md, README, CHANGELOG `[Unreleased]` and the proposal 0013 index.

## Phase Candidates
- (none yet)

Phase dependencies: Phase 2 depends on Phase 1. Phases 3 and 4 depend on Phases 1 and 2. Phase 5 has no dependencies. Phase 6 depends on Phases 2–4, because the guidance names the new tools. Phase 7 depends on all earlier phases.

---

## Phase 1: Batch undo entries

### Changes Required
- **`src/domain/UndoJournal.ts`**:
  - Add `UndoKind` `"batch"` and an `UndoBatchItem` union: `{op:"modify", path, before, after}`, `{op:"create", path, after}`, `{op:"delete", path, before}` and `{op:"move", from, to}`.
  - `UndoEntry` gains an optional `items` and an optional `label`, a short human summary such as "8 tasks in 3 notes". For batch entries, `path` is the first item's path; for move items that is the destination (`to`).
  - `hydrate()` and the TTL ghost entry in the constructor (`UndoJournal.ts:170-180`, `:396-422`) copy fields one by one, so they must also copy `items` and `label`. Otherwise batch entries lose their items on reload (SC-007).
  - Add an optional `moveItem(from, to)` capability to `UndoJournalVault`, or as a journal option. Production wires it to `fileManager.renameFile` in Phase 3. Without it, undoing a batch that contains move items fails cleanly.
  - `undo()` for batch entries:
    1. Check divergence on every item without changing anything, and record each item's observed current state (content, or present/absent):
       - modify: the file is missing, or its content ≠ `after`;
       - create: the file is missing or its content differs;
       - delete: a file now exists;
       - move: `to` is missing, or `from` is occupied.
    2. Without `force`, any divergence returns `divergence` and a new `divergentPaths: string[]`.
    3. With `force`, revert items in reverse order using the existing per-kind force semantics. Move items whose `from` is occupied, or whose `to` is missing, are skipped and listed in a new `skippedPaths`.
    4. If any revert throws, restore the items already reverted, in reverse order of reverting, to the state observed in step 1. Do not restore them to `after`, because a forced undo may be overwriting a user edit. Return `ok:false`. The entry stays undoable (FR-051).
  - Export a pure helper `batchSnapshotBytes(items)` and the constant `MAX_BATCH_SNAPSHOT_BYTES = 2*1024*1024`. The tools use them to enforce the cap (FR-052).
- **Persistence**:
  - `src/persistence/PersistedShape.ts`: `PersistedUndoEntry` gains an optional `items` and `label`.
  - `src/persistence/migrate.ts`: `validateUndoEntry` accepts `"batch"` only with a non-empty, well-formed `items` array, and validates each item's op and string fields. Old entries validate unchanged.
  - Copy the new fields in `ConversationManager.makePersistAdapter` and `ConversationsStore.recordUndo`, and in the clone if needed.
  - Downgrade caveat: an older plugin version rejects `kind:"batch"` and drops that conversation (`migrate.ts:180-184`). Record this in Docs.md and the CHANGELOG.
- **`src/ui/undoFlow.ts`**:
  - `divergenceConfirmMessage` accepts either a single path or a list of paths. It lists up to 10, then "and N more".
  - `runUndoFlow` passes `divergentPaths` for batch entries and reports `skippedPaths` through `notify`.
- **`proposals/0013-vault-tool-first-writes.md`** (Status: In Progress) and the `proposals/README.md` index row (FR-070).
- **Tests**:
  - `src/domain/UndoJournal.batch.test.ts`: clean undo; divergence for each op type; force; move-skip on an occupied original; rollback when a write fails mid-undo; cap counting; and the persist "add" payload including `items`.
  - Reload test: persist a batch entry, rebuild the journal from `initialEntries`, and check that `undo()` restores every item.
  - Rollback test: a forced undo where one item's write throws while another item is divergent. The divergent item must return to the user's content, not `after`.
  - Extend `src/persistence/migrate.test.ts` with batch round-trip, malformed batch rejection and legacy entries unchanged.
  - Extend `src/ui/undoFlow.test.ts` with multi-path wording and skipped-path notification.

### Success Criteria
#### Automated Verification
- [ ] Tests pass: `npm test`
- [ ] Typecheck: `npx tsc --noEmit`
#### Manual Verification
- [ ] Existing single-path undo behaviour is unchanged. Covered by the existing suites, which still pass.

---

## Phase 2: `update_tasks` + multi-path safety + approval previews

### Changes Required
- **`src/tools/UpdateTask.ts`**: export `validatePatch`, `applyPatch` and a pure `findExpectedLine(lines, line, expectedRawLine)`, extracted from tier 1 of `identifyTargetLine`. `updateTaskImpl` behaviour is unchanged.
- **New `src/tools/BatchWrite.ts`**: `applyBatchModifications(plans, deps)`.
  - Each plan is `{path, transform(content) → newContent | ProcessAbort}`.
  - It writes each file through `vault.process`, falling back to read+modify, and re-verifies inside the transform. It does NOT record per-file undo entries.
  - On the first failure it restores the files already written to their observed `before`, then returns a failure.
  - On success it returns `UndoBatchItem[]` (modify items, unchanged files omitted). The caller records one batch entry.
  - Reuses `hasUnsavedEditorChanges` and the path helpers in `src/tools/VaultPath.ts`.
- **New `src/tools/UpdateTasks.ts`**: `updateTasksImpl({targets, patch}, deps)`.
  - Caps: 1–200 targets.
  - Validation phase:
    - `validatePatch`;
    - each target's path resolves to an existing file;
    - no unsaved editor buffer;
    - `expectedRawLine` found unambiguously and the line is a task;
    - no duplicate resolved (path, index);
    - total snapshot under the cap.
  - It reports every failure as `{index, path, line, reason}`.
  - Apply phase: group targets by note and apply through `applyBatchModifications`, re-running `findExpectedLine` inside the transform.
  - Result: `{ok, changed, results:[{path, line, before, after, changedFields, changed}], notesChanged, undoId?, undoSurface:"journal"}`. When nothing changed, there is no undo entry.
  - Journal label: "N tasks in M notes".
- **`src/tools/WriteNoteTools.ts`**: add an `update_tasks` `defineTool` with a JSON Schema in the same style as `update_task`, sharing the patch-schema builder. The handler parses args leniently.
- **Registries**:
  - Add an `update_tasks` entry to `WRITE_NOTE_TOOL_ENTRIES`.
  - Add it to `VAULT_WRITE_TOOL_NAMES`.
  - Update the hardcoded lists in `src/main.toolGating.test.ts` and the `AgentSession.test.ts` classification list.
  - Add a lockstep test in `src/tools/WriteNoteTools.test.ts` with exact set equality: (`createWriteNoteTools` names minus `open_note`) = `WRITE_NOTE_TOOL_NAMES` = (`VAULT_WRITE_TOOL_NAMES` minus `WRITE_TOOL_NAMES`).
- **`src/domain/SafetyPolicy.ts`**:
  - `SafetyPolicyInput` gains an optional `vaultRelativePaths`.
  - In the vault case, a non-empty list auto-applies via the allowlist only if every path passes `isVaultPathAllowlisted`. Otherwise it falls through to session grant and default mode exactly as before (FR-041).
- **`src/sdk/AgentSession.ts`**:
  - The `safety` options gain `extractVaultPaths?(req)` and `describeApproval?(req): Promise<{summary?, detail?} | undefined>`.
  - `buildSafetyInput` fills `vaultRelativePaths` for vault-write custom tools when the hook returns a list.
  - In require-approval, call `describeApproval` (try/catch with a timeout of about 2 s, falling back to the current summary and detail) for vault-write custom tools only. Builtin, shell and MCP paths are untouched (FR-044).
- **New `src/tools/approvalPreview.ts`**:
  - Pure formatters: `formatUpdateTasksPreview(rows)` and the shared `boundPreview(lines, maxChars=4000)` truncation with "and N more".
  - An async `describeVaultBatchApproval(toolName, args, deps)` that reads current note content to compute before → after per target, flagging failing targets.
  - Summary text: "update_tasks: N tasks in M notes".
- **`src/main.ts`**:
  - Wire `extractVaultPaths`: `update_tasks` maps to the target paths.
  - Wire `describeApproval` to `describeVaultBatchApproval` with the vault, workspace and now.
- **Tests**:
  - `src/tools/UpdateTasks.test.ts` (fake world copied from the `UpdateTask.test.ts` pattern): multi-note success with one journal entry; stale line → no writes; duplicates; not-a-task; unsaved buffer; cap; no-op; concurrent change between validate and apply → rollback; undo restores all notes.
  - `src/tools/BatchWrite.test.ts`: rollback.
  - `src/tools/approvalPreview.test.ts`: formatting and bounds.
  - Extend `SafetyPolicy.test.ts` with multi-path allowlist all/partial cases.
  - Extend the `AgentSession.test.ts` SafetyPolicy describe: `describeApproval` used for vault writes, a fallback when it throws, and builtin and shell approval output unchanged.

### Success Criteria
#### Automated Verification
- [ ] Tests pass: `npm test`
- [ ] Typecheck: `npx tsc --noEmit`
#### Manual Verification
- [ ] In require-approval mode, an `update_tasks` call shows one prompt listing before → after lines, and its result has one Undo button.

---

## Phase 3: `move_note`

### Changes Required
- **New `src/tools/MoveNote.ts`**: `moveNoteImpl({moves}, deps)`.
  - Deps: `vault` (`getAbstractFileByPath`, `createFolder`), `fileManager.renameFile(file, newPath)`, `configDir` and `undoJournal`. Detect folders by duck typing (`"children" in file`), because `obsidianMock` has no `TFolder` and tests import modules that would otherwise need it.
  - Caps: 1–100 items.
  - Validation, all items before any move:
    - resolve both paths with `resolveVaultPath`;
    - the source exists;
    - the destination is free. Check it with a case-insensitive lookup as well, so `Foo.md` → `bar/foo.md` reports `target_exists` when `bar/Foo.md` exists. The only exception is a case-only rename of the same item;
    - from ≠ to;
    - no duplicate sources or destinations;
    - no destination equals another item's source;
    - a folder is not moved into its own subtree;
    - neither path is the config dir or inside it.
  - Apply: create missing parent folders (ignoring "already exists") and call `renameFile` in order. On failure, move the completed items back in reverse order.
  - Records one batch entry of `move` items, labelled "N items".
  - Result: per-item `{from, to}`, `undoId` and a note that link updates follow Obsidian's setting.
- **`src/domain/UndoJournal.ts`**: implement the move revert through the injected `moveItem`, creating the missing parent folder of `from`.
- **`src/main.ts`**:
  - Pass `this.app.fileManager`, `vault.configDir` and the folder predicate into the tool deps.
  - Supply `moveItem` to the runtime journal (`makeRuntimeJournal` options) using `fileManager.renameFile`.
  - `extractVaultPaths` for `move_note` returns all sources and destinations.
- **`src/tools/WriteNoteTools.ts`**: the `move_note` tool definition. The deps type gains optional `fileManager`, `configDir` and `isFolder`; if they are missing, the tool returns `{ok:false, error}`.
- **`src/tools/approvalPreview.ts`**: a move preview (`from → to` plus the incoming link count from `metadataCache.resolvedLinks`). For a folder, count links that target any file under it from outside the folder. Summary: "move_note: N items". Add `metadataCache` to the `describeVaultBatchApproval` deps.
- **Registries**: manifest entry, `VAULT_WRITE_TOOL_NAMES`, and the test lists and lockstep.
- **Tests**:
  - `src/tools/MoveNote.test.ts` with a fake vault and fileManager that move map keys, including folder children:
    - success with folder creation;
    - target exists, duplicates, subtree, config dir;
    - case-only rename allowed;
    - mid-call failure rollback;
    - undo moves back in reverse.
  - Journal move tests in the Phase 1 batch test file. Preview tests.

### Success Criteria
#### Automated Verification
- [ ] Tests pass: `npm test`
- [ ] Typecheck: `npx tsc --noEmit`
#### Manual Verification
- [ ] In Obsidian, moving a linked note updates the backlinks, and Undo moves it back with the links following.

---

## Phase 4: `bulk_edit`

### Changes Required
- **New `src/tools/BulkEdit.ts`**:
  - A pure `compileFind({find, regex, ignoreCase})`:
    - literal mode escapes to a regex;
    - regex mode uses flags `g` + `m` (+ `i`), no `s`;
    - rejects an empty find, invalid regex, or a regex that matches `""`.
  - A pure `replaceAllCounted(content, compiled, replacement, literal)`. Literal mode uses a function replacer so `$` is verbatim. Regex mode uses native `$1` / `$<name>` / `$$` semantics. Returns `{content, count, samples}`.
  - `bulkEditImpl({paths, find, replace, regex?, ignoreCase?}, deps)`:
    - Caps: ≤50 notes; `.md` / `.txt` only; total replacements ≤5000; snapshot cap.
    - Validate all paths (exists, extension, unsaved buffer) before writing.
    - Apply through `applyBatchModifications`. Inside the transform, compare the current content with the snapshot taken at validation time. If it differs, abort with `concurrent_change`, which triggers rollback, instead of quietly re-applying to new content.
    - One batch entry, labelled "N replacements in M notes".
    - Zero matches overall: ok, `changed:false`, no entry.
- **`src/tools/WriteNoteTools.ts`** definition. Manifest, `VAULT_WRITE_TOOL_NAMES`, test lists and lockstep. `extractVaultPaths` returns the paths.
- **`src/tools/approvalPreview.ts`**: bulk preview with per-note counts, up to 3 sample before/after lines per note, and the total. Summary: "bulk_edit: N replacements in M notes".
- **Tests**:
  - `src/tools/BulkEdit.test.ts`:
    - literal `$` verbatim; regex captures; ignore-case; multiline anchors;
    - empty and empty-matching regex rejected;
    - extension rejection; unsaved buffer;
    - zero-match notes untouched; zero overall → no entry;
    - rollback; undo.
  - Preview tests.

### Success Criteria
#### Automated Verification
- [ ] Tests pass: `npm test`
- [ ] Typecheck: `npx tsc --noEmit`
#### Manual Verification
- [ ] The approval shows per-file counts and samples. One Undo reverts every edited note.

---

## Phase 5: Out-of-band change warning

### Changes Required
- **New `src/domain/VaultChangeDetector.ts`**: a pure class with an injected clock and config.
  - Config: `graceMs = 2000`, `settleMs = 1500`, `configDir`, `maxListed = 20`.
  - API:
    - `externalToolStarted(toolCallId)` / `externalToolCompleted(toolCallId)`;
    - `beginSelfWrite()`, which returns a token ending the span;
    - `observe({type, path, oldPath?}, focusedEditorPath?)`, which returns `{toolCallId, change}` or `null`.
  - Exclusion rules, in order:
    1. Paths under the config dir.
    2. Any active self-write span. Paths observed during the span are remembered for `settleMs`. So are paths the span reports when it ends: `endSelfWrite(paths)` takes the written paths from tool results and batch items, which covers vault events that arrive after the span closes.
    3. Remembered self-written paths within the settle period.
    4. No external tool active or in grace.
    5. A `modify` on the focused editor path.
  - Attribution goes to the most recently started external call that is active or in grace.
  - The detector also emits to subscribers.
  - Pure helper `mergeVaultChanges(existing, change, max)`: dedupes by path and keeps the latest type, caps the list, and counts the overflow.
- **`src/domain/types.ts`**: `ToolCall` gains `vaultChanges?: {type: "created"|"modified"|"deleted"|"renamed"; path; oldPath?}[]` and `vaultChangesOverflow?: number`. Mirror these in `PersistedShape`, `migrate.validateMessage` (validated and capped), `hydrateChatState`, `toPersistedToolCalls` and `toolCallsSig`.
- **`src/main.ts`**:
  - Create one plugin-level detector.
  - Inside `onLayoutReady`, `registerEvent(vault.on("create"|"modify"|"delete"|"rename"))` and feed `observe`, with the focused path from `workspace.getActiveViewOfType(MarkdownView)?.file?.path`.
  - Wrap every vault custom tool handler (all `vaultTools`) so execution runs inside `beginSelfWrite()`. Use a helper `wrapToolsWithSelfWriteSpan(tools, detector)` in a new pure-ish module `src/tools/selfWriteSpan.ts`.
  - Pass the detector to ChatView through `ChatViewDeps` / `ChatViewRegistration`.
- **`src/ui/ChatView.ts`**:
  - In the stream loop, for builtin and MCP calls, call `externalToolStarted` only when a call becomes running. That means `tool_call_start` with outcome `approved` or `running`, or `approval_resolved` with an approve choice. Events with outcome `denied`, `cancelled` or `pending_approval` open no window.
  - Call `externalToolCompleted` on `tool_call_complete`, and complete every open window in `finally`.
  - Subscribe to detector emissions and upsert `vaultChanges` on the matching tool call in the owning segment, persisting the tool calls.
    - Keep the toolCallId → owning-message map for the grace period after the stream ends, so changes from the turn's last shell call are not lost.
    - Ignore emissions for calls the view does not know about.
  - Undo self-write span: wrap only the `journal.undo` calls. Pass `runUndoFlow` a journal adapter whose `undo` runs inside a span, so the span stays closed while the divergence-confirm modal is open.
  - Unsubscribe in `onClose`.
  - Decide which window events to feed with a pure helper `externalWindowSignal(ev)` in `src/ui/vaultChangeWarning.ts`.
- **New `src/ui/vaultChangeWarning.ts`**: pure `formatVaultChangeWarning(changes, overflow)`, returning `{headline, lines, footnote}`. It uses hedged copy and includes the link footnote only if a rename or delete is present (FR-063).
- **`src/ui/ToolCallBlock.ts`**:
  - Render a warning section (icon, headline, list) when `vaultChanges` is non-empty, outside the collapsed body so it stays visible.
  - Mark the summary with a ⚠ indicator.
  - Add minimal CSS in `styles.css`.
- **Tests**:
  - `src/domain/VaultChangeDetector.test.ts`, covering each exclusion rule:
    - the window plus grace;
    - a move during a shell call's grace period → no warning (P3 scenario 6);
    - nested and concurrent attribution;
    - the cap and overflow.
  - `src/ui/vaultChangeWarning.test.ts`.
  - `src/tools/selfWriteSpan.test.ts`: the span closes on throw, and the wrapper keeps every `defineTool` field (`skipPermission`, `overridesBuiltInTool`, `parameters`, …).
  - `externalWindowSignal` tests: denied, cancelled and pending outcomes open no window.
  - Extend `migrate.test.ts` (round-trip and malformed) and `ConversationRuntime.test.ts` (hydration).

### Success Criteria
#### Automated Verification
- [ ] Tests pass: `npm test`
- [ ] Typecheck: `npx tsc --noEmit`
#### Manual Verification
- [ ] A shell command editing a note during a turn shows a warning on that shell call, and the warning survives a reload.
- [ ] Vault tool writes and user typing while the agent is idle produce no warning.

---

## Phase 6: Preamble hard rule

### Changes Required
- **`src/domain/PreambleAssembler.ts`**:
  - Export `VAULT_WRITE_RULES_BLOCK`, the tightened brief wording covering FR-001a–e, which also mentions built-in file tools.
  - Add the `VAULT_WRITE_RULES` placeholder. Insert the block into the default preamble after the vault context and before the inventory.
  - Update the "Editing tasks" bullet: use `update_task` for one task, and one `update_tasks` call for several.
  - Add bullets pointing moves and renames to `move_note` and repeated replacements to `bulk_edit`.
  - Set `MAX_DEFAULT_PREAMBLE_BYTES = 10 * 1024`, with an updated justification comment.
  - Keep the manifest hints for the new tools concise.
- **`src/settings/SettingsTab.ts`**: list `{{VAULT_WRITE_RULES}}` in the placeholder description.
- **Tests**: extend `src/domain/PreambleAssembler.test.ts`:
  - rule present in default (full and gated) with phrases for each FR-001 sub-item;
  - placeholder substitution, including the all-placeholders test;
  - updated guidance strings;
  - byte bound for both inventories;
  - new tools in both inventory blocks via the existing lockstep test.

  Fix the existing "Editing tasks" assertions.

### Success Criteria
#### Automated Verification
- [ ] Tests pass: `npm test`
- [ ] Typecheck: `npx tsc --noEmit`
#### Manual Verification
- [ ] The assembled preamble reads clearly. The rule appears before the tool inventory.

---

## Phase 7: Documentation

### Changes Required
- **`.paw/work/vault-tool-first-writes/Docs.md`**: as-built technical reference covering the tools, batch undo, safety previews, the detector, the preamble, and how it was verified (load `paw-docs-guidance`).
- **`README.md`**: a "What's new" section for the three tools, the hard rule and the `{{VAULT_WRITE_RULES}}` placeholder, and the change warning. Update the tool list and the undo notes.
- **`CHANGELOG.md`**: add a top `## [Unreleased]` section with Added/Changed bullets in the house style.
- **`proposals/0013-vault-tool-first-writes.md`**: keep it In Progress, with the sketch updated to what was built. It is flipped to Shipped with the PR link during paw-pr.

### Success Criteria
- [ ] `npm test` and `npx tsc --noEmit` still pass.
- [ ] The docs are accurate and match house style.

---

## References
- Issue: none
- Spec: `.paw/work/vault-tool-first-writes/Spec.md`
- Research: `.paw/work/vault-tool-first-writes/CodeResearch.md`
