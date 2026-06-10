# Chat UX & Vault-Aware Tools Implementation Plan

## Overview

This plan implements v0.2 workflow A on top of the v0.1 plugin merged in PR #1. The work has three pillars: (1) keyboard-first chat input that mirrors VS Code's behavior, (2) a deterministic vault-aware preamble that names the available vault tools (so the model uses them instead of general shell discovery) with authoring-convention guidance for backlinks, tags, and tasks, and (3) eleven new vault-aware capabilities — six mutating/workspace (create note, edit note, open note, insert into active note, create daily note, create task) and five read-only auto-approved (get active note, list recent notes, find backlinks, vault tree, vault metadata) — that prefer richer Obsidian surfaces (editor, internal-plugin config, metadata cache) and fall back to the v0.1 `WriteTools`/`ReadTools` capabilities when those richer surfaces cannot satisfy the request.

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
- `src/ui/ChatView.ts` — `class ChatView extends ItemView`. The chat input is a `<textarea>` with a Send/Stop button wired via click. **A `keydown` listener already exists on the textarea** (lines 145-162 area) that binds **Ctrl/Cmd+Enter** to `handleSendOrStop` — sends when idle, **stops the active stream when streaming**. There is no IME composition tracking (`compositionstart`/`compositionend` / `event.isComposing` / `keyCode === 229`). Phase 1 refactors this listener and removes the Stop-on-Ctrl/Cmd+Enter side effect to match the spec's "Enter is no-op during stream, does NOT call Stop" requirement.
- `src/settings/SafetySettingsStore.ts` — persists settings via `loadData`/`saveData`. `DEFAULT_SAFETY_SETTINGS`, `KNOWN_BUILTIN_KINDS`. The store loads and snapshots a record consumed by the agent's `safety.config()` callback.
- `src/settings/SettingsTab.ts` — `CopilotAgentSettingTab extends PluginSettingTab`. Sectioned settings UI; we add a new section.
- `src/main.ts` — wires everything: builds `safetySettingsStore`, `safetyState`, `undoJournal`; calls `createReadTools` / `createWriteTools`; constructs `CopilotAgentSession` with the merged `tools` array; registers `ChatView`. Tools are wired directly into the constructor's `tools` arg — there is no separate "scope registry" registration step.

**Gaps (what this plan fills):**
- No editor-surface, daily-notes, metadata-cache, workspace-navigation surfaces are touched today. v0.1's `Vault.create/modify/delete` succeed but bypass cursor preservation, daily-note config, internal-plugin awareness, and resolved-link traversal.
- `ChatView` has a keyboard handler today but it binds Ctrl/Cmd+Enter (not Enter) AND doubles as a Stop trigger while streaming — both behaviors conflict with v0.2 spec.
- No vault-aware preamble path. SDK has no `systemPrompt` option; we'll need a session-scoped "first-send prepender" inside `CopilotAgentSession`.
- No "Vault Awareness" settings surface; no `taskTarget` setting; no place to persist user customizations.

**Constraints from spec:**
- 166/166 v0.1 tests must remain green; new tests target ≥40 (SC-007). **Per-phase test-count budget** to make SC-007 trackable: Phase 1 (chat UX) ≥5 tests, Phase 2 (preamble + Settings) ≥8 tests, Phase 3 (read tools — 5 capabilities) ≥10 tests, Phase 4 (write-note + open + safety extractor) ≥10 tests, Phase 5 (task format + create_task) ≥6 tests, Phase 6 (docs only — no new tests). Each phase's Automated Verification block re-asserts the running cumulative count.
- Augment-not-replace: v0.1 tools stay registered.
- No new safety primitives — reuse `decideSafety`, `SafetyState`, `UndoJournal`, `VaultPath`.
- Privacy default: only vault root path + top-level folder names in default preamble (cap 50, alphabetical, "(N more)" suffix). When the vault has zero top-level folders, list the root **files** under the same cap (per Spec line 104).
- Settings changes apply on next session start (no live mid-session re-prompt).

## Desired End State

- Pressing Enter in the chat input sends; Shift+Enter inserts newline; IME composition is respected; empty/whitespace input does not send; Enter is no-op while a stream is in flight (does NOT call Stop, does NOT call Send).
- A new `Settings → Vault Awareness` section with: mode (None / Default / Custom), custom-body textarea, default task-target mode (Today's Daily Note / Custom path), optional custom task-target path. The default preamble assembles from vault root path + top-level folder list (or top-level file list when there are no folders) + a fixed authoring-conventions block (backlinks, tags, tasks).
- Eleven new tools registered alongside v0.1 tools: mutating/workspace — `create_note`, `edit_note`, `open_note`, `insert_into_active_note`, `create_daily_note`, `create_task`; read-only — `get_active_note`, `list_recent_notes`, `find_backlinks`, `vault_tree`, `vault_metadata`. Mutating capabilities run without `skipPermission` so they route through `decideSafety`. Read-only capabilities (`get_active_note`, `list_recent_notes`, `find_backlinks`, `vault_tree`, `vault_metadata`) and the navigation-only `open_note` set `skipPermission: true` and carry the v0.1 read-only-checklist JSDoc (open_note's checklist documents that it has no filesystem effect, validates the target path against `resolveVaultPath`, and is bounded to a single vault-scoped file lookup — matching spec FR-016, which does NOT list FR-011 in the gated set, and P7 which expects no approval for navigation).
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
- [x] **Phase 1: Chat keybinding (Enter / Shift+Enter / IME)** — Make the chat input keyboard-first.
- [x] **Phase 2: Vault-aware preamble + Settings section** — Deterministic preamble assembler with three modes, authoring-conventions block, configurable task-target, and first-message prepender inside `CopilotAgentSession`.
- [x] **Phase 3: ObsidianApi helper + read-only tools** — Introduce `ObsidianApi` helper and ship `get_active_note`, `list_recent_notes`, `find_backlinks`, `vault_tree`, `vault_metadata` (all `skipPermission: true` with the read-only checklist).
- [x] **Phase 4: Vault-aware mutating tools + open_note** — Ship `create_note`, `edit_note`, `insert_into_active_note`, `create_daily_note` (all gated) and `open_note` (navigation-only, ungated per spec FR-016 / P7) on top of `ObsidianApi` and the v0.1 `WriteTools` factory.
- [x] **Phase 5: Tasks integration (`create_task`)** — Detect the Tasks plugin, format with emoji syntax or GFM fallback, default target to today's daily note (with Settings override). Includes follow-up: default created date + Undo button.
- [ ] **Phase 6: Task editing (`update_task` + `find_tasks`)** — Surgical line-level task edits with all 4 statuses (todo/in-progress/done/cancelled), auto-stamped completion/cancellation dates, line-diff approval, journal undo. Plus a read-only `find_tasks` for tag/status/date/regex filtering. Promoted mid-flight from candidates.
- [ ] **Phase 7: Documentation** — `Docs.md`, README updates, and explicit verification of SC-001..SC-010.

## Phase Candidates
<!-- Empty initially. Items added during planning if work surfaces. -->
- [x] [promoted-to-phase-6] Task editing toolset: `update_task` (status + tags + priority + dates) and `find_tasks` (filter by tag/status/regex). Supports all four statuses (`todo`/`in-progress`/`done`/`cancelled`) with auto-stamped completion/cancellation dates. Surgical line-level edits with line-diff approval and journal undo. Promoted mid-flight after Phase 5 ship; full elaboration in Phase 6 below.
- [ ] Re-prioritize / hide v0.1 raw-filesystem capabilities behind a setting after observing model preference in real use (risk mitigation from spec).
- [ ] Per-vault Daily Notes target override (if the core plugin's config proves unreliable).
- [ ] **Richer vault search capabilities** (deferred from cycle-2 design pivot):
  - `search_by_tag(tag: string)` — list notes tagged with a given tag via `metadataCache.getTags()`.
  - `search_by_name(query: string)` — fuzzy match note names via `app.vault.getMarkdownFiles()`.
  - `list_all_tags()` — enumerate every tag in the vault from `metadataCache.getTags()`.
  All three are read-only and would be auto-approved under FR-017. v0.1's `search_content` (full-text) already exists.

---

## Phase 1: Chat keybinding (Enter / Shift+Enter / IME)

### Changes Required:

- **`src/ui/ChatView.ts`** (modify):
  - **Refactor the existing `keydown` listener** (lines 145-162 area) rather than adding a new one. Today it binds Ctrl/Cmd+Enter → `handleSendOrStop`. v0.2 retires that binding: Ctrl/Cmd+Enter is removed entirely (Enter alone is the single send keybind; Stop is only via the Stop button) so that the spec invariant "Enter does NOT call Stop while streaming" holds and there is no second send keybind that ALSO stops streams.
  - Add `compositionstart`, `compositionend` listeners on the textarea. Track `isComposing` on the view (`compositionstart` → true, `compositionend` → false). Also respect `event.isComposing` and `event.keyCode === 229` for browsers/Electron versions that don't fire `compositionend` before `keydown`.
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
- [ ] Pressing **Ctrl/Cmd+Enter** during an in-flight stream does NOT stop it (the old v0.1 behavior is gone); only the Stop button stops a stream.

---

## Phase 2: Vault-aware preamble + Settings section

### Changes Required:

- **`src/domain/PreambleAssembler.ts`** (new):
  - Pure function `assemblePreamble(input: { mode: 'none' | 'default' | 'custom'; vaultRootAbsPath: string; timezone: string; todayInTimezone: string; customBody?: string }): string`. **All time-dependent values are inputs, not computed inside the function**, so the assembler stays pure and FR-021's "identical output for identical inputs" contract is testable. **Note: vault folder/file enumeration is deliberately NOT an input** — per updated FR-006/FR-007 the model obtains structure on demand via the `vault_tree` / `vault_metadata` tools, which the preamble names in its tool-inventory block.
  - For `none`: returns empty string (caller skips prepending).
  - For `default`: returns the vault root path line, the timezone line, today's date in that timezone formatted `YYYY-MM-DD`, the fixed **vault-tool inventory block** (a constant string enumerating `vault_tree`, `vault_metadata`, `get_active_note`, `list_recent_notes`, `find_backlinks`, plus v0.1's `view`/`read_file`/`search_content`/`create_file`/`edit_file`/`delete_file` with one-line usage hints each), and the fixed authoring-conventions block (FR-006a/b/c).
  - For `custom`: returns `customBody` verbatim, substituting documented placeholders (`{{VAULT_ROOT}}`, `{{VAULT_TIMEZONE}}`, `{{VAULT_TODAY}}`, `{{VAULT_TOOL_INVENTORY}}`, `{{AUTHORING_CONVENTIONS}}`) only when present in the template.
  - Tool-inventory and authoring-conventions blocks stored as constants alongside the assembler (single source of truth, deterministic). The tool-inventory constant is generated from a manifest the new-tool factories (Phase 3 and Phase 4) export, so adding a tool there automatically updates the preamble inventory in lockstep — a unit test asserts coverage (every exported new-tool name appears in the inventory string).
- **`src/domain/PreambleAssembler.test.ts`** (new) — covers all three modes, all placeholder substitutions (including `{{VAULT_TIMEZONE}}`, `{{VAULT_TODAY}}`, `{{VAULT_TOOL_INVENTORY}}`, `{{AUTHORING_CONVENTIONS}}`), the timezone-line presence-in-default / absence-in-none assertion, the deterministic-output assertion (same inputs → byte-identical string, FR-021), the **size-bound assertion** that the assembled default preamble remains under 4 KB regardless of vault contents (matches updated Spec line 157), and the tool-inventory-coverage assertion (every tool name exported by `ReadNoteTools.ts` / `WriteNoteTools.ts` appears in the inventory string).
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
  2. Computes `timezone` via `Intl.DateTimeFormat().resolvedOptions().timeZone` and `todayInTimezone` via the shared `now: () => Date` clock (the same clock injected into `createWriteNoteTools` in Phase 4 so gate-time and preamble-time stay symmetric)
  3. Calls `assemblePreamble` with all of those as inputs.
  Returns the assembled string or null when mode = none. **Note: no vault enumeration happens here** — the preamble is constant per vault root, so this callback is cheap and deterministic.
- **`src/sdk/AgentSession.test.ts`** (modify): add tests asserting first-send prepending happens, second-send is untouched, `preamble: () => null` short-circuits, `resetConversation` re-arms the prepend.

### Success Criteria:

#### Automated Verification:
- [ ] `npm test` — new assembler tests + AgentSession integration tests pass; all v0.1 tests stay green.
- [ ] `npm run build` — strict TS builds clean.
- [ ] Test asserting deterministic output: same inputs → byte-identical string (FR-021).

#### Manual Verification:
- [ ] In test vault: open Settings → Vault Awareness, observe Default mode preview shows vault root path + timezone + today + vault-tool inventory + authoring-conventions block. No folder/file enumeration.
- [ ] Switch to None, restart session, observe preamble is empty.
- [ ] Switch to Custom with a body containing `{{VAULT_ROOT}}` only, restart session, observe tool-inventory and authoring-conventions block are absent.
- [ ] Ask "what's in my vault?" on a fresh session: the agent makes exactly one auto-approved `vault_tree` call (Phase 3) and answers — no general shell discovery, no approval prompt.
- [ ] Automated size-bound test asserts the assembled default preamble is under 4 KB regardless of vault size.

---

## Phase 3: ObsidianApi helper + read-only tools

### Changes Required:

- **`src/tools/ObsidianApi.ts`** (new):
  - Constructor takes `app: App` (typed loosely the same way `main.ts` does today, via narrow interfaces) and reuses `resolveVaultPath`/`lookupTFile` from `VaultPath.ts`.
  - Methods used by Phase 3 tools:
    - `getActiveFile()` → `app.workspace.getActiveFile()` and `getActiveViewOfType(MarkdownView)?.editor` for the editor surface.
    - `listRecentlyModifiedNotes(maxN)` → `app.vault.getMarkdownFiles()` sorted by `TFile.stat.mtime` descending, sliced to `maxN`.
    - `getResolvedLinks()` → `app.metadataCache.resolvedLinks` (a record `sourcePath → { targetPath: count }`). Used as the index for `find_backlinks` to identify SOURCE files; link-form discrimination requires the per-source `getFileCache` call below.
    - `getFileCache(file)` → `app.metadataCache.getFileCache(file)` — returns headings, tags, frontmatter, and `links[]` (each with `original` and `position`). Used by `find_backlinks` for link-form discrimination AND by `vault_metadata`.
    - `getVaultTree(folder, depth, nodeCap)` → recursive walk of `app.vault.getAbstractFileByPath(folder)`'s `children`, bounded by `depth` and `nodeCap`; returns a tree node structure with `name`, `path`, `kind: 'file' | 'folder'`, `size?`, `mtime?`, `children?`, and a `truncated` flag.
  - Methods used by Phase 4 tools:
    - `openFile(file)` → `app.workspace.getLeaf(false).openFile(file)` (returns the discriminated union shape on any thrown error).
    - `getEditorForActive()` / `applyEditorTransform(mode, content)` → uses `Editor.replaceRange`, `Editor.getValue`, `Editor.setCursor` to satisfy the cursor behavior spec'd in FR-012.
    - `getDailyNotesConfig()` → `app.internalPlugins.plugins['daily-notes']?.instance?.options` (folder, format, template) or `{ ok: false, reason: 'plugin-not-enabled' }`.
    - `isCommunityPluginEnabled(id)` → `app.plugins.plugins[id] != null`.
  - Each method returns a discriminated union `{ ok: true; value: T } | { ok: false; reason: 'no-active-note' | 'no-editor' | 'plugin-not-enabled' | 'native-failed' | 'index-unavailable'; cause?: unknown }`.
- **`src/tools/ObsidianApi.test.ts`** (new): unit tests with a mocked `App` covering happy paths and the failure shapes. Tests use plain fixtures matching the `ReadToolsVault`/`WriteToolsVault` precedent — no full Obsidian mock required.
- **`src/tools/ReadNoteTools.ts`** (new) — five new read-only capabilities; exported as `createReadNoteTools(api: ObsidianApi, vault: ReadToolsVault): Tool[]`. All five satisfy the read-only checklist (strict read-only, validated path inputs, bounded scope, no symlink escape, no unbounded walks) and run with `skipPermission: true` (FR-017). Each tool source carries the JSDoc read-only checklist block per `src/tools/ReadTools.ts:53-78`. **Tool-name manifest**: this file also exports `READ_NOTE_TOOL_NAMES = ['get_active_note', 'list_recent_notes', 'find_backlinks', 'vault_tree', 'vault_metadata'] as const` so `PreambleAssembler.ts`'s tool-inventory coverage test can verify every name is in the inventory string.
  - `get_active_note` — calls `api.getActiveFile()`; returns `{ path, content }` (read content via `vault.cachedRead ?? vault.read`); errors as structured `no_active_note`.
  - `list_recent_notes(n)` — `n` defaults to 20, capped at 100. Sorts by `TFile.stat.mtime` desc.
  - `find_backlinks(targetPath)` — first tries the resolved-link index. Iterates source files via `app.metadataCache.resolvedLinks` to find which sources point to the resolved target, then for each source reads `app.metadataCache.getFileCache(sourceFile)?.links` to obtain the per-link `original` string and `position`; the link form is determined by `original.startsWith('[[')` (`'wikilink'` vs `'markdown'`) — `resolvedLinks` alone does NOT carry link-form information (per gemini cycle-2 finding 2). On `index-unavailable`, falls back to a bounded markdown-file scan (regex over `[[wikilink]]` and `[text](path)`), capped by the same per-file size and total-file caps as `ReadTools.search_content` (`MAX_SEARCH_MATCHES = 50` per call). Result includes `usedFallback: boolean`, `truncated: boolean`, and per-result `linkForm: 'wikilink' | 'markdown'`.
  - `vault_tree(folder?: string, depth?: number)` (NEW for cycle-2 design pivot) — returns folder/file hierarchy under `folder` (default: vault root). `depth` defaults to 2, max 5. Total node count capped at `MAX_TREE_NODES = 500`; truncation reported in `truncated: boolean` and `truncatedAt: string` (path where truncation occurred). Source: `app.vault.getAbstractFileByPath(folder)` then recursive walk over `children` filtering TFile/TFolder. For each TFile: include `name`, `path`, `size` (`stat.size`), `mtime` (`stat.mtime`). For each TFolder: include `name`, `path`, recursive `children`. Path validated via `resolveVaultPath` (no symlink escape, must be within vault). Returns structured `not_found` if the folder doesn't exist; `not_a_folder` if it resolves to a file. (FR-015c, FR-017)
  - `vault_metadata(path: string)` (NEW for cycle-2 design pivot) — returns the metadata-cache view for a single note: tags (from `metadataCache.getFileCache(path)?.tags` AND frontmatter tags merged & deduped), headings (with level + position), frontmatter (entire YAML object), outbound link targets (resolved paths from `resolvedLinks[path]`), and file stats (size, mtime). **Does NOT return the note body** — callers wanting body use `read_file` or `get_active_note`. Path validated via `resolveVaultPath`. Returns structured `not_found` if path resolves to no file. Bounded by single-file lookup. (FR-015d, FR-017)
- **`src/tools/ReadNoteTools.test.ts`** (new): tests for each capability — success, structured-error paths, fallback path for `find_backlinks` (proves `usedFallback: true` and `truncated: true` when caps trip), the 20/100 caps for `list_recent_notes`, the link-form discrimination for `find_backlinks` (assert wikilink vs markdown sources from a fixture metadataCache), `vault_tree` happy paths at depth 1/2/5, depth-bound enforcement, node-count cap enforcement (assert `truncated: true` and `truncatedAt` populated), `vault_tree` not_found and not_a_folder errors, `vault_metadata` returns the expected shape and does NOT include note body, `vault_metadata` merges inline+frontmatter tags. Also assert every tool exports `skipPermission: true` and carries the read-only-checklist JSDoc.
- **`src/main.ts`** (modify): construct `ObsidianApi` once, pass to `createReadNoteTools`. Append the returned tools onto the existing `tools: [...readTools, ...writeTools, ...readNoteTools]` array passed to the `CopilotAgentSession` constructor.

### Success Criteria:

#### Automated Verification:
- [ ] `npm test` — `ObsidianApi` + read-note tests pass (≥10 new tests this phase, cumulative ≥23); v0.1 tests still green.
- [ ] `npm run build` — strict TS clean.
- [ ] Each new read-only tool source carries the read-only-checklist JSDoc.
- [ ] Test asserts `skipPermission: true` on all five new tools (`get_active_note`, `list_recent_notes`, `find_backlinks`, `vault_tree`, `vault_metadata`).
- [ ] Test asserts every name in `READ_NOTE_TOOL_NAMES` appears in `PreambleAssembler`'s tool-inventory constant (lockstep test).

#### Manual Verification:
- [ ] In test vault, ask the agent "list my recent notes" — answer returns within one assistant turn, NO approval prompt shown.
- [ ] Ask "what links to <existing-note>" with at least one inbound link — backlinks listed correctly, link-form (wikilink vs markdown) reported. Compare against Obsidian's Backlinks pane.
- [ ] With an empty workspace (no active markdown view), ask "what's in my active note" — agent reports a structured no-active-note response, not a crash.
- [ ] Ask "what's in my vault?" — agent makes exactly one auto-approved `vault_tree` call (depth 2, bounded to 500 nodes) and answers; no general shell discovery.
- [ ] Ask "what tags does <note> have?" — agent makes exactly one auto-approved `vault_metadata` call and answers without reading the note body (verify in dev console: no `read_file` / `view` / `get_active_note` call followed `vault_metadata`).

---

## Phase 4: Vault-aware mutating tools + open_note

### Changes Required:

- **`src/tools/WriteNoteTools.ts`** (new) — five new capabilities; exported as `createWriteNoteTools(deps: { api: ObsidianApi; vault: WriteToolsVault; workspace: WorkspaceForWrites; undoJournal: UndoJournal; vaultAwareness: () => VaultAwarenessSettings; now: () => Date }): Tool[]`. **Fallback reuse mechanism**: this factory does NOT call `createWriteTools()` (which returns SDK `Tool` objects with their own permission gating, schemas, and registration metadata — wrapping those would double-register). Instead, Phase 4 begins with a small refactor of `src/tools/WriteTools.ts` that extracts the per-tool handler bodies into named exported functions (`createFileHandler(deps, args)`, `editFileHandler(deps, args)`, `deleteFileHandler(deps, args)`); the existing `createWriteTools` factory continues to call those internally, preserving v0.1 behavior; and the new Phase-4 capabilities call them directly for the fallback path. This keeps a single source of truth for vault-API write semantics and undo-journal recording.
  - `create_note(path, content?)` — path validated via `resolveVaultPath`. Tries the **richer surface first** (calls `api.createNote()` which uses `vault.create` plus `metadataCache` warm-up); on `native-failed`, falls back to invoking the v0.1 `create_file` handler logic directly (same `WriteToolsDeps`, same `vault.create`, same `UndoJournal` recording). On collision (`vault.create` rejects with EEXIST or `lookupTFile` already returns a file), returns structured `collision` error (NEVER overwrites). Result: `{ ok, path, undoId, usedFallback: boolean }`. Runs without `skipPermission`.
  - `edit_note(path, mode, content)` — modes: `append`, `prepend`, `replace`. Tries `api.modifyNote()` (which uses `vault.modify`). **Mode application is performed inside `edit_note` itself, not delegated to v0.1's `edit_file` handler** (which only knows full-replace semantics): for `append`/`prepend`, read existing content via `vault.cachedRead`, concatenate, then write the full result; for `replace`, write `content` directly. On richer-surface failure, fall back to the extracted `editFileHandler(deps, { path, content: fullyComposedContent })` so the same `vault.modify` + `UndoJournal` recording runs, but the mode transform has already been applied. **Unsaved-editor-conflict guard: edit_note inherits v0.1's check** — `WorkspaceForWrites.getLeavesOfType('markdown')` is consulted before calling `vault.modify`, and if the target is open with unsaved changes the write is refused with a structured `unsaved_editor_conflict` error (matches updated spec FR-010 / P3 AS#3 / FR-019). Result: `{ ok, path, undoId, usedFallback }`. Runs without `skipPermission`.
  - `open_note(path)` — path validated via `resolveVaultPath`; calls `api.openFile()` (uses `app.workspace.getLeaf(false).openFile()`). **No filesystem mutation; not in FR-016's gated set; matches P7 expectation of no approval.** Set `skipPermission: true` and include a JSDoc justification block patterned after `ReadTools.ts:53-78`, explicitly documenting: (a) no fs effect, (b) `resolveVaultPath` validation, (c) bounded to a single vault-scoped file lookup, (d) workspace navigation only — no content read or write. If the path doesn't resolve to an existing note, returns a structured `not_found` error.
  - `insert_into_active_note(content, mode)` — modes: `append`, `prepend`, `replace`. Resolves the active editor via `api.getEditorForActive()`; applies through `Editor.replaceRange` so cursor behavior matches the spec (append leaves cursor in place; prepend shifts cursor by the count of inserted code-points; replace places cursor at the end of the inserted content). **Read-only guard (FR-012)**: before any mutation, check `api.isActiveFileReadOnly()` (workspace-leaf state + file frontmatter `cssclasses` if conventionally used); on true, return structured `{ ok: false, reason: 'read_only', path }` and do NOT attempt write. **Unsaved-conflicts: per updated spec FR-012, the active-editor path does NOT apply the unsaved-editor guard** — the editor buffer IS the authoritative state. On `no-editor` falls back to calling the **extracted `editFileHandler(deps, { path, content: composedFullContent })`** directly (NOT the gated `edit_note` SDK tool) so the outer `insert_into_active_note` gate remains the single approval (P3 AS#2 "exactly one approval"). The handler invocation still runs the unsaved-editor guard because it writes to disk. Returns structured `no_active_note` if there is no active markdown editor AND no resolvable file. **No `undoId` is returned for the editor-surface path** because `UndoJournal` records disk state and cannot safely revert an editor-buffer mutation; the result carries `undoSurface: 'editor-native'` so callers know to rely on Obsidian's native Ctrl+Z. The fallback (extracted-handler) path DOES return a real `undoId` (disk surface). Result: `{ ok, path, mode, cursorAdjusted, usedFallback, undoSurface: 'editor-native' | 'disk', undoId?: string }`. Runs without `skipPermission`.
  - `create_daily_note()` — reads `api.getDailyNotesConfig()`. When ok: resolves folder, filename format (default `YYYY-MM-DD`), and **template content** (reads the template file at the configured template path via `vault.cachedRead`; empty string when no template is configured or the template file is missing — log a warning); then invokes the **extracted `createFileHandler(deps, { path: resolvedPath, content: templateContent })`** directly (NOT the gated `create_note` SDK tool) so the new daily note is seeded with the template body inside the SAME single approval flow as the outer `create_daily_note` (FR-013, P4 AS#4 "one approval prompt"). When ok=false reason=`plugin-not-enabled`: falls back to creating `YYYY-MM-DD.md` at vault root with no template, again via `createFileHandler`. Calling on existing daily note returns `{ ok: true, noop: true, path }` without overwriting. Result includes `source: 'plugin-config' | 'fallback'` AND `templateApplied: boolean`. **`create_daily_note` itself runs WITHOUT `skipPermission` — it IS the outermost gate; the inner `createFileHandler` calls are intentionally NOT re-gated** (handler-extraction pattern from FR-016 cycle-1 fix #16 extended to intra-suite chains). **Plugin reload note**: when the user upgrades from v0.1 to v0.2 by reloading the plugin, `SafetyState` is constructed fresh, so any prior session-allow-all grants do not leak across the upgrade — no migration step is required for FR-016 conformance.
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
  - Add `create_task(input)` capability to the factory. **Input contract: the tool DOES NOT parse ambiguous date strings.** It accepts `dueDate?: string` and `scheduledDate?: string` in strict `YYYY-MM-DD` format only; any other shape (including "Friday", "tomorrow", "next week") is rejected with structured `{ ok: false, reason: 'invalid_date_format', field: 'dueDate' | 'scheduledDate' }`. Per spec FR-015a and P5 AS#4, the **model** is responsible for resolving relative/ambiguous dates against the timezone+today provided by the preamble (FR-006) before invoking the tool, so the already-resolved date appears in the approval prompt for user review. This keeps date resolution transparent to the user.
  - Detects plugin via `api.isCommunityPluginEnabled('obsidian-tasks-plugin')`.
  - Calls `formatTaskLine` with the appropriate source.
  - Resolves target = `vaultAwareness.taskTargetMode === 'custom-path' ? vaultAwareness.customTaskTargetPath : <today's daily note via the extracted resolveDailyNotePath helper>`. When the resolved target doesn't exist (typical for the daily-note default on the first call of the day, or for a brand-new custom path), the capability creates it inside the same single approval flow by calling the **extracted `createFileHandler`** directly (NOT the gated `create_note` / `create_daily_note` SDK tools). For default daily-note targets, also reads template content via the same path `create_daily_note` uses (vault.cachedRead) and seeds the file.
  - Appends the line by calling the **extracted `editFileHandler(deps, { path: targetPath, content: existing + taskLine + '\n' })`** (NOT the gated `edit_note` SDK tool) — `create_task` is the outermost gate; the entire create-target + append sequence runs under that single approval (P5 AS#3 "same single approval flow"). The mode-application logic from `edit_note` (append → read+concat+write) is duplicated here to avoid re-entering the gated tool surface.
  - Returns `{ ok, targetPath, formatSource: 'tasks-plugin' | 'gfm', existingTargetCreated: boolean, usedFallback: boolean }`.
  - Settings: read `vaultAwareness.taskTargetMode` and `vaultAwareness.customTaskTargetPath` from the same `safetySettingsStore.snapshot()` callback used in Phase 2. Wire the settings reader through the same `WriteNoteTools` factory deps (add a `vaultAwareness: () => VaultAwarenessSettings` callback).
- **`src/tools/WriteNoteTools.test.ts`** (modify): add `create_task` tests — Tasks-plugin-present, Tasks-plugin-absent, target-doesn't-exist creates daily note, Settings-driven custom target override (assert it reads from the injected settings callback), **strict-date-only contract** (assert that `dueDate: 'Friday'` or `dueDate: 'tomorrow'` returns `invalid_date_format` and does NOT mutate the vault), `usedFallback` correctly reported.
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

## Phase 6: Task editing (`update_task` + `find_tasks`)

**Status**: promoted mid-flight from Phase Candidates after Phase 5 ship. The current `edit_note` is functionally sufficient but operationally poor for tasks: every edit requires a full-file replace with a scary diff, the model has to perfectly re-emit emoji/field ordering, and batch flows ("tag every communication task") become N approvals over N notes. Phase 6 adds two surgical, task-aware tools.

### Changes Required:

- **`src/tools/TaskFormat.ts`** (modify):
  - Add `TaskStatus = "todo" | "in-progress" | "done" | "cancelled"` (4 statuses; `- [/]` is the canonical in-progress marker per Tasks plugin status collections — Minimal Theme + SlRvb's Alternate Checkboxes both map `/` → IN_PROGRESS — see CodeResearch.md Phase 6 §1).
  - Add `completedDate?: string` and `cancelledDate?: string` to `TaskInput` (strict `YYYY-MM-DD`). Tasks plugin emits these as `✅ <date>` / `❌ <date>` on terminal transitions (Tasks docs `Getting Started/Dates.md`).
  - Add `status?: TaskStatus` to `TaskInput`. `formatTaskLine` currently hard-codes `- [ ]`; change to emit the correct checkbox symbol (`[ ]`/`[/]`/`[x]`/`[-]`) based on `status` (default `"todo"`).
  - Extend stable field ordering: `<checkbox> <desc> [priority] [📅 due] [⏳ scheduled] [➕ created] [✅ completed] [❌ cancelled] [#tag …]` for tasks-plugin source; mirror with `(completed: …)` / `(cancelled: …)` for gfm.
  - Add `parseTaskLine(line: string): { ok: true; parsed: TaskInput & { status, completedDate?, cancelledDate?, leadingIndent: string, source: TaskFormatSource, rawStatusSymbol: string } } | { ok: false }`. Tolerant parser — handles both tasks-plugin emoji and our gfm `(field: value)` flavor, recognizes the 4 canonical status symbols, preserves leading indent. Unparseable / non-task lines return `{ ok: false }`. Round-trip invariant: `parseTaskLine(formatTaskLine(input, src)).parsed` equals `input` for all valid inputs (covered by a property-style test).
  - Re-emission: when `update_task` writes back, it calls `formatTaskLine(patched, parsed.source)` so the same flavor is preserved (do not flip a tasks-plugin line into gfm).
- **`src/tools/TaskFormat.test.ts`** (modify): add parse tests for all 4 statuses in both flavors, both date-stamp emoji, round-trip property tests, unparseable-line rejection, format tests for new status checkbox symbol, completedDate/cancelledDate ordering.

- **`src/tools/ObsidianApi.ts`** (modify):
  - Extend `FileCacheLike` to expose `listItems?: ReadonlyArray<{ position: { start: { line: number } }; task?: string }>` (currently exposes tags/headings/frontmatter/links only — see CodeResearch.md Phase 6 §3). This is a narrow surface for Tasks discovery.
  - No new method needed; `find_tasks` calls `api.getFileCache(file)` and reads `listItems`.

- **`src/tools/FindTasks.ts`** (new) + tests:
  - `findTasksImpl(filter: FindTasksFilter, deps): Promise<FindTasksResult>` where filter accepts `{ tag?, status?, dueBefore?, dueAfter?, descriptionRegex?, path? }`. Enumerates via `vault.getMarkdownFiles()` (mirrors `search_vault` in `ReadTools.ts:275-359`); per-file: `api.getFileCache(file).listItems` filtered to `task !== undefined` gives candidate line numbers; read file content once and slice the matching lines; `parseTaskLine` each; apply filter; return `[{ path, line, raw, parsed }]` with **1-based** `line` numbers (matching existing search convention — note: Obsidian's cache is 0-based, we adjust).
  - Optional `path` filter restricts to a single file (avoids enumerating the whole vault for "find tasks in today's daily note").
  - Caps: 500 results per call (mirrors `search_vault`), 5 MB per-file size limit.
  - Returns `{ ok: true, results, truncated, scanned }`.

- **`src/tools/UpdateTask.ts`** (new) + tests:
  - `updateTaskImpl(input: UpdateTaskInput, deps): Promise<UpdateTaskResult>` where input is:
    - `path: string` — vault-relative
    - `line: number` — 1-based line number from `find_tasks`
    - `descriptionMatch?: string` — optional re-anchor; if the line at `line` doesn't parse as a task containing `descriptionMatch`, search nearby (±10 lines) for a matching task and use the first hit. If still no match, return `{ ok: false, reason: 'task_not_found' }`.
    - `patch`: structured `{ addTags?: string[], removeTags?: string[], setPriority?: TaskPriority | null, setDueDate?: string | null, setScheduledDate?: string | null, setStatus?: TaskStatus, setDescription?: string }`. `null` clears the field; omitted = leave alone.
  - Flow: read file → parse target line → apply patch (tag merge is set-union with sanitization, idempotent; status changes auto-stamp/strip ✅/❌ today via `deps.now()`) → re-format via `formatTaskLine(patched, parsed.source)` → preserve `parsed.leadingIndent` → write whole-file via `editFileImpl` (single journal undo entry).
  - **Strict-date contract** (same as `create_task`): `setDueDate` / `setScheduledDate` accept strict `YYYY-MM-DD` or `null` only. Anything else → `{ ok: false, reason: 'invalid_date_format', field }` (vault not mutated). Model resolves relative dates against preamble timezone (FR-006).
  - **Idempotency**: if the patch is a no-op (e.g., `addTags: ['x']` when `#x` already present and no other field changed), return `{ ok: true, changed: false, reason: 'no_change' }` without writing. No approval prompt for no-ops handled by SafetyPolicy gate inspecting an early return.
  - **Status auto-stamping**:
    - `setStatus: 'done'` → adds `completedDate = today` (only if not already set), clears `cancelledDate`
    - `setStatus: 'cancelled'` → adds `cancelledDate = today` (only if not already set), clears `completedDate`
    - `setStatus: 'todo'` or `'in-progress'` → clears both `completedDate` and `cancelledDate` (transitioning out of terminal state)
  - **Approval prompt detail** (rendered as plain-text `<pre>` — CodeResearch.md Phase 6 §5):
    ```
    file: <path>:<line>
    before: <raw line>
    after:  <formatted line>
    ```
  - Returns `{ ok: true, path, line, changed, before, after, undoId, undoSurface: 'journal' }`. Undo restores the file's prior content (single modify entry from `editFileImpl`).

- **`src/tools/WriteNoteTools.ts`** (modify): register `update_task` in the factory (gated like `create_task`); handler delegates to `updateTaskImpl`. No re-entry into other gated tools (calls `editFileImpl` directly).

- **`src/tools/ReadNoteTools.ts`** (modify): register `find_tasks` in the factory with `skipPermission: true` (read-only, no vault mutation — mirrors `find_backlinks` / `vault_tree`). Handler delegates to `findTasksImpl`.

- **`src/tools/WriteTools.ts`** (modify): add `update_task` to `VAULT_WRITE_TOOL_NAMES` (line 362-381) so SafetyPolicy classifies it as `source: "vault"`.

- **`src/domain/vaultToolManifest.ts`** (modify): add entries for both new tools (`update_task` = write/non-read-only, `find_tasks` = read-only) so the preamble inventory stays accurate.

- **`src/domain/PreambleAssembler.ts`** (modify): extend the authoring-conventions block with:
  - One-sentence mention of `update_task` / `find_tasks` with the standard workflow ("call `find_tasks` first, then `update_task` per result with the returned `path` + `line`").
  - Note the strict-date contract applies to `update_task` too.
  - Status vocabulary: `todo` / `in-progress` / `done` / `cancelled`.
  - Re-run Phase 2 deterministic-output tests after this tweak.

- **`src/sdk/AgentSession.ts`** (modify): `buildSafetyInput`'s `extractVaultPath` (line 1241-1266) needs a case for `update_task` to extract `args.path` (already the default; verify no override needed since args already have `path`).

- **`src/main.ts`** (modify): no factory wiring changes needed — both tools are registered through existing `createReadNoteTools` / `createWriteNoteTools` factories with the same deps.

- **Tests**:
  - `src/tools/FindTasks.test.ts` (new): single-file filter, tag filter, status filter (all 4), due-range filter, regex filter, 500-result truncation, 1-based line numbers, non-task lines ignored, both format flavors.
  - `src/tools/UpdateTask.test.ts` (new): each patch field individually (addTags/removeTags/setPriority/setDueDate/setScheduledDate/setStatus×4/setDescription), idempotent no-op short-circuit, strict-date rejection for both date fields, descriptionMatch re-anchor (line moved up/down within ±10), task_not_found when re-anchor fails, status auto-stamp on done/cancelled, strip ✅/❌ when transitioning back to todo/in-progress, undoId surfaced, leadingIndent preserved, source flavor preserved (tasks-plugin stays tasks-plugin).
  - `src/domain/PreambleAssembler.test.ts` (modify): update fixture for the conventions block.
  - `src/domain/SafetyPolicy.test.ts` (modify): `update_task` classified as vault; `find_tasks` classified as read-only.

### Success Criteria:

#### Automated Verification:
- [ ] `npm test` — all new tests pass; Phase 2 / 5 tests still green after authoring-conventions tweak; total test count grows by ~40.
- [ ] `npm run typecheck` — clean.
- [ ] `npm run build` — clean.

#### Manual Verification:
- [ ] In a vault with several tasks across multiple notes: ask "find all my tasks tagged #work that are due before next Friday" — single read-only call (no approval), structured candidate list returned in chat.
- [ ] Pick one and ask "mark that done" — single approval showing `before:` / `after:` for ONE line; the task line gets `- [x] … ✅ <today>` (or `(completed: <today>)` for gfm); Undo button reverts cleanly.
- [ ] Ask "tag all my communication tasks with #communication" — model uses `find_tasks` to enumerate candidates, then issues one `update_task` per result. Each approval shows a tiny per-line diff. Re-running is idempotent (no-op approvals reported, vault not mutated).
- [ ] Mark a task in-progress (`setStatus: 'in-progress'`) — produces `- [/]`. Verify Tasks plugin Theme picks it up as IN_PROGRESS.
- [ ] Mark a `done` task back to `todo` — `✅` date is stripped.
- [ ] Edit a task in a file open in the editor with unsaved changes — refused with same error as `edit_note`'s dirty-buffer guard.

---



## Phase 7: Documentation

### Changes Required:

- **`.paw/work/chat-ux-vault-tools/Docs.md`** (new): Technical reference (load `paw-docs-guidance` skill for templates):
  - Architecture diagram showing `ChatView` ↔ `CopilotAgentSession` (with first-send preamble prepender) ↔ `PreambleAssembler` and the `ObsidianApi` ↔ tool capabilities ↔ `decideSafety`/`UndoJournal` paths.
  - Per-capability tool surface reference (signatures, error shapes, fallback semantics, format-source reporting). Cover all v0.2 capabilities including Phase 6's `update_task` / `find_tasks`.
  - Vault Awareness Settings UX walk-through (modes, custom body placeholder syntax, preview).
  - Task editing workflow: `find_tasks` → `update_task` pattern, all 4 statuses with their checkbox symbols, auto-stamped completion/cancellation dates, strict-date contract, line-number convention (1-based to match search).
  - Verification matrix mapping SC-001..SC-010 to specific manual steps and to test files.
- **`README.md`** (modify): update "What's new in v0.2" or similar section. Document Enter-to-send, Shift+Enter, IME handling. Document new capabilities including Phase 5 (`create_task`) and Phase 6 (`update_task` + `find_tasks`). Document Vault Awareness setting (with an explicit privacy note: top-level folder names are in the prompt by default; switch to None for sensitive vaults). Update "What is NOT in v0.1" → mark items now shipped in v0.2 and clearly note workflow B items remaining out of scope.
- **`CHANGELOG.md`** (modify or create if absent following project convention): add a v0.2 section enumerating user-visible changes (keybinding, vault-aware preamble, eleven+ new capabilities, Tasks/Calendar integration via daily-note write target, full task editing toolset).
- **Verify SC-001..SC-010 manually** and capture the results in `Docs.md`'s verification matrix.

### Success Criteria:

#### Automated Verification:
- [ ] `npm test` — full suite still green at end of phase.
- [ ] `npm run build` — clean.
- [ ] Markdown linter (if present in repo) — clean. (No new linter added if not already present per repo convention.)

#### Manual Verification:
- [ ] Docs.md verification matrix has a row per SC, each marked done, with the test file path or manual step recorded.
- [ ] README's "What's new" reflects ship state; "What is NOT" items are accurate.
- [ ] CHANGELOG entry mentions every user-visible change including task editing tools.

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
