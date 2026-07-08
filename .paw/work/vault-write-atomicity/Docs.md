# Vault Write Atomicity

## Overview

This work eliminated a lost-update race in four vault-mutating tools
that all shared the same read-modify-write shape. Under parallel
invocation against the same target file, only the last writer's
change survived — earlier callers' writes were silently overwritten.
The fix routes read-modify-write through Obsidian's atomic
`Vault.process` primitive.

**User-visible symptom** (the bug that motivated this): the model
issued five `create_task` calls in parallel to the same daily note,
and only two tasks landed. The other three were lost.

**Scope of the fix**:
- `create_task` — the existing-target append step is now atomic;
  the missing-target race is fixed via a create-or-tolerate-exists
  pattern (see below).
- `update_task` — the split → identify → patch → join compute step
  now runs inside the atomic callback.
- `edit_note` in `append` and `prepend` modes.
- `insert_into_active_note` — picks up the fix transitively through
  its disk-fallback delegation to `edit_note`.

**Intentionally NOT fixed**: `edit_note` in `replace` mode. Replace
is documented as last-writer-wins because the user may issue it
against a note with independent unrelated writes that they intend to
overwrite. FR-007 adds a manifest hint steering the model away from
issuing parallel `edit_note replace` calls on the same path.

## Architecture and Design

### High-Level Architecture

Before this fix, every affected tool implemented its own variant of:

```
1. Look up the target file
2. Read the current on-disk content
3. Compute the new content (append, prepend, patch, etc.)
4. Write the new content via `vault.modify(file, newContent)`
```

Steps 2 and 4 are asynchronous, and Obsidian's vault runs on the
same JavaScript event loop as the tools. If two tools interleaved
their reads before either wrote, both would compute their result
from the same "before" snapshot; the second `modify` would overwrite
the first's result. Classic read-modify-write race.

The fix collapses steps 2–4 into a single atomic section by using
Obsidian's `Vault.process(file, callback)` primitive (available
since Obsidian 1.1.0). `Vault.process` guarantees the callback sees
the current on-disk content and its return value is written back
before any other write to that same file can begin.

### The `processFileImpl` helper

`src/tools/WriteTools.ts` exports a new helper `processFileImpl`
that wraps `Vault.process` with the plugin's usual concerns:
- Path resolution and vault-relative normalization.
- The unsaved-editor-conflict guard (`hasUnsavedEditorChanges`) runs
  *before* the atomic section — it protects against user-typed
  content in an open editor, which is a separate concern from
  tool-vs-tool contention.
- Undo journal entry recording, with `before` captured from the
  callback INPUT and `after` from the callback RETURN. Under
  contention, this guarantees the undo entry reflects the exact
  transition that landed on disk.
- No-op skip: if the callback returns the input unchanged, no write
  occurs and no undo entry is recorded.
- `ProcessAbort` mechanism: the callback can throw
  `new ProcessAbort(reason)` to bail out with no write and no undo
  entry. `updateTaskImpl` uses this to signal "target line missing"
  or "not a task" without leaving a stale write.

### Why `Vault.process`, not a mutex?

We considered a per-path `Mutex` on top of the existing
`vault.modify` calls. `Vault.process` won for three reasons:
- **Native primitive**: `Vault.process` is Obsidian's supported
  atomic API. Third-party plugins that also write to the vault
  respect its serialization; a JavaScript-level mutex only
  serializes writes from within *this* plugin.
- **No abstraction layer needed**: no lock ownership, no timeout
  handling, no deadlock class to think about.
- **Same guard placement**: the `hasUnsavedEditorChanges` guard has
  to run outside any atomic section anyway (it's async;
  `Vault.process`'s callback is sync). A mutex would not have moved
  that guard.

`Vault.process` was added in Obsidian 1.1.0 and the plugin's
`manifest.json` sets `minAppVersion: 1.5.0`, so no floor bump is
needed.

### Missing-target race in `create_task`

`create_task` targets a daily note. If the daily note doesn't exist
yet, `createTaskImpl` creates it, seeds it with the daily-notes
template, then appends the task line. Under parallel invocation
against a not-yet-existing daily note, the create step itself was
racy:
- Caller A: `lookupTFile("2026-07-08.md")` returns null.
- Caller B: `lookupTFile("2026-07-08.md")` returns null.
- Caller A: `vault.create("2026-07-08.md", seed)` succeeds.
- Caller B: `vault.create("2026-07-08.md", seed)` throws "already exists".
- Caller B: bubbles up "Failed to create task target …" error.

The fix threads an `alreadyExists?: true` flag through
`createFileImpl`'s error result. `createTaskImpl` treats
`alreadyExists` as "a concurrent caller beat me to it" rather than
as a genuine failure: it re-looks up the file, then re-enters the
atomic append branch. Exactly one caller reports
`existingTargetCreated: true`; the rest report `false` and their
undo IDs point at the append entries (deleting only their own task
line on undo, which is correct).

Detection uses a narrow regex `/already exists|file exists|exists at|EEXIST/i`
with a negative guard on `no such file` to avoid misclassifying
unrelated errors.

### Test fake vaults

The three test files that construct fake vaults (`WriteTools.test.ts`,
`WriteNoteTools.test.ts`, `UpdateTask.test.ts`) each grew a
`process(file, fn)` implementation that mimics Obsidian's atomic
serialization: a per-path `Promise` chain queues concurrent
callbacks so the tests behave deterministically. Tests that assert
correctness under parallel calls rely on this behavior.

## User Guide

There is no user-facing API change. Existing tool calls work
exactly as before. The improvement is transparent under parallel
load.

Under the hood, when the model issues `Promise.all([...])` of five
`create_task` calls to the same daily note, all five tasks land in
the note in some order (order is implementation-defined; count is
guaranteed).

## Integration Points

- **`processFileImpl`** in `src/tools/WriteTools.ts` wraps
  `Vault.process` directly (no separate `ObsidianApi` wrapper — the
  helper accesses `vault.process` on the write-side vault shim
  because that's where the write pipeline lives). `WriteToolsVault`
  gained an optional `process?(file, fn)` field, always supplied in
  production wiring.
- **`ProcessAbort`** class is exported from `src/tools/WriteTools.ts`
  for callers that need to bail from inside their callback with a
  typed abort. It is thrown OUT of the atomic callback (not caught
  inside), so Obsidian's `Vault.process` skips the underlying
  `modify` entirely — true no-write abort, no spurious `modify`
  events.
- **Manifest hint** for `edit_note` in `src/domain/vaultToolManifest.ts`
  now explicitly warns against parallel `replace` calls. The SDK
  `defineTool("edit_note")` description mirrors the same guidance
  so the model sees it on both surfaces.

## Testing

New test patterns for concurrent-call regressions live in:
- `src/tools/WriteTools.test.ts` — `processFileImpl` fundamentals
  and a 20-way `Promise.all` linearization test.
- `src/tools/WriteNoteTools.test.ts` — 5 parallel appends, 3
  parallel prepends, 10 cross-file appends (no serialization),
  100 parallel `create_task` same-target (SC-001), 5 parallel
  missing-target race, 100 parallel `create_task` different targets
  (SC-002 wall-clock).
- `src/tools/UpdateTask.test.ts` — 3 parallel different-line
  patches, 2 parallel same-line non-overlapping patches, task_not_found
  via `ProcessAbort`.
- `src/domain/PreambleAssembler.test.ts` and
  `src/tools/WriteNoteTools.test.ts` — FR-007 hint assertions on
  both the preamble and SDK surfaces.

## Follow-ups / Future Work

- **Undo semantics under contention.** The `UndoJournal` uses
  snapshot-based modify entries (`before`/`after` on the full file
  content). Under contention, entries recorded by earlier callers
  become stale as soon as later successful writes land: a normal
  "undo" click safely declines with `divergence: "modified"`, but a
  force-undo would revert the whole file to that caller's snapshot,
  discarding the later writes. The missing-target `create_task`
  creator surfaces a `create` undo whose force-undo would delete the
  daily note. This is a pre-existing property of the snapshot-based
  undo journal (not a regression from this fix — before this fix,
  only one write per contention window succeeded so the effect
  didn't manifest). Redesigning to operation-aware inverses (revert
  only my appended block, only my patched line, etc.) is a candidate
  for a future release.
- **`usedFallback` is vestigial** for `edit_note` append/prepend on
  the atomic path — it is always `false`. The field is informational
  and left in place for return-shape compatibility.
- The `hint` string for `edit_note` is duplicated between the
  manifest and the SDK description. Extracting a shared constant
  would be a small future refactor if the guidance needs to evolve.
- `Vault.process` semantics for other concurrent plugin writers are
  Obsidian's responsibility; we do not attempt cross-plugin
  serialization ourselves. This is a deliberate scope choice.
