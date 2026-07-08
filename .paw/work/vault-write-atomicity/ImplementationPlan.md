# Vault Write Atomicity Implementation Plan

## Overview

Replace the read-then-modify pattern in four vault-write code paths with Obsidian's atomic `Vault.process(file, fn)` primitive, so concurrent tool calls against the same file no longer lose writes. The fix is scoped to the identified racy sites: `create_task`, `update_task`, `edit_note` (append/prepend), and `insert_into_active_note`'s disk-fallback branch. `edit_note replace` remains last-writer-wins by intent, guarded by a new tool-description hint that steers the model away from parallel replaces.

## Current State Analysis

Four sites do `read → compose → write` with no atomicity, allowing lost updates under `Promise.all`-style parallel tool invocation:

- `createTaskImpl` (`src/tools/WriteNoteTools.ts:601-650`) — reads target, composes `current + taskLine`, hands off to `editFileImpl`
- `updateTaskImpl` (`src/tools/UpdateTask.ts:120-158`) — reads whole file, patches one line, writes back via `editFileImpl`
- `editNoteImpl` (`src/tools/WriteNoteTools.ts:133-225`) — reads `before`, composes `after`, calls `modifyNote`/`editFileImpl`
- `insertIntoActiveNoteImpl` (`src/tools/WriteNoteTools.ts:258-299`) — inherits via `editNoteImpl` on disk-fallback branch

Obsidian ships `Vault.process(file, fn)` since 1.1.0; plugin `minAppVersion` is already 1.5.0 (`manifest.json:5`). Callback is synchronous `(data: string) => string`, returns `Promise<string>`. No new dependency required.

Three fake vaults exercise these paths (`src/tools/WriteNoteTools.test.ts:88-106`, `src/tools/UpdateTask.test.ts:47-66`, `src/tools/WriteTools.test.ts:31-69`); none implement `process` today.

## Desired End State

- `Vault.process` handles the RMW step for the four affected operations. Under `Promise.all` against the same file, every call's changes persist.
- `hasUnsavedEditorChanges` continues to run pre-write (outside the sync callback) — unchanged protection.
- Undo journal `before` snapshot is captured from the value passed *into* the process callback, not a stale pre-read.
- `edit_note` SDK tool description AND preamble hint both include an explicit "do not parallel-call `replace`" guidance line (FR-007).
- All existing tests pass unchanged. New regression tests exercise deterministic parallelism at each affected site.
- Point release `v0.10.2` published, CHANGELOG updated, BRAT users receive it via the same release pipeline used for v0.10.0 and v0.10.1.

**Verification approach**: `npm test`, `npm run typecheck`, `npm run build`, `npm run schema:check` all pass. Manual smoke test at the user's test vault: 5 parallel `create_task` calls land 5 distinct tasks.

## What We're NOT Doing

- Not touching `edit_note` `replace` mode's write path — semantics stay last-writer-wins by intent (FR-006).
- Not touching `create_note`'s create-race behavior — one-wins-one-errors is acceptable (Spec Out-of-Scope).
- Not introducing an in-process mutex or async-mutex npm dep — vendor primitive covers it.
- Not restructuring `ObsidianApi` beyond adding a single `processNote` wrapper.
- Not changing the `Vault` adapter types in ways that break unrelated callers.
- Not changing `minAppVersion` (FR-008 stays 1.5.0).
- Not filing a GitHub issue — this workflow is the source of truth.

## Phase Status

- [ ] **Phase 1: Vault.process foundation** — Add `process` to vault shims + `ObsidianApi.processNote`; extend fakes; wrapper tests.
- [ ] **Phase 2: Migrate edit_note append/prepend + insert_into_active_note disk fallback** — Route append/prepend RMW through `processNote`; deterministic parallelism test.
- [ ] **Phase 3: Migrate create_task and update_task** — Route their RMW steps through `processNote`; deterministic parallelism tests for both.
- [ ] **Phase 4: FR-007 hint + edit_note description update** — Update manifest hint and SDK description; assertion tests.
- [ ] **Phase 5: Documentation + release prep** — Docs.md, CHANGELOG, README (no BRAT-section change), version bump prep for v0.10.2.

## Phase Candidates

<!-- None planned; append here if any surface during implementation. -->

---

## Phase 1: Vault.process foundation

**Objective**: Land the plumbing so subsequent phases can atomically read-modify-write. No behavior change in production callers yet.

### Changes Required:

- **`src/tools/WriteTools.ts`**: Extend `WriteToolsVault` type with optional `process?(file: TFileLike, fn: (data: string) => string, options?: unknown): Promise<string>`. Preserve current `modify` field (both remain available; higher layers pick).
- **`src/tools/ObsidianApi.ts`**:
  - Extend `AppLike.vault` with the same optional `process` field.
  - Add `processNote(file, fn): Promise<ApiResult<string>>` next to `modifyNote` (`src/tools/ObsidianApi.ts:737-757`). Contract: `index-unavailable` when host lacks `process`; `native-failed` on throw; on success, `{ ok: true, value: writtenContent }`.
- **`src/tools/WriteTools.ts`**: Add a small helper `processFileImpl(rawPath, fn, deps)` that runs alongside `editFileImpl` (does not replace it). Same signature contract as `editFileImpl` (returns `ok`/`error`/`undoId`), but delegates the modify to `deps.vault.process(file, fn)` and captures `before`/`after` from the callback input + return for undo journal. Keeps the unsaved-editor-conflict guard as a pre-call step. Falls back to legacy `editFileImpl` if `deps.vault.process` is absent (defense in depth for exotic fakes; production always has it).
- **Fakes (three files)**: Add a `process(file, fn)` implementation to each fake vault, keyed by path with a per-path `Promise` chain to serialize concurrent calls deterministically. This ensures the fakes correctly simulate atomic semantics so the new regression tests reflect real production behavior.
  - `src/tools/WriteNoteTools.test.ts` (shared `makeDeps`)
  - `src/tools/UpdateTask.test.ts` (local `makeDeps`)
  - `src/tools/WriteTools.test.ts` (`makeVault`)
- **Tests**:
  - `src/tools/ObsidianApi.test.ts`: `processNote` forwards to `vault.process`; returns `index-unavailable` when absent; returns `native-failed` on throw; returns the written string on success.
  - `src/tools/WriteTools.test.ts`: `processFileImpl` records undo with `before` from callback input and `after` from callback return; falls back to `editFileImpl` when `process` absent; propagates the dirty-editor-conflict rejection.

### Success Criteria:

#### Automated Verification:
- [ ] `npm test -- src/tools/ObsidianApi.test.ts src/tools/WriteTools.test.ts` passes
- [ ] `npm run typecheck` passes
- [ ] Existing suite unaffected: `npm test` still green

#### Manual Verification:
- [ ] Read the new `processNote` wrapper: contract mirrors `modifyNote`'s style, and it's the only public API exposed to higher layers.
- [ ] `WriteToolsVault.process` is optional — no unrelated adapter or test-fake was forced to implement it in Phase 1.

---

## Phase 2: Migrate edit_note append/prepend + insert_into_active_note disk fallback

**Objective**: Fix the race in `editNoteImpl` for the append/prepend modes. `insert_into_active_note` picks up the fix transitively.

### Changes Required:

- **`src/tools/WriteNoteTools.ts`** (`editNoteImpl`, lines 133-225):
  - For `mode === "append"` and `mode === "prepend"`: call `processFileImpl` (new Phase-1 helper) with a callback that composes `before + content` or `content + before`. Undo `before` comes from the callback input.
  - For `mode === "replace"`: keep the existing `modifyNote` + `editFileImpl` fallback path unchanged. Documented as last-writer-wins.
  - The `hasUnsavedEditorChanges` guard stays exactly where it is (pre-write). Rationale: it protects against user-typed unsaved editor content; the atomic section protects against tool-vs-tool contention. Separate concerns.
- **`src/tools/WriteNoteTools.ts`** (`insertIntoActiveNoteImpl`, lines 258-299):
  - No direct changes; picks up the fix through `editNoteImpl`'s disk fallback branch. Editor-native branch (`applyEditorTransform`) remains unchanged.
- **Tests** (`src/tools/WriteNoteTools.test.ts`):
  - New: 5 parallel `edit_note` `append` calls against the same note → file contains all 5 appended blocks in some order, no losses.
  - New: 3 parallel `edit_note` `prepend` calls → all 3 prepends survive.
  - New: 3 parallel `insert_into_active_note` `append` calls on the disk-fallback branch → all 3 land.
  - Assertion: pre-existing tests for `editNoteImpl` still pass unchanged.
  - Assertion: `replace` mode still goes through the modify path (fake vault records `modify` calls; `process` calls are counted only for append/prepend).

### Success Criteria:

#### Automated Verification:
- [ ] `npm test -- src/tools/WriteNoteTools.test.ts` passes including new parallel tests
- [ ] `npm run typecheck` passes

#### Manual Verification:
- [ ] Under `Promise.all` of 5 `edit_note append`, resulting content shows all 5 blocks (order is implementation-defined; count is fixed at 5).
- [ ] `edit_note` on a note with dirty editor still fails with the unsaved-editor-conflict error.

---

## Phase 3: Migrate create_task and update_task

**Objective**: Fix the remaining two racy sites.

### Changes Required:

- **`src/tools/WriteNoteTools.ts`** (`createTaskImpl`, lines 517-673):
  - The existing-target append branch (lines 601-650) uses `processFileImpl` for the read+append+write step.
  - The missing-target branch (create the target file first) remains unchanged. Once the file exists, the append re-enters the atomic path.
  - `existingTargetCreated`, `createUndoId`, `undoSurface` semantics preserved.
- **`src/tools/UpdateTask.ts`** (`updateTaskImpl`, lines 100-171):
  - Move the entire compute step (split lines → identify target line → parse task → apply patch → join) *inside* the `processFileImpl` callback. If target line is not found or parse fails inside the callback, the callback returns the original data unchanged and the outer function reports the appropriate error via a captured status object (side-channel from the callback).
  - Rationale: the read must be atomic with the line-identification step so two concurrent updaters see each other's edits.
- **Tests** (`src/tools/WriteNoteTools.test.ts`, `src/tools/UpdateTask.test.ts`):
  - New: 5 parallel `create_task` calls to same target → 5 distinct task lines in file.
  - New: 3 parallel `create_task` calls with different formats (Tasks plugin off/on) → all 3 land with the correct format each.
  - New: 3 parallel `update_task` calls each patching a different task line in same file → all 3 patches persist.
  - New: 2 parallel `update_task` calls targeting the SAME line with non-overlapping field patches → resulting line has both patches applied (or last-field-wins for overlapping fields; document actual behavior).
  - Assertion: existing tests unchanged.

### Success Criteria:

#### Automated Verification:
- [ ] `npm test` passes; new parallelism tests present
- [ ] `npm run typecheck` passes
- [ ] `npm run build` succeeds

#### Manual Verification:
- [ ] User's original bug reproduces on `git checkout main` and is gone on this branch (smoke-test in `copilot-test` vault: 5 parallel `create_task` → 5 tasks).
- [ ] Undo click on a single `create_task`/`update_task`/`edit_note` result reverses only that operation.

---

## Phase 4: FR-007 hint + edit_note description update

**Objective**: Steer the model away from parallel `edit_note replace` calls.

### Changes Required:

- **`src/domain/vaultToolManifest.ts`** (`edit_note` entry, ~lines 108-118): Extend the `hint` field to include: "`replace` overwrites the whole note; do not issue parallel `edit_note replace` calls against the same path (only one write survives). Serialize them, or use `append`/`prepend` when preserving existing content matters."
- **`src/tools/WriteNoteTools.ts`** (SDK `defineTool("edit_note", { description })`, lines 717-742): Mirror the same guidance in the SDK-visible description so the model sees it in both surfaces.
- **Tests**:
  - `src/domain/PreambleAssembler.test.ts`: Assertion that the rendered preamble line for `edit_note` includes the "parallel `edit_note replace`" phrase.
  - `src/tools/WriteNoteTools.test.ts`: Assertion that the `edit_note` tool's SDK description includes the same phrase.

### Success Criteria:

#### Automated Verification:
- [ ] `npm test -- src/domain/PreambleAssembler.test.ts src/tools/WriteNoteTools.test.ts` passes with new assertions

#### Manual Verification:
- [ ] Rendered `## Vault tools` preamble section shows the updated `edit_note` hint at the top of a fresh chat.

---

## Phase 5: Documentation + release prep

**Objective**: Land Docs.md, update CHANGELOG, prepare v0.10.2 files. The actual `git tag`/GitHub release is orchestrated post-PR-merge by the release skill; this phase just gets the source tree ready.

### Changes Required:

- **`.paw/work/vault-write-atomicity/Docs.md`**: Technical reference — atomic RMW architecture, why `Vault.process` was chosen over a mutex, testing pattern for concurrent-call regressions. Load `paw-docs-guidance`.
- **`CHANGELOG.md`**: Prepend a v0.10.2 section describing the fix and the FR-007 hint. Same bullet style as v0.10.1 and v0.10.0.
- **`docs/agent-vault-tools.md`**: Add a one-line note under `edit_note` that `replace` should not be issued in parallel; single sentence, matches new hint.
- **`README.md`**: No structural change needed. Version-string bump happens automatically via `npm run release:prepare 0.10.2` in the release flow, not here.
- **`package.json` / `manifest.json` / `versions.json`**: NOT touched in this phase — version bump is done immediately before release-tag, following the same "bump within feature branch, merge, tag" pattern used for v0.10.1.

### Success Criteria:

#### Automated Verification:
- [ ] `npm test` — all suites (target ≥1611 tests: 1605 + ~6 new)
- [ ] `npm run typecheck`
- [ ] `npm run build`
- [ ] `npm run schema:check` (if it still exists and applies)

#### Manual Verification:
- [ ] Docs.md reads like an "as-built" reference for a maintainer investigating this fix later
- [ ] CHANGELOG entry mentions the user-visible symptom (lost tasks under parallel create) and the FR-007 hint change

---

## References

- Issue: none (workflow is source of truth)
- Spec: `.paw/work/vault-write-atomicity/Spec.md`
- Research: `.paw/work/vault-write-atomicity/CodeResearch.md`
- Prior release runbook: `RELEASING.md`, `.copilot/agents/release/`
