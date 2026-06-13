---
date: 2026-06-11T19:23:36.281-07:00
git_commit: 7ba3583076f6fc8b5d8be3779f23ecaa78daba97
branch: feature/model-picker
repository: obsidian-copilot-agent
topic: "Per-conversation model picker v0.4 code research"
tags: [research, codebase, models, sdk, conversations, persistence, chat-ui]
status: complete
last_updated: 2026-06-11
---

# Research: Per-Conversation Model Picker v0.4

## Research Question

Map SDK and plugin implementation points for v0.4 per-conversation model selection: model discovery, model binding/swap behavior, transcript continuity, token limits, persistence, chat header UI, settings, runtime disposal, approval cancellation, and Notice/modal patterns.

## Summary

- SDK model listing is `CopilotClient.listModels(): Promise<ModelInfo[]>`; it caches successful results, supports `onListModels`, and otherwise calls runtime RPC `models.list` (`node_modules/@github/copilot/copilot-sdk/client.d.ts:274-284`, `node_modules/@github/copilot/copilot-sdk/index.js:6727-6775`).
- `ModelInfo` exposes `id`, `name`, `capabilities`, optional `policy`, optional `billing`, and optional reasoning metadata. Capabilities expose `supports.vision`, `supports.reasoningEffort`, and token/vision limits including `max_prompt_tokens` and `max_context_window_tokens`; no public chat-vs-embedding-vs-image modality discriminator is present (`node_modules/@github/copilot/copilot-sdk/types.d.ts:1634-1651`, `node_modules/@github/copilot/copilot-sdk/types.d.ts:1672-1689`).
- `createSession` accepts `SessionConfig.model` and forwards it to `session.create` as `model`; the SDK client performs no local lookup against `listModels()` before sending the RPC (`node_modules/@github/copilot/copilot-sdk/types.d.ts:1129-1139`, `node_modules/@github/copilot/copilot-sdk/index.js:6456-6501`).
- The SDK also exposes `CopilotSession.setModel(model, options)`, which sends `session.model.switchTo({ modelId })`; SDK docs state the new model takes effect for the next message and conversation history is preserved (`node_modules/@github/copilot/copilot-sdk/session.d.ts:250-265`, `node_modules/@github/copilot/copilot-sdk/index.js:5639-5654`).
- No explicit `messages` / `history` seed parameter exists on `SessionConfig` or `MessageOptions`; new-session transcript seeding through `createSession` is not represented in the public type or JS payload (`node_modules/@github/copilot/copilot-sdk/types.d.ts:1129-1360`, `node_modules/@github/copilot/copilot-sdk/types.d.ts:1472-1479`, `node_modules/@github/copilot/copilot-sdk/index.js:6497-6548`).
- Current plugin model selection is centralized in `CopilotAgentSession.pickModel`: preferred model if supplied; otherwise `client.listModels()`, filter disabled models when enabled models exist, then choose `gpt-4.1`, `gpt-4o`, first `gpt-*`, else first available (`src/sdk/AgentSession.ts:1017-1052`).
- v0.3 conversation persistence stores `PersistedConversation` with `id`, `name`, `createdAt`, `lastActiveAt`, optional `archived`, `messages`, and `undoEntries`; the natural optional per-conversation metadata path is this shape plus the `Conversation` metadata mirror (`src/persistence/PersistedShape.ts:63-79`, `src/domain/Conversation.ts:17-63`).
- The current header mounts the v0.3 conversation picker first, then a title/status row containing the status pill; model picker UI naturally mounts in this header/title-row area (`src/ui/ChatView.ts:189-256`).
- Runtime leak verification already exists through `liveRuntimes`; each materialized runtime is added to the set and removed inside `runtime.dispose()`, which calls `session.dispose()` (`src/main.ts:203-211`, `src/main.ts:344-360`).

## Documentation System

- **Framework**: Plain Markdown; product docs are repository Markdown files (`README.md:1-6`, `CHANGELOG.md:1-6`).
- **Docs Directory**: N/A for product docs; PAW artifacts live under `.paw/work/<work-id>/` and v0.3 docs are referenced from README (`README.md:17-19`).
- **Navigation Config**: N/A.
- **Style Conventions**: README uses H1/H2 sections, bullet release notes, numbered setup, and fenced command blocks (`README.md:1-15`, `README.md:45-67`, `README.md:105-111`). CHANGELOG uses versioned H2 entries and categorized H3 headings (`CHANGELOG.md:1-19`, `CHANGELOG.md:21-32`).
- **Build Command**: N/A for docs. Repository build is `npm run build` (`package.json:8-13`).
- **Standard Files**: `README.md`, `CHANGELOG.md` (`README.md:1`, `CHANGELOG.md:1`).

## Verification Commands

- **Test Command**: `npm test` -> `vitest run` (`package.json:8-13`).
- **Lint Command**: No lint script is declared in `package.json` (`package.json:8-14`).
- **Build Command**: `npm run build` -> `node esbuild.config.mjs production` (`package.json:8-13`).
- **Type Check**: `npm run typecheck` -> `tsc --noEmit` (`package.json:8-13`); strict/no-unused/no-implicit-return/noEmit are set in `tsconfig.json` (`tsconfig.json:2-21`).
- **Test Harness**: Vitest runs in Node and includes `src/**/*.test.ts` (`vitest.config.ts:1-10`).

## Detailed Findings

### 1. SDK model-list API

- Public API: `CopilotClient.listModels(): Promise<ModelInfo[]>` lists available models with metadata and throws if not connected when no custom handler is set (`node_modules/@github/copilot/copilot-sdk/client.d.ts:274-284`).
- Implementation: `listModels()` serializes concurrent callers with `modelsCacheLock`, returns a defensive copy of `modelsCache`, calls `onListModels()` if supplied, otherwise requires `this.connection` and calls `this.connection.sendRequest("models.list", {})` (`node_modules/@github/copilot/copilot-sdk/index.js:6737-6756`).
- Result normalization: for RPC models missing `capabilities`, the SDK fills `capabilities.supports` and `capabilities.limits.max_context_window_tokens`; it also backfills missing nested `supports`/`limits` objects (`node_modules/@github/copilot/copilot-sdk/index.js:6757-6771`).
- Public return shape: `ModelInfo` has `id`, `name`, `capabilities`, optional `policy`, optional `billing`, optional `supportedReasoningEfforts`, and optional `defaultReasoningEffort` (`node_modules/@github/copilot/copilot-sdk/types.d.ts:1672-1689`).
- Capability metadata: `ModelCapabilities.supports` contains `vision` and `reasoningEffort`; `limits` contains optional `max_prompt_tokens`, required `max_context_window_tokens`, and optional `vision` limits (`node_modules/@github/copilot/copilot-sdk/types.d.ts:1634-1651`). Generated RPC types additionally model optional `max_output_tokens` (`node_modules/@github/copilot/copilot-sdk/generated/rpc.d.ts:3891-3910`).
- Modality metadata: the public type has no chat/completion/embedding/image discriminator; vision is image input support, not image-output or embedding-only classification (`node_modules/@github/copilot/copilot-sdk/types.d.ts:1634-1651`, `node_modules/@github/copilot/copilot-sdk/types.d.ts:1672-1689`). Generated `Model` has optional `modelPickerCategory` and `modelPickerPriceCategory`, which are UX/cost categories, not modality flags (`node_modules/@github/copilot/copilot-sdk/generated/rpc.d.ts:574-602`, `node_modules/@github/copilot/copilot-sdk/generated/rpc.d.ts:3838-3864`).
- Authentication context: low-level `models.list` accepts optional `gitHubToken`, but public `CopilotClient.listModels()` calls it with `{}` and relies on connected runtime/auth context unless `onListModels` is supplied (`node_modules/@github/copilot/copilot-sdk/generated/rpc.d.ts:4120-4125`, `node_modules/@github/copilot/copilot-sdk/index.js:6748-6756`).

### 2. Session model binding and related options

- `SessionConfigBase.model?: string` is the public field for session model selection (`node_modules/@github/copilot/copilot-sdk/types.d.ts:1129-1139`).
- `CopilotClient.createSession(config)` creates a `CopilotSession`, registers tools/callbacks, stores it in `this.sessions`, and sends `session.create` with `model: config.model` plus tools, streaming, auth, and other options (`node_modules/@github/copilot/copilot-sdk/index.js:6456-6548`).
- Related options include `reasoningEffort`, `modelCapabilities`, `provider`, `availableTools`, `excludedTools`, `streaming`, `gitHubToken`, and `remoteSession` (`node_modules/@github/copilot/copilot-sdk/types.d.ts:1136-1147`, `node_modules/@github/copilot/copilot-sdk/types.d.ts:1209-1223`, `node_modules/@github/copilot/copilot-sdk/types.d.ts:1270-1276`, `node_modules/@github/copilot/copilot-sdk/types.d.ts:1328-1344`).
- The SDK client performs no local check that `config.model` appears in `listModels()` before sending `session.create`; the awaited RPC is the first visible validation boundary in client code (`node_modules/@github/copilot/copilot-sdk/index.js:6456-6556`).
- In-place model switching exists: `CopilotSession.setModel(model, options)` is documented as applying to the next message while preserving conversation history; implementation calls `this.rpc.model.switchTo({ modelId: model, ...options })` (`node_modules/@github/copilot/copilot-sdk/session.d.ts:250-265`, `node_modules/@github/copilot/copilot-sdk/index.js:5639-5654`).
- Low-level session RPC exposes `session.model.getCurrent`, `session.model.switchTo`, and `session.model.setReasoningEffort` (`node_modules/@github/copilot/copilot-sdk/index.js:3691-3713`).

### 3. Transcript seeding for a new session

- `SessionConfigBase` lists model, reasoning, tool, system-message, working-directory, streaming, auth, remote-session, and callback fields; no `messages`, `history`, `transcript`, or equivalent seed field appears (`node_modules/@github/copilot/copilot-sdk/types.d.ts:1129-1360`, `node_modules/@github/copilot/copilot-sdk/types.d.ts:1362-1395`).
- `createSession` forwards a fixed payload to `session.create`; it includes `systemMessage`, tools, model, auth, and runtime options, but no prior-message array or persisted transcript field (`node_modules/@github/copilot/copilot-sdk/index.js:6497-6548`).
- `MessageOptions` contains `prompt` and attachments, not a structured conversation-history field (`node_modules/@github/copilot/copilot-sdk/types.d.ts:1472-1495`).
- `CopilotSession.getEvents()` retrieves a session's history, and `resumeSession(sessionId, config)` resumes an existing SDK session id; these APIs do not seed a new SDK session from plugin-persisted transcript (`node_modules/@github/copilot/copilot-sdk/session.d.ts:185-203`, `node_modules/@github/copilot/copilot-sdk/client.d.ts:223-246`).
- Existing plugin behavior has a first-prompt preamble mechanism: `wrapWithPreamble()` prepends vault context to the first user send of each SDK session, and `resetConversation()` re-arms that first-send flag (`src/sdk/AgentSession.ts:105-113`, `src/sdk/AgentSession.ts:780-792`, `src/sdk/AgentSession.ts:813-840`). This is plugin-side prompt text, not a documented SDK historical-context protocol.
- Gap: a brand-new SDK session has no typed transcript seed mechanism in the researched public SDK. The SDK’s in-place `setModel()` API is the observed mechanism that preserves SDK-side history across a model change (`node_modules/@github/copilot/copilot-sdk/session.d.ts:250-265`). If implementation uses `resetConversation()`/`createSession`, only plugin-visible scrollback remains preserved unless the transcript is manually embedded into a prompt.

### 4. SDK input-token limits and token-counting utilities

- Model metadata exposes per-model `max_prompt_tokens` and `max_context_window_tokens` in public types (`node_modules/@github/copilot/copilot-sdk/types.d.ts:1642-1650`). Generated RPC types include `max_output_tokens` (`node_modules/@github/copilot/copilot-sdk/generated/rpc.d.ts:3891-3910`).
- Custom provider config has `maxPromptTokens` and `maxOutputTokens`; docs state the runtime triggers conversation compaction before sending when prompt/system/history/tool/user payload exceeds `maxPromptTokens` (`node_modules/@github/copilot/copilot-sdk/types.d.ts:1438-1469`).
- Session metadata RPC exposes `contextInfo` for current context window token breakdown and `recomputeContextTokens` to re-tokenize the session's existing messages against a model (`node_modules/@github/copilot/copilot-sdk/index.js:4488-4519`).
- Generated types describe `MetadataRecomputeContextTokensRequest.modelId` and result fields `totalTokens` and `messagesTokenCount` (`node_modules/@github/copilot/copilot-sdk/generated/rpc.d.ts:3680-3707`).
- These utilities operate on an SDK session’s existing messages; no public utility was found for token-counting an arbitrary plugin-persisted transcript before it is seeded into a new session (`node_modules/@github/copilot/copilot-sdk/generated/rpc.d.ts:10418-10448`).

### 5. Error semantics on unknown model id

- `createSession` is asynchronous and forwards `model: config.model` to `session.create`; no local synchronous validation against `listModels()` is present before the RPC (`node_modules/@github/copilot/copilot-sdk/index.js:6456-6556`).
- If `session.create` rejects, `createSession` deletes the session from `this.sessions` and rethrows the RPC error (`node_modules/@github/copilot/copilot-sdk/index.js:6495-6555`).
- `setModel()` is also asynchronous and awaits `session.model.switchTo({ modelId: model })`; no local validation is present in the wrapper (`node_modules/@github/copilot/copilot-sdk/index.js:5639-5654`).
- Current plugin initialization awaits `client.createSession({ model, ... })`; errors from that call flow through `doInit()` before first send (`src/sdk/AgentSession.ts:977-1007`).
- Current plugin `preferredModel` bypasses `listModels()` entirely, so a supplied stale id goes directly to `createSession` (`src/sdk/AgentSession.ts:87-88`, `src/sdk/AgentSession.ts:1017-1022`).

### 6. Model-list fetch failure modes

- Public docs state `listModels()` throws if not connected when no custom handler is set (`node_modules/@github/copilot/copilot-sdk/client.d.ts:274-284`).
- Implementation failure paths include `onListModels()` throwing, no `this.connection` causing `new Error("Client not connected")`, or `models.list` RPC rejection; all propagate because there is no catch besides the `finally` lock release (`node_modules/@github/copilot/copilot-sdk/index.js:6737-6778`).
- Current plugin wraps `client.listModels()` errors in `[AgentSession] client.listModels failed: ...` during `pickModel()` (`src/sdk/AgentSession.ts:1025-1034`).
- Current `doInit()` starts the client, pings it, sets `this.client`, and then calls `pickModel()`; model-list failures abort initialization before `createSession()` (`src/sdk/AgentSession.ts:967-983`).

### 7. Current `pickModel()` heuristic

- `pickModel(client, preferred)` returns `preferred` immediately when supplied (`src/sdk/AgentSession.ts:1017-1022`).
- If `client.listModels` is unavailable, it returns `gpt-4.1` (`src/sdk/AgentSession.ts:1022-1024`).
- It filters out models with `policy.state === "disabled"` when at least one enabled/unspecified-policy model exists; otherwise it uses the full model array (`src/sdk/AgentSession.ts:1035-1041`).
- It throws `[AgentSession] No Copilot models available for this account.` on an empty pool (`src/sdk/AgentSession.ts:1041-1045`).
- Selection order is `gpt-4.1` → `gpt-4o` → first id starting with `gpt-` → first pool entry (`src/sdk/AgentSession.ts:1047-1052`). The test suite names and asserts this order (`src/sdk/AgentSession.test.ts:179-189`).

### 8. Persistence shape and migration

- Persisted conversation fields currently are `id`, `name`, `createdAt`, `lastActiveAt`, optional `archived`, `messages`, and `undoEntries` (`src/persistence/PersistedShape.ts:63-72`).
- `PersistedConversationsState` owns top-level `schemaVersion`, `conversations`, and `activeConversationId`; current schema version is `1` (`src/persistence/PersistedShape.ts:74-87`).
- Domain `Conversation` mirrors persisted metadata fields and `conversationToPersistedMetadata()` writes the metadata subset excluding messages/undo entries (`src/domain/Conversation.ts:17-27`, `src/domain/Conversation.ts:53-63`).
- Migration `validateConversation()` requires core fields and arrays, then returns a new object with known keys only: `id`, `name`, `createdAt`, `lastActiveAt`, `archived`, `messages`, `undoEntries` (`src/persistence/migrate.ts:95-127`).
- The v0.3 sibling-key preservation pattern is top-level: `ConversationsStore.flushImmediate()` re-reads the latest blob, spreads unrelated top-level keys, then writes owned `schemaVersion`, `conversations`, and `activeConversationId` (`src/persistence/ConversationsStore.ts:455-471`).
- Adding optional `modelId` requires updating persisted type, migration validation/clone paths, and metadata conversion paths; the existing top-level merge protects sibling top-level keys, not unknown per-conversation keys (`src/persistence/migrate.ts:118-126`, `src/domain/Conversation.ts:37-63`, `src/persistence/ConversationsStore.ts:219-244`).

### 9. ConversationManager / Conversation domain state

- `ConversationManager` owns conversation metadata, lazy runtimes, and active id; mutating methods write through to `ConversationsStore` (`src/domain/ConversationManager.ts:1-20`, `src/domain/ConversationManager.ts:125-139`).
- Hydration reads persisted metadata into `Conversation` objects and mirrors rows back to the store with messages and undo entries (`src/domain/ConversationManager.ts:151-184`).
- `createInternal()` creates metadata with id/name/createdAt/lastActiveAt and immediately upserts an empty persisted row (`src/domain/ConversationManager.ts:533-566`).
- `persistMetadataOnly()` is the existing debounced metadata flush path used by rename, archive, and touch; it preserves existing messages/undo entries and upserts metadata through `ConversationsStore` (`src/domain/ConversationManager.ts:283-291`, `src/domain/ConversationManager.ts:315-329`, `src/domain/ConversationManager.ts:371-378`, `src/domain/ConversationManager.ts:478-488`).
- `ConversationRuntimeFactory` receives `metadata`, optional hydrated messages/undo entries, and a persist adapter; runtime creation is lazy in `getOrCreateRuntime()` (`src/domain/ConversationRuntime.ts:58-65`, `src/domain/ConversationManager.ts:437-452`).

### 10. Chat header rendering and picker patterns

- `ChatView.onOpen()` creates `.copilot-agent-header`, mounts `ConversationPicker` in it, then creates `.copilot-agent-header-row` with title and `statusEl` (`src/ui/ChatView.ts:184-256`).
- The status pill displays auth/model text through `renderAuth()`, using `Connected · ${state.model}` when `AuthState` has a model (`src/ui/ChatView.ts:432-467`).
- `ConversationPicker` renders a button with `aria-haspopup="menu"`, label, chevron icon, and click handler to open an Obsidian `Menu` (`src/ui/ConversationPicker.ts:25-51`, `src/ui/ConversationPicker.ts:71-133`).
- Picker rows use `Menu.addItem`, `setTitle`, optional checked state, and callbacks; create/rename/delete rows are separated by `menu.addSeparator()` (`src/ui/ConversationPicker.ts:76-127`).
- Chat input keyboard ergonomics are centralized through `decideKeydownAction()`: Enter submits when connected and not streaming/pending, Shift+Enter creates newline, IME composition is respected, and streaming Enter is inert (`src/ui/ChatView.ts:320-348`).

### 11. Live runtime bookkeeping and disposal on swap/remove

- `main.ts` maintains `liveRuntimes = new Set<{ session: AgentSession; conversationId: string }>()` for instantiated runtimes; token rotations broadcast through this set (`src/main.ts:199-211`, `src/main.ts:373-410`).
- The runtime factory creates a `CopilotAgentSession`, hydrates `ChatState`, adds a `liveEntry`, and returns a runtime whose `dispose()` deletes the entry and calls `session.dispose()` (`src/main.ts:267-360`).
- `ConversationManager.removeConversation()` disposes an instantiated runtime before deleting metadata/store rows (`src/domain/ConversationManager.ts:336-349`).
- `ConversationManager.disposeAll()` clears runtime references and awaits `dispose()` on each instantiated runtime (`src/domain/ConversationManager.ts:424-433`).
- `CopilotAgentSession.dispose()` is terminal, cancels pending approvals, and calls `stopRuntime()` (`src/sdk/AgentSession.ts:842-847`). `stopRuntime()` disconnects the SDK session, stops the client, and force-stops if normal stop times out (`src/sdk/AgentSession.ts:856-905`).

### 12. Settings infrastructure

- `SafetySettings` stores safety policy, allowlist, built-in auto-approve toggles, vault awareness, and `exposeRawFsTools`; defaults live in `DEFAULT_SAFETY_SETTINGS` (`src/settings/SafetySettingsStore.ts:23-83`).
- `SafetySettingsStore.snapshot()` returns a copy; setters update cached fields then call `persist()`, and `persist()` notifies listeners then re-reads and writes the top-level `safety` key while preserving other top-level keys (`src/settings/SafetySettingsStore.ts:118-194`).
- Settings UI uses `new Setting(containerEl)` rows with `addToggle`, `addDropdown`, `addTextArea`, and `addText`; changes call store setters (`src/settings/SettingsTab.ts:50-69`, `src/settings/SettingsTab.ts:76-143`, `src/settings/SettingsTab.ts:231-306`).
- The existing settings store is named around safety/vault-awareness but already owns runtime-adjacent settings such as raw-FS exposure and vault-awareness preamble/task target (`src/settings/SafetySettingsStore.ts:52-74`, `src/settings/SettingsTab.ts:183-319`).

### 13. Session reset and teardown mechanics

- `AgentSession.resetConversation()` cancels pending approvals, disconnects the old SDK session, creates a fresh session on the existing client using `model: this.selectedModel`, reassigns `this.session`, and re-arms first-send preamble injection (`src/sdk/AgentSession.ts:813-840`).
- `cancelCurrent()` aborts the current SDK session when available (`src/sdk/AgentSession.ts:746-754`).
- `ChatView.handleStop()` immediately marks the current assistant placeholder interrupted, disables the button, then calls `cancelCurrent()` on the captured originating session so mid-stream conversation switches do not abort the wrong runtime (`src/ui/ChatView.ts:492-519`).
- Streaming send captures `state`, `convId`, and `session` at send time, appends user and assistant placeholder messages, and persists the user/placeholder before starting the SDK stream (`src/ui/ChatView.ts:521-620`).
- Finalization turns failures into `error`, user stop into `interrupted`, normal completion into `complete`, and persists the final assistant replacement through `ConversationManager.persistMessageReplace()` (`src/ui/ChatView.ts:727-805`).

### 14. Approval cancellation

- `handlePermissionViaSafetyPolicy()` creates a deferred approval, stores it in `pendingApprovals`, awaits the deferred promise, and deletes it in `finally` (`src/sdk/AgentSession.ts:1198-1227`).
- `resolveApproval()` resolves and deletes a pending approval by tool call id (`src/sdk/AgentSession.ts:1344-1349`).
- `cancelAllPendingApprovals(reason)` resolves every pending approval with `{ kind: "reject", reason }` and clears the map; comments list callers including `cancelCurrent`, stream cleanup, `resetConversation`, token rotation, and dispose (`src/sdk/AgentSession.ts:1351-1367`).
- `resetConversation()`, `dispose()`, and `setToken()` call `cancelAllPendingApprovals()` with context-specific reasons (`src/sdk/AgentSession.ts:813-815`, `src/sdk/AgentSession.ts:842-846`, `src/sdk/AgentSession.ts:907-916`).

### 15. Notice / modal infrastructure

- Obsidian `Notice` is imported and used in `ChatView` for switch/create/rename/delete failures, connection errors, stream errors, undo notifications, and soft-cap archiving (`src/ui/ChatView.ts:1-6`, `src/ui/ChatView.ts:193-245`, `src/ui/ChatView.ts:392-399`, `src/ui/ChatView.ts:521-534`, `src/ui/ChatView.ts:727-733`, `src/ui/ChatView.ts:850-857`).
- `ConversationPicker` imports/re-exports `Notice` and defines lightweight overlay helpers `promptForText()` and `confirmDestructive()` using `.copilot-agent-prompt-overlay`, `.copilot-agent-prompt-card`, button rows, Escape/Enter handling, and click-outside cancellation (`src/ui/ConversationPicker.ts:12-14`, `src/ui/ConversationPicker.ts:137-260`).
- `ChatView` uses `promptForText()` for rename and `confirmDestructive()` for delete and Undo divergence confirmation (`src/ui/ChatView.ts:215-245`, `src/ui/ChatView.ts:850-857`).

## Code References

- `node_modules/@github/copilot/copilot-sdk/client.d.ts:274-284` - Public `CopilotClient.listModels()` declaration and failure note.
- `node_modules/@github/copilot/copilot-sdk/index.js:6737-6775` - `listModels()` cache/override/RPC implementation.
- `node_modules/@github/copilot/copilot-sdk/types.d.ts:1634-1651` - Public model capability fields and token limits.
- `node_modules/@github/copilot/copilot-sdk/types.d.ts:1672-1689` - Public `ModelInfo` return shape.
- `node_modules/@github/copilot/copilot-sdk/types.d.ts:1129-1360` - Session config fields; includes `model`, no history/messages seed.
- `node_modules/@github/copilot/copilot-sdk/index.js:6456-6556` - `createSession()` implementation and `session.create` payload.
- `node_modules/@github/copilot/copilot-sdk/session.d.ts:250-265` - `setModel()` documentation: next message, history preserved.
- `node_modules/@github/copilot/copilot-sdk/index.js:5639-5654` - `setModel()` implementation via `session.model.switchTo`.
- `src/sdk/AgentSession.ts:1017-1052` - Current model heuristic.
- `src/sdk/AgentSession.ts:813-840` - Current reset creates a fresh SDK session.
- `src/persistence/PersistedShape.ts:63-79` - Per-conversation persisted shape.
- `src/persistence/migrate.ts:95-127` - Per-conversation migration validation and key projection.
- `src/domain/Conversation.ts:17-63` - Domain metadata and persisted metadata conversion.
- `src/domain/ConversationManager.ts:478-488` - Metadata-only persistence path.
- `src/ui/ChatView.ts:189-256` - Header, conversation picker, title/status row.
- `src/main.ts:203-211` - `liveRuntimes` registry.
- `src/main.ts:344-360` - Runtime dispose removes live entry and disposes session.
- `src/settings/SafetySettingsStore.ts:118-194` - Settings snapshot/setter/persist pattern.
- `src/ui/ConversationPicker.ts:137-260` - Existing overlay modal style.

## Architecture Documentation

- The plugin uses per-conversation runtime ownership: each `ConversationRuntime` has its own `AgentSession`, `UndoJournal`, and `ChatState`; the manager lazily creates runtimes and the chat view re-binds to the active runtime (`src/domain/ConversationRuntime.ts:1-23`, `src/domain/ConversationManager.ts:234-243`, `src/ui/ChatView.ts:156-170`).
- Persistence is split across stores that preserve unrelated top-level keys by re-reading the full Obsidian data blob before writing their owned subtree (`src/persistence/ConversationsStore.ts:455-471`, `src/settings/SafetySettingsStore.ts:180-194`).
- The current SDK adapter keeps minimal structural SDK types locally for testability rather than importing SDK types directly (`src/sdk/AgentSession.ts:1573-1604`).
- Streaming captures the originating runtime’s state/session/id before sending, so mid-stream conversation switches do not redirect deltas, aborts, or final persistence to the wrong conversation (`src/ui/ChatView.ts:542-563`, `src/ui/ChatView.ts:774-805`).
- The settings tab is rebuilt on each `display()` call and wires controls directly to store setter methods (`src/settings/SettingsTab.ts:39-43`, `src/settings/SettingsTab.ts:188-193`).

## Open Questions

- The public SDK model metadata does not expose a direct chat/embedding/image-output discriminator. If the runtime only returns chat-capable models from `models.list`, that constraint is outside the public type evidence captured here (`node_modules/@github/copilot/copilot-sdk/types.d.ts:1634-1651`, `node_modules/@github/copilot/copilot-sdk/types.d.ts:1672-1689`).
- Unknown model id behavior is client-side asynchronous RPC rejection territory in the researched SDK wrapper; the exact server error message/code for a deprecated id is not defined in the public wrapper code (`node_modules/@github/copilot/copilot-sdk/index.js:6456-6556`, `node_modules/@github/copilot/copilot-sdk/index.js:5639-5654`).
- There is no typed create-session transcript seed API in the researched public SDK surface; continuity across model changes is represented by `CopilotSession.setModel()`, while continuity after creating a fresh SDK session would require an application-level prompt convention or storing/resuming SDK session ids (`node_modules/@github/copilot/copilot-sdk/session.d.ts:250-265`, `node_modules/@github/copilot/copilot-sdk/client.d.ts:223-246`).

## Planning Implications

- Model-list infrastructure should wrap `client.listModels()` and cache a `ModelInfo[]`/error/empty state for UI use, because the SDK itself caches successful calls and propagates failures (`node_modules/@github/copilot/copilot-sdk/index.js:6737-6778`).
- Chat-capable filtering cannot rely on a public modality flag; the observed metadata supports policy/limits/vision/reasoning filtering and fail-open behavior for ambiguous models (`node_modules/@github/copilot/copilot-sdk/types.d.ts:1634-1651`, `node_modules/@github/copilot/copilot-sdk/types.d.ts:1672-1689`).
- The “Auto” option can preserve existing behavior by reusing the exact `pickModel()` order and disabled-policy filtering (`src/sdk/AgentSession.ts:1017-1052`).
- For mid-conversation swaps, the SDK’s `session.setModel()` is the documented path that applies on the next message and preserves SDK-side history; a reset/recreate path has no typed transcript seed and would degrade to visible-scrollback preservation plus optional prompt-level context (`node_modules/@github/copilot/copilot-sdk/session.d.ts:250-265`, `node_modules/@github/copilot/copilot-sdk/types.d.ts:1129-1360`).
- Persisting `modelId` fits the existing per-conversation metadata shape, but migration and clone/conversion helpers currently project known keys and must be updated together (`src/persistence/PersistedShape.ts:63-79`, `src/persistence/migrate.ts:95-127`, `src/domain/Conversation.ts:37-63`).
- Picker selection should reuse `ConversationManager.persistMetadataOnly()` semantics for debounced metadata durability, as rename/archive/touch already do (`src/domain/ConversationManager.ts:283-291`, `src/domain/ConversationManager.ts:478-488`).
- Runtime swap/leak tests can assert existing `liveRuntimes` add/remove and `runtime.dispose()` behavior; if `setModel()` is used, no runtime replacement is needed, while reset/recreate must disconnect/dispose the prior session before replacement (`src/main.ts:203-211`, `src/main.ts:344-360`, `src/sdk/AgentSession.ts:813-840`).
- Pending-approval swap handling can reuse the existing cancellation path that rejects all deferred approvals with a reason (`src/sdk/AgentSession.ts:1351-1367`).
- Settings work can follow the existing `SafetySettingsStore`/`SettingsTab` add-a-field pattern, or split a new store if the naming boundary is kept strict; the existing store already persists runtime-adjacent settings under `safety` while preserving top-level siblings (`src/settings/SafetySettingsStore.ts:52-83`, `src/settings/SafetySettingsStore.ts:180-194`).
- Confirmation and unavailable/default notices can reuse existing `Notice` and lightweight overlay modal patterns (`src/ui/ChatView.ts:1-6`, `src/ui/ConversationPicker.ts:137-260`).
