# Changelog

All notable changes to this project are documented in this file.
The format is loosely based on [Keep a Changelog](https://keepachangelog.com/).

## [0.4.0] – 2026-06-12

### Added

- **Per-conversation model picker** in the chat header (FR-001 / FR-002 / FR-003). A dropdown sits next to the connection status pill and shows the model bound to the currently-active conversation; clicking it lists every chat-capable Copilot model your account can reach. Each conversation remembers its own model — switching conversations updates the picker label. The picker uses Obsidian's standard `Menu` widget (the same dropdown style as the conversation picker) so it inherits keyboard accessibility and theme tokens.
- **Settings → Copilot Agent → Model → Default model** (FR-007). A new dropdown picks the model that new conversations start with. The list mirrors the same chat-capable catalog the chat-header picker uses. The default is honoured at conversation creation time; if it's not in the catalog at the moment you create a conversation, the plugin falls back to a heuristic (gpt-4.1 / gpt-4o / first chat model) and surfaces a one-shot Notice so you can update the setting.
- **Mid-conversation model swap with history preserved** (FR-005 / FR-008). Picking a different model swaps it on the underlying SDK session in-place — the conversation history is preserved and your next message is answered by the new model. The first swap on a conversation with at least one completed assistant turn opens a confirmation dialog ("Switching to <model>. The conversation history is preserved; …. Continue?"). Identity swaps and swaps on a brand-new conversation skip the dialog. Any pending tool-approval prompts are cancelled when the swap is confirmed (the dialog tells you so).
- **Recovery flows for catalog failures, empty accounts, and stale models** (FR-010 / FR-016 / FR-018). When the model list can't be fetched at startup the plugin no longer aborts: the chat opens with an inline "Models unavailable" banner above the composer and a **Retry** button that re-runs `listModels()` without a plugin reload. When the account has zero chat-capable models you see "No chat models available." instead. When a conversation's persisted modelId is no longer in the catalog (e.g. a model was deprecated), the picker shows `<id> (unavailable)` as the current selection and an inline banner blocks send until you pick a real model.
- **Lazy model resolution for migrated conversations** (FR-013). v0.3 conversations open with no bound model id; on first activation in v0.4 the plugin resolves one (configured default → heuristic) and persists it so subsequent opens are stable.
- **Deferred SDK-session creation** (S1). If the catalog is unavailable at startup the AgentSession defers `createSession()` rather than failing. It subscribes to the catalog and creates the session in-place the moment the catalog reaches the `ready` state — either because Retry succeeds, the token rotates, or you explicitly pick a model from the (still-degraded) picker. No plugin reload required for any of these recoveries.
- **`canSend()` single-source send gate** (FR-014). All four catalog/model blocked states (`unavailable-model`, `catalog-error`, `catalog-empty`, `unresolved-model`) plus the existing connection / streaming / pending reasons go through one decision function. The send button, Enter key, and inline banner all derive from the same result, so the user always sees the same reason text in the same precedence order.

### Changed

- **Chat header layout** (FR-015). The connection status pill is now smaller and adjacent to the model picker; the model name is no longer duplicated as `Connected · <model>` because the picker is the canonical model indicator. Status text is just `Connected` while connected.
- `AgentSession` interface gains `hasPendingApprovals(): boolean` and `hasDeferredSession(): boolean` so the UI can drive the swap-confirmation copy and the inline-error banner without touching internals.
- `ConversationManager` gains an optional `resolveCreationModelId` resolver (sync, runs at create time AND lazily on first activation for migrated conversations) and an optional `onUnavailableDefault(configuredDefault)` callback so the domain layer can surface a Notice without coupling to the Obsidian SDK.
- Token rotation now refreshes the model catalog automatically so entitlement changes propagate without a plugin reload.

### Migration

- **Persistence schema v1 → v2 (additive, no destructive migration)**: each persisted conversation gains an optional `modelId: string | null` field. v1 payloads parse cleanly into v2 (the field is missing → treated as v0.3-migrated → lazy-resolved on first activation). No user action required.
- The "Default model" Settings dropdown starts empty for upgraders; the plugin uses the v0.3 heuristic until you pick one.

### Tests

- 609 → 728 (+119 across 19 commits): per-conversation modelId persistence, the model catalog filter (hard `policy.state === "disabled"` only; soft signal is logged not excluded), the heuristic resolver, the swap orchestration, the model picker view-model/keyboard reducer/confirmation copy, the four canSend blocked states with precedence, the unavailable-id sentinel row, lazy resolution, and the AgentSession deferred-init recovery cycle.

## [0.3.0] – 2026-06-11

### Added

- Multi-conversation support: conversation picker dropdown at the top of the chat pane (current name + caret), with Create / Switch / Rename / Delete actions. Up to 20 active conversations; the 21st auto-archives the lowest-`lastActiveAt` non-active conversation and surfaces a one-time Notice. Archived conversations are preserved on disk for a future "Show archived" UI.
- Auto-naming: new conversations are seeded with `Untitled YYYY-MM-DD HH:MM` (local time). On the first user message the conversation auto-renames from the first non-empty line of that message (≤ 40 chars, surrogate-pair safe). Manual renames always win — the auto-name only applies while the current name still matches the default-name predicate.
- Cross-restart persistence: conversation list, per-conversation message history, per-conversation undo journals, and the active-conversation id all persist across plugin reload, Obsidian restart, and OS reboot via debounced writes (≤ 1 per 500 ms). Final flush on Obsidian's `quit` event ensures OS-level shutdown still persists everything.
- Cross-restart Undo with divergence prompt: undo entries persist alongside their conversation (50 most recent per conversation, 7-day TTL). When the file has been modified, deleted, or replaced since the recorded snapshot, the Undo button opens an overlay describing the divergence ("modified outside the agent" / "no longer exists" / "already exists") with **Cancel** / **Revert anyway** actions; choosing Revert anyway re-runs `UndoJournal.undo(id, { force: true })`. Successful undos flip to a "reverted" pill that survives a fast restart (immediate flush on `markUndone`, FR-013).
- Three new read-only auto-approved search tools: `search_by_tag`, `search_by_name`, `list_all_tags`. Backed by Obsidian's `MetadataCache`; bounded result caps; structured `{ ok: false, reason: "metadata-cache-not-ready" }` payload when the cache is cold.
- Safety setting "Expose v0.1 raw-filesystem tools" (default **ON**, opt-out). The six v0.1 raw-FS tools (`view`, `read_file`, `search_content`, `create_file`, `edit_file`, `delete_file`) remain registered as a defensive fallback while the preamble's tool inventory marks them as `(fallback)` so the model reaches for the vault-aware tools first. Toggle OFF for a strictly vault-only surface — the gating is captured at plugin onload, so when OFF the raw-FS tools are not registered with the SDK and are omitted from the preamble's tool inventory. Toggling persists immediately; the new value applies at the next plugin reload (FR-015).
- Suppressed Undo affordance for historical raw-FS tool calls while the toggle is OFF (FR-016): the call name + result still render so chat scrollback stays readable, but the Undo button is hidden. Already-undone calls still show their "reverted" pill.
- Schema versioning of persisted state with corruption-recovery sidecar: when validation fails, the malformed conversation subtree is wrapped as `{ recoveredAt, schemaVersionExpected, malformed }` and written to `<plugin-dir>/conversations_recovery.bak.json`, then the plugin proceeds from defaults; auth and safety settings survive recovery (FR-010, SC-001).
- One-shot 5 MB size warning Notice (SC-011) when the persisted blob crosses 5 × 1024 × 1024 bytes; in-memory flag prevents Notice spam within a session.
- Comprehensive new test coverage across `ConversationManager`, `ConversationsStore`, `ConversationRuntime`, `UndoJournal` cross-restart paths, and the new search tools.

### Changed

- v0.2 Undo behaviour now survives a restart. Undo button continues to appear on persisted tool-call blocks; clicks check current file content against the snapshot before reverting (no mtime/size fields are stored — divergence is detected by byte-for-byte content comparison, SI-1).
- The default preamble's tool inventory now lists the v0.2 vault-aware tools first and tags the v0.1 raw-FS tools as `(fallback)` so the model prefers the vault-aware surface. The raw-FS tools remain registered by default and are still available when needed; users who want them gone entirely can flip the new safety toggle OFF.
- Plugin onload sequence now materialises the active conversation's runtime BEFORE auth hydrates so the broadcasting `tokenSink.reconnect()` finds a live model id and the header model pill displays the current model immediately on first paint.
- `ConversationsStore.markUndone` bypasses the 500 ms debounce and writes through immediately so a successful undo cannot be undone by a fast restart.
- `UndoJournal` now accepts a richer options object (`persist`, `initialEntries`, `maxEntries`, `loadOptions.ttlMs`, `now`) for persistence wiring while remaining backward-compatible with the legacy `new UndoJournal(vault)` constructor.

### Migration

- No action required for the raw-FS tools — the new "Expose v0.1 raw-filesystem tools" safety toggle defaults ON, so the v0.1 raw-FS tools remain available exactly as before. The v0.3 preamble simply nudges the model to prefer the vault-aware tools first. To opt out: Settings → Copilot Agent → Safety → "Expose v0.1 raw-filesystem tools" → toggle OFF, then reload the plugin (Disable + Enable in Community plugins, or restart Obsidian).
- v0.2 persisted data carrying no `schemaVersion` parses cleanly into v0.3 defaults — there is no destructive migration. Forward-incompatible payloads (a future `schemaVersion > 1` from a downgrade) trigger the recovery-sidecar path so user data is preserved rather than truncated.

## [0.2.0] – 2026-06-10

### Added

- Keyboard-first chat input: Enter sends, Shift+Enter inserts a newline, IME composition is respected, empty/whitespace input is rejected. Enter is inert while a response is streaming (Stop is the only cancel path).
- Vault-aware preamble assembled on the first send of each session: vault root path, timezone, today, inventory of available vault tools, and an authoring-conventions block (wikilinks, hash-prefixed tags, Tasks-plugin checkbox syntax). Configurable via Settings → Copilot Agent → Vault Awareness (Default / Custom / None).
- Vault Awareness settings: mode toggle, custom-body textarea with `{{VAULT_ROOT}}` / `{{VAULT_TIMEZONE}}` / `{{VAULT_TODAY}}` / `{{VAULT_TOOL_INVENTORY}}` / `{{AUTHORING_CONVENTIONS}}` placeholders, default task target (today's daily note or custom path).
- Read-only vault-aware tools (auto-approved, no prompt): `get_active_note`, `list_recent_notes`, `find_backlinks`, `vault_tree`, `vault_metadata`, `find_tasks`, plus `open_note` (navigation only).
- Mutating vault-aware tools (one approval each, journal-undoable): `create_note`, `edit_note`, `insert_into_active_note`, `create_daily_note`, `create_task`, `update_task`.
- Daily Notes core plugin integration: `create_daily_note` honors the configured folder/format/template, falls back to `<vault-root>/YYYY-MM-DD.md` when disabled.
- Tasks community plugin integration: `create_task` auto-detects plugin presence and emits the matching flavor (📅/✅/⏳/➕/❌ emoji syntax when present, GFM `(field: value)` syntax otherwise). `createdDate` (➕) defaults to today.
- `update_task` structured patch tool: change status / priority / tags / due date / scheduled date / description on a single task line, with two-tier re-anchor (byte-exact `expectedRawLine` then `descriptionMatch`), idempotent status auto-stamping (`done` → ✅ today, `cancelled` → ❌ today), recurrence and block-ID preservation via an `extras` pass-through, and format-source preservation (tasks-plugin stays tasks-plugin, GFM stays GFM).

### Changed

- v0.1 tools (`view`, `read_file`, `search_content`, `create_file`, `edit_file`, `delete_file`) remain registered as defensive fallbacks. Each new capability with a fallback path reports `usedFallback: boolean` in its result.
- Test count: 166 → 401 (+235 across new domain, tool, and UI suites).

### Security / Privacy

- The default preamble sends only vault root path + timezone + today + tool inventory + authoring conventions. **No folder or file enumeration, no note contents, no recent-activity metadata, no per-file timestamps.** Folder/file structure is available on demand via the auto-approved `vault_tree` / `vault_metadata` tools. Users with the most sensitive vaults can set Vault Awareness to **None** to suppress the preamble entirely.
- The universal permission gate (`decideSafety`) is unchanged from v0.1. Every mutating capability — including `update_task` — registers without `skipPermission`, so all writes route through the same gate as v0.1's `create_file` / `edit_file` / `delete_file`.

## [0.1.0] – v0.1 private spike

Initial private spike. OAuth Device Flow sign-in via the `gh` CLI client ID, streaming chat with Stop-to-cancel, vault read tools (`view`, `read_file`, `search_content`) exempt from prompts, vault write tools (`create_file`, `edit_file`, `delete_file`) routed through a single deny-by-default approval gate, in-session Undo for any approved write, three-mode safety policy (require-approval / auto-apply-with-undo / allowlist) plus persistent trust scopes (path allowlist, per-built-in toggles). 166 tests across domain, tools, and SDK adapter.
