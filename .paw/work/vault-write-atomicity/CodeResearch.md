---
date: 2026-07-08T11:30:17.452-07:00
git_commit: 7f1eb2f8839f2cabf32ddc0271f0491e36ac3657
branch: feature/vault-write-atomicity
repository: obsidian-copilot-agent
topic: "Vault Write Atomicity"
tags: [research, codebase, vault-tools, atomicity, obsidian]
status: complete
last_updated: 2026-07-08
---

# Research: Vault Write Atomicity

## Research Question

Map the existing read-compose-write paths for `create_task`, `update_task`, `edit_note` append/prepend, and `insert_into_active_note` disk fallback, and document the existing Vault abstractions, Obsidian `Vault.process` contract, undo-journal semantics, tests, and tool-manifest hint pipeline needed to implement atomic vault writes.

## Summary

The four affected write paths currently read file content, compose a full replacement string, then call `vault.modify` through `ObsidianApi.modifyNote` or `editFileImpl`, so concurrent operations against the same file can compute from the same `before` snapshot and overwrite one another (`src/tools/WriteNoteTools.ts:155-179`, `src/tools/WriteNoteTools.ts:198-216`, `src/tools/WriteTools.ts:158-202`, `src/tools/WriteNoteTools.ts:601-650`, `src/tools/UpdateTask.ts:120-158`). The plugin already depends on `obsidian@^1.5.0` (`package.json:37-43`) and the manifest requires Obsidian `1.5.0` (`manifest.json:4-5`); the vendored Obsidian API exposes `Vault.process(file, fn, options?)` since `1.1.0`, with a synchronous callback and `Promise<string>` return (`node_modules/obsidian/obsidian.d.ts:7404-7418`).

## Documentation System

- **Framework**: Plain Markdown docs; no docs build framework or navigation config found in root config files. Root scripts are build/test/typecheck/release oriented (`package.json:8-28`).
- **Docs Directory**: `docs/`, with user-facing markdown such as `docs/agent-vault-tools.md` (`docs/agent-vault-tools.md:1-14`).
- **Navigation Config**: N/A; the README links docs directly, e.g. `docs/agent-vault-tools.md` (`README.md:19-28`).
- **Style Conventions**: Markdown headings, prose bullets, tables, and inline code are used in docs (`README.md:1-28`, `docs/agent-vault-tools.md:16-29`, `docs/agent-vault-tools.md:33-53`).
- **Build Command**: N/A for docs. Project build command is `npm run build` (`package.json:8-12`).
- **Standard Files**: `README.md`, `CHANGELOG.md`, `RELEASING.md`, and `docs/*.md` exist; `README.md` is the entry point (`README.md:1-17`).

## Verification Commands

- **Test Command**: `npm test` (`package.json:8-13`).
- **Lint Command**: No lint script is declared (`package.json:8-28`).
- **Build Command**: `npm run build` (`package.json:8-10`).
- **Type Check**: `npm run typecheck` (`package.json:8-12`).
- **Vitest Config**: `vitest.config.ts` aliases `obsidian` to `src/test/obsidianMock.ts` and includes `src/**/*.test.ts` (`vitest.config.ts:4-18`).

## Current State

### Racy site 1: `create_task` → `createTaskImpl`

- `createTaskImpl` computes defaults, validates input, resolves the target daily/custom note path, chooses Tasks-plugin vs GFM format, and builds the task line before any target content read (`src/tools/WriteNoteTools.ts:517-555`).
- For a missing target, it may ensure the parent folder, read the daily-note template, and call `createFileImpl` to create the target; this creation path is outside the append race being fixed for existing target files (`src/tools/WriteNoteTools.ts:567-599`).
- The append race is the sequence: look up target file, read `current` via `vault.read`/`cachedRead`, guard unsaved editor changes using that `current`, compute separator and `nextContent`, then call `editFileImpl(targetPath, nextContent, deps)` (`src/tools/WriteNoteTools.ts:601-650`).
- `editFileImpl` then performs its own read/guard/modify/record sequence for the full `nextContent`, which means the content composed by `createTaskImpl` can be based on a stale read before the final `vault.modify` (`src/tools/WriteTools.ts:158-202`).

### Racy site 2: `update_task` → `updateTaskImpl`

- `updateTaskImpl` validates and resolves the target file, reads the whole file via `deps.vault.read` or `deps.vault.cachedRead`, and returns `read_failed` if no reader is present (`src/tools/UpdateTask.ts:100-127`).
- It splits the previously-read content, identifies the target line, parses and patches the task, replaces `lines[idx]`, joins `newContent`, and calls `editFileImpl(vaultRel, newContent, deps)` (`src/tools/UpdateTask.ts:129-158`).
- The write is non-atomic with respect to the earlier read because `editFileImpl` writes a complete replacement string after its own read/guard step (`src/tools/WriteTools.ts:158-202`).

### Racy site 3: `edit_note` append/prepend → `editNoteImpl` / `editFileImpl`

- `editNoteImpl` resolves and looks up the note, reads `before` with `vault.read` or `cachedRead`, then composes `after` as `before + content` for append, `content + before` for prepend, or `content` for replace (`src/tools/WriteNoteTools.ts:133-179`).
- It runs `hasUnsavedEditorChanges(vaultRel, before, deps.workspace)`, then calls `deps.api.modifyNote(file, after)` and records an undo entry with the pre-read `before` and composed `after` if the richer surface succeeds (`src/tools/WriteNoteTools.ts:181-215`).
- If the richer surface fails, it falls back to `editFileImpl(rawPath, after, deps)`, which reads `before` again, checks the same dirty-editor guard, calls `deps.vault.modify(file, content ?? "")`, and records `before`/`after` after the modify (`src/tools/WriteNoteTools.ts:216-225`, `src/tools/WriteTools.ts:158-202`).
- For append/prepend, the stale-read risk is the `before` used to compose `after`; replace is intentionally full-content replacement per the spec (`Spec.md:54-57`).

### Racy site 4: `insert_into_active_note` → transitively via `editNoteImpl`

- `insertIntoActiveNoteImpl` resolves the active path, then tries the live editor surface first: `getEditorForActive()`, `applyEditorTransform(mode, content)`, and returns `undoSurface: "editor-native"` on success (`src/tools/WriteNoteTools.ts:258-290`).
- When the editor transform is not used or fails, the disk fallback calls `editNoteImpl(activePath, mode, content, deps)`, so the same `editNoteImpl` read-compose-write path applies (`src/tools/WriteNoteTools.ts:292-299`, `src/tools/WriteNoteTools.ts:155-216`).
- Therefore, when `applyEditorTransform` handles the edit, the disk RMW is skipped; the race only affects the disk-fallback branch (`src/tools/WriteNoteTools.ts:280-299`).

## Constraints

### Vault interface shape and adding `process`

- The read-side plugin vault shim is `ReadToolsVault`, which exposes `adapter.getBasePath`, file lookup/list methods, `read`, and `cachedRead` (`src/tools/ReadTools.ts:10-23`).
- The write-side shim `WriteToolsVault` extends `ReadToolsVault` and currently adds optional `create`, `createFolder`, `modify`, `delete`, and `trash` (`src/tools/WriteTools.ts:11-31`).
- Path resolution uses a narrower `VaultLike` with `adapter.getBasePath`, `getAbstractFileByPath`, and `getFileByPath` (`src/tools/VaultPath.ts:17-27`).
- `ObsidianApi.AppLike.vault` currently adds only optional `create` and `modify` over `ReadToolsVault` (`src/tools/ObsidianApi.ts:114-122`).
- `UndoJournalVault` structurally accepts lookup, read/cachedRead, create, modify, delete, and trash; it does not need `process` for current undo/redo operations (`src/domain/UndoJournal.ts:83-96`).
- Adding `process(file, fn)` for production/testability requires extending `WriteToolsVault` and `AppLike.vault`; tests with hand-rolled fake vaults that exercise write paths must implement compatible behavior (`src/tools/WriteTools.ts:19-31`, `src/tools/ObsidianApi.ts:118-122`, `src/tools/WriteNoteTools.test.ts:88-106`, `src/tools/UpdateTask.test.ts:47-66`).

### Obsidian real `Vault.process` API contract

- The vendored `obsidian.d.ts` describes `process` as: "Atomically read, modify, and save the contents of a note" (`node_modules/obsidian/obsidian.d.ts:7404-7408`).
- Signature: `process(file: TFile, fn: (data: string) => string, options?: DataWriteOptions): Promise<string>` (`node_modules/obsidian/obsidian.d.ts:7415-7418`).
- The callback returns the new content synchronously; it is typed `(data: string) => string`, not async (`node_modules/obsidian/obsidian.d.ts:7405-7418`).
- Return value is the text value written, as `Promise<string>` (`node_modules/obsidian/obsidian.d.ts:7408-7418`).
- `@since 1.1.0`; the plugin manifest requires `minAppVersion` `1.5.0`, and `package.json` uses `obsidian` dev dependency `^1.5.0` (`node_modules/obsidian/obsidian.d.ts:7415-7418`, `manifest.json:4-5`, `package.json:37-43`).

### `ObsidianApi.modifyNote`

- `ObsidianApi` is a narrow, test-friendly wrapper around Obsidian app surfaces; it avoids importing the runtime `App` class and returns discriminated `ApiResult` unions (`src/tools/ObsidianApi.ts:1-21`, `src/tools/ObsidianApi.ts:26-42`).
- `modifyNote(file, content)` checks for `vault.modify`, returns `index-unavailable` if absent, calls `vault.modify(file, content)` if present, and maps thrown errors to `native-failed` (`src/tools/ObsidianApi.ts:737-757`).
- Tests assert that `modifyNote` forwards to `vault.modify` and reports `index-unavailable` when `modify` is absent (`src/tools/ObsidianApi.test.ts:742-767`).
- There is no corresponding `processNote` wrapper today; the only write wrappers in this region are `createNote` and `modifyNote` (`src/tools/ObsidianApi.ts:713-757`).

### Unsaved-editor-conflict guard

- `hasUnsavedEditorChanges(vaultRel, diskContent, workspace)` lives in `src/tools/WriteTools.ts` and scans markdown leaves from `workspace.getLeavesOfType("markdown")` (`src/tools/WriteTools.ts:110-123`).
- For each leaf, it checks `view.file.path === vaultRel`, reads `view.getViewData()` when present, and returns `true` when the editor buffer differs from the supplied disk content (`src/tools/WriteTools.ts:123-134`).
- The existing write paths run this guard before modifying: `editFileImpl` does so after reading `before` and before `vault.modify` (`src/tools/WriteTools.ts:158-188`), `editNoteImpl` replicates it before the richer `modifyNote` path (`src/tools/WriteNoteTools.ts:181-198`), and `createTaskImpl` does so before composing the appended task (`src/tools/WriteNoteTools.ts:628-650`).
- The guard is about dirty editor buffer versus on-disk content for the same path; keeping it outside the atomic `process` callback preserves the same pre-write rejection behavior because the callback itself is synchronous and cannot await workspace/editor reads (`src/tools/WriteTools.ts:116-134`, `node_modules/obsidian/obsidian.d.ts:7405-7418`).

### UndoJournal recording semantics

- `createFileImpl` records a `kind: "create"` undo entry after `deps.vault.create` succeeds, with only `after` content because there is no prior file (`src/tools/WriteTools.ts:93-107`).
- `editFileImpl` reads `before`, calls `deps.vault.modify(file, content ?? "")`, then records a `kind: "modify"` entry with `before` and `after` snapshots after the modify succeeds (`src/tools/WriteTools.ts:158-202`).
- `createNoteImpl` records `kind: "create"` after `deps.api.createNote` succeeds (`src/tools/WriteNoteTools.ts:98-119`).
- `editNoteImpl` records `kind: "modify"` after the richer `modifyNote` succeeds using the pre-read `before` and composed `after`; fallback delegates recording to `editFileImpl` (`src/tools/WriteNoteTools.ts:198-225`).
- `updateTaskImpl` returns the undo id from `editFileImpl` (`src/tools/UpdateTask.ts:158-171`); `createTaskImpl` returns the create-entry undo id when it created the target, otherwise the append modify-entry undo id from `editFileImpl` (`src/tools/WriteNoteTools.ts:650-673`).
- For a `process`-based modify path, the `before` and `after` snapshots for append/prepend/task update need to be derived from the content observed and returned by the `process` callback; the existing record call can still occur after the write succeeds, matching current record-after-modify behavior (`src/tools/WriteTools.ts:187-202`, `node_modules/obsidian/obsidian.d.ts:7404-7418`).

### Test fakes and smallest `process()` addition

- `WriteNoteTools.test.ts` has a shared `makeDeps(world)` fake where `app.vault` exposes `adapter`, `getAbstractFileByPath`, `read`, `cachedRead`, `create`, and `modify`; `UndoJournal` receives this fake vault (`src/tools/WriteNoteTools.test.ts:55-144`).
- `makeWorld` stores fake files in `Map<string, FakeFile>` with mutable `content`, plus active editor state and vault-awareness settings (`src/tools/WriteNoteTools.test.ts:39-53`, `src/tools/WriteNoteTools.test.ts:146-156`).
- `UpdateTask.test.ts` has a similar local `makeDeps(world)` fake with `adapter`, lookup, `read`, `cachedRead`, `create`, and `modify` (`src/tools/UpdateTask.test.ts:47-85`).
- Lower-level `WriteTools.test.ts` has `makeVault(initialFiles)` returning `WriteToolsVault` over a `Map<string, string>`, with lookup/list, `read`, `cachedRead`, `create`, `modify`, and `trash` (`src/tools/WriteTools.test.ts:31-69`).
- The smallest working fake addition is an optional `process(file, fn)` that reads the current map entry for `file.path`, calls `fn(current)` synchronously, stores/writes the returned string, and returns the written string; for deterministic contention tests the fake can queue per path so concurrent calls serialize at the fake vault boundary (`src/tools/WriteNoteTools.test.ts:88-106`, `src/tools/UpdateTask.test.ts:49-66`, `src/tools/WriteTools.test.ts:36-68`, `node_modules/obsidian/obsidian.d.ts:7404-7418`).

### Existing parallelism/racing tests

- The repository already uses `Promise.all` for concurrency behavior in tests, including `TokenStore.test.ts` concurrent `setToken` calls (`src/auth/TokenStore.test.ts:73-83`).
- `McpManager.mvr.test.ts` verifies a single-flight initialize path by starting two enable calls, releasing both, then awaiting `Promise.all([a, b])` (`src/mcp/McpManager.mvr.test.ts:8-18`).
- Other test files also use `Promise.all`/`Promise.allSettled` for lifecycle and persistence concurrency paths (`src/sdk/ModelCatalog.test.ts:203`, `src/sdk/AgentSession.test.ts:317`, `src/persistence/ConversationsStore.test.ts:371`).

### Vault-tool manifest and FR-007 hint pipeline

- `vaultToolManifest.ts` defines `VaultToolEntry` with singular `hint`, plus `name` and `readOnly`; the comment says this is the single source of truth for names and one-line usage hints in the preamble inventory (`src/domain/vaultToolManifest.ts:1-26`).
- The `edit_note` manifest entry currently has hint text: "Edit an existing note in append, prepend, or replace mode. Preserves unsaved-editor-conflict guard." It does not mention concurrent `replace` calls (`src/domain/vaultToolManifest.ts:108-118`).
- v0.10 navigation/read entries use the same `hint` field pattern for preamble-visible guidance, with comments noting hint text refinement for the session-start inventory (`src/domain/vaultToolManifest.ts:181-207`).
- `ALL_VAULT_TOOL_ENTRIES` includes write-note entries before raw fallback entries (`src/domain/vaultToolManifest.ts:209-217`).
- `PreambleAssembler` builds the visible `## Vault tools` block by mapping each entry to `- \`name\`: hint`, adding `(R/O)` or `(fallback)` tags (`src/domain/PreambleAssembler.ts:158-187`).
- `PreambleAssembler.test.ts` asserts v0.10 capabilities appear once each with distinguishable hint lines and grabs each hint line from the inventory text (`src/domain/PreambleAssembler.test.ts:155-187`).
- The SDK tool description for `edit_note` is assembled separately in `createWriteNoteTools`, and currently describes append/prepend/replace plus missing/unsaved-change failures without concurrent replace guidance (`src/tools/WriteNoteTools.ts:717-742`).

## Options

### A. Use Obsidian `vault.process` for affected same-file read-compose-write operations

- **How it maps to source**: Add a thin `ObsidianApi.processNote(file, fn)` wrapper next to `modifyNote`, add `process` to `WriteToolsVault`/`AppLike.vault`, and move append/prepend/task-update composition into `process` callbacks (`src/tools/ObsidianApi.ts:737-757`, `src/tools/WriteTools.ts:19-31`, `src/tools/WriteNoteTools.ts:155-216`, `src/tools/UpdateTask.ts:120-158`).
- **Pros**: Uses Obsidian's documented atomic note RMW primitive; preserves per-file host-level serialization; no new dependency; compatible with current `minAppVersion` (`node_modules/obsidian/obsidian.d.ts:7404-7418`, `manifest.json:4-5`).
- **Cons**: Callback is synchronous, so async validations/editor checks must remain outside; tests must update fake vaults (`node_modules/obsidian/obsidian.d.ts:7405-7418`, `src/tools/WriteNoteTools.test.ts:88-106`).

### B. Add a plugin-level per-path mutex around existing reads and modifies

- **How it maps to source**: Wrap existing `editNoteImpl`, `createTaskImpl`, `updateTaskImpl`, and `editFileImpl` RMW sequences in an in-process lock keyed by vault-relative path (`src/tools/WriteNoteTools.ts:133-225`, `src/tools/WriteNoteTools.ts:517-673`, `src/tools/UpdateTask.ts:100-171`, `src/tools/WriteTools.ts:137-202`).
- **Pros**: Keeps current `vault.read`/`vault.modify` contracts and test fakes mostly intact (`src/tools/ReadTools.ts:15-23`, `src/tools/WriteTools.ts:19-31`).
- **Cons**: Only serializes callers that go through this plugin's lock; it duplicates behavior available in Obsidian's native API and requires lifecycle cleanup for lock bookkeeping.

### C. Hybrid: use `vault.process` when available, fall back to per-path mutex otherwise

- **How it maps to source**: Feature-detect `process` in `ObsidianApi`/`WriteToolsVault`; use native atomic RMW when present and lock the legacy `read`/`modify` sequence otherwise (`src/tools/ObsidianApi.ts:743-757`, `src/tools/WriteTools.ts:158-202`).
- **Pros**: Gives a compatibility path for tests/fakes or older app surfaces (`src/tools/ObsidianApi.ts:747-750`).
- **Cons**: The plugin already requires Obsidian `1.5.0`, above `process`'s `@since 1.1.0`, so the fallback adds code paths not needed by the declared runtime floor (`manifest.json:4-5`, `node_modules/obsidian/obsidian.d.ts:7415-7418`).

## Recommended Approach

Use **Option A: `vault.process` everywhere the affected operations perform read-compose-write**, behind a thin `ObsidianApi.processNote(file, fn)` wrapper for testability. Keep `hasUnsavedEditorChanges` outside the atomic callback, because it depends on async workspace/editor inspection while `Vault.process` requires a synchronous callback (`src/tools/WriteTools.ts:116-134`, `node_modules/obsidian/obsidian.d.ts:7405-7418`). For undo, compute `before` and `after` within the process callback and record the journal entry after the process promise resolves, preserving current record-after-success semantics (`src/tools/WriteTools.ts:187-202`, `src/tools/WriteNoteTools.ts:198-206`).

## Impacted Files

- `src/tools/WriteTools.ts` — extend `WriteToolsVault` with `process`; add a reusable process-backed modify helper or update `editFileImpl` semantics while preserving undo recording and dirty-editor guard (`src/tools/WriteTools.ts:19-31`, `src/tools/WriteTools.ts:137-202`).
- `src/tools/WriteNoteTools.ts` — move `edit_note` append/prepend composition and `create_task` existing-target append composition into process-backed RMW; keep `insert_into_active_note` editor path unchanged and disk fallback via `editNoteImpl` (`src/tools/WriteNoteTools.ts:133-225`, `src/tools/WriteNoteTools.ts:258-299`, `src/tools/WriteNoteTools.ts:517-673`).
- `src/tools/UpdateTask.ts` — move read/identify/patch/join for `update_task` into a process-backed callback so each updater sees the latest file content (`src/tools/UpdateTask.ts:100-171`).
- `src/tools/ObsidianApi.ts` — add `process` to `AppLike.vault` and add a `processNote` wrapper parallel to `modifyNote` (`src/tools/ObsidianApi.ts:118-122`, `src/tools/ObsidianApi.ts:737-757`).
- `src/tools/ObsidianApi.test.ts` — add wrapper coverage for forwarding to `vault.process`, returning the written string, and `index-unavailable` when absent (`src/tools/ObsidianApi.test.ts:742-767`).
- `src/tools/WriteTools.test.ts` — extend `makeVault` with process support and add/edit tests for process-backed modify undo snapshots (`src/tools/WriteTools.test.ts:31-69`, `src/tools/WriteTools.test.ts:116-127`).
- `src/tools/WriteNoteTools.test.ts` — extend shared fake vault with process support and add concurrent `edit_note`, `insert_into_active_note` disk fallback, and `create_task` tests (`src/tools/WriteNoteTools.test.ts:55-144`, `src/tools/WriteNoteTools.test.ts:218-302`, `src/tools/WriteNoteTools.test.ts:323-362`).
- `src/tools/UpdateTask.test.ts` — extend the local fake vault with process support and add concurrent `update_task` tests (`src/tools/UpdateTask.test.ts:47-85`).
- `src/domain/vaultToolManifest.ts` — update the `edit_note` preamble hint to warn against concurrent `replace` calls on the same file and prefer serializing or append/prepend for preservation (`src/domain/vaultToolManifest.ts:108-118`).
- `src/tools/WriteNoteTools.ts` tool descriptions/tests — update the SDK-visible `edit_note` description similarly, because the model sees `defineTool("edit_note", { description })` as well as the preamble inventory (`src/tools/WriteNoteTools.ts:717-742`).
- `src/domain/PreambleAssembler.test.ts` and/or `src/tools/WriteNoteTools.test.ts` — add assertions for the FR-007 hint in the preamble/tool description (`src/domain/PreambleAssembler.ts:180-187`, `src/domain/PreambleAssembler.test.ts:155-187`, `src/tools/WriteNoteTools.test.ts:488-495`).
- `CHANGELOG.md` — add the scoped bug-fix entry; changelog is a standard project file (`CHANGELOG.md:1`, `README.md:19-28`).

## Code References

- `src/tools/WriteNoteTools.ts:133-225` - `editNoteImpl` read-compose-write path with richer `modifyNote` and `editFileImpl` fallback.
- `src/tools/WriteNoteTools.ts:258-299` - `insertIntoActiveNoteImpl` editor-first path and disk fallback via `editNoteImpl`.
- `src/tools/WriteNoteTools.ts:517-673` - `createTaskImpl` target resolution, create-if-missing, read current, compose appended task, write via `editFileImpl`.
- `src/tools/UpdateTask.ts:100-171` - `updateTaskImpl` read, identify/patch target line, write full file via `editFileImpl`.
- `src/tools/WriteTools.ts:137-202` - `editFileImpl` lower-level read/guard/modify/undo-record sequence.
- `src/tools/WriteTools.ts:116-134` - `hasUnsavedEditorChanges` dirty editor guard.
- `src/tools/ReadTools.ts:15-23` - shared read-side vault shim.
- `src/tools/WriteTools.ts:19-31` - write-side vault shim.
- `src/tools/ObsidianApi.ts:743-757` - `modifyNote` wrapper over `vault.modify`.
- `node_modules/obsidian/obsidian.d.ts:7404-7418` - real Obsidian `Vault.process` contract.
- `src/domain/vaultToolManifest.ts:19-26` - vault tool manifest shape with `hint`.
- `src/domain/PreambleAssembler.ts:158-187` - manifest hints rendered into session-start preamble.

## Architecture Documentation

The tool layer uses structurally typed, narrow interfaces rather than importing Obsidian runtime types directly: `ReadToolsVault` for reads, `WriteToolsVault` for writes, `VaultLike` for path resolution, and `AppLike` for `ObsidianApi` tests (`src/tools/ReadTools.ts:10-23`, `src/tools/WriteTools.ts:11-31`, `src/tools/VaultPath.ts:17-27`, `src/tools/ObsidianApi.ts:114-122`). Write tools are registered through SDK `defineTool` factories and route mutating calls through the permission gate; `createWriteNoteTools` defines `edit_note`, `insert_into_active_note`, `create_task`, and `update_task` handlers over pure-ish implementation functions (`src/tools/WriteNoteTools.ts:686-984`). User-visible tool guidance has two channels: SDK tool descriptions in the tool factory and preamble inventory hints from `vaultToolManifest.ts` rendered by `PreambleAssembler` (`src/tools/WriteNoteTools.ts:717-742`, `src/domain/vaultToolManifest.ts:108-118`, `src/domain/PreambleAssembler.ts:158-187`).

## Open Questions

- Whether Obsidian's `Vault.process` creates a missing file is not stated in the vendored type contract; current source only documents processing an existing `TFile` (`node_modules/obsidian/obsidian.d.ts:7404-7418`). The existing missing-target branch in `createTaskImpl` currently uses `createFileImpl` first (`src/tools/WriteNoteTools.ts:567-599`).
- Whether `Vault.process` triggers the exact same Obsidian editor/file conflict UX as `vault.modify` is not documented in `obsidian.d.ts`; the current plugin-level guard only compares open markdown editor buffers before writes (`src/tools/WriteTools.ts:116-134`, `node_modules/obsidian/obsidian.d.ts:7404-7418`).
- The implementation boundary for a reusable process-backed helper (inside `WriteTools.ts` vs only in higher-level tool implementations) is not prescribed by existing source; current code centralizes low-level modify behavior in `editFileImpl` (`src/tools/WriteTools.ts:137-202`).

## Risks & Mitigations

- **Risk: async work inside `Vault.process` is impossible.** The callback is synchronous by type, so path lookup, validation that can fail early, and dirty-editor checks must happen before the callback; pure string transformation should happen inside (`node_modules/obsidian/obsidian.d.ts:7405-7418`, `src/tools/WriteTools.ts:116-134`).
- **Risk: undo snapshots could be stale if captured outside the atomic callback.** Current modify entries record after write but use a pre-read `before`; process-backed code should capture `before` from the callback input and `after` from the callback return, then record after the promise resolves (`src/tools/WriteTools.ts:187-202`, `src/tools/WriteNoteTools.ts:198-206`).
- **Risk: test fakes without `process` will report `index-unavailable` or fail type expectations.** The shared fake vaults in `WriteNoteTools.test.ts`, `UpdateTask.test.ts`, and `WriteTools.test.ts` currently expose `modify` but not `process`; add the minimal sync-transform implementation to each (`src/tools/WriteNoteTools.test.ts:88-106`, `src/tools/UpdateTask.test.ts:49-66`, `src/tools/WriteTools.test.ts:36-68`).
- **Risk: `insert_into_active_note` behavior could accidentally move editor-surface edits onto disk path.** Preserve the current editor-first branch and only rely on `editNoteImpl` for the existing disk fallback (`src/tools/WriteNoteTools.ts:280-299`).
- **Risk: model guidance could be updated in only one place.** The model sees both SDK tool descriptions and preamble hints; update both the `defineTool("edit_note")` description and `vaultToolManifest` hint, with tests covering the rendered preamble/tool manifest (`src/tools/WriteNoteTools.ts:717-742`, `src/domain/vaultToolManifest.ts:115-117`, `src/domain/PreambleAssembler.ts:180-187`).
