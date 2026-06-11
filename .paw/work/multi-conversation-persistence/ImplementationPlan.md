# Multi-Conversation & Persistence (v0.3) Implementation Plan

<!--
Generated via multi-model planning (gpt-5.4 + gemini-3.1-pro-preview + claude-opus-4.7).
Per-model drafts live in ./planning/ (gitignored). Final structure follows the opus draft,
which front-loads independent low-risk wins (Phases 1-2) before the persistence/runtime
refactor, and explicitly names the FR-007 captured-at-send-time invariant. A per-conversation-
runtime alternative (one CopilotAgentSession per conversation, surfaced by gpt-5.4) is
documented in Phase 4 as a fallback if the captured-at-send-time approach proves fragile
during implementation.
-->

## Overview

v0.3 transforms the chat panel from a single ephemeral thread into a durable, multi-conversation workspace and extends the Undo journal across plugin reloads. Alongside this, v0.3 ships three deferred v0.2 usability wins: gating the v0.1 raw-filesystem tools behind an opt-in setting (so the model leans on the v0.2 vault tools), and three new auto-approved read-only search tools (`search_by_tag`, `search_by_name`, `list_all_tags`) that route through the universal permission gate. The v0.2 baseline (universal permission gate, FR-017 read-only auto-approval, streaming/Stop semantics, token rotation, 13 vault tools, 410/410 tests) must remain intact through every phase.

## Current State Analysis

- The plugin constructs **one** of everything at load: one `UndoJournal`, one `CopilotAgentSession`, one `ChatView` with one private `ChatState` (`src/main.ts:69-71`, `src/main.ts:166-183`, `src/main.ts:289-292`, `src/ui/ChatView.ts:38-42`). There is no conversation concept and no abstraction for "thread of messages plus its undo journal."
- Chat history lives only in `ChatState`'s private `messages: Message[]` array (`src/domain/ChatState.ts:10-17`); it is not persisted. Closing the leaf or reloading the plugin discards it.
- `UndoJournal` stores entries in a private `Map`; the class header explicitly notes it is in-memory only and cleared on reload (`src/domain/UndoJournal.ts:1-5`, `src/domain/UndoJournal.ts:72-84`). Entry data is already fully serializable (`id`, `kind`, `scope`, `path`, optional `before`/`after`, `recordedAt`, `undone` — `src/domain/UndoJournal.ts:22-35`).
- Persistence today uses Obsidian's `Plugin.loadData()` / `saveData()` through two independent stores (`TokenStore`, `SafetySettingsStore`) that share a `data.json` blob. Each store re-reads the blob, spreads unknown top-level keys, merges its own subtree, and writes back via a tail-serialized promise (`src/auth/TokenStore.ts:81-108`, `src/settings/SafetySettingsStore.ts:147-169`). No schema-version field exists yet; corruption recovery is per-field defaulting only.
- Tool registration is a single concatenation in `main.ts`: `[...v01ReadTools, ...v01WriteTools, ...v02ReadNoteTools, ...v02WriteNoteTools]` passed to `CopilotAgentSession` (`src/main.ts:78-89`, `src/main.ts:144-164`, `src/main.ts:178-183`). There is no gating layer — the six raw-FS tools (`view`, `read_file`, `search_content`, `create_file`, `edit_file`, `delete_file`) are always offered (`src/domain/vaultToolManifest.ts:32-61`).
- `ObsidianApi` wraps per-file metadata (`getFileCache` — `src/tools/ObsidianApi.ts:225-232`) but has no `metadataCache.getTags()` wrapper. Note-search patterns currently iterate `vault.getMarkdownFiles()` (`src/tools/ObsidianApi.ts:186-192`, `src/tools/ReadTools.ts:284-312`). Read-only tools register `skipPermission: true` and follow the checklist at `src/tools/ReadTools.ts:53-75`.
- The chat header is minimal (title + status — `src/ui/ChatView.ts:120-125`); there is no picker. UI is DOM-only (Obsidian `createDiv`/`createEl`); unit tests run in node/no-DOM via Vitest (`vitest.config.ts:4-8`), so any picker logic must be extractable into a pure module the way `src/ui/chatKeydown.ts` is.
- In-flight streaming is bound to a captured `currentPlaceholderId` and a captured `session` reference inside the streaming loop (`src/ui/ChatView.ts:317-341`, `src/sdk/AgentSession.ts:465-468`). Pending approvals live on the single `CopilotAgentSession`'s global maps (`src/sdk/AgentSession.ts:305-326`). v0.3 conversation-switching must not perturb either.

## Desired End State

- A user can create, switch, rename, and delete named conversations from a picker at the top of the chat pane; up to 20 active conversations are surfaced (older ones soft-archive on disk).
- Conversation list, per-conversation message history, active-conversation id, and per-conversation undo entries persist via Obsidian plugin data and survive plugin reload, Obsidian restart, and OS reboot; corruption produces a Notice + `.bak` recovery, not a crash.
- An in-flight assistant stream continues to land in its originating conversation even when the user switches to view a different conversation; Stop, approvals, and token rotation behave exactly as in v0.2.
- Undo on a tool-driven file change works the same after a restart (within 7 days, last 50 per conversation), with a confirmation prompt when the target file has been modified externally since the snapshot.
- A new setting "Expose v0.1 raw-filesystem tools" (default OFF) hides the six v0.1 raw-FS tools from the SDK tool list on the next session start; turning it back ON restores prior behavior.
- Three new read-only tools (`search_by_tag`, `search_by_name`, `list_all_tags`) are registered with `skipPermission: true`, satisfying the FR-017 checklist, and are auto-approved through the universal permission gate.
- `npm test`, `npm run typecheck`, and `npm run build` all pass; the 410 v0.2 tests remain green and new test count is additive only.

### Verification approach
- Automated: Vitest suites for each new module (persistence store, conversation manager, undo serialization, tool-gating, three search tools, picker pure logic). Targeted regression suites for stream-while-switching, approval persistence binding, and raw-FS gating both ON and OFF.
- Manual: deploy via `npm run deploy`, then run the five user-story flows from the spec (P1–P5) plus the four edge-case flows (corruption recovery, 21st-conversation archival, file-modified-since-snapshot undo, file-deleted-since-snapshot undo).

## What We're NOT Doing

Copied verbatim from `Spec.md` § Scope / Out of Scope:

- MCP integration.
- Extra-vault filesystem roots.
- Model picker UI / per-conversation model selection.
- Mid-session settings reload (settings continue to apply on the next session start).
- Tag-rename / tag-create capability surface.
- SDK changes (transport preamble continues via first-message prepending in `CopilotAgentSession`).
- Per-vault Daily Notes target override (deferred candidate dropped after dogfooding showed no observed pain).
- Showing or restoring archived conversations from the picker.
- Sharing conversations across vaults or syncing them through Obsidian Sync (vault-local data only).
- Conversation export / import.
- Search-by-content fuzzy matching (current substring `search_content` continues unchanged).
- Cross-conversation tool-call inspection (each conversation's undo journal is private to that conversation).

## Phase Status

- [ ] **Phase 1: Raw-FS tool gating** — Introduce the `exposeRawFsTools` setting and filter the tool list at session-construction time.
- [ ] **Phase 2: New read-only search tools** — Add `search_by_tag`, `search_by_name`, `list_all_tags` through the FR-017 read-only path.
- [ ] **Phase 3: Persistence foundation** — Introduce versioned `ConversationsStore` with corruption recovery, debounced writes, and the v0.2-compatible top-level-merge pattern.
- [ ] **Phase 4: Conversation manager + persisted UndoJournal** — Refactor `UndoJournal` and chat state behind a per-conversation `ConversationManager` with serialization adapters; preserve in-flight stream binding.
- [ ] **Phase 5: Multi-conversation chat UI** — Add the picker, CRUD affordances, archive-at-21 behavior, and v0.2-session migration on first load.
- [ ] **Phase 6: Cross-restart Undo finalization** — Apply 7-day TTL + 50-entry cap on load, file-modified-since-snapshot confirmation, persistent "Undone" marker, and gated-tool history rendering rules.
- [ ] **Phase 7: Documentation** — Update README, CHANGELOG, and Docs.md for v0.3.

## Phase Candidates

<!-- Items the spec mentions in passing or that emerged during research as "would be nice but not in v0.3" -->

- [ ] "Show archived" gesture in the picker (spec FR-002 retains data on disk to enable this later).
- [ ] Conversation export / import (Out of Scope, but persisted shape is already versioned and serializable).
- [ ] fzf-style fuzzy ranking for `search_by_name` (Assumption notes substring + bucket ranking is sufficient for v0.3).
- [ ] Per-conversation model selection (Out of Scope; would slot into the picker UI).
- [ ] Inline "Restore archived" command and an Obsidian command-palette entry for switching conversations by name.
- [ ] Snapshot compression for large undo `before`/`after` payloads to push past the 5 MB soft limit gracefully.
- [ ] A shared `PluginDataService` that consolidates the three top-level-merge stores (`auth`, `safety`, `conversations`) behind one tail-serialized writer.

---

## Phase 1: Raw-FS tool gating

### Changes Required:

- **`src/settings/SafetySettingsStore.ts`**: Extend `SafetySettings` with `exposeRawFsTools: boolean` (default `false`); apply the same field-by-field defaulting in `mergeWithDefaults` that `defaultMode`/`allowlist` use; preserve unknown top-level keys on write as today (`src/settings/SafetySettingsStore.ts:147-169`).
- **`src/settings/SettingsTab.ts`**: Add a new `Setting` row "Expose v0.1 raw-filesystem tools" in the safety section using the existing `addToggle` + `onChange → store setter` pattern (`src/settings/SettingsTab.ts:90-146`). Description must mention "takes effect on the next session start" (FR-015).
- **`src/main.ts`**: After constructing the four tool arrays (`src/main.ts:78-89`, `src/main.ts:144-164`), filter out the six `WRITE_TOOL_NAMES` ∪ `{view, read_file, search_content}` entries from the SDK-bound concat when `exposeRawFsTools === false` (`src/main.ts:178-183`). The `ALL_VAULT_TOOL_ENTRIES` manifest stays unchanged so historical messages still render tool names.
- **`src/domain/vaultToolManifest.ts`**: Export a `V01_RAW_FS_TOOL_NAMES` constant (the six names) that both `main.ts` (for filtering) and the renderer (for "gated, cannot re-invoke" rendering — covered in Phase 6) can reuse without re-declaring the list.
- **`src/domain/PreambleAssembler.ts`**: Accept the same filtered tool-entries list (or a `excludeRawFs` flag) so the preamble's tool inventory matches the SDK manifest when gating is on (`src/domain/PreambleAssembler.ts:114-115`).
- **Tests**:
  - `src/settings/SafetySettingsStore.test.ts` (existing): add coverage for default `false`, round-trip persistence, and `mergeWithDefaults` on a missing field.
  - New `src/main.toolGating.test.ts` (or extend existing) verifying the filtered list contains 0 raw-FS tools when off and all 6 when on, given a stubbed registry.
  - `src/domain/PreambleAssembler.test.ts` (existing): cover gated-off preamble omitting the six entries.

### Success Criteria:

#### Automated Verification:
- [ ] Tests pass: `npm test`
- [ ] Typecheck: `npm run typecheck`
- [ ] Build: `npm run build`

#### Manual Verification:
- [ ] With setting OFF (default), prompting "read README.md" causes the agent to call `read_note`, never `read_file`/`view`.
- [ ] Toggling the setting ON, reloading the plugin, and re-prompting allows the agent to invoke `read_file`.
- [ ] An existing v0.2 conversation referencing `edit_file` still renders text + result when the setting is OFF.

---

## Phase 2: New read-only search tools

### Changes Required:

- **`src/tools/ObsidianApi.ts`**: Extend `AppLike["metadataCache"]` with optional `getTags?(): Record<string, number>` and an optional `getMarkdownFiles`-backed tag→files traversal helper. Add wrapper methods `listAllTags()` and `findFilesByTag(tag)` that preserve native `this` the same way `getFileCache` does (`src/tools/ObsidianApi.ts:106-108`, `src/tools/ObsidianApi.ts:225-232`). Both must return a `metadata-cache-not-ready` discriminated status (consistent with the existing `index-unavailable`/`not-found` pattern) so the agent can retry per Risks § "metadata cache populating."
- **`src/tools/SearchTools.ts`** (new): Implement `search_by_tag`, `search_by_name`, `list_all_tags` following the `createReadNoteTools` registration pattern (`src/tools/ReadNoteTools.ts:29-46`, `src/tools/ReadNoteTools.ts:57-208`). All three use `skipPermission: true`; the FR-017 read-only checklist comment from `ReadTools.ts:53-75` is duplicated/adapted at the top. Tag normalization (leading `#` stripped) lives in a small pure helper.
  - `search_by_tag`: combines `cache.tags` + frontmatter tags via the same merge as `vault_metadata` (`src/tools/ReadNoteTools.ts:588-634`); cap 200 results with a `truncated: true` flag.
  - `search_by_name`: iterates `vault.getMarkdownFiles()`; bucket-ranks exact > prefix > substring (case-insensitive); cap 50.
  - `list_all_tags`: prefers `metadataCache.getTags()` when available, falls back to scanning `getFileCache` for each markdown file; sorts by count desc.
- **`src/domain/vaultToolManifest.ts`**: Add three new entries to a new `V03_READ_TOOL_ENTRIES` block and append into `ALL_VAULT_TOOL_ENTRIES` (`src/domain/vaultToolManifest.ts:147-152`). Mark all three R/O so `PreambleAssembler` renders the `_(R/O)_` suffix (`src/domain/PreambleAssembler.ts:114-115`).
- **`src/main.ts`**: Construct via `createSearchTools(obsidianApi, vault)` next to `createReadNoteTools` and concatenate ahead of write-note tools (`src/main.ts:144-164`).
- **`src/sdk/AgentSession.ts`**: `buildSafetyInput()` already classifies unknown tool names as `builtin`; verify the three new names are explicitly classified as `vault`/read so the universal permission gate routes them through the FR-017 auto-approve path (`src/sdk/AgentSession.ts:1242-1282`).
- **Tests**:
  - New `src/tools/SearchTools.test.ts`: tag with/without `#`, empty vault, `#` not present, truncation at 200, ranking buckets for name search, sort order for `list_all_tags`, `metadata-cache-not-ready` status path.
  - Extend `src/tools/ObsidianApi.test.ts` for the new wrappers' `this`-preservation (mirror existing test at `:288-316`).
  - Extend `src/sdk/AgentSession.test.ts` (or whichever covers `buildSafetyInput`) to confirm the three names are auto-approved.

### Success Criteria:

#### Automated Verification:
- [ ] Tests pass: `npm test`
- [ ] Typecheck: `npm run typecheck`
- [ ] Build: `npm run build`

#### Manual Verification:
- [ ] "what tags are in my vault" calls `list_all_tags` with no approval prompt.
- [ ] "show me notes tagged #project" returns exactly the matching notes; tag normalization works with or without `#`.
- [ ] On a fresh vault open before the metadata cache is ready, calling a search tool returns the not-ready status and the agent retries.

---

## Phase 3: Persistence foundation

### Changes Required:

- **`src/persistence/ConversationsStore.ts`** (new): A third top-level-merge store living alongside `TokenStore` and `SafetySettingsStore`. Owns the `conversations` and `activeConversationId` keys plus a top-level `schemaVersion: 1`. Mirrors the proven contract:
  - Injected `PluginDataIO` (the same shape passed to `TokenStore` from `src/main.ts:59-66`).
  - Tail-serialized writes via a single tail promise (follow `TokenStore.flush()` merge-and-write at `src/auth/TokenStore.ts:81-108`).
  - Debounced flush at ≤1 write per 500 ms (spec NFR) — implement as a `scheduleFlush()` helper that coalesces calls.
  - `load()` is async, validates schema version, normalizes per-field, and on parse failure: (a) renames the existing `data.json` to `<original>.bak` via Obsidian adapter, (b) returns defaults, (c) emits a one-shot `recovered: true` flag the plugin surfaces as a Notice.
  - Public API: `loadAll()`, `getActiveId()`, `setActiveId(id)`, `listConversations()`, `upsertConversation(c)`, `removeConversation(id)`, `appendMessage(convId, msg)`, `replaceMessage(convId, msgId, partial)`, `recordUndo(convId, entry)`, `markUndone(convId, entryId)`, `pruneOnLoad()` (applies 7-day TTL and last-50 cap per FR-011).
- **`src/persistence/PersistedShape.ts`** (new): Type declarations for `PersistedConversation`, `PersistedMessage`, `PersistedUndoEntry`, `PersistedState`. `PersistedMessage` mirrors `Message` from `src/domain/types.ts:15-77` minus any non-serializable handles. `schemaVersion = 1`.
- **`src/persistence/migrate.ts`** (new): Stub `migrate(raw: unknown): { state: PersistedState; recovered: boolean }`. v0.3 only knows `schemaVersion === 1`; anything else triggers the recovery path. Document the migration-policy contract in a top-of-file comment so v0.4+ has a stable extension point (Risk § "future migrations").
- **`src/main.ts`**: After `safetyStore` (`src/main.ts:59-66`), construct `conversationsStore = new ConversationsStore({ loadData: …, saveData: …, adapter: this.app.vault.adapter })`; defer `await conversationsStore.load()` into the existing async hydration block (`src/main.ts:261-268`). On `recovered: true`, show a `new Notice(...)`.
- **Tests**:
  - New `src/persistence/ConversationsStore.test.ts`: round-trip save/load, top-level-merge preserves `auth`/`safety` keys (mirror `TokenStore` tests), debounce coalescing, schema-version mismatch triggers `.bak` rename + recovery flag, malformed JSON triggers recovery, write tail-serialization (two concurrent flushes complete in order).
  - New `src/persistence/migrate.test.ts`: known version passes through; unknown version flags `recovered: true`.

### Success Criteria:

#### Automated Verification:
- [ ] Tests pass: `npm test`
- [ ] Typecheck: `npm run typecheck`
- [ ] Build: `npm run build`

#### Manual Verification:
- [ ] Deploy → trigger a load → confirm `data.json` gains a `conversations` key while `auth`/`safety` remain intact.
- [ ] Corrupt `data.json` to `{conversations: "garbage", schemaVersion: 999}` → reload plugin → a Notice appears, `.bak` exists on disk, plugin still loads.

---

## Phase 4: Conversation manager + persisted UndoJournal

### Changes Required:

- **`src/domain/Conversation.ts`** (new): A `Conversation` aggregates `id`, `name`, `createdAt`, `lastActiveAt`, `archived`, an owned `ChatState`, and an owned `UndoJournal`. Provides `toPersisted()` / `static fromPersisted(...)` adapters that map to `PersistedConversation`/`PersistedUndoEntry` from Phase 3.
- **`src/domain/ConversationManager.ts`** (new): Owns the in-memory map of `Conversation` objects, the `activeId`, and the policy logic (FR-002 soft cap at 20, FR-005 auto-naming + suffix-disambiguation, FR-009 active-on-load resolution). Emits a small `subscribe(listener)` change-feed for the chat view. Each mutating call writes through to `ConversationsStore` (debounced).
- **`src/domain/UndoJournal.ts`**: Make the existing class accept an optional `{ persist?: (entry, op) => void; initialEntries?: PersistedUndoEntry[] }` constructor argument. Public API surface (`record`, `get`, `undo`, `clear`) is unchanged so existing call sites in `src/tools/WriteTools.ts:101-201` and `src/tools/WriteNoteTools.ts:104-206` keep working. `record()` calls `persist(entry, "add")` after store, `undo()` calls `persist(entry, "mark-undone")` on success. Update the class header comment to reflect persistence.
- **`src/domain/ConversationManager.ts`** wires each `Conversation`'s journal `persist` callback into `ConversationsStore.recordUndo` / `markUndone`.
- **`src/main.ts`**: Replace the single `new UndoJournal()` at `src/main.ts:69-71` with a manager-owned construction. Tool factories (`createWriteTools`, `createWriteNoteTools`) currently expect a single journal; introduce an indirection `getJournalForActiveConversation()` (a function the manager exposes) so the existing factory signatures don't break — tools always operate on the active conversation's journal (which is the conversation whose stream triggered the tool call, per FR-007 captured-at-send-time semantics).
  - Important: this indirection must be captured **at send time** alongside `currentPlaceholderId` (`src/ui/ChatView.ts:317-341`) so a mid-stream conversation switch does not redirect an in-flight tool's undo entry to the wrong conversation.

### Architectural alternative (documented, not chosen)

A second architecture was surfaced during multi-model planning: spin up **one `CopilotAgentSession` per conversation** instead of sharing one global session with active-at-send-time capture in `ChatView`. The per-conversation-runtime approach removes the binding-discipline risk entirely (each session naturally owns its own stream and approval maps) at the cost of a larger refactor and slightly higher idle memory (≤ 20 sessions). The captured-at-send-time approach was chosen because:
- Only one stream is in flight at any time (the input is disabled while streaming — verify in `src/ui/ChatView.ts:317-341`), so concurrent streams across conversations are not a real concern in v0.3.
- It keeps `CopilotAgentSession` construction, auth wiring, and preamble assembly unchanged from v0.2.
- Phase 4's regression tests directly exercise the binding discipline.

If during Phase 4 implementation the captured-at-send-time discipline proves fragile (e.g., pending approvals leak between conversations in manual testing), fall back to per-conversation `ConversationRuntime` objects each owning their own `CopilotAgentSession` / `ChatState` / `UndoJournal`. This is a self-contained change within `ConversationManager` and `ChatView`.
- **`src/ui/ChatView.ts`**: Replace the private `state = new ChatState()` (`src/ui/ChatView.ts:38`) with an indirection that reads `manager.getActive().state`. The streaming loop captures `const conv = manager.getActive()` once at send time and writes deltas/tool-calls into `conv.state` regardless of which conversation is currently displayed. `syncList()` continues to render `manager.getActive().state.getMessages()` from the subscribed change-feed.
- **`src/sdk/AgentSession.ts`**: Unchanged. Per CodeResearch (`:465-468`, `:703-704`) the SDK already captures session locally; the conversation binding is layered above the SDK in `ChatView`.
- **Tests**:
  - New `src/domain/ConversationManager.test.ts`: CRUD, soft-cap archive-at-21, FR-005 auto-naming + disambiguation, FR-009 active resolution (active still exists, active was deleted, none exist).
  - New `src/domain/UndoJournal.persistence.test.ts`: hydration from `initialEntries`, `persist` callback called on `record` and `undo`, existing v0.2 behavior unchanged when no `persist` is provided.
  - Extend `src/ui/ChatView` keydown/UI tests with a node-friendly fake manager to assert streaming-into-originating-conversation when active changes mid-stream (refactor into a pure helper module like `src/ui/chatKeydown.ts` per the repo's DOM-free testing convention).

### Success Criteria:

#### Automated Verification:
- [ ] Tests pass: `npm test`
- [ ] Typecheck: `npm run typecheck`
- [ ] Build: `npm run build`
- [ ] 410 v0.2 baseline tests remain green.

#### Manual Verification:
- [ ] Start a long stream in conversation A, switch to a fresh conversation B mid-stream → B shows nothing new, A's stream completes correctly when re-selected.
- [ ] An approval prompt fired during a stream in A remains bound to A even if the user views B before resolving it.

---

## Phase 5: Multi-conversation chat UI

### Changes Required:

- **`src/ui/ConversationPicker.ts`** (new): Pure DOM-construction module returning the picker root element + a controller object (`{ render(), destroy(), onSelect, onCreate, onRename, onDelete }`). The picker shows current name + chevron, opens a list of non-archived conversations sorted by `lastActiveAt` desc plus a "New conversation" entry (FR-003/FR-020). Long names truncate with CSS ellipsis.
- **`src/ui/conversationPickerLogic.ts`** (new, DOM-free): Pure functions for sort order, truncation, suffix-disambiguation lookup, and "should archive" computation. Tested in node per `vitest.config.ts:4-8` (mirrors `src/ui/chatKeydown.ts`).
- **`src/ui/ChatView.ts`**: Add the picker to the existing header (`src/ui/ChatView.ts:120-125`) above the title row. Wire `onCreate`/`onSelect`/`onRename`/`onDelete` to the `ConversationManager`. On `onSelect`, re-subscribe `syncList()` to the new active conversation's state. Confirmation dialog for delete uses Obsidian's modal pattern. Approval-prompt and Undo-button handlers (currently `src/ui/ChatView.ts:133-148`) read from the active conversation's renderer.
- **`src/ui/ChatViewRegistration.ts`**: Inject the `ConversationManager` into the view dependency object alongside the existing agent/undoJournal/auth (`src/ui/ChatViewRegistration.ts:14-20`).
- **`src/main.ts`**: Pass `conversationManager` into `registerChatView` (`src/main.ts:289-307`). On first v0.3 load with empty persisted data, run FR-019 migration: if a `ChatView` instance is currently live with non-empty `ChatState`, seed a single conversation from it; else create one empty "Untitled" conversation.
- **`styles.css`**: Add classes for `.copilot-agent-conv-picker`, `.copilot-agent-conv-picker-list`, `.copilot-agent-conv-picker-item`, ellipsis truncation, hover/active states. Keep visual styling consistent with the existing chat header.
- **Tests**:
  - New `src/ui/conversationPickerLogic.test.ts`: sort, truncation, suffix-disambiguation, archive-trigger on 21st.
  - Extend `src/domain/ConversationManager.test.ts` to cover the FR-019 migration branch (empty persisted + non-empty in-memory ChatState → one seeded conversation with auto-name).

### Success Criteria:

#### Automated Verification:
- [ ] Tests pass: `npm test`
- [ ] Typecheck: `npm run typecheck`
- [ ] Build: `npm run build`

#### Manual Verification:
- [ ] Create two conversations with distinct messages, switch via picker → each shows only its own history.
- [ ] Rename a conversation → reload Obsidian → rename persists, picker order intact.
- [ ] Delete a conversation with confirmation → it disappears from picker and from `data.json`.
- [ ] Create 21 conversations → the oldest non-active archives (no longer in picker); reopen `data.json` to confirm its data is retained on disk.
- [ ] Picker remains usable when the pane is narrowed.

---

## Phase 6: Cross-restart Undo finalization

### Changes Required:

- **`src/domain/UndoJournal.ts`**: Add a constructor option `loadOptions: { ttlMs: number; maxEntries: number }` used by `pruneOnLoad()` to drop entries older than 7 days and to keep only the last 50 per journal (FR-011). The drop happens during `ConversationManager` hydration before the journal is exposed to UI.
- **`src/domain/UndoJournal.ts`**: Extend `undo()` (`src/domain/UndoJournal.ts:97-188`) so the "file content matches snapshot" guard returns a discriminated `divergence: "modified" | "missing" | "ok"` result instead of throwing/silently bailing. The caller (chat renderer) decides whether to prompt.
- **`src/ui/ChatView.ts`** (Undo handler at `:133-148`): When `divergence === "modified"` or `"missing"`, open an Obsidian modal with a brief description ("File was modified outside the agent on …" / "File no longer exists; recreate from snapshot?"). On explicit confirm, call `undo({ force: true })`.
- **`src/persistence/ConversationsStore.ts`**: `markUndone(convId, entryId)` writes through immediately (no debounce) so a successful undo survives a fast restart — FR-013.
- **`src/ui/messageRenderer.ts`** (or wherever tool-call rows render): When rendering a historical tool-call whose tool name is in `V01_RAW_FS_TOOL_NAMES` and the setting is currently OFF, suppress the Undo button (FR-016) — the tool name and result text still render normally. The renderer must already render historical tool-calls; this is a conditional on button visibility only.
- **`src/persistence/ConversationsStore.ts`**: Track persisted data size; when it crosses 5 MB on save, surface a one-shot `new Notice("Copilot Agent: conversation data exceeds 5 MB; consider pruning old conversations")` (SC-011). Use a `sizeWarned: boolean` field in memory so the Notice fires once per session.
- **Tests**:
  - New `src/domain/UndoJournal.crossRestart.test.ts`: hydrate with mixed-age entries → TTL drops the right ones; >50 entries → only last 50 retained; `undo()` returns `divergence: "modified"` when mtime/size differ; `undo({force: true})` restores; `markUndone` persistence flag is read on re-hydrate.
  - Extend `src/ui/ChatView` test surface (via the pure-helper extraction approach) for the gated-tool-no-Undo-button rule and the modified-file confirmation branch.
  - Extend `src/persistence/ConversationsStore.test.ts` for the 5 MB Notice trigger.

### Success Criteria:

#### Automated Verification:
- [ ] Tests pass: `npm test`
- [ ] Typecheck: `npm run typecheck`
- [ ] Build: `npm run build`

#### Manual Verification:
- [ ] Run an `edit_note`, restart Obsidian, click Undo within 7 days → file reverts; entry shows "Undone" and Undo button disappears.
- [ ] Edit the same file manually after the tool call, then click Undo → modal explains divergence, requires confirmation; on confirm, file reverts.
- [ ] Delete the targeted file manually, then click Undo → modal offers to recreate from snapshot.
- [ ] Backdate an entry's `recordedAt` past 7 days in `data.json`, reload → entry is dropped from storage and no Undo button appears.
- [ ] In a conversation with 60 undoable entries, reload → only the last 50 retain Undo buttons; older tool-call messages still render.

---

## Phase 7: Documentation

### Changes Required:

- **`.paw/work/multi-conversation-persistence/Docs.md`** (new): Technical reference following the style of `.paw/work/chat-ux-vault-tools/Docs.md`. Sections: multi-conversation model (entities, lifecycle, archive policy), persistence layout (`data.json` keys, schema version, corruption recovery, `.bak` policy), cross-restart Undo contract (TTL, cap, divergence prompt, "Undone" finality), raw-FS gating contract (toggle, next-session-start semantics), new search tools (signatures, FR-017 auto-approval rationale, MetadataCache dependency), migration-policy contract for future schema versions.
- **`README.md`**: New "v0.3 — Multi-Conversation & Persistence" H2 section near the top of release notes following the existing pattern (`README.md:31-47`). Cover: conversation picker, restart-resume, cross-restart Undo, raw-FS toggle (and one-time Notice on first v0.3 load explaining the change), three new search tools.
- **`CHANGELOG.md`**: New v0.3 entry mirroring existing version section style (`CHANGELOG.md:6-24`). Categorized H3s: Added (picker, persistence, search tools, raw-FS toggle), Changed (Undo now survives restart; raw-FS tools no longer exposed by default), Migration (one-time Notice; how to re-enable raw-FS tools).
- **`.github/copilot-instructions.md`**: No changes expected unless the deploy/test workflow shifts; verify no documented invariants are broken.

### Success Criteria:

#### Automated Verification:
- [ ] Build: `npm run build`
- [ ] Typecheck: `npm run typecheck`
- [ ] Tests pass: `npm test`

#### Manual Verification:
- [ ] README, CHANGELOG, and Docs.md are consistent with shipped behavior (no TBDs; toggle name and default exactly match the Settings UI; tool names exactly match the SDK manifest).
- [ ] Docs.md "What is NOT in v0.3" enumerates the Out-of-Scope items from Spec § Scope (SC-012).

---

## References

- Issue: none
- Spec: `.paw/work/multi-conversation-persistence/Spec.md`
- Research: `.paw/work/multi-conversation-persistence/CodeResearch.md`
- Prior art: `.paw/work/chat-ux-vault-tools/ImplementationPlan.md` (v0.2)
