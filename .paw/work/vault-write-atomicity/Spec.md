# Feature Specification: Vault Write Atomicity

**Branch**: feature/vault-write-atomicity  |  **Created**: 2026-07-08  |  **Status**: Draft
**Input Brief**: Fix lost-update race in read-modify-write vault write tools so parallel tool calls no longer clobber each other.

## Overview

When the agent invokes multiple vault-write tools in parallel against the same note — the model's default behavior today for batched operations like "create these five tasks" — some of the writes silently disappear. Only the last-written call's changes survive. The user reproduced this by asking the agent to add five follow-up tasks to today's daily note; only two survived, and the last three (which the model issued in parallel) overwrote each other. This is not a display glitch or a caching artifact: the tasks never make it to disk.

Users experience this as data loss. They asked for five tasks; they got two. The tools involved report success. The agent has no way to know a race occurred and no way to retry, because from its perspective every tool call completed successfully. This trust-erodes the whole "let the agent manage my vault" experience — if the user has to check what actually landed after every batched operation, the tools are worse than useless.

The fix must guarantee that every successful tool call's changes persist to disk when multiple tools race against the same file — no lost writes, no silent overwrites, no user-visible symptoms distinguishable from serialized execution. This is a correctness bug, not a performance one; the acceptable "cost" of the fix is that concurrent writes to the same file serialize.

## Objectives

- Every successful write from a vault-mutating tool call persists to disk, even when other tool calls target the same file concurrently.
- Parallel writes to *different* files still run in parallel — the fix must not serialize the whole vault.
- Tool return values remain unchanged; the fix is transparent to callers (the agent, the SDK, tests).
- The user-visible guard for unsaved-editor conflicts (dirty open editor) continues to function; the fix does not weaken that protection.

## User Scenarios & Testing

### User Story P1 – Batched task creation preserves every task

**Narrative**: The user asks the agent to record follow-ups from a meeting transcript. The agent identifies five action items and issues five `create_task` calls in parallel (its natural pattern for independent operations). After the calls return, the daily note contains all five tasks in the order the calls resolved.

**Independent Test**: Issue N parallel `create_task` calls against the same target daily note; assert N task lines land in the file, all distinct, all preserved.

**Acceptance Scenarios**:
1. Given an empty daily note, When 5 concurrent `create_task` calls target it, Then all 5 task lines appear in the file after the last call resolves.
2. Given a daily note with existing tasks, When 3 concurrent `create_task` calls append new tasks, Then the existing tasks are preserved and all 3 new tasks appear.
3. Given N concurrent calls, When they all report `ok: true`, Then the file contains exactly N new task lines (no duplicates, no losses).

### User Story P2 – Batched task updates don't clobber each other

**Narrative**: The user asks the agent to mark three specific tasks as done. The agent issues three `update_task` calls in parallel against the same daily note. All three tasks flip to `- [x]`; none revert.

**Independent Test**: Issue N parallel `update_task` calls targeting different lines in the same file; assert all N line edits persist.

**Acceptance Scenarios**:
1. Given a note with 5 open tasks, When 3 concurrent `update_task` calls each mark a different task done, Then the file shows exactly those 3 tasks as done and the other 2 unchanged.
2. Given two `update_task` calls that patch different fields on the *same* task line, When they race, Then the final line reflects both patches (or one is cleanly rejected — never a silent overwrite that discards one patch's fields).

### User Story P3 – Batched note edits don't lose content

**Narrative**: The agent appends two independent sections to the same note in parallel (e.g., "meeting notes" and "action items" from a transcript). Both sections end up in the file.

**Independent Test**: Issue N parallel `edit_note append` (or `prepend`) calls against the same note; assert all N appended blocks are present.

**Acceptance Scenarios**:
1. Given a note with existing content, When 2 concurrent `edit_note append` calls add distinct blocks, Then both blocks are present in the final file and the original content is preserved.
2. Given N concurrent `insert_into_active_note append` calls falling back to the disk path (no active editor), Then all N insertions land in the file.

### Edge Cases

- **`edit_note replace` mode**: parallel `replace` calls are inherently "last writer wins" by intent (the user asked to *replace* the content). No atomicity guarantee is offered for parallel replaces; only append/prepend/patch-line modes are protected.
- **Two calls target the same task line via `update_task`**: the second-to-run sees the first's already-applied edits (because the read happens inside the atomic RMW). Either both patches merge (if fields don't overlap) or the second's patch overrides the first's (last-writer-wins *at the field level*, no line loss).
- **Concurrent write to a file that was just created by another concurrent call**: the second call sees the fresh file content and appends to it — no "file disappeared" error.
- **User is actively typing in the open editor while the tool call is in flight**: the unsaved-editor-conflict guard continues to detect the dirty buffer and reject the write, preserving the user's in-progress edits. The fix does not touch this guard.
- **Concurrent writes to *different* files**: run fully in parallel; no cross-file serialization.

## Requirements

### Functional Requirements

- FR-001: When multiple vault-mutating tool calls target the same file concurrently, each successful call's changes MUST be present in the final on-disk content. (Stories: P1, P2, P3)
- FR-002: When vault-mutating tool calls target different files, they MUST NOT serialize on each other. (Stories: P1, P2, P3)
- FR-003: The observable return contract of the affected tools (success/failure signal, undo handle, target path, error message) MUST remain semantically identical to the pre-fix behavior. (Stories: P1, P2, P3)
- FR-004: The unsaved-editor-conflict guard MUST continue to reject writes when the target file has unsaved changes in an open editor. (Stories: P1, P2, P3 — protects the guard invariant they all rely on)
- FR-005: The atomicity guarantee applies to the following tool operations: `create_task`, `update_task`, `edit_note` in `append`/`prepend` modes, and `insert_into_active_note` when it writes to disk. (Stories: P1, P2, P3)
- FR-006: `edit_note` in `replace` mode is documented as last-writer-wins by intent; no atomicity guarantee is added for this mode. (Stories: P3 — bounds the guarantee for that story)
- FR-007: The `edit_note` tool description surfaced to the model MUST warn against issuing concurrent `replace` calls against the same file, and MUST recommend either serializing them or using `append`/`prepend` when data preservation is needed. (Stories: P3)
- FR-008: The fix MUST NOT change the plugin's declared minimum Obsidian app version. (Stories: P1, P2, P3 — compatibility floor for all users)
- FR-009: Undo journal entries recorded by the affected tools MUST remain valid — a single undo click reverses the tool's effect exactly as before. (Stories: P1, P2, P3)

### Key Entities

- **Vault-relative path**: the normalized string used to identify a file within the vault. Case-sensitive.

### Cross-Cutting / Non-Functional

- **No regression in single-call latency**: an uncontended tool call completes within 105% of its pre-fix wall-clock time (i.e., ≤ 5% overhead) on the existing benchmark shape.
- **Bounded contention overhead**: under high contention on a single file, wall-clock time for N calls scales linearly in N (i.e., serialized execution), not quadratically.

## Success Criteria

- SC-001: 100 concurrent `create_task` calls to the same target note result in 100 distinct task lines in the file. (FR-001)
- SC-002: 100 concurrent `create_task` calls to 100 distinct target notes complete in wall-clock time no greater than 2× a single-call baseline (i.e., no cross-file serialization penalty). (FR-002)
- SC-003: The plugin's existing test suite passes without modification to production-code contracts (test additions permitted; test rewrites for behavior changes are not). (FR-003)
- SC-004: A deterministic-parallelism regression test exercises the race on the *pre-fix* code (fails) and the post-fix code (passes) for each of the four affected tool operations. (FR-005)
- SC-005: A vault-write call against a note with a dirty open editor is still rejected with the unsaved-editor-conflict error. (FR-004)
- SC-006: The `edit_note` tool description surfaced to the model contains explicit anti-parallel-replace guidance, verified by an assertion test on the tool manifest. (FR-007)
- SC-007: The plugin's declared minimum Obsidian app version is unchanged relative to the pre-fix release. (FR-008)

## Assumptions

- **The host application exposes an atomic read-modify-write mechanism at or below the plugin's declared minimum app version.** No new dependency is required. (Implementation choice is documented in CodeResearch.)
- **The user-perceived correctness bar is "no lost writes", not "linearizable ordering with strong isolation".** If two `update_task` calls concurrently patch different fields of the same task line, either merge or last-field-wins semantics is acceptable — the anti-goal is silent line loss.
- **The fix is scoped to in-process races.** Two host instances opening the same vault simultaneously is out of scope.
- **Async work performed by the tools (guard checks, active-editor lookup) can be arranged around the atomic section** — it does not need to run inside it.

## Scope

**In Scope**:
- Atomic write behavior for `create_task`, `update_task`, `edit_note` in `append`/`prepend` modes, and `insert_into_active_note`'s disk-fallback path.
- Regression tests exercising deterministic parallelism against each affected tool.
- Tool-description update for `edit_note` steering the model away from parallel `replace` calls.
- CHANGELOG entry and point release.

**Out of Scope**:
- `create_note` behavior when two concurrent calls target the same new path. Current behavior (one succeeds, the other reports an error) is acceptable.
- Atomicity for `edit_note replace` — last-writer-wins matches the mode's stated intent.
- Cross-process (multi-instance) coordination.
- Multi-file transactions (all-or-nothing across multiple file writes).
- Performance tuning beyond the non-regression bound in Cross-Cutting / Non-Functional.
- New third-party dependencies for locking.

## Dependencies

- Atomic read-modify-write capability on the host's vault interface. (Implementation choice documented in CodeResearch.)
- No new npm dependencies.

## Risks & Mitigations

- **Risk: the atomic RMW primitive has subtle behavior differences from the existing read-then-modify path.** Impact: silent regression in a well-covered code path. Mitigation: run the existing test suite unchanged; add targeted tests for edge cases (empty file, missing file, file created inside the callback race window). Details in CodeResearch.
- **Risk: test fakes for the vault interface don't implement the atomic primitive.** Impact: many tests break. Mitigation: extend the shared vault test-fake to expose it with deterministic single-flight semantics per path.
- **Risk: the unsaved-editor-conflict guard becomes ineffective because it runs outside the atomic section.** Impact: dirty editor buffer could theoretically be overwritten in a narrow window. Mitigation: the guard protects against *user-typed-but-unsaved* content, not tool-vs-tool contention; the host's own editor-file conflict detection handles the case where the user types during the atomic section. This analysis is documented in CodeResearch.
- **Risk: undo-journal double-recording under high contention.** Impact: a single undo click reverses more than the tool intended. Mitigation: record the journal entry based on the `before → after` transition observed atomically inside the critical section, not from a pre-read snapshot.

## References

- Reported by user via smoke test on 2026-07-08: five task-creation calls issued in parallel; only two survived.
- Related prior work: the v0.10.0 release added read-side vault-navigation tools; this feature addresses the correctness gap in the write-side counterparts.
