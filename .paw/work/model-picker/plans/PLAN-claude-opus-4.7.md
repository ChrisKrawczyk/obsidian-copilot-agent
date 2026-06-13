# Per-Conversation Model Picker (v0.4) Implementation Plan — Draft (claude-opus-4.7)

## Overview

v0.4 adds per-conversation model selection on top of the v0.3 multi-conversation baseline. Each conversation persists an optional `modelId`; a chat-header picker reads and writes that id; a Settings field controls the prospective default for new conversations; mid-conversation swaps confirm, interrupt any in-flight stream, and apply via `CopilotSession.setModel()` (SDK-side history preserved). An onload-cached chat-capable model list (with explicit failure and empty states) underwrites every UI path, and unavailable persisted ids surface an inline error that blocks send until the user re-picks. The change is strictly additive to v0.3 — no v0.3 baseline behavior (streaming, Stop, approvals, token rotation, archive, Undo, raw-FS gating, vault-aware preamble) regresses.

## Current State Analysis

- Model selection is one-shot at plugin onload: `CopilotAgentSession.pickModel()` calls `client.listModels()`, filters disabled policies, then prefers `gpt-4.1 → gpt-4o → first gpt-* → first available`, and throws on empty (`src/sdk/AgentSession.ts:1017-1052`, tests at `src/sdk/AgentSession.test.ts:179-189`). The selected id is never displayed to the user and cannot be changed in-app.
- `pickModel()` runs inside `doInit()` *before* `createSession()`, so model-list fetch failures abort initialization (`src/sdk/AgentSession.ts:967-1007`). v0.4 needs a model-list path the UI can recover from without aborting the runtime.
- The SDK exposes both session-creation binding (`SessionConfig.model` → `session.create`, `node_modules/.../types.d.ts:1129-1139`, `index.js:6456-6548`) and in-place swap (`CopilotSession.setModel(model, options)` → `session.model.switchTo`, `session.d.ts:250-265`, `index.js:5639-5654`). `setModel()` documents "next message, history preserved" — this is the FR-005 mechanism.
- `ModelInfo` has `id`, `name`, `capabilities.{supports,limits}`, optional `policy`, optional `billing`, optional reasoning fields (`types.d.ts:1672-1689`, `1634-1651`). **No public chat/embedding/image modality discriminator** — FR-012 fail-open is mandatory.
- Persisted per-conversation shape is `{id, name, createdAt, lastActiveAt, archived?, messages, undoEntries}` at `src/persistence/PersistedShape.ts:63-79`. Domain mirror at `src/domain/Conversation.ts:17-63`. Migration projects known keys only at `src/persistence/migrate.ts:95-127`. Top-level sibling preservation pattern at `src/persistence/ConversationsStore.ts:455-471` protects top-level keys, *not* unknown per-conversation keys — so adding `modelId` requires coordinated updates to the persisted type, `validateConversation`, `Conversation` domain class, `conversationToPersistedMetadata()`, and the metadata-only flush path (`ConversationManager.persistMetadataOnly()`, `src/domain/ConversationManager.ts:478-488`).
- The header is composed in `ChatView.onOpen()`: `.copilot-agent-header` hosts `ConversationPicker`, then `.copilot-agent-header-row` hosts title + status pill (`src/ui/ChatView.ts:184-256`). Status pill renders `Connected · ${state.model}` (`src/ui/ChatView.ts:432-467`). FR-015 allows merging the status indicator with the picker.
- `ConversationPicker` is the established dropdown pattern (button with `aria-haspopup="menu"`, Obsidian `Menu`, checked rows, separators; `src/ui/ConversationPicker.ts:25-133`). It also exports overlay helpers `promptForText()` and `confirmDestructive()` used by rename/delete/Undo confirmation (`src/ui/ConversationPicker.ts:137-260`) — `confirmDestructive()` is the reusable modal for the FR-004 swap confirmation.
- Per-conversation runtime ownership: `ConversationRuntime` wraps `AgentSession + UndoJournal + ChatState` (`src/domain/ConversationRuntime.ts`), lazily created via `ConversationManager.getOrCreateRuntime()` (`src/domain/ConversationManager.ts:437-452`). Live runtimes are tracked in `liveRuntimes: Set<{session, conversationId}>` (`src/main.ts:199-211`); dispose paths at `src/main.ts:344-360` and `src/domain/ConversationManager.ts:336-349, 424-433`. Token rotation iterates `liveRuntimes` (`src/main.ts:373-410`).
- Streaming captures `state/convId/session` at send-time (`src/ui/ChatView.ts:521-620`); finalization buckets into `complete | interrupted | error` (`src/ui/ChatView.ts:727-805`). `handleStop()` interrupts the placeholder and calls `cancelCurrent()` on the captured originating session (`src/ui/ChatView.ts:492-519`). Pending approvals live in per-session `pendingApprovals` and have a clean bulk-cancel path: `cancelAllPendingApprovals(reason)` (`src/sdk/AgentSession.ts:1351-1367`).
- Settings: `SafetySettingsStore` exposes the snapshot/setter/persist pattern with top-level sibling preservation (`src/settings/SafetySettingsStore.ts:118-194`). `SettingsTab` rebuilds on each `display()` and wires controls to store setters (`src/settings/SettingsTab.ts:39-43, 188-193`). v0.3 already proved this store cleanly accepts new runtime-adjacent fields (`exposeRawFsTools`, `vaultAwarePreamble`).

## Desired End State

- Each `PersistedConversation` carries an optional `modelId`; loads, migrations, and metadata flushes round-trip it cleanly without disturbing v0.3 fields or top-level siblings.
- A chat-header model picker shows the active conversation's bound id (or `"(unavailable)"` suffix if persisted id is missing from the SDK list), opens synchronously from a cached `ModelInfo[]`, and is keyboard-accessible (Enter/Space to open, arrow keys, Enter to select, Escape to dismiss).
- A new Settings row "Default model for new conversations" lists chat-capable models plus "Auto (heuristic)"; changes affect only newly-created conversations.
- Mid-conversation swaps with at least one completed assistant turn show a confirmation modal; cancel reverts the picker; confirm interrupts any streaming turn (placeholder → `interrupted`), cancels any pending approvals, then calls `CopilotSession.setModel(newId)` and updates persisted `modelId`. The next user message is dispatched to the new model with both plugin scrollback and SDK-side history preserved.
- Empty assistant-turn swaps and identity-swap re-selects are dialog-free no-ops (identity swap) or immediate (no prior context).
- The onload model-list fetch is decoupled from `doInit()`: failure puts the picker into "Models unavailable — Retry" state and blocks send with the same guidance; successful retry repopulates the picker without plugin reload. Empty-list state is distinct: picker disabled, "No chat models available", send blocked.
- An unavailable persisted `modelId` surfaces an inline chat error and blocks send until the user re-picks.
- All v0.3 success criteria stay green: streaming, Stop, approvals (with persistence across plugin reload), token rotation, multi-conversation soft-cap/archive, Undo journal (cross-restart + content-divergence), raw-FS gating, vault-aware preamble.
- `npm test`, `npm run typecheck`, `npm run build` pass; existing v0.3 tests untouched except where heuristic call-sites move.

### Verification approach

- **Automated**: Vitest suites for (a) `ModelCatalog` cache/failure/retry/empty/filter, (b) persistence migration round-trip of `modelId` (present, missing, null, unknown), (c) `AgentSession.swapModel()` exercising `setModel()`, stream interrupt, and pending-approval cancellation, (d) `ConversationManager` create-with-default-or-heuristic path, (e) `ModelPicker` pure logic (keyboard reducer, available/unavailable/disabled/empty/failure render states), (f) `SettingsTab` default-model setter round-trip including "Auto" sentinel, (g) regression tests covering all v0.3 behaviors still pass unchanged.
- **Manual**: Deploy via `npm run deploy`; run the 7 user-story flows (P1 picker, P1 persistence reload, P1 mid-conversation swap with confirmation, P2 global default applies prospectively, P2 unavailable default → notice + heuristic, P2 unavailable persisted id → inline error + recover, P3 chat-capable filtering), plus model-list-fetch-failure → retry, empty model list, swap-during-stream, swap-during-pending-approval, identity-swap, zero-assistant-turn swap, and v0.3 baseline smoke (Undo across restart, raw-FS gating, archive 21st conversation).

## What We're NOT Doing

Per Spec § Scope / Out of Scope, with planning-layer additions surfaced in Phase Candidates:

- MCP integration.
- Extra-vault FS roots.
- Mid-session reload of non-model settings (raw-FS gating still applies on next session start per v0.3).
- Curated model allowlist in Settings (this release shows all SDK chat-capable models).
- Per-tool model selection.
- Manual "refresh models" affordance independent of the FR-018 retry path.
- Tag rename / tag create capability surface.
- Conversation export/import.
- Snapshot compression for large undo payloads.
- Archived-conversation gestures (show/restore) and command-palette switch-by-name.
- Surfacing reasoning-effort, vision-support, or token-limit metadata in the picker (the data is in `ModelInfo` but UX is deferred).
- Telemetry / analytics on per-conversation model usage.
- Cross-session pricing/policy display (the `policy.state === "disabled"` filter is reused silently).

## Phase Status

- [ ] **Phase 1: Persistence shape + migration for `modelId`** — Add the optional field, propagate through migrate/domain/metadata-flush, lock in with round-trip tests. No UI change.
- [ ] **Phase 2: `ModelCatalog` + heuristic refactor + Settings default** — Introduce a session-scoped model-list cache with `ready | empty | error` states, factor `pickModel()` into a pure resolver reusable by both onload heuristic and the "Auto" default, add the Settings default-model row.
- [ ] **Phase 3: `AgentSession.swapModel()` + runtime plumbing** — Wrap `CopilotSession.setModel()` with stream-interrupt + approval-cancel orchestration, surface a per-conversation `setModelId()` on `ConversationRuntime`, ensure `ConversationManager.create()` resolves and persists initial `modelId` per FR-007.
- [ ] **Phase 4: Chat-header `ModelPicker` UI** — Build the picker as a pure-logic module wired to an Obsidian `Menu`-based DOM shell, integrate confirmation dialog, status-pill merge, keyboard ergonomics, and all empty/failure/unavailable states.
- [ ] **Phase 5: Recovery flows + inline-error + send gating** — Wire unavailable-id detection on conversation activation, the inline chat error, send-button gating across all blocked states (unavailable id, model-list failure, empty list), and the model-list retry affordance.
- [ ] **Phase 6: Documentation** — Update README, CHANGELOG, and produce `.paw/work/model-picker/Docs.md` (load `paw-docs-guidance`).

## Phase Candidates

<!-- Items the spec mentions in passing or that emerged during research as "would be nice but not in v0.4" -->

- [ ] Manual "Refresh models" menu item (separate from FR-018 retry); deferred unless dogfooding shows entitlement-change pain mid-session.
- [ ] Per-model badges in picker showing reasoning support / vision support / context-window size from `ModelInfo.capabilities`.
- [ ] Persist `modelCapabilities` snapshot alongside `modelId` so unavailable-id error messages can hint at "was a reasoning model" etc.
- [ ] Migrate `SafetySettingsStore` into a more general `PluginSettingsStore` (the v0.3 deferred candidate); v0.4 keeps the current naming.
- [ ] Telemetry on model-swap frequency and unavailable-id incidence to drive future allowlist UX.
- [ ] Curated allowlist in Settings (Out of Scope — would slot into Phase 2).
- [ ] Surface model id in conversation-list rows in `ConversationPicker` (would require touching v0.3 UI).
- [ ] A "Models" command-palette entry to open the picker from the keyboard outside the chat view.

## Ordering Rationale

1. **Persistence first (Phase 1)** because every later phase reads/writes `modelId`; landing the shape + migration in isolation makes the round-trip tests trivial to assert against an existing v0.3 fixture, and lets reviewers verify "no v0.3 conversation regresses" before any behavior change.
2. **Model catalog + Settings default next (Phase 2)** because both the runtime swap path and the picker UI consume it. Refactoring `pickModel()` into a pure resolver eliminates a duplicate code path before introducing the second caller (Settings "Auto" + lazy resolution).
3. **Runtime swap (Phase 3)** is the highest-risk SDK-interaction work and is wired before any UI calls it, so we can integration-test `swapModel()` via direct method calls before the picker exists.
4. **UI (Phase 4)** lands on top of a known-good catalog + swap layer; the picker is mostly composition (Menu + confirmDestructive + status pill merge).
5. **Recovery flows (Phase 5)** are last because they cross-cut the catalog (failure/empty), persistence (unavailable id), UI (inline error, send gating), and runtime (block send) — easier to wire correctly once all the upstream pieces are stable.
6. **Documentation (Phase 6)** captures the as-built picture and pulls user-facing notes into README + CHANGELOG.

---

## Phase 1: Persistence shape + migration for `modelId`

### Changes Required:

- **`src/persistence/PersistedShape.ts`**: Add optional `modelId?: string | null` to `PersistedConversation` (lines 63-79). `null` is the explicit "migrated v0.3, not yet resolved" sentinel; `undefined` collapses to `null` on read for normalization.
- **`src/persistence/migrate.ts`**: Extend `validateConversation()` (lines 95-127) to project `modelId` into the cleaned key set with `typeof === "string" ? value : null` normalization. Bump `schemaVersion` to `2` in `PersistedConversationsState` (`PersistedShape.ts:74-87`) and add a no-op `v1 → v2` migration step that simply seeds `modelId: null` on each conversation; the schema bump signals "new field landed" to future migrations even though no transformation is required.
- **`src/domain/Conversation.ts`**: Add `modelId: string | null` to the `Conversation` metadata mirror (lines 17-27) and to `conversationToPersistedMetadata()` (lines 53-63). Constructor accepts optional `modelId` defaulting to `null`.
- **`src/domain/ConversationManager.ts`**: Update hydration (`createInternal()` at lines 533-566 and persisted-row hydration at lines 151-184) to read/write `modelId`. Add a `setConversationModelId(convId, modelId)` method that uses the existing `persistMetadataOnly()` debounce path (lines 283-291, 478-488); this is the FR-003 durability hook used by Phases 3-4.
- **Tests**:
  - `src/persistence/migrate.test.ts`: round-trip an in-memory v1 blob (no `modelId` field) → load → verify `modelId === null` on every conversation; verify unknown per-conversation keys are still stripped.
  - `src/persistence/ConversationsStore.test.ts`: round-trip a v2 blob with mixed `modelId` values (string, null, missing) → verify equality after write/re-read.
  - `src/domain/ConversationManager.test.ts`: `setConversationModelId()` updates metadata + persists exactly once after debounce; messages/undo entries untouched.

### Success Criteria:

#### Automated Verification:
- [ ] Tests pass: `npm test`
- [ ] Typecheck: `npm run typecheck`
- [ ] Build: `npm run build`

#### Manual Verification:
- [ ] Load a v0.3 vault data.json; all conversations retain name/messages/undo; new `modelId: null` field appears on first save.
- [ ] Other top-level keys (`auth`, `safety`) survive a v1 → v2 conversation migration write.

### Risks:
- Forgetting one of the three projection sites (`migrate.ts`, `Conversation.ts`, `ConversationManager` hydration) silently drops `modelId` on re-save. Mitigation: a single integration test that creates a conversation with `modelId: "x"`, restarts the manager from disk, and asserts `modelId === "x"`.
- Schema bump triggers user fear ("did something break?"). Mitigation: the v1 → v2 step is pure additive seeding; CHANGELOG entry will be explicit.

---

## Phase 2: `ModelCatalog` + heuristic refactor + Settings default

### Changes Required:

- **`src/sdk/ModelCatalog.ts`** (new): Session-scoped cache wrapping `client.listModels()`. Exposes:
  - `getState(): { kind: "loading" } | { kind: "ready"; models: ModelInfo[]; chatModels: ModelInfo[] } | { kind: "empty" } | { kind: "error"; message: string }`
  - `refresh(): Promise<void>` — invoked from onload and from the FR-018 retry affordance.
  - `subscribe(listener)` — UI re-render hook (picker + send-gating).
  - A pure `filterChatCapable(models: ModelInfo[]): ModelInfo[]` that drops models with `policy.state === "disabled"` and then applies fail-open chat filtering. Because public `ModelInfo` has no modality discriminator (per CodeResearch §1), v0.4 filtering is policy + a configurable family-prefix allowlist (`gpt-`, `claude-`, `gemini-`, `o1-`, `o3-`, etc.); any model whose id does not match a known family passes through (fail-open) per FR-012. The allowlist lives as a module-level constant; a follow-up Phase Candidate is to make it user-configurable.
  - Empty `models` array → `{ kind: "empty" }`; thrown error → `{ kind: "error", message }`.
- **`src/sdk/AgentSession.ts`**: Refactor `pickModel()` (lines 1017-1052) — extract the resolver core (`gpt-4.1 → gpt-4o → first gpt-* → first available`) into an exported pure function `resolveHeuristicModelId(models: ModelInfo[]): string | null` so the same logic powers the onload heuristic, the Settings "Auto" path, and the FR-013 lazy-resolution for migrated v0.3 conversations. Keep the existing exported behavior intact (the test at `AgentSession.test.ts:179-189` continues to pass against the new signature via a thin adapter).
  - `doInit()` (lines 967-1007) is decoupled: it accepts an externally-provided model id (or `null`/`"auto"`) and no longer calls `listModels()` itself. The catalog handles list-fetch failures; `AgentSession` only needs the resolved id to call `createSession({ model })`. If id is `null` and catalog is in failure/empty state, `doInit()` defers init until a usable id arrives (or surfaces the same blocked state).
- **`src/settings/SafetySettingsStore.ts`**: Add `defaultModelId: string | null` (lines 23-83); `null` is the "Auto (heuristic)" sentinel. Extend `mergeWithDefaults` for the new field; keep top-level sibling preservation intact (lines 180-194).
- **`src/settings/SettingsTab.ts`**: Add a "Default model for new conversations" `Setting` row using `addDropdown` (existing pattern at lines 76-143). Populate from `ModelCatalog.getState()`:
  - `ready` → `"Auto (heuristic)"` + each chat-capable model id (display `name`, value `id`).
  - `empty` / `error` → disabled dropdown showing the catalog's status message; persisted value still visible.
  - If the persisted `defaultModelId` is no longer in the chat-capable list, prepend a `"<id> (unavailable)"` row at the top, render an Obsidian `Notice` once per Settings open per FR-007 acceptance #4.
- **`src/main.ts`**: Construct the `ModelCatalog` at plugin onload and pass it into `liveRuntimes` factory; invoke `catalog.refresh()` once at onload. Token rotation already iterates `liveRuntimes` (lines 373-410); add an analogous catalog `refresh()` on token rotation (entitlements may have changed).
- **Tests**:
  - `src/sdk/ModelCatalog.test.ts` (new): all four state transitions, filter behavior (disabled policy excluded; ambiguous family passes through; empty list → `empty`), subscriber notification, retry-after-failure path.
  - `src/sdk/AgentSession.test.ts` (existing): preserve the resolver-order assertion; add coverage for the new `resolveHeuristicModelId()` extraction with explicit fixtures.
  - `src/settings/SafetySettingsStore.test.ts` (existing): default-model field round-trip including `null` sentinel.
  - `src/settings/SettingsTab.test.ts` if present, else light DOM smoke: dropdown populates from catalog state.

### Success Criteria:

#### Automated Verification:
- [ ] Tests pass: `npm test`
- [ ] Typecheck: `npm run typecheck`
- [ ] Build: `npm run build`

#### Manual Verification:
- [ ] Settings dropdown lists models on a healthy account; "Auto" is present and is the default.
- [ ] Disconnecting the network at onload puts the dropdown in the disabled-error state with a retry-like message.
- [ ] Setting default to model X, creating a new conversation, confirms X appears in the (Phase 4) picker once landed; for now, verify `defaultModelId: "X"` is persisted in `data.json`.

### Risks:
- The family-prefix allowlist will drift as Copilot adds models. Mitigation: keep the prefix list short and explicit, document it inline; the fail-open clause means unknown families still appear — the prefix list is just a *positive* signal, never an exclusion gate. **Important**: the implementer must verify this — `filterChatCapable` must NOT drop unknown ids; it should pass through everything except `policy.state === "disabled"` until/unless a richer modality signal becomes available.
- Decoupling `doInit()` from `pickModel()` can subtly change initialization ordering. Mitigation: snapshot existing init tests and verify byte-for-byte unchanged behavior in the "happy path with model X provided" case.

---

## Phase 3: `AgentSession.swapModel()` + runtime plumbing

### Changes Required:

- **`src/sdk/AgentSession.ts`**: Add an async `swapModel(newModelId: string): Promise<void>`:
  1. If `this.selectedModel === newModelId`, no-op return.
  2. If a turn is streaming (`this.currentStream` or equivalent active state), call the existing `cancelCurrent()` path (lines 746-754) — this lets `ChatView.handleStop()`-style finalization mark the placeholder as `interrupted` (existing flow at `ChatView.ts:492-519, 727-805`). Wait for stream cleanup to settle (same await pattern `handleStop` uses).
  3. Call `cancelAllPendingApprovals("model-swap")` (lines 1351-1367) — reuses the existing approval-rejection plumbing.
  4. Call `this.session.setModel(newModelId)` (SDK path `index.js:5639-5654`). SDK docs: applies to next message, history preserved.
  5. Update `this.selectedModel = newModelId`. Notify auth/model listeners so the status pill picks up the new id (existing `renderAuth()` consumer at `ChatView.ts:432-467`).
- Do **not** call `resetConversation()` (`AgentSession.ts:813-840`) — that recreates the SDK session and would defeat FR-005's history preservation guarantee. Add a guarded comment at the top of `swapModel()` referencing FR-005.
- **`src/domain/ConversationRuntime.ts`**: Expose a `setModelId(newId, opts: { persist: boolean }): Promise<void>` method that calls `agentSession.swapModel(newId)` and (when `persist: true`) `conversationManager.setConversationModelId(convId, newId)`. UI calls this with `persist: true`; the FR-013 lazy-resolution path calls it with `persist: true` on first use.
- **`src/domain/ConversationManager.ts`**: Update `createInternal()` (lines 533-566) so new-conversation creation resolves `modelId` per FR-007:
  - Read `settings.defaultModelId`; if non-null and present in `ModelCatalog`'s ready model list, use it.
  - Else compute `resolveHeuristicModelId(catalog.getState().chatModels)` (from Phase 2). If catalog is in failure/empty state, store `modelId: null` and let the existing send-blocked path (Phase 5) handle it.
  - Surface a one-time Settings `Notice` if the configured default was unavailable at resolution time (per FR-007 acceptance #4).
  - Write the resolved id immediately so FR-007 prospective-only semantics hold even if the user changes the default before sending the first message.
- **`src/main.ts`**: Inject `ModelCatalog` and `SafetySettingsStore` into `ConversationRuntimeFactory` (lines 267-360). When constructing each `AgentSession`, pass the persisted `modelId` (or trigger lazy resolution + write-back if `null`) so the SDK session is created bound to the correct model.
- **Tests**:
  - `src/sdk/AgentSession.test.ts`: `swapModel()` happy path calls `session.setModel()` exactly once with the new id; identity swap is a no-op; swap during stream calls `cancelCurrent()` first; swap with pending approvals calls `cancelAllPendingApprovals` with a recognizable reason; `selectedModel` updates only after `setModel()` resolves.
  - `src/domain/ConversationRuntime.test.ts` (new or extend existing): `setModelId(..., {persist: true})` triggers both the SDK swap and the metadata flush.
  - `src/domain/ConversationManager.test.ts`: new conversation with `defaultModelId: "X"` (available) → conv has `modelId: "X"`; with `defaultModelId: "Y"` (unavailable) → conv has heuristically-resolved id AND a Notice is dispatched; with `defaultModelId: null` → heuristic id.
  - Regression: `liveRuntimes` size invariants hold across a swap (no leak, no duplicate); token rotation iteration still finds the swapped runtime.

### Success Criteria:

#### Automated Verification:
- [ ] Tests pass: `npm test`
- [ ] Typecheck: `npm run typecheck`
- [ ] Build: `npm run build`

#### Manual Verification:
- [ ] Programmatically call `runtime.setModelId("claude-3-5-sonnet", { persist: true })` (devtools), send next message — response demonstrably from new model; scrollback intact; `data.json` reflects new `modelId`.
- [ ] Same call while a stream is mid-flight interrupts the stream (placeholder shows `interrupted`), then next user message uses the new model.

### Risks:
- `CopilotSession.setModel()` semantics under partial failure are not documented beyond "applies to next message" (CodeResearch §2). Mitigation: tests assert observable post-conditions only (post-swap, the next user message hits the new id); we do not assume atomicity. If the RPC rejects, `selectedModel` is *not* updated and the picker reverts.
- A swap that happens between the user clicking Send and the stream actually starting could land mid-RPC. Mitigation: the captured `session` reference pattern from `ChatView.ts:521-620` already ensures stream events route to the correct runtime; the swap RPC is awaited before resolving, so callers can sequence (FR-005 acceptance #3 specifies "at the next user-message boundary" which Phase 4 enforces in UI).
- Lazy resolution write-back races with another tab/process. Mitigation: lazy resolution uses the same debounced `persistMetadataOnly()` path that v0.3 uses for rename/archive — known-good against the soft-cap archive flow.

---

## Phase 4: Chat-header `ModelPicker` UI

### Changes Required:

- **`src/ui/ModelPicker.ts`** (new): A class mirroring the `ConversationPicker` pattern (`src/ui/ConversationPicker.ts:25-133`). Renders a button with `aria-haspopup="menu"`, current-model label, chevron icon. Opens an Obsidian `Menu` with one row per chat-capable model (checkmark on current id), plus separator + special rows for `"(unavailable: <id>)"` (when active conv's persisted id is missing), `"Models unavailable — Retry"` (catalog error), or `"No chat models available"` (catalog empty, disabled row).
- **`src/ui/modelPickerLogic.ts`** (new, pure module — testable in node like `src/ui/chatKeydown.ts`): A pure reducer mapping `(catalogState, activeConversation, settingsDefault) → PickerViewModel`. Encapsulates:
  - Render state: `{ kind: "disabled-empty" } | { kind: "disabled-error", message, retryable: true } | { kind: "ready", rows: PickerRow[], currentId, unavailableId?: string }`
  - Keyboard reducer: open/close, arrow-key navigation, Enter to select, Escape to dismiss. Mirrors `decideKeydownAction()` extraction pattern from `src/ui/ChatView.ts:320-348`.
- **`src/ui/ChatView.ts`**: Mount `ModelPicker` in the header row (lines 184-256). Two placement options:
  - **Option A** (recommended): Replace the status pill's model fragment (`Connected · ${state.model}`, lines 432-467) with the `ModelPicker` so the picker IS the model indicator (FR-015 "MAY merge"). Auth/connection state moves to a smaller adjacent indicator.
  - **Option B**: Keep status pill, add picker as a sibling in `.copilot-agent-header-row`. Simpler but consumes more header width and creates two sources of truth for "which model".
  - Recommendation: Option A for fewer moving parts and one source of truth, consistent with how `ConversationPicker` owns conversation identity in the header.
- On picker selection:
  1. If selected id === current id → no-op.
  2. If conversation has zero completed assistant turns (count from `state.messages` filtered by `role === "assistant" && status === "complete"`) → call `runtime.setModelId(newId, { persist: true })` immediately.
  3. Else show `confirmDestructive()` (reusing `src/ui/ConversationPicker.ts:137-260`) with copy:
     > "Switching to `<new-name>`. The conversation history is preserved; your next message will be answered by `<new-name>`. Continue?"
     - If pending approvals exist, append: "Any pending tool approvals will be cancelled."
     - Cancel → picker reverts visually (no state mutation needed since the new id was never committed).
     - Confirm → `runtime.setModelId(newId, { persist: true })`.
- **`src/ui/ChatView.ts` send path**: Wire a `canSend(): { ok: true } | { ok: false; reason: string }` check into the existing send/Stop button enable logic (`src/ui/ChatView.ts:320-348, 521-534`). For Phase 4, this only knows "ok" — the blocked reasons (unavailable id, model-list failure, empty list) land in Phase 5.
- **Tests**:
  - `src/ui/modelPickerLogic.test.ts` (new, pure): all six render states; keyboard reducer state machine; identity-swap detection; assistant-turn-count → confirmation-required derivation.
  - `src/ui/ChatView.test.ts` (extend existing if light DOM, else add `ModelPicker.integration.test.ts`): confirmation dialog appears for swap with assistant turns; cancel reverts picker label; confirm calls `runtime.setModelId`; empty-transcript swap skips dialog.
  - Snapshot/coverage: status-pill merge does not regress auth/connection rendering (`src/ui/ChatView.ts:432-467` covered tests should still pass with adapted assertions).

### Success Criteria:

#### Automated Verification:
- [ ] Tests pass: `npm test`
- [ ] Typecheck: `npm run typecheck`
- [ ] Build: `npm run build`

#### Manual Verification:
- [ ] Open chat — picker shows the current conversation's model.
- [ ] Switch conversations — picker label updates within one frame (NFR-002 budget).
- [ ] Mid-conversation swap with assistant turns shows the modal; cancel reverts; confirm triggers a swap; next response demonstrably from new model; prior scrollback intact.
- [ ] Identity re-select: no dialog, no swap.
- [ ] Empty-transcript swap: immediate, no dialog.
- [ ] Keyboard: focus the picker, Enter opens, arrows navigate, Enter selects, Escape closes.

### Risks:
- Status-pill merge (Option A) may surprise users accustomed to the v0.3 connection indicator location. Mitigation: keep an adjacent connection dot/badge; mention in CHANGELOG. If reviewer pushback, fall back to Option B with no logic changes.
- Confirmation dialog copy must be unambiguous for the `pending approvals` case. Mitigation: dedicated test case asserts the conditional copy fragment.
- A swap initiated while another swap's confirmation is still open could race. Mitigation: picker click handler is gated by `isSwapInProgress` flag set true between confirm and `setModelId` resolution.

---

## Phase 5: Recovery flows + inline-error + send gating

### Changes Required:

- **`src/sdk/ModelCatalog.ts`** (extend Phase 2): Expose `isModelAvailable(id: string): boolean` deriving from current `chatModels` list. Used by the inline-error detection and by the picker's "(unavailable)" rendering.
- **`src/ui/ChatView.ts`**: Add an inline-error banner above the chat input (similar to how stream errors render at `ChatView.ts:727-733`). Triggered when:
  - Active conversation's `modelId` is non-null AND `!catalog.isModelAvailable(modelId)` → FR-010 message: `"Model `<id>` is no longer available. Pick a model to continue."`
  - Catalog state is `error` → `"Models unavailable: <message>"` + inline "Retry" button calling `catalog.refresh()`.
  - Catalog state is `empty` → `"No chat models available."` (no retry).
  - Active conversation has `modelId === null` AND catalog not ready → blocked state inherited from above.
- **Send gating**: Extend `canSend()` from Phase 4 to return `{ok: false, reason}` for each of the three blocked states above; wire into the existing send-button disable logic (`src/ui/ChatView.ts:320-348, 492-534`). Block Enter via `decideKeydownAction()` extension (note: that helper already handles "disconnected"-style cases, so this is an additive case).
- **Unavailable-id picker affordance**: When the picker renders an unavailable id, prepend a disabled row `"<id> (unavailable)"` with a checkmark (so the user sees what was bound) above the separator + chat-capable list. Selecting any other row clears the inline error on send (the next `setModelId` write replaces the unavailable id).
- **Onload flow**: `main.ts` calls `catalog.refresh()` once; failure does NOT abort plugin init (unlike v0.3 `pickModel()` behavior). Each `ConversationRuntime` is still constructed; its `AgentSession.doInit()` defers `createSession()` until a usable model id is available — first-send remains the trigger that finally creates the SDK session if it wasn't created at runtime construction.
- **Token rotation** (`src/main.ts:373-410`): On rotation, call `catalog.refresh()` after the token update so entitlement changes propagate to the picker without plugin reload.
- **Lazy resolution (FR-013)** wraps to Phase 5 because it depends on the same catalog-availability check: when a v0.3-migrated conversation with `modelId: null` is first activated, attempt resolution via `settings.defaultModelId` (if available) else heuristic; write through `setConversationModelId()`. If both paths fail (degenerate state), conversation enters the FR-010 inline-error state with `<id>` replaced by `"<unresolved>"` and copy adjusted accordingly.
- **Tests**:
  - `src/ui/ChatView.test.ts`: inline error appears for each of the four blocked states; send button disabled in each; picking an available model clears the error.
  - `src/sdk/ModelCatalog.test.ts`: `isModelAvailable()` correctness across state transitions.
  - `src/domain/ConversationManager.test.ts`: lazy resolution of `modelId: null` on first activation uses default-then-heuristic order; writes through.
  - End-to-end style: persist a conversation with `modelId: "fake-deprecated"`, reload, verify inline error + send-block + recoverability by selecting a real model.

### Success Criteria:

#### Automated Verification:
- [ ] Tests pass: `npm test`
- [ ] Typecheck: `npm run typecheck`
- [ ] Build: `npm run build`

#### Manual Verification:
- [ ] Stop the network → reload plugin → picker shows "Models unavailable — Retry"; send blocked with same message; restoring network + clicking retry repopulates picker.
- [ ] Hand-edit `data.json` to set a conversation's `modelId: "gpt-banana"` → reload → that conversation shows inline error + "(unavailable)" picker row; selecting a real model clears the error; next send works.
- [ ] Stub an empty `listModels()` response → picker disabled with "No chat models available"; visually distinct from the failure state (no retry button).

### Risks:
- "Block send" semantics must coexist with v0.3's existing connection-loss block. Mitigation: extend the existing block-reason taxonomy rather than gating in parallel; one source of truth for "is send allowed".
- A user who manages to enqueue a send before the inline error renders (race window during catalog refresh-after-rotation) could hit a confusing SDK rejection. Mitigation: `swapModel()` and `createSession()` are already inside try/catch; the rejection's message is surfaced via the existing stream-error path so the user sees *something* useful even in the race window.
- Inline error rendering above the chat input may conflict visually with the v0.3 stream-error path (also above-input). Mitigation: render at most one banner; precedence is `unavailable-id > catalog-failure > catalog-empty > stream-error`.

---

## Phase 6: Documentation

### Changes Required:

- **`.paw/work/model-picker/Docs.md`** (new, load `paw-docs-guidance`): Technical reference covering:
  - v0.4 architecture diagram (catalog + per-runtime swap + picker + recovery flows).
  - Persistence shape change (v1 → v2, `modelId` field semantics: string vs null).
  - SDK dependency notes (`listModels()`, `CopilotSession.setModel()`, `policy.state === "disabled"` filter, fail-open chat-capable rule, no public modality discriminator).
  - State machine for picker (ready / empty / error / unavailable-id) with allowed transitions.
  - Swap orchestration order (stream interrupt → approval cancel → `setModel()` → `selectedModel` update → metadata persist).
  - Recovery flow walkthroughs for the three blocked states.
  - Test-coverage map back to FR/NFR/SC ids.
- **`README.md`**: Add a v0.4 section under the release notes describing per-conversation model selection, the Settings default, and the recovery affordance; update any "current limitations" section that mentioned single-model behavior.
- **`CHANGELOG.md`**: Add `## v0.4` entry with `### Added`, `### Changed`, `### Migration` (note schema v1 → v2, additive only).
- **Verification**:
  - Plain-markdown link check (no MkDocs in this repo — see CodeResearch §Documentation System).
  - Re-skim Docs.md against FR/NFR/SC list using the matrix below.

### Success Criteria:

#### Automated Verification:
- [ ] Build still green: `npm run build`
- [ ] Tests still green: `npm test`

#### Manual Verification:
- [ ] Docs.md covers every FR + NFR + SC (cross-reference matrix in this plan).
- [ ] README and CHANGELOG entries follow v0.3 conventions (versioned H2, bullet release notes).

### Risks:
- None substantive; documentation phase is well-trodden.

---

## FR/NFR/SC Coverage Matrix

| Spec ID | Title (abbrev.) | Primary Phase(s) | Notes |
|---------|-----------------|-------------------|-------|
| FR-001 | Per-conversation `modelId` field | 1 | Optional, nullable; round-trip tested. |
| FR-002 | Header surfaces model picker | 4 | Replaces/merges with status pill (FR-015). |
| FR-003 | Picker selection persists | 1 (storage) + 4 (call site) | Uses `persistMetadataOnly()` debounce. |
| FR-004 | Confirmation when prior assistant turns + non-identity | 4 | `confirmDestructive()` reuse; assistant-turn count check. |
| FR-005 | In-place swap via `CopilotSession.setModel()` | 3 | No session teardown; FR-005-anchored. |
| FR-006 | Interrupt in-flight stream before swap | 3 | Reuses `cancelCurrent()` + placeholder→`interrupted` path. |
| FR-007 | Initial `modelId` resolution at creation | 2 (resolver) + 3 (call site) | Default-then-heuristic; written immediately. |
| FR-008 | Settings exposes default-model control with "Auto" | 2 | `null` sentinel = Auto. |
| FR-009 | Changing default does not mutate existing convs | 2 + 3 | Resolution happens once at creation. |
| FR-010 | Inline error on unavailable persisted id | 5 | "(unavailable)" picker row + chat banner. |
| FR-011 | Send blocked while FR-010 active | 5 | `canSend()` extension. |
| FR-012 | Filter to chat-capable, fail-open | 2 | Family-prefix positive signal, never exclusion. |
| FR-013 | Migration-safe lazy resolution | 1 (shape) + 5 (resolve-on-first-use) | Uses FR-007 rule. |
| FR-014 | No sibling-key regression | 1 | Top-level merge preserved; schema bump tested. |
| FR-015 | Header indicator in sync with picker | 4 | Option A: merged into one element. |
| FR-016 | Empty model list → disabled + send-block | 2 + 5 | Distinct visual from failure. |
| FR-017 | Keyboard accessibility | 4 | Pure reducer in `modelPickerLogic.ts`. |
| FR-018 | Onload fetch failure → retry + send-block | 2 (catalog states) + 5 (UI) | Retry restores picker without reload. |
| NFR-001 | Picker opens synchronously from cache | 2 + 4 | Catalog cached; no SDK round-trip on open. |
| NFR-002 | Conversation-switch picker update ≤ 16 ms | 4 | Subscriber-driven re-render. |
| NFR-003 | No v0.3 test fails | All | Additive tests only. |
| NFR-004 | No runtime session leak on swap | 3 | `setModel()` keeps one session; `liveRuntimes` invariant tested. |
| NFR-005 | All v0.3 baseline behaviors intact | All + 6 | Regression smoke in Phase 6 manual verification. |
| SC-001 | Picker + swap + observable response from chosen model | 3 + 4 | E2E manual. |
| SC-002 | Reload preserves bound model | 1 | Persistence round-trip. |
| SC-003 | Default prospective-only semantics | 2 + 3 | Resolution-at-creation. |
| SC-004 | Unavailable id → error + block + recover | 5 | Full recovery loop. |
| SC-005 | Chat-capable filter; ambiguous models present | 2 | Fail-open test fixtures. |
| SC-006 | v0.3 baselines green | All + 6 | NFR-005 enumeration. |
| SC-007 | Mid-conv swap interrupts + applies + preserves history | 3 + 4 | E2E. |
| SC-008 | Failure + empty visually distinguishable; retry restores | 5 | Distinct banners tested. |

## References

- Issue: see WorkflowContext.md
- Spec: `.paw/work/model-picker/Spec.md`
- Research: `.paw/work/model-picker/CodeResearch.md`
- v0.3 reference baseline: `.paw/work/multi-conversation-persistence/ImplementationPlan.md`
