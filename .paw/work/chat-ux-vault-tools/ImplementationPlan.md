# Chat UX & Vault-Aware Tools Implementation Plan

## Overview

This plan implements v0.2 workflow A on top of the v0.1 plugin merged in PR #1. The work has three pillars: (1) keyboard-first chat input that mirrors VS Code's behavior, (2) a deterministic vault-aware preamble (the spec calls it the "system prompt") with authoring-convention guidance for backlinks, tags, and tasks, and (3) nine new vault-aware capabilities that prefer richer Obsidian surfaces (editor, internal-plugin config, resolved-link index) and fall back to the v0.1 `WriteTools`/`ReadTools` capabilities when those richer surfaces cannot satisfy the request.

The plan is structured so each phase is independently reviewable and lands behind the existing universal permission gate (`decideSafety` in `src/domain/SafetyPolicy.ts`). New mutating capabilities reuse `decideSafety` indirectly — by going through the SDK `tools` array with `skipPermission` left unset, which routes every invocation through `CopilotAgentSession.handlePermission` → `decideSafety` exactly like v0.1's `WriteTools`. New read-only capabilities reuse the v0.1 JSDoc checklist established at `src/tools/ReadTools.ts:53-78` and set `skipPermission: true`. v0.1 capabilities (`view`, `read_file`, `search_content`, `create_file`, `edit_file`, `delete_file`) stay registered (FR-020) — augment, not replace.

## Current State Analysis

**v0.1 layout (relevant modules, verified against actual source):**
- `src/tools/ReadTools.ts` — exports `createReadTools(vault: ReadToolsVault): Tool[]` returning `view`, `read_file`, `search_content`. All three tools are constructed with `skipPermission: true` and carry the read-only-checklist JSDoc at lines 53-78. Bounded constants: `MAX_VIEW_ENTRIES=500`, `MAX_READ_BYTES=256*1024`, `MAX_SEARCH_MATCHES=50`, `SNIPPET_RADIUS=80`.
- `src/tools/WriteTools.ts` — exports `createWriteTools(deps: WriteToolsDeps): Tool[]` returning `create_file`, `edit_file`, `delete_file`. **Already uses Obsidian's Vault API** (`vault.create`, `vault.modify`, `vault.delete`/`vault.trash` via `WriteToolsVault`). Each tool runs without `skipPermission`, so every call is gated. Records `UndoEntry` rows on success. `WRITE_TOOL_NAMES` constant exposed.
- `src/tools/VaultPath.ts` — exports `resolveVaultPath`, `toVaultRelative`, `lookupTFile`, `VaultPathError`. Path validation (within-vault, no symlink escape, normalized).
- `src/tools/ScopeRegistry.ts` — `VaultOnlyScopeRegistry.classify(absPath)` — pure path classifier (vault / extra-vault / outside). **Not** a tool registry. Tool lists are passed directly to the agent constructor in `main.ts`.
- `src/domain/SafetyPolicy.ts` — exports `decideSafety(input, config)` (function), `SafetyState` (class), `normaliseAllowlistEntry`, `isVaultPathAllowlisted`. Used by `CopilotAgentSession.handlePermission` (`AgentSession.ts:480-540` area) which the SDK calls via `onPermissionRequest`.
- `src/domain/UndoJournal.ts` — `UndoJournal` class. New write capabilities should record their undo entries here too.
- `src/sdk/AgentSession.ts` — exports `CopilotAgentSession`. Constructor takes `tools: SdkTool[]` (defensive-copied to `this.toolsList`), `safety` (config + state + extractor), `decider`, `cliPath`, etc. `client.createSession({ model, availableTools: ['builtin:*'], streaming: true, tools, onPermissionRequest })` is the only `createSession` call site. **`SdkSessionOptions` has no `systemPrompt` / `instructions` / `preamble` field** — the SDK does not currently accept a system prompt. Therefore v0.2's vault-aware preamble must be transported by prepending it to the first user message in `sendAndWait` (or, more cleanly, by interposing a "preamble injector" that, on the first send of a session, prepends the assembled string to the user's text). `SdkSession.sendAndWait(prompt: string)` is the only outgoing surface.
- `src/ui/ChatView.ts` — `class ChatView extends ItemView`. The chat input is a `<textarea>` and Send is wired via button click. There is no `keydown` listener on the textarea today, no `compositionstart`/`compositionend` tracking.
- `src/settings/SafetySettingsStore.ts` — persists settings via `loadData`/`saveData`. `DEFAULT_SAFETY_SETTINGS`, `KNOWN_BUILTIN_KINDS`. The store loads and snapshots a record consumed by the agent's `safety.config()` callback.
- `src/settings/SettingsTab.ts` — `CopilotAgentSettingTab extends PluginSettingTab`. Sectioned settings UI; we add a new section.
- `src/main.ts` — wires everything: builds `safetySettingsStore`, `safetyState`, `undoJournal`; calls `createReadTools` / `createWriteTools`; constructs `CopilotAgentSession` with the merged `tools` array; registers `ChatView`. Tools are wired directly into the constructor's `tools` arg — there is no separate "scope registry" registration step.

**Gaps (what this plan fills):**
- No editor-surface, daily-notes, metadata-cache, workspace-navigation surfaces are touched today. v0.1's `Vault.create/modify/delete` succeed but bypass cursor preservation, daily-note config, internal-plugin awareness, and resolved-link traversal.
- `ChatView` has no keyboard send.
- No vault-aware preamble path. SDK has no `systemPrompt` option; we'll need a session-scoped "first-send prepender" inside `CopilotAgentSession`.
- No "Vault Awareness" settings surface; no `taskTarget` setting; no place to persist user customizations.

**Constraints from spec:**
- 166/166 v0.1 tests must remain green; new tests target ≥35 (SC-007).
- Augment-not-replace: v0.1 tools stay registered.
- No new safety primitives — reuse `decideSafety`, `SafetyState`, `UndoJournal`, `VaultPath`.
- Privacy default: only vault root path + top-level folder names in default preamble (cap 50, alphabetical, "(N more)" suffix). When the vault has zero top-level folders, list the root **files** under the same cap (per Spec line 104).
- Settings changes apply on next session start (no live mid-session re-prompt).

## Desired End State

- Pressing Enter in the chat input sends; Shift+Enter inserts newline; IME composition is respected; empty/whitespace input does not send; Enter is no-op while a stream is in flight (does NOT call Stop, does NOT call Send).
- A new `Settings → Vault Awareness` section with: mode (None / Default / Custom), custom-body textarea, default task-target mode (Today's Daily Note / Custom path), optional custom task-target path. The default preamble assembles from vault root path + top-level folder list (or top-level file list when there are no folders) + a fixed authoring-conventions block (backlinks, tags, tasks).
- Nine new tools registered alongside v0.1 tools: `create_note`, `edit_note`, `open_note`, `insert_into_active_note`, `create_daily_note`, `list_recent_notes`, `get_active_note`, `create_task`, `find_backlinks`. Mutating capabilities run without `skipPermission` so they route through `decideSafety`. Read-only capabilities (`get_active_note`, `list_recent_notes`, `find_backlinks`) and the navigation-only `open_note` set `skipPermission: true` and carry the v0.1 read-only-checklist JSDoc (open_note's checklist documents that it has no filesystem effect, validates the target path against `resolveVaultPath`, and is bounded to a single vault-scoped file lookup — matching spec FR-016, which does NOT list FR-011 in the gated set, and P7 which expects no approval for navigation).
- An `ObsidianApi` helper (in `src/tools/ObsidianApi.ts`) wraps the richer surfaces: editor (active `MarkdownView` editor), workspace (`getLeaf().openFile`), metadata cache (`metadataCache.resolvedLinks`), internal plugins (`internalPlugins.plugins['daily-notes']`), community plugins (`plugins.plugins[id]`). Each method returns a discriminated union `{ ok: true; value: T } | { ok: false; reason: '...'; cause?: unknown }` so capability handlers can decide whether to call into v0.1's existing `WriteTools`/`ReadTools` factories as a fallback.
- Tasks integration: when the Tasks plugin is detected, `create_task` writes a Tasks-plugin-compatible checkbox; otherwise it writes a GFM checkbox. Default target = today's daily note (resolved via `create_daily_note` logic). Settings can override target.
- Every capability that has a fallback path (FR-018) reports `usedFallback: boolean` (or equivalent enumerated discriminator) in its tool result so the model and tests can verify which path ran.
- All new behavior covered by unit tests; chat keybinding covered by simulated `KeyboardEvent` + composition events.

**Verification approach:**
- `npm test` passes with new + existing tests.
- `npm run build` succeeds with strict TypeScript.
- Manual: install the rebuilt plugin into the test vault (`C:\Users\chkraw\OneDrive - Microsoft\Vaults\copilot-test`) and exercise SC-001 through SC-010 by hand.

## What We're NOT Doing

- No replacement of v0.1 tools (`view`, `read_file`, `search_content`, `create_file`, `edit_file`, `delete_file`) — they remain registered (FR-020).
- No new safety primitives — `decideSafety`, `SafetyState`, `UndoJournal`, `VaultPath`, `VaultOnlyScopeRegistry` reused as-is.
- No mobile support; desktop-only (consistent with v0.1).
- No Periodic Notes plugin integration (Daily Notes core only).
- No Calendar-plugin-specific code path (integration via daily-note write target).
- No tag-rename or tag-create capability surface.
- No mid-session settings reload — settings changes apply on next session start.
- No SDK changes (the SDK is upstream; we transport the preamble via first-message prepending inside `CopilotAgentSession`).
- No multi-conversation, no cross-restart Undo, no MCP, no extra-vault roots, no model picker — all deferred to workflow B.

## Phase Status
- [ ] **Phase 1: Chat keybinding (Enter / Shift+Enter / IME)** — Make the chat input keyboard-first.
- [ ] **Phase 2: Vault-aware preamble + Settings section** — Deterministic preamble assembler with three modes, authoring-conventions block, configurable task-target, and first-message prepender inside `CopilotAgentSession`.
- [ ] **Phase 3: ObsidianApi helper + read-only tools** — Introduce `ObsidianApi` helper and ship `get_active_note`, `list_recent_notes`, `find_backlinks` (all `skipPermission: true` with the read-only checklist).
- [ ] **Phase 4: Vault-aware mutating tools + open_note** — Ship `create_note`, `edit_note`, `insert_into_active_note`, `create_daily_note` (all gated) and `open_note` (navigation-only, ungated per spec FR-016 / P7) on top of `ObsidianApi` and the v0.1 `WriteTools` factory.
- [ ] **Phase 5: Tasks integration (`create_task`)** — Detect the Tasks plugin, format with emoji syntax or GFM fallback, default target to today's daily note (with Settings override).
- [ ] **Phase 6: Documentation** — `Docs.md`, README updates, and explicit verification of SC-001..SC-010.

## Phase Candidates
<!-- Empty initially. Items added during planning if work surfaces. -->
- [ ] Re-prioritize / hide v0.1 raw-filesystem capabilities behind a setting after observing model preference in real use (risk mitigation from spec).
- [ ] Per-vault Daily Notes target override (if the core plugin's config proves unreliable).

---

## Phase 1: Chat keybinding (Enter / Shift+Enter / IME)

### Changes Required:

- **`src/ui/ChatView.ts`** (modify):
  - Add `keydown`, `compositionstart`, `compositionend` listeners to the chat textarea. Track `isComposing` on the view (`compositionstart` → true, `compositionend` → false). Also respect `event.isComposing` and `event.keyCode === 229` for browsers/Electron versions that don't fire `compositionend` before `keydown`.
  - On `Enter` without `Shift` AND `!isComposing` AND `event.keyCode !== 229` AND the input has non-whitespace content AND the existing Send-button-disabled state is false (i.e., not currently streaming): `event.preventDefault()`, then call the same handler that the Send button uses.
  - On `Shift+Enter`: do nothing (default newline behavior in the textarea).
  - While streaming (Send disabled): `event.preventDefault()` to suppress accidental newline-then-stop interactions but **do NOT call the Stop handler**; the Stop button stays the only path to abort. Whitespace-only Enter: `preventDefault()` and no-op.
  - Refactor the existing send path so the `keydown` handler and the Send button click both invoke a single `submitMessage()` method (DRY).
  - The Send button stays — keyboard support is additive.
- **`src/ui/ChatView.test.ts`** (new — confirm test harness pattern matches `MessageRenderer.test.ts` if one exists, or use the same Vitest/Jest setup as `ReadTools.test.ts`). Tests:
  - Plain Enter on non-empty input calls `submitMessage` and clears the textarea.
  - Shift+Enter does NOT call `submitMessage`.
  - Enter during composition (`isComposing: true` AND/OR `keyCode === 229`) does NOT call `submitMessage`.
  - Enter on whitespace-only input does NOT call `submitMessage`.
  - Enter while streaming-in-progress (Send disabled) does NOT call `submitMessage` AND does NOT call the Stop handler.

### Success Criteria:

#### Automated Verification:
- [ ] `npm test` — all v0.1 tests still pass; new ChatView tests pass.
- [ ] `npm run build` — strict TypeScript builds clean.

#### Manual Verification:
- [ ] Open the chat input in the test vault, type "hello", press Enter — message sends, input clears.
- [ ] Type two lines using Shift+Enter — newline inserted, no message sent.
- [ ] Type with Pinyin/Kana IME, press Enter to commit composition — composition commits, message NOT sent. Press Enter again — message sends.
- [ ] Press Enter in an empty input — nothing happens.
- [ ] During an in-flight stream, press Enter — stream continues (NOT stopped) and no new message is sent.

---

## Phase 2: Vault-aware preamble + Settings section

### Changes Required:

- **`src/domain/PreambleAssembler.ts`** (new):
  - Pure function `assemblePreamble(input: { mode: 'none' | 'default' | 'custom'; vaultRootAbsPath: string; topLevelFolderNames: string[]; topLevelFileNames: string[]; customBody?: string }): string`.
  - For `none`: returns empty string (caller skips prepending).
  - For `default`: returns the vault root path line, the local timezone line (IANA name from `Intl.DateTimeFormat().resolvedOptions().timeZone`) and today's date in that zone formatted `YYYY-MM-DD` — both required for P5 acceptance scenario 4 ("resolves the date deterministically against the user's local timezone (provided in the system prompt)") and consumed by `create_task`'s ambiguous-date resolution in Phase 5; then either the top-level folder list (sorted alphabetically, capped at 50, "(N more)" suffix when truncated) OR — when `topLevelFolderNames.length === 0` — the top-level file list under the same cap, with a label distinguishing the two listings (per Spec line 104). Then appends the fixed authoring-conventions block (FR-006a/b/c).
  - For `custom`: returns `customBody` verbatim, substituting documented placeholders (`{{VAULT_ROOT}}`, `{{VAULT_TIMEZONE}}`, `{{VAULT_TODAY}}`, `{{TOP_LEVEL_FOLDERS}}`, `{{TOP_LEVEL_FILES}}`, `{{AUTHORING_CONVENTIONS}}`) only when present in the template.
  - Authoring-conventions block stored as a constant alongside the assembler (single source of truth, deterministic).
- **`src/domain/PreambleAssembler.test.ts`** (new) — covers all three modes, the 50-folder cap, alphabetical sort, the placeholder substitution (including `{{VAULT_TIMEZONE}}` and `{{VAULT_TODAY}}`), the empty-folder-list-with-files edge case (Spec line 104), the empty-folder-list-with-no-files edge case, the timezone-line presence-in-default / absence-in-none assertion, and the deterministic-output assertion (same inputs → same string, FR-021).
- **`src/settings/VaultAwarenessSettings.ts`** (new): persisted shape:
  - `mode: 'none' | 'default' | 'custom'` (default: `'default'`)
  - `customBody: string` (default: `''`)
  - `taskTargetMode: 'today-daily-note' | 'custom-path'` (default: `'today-daily-note'`)
  - `customTaskTargetPath: string` (default: `''`, only used when `taskTargetMode === 'custom-path'`)
- **`src/settings/SafetySettingsStore.ts`** (modify): extend the persisted record to include `vaultAwareness: VaultAwarenessSettings`. Migrate missing field to the default. Existing settings remain compatible.
- **`src/settings/SettingsTab.ts`** (modify): add a "Vault Awareness" section with:
  - Dropdown (None / Default / Custom).
  - Custom-body textarea (visible only when mode = Custom) plus a placeholder reference.
  - "Default task target" dropdown (Today's Daily Note / Custom path) and a path field for the custom case.
  - A "Preview" disclosure that calls `assemblePreamble` with the current vault state.
- **`src/sdk/AgentSession.ts`** (modify):
  - Add a constructor option `preamble?: () => string | null` (lazy to avoid stale snapshots during reconnect).
  - Inside `CopilotAgentSession`, track `private firstSendOfSession: boolean = true`. On each `client.createSession` (the existing call sites at ~line 713 and ~line 865, and inside `resetConversation`), reset `firstSendOfSession = true`.
  - Wrap `SdkSession.sendAndWait` so the FIRST call after `createSession` prepends the assembled preamble to the user's text using a documented separator (e.g., a clearly-marked block with a leading marker line) and sets `firstSendOfSession = false`. Subsequent calls pass through unchanged. If `preamble()` returns null/empty, no prepending occurs.
  - Expose `preambleProbe()` for tests so the integration test can assert (a) what was prepended on the first send and (b) that the second send is untouched.
- **`src/main.ts`** (modify): wire the settings store into `CopilotAgentSession`'s `preamble` callback. The callback reads:
  1. `safetySettingsStore.snapshot().vaultAwareness`
  2. `app.vault.getRoot().children` filtered into folders/files
  3. Calls `assemblePreamble`.
  Returns the assembled string or null when mode = none.
- **`src/sdk/AgentSession.test.ts`** (modify): add tests asserting first-send prepending happens, second-send is untouched, `preamble: () => null` short-circuits, `resetConversation` re-arms the prepend.

### Success Criteria:

#### Automated Verification:
- [ ] `npm test` — new assembler tests + AgentSession integration tests pass; all v0.1 tests stay green.
- [ ] `npm run build` — strict TS builds clean.
- [ ] Test asserting deterministic output: same inputs → byte-identical string (FR-021).

#### Manual Verification:
- [ ] In test vault: open Settings → Vault Awareness, observe Default mode preview shows vault root path + folder list + authoring-conventions block.
- [ ] Switch to None, restart session, observe agent must run discovery tool calls to answer "what's in my vault?".
- [ ] Switch to Custom with a body containing `{{VAULT_ROOT}}` only, restart session, observe folder list and authoring-conventions block are absent.
- [ ] In a vault with 60+ top-level folders, the prompt body lists 50 alphabetically and then "(10 more)".
- [ ] In a vault with **zero** top-level folders (only files at root), the prompt body lists root files (capped at 50, alphabetical, "(N more)" if truncated) — per Spec line 104.

---

## Phase 3: ObsidianApi helper + read-only tools

### Changes Required:

- **`src/tools/ObsidianApi.ts`** (new):
  - Constructor takes `app: App` (typed loosely the same way `main.ts` does today, via narrow interfaces) and reuses `resolveVaultPath`/`lookupTFile` from `VaultPath.ts`.
  - Methods used by Phase 3 tools:
    - `getActiveFile()` → `app.workspace.getActiveFile()` and `getActiveViewOfType(MarkdownView)?.editor` for the editor surface.
    - `listRecentlyModifiedNotes(maxN)` → `app.vault.getMarkdownFiles()` sorted by `TFile.stat.mtime` descending, sliced to `maxN`.
    - `getResolvedLinks()` → `app.metadataCache.resolvedLinks` (a record `sourcePath → { targetPath: count }`).
    - `getMetadataCache()` → reference for downstream tag enumeration.
  - Methods used by Phase 4 tools:
    - `openFile(file)` → `app.workspace.getLeaf(false).openFile(file)` (returns the discriminated union shape on any thrown error).
    - `getEditorForActive()` / `applyEditorTransform(mode, content)` → uses `Editor.replaceRange`, `Editor.getValue`, `Editor.setCursor` to satisfy the cursor behavior spec'd in FR-012.
    - `getDailyNotesConfig()` → `app.internalPlugins.plugins['daily-notes']?.instance?.options` (folder, format, template) or `{ ok: false, reason: 'plugin-not-enabled' }`.
    - `isCommunityPluginEnabled(id)` → `app.plugins.plugins[id] != null`.
  - Each method returns a discriminated union `{ ok: true; value: T } | { ok: false; reason: 'no-active-note' | 'no-editor' | 'plugin-not-enabled' | 'native-failed' | 'index-unavailable'; cause?: unknown }`.
- **`src/tools/ObsidianApi.test.ts`** (new): unit tests with a mocked `App` covering happy paths and the failure shapes. Tests use plain fixtures matching the `ReadToolsVault`/`WriteToolsVault` precedent — no full Obsidian mock required.
- **`src/tools/ReadNoteTools.ts`** (new) — three new read-only capabilities; exported as `createReadNoteTools(api: ObsidianApi, vault: ReadToolsVault): Tool[]`:
  - `get_active_note` — calls `api.getActiveFile()`; returns `{ path, content }` (read content via `vault.cachedRead ?? vault.read`); errors as structured `no_active_note`. `skipPermission: true`.
  - `list_recent_notes(n)` — `n` defaults to 20, capped at 100. Sorts by `TFile.stat.mtime` desc. `skipPermission: true`.
  - `find_backlinks(targetPath)` — first tries the resolved-link index (iterate `api.getResolvedLinks()` and collect sources whose values include the resolved target). On `index-unavailable`, falls back to a bounded markdown-file scan (regex over `[[wikilink]]` and `[text](path)`), capped by the same per-file size and total-file caps as `ReadTools.search_content` (`MAX_SEARCH_MATCHES = 50` is the per-call limit; we'll mirror the file-scan caps). Result includes `usedFallback: boolean`, `truncated: boolean`, and the link form (`'wikilink' | 'markdown'`). `skipPermission: true`.
  - Each tool function carries the JSDoc read-only checklist comment block per `src/tools/ReadTools.ts:53-78`.
- **`src/tools/ReadNoteTools.test.ts`** (new): tests for each capability — success, structured-error paths, fallback path for `find_backlinks` (proves `usedFallback: true` and `truncated: true` when caps trip), the 20/100 caps for `list_recent_notes`, the link-form discrimination for `find_backlinks`.
- **`src/main.ts`** (modify): construct `ObsidianApi` once, pass to `createReadNoteTools`. Append the returned tools onto the existing `tools: [...readTools, ...writeTools, ...readNoteTools]` array passed to the `CopilotAgentSession` constructor.

### Success Criteria:

#### Automated Verification:
- [ ] `npm test` — `ObsidianApi` + read-note tests pass; v0.1 tests still green.
- [ ] `npm run build` — strict TS clean.
- [ ] Each new read-only tool source carries the read-only-checklist JSDoc.
- [ ] Test asserts `skipPermission: true` on all three new tools.

#### Manual Verification:
- [ ] In test vault, ask the agent "list my recent notes" — answer returns within one assistant turn, NO approval prompt shown.
- [ ] Ask "what links to <existing-note>" with at least one inbound link — backlinks listed correctly. Compare against Obsidian's Backlinks pane.
- [ ] With an empty workspace (no active markdown view), ask "what's in my active note" — agent reports a structured no-active-note response, not a crash.

---

## Phase 4: Vault-aware mutating tools + open_note

### Changes Required:

- **`src/tools/WriteNoteTools.ts`** (new) — five new capabilities; exported as `createWriteNoteTools(deps: { api: ObsidianApi; vault: WriteToolsVault; workspace: WorkspaceForWrites; undoJournal: UndoJournal }): Tool[]`. Note: in Phase 4 we deliberately reuse the `WriteToolsDeps` shape so the v0.1 `createWriteTools` factory can be invoked from inside Phase-4 capabilities for the fallback path:
  - `create_note(path, content?)` — path validated via `resolveVaultPath`. Tries the **richer surface first** (calls `api.createNote()` which uses `vault.create` plus `metadataCache` warm-up); on `native-failed`, falls back to invoking the v0.1 `create_file` handler logic directly (same `WriteToolsDeps`, same `vault.create`, same `UndoJournal` recording). On collision (`vault.create` rejects with EEXIST or `lookupTFile` already returns a file), returns structured `collision` error (NEVER overwrites). Result: `{ ok, path, undoId, usedFallback: boolean }`. Runs without `skipPermission`.
  - `edit_note(path, mode, content)` — modes: `append`, `prepend`, `replace`. Tries `api.modifyNote()` (which uses `vault.modify`); falls back to v0.1's `edit_file` handler. **Stale-content / conflict guard: edit_note inherits v0.1's unsaved-editor conflict detection** — the v0.1 `edit_file` handler reads `WorkspaceForWrites.getLeavesOfType('markdown')` and refuses to write when the target is open with unsaved changes; `edit_note`'s richer-surface path performs the same check before calling `vault.modify`, and the fallback path uses the existing `edit_file` handler verbatim. (No new `expectedHash` mechanism is introduced — that was a misread of v0.1; correcting here.) Result: `{ ok, path, undoId, usedFallback }`. Runs without `skipPermission`.
  - `open_note(path)` — path validated via `resolveVaultPath`; calls `api.openFile()` (uses `app.workspace.getLeaf(false).openFile()`). **No filesystem mutation; not in FR-016's gated set; matches P7 expectation of no approval.** Set `skipPermission: true` and include a JSDoc justification block patterned after `ReadTools.ts:53-78`, explicitly documenting: (a) no fs effect, (b) `resolveVaultPath` validation, (c) bounded to a single vault-scoped file lookup, (d) workspace navigation only — no content read or write. If the path doesn't resolve to an existing note, returns a structured `not_found` error.
  - `insert_into_active_note(content, mode)` — modes: `append`, `prepend`, `replace`. Resolves the active editor via `api.getEditorForActive()`; applies through `Editor.replaceRange` so cursor behavior matches the spec (append leaves cursor in place; prepend shifts cursor by the count of inserted code-points; replace places cursor at the end of the inserted content). On `no-editor` falls back to `edit_note` on the underlying file path when the active file is known. Returns structured `no_active_note` if there is no active markdown editor AND no resolvable file. Result: `{ ok, path, undoId, usedFallback, mode, cursorAdjusted }`. Runs without `skipPermission`.
  - `create_daily_note()` — reads `api.getDailyNotesConfig()`. When ok: resolves folder, filename format (default `YYYY-MM-DD`), template path; then internally calls `create_note` for the resolved path. When ok=false reason=`plugin-not-enabled`: falls back to creating `YYYY-MM-DD.md` at vault root with no template (also via `create_note`). Calling on existing daily note returns `{ ok: true, noop: true, path }` without overwriting. Result includes `source: 'plugin-config' | 'fallback'` so manual verification matches Spec acceptance. Runs without `skipPermission` (the underlying `create_note` is the gated call).
- **`src/tools/WriteNoteTools.test.ts`** (new): tests for each capability — happy path (richer surface), fallback path (assert `usedFallback: true`), collision/stale/no-active-note structured errors, daily-note's noop case, daily-note enabled-and-disabled paths (both result in a `create_note`-style approval flow), `insert_into_active_note` cursor behavior assertions for all three modes (use a fake `Editor` with `replaceRange`/`setCursor` spies), and `open_note` happy + not-found cases. Also assert `open_note.skipPermission === true` and the other four mutating tools have `skipPermission` falsy.
- **`src/main.ts`** (modify):
  - Build `ObsidianApi` once (shared with Phase 3).
  - Build write-note tools with the same `WriteToolsDeps` already in scope plus `api`.
  - Append into the `tools: [...]` array.
- **`src/tools/WriteTools.ts`** (modify) — export a combined list:
  - Add `export const NOTE_WRITE_TOOL_NAMES = ['create_note', 'edit_note', 'insert_into_active_note', 'create_daily_note', 'create_task'] as const;` (kept here so `AgentSession`'s safety classifier — which already imports from this module — can reuse the existing pattern without a new import).
  - Add `isVaultWriteToolName(name)` which returns true for either `WRITE_TOOL_NAMES` or `NOTE_WRITE_TOOL_NAMES`.
- **`src/sdk/AgentSession.ts`** (modify):
  - Replace the single `isWriteToolName(toolName)` test in `buildSafetyInput` (~line 1166) with `isVaultWriteToolName(toolName)` so all five new mutating tools get `source: 'vault'` classification — inheriting the same vault allowlist matching, session-grant semantics, and "approved" / "approve-all" / "session-allow-all" modes that v0.1 vault writes use today (FR-016).
  - This is the **only** change to the gate plumbing; `decideSafety` itself does not change.
- **`src/main.ts`** (modify): broaden the `safety.extractVaultPath` callback so it synthesizes the vault-relative path **before** the SDK permission request fires (since `handlePermission` → `buildSafetyInput` → `decideSafety` runs before any tool handler executes). The new extractor closes over `ObsidianApi`, the `vaultAwareness` settings reader, and a deterministic `now: () => Date` clock; it handles each new tool by name:
  - `create_note` / `edit_note` → use `request.args.path`.
  - `open_note` → also accepts `request.args.path`, but in practice the extractor is not called because `open_note.skipPermission === true`; kept for completeness so the same map covers every name and so a future spec change that gates `open_note` doesn't introduce a bug.
  - `create_task` → if `request.args.targetPath` is present (model-provided override), use it; otherwise read `vaultAwareness.taskTargetMode`. For `'custom-path'`, return `customTaskTargetPath`. For `'today-daily-note'`, synthesize today's daily-note path via `resolveDailyNotePath(api, now())`.
  - `create_daily_note` → call `resolveDailyNotePath(api, now())`.
  - `insert_into_active_note` → read `app.workspace.getActiveFile()?.path` (sync). If null, return `undefined` so `decideSafety` treats it as a path-less vault write (allowlist match impossible; the existing `vaultGranted` session-grant path still applies).
  - The same `now: () => Date` clock and the same `resolveDailyNotePath` helper are passed into `createWriteNoteTools` as deps (see below) so the handler-side path resolution uses the identical inputs the extractor used. A unit test asserts this equivalence (gate path === actual write path) for all three synthesizing cases, on at least three clock values.
- **`src/tools/ObsidianApi.ts`** (modify, scope adjustment from Phase 3): expose `getDailyNotesConfig()` as a **synchronous** read (the underlying `app.internalPlugins.plugins['daily-notes']?.instance?.options` is sync). This is the contract the extractor relies on. If the underlying read ever needs to await something, the extractor falls back to the `YYYY-MM-DD.md`-at-root path and the tool handler does the same — preserving the gate/handler equivalence.
- **`src/tools/DailyNotePath.ts`** (new): exports the pure helper `resolveDailyNotePath(api: ObsidianApi, now: Date): { path: string; source: 'plugin-config' | 'fallback' }`. Used by both the extractor (in `main.ts`) and the `create_daily_note` / `create_task` tool handlers (in `WriteNoteTools.ts`). Keeps the gate/handler in lockstep.
- **`src/tools/DailyNotePath.test.ts`** (new): tests for both branches (plugin enabled vs. disabled), invalid filename formats, and folder-doesn't-yet-exist (helper just returns the path; the tool handler is responsible for creating the folder before writing).
- **`createWriteNoteTools` deps shape** (Phase-4 update to the factory introduced earlier in this phase): include an explicit `now: () => Date` clock function alongside `api`, `vault`, `workspace`, `undoJournal`, `vaultAwareness`. `main.ts` passes `Date.now` (wrapped as `() => new Date()`) by default; tests inject a fixed clock for deterministic assertions. This guarantees the handler-side `resolveDailyNotePath` call uses the same `now` the extractor used at gate time.
- **`src/sdk/AgentSession.test.ts`** (modify): add tests asserting each of the five new tool names is classified as `source: 'vault'` by `buildSafetyInput`, and that the resolved path is read for allowlist matching.



### Success Criteria:

#### Automated Verification:
- [ ] `npm test` — write-note tests pass; v0.1 write tests still green; tests assert `open_note.skipPermission === true` and the four mutating tools route through `decideSafety` (verified by spying on the agent's permission handler).
- [ ] `npm run build` — strict TS clean.
- [ ] Each fallback path returns a result with `usedFallback: true` (FR-018 observability).

#### Manual Verification:
- [ ] Ask "create a note titled Meeting Notes" — exactly one approval prompt; on approve, file appears in Obsidian's file explorer immediately.
- [ ] With Daily Notes plugin disabled, ask for today's daily note — `YYYY-MM-DD.md` appears at vault root; tool result reports `source: 'fallback'`.
- [ ] With Daily Notes plugin enabled and a configured folder, ask for today's daily note — note appears in configured folder; tool result reports `source: 'plugin-config'`.
- [ ] Open a note and ask "append a TODO list to this note" — one approval, content appended through the editor surface, cursor stays at original position.
- [ ] Ask "open my Project Plan note" — note focuses in the workspace **with no approval prompt** (per FR-016 / P7).
- [ ] Force a collision (ask twice for the same note name) — second attempt returns a structured collision error, original file untouched.

---

## Phase 5: Tasks integration (`create_task`)

### Changes Required:

- **`src/tools/TaskFormat.ts`** (new):
  - `formatTaskLine(input: TaskInput, source: 'tasks-plugin' | 'gfm'): string`.
  - When source is `tasks-plugin`: emoji syntax `📅 YYYY-MM-DD` (due), `⏳ YYYY-MM-DD` (scheduled), `⏫`/`🔼`/`🔽` (priority), `#tag` for tags.
  - When source is `gfm`: plain `- [ ] description` followed by inline-text date metadata (e.g., `(due: 2026-06-12)`) the user can later upgrade.
- **`src/tools/TaskFormat.test.ts`** (new): cover both formats, all priority values, tags, no-date case, stable output ordering.
- **`src/tools/WriteNoteTools.ts`** (modify):
  - Add `create_task(input)` capability to the factory.
  - Detects plugin via `api.isCommunityPluginEnabled('obsidian-tasks-plugin')`.
  - Calls `formatTaskLine` with the appropriate source.
  - Resolves target = `vaultAwareness.taskTargetMode === 'custom-path' ? vaultAwareness.customTaskTargetPath : <today's daily note via create_daily_note>`. When the resolved target doesn't exist (typical for the daily-note default on the first call of the day, or for a brand-new custom path), the capability creates it inside the same single approval flow by chaining into `create_daily_note` (default) or `create_note` (custom-path).
  - Appends the line through `edit_note(targetPath, 'append', taskLine + '\n')` so the same gate, journal, and fallback path apply.
  - Returns `{ ok, targetPath, formatSource: 'tasks-plugin' | 'gfm', existingTargetCreated: boolean, usedFallback: boolean }`.
  - Settings: read `vaultAwareness.taskTargetMode` and `vaultAwareness.customTaskTargetPath` from the same `safetySettingsStore.snapshot()` callback used in Phase 2. Wire the settings reader through the same `WriteNoteTools` factory deps (add a `vaultAwareness: () => VaultAwarenessSettings` callback).
- **`src/tools/WriteNoteTools.test.ts`** (modify): add `create_task` tests — Tasks-plugin-present, Tasks-plugin-absent, target-doesn't-exist creates daily note, Settings-driven custom target override (assert it reads from the injected settings callback), ambiguous-date deterministic resolution (test passes a fixed `now` for determinism), `usedFallback` correctly reported.
- **`src/main.ts`** (modify): pass the `vaultAwareness` settings reader into `createWriteNoteTools`.
- **Phase-2 cross-check**: ensure the authoring-conventions block in `PreambleAssembler.ts` mentions `create_task` and references the same Tasks-plugin emoji syntax that `formatTaskLine` produces. Adjust the block here in Phase 5 if needed and re-run Phase-2 deterministic-output tests.

### Success Criteria:

#### Automated Verification:
- [ ] `npm test` — task-format and create-task tests pass; v0.1 tests still green; Phase-2 preamble tests still green after authoring-conventions tweak.
- [ ] `npm run build` — strict TS clean.

#### Manual Verification:
- [ ] With Tasks plugin installed, ask "remind me to follow up with Alice on Friday" — one approval; today's daily note (creating it if needed) gets a `📅 YYYY-MM-DD` line; the Tasks plugin's query view picks it up; the Calendar plugin shows it on the due date.
- [ ] Without Tasks plugin, same prompt — one approval; line is GFM `- [ ]` with inline-text date; result reports `formatSource: 'gfm'`.
- [ ] Ask for a task with the daily note absent — single approval flow that creates the daily note AND appends the task.
- [ ] Switch Settings → Default task target → Custom path → `Inbox.md`; ask for a task — one approval; the line is appended to `Inbox.md`.

---

## Phase 6: Documentation

### Changes Required:

- **`.paw/work/chat-ux-vault-tools/Docs.md`** (new): Technical reference (load `paw-docs-guidance` skill for templates):
  - Architecture diagram showing `ChatView` ↔ `CopilotAgentSession` (with first-send preamble prepender) ↔ `PreambleAssembler` and the `ObsidianApi` ↔ tool capabilities ↔ `decideSafety`/`UndoJournal` paths.
  - Per-capability tool surface reference (signatures, error shapes, fallback semantics, format-source reporting).
  - Vault Awareness Settings UX walk-through (modes, custom body placeholder syntax, preview).
  - Verification matrix mapping SC-001..SC-010 to specific manual steps and to test files.
- **`README.md`** (modify): update "What's new in v0.2" or similar section. Document Enter-to-send, Shift+Enter, IME handling. Document new capabilities. Document Vault Awareness setting (with an explicit privacy note: top-level folder names are in the prompt by default; switch to None for sensitive vaults). Update "What is NOT in v0.1" → mark items now shipped in v0.2 and clearly note workflow B items remaining out of scope.
- **`CHANGELOG.md`** (modify or create if absent following project convention): add a v0.2 section enumerating user-visible changes (keybinding, system prompt, nine new capabilities, Tasks/Calendar integration via daily-note write target).
- **Verify SC-001..SC-010 manually** and capture the results in `Docs.md`'s verification matrix.

### Success Criteria:

#### Automated Verification:
- [ ] `npm test` — full suite still green at end of phase.
- [ ] `npm run build` — clean.
- [ ] Markdown linter (if present in repo) — clean. (No new linter added if not already present per repo convention.)

#### Manual Verification:
- [ ] Docs.md verification matrix has a row per SC, each marked done, with the test file path or manual step recorded.
- [ ] README's "What's new" reflects ship state; "What is NOT" items are accurate.
- [ ] CHANGELOG entry mentions every user-visible change.

---

## References
- Issue: none (private repo, post-v0.1)
- Spec: `.paw/work/chat-ux-vault-tools/Spec.md`
- Workflow Context: `.paw/work/chat-ux-vault-tools/WorkflowContext.md`
- v0.1 reference: `.paw/work/copilot-sdk-spike/` (merged in PR #1, commit f1645a7)
- Read-only checklist source: `src/tools/ReadTools.ts:53-78`
- Permission gate source: `src/domain/SafetyPolicy.ts`
- v0.1 fallback path: `src/tools/WriteTools.ts`
- Research: none — sufficient context exists from v0.1 and the referenced plugins (Spec.md References).
