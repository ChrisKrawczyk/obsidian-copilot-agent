# Vault Tool-First Writes

## Overview

When a vault tool was slow, approval-heavy, or missing, the in-Obsidian agent used to fall back to shell commands (PowerShell `Move-Item`/`Set-Content`, Python `open(...).write`, .NET `WriteAllText`) to change vault files. Those writes skip the SafetyPolicy approval prompt, aren't recorded in the UndoJournal, and moves done that way leave every wikilink pointing at the old path.

This work makes the shell path unnecessary and less tempting, without blocking it:

1. **A hard rule in the default preamble** says every vault change goes through the vault tools. The rule is also available in custom mode as `{{VAULT_WRITE_RULES}}`.
2. **Three batch tools** remove the main reasons the agent reached for the shell. Each asks for approval at most once per call (when SafetyPolicy requires approval) and creates one Undo entry when something changed:
   - `update_tasks` applies one patch to many tasks.
   - `move_note` does link-aware moves and renames.
   - `bulk_edit` does a previewed find/replace across notes.
3. **Batch Undo entries** in the UndoJournal. One entry covers many files and is undone atomically.

No shell guard was added, and vault writes made by shell or MCP calls are neither blocked nor flagged. Shell and other built-in permission decisions are unchanged (FR-044). An out-of-band change warning was built during this work and then removed after PR review, because external calls may legitimately be expected to change vault files.

## Architecture and Design

### High-Level Architecture

```
model ──► update_tasks / move_note / bulk_edit (src/tools/*)
            │ analyze (pure, validate-all)  ──► approval preview (src/tools/approvalPreview.ts)
            │ SafetyPolicy (multi-path allowlist)
            │ apply (BatchWrite / fileManager.renameFile) ──► rollback on failure
            ▼
         UndoJournal.recordBatch ──► one "batch" entry (persisted)
            ▼
         ToolCallBlock Undo ──► undoFlow ──► UndoJournal.undo (atomic, divergence-checked)
```

- **`src/tools/UpdateTasks.ts`**: `analyzeUpdateTasks` resolves every target against current note content using the `update_task` semantics in `UpdateTask.ts` and `TaskFormat.ts`, then groups the rows per note.
- **`src/tools/BulkEdit.ts`**:
  - `compileFind` handles literal or regex search. It is case-sensitive unless `ignoreCase` is set, and regex mode uses the global and multiline flags.
  - `replaceAllCounted` returns per-note counts and up to 3 sample lines.
- **`src/tools/MoveNote.ts`**:
  - `analyzeMoveNote` validates the whole list.
  - Apply creates any missing parent folders and calls `app.fileManager.renameFile` for each item in order.
  - If an item fails, the items already moved are moved back.
- **`src/tools/BatchWrite.ts`**: shared modify-with-rollback for the two text tools. Each note is rewritten with `vault.process`, which re-checks the validated content atomically. If a note fails, notes already written are restored.
- **`src/tools/approvalPreview.ts`**: pure formatters for the approval prompt.
  - `update_tasks`: each target's line before → after.
  - `move_note`: each from → to, with the number of notes that link to it.
  - `bulk_edit`: per-note counts plus samples.
  - The preview is capped at about 4,000 characters, after which it adds "and N more". `extractBatchVaultPaths` feeds SafetyPolicy's multi-path allowlist check.
- **`src/domain/UndoJournal.ts`**: a `batch` entry kind with modify, create, delete and move items.

### Design Decisions

- **One move tool, not separate move and rename tools.** A rename is a move within the same folder, and one batched tool is easier for the model to pick. It is called `move_note` as the brief asked, but it also accepts attachments and folders.
- **Validate everything, then apply, with rollback.** All three tools validate every target before writing anything. Any validation failure means zero writes, and the result lists every failing target with a machine-readable reason. If something fails at write time (a concurrent change, an I/O error, or a rename error), the writes already made in that call are rolled back and no Undo entry is recorded.
- **`update_tasks` takes one patch, and every target needs `expectedRawLine`.** There is no fuzzy `descriptionMatch` fallback for bulk edits. Re-anchoring 200 lines by substring is too risky.
- **Batch Undo is atomic.**
  - Every item is checked for divergence before any is reverted. Without force, nothing is reverted and the divergent paths are listed.
  - With force:
    - every item is reverted, except moves whose moved item is gone or whose original path is now taken by a different file; those are skipped and reported;
    - a note deleted since the action is recreated from its snapshot.
  - Each revert is guarded: it writes only if the file still holds what the preflight saw (inside `vault.process` when available), so an edit that lands during the Undo aborts it instead of being overwritten.
  - If a write fails partway through an Undo, the items already reverted are put back to the state seen just before the Undo began, and the entry stays undoable.
- **Size caps keep persisted data bounded:**
  - 200 tasks per call, 100 moves per call, and 50 notes or 5,000 replacements per `bulk_edit` call;
  - 2 MB of combined snapshot content per batch entry, checked when the tool validates its input and again against what was actually written (a note that grew in between makes the call roll back);
  - `bulk_edit` stops counting matches once the 5,000 cap is exceeded, so an oversized edit is rejected without a full dry run;
  - a batch entry counts as one entry toward the journal cap.
- **Preamble size bound raised from 8 KB to 10 KB.** The rule is safety-critical, and the preamble is still constant per vault. The assembled preamble is about 9.1 KB with the full inventory and about 7.9 KB with the gated one, measured with a 260-character vault path.
- **The thresholds come from the brief.** "More than 5 items needs confirmation" and "more than about 10 tool calls, stop and ask" are kept as written, even though large batches then need one chat round-trip before the single approval.

### Integration Points

- **`src/domain/vaultToolManifest.ts`**: the three tools are registered as mutating vault tools. This keeps the preamble inventory, safety classification and raw-FS tool gating in lockstep, and `src/main.toolGating.test.ts` checks it.
- **`src/domain/SafetyPolicy.ts`**: the new tools fall under the `vault` source. A multi-path call is auto-approved through the allowlist only when every path it touches is covered. For moves that means every source and every destination. Paths are normalised (`\\`, doubled and edge slashes); empty, `.` or `..` segments never match, so such calls always prompt. An allowlisted `move_note` can still rewrite links in notes outside the allowlist.
- **`src/sdk/AgentSession.ts`**: calls the `describeApproval` hook (wired in `main.ts` to `describeVaultBatchApproval`) to build the preview, with a 2 s timeout. If the preview fails or times out, the default prompt is shown instead, and the approval is never blocked.
- **`src/ui/undoFlow.ts` and `ToolCallBlock.ts`**: the Undo button works for the new tools. For a batch entry, the divergence confirmation lists the affected paths.
- **Persistence (`PersistedShape.ts`, `migrate.ts`)**:
  - Batch Undo entries are saved with the conversation, and the migration validates them.
  - Conversations saved by a pre-merge build with the removed `vaultChanges` / `vaultChangesOverflow` tool-call fields still load; the fields are dropped.
  - The schema version is still 2.

## User Guide

### Prerequisites

None. The tools and the rule are on by default. Under the **Custom** preamble mode, add `{{VAULT_WRITE_RULES}}` to your template to keep the rule.

### Basic Usage

- **"Mark every task tagged #sprint-12 as done."** The agent calls `find_tasks`, lists the matches, and confirms with you if there are more than 5. It then makes one `update_tasks` call. You approve once and see each task's line before and after. One Undo reverts all of them.
- **"Rename Projects/Old.md to Projects/New.md"** or **"move these 12 notes into Archive/2026/".** The agent makes one `move_note` call. The approval shows each from → to and how many notes link to each item. Links are updated according to your Obsidian link settings ("Automatically update internal links"). Undo moves everything back and updates the links again.
- **"Replace 'ACME Corp' with 'Acme' in these notes."** The agent makes one `bulk_edit` call. The approval shows the match count for each note, a few before/after lines, and the total.

### Advanced Usage

- **`bulk_edit` regex mode:**
  - Set `regex: true`. `^` and `$` match at line boundaries, and `.` doesn't match a newline.
  - The replacement can use `$1`, `$<name>` and `$$`.
  - In literal mode the replacement is inserted exactly as written.
  - `ignoreCase: true` makes the search case-insensitive.
- **Allowlisted folders.** A batch call is auto-applied only when every path it touches is inside the allowlist.

## API Reference

### Key Components

- **`update_tasks({ targets: [{ path, line, expectedRawLine }], patch })`**:
  - `patch` has the same fields as `update_task`.
  - Possible failure reasons: `invalid_target`, `invalid_path`, `not_found`, `read_failed`, `unsaved_changes`, `task_not_found`, `ambiguous_match`, `not_a_task`, `duplicate_target`.
- **`move_note({ moves: [{ from, to }] })`**:
  - Possible failure reasons: `invalid_item`, `invalid_path`, `not_found`, `same_path`, `target_exists`, `parent_is_file`, `folder_case_mismatch`, `duplicate_source`, `duplicate_destination`, `overlapping_items`, `into_own_subtree`, `config_dir`.
  - A rename that changes only letter case is allowed.
- **`bulk_edit({ paths, find, replace, regex?, ignoreCase? })`**:
  - Works on `.md` and `.txt` notes only.
  - An empty `find`, or a regex that can match the empty string, is rejected.
  - Possible failure reasons: `invalid_path`, `not_found`, `not_a_note`, `read_failed`, `unsaved_changes`, `duplicate_path`, `match_error`.
- **What successful results return:**
  - **Rows:** `update_tasks` returns per-target before/after lines and the changed fields. `bulk_edit` returns per-note counts.
  - **Undo id:** the `undoId`, present only when something actually changed.
  - **No-change runs:** targets or notes with nothing to change are reported as unchanged and are not written.

### Configuration Options

- **Preamble placeholder:** `{{VAULT_WRITE_RULES}}`, used in Custom mode. It is listed in the settings text next to the other placeholders.
- **No new settings toggles.**

## Testing

### How to Test

The automated checks are `npm test` (119 files, 1,814 tests) and `npx tsc --noEmit`. To check by hand in Obsidian:

1. Create notes with 8 or more tasks. Ask the agent to mark all of them done. You should see one confirmation, one approval with a before/after preview, and one Undo button. Undo should restore every line.
2. Ask the agent to rename a note that other notes link to. The links should update. After Undo, they should point back at the original name.
3. Ask for a find/replace across 3 notes. Check the counts in the preview, then approve and Undo.
4. Read the assembled preamble (Settings → Vault Awareness shows a preview) and check that the hard rule reads clearly.

### Edge Cases

- **Stale input:** a stale `expectedRawLine`, or a note with unsaved editor changes, means the whole batch is rejected and nothing is written.
- **Note changed between validation and write:** everything already written is rolled back, and the result reports a concurrent change.
- **Move conflicts:** a destination that already exists, a folder moved into its own subtree, a destination that is another item's source, and a file moved to a path another item uses as a folder (`parent_is_file`) are all rejected.
- **Undo after a note was deleted:** the divergence prompt appears. A forced Undo recreates the note from the snapshot.
- **Forced Undo of a move whose moved item is gone, or whose original path is now taken by a different file:** that item is skipped and reported.

## Limitations and Future Work

- **`move_note` leaves empty folders behind.** Folders created for a destination aren't removed on rollback or Undo.
- **No automated test covers the 2 s `describeApproval` preview timeout.**
- **Downgrade caveat.** Older plugin versions can't read batch Undo entries, so they drop conversations that contain them. The schema version wasn't bumped.
- **Deferred:**
  - per-target patches in `update_tasks`;
  - line-level Undo (proposal 0012).
