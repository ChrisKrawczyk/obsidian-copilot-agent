---
date: 2026-06-10T19:14:05.759-07:00
git_commit: 1e1885597a25ec641e011eb67d0cce4d7ce7d47d
branch: feature/multi-conversation-persistence
repository: obsidian-copilot-agent
topic: "Multi-conversation persistence v0.3 implementation research"
tags: [research, codebase, conversations, persistence, undo, tools, chat-ui]
status: complete
last_updated: 2026-06-10
---

# Research: Multi-Conversation & Persistence v0.3

## Research Question

Map the existing v0.2 implementation points needed for v0.3: multi-conversation chat, persistent conversations and undo journals, raw-filesystem tool gating, three new read-only search tools, streaming behavior while switching conversations, and persisted-data/schema handling.

## Summary

- Plugin startup currently constructs one `CopilotAgentSession`, one `UndoJournal`, one `ChatState` inside `ChatView`, and wires them together through `registerChatView` (`src/main.ts:69-71`, `src/main.ts:166-183`, `src/main.ts:289-292`, `src/ui/ChatView.ts:38-42`, `src/ui/ChatViewRegistration.ts:14-20`).
- Persisted plugin data is stored through Obsidian `Plugin.loadData()` / `saveData()` with top-level `auth`, `settings`, and `safety` keys; stores serialize writes with a tail promise and re-read before saving to avoid clobbering unrelated top-level keys (`src/auth/TokenStore.ts:17-20`, `src/auth/TokenStore.ts:81-108`, `src/settings/SafetySettingsStore.ts:79-80`, `src/settings/SafetySettingsStore.ts:147-169`).
- Undo entries already contain serializable data (`id`, `kind`, `scope`, `path`, optional `before`/`after`, `recordedAt`, `undone`) and the current public API is `record`, `get`, `undo`, and `clear` (`src/domain/UndoJournal.ts:22-35`, `src/domain/UndoJournal.ts:72-84`, `src/domain/UndoJournal.ts:97-193`).
- Tool registration is centralized in `main.ts` by concatenating raw v0.1 read/write tools and v0.2 note/task tools into the SDK `tools` option; the manifest separately lists v0.1 tool names as `V01_TOOL_ENTRIES` (`src/main.ts:178-183`, `src/domain/vaultToolManifest.ts:32-61`).
- Current metadata-cache wrappers expose per-file cache (`getFileCache`) and vault markdown file enumeration, but no `getTags()` wrapper yet (`src/tools/ObsidianApi.ts:44-45`, `src/tools/ObsidianApi.ts:106-108`, `src/tools/ObsidianApi.ts:186-192`, `src/tools/ObsidianApi.ts:225-232`).

## Documentation System

- **Framework**: Plain Markdown; no mkdocs/docusaurus/sphinx config found in repository root. Standard docs are repository Markdown files and PAW artifacts (`README.md:1`, `CHANGELOG.md:1`).
- **Docs Directory**: N/A for product docs; workflow artifacts live under `.paw/work/<work-id>/` as Markdown (existing v0.2 artifacts include `.paw/work/chat-ux-vault-tools/Docs.md`).
- **Navigation Config**: N/A; no navigation configuration file is present.
- **Style Conventions**: README uses H1 then H2 sections with bullet-heavy release notes and fenced shell commands (`README.md:1`, `README.md:7`, `README.md:31-47`, `README.md:91-96`). CHANGELOG uses versioned H2 sections and categorized H3 headings (`CHANGELOG.md:1`, `CHANGELOG.md:6-24`).
- **Build Command**: N/A for docs. Repository build command is `npm run build` (`package.json:8-13`).
- **Standard Files**: `README.md`, `CHANGELOG.md`, `.github/copilot-instructions.md`.

## Verification Commands

- **Test Command**: `npm test` -> `vitest run` (`package.json:8-13`).
- **Lint Command**: No lint script is declared in `package.json` (`package.json:8-13`).
- **Build Command**: `npm run build` -> `node esbuild.config.mjs production` (`package.json:8-13`).
- **Type Check**: `npm run typecheck` -> `tsc --noEmit` (`package.json:8-13`); TypeScript strict mode and noEmit are set in `tsconfig.json` (`tsconfig.json:3-17`).
- **Deploy Command**: `npm run deploy` builds and runs `scripts/deploy.mjs` (`package.json:8-13`, `README.md:43-47`).
- **Test Environment**: Vitest runs in Node and includes `src/**/*.test.ts` (`vitest.config.ts:4-8`). Existing test files cover auth, domain, SDK, tools, and UI keydown behavior.

## Detailed Findings

### 1. Persistence Layer and Current Data Shape

- `TokenStore` persists OAuth token state through injected `PluginDataIO.loadData()` / `saveData()` (`src/auth/TokenStore.ts:22-24`). `main.ts` injects the plugin methods directly (`src/main.ts:59-66`).
- The current auth/settings persisted shape is `auth?: { token?: string | null }` and `settings?: { persistEnabled?: boolean }` (`src/auth/TokenStore.ts:17-20`). `persistEnabled` defaults to `true`, while absent token defaults to `null` (`src/auth/TokenStore.ts:41-48`).
- `TokenStore.flush()` re-reads the latest blob, spreads all existing top-level properties, and merges only its `auth` and `settings` subtrees before calling `saveData` (`src/auth/TokenStore.ts:93-108`).
- `SafetySettingsStore` uses a separate top-level `safety` key alongside `auth` and `settings` (`src/settings/SafetySettingsStore.ts:1-10`, `src/settings/SafetySettingsStore.ts:79-80`). Its persisted `SafetySettings` includes `defaultMode`, `allowlist`, `autoApproveBuiltins`, and nested `vaultAwareness` (`src/settings/SafetySettingsStore.ts:23-57`).
- `SafetySettingsStore.persist()` snapshots settings, notifies listeners, re-reads the latest blob, spreads all existing top-level properties, and writes `safety: snap` (`src/settings/SafetySettingsStore.ts:147-169`).
- Both stores serialize writes via a tail promise (`src/auth/TokenStore.ts:81-90`, `src/settings/SafetySettingsStore.ts:172-180`). There is no general shared persistence service; each store owns its own tail.
- Current load behavior normalizes missing or malformed safety data to defaults through `mergeWithDefaults` (`src/settings/SafetySettingsStore.ts:90-97`, `src/settings/SafetySettingsStore.ts:183-207`). `TokenStore.load()` treats non-object or empty data as an empty object (`src/auth/TokenStore.ts:34-38`).
- Observed interaction point for adding top-level `conversations` and `undoJournals`: existing stores preserve unknown top-level keys via object spread when saving (`src/auth/TokenStore.ts:102-106`, `src/settings/SafetySettingsStore.ts:165-168`).

### 2. Conversation Lifecycle and Message State

- `CopilotAgentPlugin.onload()` creates a single `UndoJournal` before tool construction (`src/main.ts:69-71`). That same journal is passed to v0.1 write tools, v0.2 write-note tools, and the chat view (`src/main.ts:81-89`, `src/main.ts:153-164`, `src/main.ts:289-292`).
- `CopilotAgentPlugin.onload()` creates one `CopilotAgentSession` and stores it in `this.agent` (`src/main.ts:166-183`, `src/main.ts:248`). The plugin disposes that one session on unload (`src/main.ts:316-324`).
- The chat view is registered with a dependency object containing the single agent, auth controller, undo journal, and settings opener (`src/main.ts:289-307`, `src/ui/ChatViewRegistration.ts:14-20`). `registerChatView` reuses an existing leaf if one exists, otherwise creates a right-side leaf and sets view state (`src/ui/ChatViewRegistration.ts:38-45`).
- `ChatView` owns UI-level message history in a private `ChatState` field (`src/ui/ChatView.ts:38`). `ChatState` stores a private `messages: Message[]` array and exposes snapshot, append, update, delta, interrupt, tool-call upsert, clear, and subscribe operations (`src/domain/ChatState.ts:10-17`, `src/domain/ChatState.ts:28-45`, `src/domain/ChatState.ts:61-76`, `src/domain/ChatState.ts:90-104`, `src/domain/ChatState.ts:117-147`).
- `ChatView.handleSend()` appends the user message and a pending assistant placeholder to `ChatState` before starting the SDK stream (`src/ui/ChatView.ts:305-323`). Streaming deltas and tool events mutate the same placeholder (`src/ui/ChatView.ts:330-410`). Completion updates the placeholder to `complete`, `interrupted`, or `error` (`src/ui/ChatView.ts:428-471`).
- Message data includes `MessageStatus`, `ToolCall`, and `Message` shapes in `src/domain/types.ts`; messages can include `toolCalls` (`src/domain/types.ts:15-22`, `src/domain/types.ts:71-77`).
- `CopilotAgentSession` owns SDK runtime/session state, not UI message rendering state: fields include `client`, `session`, `toolsList`, and approval/stream helpers (`src/sdk/AgentSession.ts:239-303`, `src/sdk/AgentSession.ts:357-359`). The SDK session is created with `tools: this.toolsList` during reset/init (`src/sdk/AgentSession.ts:800-808`, `src/sdk/AgentSession.ts:953-957`).

### 3. UndoJournal Contract and Captured Snapshot Data

- `UndoEntry` fields are serializable primitives plus optional strings: `id`, `kind`, `scope`, `path`, optional `before`, optional `after`, numeric `recordedAt`, and optional `undone` (`src/domain/UndoJournal.ts:22-35`).
- `UndoJournal.record()` assigns `undo-${++idCounter}` when no id is supplied, stamps `Date.now()`, stores the entry in a private `Map`, and returns the stored entry (`src/domain/UndoJournal.ts:72-80`).
- `UndoJournal.get()` returns a single entry by id (`src/domain/UndoJournal.ts:83-84`), `undo()` applies guard checks and filesystem operations (`src/domain/UndoJournal.ts:97-188`), and `clear()` empties the map (`src/domain/UndoJournal.ts:191-193`).
- Create undo entries record `kind: "create"`, `scope: "vault"`, `path`, and `after` content (`src/tools/WriteTools.ts:101-106`, `src/tools/WriteNoteTools.ts:104-109`).
- Modify undo entries record `kind: "modify"`, `scope: "vault"`, `path`, `before`, and `after` (`src/tools/WriteTools.ts:195-201`, `src/tools/WriteNoteTools.ts:200-206`).
- Delete undo entries record `kind: "delete"`, `scope: "vault"`, `path`, and `before` (`src/tools/WriteTools.ts:252-257`).
- `update_task` delegates the actual write to `editFileImpl`, so its returned `undoId` is the file-level modify journal entry from that path (`src/tools/UpdateTask.ts:155-170`).
- Undo guard behavior is content-based: create undo requires the file still exists and current content equals `after`; modify undo requires current content equals `after` then restores `before`; delete undo requires the file to still be absent then recreates from `before` (`src/domain/UndoJournal.ts:113-175`).
- The current class comment states the journal is in-memory only and cleared on plugin reload / Obsidian restart (`src/domain/UndoJournal.ts:1-5`).

### 4. Tool Registration and Raw-FS Gating Points

- `main.ts` constructs v0.1 read tools with `createReadTools(vault)`, v0.1 write tools with `createWriteTools({ vault, workspace, undoJournal })`, v0.2 read-note tools with `createReadNoteTools(obsidianApi, vault)`, and v0.2 write-note tools with `createWriteNoteTools(...)` (`src/main.ts:78-89`, `src/main.ts:144-164`).
- These four arrays are concatenated directly into `CopilotAgentSession` `tools` (`src/main.ts:178-183`). This is the call site where a setting-gated subset can change the SDK-visible tool list before session creation.
- `CopilotAgentSession` stores the provided tools as `toolsList` and passes them into SDK `client.createSession` (`src/sdk/AgentSession.ts:357-359`, `src/sdk/AgentSession.ts:800-804`, `src/sdk/AgentSession.ts:953-957`).
- The manifest documents v0.1 raw-filesystem tool entries as `view`, `read_file`, `search_content`, `create_file`, `edit_file`, and `delete_file` (`src/domain/vaultToolManifest.ts:11-12`, `src/domain/vaultToolManifest.ts:32-61`). `ALL_VAULT_TOOL_ENTRIES` concatenates v0.1, read-note, and write-note entries for inventory presentation (`src/domain/vaultToolManifest.ts:147-152`).
- `PreambleAssembler` reads `ALL_VAULT_TOOL_ENTRIES` to list tools in the vault-aware preamble and marks read-only entries with `_(R/O)_` (`src/domain/PreambleAssembler.ts:1`, `src/domain/PreambleAssembler.ts:114-115`).
- v0.1 read tools `read_file`, `view`, and `search_content` register with `skipPermission: true`; `read_file` and `view` also override built-ins (`src/tools/ReadTools.ts:79-167`). The read-tool exemption checklist is documented at the top of `ReadTools.ts` (`src/tools/ReadTools.ts:53-75`).
- v0.1 write tools register `create_file`, `edit_file`, and `delete_file` without `skipPermission`; the names are exported as `WRITE_TOOL_NAMES` (`src/tools/WriteTools.ts:264-363`).
- `AgentSession.buildSafetyInput()` classifies registered write tools by name into `source: "vault"`; other custom or SDK built-ins become `builtin` unless they match known vault write names (`src/sdk/AgentSession.ts:1242-1282`).

### 5. MetadataCache APIs and Existing Search Patterns

- The local `FileCacheLike` includes `tags?: Array<{ tag: string; position?: unknown }>` and frontmatter/headings/links (`src/tools/ObsidianApi.ts:44-48`). The app-like metadata cache currently models `resolvedLinks` and `getFileCache(file)` only (`src/tools/ObsidianApi.ts:106-108`).
- `ObsidianApi.getFileCache(file)` checks for a metadata cache and `getFileCache` function, calls it as `mc.getFileCache(file)` to preserve native `this`, returns `not-found` for null, and maps missing API to `index-unavailable` (`src/tools/ObsidianApi.ts:225-232`; preservation is tested in `src/tools/ObsidianApi.test.ts:288-316`).
- Existing note search patterns use `vault.getMarkdownFiles()` for file enumeration: recent notes (`src/tools/ObsidianApi.ts:186-192`), raw content search (`src/tools/ReadTools.ts:284-312`), and task search (`src/tools/FindTasks.ts:113-127`).
- `vault_metadata` combines inline tags from `cache.tags` with frontmatter tags and normalizes/deduplicates them (`src/tools/ReadNoteTools.ts:588-607`, `src/tools/ReadNoteTools.ts:615-634`).
- `find_tasks` uses `api.getFileCache(file).listItems` and filters parsed task tags case-insensitively (`src/tools/FindTasks.ts:113-127`, `src/tools/FindTasks.ts:158-159`).
- The current abstraction has no `metadataCache.getTags()` field or wrapper, so `list_all_tags()` and any tag-to-note lookup through `getTags()` would add to `AppLike["metadataCache"]` or use the underlying Obsidian app directly (`src/tools/ObsidianApi.ts:106-108`).
- Existing read-only note tools register with `skipPermission: true` after documenting the FR-017 read-only checklist (`src/tools/ReadNoteTools.ts:29-46`, `src/tools/ReadNoteTools.ts:57-208`).

### 6. Chat View UI Structure and DOM/Event Patterns

- `ChatView.onOpen()` empties the root, adds `copilot-agent-chat-root`, creates a header, title, status element, message list, renderer, composer, textarea, send button, and connect button (`src/ui/ChatView.ts:115-213`).
- The current header contains only title and status (`src/ui/ChatView.ts:120-125`). A picker/dropdown would live in or adjacent to this header according to the current DOM grouping.
- Composer controls are created with Obsidian-style `createDiv`, `createEl`, `createSpan`, event listeners, and CSS classes (`src/ui/ChatView.ts:150-202`).
- State updates subscribe through `this.state.subscribe(() => this.syncList())`; `syncList()` calls `renderer.sync(this.state.getMessages())` (`src/ui/ChatView.ts:211-212`, `src/ui/ChatView.ts:511-513`).
- Approval and Undo UI actions are owned by `ChatView` through renderer tool-call handlers (`src/ui/ChatView.ts:133-148`).
- Settings UI uses Obsidian `new Setting(containerEl)` rows, `addToggle`, `addDropdown`, `addTextArea`, and `onChange` callbacks that call store setters (`src/settings/SettingsTab.ts:50-76`, `src/settings/SettingsTab.ts:90-146`, `src/settings/SettingsTab.ts:210-283`).

### 7. In-Flight Stream Behavior

- `ChatView` tracks stream UI with fields `pending`, `streaming`, `stopping`, `userRequestedStop`, and `currentPlaceholderId` (`src/ui/ChatView.ts:51-79`).
- Stop behavior marks the current placeholder interrupted before awaiting `agent.cancelCurrent()`, then relies on the streaming loop finally block to reset UI (`src/ui/ChatView.ts:282-303`). `ChatState.appendDelta` refuses to mutate terminal messages, so late deltas do not change an interrupted placeholder (`src/domain/ChatState.ts:61-76`, `src/ui/ChatView.ts:286-292`).
- `handleSend()` drains stream events from `agent.sendMessageStreaming(text)` and mutates the current placeholder id captured at send time (`src/ui/ChatView.ts:317-341`). Tool starts/completions and approval prompts are also upserted into that same placeholder (`src/ui/ChatView.ts:342-410`).
- `setStreaming(true)` changes the send button into Stop and keeps it enabled; `setStreaming(false)` restores Send (`src/ui/ChatView.ts:490-506`).
- `CopilotAgentSession.sendMessageStreaming()` captures `const session = this.session` and uses that captured session during streaming, with comments noting this avoids a reset/reconnect swapping `this.session` under the cleanup path (`src/sdk/AgentSession.ts:465-468`, `src/sdk/AgentSession.ts:703-704`).
- The SDK adapter stores one `currentStreamPush` while a stream is active and clears it in `finally` so post-stream events are ignored (`src/sdk/AgentSession.ts:285-292`, `src/sdk/AgentSession.ts:489-492`, `src/sdk/AgentSession.ts:691-695`).
- `cancelCurrent()` aborts the current SDK session (`src/sdk/AgentSession.ts:716-718`), and approval prompts are stored globally on the single `CopilotAgentSession` in `pendingApprovals` / `resolvedApprovalChoices` maps (`src/sdk/AgentSession.ts:305-326`).

### 8. Schema Versioning and Corruption Recovery

- No schema-version or migration field is present in `TokenStore.PersistedShape` or `SafetySettingsStore.PersistedShapeWithSafety` (`src/auth/TokenStore.ts:17-20`, `src/settings/SafetySettingsStore.ts:79-80`). Repository-wide searches only find defaults/normalizers, not persisted schema migration code (`src/settings/SafetySettingsStore.ts:183-207`).
- `TokenStore.load()` accepts any object-shaped blob and otherwise falls back to `{}` (`src/auth/TokenStore.ts:34-38`). Its `snapshot()` supplies defaults for absent fields (`src/auth/TokenStore.ts:41-48`).
- `SafetySettingsStore.load()` reads `raw.safety` and passes it to `mergeWithDefaults`; invalid/missing values are replaced with defaults field-by-field (`src/settings/SafetySettingsStore.ts:90-97`, `src/settings/SafetySettingsStore.ts:183-207`).
- `VaultAwarenessSettings.mergeVaultAwarenessSettings()` normalizes invalid `mode`, `taskTargetMode`, and string fields back to defaults or empty strings (`src/settings/VaultAwarenessSettings.ts:36-55`).
- Current write paths preserve unknown top-level keys when saving, but do not wrap `saveData()` errors with recovery behavior (`src/auth/TokenStore.ts:93-108`, `src/settings/SafetySettingsStore.ts:147-169`).

## Code References

- `src/main.ts:59-67` - Injects plugin `loadData`/`saveData` into TokenStore and SafetySettingsStore.
- `src/main.ts:69-71` - Creates the single in-memory UndoJournal.
- `src/main.ts:78-89` - Creates v0.1 read/write tools.
- `src/main.ts:144-164` - Creates v0.2 read/write note tools with shared ObsidianApi and UndoJournal.
- `src/main.ts:166-183` - Creates the single CopilotAgentSession and concatenates all tools.
- `src/main.ts:261-268` - Hydrates token, safety settings, and auth controller asynchronously on load.
- `src/main.ts:289-292` - Registers the chat view with the single agent and undo journal.
- `src/main.ts:316-324` - Disposes the single agent on plugin unload.
- `src/auth/TokenStore.ts:17-20` - Current persisted auth/settings shape.
- `src/auth/TokenStore.ts:81-108` - Tail-serialized, re-read-and-merge persistence write.
- `src/settings/SafetySettingsStore.ts:23-65` - Persisted safety settings fields and defaults.
- `src/settings/SafetySettingsStore.ts:147-169` - Safety store persistence write path.
- `src/domain/UndoJournal.ts:22-35` - UndoEntry data shape.
- `src/domain/UndoJournal.ts:72-193` - UndoJournal public API and undo behavior.
- `src/domain/ChatState.ts:10-147` - Chat message state store and mutation API.
- `src/domain/vaultToolManifest.ts:32-61` - v0.1 raw-filesystem manifest entries.
- `src/domain/vaultToolManifest.ts:147-158` - Combined manifest and note-tool name exports.
- `src/tools/ObsidianApi.ts:44-48` - Metadata cache file shape including tags.
- `src/tools/ObsidianApi.ts:106-108` - Current metadataCache app-like surface.
- `src/tools/ObsidianApi.ts:225-232` - `getFileCache` wrapper behavior.
- `src/tools/ReadTools.ts:53-75` - Read-only `skipPermission` checklist.
- `src/tools/ReadTools.ts:79-167` - v0.1 read tool definitions.
- `src/tools/ReadNoteTools.ts:29-46` - v0.2 read-only tool checklist.
- `src/tools/ReadNoteTools.ts:57-208` - v0.2 read-only note tool definitions.
- `src/tools/ReadNoteTools.ts:588-607` - Existing tag extraction for `vault_metadata`.
- `src/tools/WriteTools.ts:101-106`, `src/tools/WriteTools.ts:195-201`, `src/tools/WriteTools.ts:252-257` - v0.1 write undo entry recording.
- `src/tools/WriteNoteTools.ts:104-109`, `src/tools/WriteNoteTools.ts:200-206` - v0.2 note write undo entry recording.
- `src/tools/UpdateTask.ts:155-170` - `update_task` returns undo id from file-level edit.
- `src/ui/ChatView.ts:115-213` - Existing header/composer DOM construction.
- `src/ui/ChatView.ts:305-471` - Send/stream/message update lifecycle.
- `src/ui/ChatView.ts:522-566` - Undo click handling and undoId extraction.
- `src/sdk/AgentSession.ts:357-359`, `src/sdk/AgentSession.ts:800-804`, `src/sdk/AgentSession.ts:953-957` - SDK tool list storage and session creation.
- `src/sdk/AgentSession.ts:459-695` - Streaming generator mechanics and cleanup.
- `src/sdk/AgentSession.ts:1099-1215` - Approval prompt event flow.
- `src/sdk/AgentSession.ts:1242-1282` - Permission request classification.

## Architecture Documentation

- **Persistence pattern**: Multiple stores write to one Obsidian plugin-data blob. Each store preserves unrelated top-level keys by re-reading and spreading the latest blob before saving (`src/auth/TokenStore.ts:93-108`, `src/settings/SafetySettingsStore.ts:147-169`).
- **Session pattern**: Plugin lifetime owns the SDK adapter; view lifetime owns `ChatState` and rendering subscriptions (`src/main.ts:166-183`, `src/ui/ChatView.ts:38`, `src/ui/ChatView.ts:211-213`).
- **Tool pattern**: Tool factories return SDK `defineTool` entries. Read-only tools may set `skipPermission: true` when the documented checklist is met; mutating tools do not set `skipPermission` and are classified by SafetyPolicy (`src/tools/ReadTools.ts:53-75`, `src/tools/ReadNoteTools.ts:29-46`, `src/tools/WriteTools.ts:264-363`, `src/sdk/AgentSession.ts:1242-1282`).
- **Undo pattern**: Write handlers record journal entries after a successful write and return `undoId` in JSON tool results; the chat view parses the result and wires the Undo button back into `UndoJournal.undo()` (`src/tools/WriteTools.ts:101-107`, `src/ui/ChatView.ts:357-369`, `src/ui/ChatView.ts:522-566`).
- **Streaming pattern**: UI state uses a placeholder message per turn; SDK adapter yields deltas/tool/approval/complete events; Stop marks the placeholder interrupted and calls session abort (`src/ui/ChatView.ts:317-341`, `src/ui/ChatView.ts:371-410`, `src/ui/ChatView.ts:282-303`, `src/sdk/AgentSession.ts:459-695`).

## Open Questions

- No `metadataCache.getTags()` wrapper currently exists in `ObsidianApi`; implementation planning should decide whether new tag tools extend `ObsidianApi` or call `app.metadataCache` through a new app-like surface (`src/tools/ObsidianApi.ts:106-108`).
- No persisted schema version is present today; current recovery is defaulting/normalizing known fields and preserving unknown top-level keys (`src/auth/TokenStore.ts:17-20`, `src/settings/SafetySettingsStore.ts:79-80`, `src/settings/SafetySettingsStore.ts:183-207`).
- The existing SDK adapter has a single active stream push and single pending-approval map per `CopilotAgentSession`; conversation switching during an active stream will need planning around the currently single `currentStreamPush` and UI placeholder ownership (`src/sdk/AgentSession.ts:285-326`, `src/ui/ChatView.ts:317-341`).
