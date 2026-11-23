# Feature Specification: Vault Tool-First Writes

**Branch**: feature/vault-tool-first-writes  |  **Created**: 2026-11-20  |  **Status**: Draft (rev 3 — change detection removed after PR review)
**Input Brief**: Make shell-based vault mutation unnecessary and less enticing (not blocked) by adding a hard preamble rule, batch/move/bulk-edit vault tools with single approval + single undo.

## Overview

The in-Obsidian Copilot agent has a family of vault tools that respect the user's safety policy (approval prompts, allowlist) and record every write in the per-conversation Undo journal. When those tools are slow, approval-heavy, or simply missing, the model routes around them: it runs PowerShell/bash/Python to rewrite or move vault files directly. Those writes skip approvals, can't be undone from chat, and — for moves — leave every wikilink pointing at the old location. The two observed drivers are that `update_task` edits only one task per call (so "mark these 30 tasks done" means 30 approvals and 30 undo entries), and that there is no vault tool to move or rename a note at all.

This work removes the reasons to reach for the shell instead of forbidding the shell. The default preamble gains a short, explicit "vault writes" hard rule that tells the model all vault mutations go through vault tools, what the shell may still be used for (reading, and writing outside the vault), and that it must stop and ask the user before falling back. In parallel, three new vault tools close the capability gaps: a batch task updater, a link-preserving move/rename tool, and a previewed multi-file find/replace. Each new tool needs one approval and produces one Undo entry for the whole batch, so the "right" path is also the cheap path. The shell itself is never blocked, gated, or flagged by this work: shell and MCP calls may legitimately change vault files.

## Objectives

- Make the vault tools the obvious default for every vault mutation, including bulk task updates, moves/renames, and repetitive text edits (Rationale: the model takes the shell path when vault tools are costlier or missing).
- Reduce approval and undo noise for bulk operations to one approval and one Undo click per batch.
- Preserve wikilinks when notes are moved or renamed by the agent.
- Keep every new write tool inside the existing safety model (approval/allowlist/session grant) and the existing Undo journal, including across plugin reloads.
- Do NOT add any guard, rejection, extra approval requirement, or after-the-fact warning for shell or MCP writes.

## User Scenarios & Testing

### User Story P1 – Bulk task status change in one step
Narrative: The user asks "mark every open task tagged #sprint-12 as done". The agent finds the tasks; if there are more than 5, it lists them with the matching rule in chat and waits for the user's go-ahead (per the hard rule the user specified), then issues one batch update. The user sees one approval listing every task's before → after line, approves once, and all tasks flip. If something is wrong, one Undo click restores every touched note.
Independent Test: With require-approval mode, have the agent call the batch tool for 8 tasks across 3 notes; observe exactly one approval prompt and one Undo button; click Undo and verify all 3 notes return to their prior content.
Acceptance Scenarios:
1. Given 8 matching tasks in 3 notes, When the agent calls the batch tool with all 8 targets, Then one approval prompt shows each target (note, line, before → after), and after approval all 8 lines are updated and one Undo entry exists.
2. Given one target's expected line text no longer matches the note (stale), When the batch tool runs, Then no note is modified, and the result names the failing target(s) and reason so the agent can re-run `find_tasks`.
3. Given a completed batch, When the user clicks Undo and none of the notes changed since, Then all notes are restored and the call shows "reverted".
4. Given a completed batch where one note was edited afterwards, When the user clicks Undo, Then the user is asked to confirm a divergent revert listing the changed note(s); declining leaves everything as-is; confirming restores every note in the batch.

### User Story P1 – Move or rename notes with links updated
Narrative: The user asks "move all meeting notes from Inbox into Meetings/2026". The agent issues one move call with the list. Obsidian updates links in every referencing note. One Undo click moves them all back (links follow again).
Independent Test: Move a note that two other notes link to; verify both links now point at the new location; click Undo and verify the note and links are back.
Acceptance Scenarios:
1. Given `Inbox/A.md` linked from two notes, When the agent moves it to `Meetings/2026/A.md` (folder missing), Then the folder is created, the note moves, and both links resolve to the new path.
2. Given the destination already exists, When the move is requested, Then nothing moves and the result reports `target_exists` for that item.
3. Given a multi-item move where any item is invalid (source missing, destination occupied, duplicate destination, destination inside the source folder), When the tool runs, Then nothing moves and every invalid item is reported.
4. Given a completed move, When the user clicks Undo, Then every item is moved back to its original path using the same link-updating mechanism.
5. Given a rename (same folder, new name), When requested, Then it behaves exactly like a move.
6. Given a case-only rename (`a.md` → `A.md`), When requested, Then it succeeds (it is not treated as "target exists").

### User Story P2 – Previewed find/replace across notes
Narrative: The user asks "rename the tag #proj-x to #project-x everywhere". The agent finds candidate notes and issues one bulk edit. The approval shows per-file match counts and sample before/after lines. One approval applies all; one Undo reverts all.
Independent Test: Bulk-replace a literal string across 4 notes in require-approval mode; verify the approval lists 4 files with counts; approve; verify content; Undo restores all.
Acceptance Scenarios:
1. Given 4 notes containing the find text, When the bulk edit is requested, Then the approval shows each file with its match count and sample changed lines, plus the total.
2. Given a listed note with zero matches, When the edit runs, Then that note is untouched and reported as unchanged; other notes are edited.
3. Given zero matches overall, When the edit runs, Then no note changes, no Undo entry is recorded, and the result says so.
4. Given a listed path that doesn't exist, is not a markdown/text note, or has unsaved editor changes, When the edit runs, Then no note is modified and the failing paths are reported.
5. Given regex mode with capture groups, When the edit runs, Then `$1`-style references in the replacement are honoured.

### User Story P2 – The model is told the rule
Narrative: With the default preamble, the model is told that vault changes go through vault tools only, what the shell may still do, to stop and ask before falling back, and to confirm bulk operations (>5 items) by listing targets first. Task-editing guidance points at the batch tool; move/rename guidance points at the move tool.
Independent Test: Assemble the default preamble and verify the rule block, the batch/move guidance, and all new tools in the inventory are present and the preamble stays within its size bound.
Acceptance Scenarios:
1. Given default preamble mode, When the preamble is assembled, Then it contains the vault-writes hard rule and the updated task/move guidance.
2. Given custom preamble mode with the new placeholder, When assembled, Then the placeholder is replaced by the same rule text.
3. Given the raw-FS gated inventory and the full inventory, When assembled, Then both name every new tool.

### Edge Cases
- Batch task tool: two targets resolving to the same line → validation failure (duplicate target), nothing written.
- Batch task tool: patch that changes nothing for some targets → those targets are reported unchanged; only changed notes are written; if nothing changes overall, no Undo entry.
- Batch task tool: target line is not a task → validation failure for that target.
- Batch task tool / bulk edit: a note changes between validation and write → the whole batch is rolled back (already-written notes restored) and the result reports a concurrent change; the agent can retry.
- Batch task tool: more than the per-call target cap → rejected with guidance to split.
- Move: source equals destination → validation failure (no-op move rejected).
- Move: one item's destination is another item's source → validation failure (ambiguous ordering).
- Move: folder moved into its own subtree → validation failure.
- Move: a later item fails at write time → earlier items in the same call are moved back; result reports failure.
- Move undo: original path is now occupied, or the moved item is gone → divergence prompt; forced undo skips items whose original path is occupied by a different file rather than overwriting, and reports them.
- Bulk edit: empty find string or a regex that can match the empty string → rejected.
- Bulk edit: invalid regex → rejected with the regex error.
- Bulk edit / batch task tool: combined size of targeted notes over the snapshot cap → rejected with guidance to split.
- Undo of a batch where a note was deleted since → divergence prompt; forced undo recreates it from the snapshot.
- Undo failure partway through a batch → already-reverted notes are put back to their post-action content and the user is told the undo failed; the entry remains undoable.
- Move: case-only rename on a case-insensitive file system → allowed; not a `target_exists` failure.
- Move: source inside the Obsidian config folder (or the config folder itself) → validation failure.

## Requirements

### Functional Requirements

Preamble
- FR-001: The default preamble includes a "Vault writes: hard rule" block (wording derived from the brief's intended text) stating each of the following, each independently checkable in the assembled text: (Stories: P2-rule)
  - FR-001a: any vault change (create, edit, move, rename, delete, task status) must go through vault tools;
  - FR-001b: never via shell commands (PowerShell/bash, Python, Move-Item, Set-Content, WriteAllText, etc.) or built-in file tools, even when a vault tool is slower, needs many approvals, or seems less convenient;
  - FR-001c: shell commands may read the vault, and may write only outside the vault or inside the agent's session-state folder (the plugin's own data folder under the Obsidian config folder, which vault tools never touch);
  - FR-001d: if no vault tool can do the change, or doing it would take more than about 10 tool calls (threshold taken verbatim from the brief), stop and ask the user, explaining the plan, why the vault tools fall short, and that a shell change bypasses approvals and can't be undone; act only after explicit agreement;
  - FR-001e: bulk operations over 5 items (threshold taken verbatim from the brief): list the targets and the matching rule and get confirmation before starting.
- FR-002: Custom preamble mode supports a new placeholder `{{VAULT_WRITE_RULES}}` that expands to the same rule block; it is documented with the other placeholders. (Stories: P2-rule)
- FR-003: The "Editing tasks" guidance directs single-task edits to `update_task` and multi-task edits to one `update_tasks` call; authoring guidance directs moves/renames to `move_note` and repetitive text replacement across notes to `bulk_edit`. (Stories: P2-rule)
- FR-004: The assembled default preamble (full and gated inventory) stays within its documented size bound, which is raised from 8 KB to 10 KB with the justification recorded alongside it. (Stories: P2-rule)
- FR-005: All new tools appear in the shared tool manifest so the preamble inventory, safety classification, and tool gating stay in lockstep. (Stories: all)

Batch task updates (`update_tasks`)
- FR-010: A tool accepts a list of targets (each: note path, 1-based line, exact expected raw line from `find_tasks`) and one patch with the same fields and semantics as `update_task` (status with auto-stamping, due/scheduled dates, priority, add/remove tags, description). (Stories: P1-tasks)
- FR-011: The tool validates every target before writing anything (path valid and in vault, note exists, no unsaved editor changes, expected line found unambiguously, line is a task, no duplicate targets, patch valid, within caps). Any validation failure → no writes; result lists every failing target with a machine-readable reason. (Stories: P1-tasks)
- FR-012: After validation, all affected notes are written; the write for each note re-verifies the validated lines atomically. If any note write fails or detects a concurrent change, notes already written in this call are restored and the result reports the failure; no Undo entry is recorded. (Stories: P1-tasks)
- FR-013: A successful call with at least one changed note records exactly one Undo entry covering every changed note, and returns per-target before/after lines, changed fields, and the undo id. (Stories: P1-tasks)
- FR-014: Caps: at most 200 targets per call; combined size of affected notes bounded by the batch snapshot cap (FR-052). (Stories: P1-tasks)

Move / rename (`move_note`)
- FR-020: One tool, `move_note`, moves or renames one or more vault items (files of any type, or folders) given a list of `{ from, to }` vault-relative paths. (Stories: P1-move)
- FR-021: Moves use Obsidian's link-aware rename so links to moved items are updated per the user's Obsidian link settings. (Stories: P1-move)
- FR-022: Validation before any move: source exists; destination path valid, in vault, not existing (no overwrite); source ≠ destination; no duplicate sources or destinations; no destination equal to another item's source; folder not moved into its own subtree; neither source nor destination is the Obsidian config folder or inside it. A case-only rename of the same item is not a "destination exists" conflict. Any failure → nothing moves; result lists every failing item with a reason. (Stories: P1-move)
- FR-023: Missing destination parent folders are created. (Stories: P1-move)
- FR-024: Moves apply in order; if one fails, earlier moves in the same call are moved back and the result reports the failure; no Undo entry is recorded. (Stories: P1-move)
- FR-025: A successful call records exactly one Undo entry; undo moves every item back (reverse order) with the same link-aware rename. (Stories: P1-move)
- FR-026: Cap: at most 100 items per call. (Stories: P1-move)

Bulk find/replace (`bulk_edit`)
- FR-030: A tool applies one find/replace to a list of notes: literal (default) or regular expression; case-sensitive by default with an option to ignore case. Regex mode is global and multiline (`^`/`$` match at line boundaries), without dot-all, so matches span lines only when the pattern explicitly matches a newline; replacements support capture-group references (`$1`, `$<name>`, `$$`). In literal mode the replacement is inserted verbatim (`$` has no special meaning). (Stories: P2-bulk)
- FR-031: Validation before writing: every path exists, is a markdown or plain-text note, has no unsaved editor changes; find is non-empty; regex compiles and cannot match the empty string; within caps (at most 50 notes; combined size within FR-052 cap; at most 5,000 total replacements). Any failure → no writes; failing paths listed. (Stories: P2-bulk)
- FR-032: Notes with zero matches are left untouched and reported unchanged. Zero matches overall → success with no changes and no Undo entry. (Stories: P2-bulk)
- FR-033: Writes follow the same all-or-rollback behaviour as FR-012, and success records exactly one Undo entry for all changed notes; result reports per-note replacement counts and the undo id. (Stories: P2-bulk)

Approval and safety
- FR-040: All three tools are vault-mutating tools classified under the vault safety source, honouring default mode, allowlist, and session grants exactly as existing vault write tools do. (Stories: P1-tasks, P1-move, P2-bulk)
- FR-041: For multi-path calls, the allowlist auto-applies only when every path the call touches (for moves: every source and destination path; for a folder move, the folder's own source and destination paths, with allowlist folder-prefix rules covering contents) is covered; otherwise the normal default-mode/grant decision applies. (Stories: P1-tasks, P1-move, P2-bulk)
- FR-042: When approval is required, the prompt shows a human-readable preview computed from the current vault state: batch tasks → each target as note:line with before → after line (failing targets flagged); move → each from → to plus how many notes link to each item; bulk edit → each note with match count and sample before/after lines, plus total. Previews are size-bounded: at most 3 sample changed lines per note for bulk edit, and a total preview of at most about 4,000 characters (the existing approval detail limit), truncated with an "and N more" line. Preview failures fall back to the raw arguments and never block the approval. (Stories: P1-tasks, P1-move, P2-bulk)
- FR-043: The approval summary line names the tool and the batch scale (e.g. "update_tasks: 8 tasks in 3 notes"). (Stories: P1-tasks, P1-move, P2-bulk)
- FR-044: No change is made to how shell or other built-in tool requests are decided or approved. (Stories: all)

Undo journal
- FR-050: The Undo journal supports a batch entry composed of per-item operations (modify, create, delete, move) that is undone atomically: all items are checked for divergence first; without force, any divergence → no item reverted and the outcome lists the divergent paths; with force, all items are reverted (move items whose original path is occupied by a different item are skipped and reported). (Stories: P1-tasks, P1-move, P2-bulk)
- FR-051: If a write fails during a batch undo, items already reverted are restored to the state observed just before the undo began (so a forced undo never destroys an external edit) and the outcome is a failure; the entry stays undoable. (Stories: P1-tasks, P1-move, P2-bulk)
- FR-052: Batch entries persist across plugin reloads like existing entries, count as one entry toward the journal cap, and are bounded by a combined snapshot cap of 2 MB per entry, counting all stored content (before plus after for modify items; content for create/delete items), enforced by the tools at validation time. Older persisted data loads unchanged. (Stories: P1-tasks, P1-move, P2-bulk)
- FR-053: The chat Undo button works for the new tools exactly as for existing vault write tools; the divergence confirmation names the affected path(s) for batch entries. (Stories: P1-tasks, P1-move, P2-bulk)

Documentation
- FR-070: README documents the new tools, and the hard rule and its placeholder; CHANGELOG `Unreleased` lists them; proposal 0013 is added and indexed with Status In Progress, and set to Shipped with the PR link when the PR is opened. (Stories: all)

### Key Entities
- Batch Undo entry: one journal entry holding an ordered list of per-item operations (modify with before/after content, create with content, delete with prior content, move with from/to path).

### Cross-Cutting / Non-Functional
- Unit tests run in a DOM-free node environment; UI decision logic lives in pure sibling modules.
- Strict type-check stays clean; all existing tests stay green.
- No change to shell or MCP command execution.

## Success Criteria
- SC-001: Changing N tasks (N ≤ 200) across any number of notes requires exactly one approval prompt and produces exactly one Undo button. (FR-010–FR-014, FR-040)
- SC-002: A batch with any invalid target modifies zero notes. (FR-011, FR-022, FR-031)
- SC-003: After moving a note linked from K notes, all K links resolve to the new location; after Undo, all K resolve to the original. (FR-021, FR-025)
- SC-004: One Undo click on any new tool's call restores every affected note/path, or — on divergence without confirmation — changes nothing. (FR-050, FR-051, FR-053)
- SC-005: The default preamble contains the hard rule and names all new tools, and its size stays within the documented bound. (FR-001–FR-005)
- SC-007: Undo entries for the new tools survive a plugin reload. (FR-052)
- SC-008: Shell and other built-in tool permission decisions are unchanged versus before this work (same decisions for the same inputs; existing permission tests unchanged and green). (FR-044)
- SC-009: Approval previews for the new tools show per-target detail (lines, moves, or per-note counts). (FR-042)

## Assumptions
- One move tool rather than separate move/rename tools: a rename is a move within the same folder, and one batched tool is cheaper for the model to choose. The tool is named `move_note` (matching the brief) even though it accepts a list and non-markdown files/folders.
- `update_tasks` applies ONE patch to all targets (per the brief: "apply one change to a list of tasks"); per-target patches are out of scope. `expectedRawLine` is required per target (no description-substring fallback) to keep bulk re-anchoring safe.
- Partial-failure policy is validate-all-then-apply with rollback on write-time failure, for all three tools (brief preference).
- The preamble size bound is raised from 8 KB to 10 KB (current default preamble is ~6.9 KB; the rule block plus three tool entries add ~2 KB). Justification: safety-critical rule; still constant per vault.
- The rule also names "built-in file tools" alongside shell commands because the SDK's built-in file-edit tools bypass vault tools the same way.
- Bulk edit accepts `.md` and `.txt` notes only; other files stay with the generic edit tool.
- Folders created for a move destination are not removed on undo.
- The >5-item confirmation and ~10-tool-call thresholds come verbatim from the user's intended preamble wording in the brief, so they are kept even though they add a chat round-trip for large batches; the approval prompt is still a single step after that.
- Case-only renames are allowed; on case-insensitive file systems they are performed via Obsidian's rename like any other move.
- Batch snapshot cap of 2 MB per entry and the per-call caps (200 tasks, 100 moves, 50 notes / 5,000 replacements) are conservative limits that keep persisted data bounded.

## Scope
In Scope:
- Preamble hard rule (default + custom placeholder) and updated authoring guidance.
- `update_tasks`, `move_note`, `bulk_edit` tools with safety classification, multi-path allowlist handling, approval previews, and batch Undo (persisted).
- README, CHANGELOG (Unreleased), proposal 0013 + index.
Out of Scope:
- Any shell guard: rejecting, gating, or adding approval to shell commands that target the vault.
- Detecting or warning about vault changes made by shell or MCP calls. An earlier revision (FR-060–FR-065, User Story P3) specified a non-blocking warning; it was dropped after PR review because external calls may be expected to change the vault. The agent should prefer the vault tools without external writes being blocked or flagged.
- Operation-aware (line-level) undo (proposal 0012).
- Per-target patches in `update_tasks`; deleting/creating folders as standalone operations.
- Cutting a release.

## Dependencies
- Obsidian link-aware rename (file manager).
- Existing safety policy, Undo journal, and conversation persistence.

## Risks & Mitigations
- Model still uses the shell: impact — rule ignored. Mitigation: hard-rule wording and cheaper batch tools.
- Persisted snapshot bloat from batch entries: Mitigation: per-entry 2 MB cap and per-call caps; entry counts once toward the 50-entry cap.
- Partial writes on failure: Mitigation: validate-all-then-apply with rollback; atomic per-note writes.
- Link updates depend on the user's Obsidian setting ("Automatically update internal links"): Mitigation: documented; tool result notes that link updating follows Obsidian's setting.
- Preamble growth: Mitigation: bounded size test; bound raise justified in code.

## References
- Issue: none
- Brief: WorkflowContext.md Initial Prompt
- Related: proposals/0012-undo-under-contention.md
