# Per-Conversation Model Picker (v0.4) — Implementation Plan

<!-- Synthesized from plans/PLAN-gpt-5.4.md, plans/PLAN-claude-opus-4.7.md, plans/PLAN-gemini-3.1-pro-preview.md. The per-model drafts remain in plans/ for traceability; this file is canonical from this point. -->

## Overview

v0.4 adds per-conversation model selection on top of the v0.3 multi-conversation baseline. Each conversation persists an optional `modelId`; a chat-header picker reads and writes it; a Settings field controls the prospective default for new conversations; mid-conversation swaps confirm, interrupt any in-flight stream, cancel pending approvals, and apply via `CopilotSession.setModel()` (history preserved, no session teardown). A session-scoped catalog wraps `client.listModels()` with explicit `loading | ready | empty | error` states that drive picker rendering, send-gating, and a single retry affordance. Unavailable persisted ids surface an inline chat error and block send until the user re-picks. The change is strictly additive: every v0.3 baseline behavior (streaming, Stop, approvals, persistence, token rotation, archive, Undo, raw-FS gating, vault-aware preamble) must remain green per NFR-005.

**Phase shippability invariant (degraded-catalog states):** While Phases 2–4 land *without* Phase 5's recovery UX, the plugin MUST behave exactly as v0.3 whenever `ModelCatalog` is in `failure` or `empty` state — i.e., the runtime keeps calling the existing `pickModel()` / `client.listModels()` path at session-creation, no `createSession()` is deferred, and no degraded-state user surface is introduced. The "deferred `createSession()`" contract and every error/empty/unavailable user-facing surface are **introduced in Phase 5**, alongside the UX that recovers from them. This keeps each intermediate phase strictly non-broken (no half-built error states without a retry path).

## Current State Analysis

- Model selection is one-shot at plugin onload via `CopilotAgentSession.pickModel()` (`src/sdk/AgentSession.ts:1017-1052`): it calls `client.listModels()`, drops `policy.state === "disabled"`, then picks `gpt-4.1 → gpt-4o → first gpt-* → first available`, throwing on empty. The id is never displayed and cannot be changed in-app. Existing assertion at `src/sdk/AgentSession.test.ts:179-189`.
- `pickModel()` runs inside `doInit()` *before* `createSession()` (`src/sdk/AgentSession.ts:967-1007`), so a list-fetch failure aborts initialization. v0.4 needs a recoverable list path the UI can drive without aborting the runtime.
- The SDK exposes both creation-time binding (`SessionConfig.model` → `session.create`, `node_modules/.../types.d.ts:1129-1139`) and in-place swap (`CopilotSession.setModel(model, options)` → `session.model.switchTo`, `session.d.ts:250-265`, `index.js:5639-5654`). `setModel()` is documented as "applies to next message, history preserved" — this is the FR-005 mechanism. Per CodeResearch §2 we treat it as the single commit point and never call `resetConversation()` on swap.
- `ModelInfo` exposes `id`, `name`, `capabilities.{supports,limits}`, optional `policy`, `billing`, reasoning fields (`types.d.ts:1672-1689`). **No public chat/embedding/image modality discriminator** — FR-012 fail-open is mandatory.
- Persistence: `PersistedConversation` (`src/persistence/PersistedShape.ts:63-79`) is `{id, name, createdAt, lastActiveAt, archived?, messages, undoEntries}`. Domain mirror `src/domain/Conversation.ts:17-63`. `validateConversation()` (`src/persistence/migrate.ts:95-127`) projects known keys only; unknown per-conversation keys are stripped. Top-level sibling preservation lives in `ConversationsStore` (`src/persistence/ConversationsStore.ts:455-471`) and protects only top-level keys, so adding `modelId` requires coordinated updates to: persisted shape, `validateConversation`, `Conversation` class, `conversationToPersistedMetadata()`, hydration sites in `ConversationManager`, and the `persistMetadataOnly()` debounce path (`src/domain/ConversationManager.ts:478-488`).
- Header is composed in `ChatView.onOpen()`: `.copilot-agent-header` hosts `ConversationPicker`, then `.copilot-agent-header-row` hosts title + status pill (`src/ui/ChatView.ts:184-256`); the pill renders `Connected · ${state.model}` (`src/ui/ChatView.ts:432-467`). FR-015 explicitly allows merging the model fragment into the new picker.
- `ConversationPicker` (`src/ui/ConversationPicker.ts:25-133`) is the established dropdown pattern (button with `aria-haspopup="menu"`, Obsidian `Menu`, checked rows, separators) and exports overlay helpers `promptForText()` / `confirmDestructive()` (`:137-260`) — `confirmDestructive()` is the reusable modal for FR-004.
- Per-conversation runtime ownership: `ConversationRuntime` wraps `AgentSession + UndoJournal + ChatState`, lazily constructed via `ConversationManager.getOrCreateRuntime()` (`src/domain/ConversationManager.ts:437-452`). Live runtimes tracked in `liveRuntimes: Set<{session, conversationId}>` (`src/main.ts:199-211`); dispose paths at `src/main.ts:344-360` and `ConversationManager.ts:336-349, 424-433`. Token rotation iterates `liveRuntimes` (`src/main.ts:373-410`) — the v0.4 catalog refresh hooks here as well.
- Streaming captures `state/convId/session` at send-time (`src/ui/ChatView.ts:521-620`); finalization buckets into `complete | interrupted | error` (`:727-805`). `handleStop()` interrupts the placeholder and calls `cancelCurrent()` on the captured session (`:492-519`). Pending approvals have a clean bulk-cancel path: `cancelAllPendingApprovals(reason)` (`src/sdk/AgentSession.ts:1351-1367`).
- Settings: `SafetySettingsStore` (`src/settings/SafetySettingsStore.ts:118-194`) uses snapshot/setter/persist with top-level sibling preservation — v0.3 already added `exposeRawFsTools` and `vaultAwarePreamble` cleanly. `SettingsTab.display()` (`src/settings/SettingsTab.ts:39-43, 76-143, 188-193`) rebuilds on each open.
- Baseline verified green at synthesis time: `npm test` 611/611, `npm run typecheck`, `npm run build`.

## Desired End State

- Each `PersistedConversation` carries an optional `modelId: string | null`; loads, migrations, and metadata flushes round-trip it without disturbing v0.3 fields or top-level siblings (FR-001, FR-014).
- A chat-header `ModelPicker` shows the active conversation's bound id (or `<id> (unavailable)` when missing from the catalog), opens synchronously from a cached `ModelInfo[]`, and is keyboard-accessible — Enter/Space to open, arrows to navigate, Enter to select, Escape to dismiss (FR-002, FR-015, FR-017, NFR-001, NFR-002).
- A "Default model for new conversations" Settings dropdown lists chat-capable models plus `Auto (heuristic)`; changes affect only newly-created conversations (FR-008, FR-009, SC-003).
- Mid-conversation swaps with at least one completed assistant turn show a confirmation modal; cancel reverts the picker; confirm interrupts any streaming turn (placeholder → `interrupted`), cancels pending approvals, calls `CopilotSession.setModel(newId)`, and persists the new `modelId`. The next user message is dispatched to the new model with both plugin scrollback and SDK-side history preserved (FR-003, FR-004, FR-005, FR-006, NFR-004, SC-007).
- Empty-transcript and identity re-select are dialog-free.
- The onload model-list fetch is decoupled from `doInit()`: failure puts the picker into "Models unavailable — Retry" and blocks send; successful retry repopulates without plugin reload. Empty list is a distinct state: picker disabled, "No chat models available", send blocked (FR-016, FR-018, SC-008).
- An unavailable persisted `modelId` surfaces an inline chat error and blocks send until the user re-picks (FR-010, FR-011, SC-004).
- Migrated v0.3 conversations with `modelId === null` lazy-resolve on first activation using `default → heuristic` order, then persist (FR-013).
- `npm test`, `npm run typecheck`, `npm run build` all green; v0.3 tests untouched except where the heuristic call-site moves (NFR-003, NFR-005, SC-006).

### Verification Approach

- **Automated** (Vitest): (a) `ModelCatalog` cache/failure/retry/empty/filter; (b) persistence migration round-trip of `modelId` (string / null / missing / structurally invalid); (c) `AgentSession.swapModel()` exercising `setModel()`, stream interrupt, and pending-approval cancellation; (d) `ConversationManager` create-with-default-or-heuristic + lazy-resolution paths; (e) `modelPickerLogic` pure reducer (six render states + keyboard state machine); (f) `SafetySettingsStore` round-trip including `null` "Auto" sentinel; (g) `liveRuntimes` invariants across swap; (h) full v0.3 regression suite untouched.
- **Manual**: 7 user-story flows from the Spec + onload list-fetch failure + retry, empty-list rendering, swap-during-stream, swap-during-pending-approval, identity re-select, zero-assistant-turn swap, and v0.3 baseline smoke (Undo across restart, raw-FS gating, archive 21st conversation, token rotation).

## What We're NOT Doing

- MCP integration.
- Extra-vault FS roots.
- Mid-session reload of non-model settings (raw-FS gating still applies on next session start, per v0.3).
- Curated model allowlist in Settings (this release shows all SDK chat-capable models).
- Per-tool / per-message model routing.
- Manual "Refresh models" affordance independent of the FR-018 retry path.
- Surfacing reasoning-effort, vision-support, or context-window metadata in the picker (data is in `ModelInfo` but UX is deferred).
- Per-conversation reasoning-effort controls.
- Soft warning when switching to a materially smaller context window.
- Conversation export/import.
- Snapshot compression for large undo payloads.
- Archived-conversation gestures (show/restore) and command-palette switch-by-name.
- Telemetry / analytics on per-conversation model usage.
- Cross-session pricing/policy display (the `policy.state === "disabled"` filter is reused silently).

## Phase Status

- [ ] **Phase 1: Persistence shape + migration for `modelId`** — Add the optional field; propagate through migrate / domain / metadata-flush; lock in with round-trip tests. No UI change; shippable as additive persistence-only.
- [ ] **Phase 2: `ModelCatalog` + heuristic refactor + Settings default** — Session-scoped cache with `loading | ready | empty | error` states; factor `pickModel()` into a pure resolver shared by onload + `Auto` + lazy resolution; add the Settings default-model row. **Shippable: Settings UI lands and the catalog is wired; default-model creation semantics activate in Phase 3.** While shipping with only Phases 1–2 landed, the runtime continues to use v0.3-equivalent behavior — `pickModel()`/`listModels()` is still invoked at session-creation as today.
- [ ] **Phase 3: `AgentSession.swapModel()` + runtime plumbing** — Wrap `CopilotSession.setModel()` with stream-interrupt + approval-cancel orchestration; expose `ConversationRuntime.setModelId()`; resolve and persist initial `modelId` on conversation creation per FR-007. When the catalog is in `error|empty` state at creation time, fall back to a fresh `client.listModels()` + heuristic resolution (v0.3 behavior preserved); do **not** store `modelId: null` and do **not** defer `createSession()` yet. Shippable: swap is correct via programmatic API; UI lands next.
- [ ] **Phase 4: Chat-header `ModelPicker` UI** — Pure logic module + Obsidian `Menu`-based DOM shell; integrate confirmation dialog; merge with status pill; keyboard ergonomics; happy-path swap. When the catalog is non-ready, the picker either hides itself entirely or renders a non-interactive current-model label (no error / retry / empty banners yet — those land in Phase 5). Shippable: end-user can swap models for any conversation under healthy-catalog conditions; degraded conditions still behave as v0.3.
- [ ] **Phase 5: Recovery flows + inline-error + send gating + deferred `createSession()`** — Introduce the deferred-init contract (AgentSession subscribes to catalog; defers SDK `createSession()` until a usable id is available) and wire unavailable-id detection, retry affordance, empty-list state, inline chat error, and unified `canSend()` gating for all four blocked states; lazy-resolution-on-first-use for migrated v0.3 conversations. This is the phase that **introduces** any user-facing degraded surface.
- [ ] **Phase 6: Documentation** — Produce `.paw/work/model-picker/Docs.md`; update `README.md` and `CHANGELOG.md`.

## Phase Candidates

<!-- Items deferred-but-worth-listing across the three drafts. -->

- [ ] Manual "Refresh models" command independent of the FR-018 retry path (deferred unless dogfooding shows entitlement-change pain mid-session).
- [ ] Richer per-row metadata in the picker — provider badges, context-window size, vision/reasoning support — sourced from `ModelInfo.capabilities`.
- [ ] Per-conversation reasoning-effort controls layered onto model selection.
- [ ] Soft warning when switching to a materially smaller context-window model.
- [ ] Persist a `modelCapabilities` snapshot alongside `modelId` so unavailable-id error messages can hint "was a reasoning model".
- [ ] Curated model allowlist in Settings (Out of Scope — would slot into Phase 2).
- [ ] Migrate `SafetySettingsStore` into a more general `PluginSettingsStore` (v0.3 deferred candidate carried forward).
- [ ] Telemetry on swap frequency and unavailable-id incidence.
- [ ] Surface model id in conversation-list rows in `ConversationPicker`.
- [ ] Command-palette "Models" entry to open the picker from the keyboard.

## Phase Ordering Rationale

1. **Persistence first (Phase 1)** because every later phase reads/writes `modelId`. Landing the shape + migration alone makes the round-trip test trivial, lets reviewers confirm "no v0.3 conversation regresses" before any behavior change, and keeps NFR-005 risk minimal.
2. **Catalog + Settings default (Phase 2)** because both the runtime swap path and the picker UI consume the catalog, and refactoring `pickModel()` into a pure resolver eliminates a duplicate code path before the second caller (`Auto` default + lazy resolution) is introduced. Settings ships standalone — it only resolves on creation.
3. **Runtime swap (Phase 3)** is the highest-risk SDK-interaction work and is wired before any UI calls it, so we integration-test `swapModel()` through direct method calls before the picker exists. This is also where `liveRuntimes` invariants are pinned (NFR-004).
4. **UI (Phase 4)** lands on top of a known-good catalog + swap layer; the picker is mostly composition (`Menu` + `confirmDestructive()` + status-pill merge), with one new pure-logic module.
5. **Recovery flows (Phase 5)** are last for the *behavior* surface because they cross-cut catalog (failure/empty), persistence (unavailable id), UI (inline error, send gating), and runtime — easier to wire correctly once all upstream pieces are stable.
6. **Documentation (Phase 6)** captures the as-built picture; writing earlier risks describing the spec rather than the implementation.

---

## Phase 1: Persistence shape + migration for `modelId`

### Goals

Add `modelId` to the persistence shape and domain mirror with full round-trip durability. No behavior change, no UI.

### Scope

- `src/persistence/PersistedShape.ts`
- `src/persistence/migrate.ts`
- `src/domain/Conversation.ts`
- `src/domain/ConversationManager.ts` (hydration + a new `setConversationModelId()` setter on the existing debounce path)
- Tests: `src/persistence/migrate.test.ts`, `src/persistence/ConversationsStore.test.ts`, `src/domain/ConversationManager.test.ts`

### Implementation

- **`PersistedShape.ts`**: Add optional `modelId?: string | null` to `PersistedConversation`. `null` is the explicit "migrated v0.3, not yet resolved" sentinel; missing collapses to `null` on read. Bump `CURRENT_SCHEMA_VERSION` to `2` in `PersistedConversationsState`.
- **`migrate.ts`** (structural change, not a no-op): The current `loadFromRaw()` (`src/persistence/migrate.ts:44-46`) treats *any* `obj.schemaVersion !== CURRENT_SCHEMA_VERSION` as a recovery trigger (which sidecars data and resets to defaults). Bumping `CURRENT_SCHEMA_VERSION` without restructuring would wipe every v0.3 vault on first v0.4 load — a catastrophic FR-014 / NFR-005 regression. Restructure `loadFromRaw()` so that **`obj.schemaVersion === 1` is recognized as a known prior version BEFORE the equality check**: each conversation is upcast through `validateConversation()` with `modelId: null` injected, the resulting object is stamped with `schemaVersion: 2`, and `recovered: false` is preserved. Only versions outside the recognized set (≠ 1, ≠ 2) trigger recovery. Also extend `validateConversation()` itself to project `modelId` through with `typeof === "string" ? value : null` normalization (rejects numbers/objects to `null`).
- **`Conversation.ts`**: Add `modelId: string | null` to the metadata mirror and to `conversationToPersistedMetadata()`. Constructor accepts optional `modelId` defaulting to `null`.
- **`ConversationManager.ts`**: Update hydration sites (`createInternal()` and persisted-row hydration) to read/write `modelId`. Add `setConversationModelId(convId, modelId)` that uses the existing debounced `persistMetadataOnly()` path — the FR-003 durability hook used by Phases 3–5.

### Tests

- `migrate.test.ts` — **gating test for v1 → v2 upcast (M2)**: a payload with `schemaVersion: 1` plus full v0.3 conversation rows (id, name, createdAt, lastActiveAt, archived, messages, undoEntries) MUST round-trip to a state with `schemaVersion: 2`, `modelId: null` projected onto every conversation, AND `recovered: false`. This test, not the existing recovery test, is the gate that proves the v1 path does not trigger recovery.
- `migrate.test.ts`: round-trip an in-memory v1 blob (no `modelId` field) → load → verify `modelId === null` on every conversation; verify unknown per-conversation keys are still stripped; verify structurally invalid `modelId` values (numbers, objects, arrays) normalize to `null`; verify a payload with an unrecognized `schemaVersion` (e.g., `99`) still triggers recovery.
- `ConversationsStore.test.ts`: round-trip a v2 blob with mixed `modelId` values (string, null, missing) → equality after write/re-read.
- `ConversationManager.test.ts`: `setConversationModelId()` updates metadata and persists exactly once after debounce; messages and undo entries are untouched; sibling top-level keys (`auth`, `safety`) survive.

### Validation

#### Automated Verification:
- [ ] Tests pass: `npm test`
- [ ] Typecheck: `npm run typecheck`
- [ ] Build: `npm run build`

#### Manual Verification:
- [ ] Load a v0.3 vault `data.json`; all conversations retain name/messages/undo; new `modelId: null` appears on first save.
- [ ] Top-level `auth` and `safety` keys survive a v1 → v2 conversation migration write.
- [ ] Round-trip a conversation with `modelId: "gpt-4o"` through the full hydrate-restart-rehydrate loop and confirm equality.

### Risks & Mitigations

- **Risk**: forgetting one of the three projection sites (`migrate.ts`, `Conversation.ts`, `ConversationManager` hydration) silently drops `modelId` on re-save. **Mitigation**: a single integration test that creates a conversation with `modelId: "x"`, restarts the manager from disk, and asserts `modelId === "x"`.
- **Risk**: schema bump causes user concern. **Mitigation**: v1 → v2 is pure additive seeding; CHANGELOG entry will be explicit.

---

## Phase 2: `ModelCatalog` + heuristic refactor + Settings default

### Goals

Introduce a session-scoped `ModelCatalog`, refactor `pickModel()` into a pure resolver, and add the Settings default-model dropdown. Shippable as a behavior-complete "default model on creation" feature even before the UI picker exists.

### Scope

- `src/sdk/ModelCatalog.ts` (new)
- `src/sdk/AgentSession.ts` (extract `resolveHeuristicModelId()`; decouple `doInit()` from `listModels()`)
- `src/settings/SafetySettingsStore.ts`
- `src/settings/SettingsTab.ts`
- `src/main.ts` (catalog construction + onload refresh + token-rotation refresh)
- Tests: `src/sdk/ModelCatalog.test.ts` (new), `src/sdk/AgentSession.test.ts`, `src/settings/SafetySettingsStore.test.ts`

### Implementation

- **`src/sdk/ModelCatalog.ts`** (new): Session-scoped wrapper around `client.listModels()`. Public surface:
  - `getState(): { kind: "loading" } | { kind: "ready"; models: ModelInfo[]; chatModels: ModelInfo[] } | { kind: "empty" } | { kind: "error"; message: string }`
  - `refresh(): Promise<void>` — invoked at onload, on token rotation, and from the FR-018 retry affordance (Phase 5).
  - `subscribe(listener)` — UI re-render hook (picker + send-gating).
  - `isModelAvailable(id: string): boolean` — derived from current `chatModels`.
  - Pure helper `filterChatCapable(models: ModelInfo[]): ModelInfo[]`. **Concrete exclusion rule for FR-012** (per CodeResearch §1, the SDK exposes no public chat/embedding/image discriminator, so we combine the available negative signals and otherwise fail-open):
    1. Drop models where `policy.state === "disabled"`.
    2. Drop models where `disabled === true` is set on the SDK record.
    3. Drop models whose `id` (case-insensitive substring match) contains any known non-chat keyword: `embedding`, `image`, `dall-e`, `whisper`, `tts`.
    4. Everything else passes through (fail-open). A family-prefix list (`gpt-`, `claude-`, `gemini-`, `o1-`, `o3-`, etc.) MAY be used as a positive signal for sort-order/scoring, but it is **never** an exclusion gate.
- **`src/sdk/AgentSession.ts`**: Extract the resolver core (`gpt-4.1 → gpt-4o → first gpt-* → first available`) from `pickModel()` (`:1017-1052`) into an exported pure function `resolveHeuristicModelId(models: ModelInfo[]): string | null`. Keep the existing test at `:179-189` passing via a thin adapter. **`doInit()` keeps its v0.3 signature in this phase** beyond receiving an injected `ModelCatalog` reference — it does NOT switch to "accepts an externally-resolved id" and does NOT defer `createSession()`. When the catalog is in `ready` state, `doInit()` may use the cached `chatModels` and `resolveHeuristicModelId()` to avoid a duplicate `listModels()` round-trip; otherwise it falls back to the existing `pickModel()` / `client.listModels()` path exactly as v0.3 does. The "deferred `createSession()`" contract is introduced in Phase 5 alongside the recovery UX that depends on it.
- **`SafetySettingsStore.ts`**: Add `defaultModelId: string | null` (`null` is the `Auto (heuristic)` sentinel). Extend `mergeWithDefaults`; preserve top-level sibling keys.
- **`SettingsTab.ts`**: Add a "Default model for new conversations" row using `addDropdown` (existing pattern at `:76-143`). Populate from `ModelCatalog.getState()`:
  - `ready` → `Auto (heuristic)` plus one row per chat-capable model (display `name`, value `id`).
  - `empty` / `error` → disabled dropdown showing the catalog status; persisted value still visible.
  - If the persisted `defaultModelId` is no longer in the chat-capable list, prepend a `<id> (unavailable)` row and emit an Obsidian `Notice` once per Settings open (Spec.md Edge Cases: "Global default unavailable at conversation creation", `Spec.md:169`).
- **`main.ts`**: Construct `ModelCatalog` at onload, invoke `catalog.refresh()` once, and call `catalog.refresh()` after each token rotation (entitlements may change).

### Tests

- `ModelCatalog.test.ts` (new): all four state transitions; `filterChatCapable` excludes `policy.state === "disabled"` AND `disabled === true` AND ids matching the non-chat keyword list (`embedding`, `image`, `dall-e`, `whisper`, `tts`); **fixture asserts the exclusion concretely**: stub records `{id: "text-embedding-ada-002"}`, `{id: "dall-e-3"}`, `{id: "whisper-1"}`, `{id: "tts-1"}` MUST be filtered out; a chat record `{id: "gpt-4o"}` MUST pass through; an ambiguous record `{id: "some-future-frobnicator"}` (unknown family, no non-chat keyword) MUST also pass through (fail-open). Empty list → `empty`; thrown error → `error`; subscribe/notify; retry-after-failure repopulates without re-construct.
- `AgentSession.test.ts`: `resolveHeuristicModelId()` preserves `gpt-4.1 → gpt-4o → first gpt-* → first available` ordering; `doInit()` retains v0.3 behavior when the catalog is in `error|empty` state (still calls `listModels()` and resolves internally, no `createSession()` deferral); when catalog is `ready`, `doInit()` uses cached `chatModels` and does not duplicate the `listModels()` call.
- `SafetySettingsStore.test.ts`: round-trip `defaultModelId` including the `null` sentinel; sibling keys survive.

### Validation

#### Automated Verification:
- [ ] Tests pass: `npm test`
- [ ] Typecheck: `npm run typecheck`
- [ ] Build: `npm run build`

#### Manual Verification:
- [ ] Settings dropdown lists models on a healthy account; `Auto (heuristic)` is present and is the default.
- [ ] Disconnecting the network at onload disables the dropdown with a status message; the persisted value remains visible.
- [ ] Setting default to `X` and creating a new conversation persists `defaultModelId: "X"` in `data.json`; existing conversations are unaffected.

### Risks & Mitigations

- **Risk**: family-prefix list is mistaken for an exclusion gate, breaking FR-012. **Mitigation**: explicit unit fixture asserting an unknown-family id passes through; inline comment forbidding negative use; the only negative gates are `policy.state === "disabled"`, `disabled === true`, and the non-chat keyword list (`embedding`, `image`, `dall-e`, `whisper`, `tts`).
- **Risk**: changing `doInit()`'s relationship to `listModels()` subtly alters initialization ordering. **Mitigation**: snapshot the existing happy-path init test; in this phase `doInit()` retains v0.3 behavior when the catalog is non-ready, so the only observable change at the catalog-`ready` happy path is "id resolved from cache instead of fetched again."
- **Risk**: settings UI snapshots stale catalog data. **Mitigation**: drive `SettingsTab` from the same `ModelCatalog.subscribe()` channel as the chat header.

---

## Phase 3: `AgentSession.swapModel()` + runtime plumbing

### Goals

Implement the in-place swap mechanic and the create-time resolution rule. After this phase, `runtime.setModelId(id, { persist: true })` is correct end-to-end at the API level; the user-facing UI lands in Phase 4.

### Scope

- `src/sdk/AgentSession.ts` (`swapModel()`)
- `src/domain/ConversationRuntime.ts` (`setModelId()`)
- `src/domain/ConversationManager.ts` (`createInternal()` resolves and persists `modelId` per FR-007)
- `src/main.ts` (inject catalog + settings into runtime factory; pass persisted `modelId` to `AgentSession`)
- Tests: `src/sdk/AgentSession.test.ts`, `src/domain/ConversationRuntime.test.ts`, `src/domain/ConversationManager.test.ts`

### Implementation

- **`AgentSession.ts`** — add `async swapModel(newModelId: string): Promise<void>`:
  1. If `this.selectedModel === newModelId`, no-op return (identity swap).
  2. If a turn is streaming, call the existing `cancelCurrent()` path (`:746-754`) so `ChatView` finalization marks the placeholder as `interrupted` (`src/ui/ChatView.ts:492-519, 727-805`). Await stream cleanup.
  3. Call `cancelAllPendingApprovals("model-swap")` (`:1351-1367`).
  4. Call `this.session.setModel(newModelId)` (SDK path `index.js:5639-5654`). This is the FR-005 commit point.
  5. Update `this.selectedModel = newModelId` **only after** `setModel()` resolves; notify listeners. On rejection, leave `selectedModel` unchanged so the picker reverts.
  - **Do NOT** call `resetConversation()` (`:813-840`) — that recreates the SDK session and would defeat FR-005's history-preservation guarantee. A guarded comment at the top of `swapModel()` references FR-005.
- **`ConversationRuntime.ts`**: Expose `setModelId(newId: string, opts: { persist: boolean }): Promise<void>` that calls `agentSession.swapModel(newId)` and, when `persist: true`, `conversationManager.setConversationModelId(convId, newId)`. UI calls with `persist: true`; FR-013 lazy-resolution also calls with `persist: true`.
- **`ConversationManager.createInternal()`**: Resolve `modelId` per FR-007 at creation time:
  - If `settings.defaultModelId` is non-null and present in `catalog.chatModels`, use it.
  - Else compute `resolveHeuristicModelId(catalog.chatModels)`.
  - **If the catalog is in `error|empty` state**, fall back to a fresh `client.listModels()` call (v0.3 path) and run `resolveHeuristicModelId()` against that result. Only if the fallback `listModels()` itself fails or returns empty is `modelId: null` stored — and that path is then handled by Phase 5's lazy resolution + inline-error UX. **Phases 1–4 must not produce a `null` `modelId` under any catalog-degraded condition that v0.3 would have succeeded in.**
  - If the configured default was unavailable at resolution, surface a single Obsidian `Notice` (Spec.md Edge Cases: "Global default unavailable at conversation creation", `Spec.md:169`).
  - Write the resolved id immediately so prospective-only semantics hold even if the user changes the default before sending the first message.
- **`main.ts`**: Inject `ModelCatalog` and `SafetySettingsStore` into the runtime factory. When constructing each `AgentSession`, pass the persisted `modelId` as `preferredModel` so the SDK session is created bound to the correct model. `liveRuntimes` invariants — one entry per conversation, no leak across swaps — must hold across the new path.

### Tests

- `AgentSession.test.ts`: `swapModel()` happy path calls `session.setModel()` exactly once with the new id; identity swap is a no-op (no SDK call); swap during stream calls `cancelCurrent()` first; swap with pending approvals calls `cancelAllPendingApprovals` with a recognizable reason; `selectedModel` updates only after `setModel()` resolves; rejected `setModel()` leaves `selectedModel` and metadata unchanged.
- `ConversationRuntime.test.ts`: `setModelId(..., { persist: true })` triggers both the SDK swap and the metadata flush; `{ persist: false }` only swaps.
- `ConversationManager.test.ts`: new conversation with available `defaultModelId: "X"` → `modelId: "X"`; with unavailable `defaultModelId: "Y"` → heuristic id + single `Notice`; with `defaultModelId: null` → heuristic id; existing conversations are not mutated when settings change.
- Regression: `liveRuntimes.size` is unchanged across a swap; token rotation iteration still finds the swapped runtime.

### Validation

#### Automated Verification:
- [ ] Tests pass: `npm test`
- [ ] Typecheck: `npm run typecheck`
- [ ] Build: `npm run build`

#### Manual Verification:
- [ ] Programmatically call `runtime.setModelId("claude-3-5-sonnet", { persist: true })` (devtools), send next message — response is demonstrably from the new model; scrollback intact; `data.json` reflects new `modelId`.
- [ ] Same call while a stream is in flight interrupts the stream (placeholder shows `interrupted`); the next user message uses the new model.
- [ ] Same call while a tool approval is pending cancels the approval cleanly with the recognizable reason.
- [ ] Switch between conversations on different models and confirm each runtime resumes on its persisted model.

### Risks & Mitigations

- **Risk**: `CopilotSession.setModel()` semantics under partial failure are not documented beyond "applies to next message". **Mitigation**: tests assert only observable post-conditions (post-swap, the next user message hits the new id); we do not assume atomicity. On rejection, `selectedModel` is **not** updated and the picker reverts.
- **Risk**: a swap between user-clicks-Send and stream-actually-starts could land mid-RPC. **Mitigation**: the captured-`session` pattern at `ChatView.ts:521-620` already routes stream events to the correct runtime; `swapModel()` is awaited so callers can sequence — Phase 4 enforces "next user-message boundary" in the UI.
- **Risk**: lazy-resolution write-back races with another tab/process. **Mitigation**: the same debounced `persistMetadataOnly()` path used for rename/archive in v0.3.

---

## Phase 4: Chat-header `ModelPicker` UI

### Goals

Land the user-facing picker, including confirmation flow and keyboard ergonomics. Recovery / failure / empty UX is layered in Phase 5.

### Scope

- `src/ui/ModelPicker.ts` (new — DOM owner)
- `src/ui/modelPickerLogic.ts` (new — pure logic module, testable in node like `src/ui/chatKeydown.ts`)
- `src/ui/ChatView.ts` (mount picker; merge with status pill; wire `canSend()`)
- `styles.css` (header layout, picker emphasis variants)
- `src/main.ts` (pass catalog accessors + retry callbacks into the chat view)
- Tests: `src/ui/modelPickerLogic.test.ts` (new), `src/ui/ChatView.test.ts` (extend) or new `ModelPicker.integration.test.ts`

### Implementation

- **`src/ui/ModelPicker.ts`** (new): Mirrors the `ConversationPicker` pattern (`src/ui/ConversationPicker.ts:25-133`). Renders a button with `aria-haspopup="menu"`, current-model label, chevron icon. Opens an Obsidian `Menu` with one row per chat-capable model (checkmark on current id), plus separators. **When the catalog is non-ready in this phase, the picker degrades to v0.3-equivalent presentation**: render a non-interactive label showing the active conversation's bound model id (or hide the picker entirely if no id is resolved) — no error / retry / empty banners, no `<id> (unavailable)` rows. Those degraded surfaces are introduced together in Phase 5; this phase deliberately ships only the healthy-catalog UX so that under degraded conditions the user sees v0.3 behavior.
- **`src/ui/modelPickerLogic.ts`** (new, pure): Pure reducer mapping `(catalogState, activeConversation, settingsDefault) → PickerViewModel`:
  - Render state: `{ kind: "disabled-empty" } | { kind: "disabled-error", message, retryable: true } | { kind: "ready", rows, currentId, unavailableId? }`.
  - Keyboard reducer: open/close, arrow navigation, Enter to select, Escape to dismiss — mirrors `decideKeydownAction()` extraction at `src/ui/ChatView.ts:320-348`.
  - Pure helpers: identity-swap detection; "should confirm swap?" derivation (count `state.messages` filtered by `role === "assistant" && status === "complete"`).
- **`src/ui/ChatView.ts`**: Mount `ModelPicker` in `.copilot-agent-header-row`. **Merge with the status pill** (FR-015): the picker IS the model indicator; the connection state remains as a smaller adjacent dot/badge. This keeps a single source of truth for "which model" and matches how `ConversationPicker` owns conversation identity.

  On picker selection:
  1. Identity → no-op.
  2. Zero completed assistant turns → call `runtime.setModelId(newId, { persist: true })` immediately (no dialog).
  3. Otherwise show `confirmDestructive()` (`src/ui/ConversationPicker.ts:137-260`) with:
     > "Switching to `<new-name>`. The conversation history is preserved; your next message will be answered by `<new-name>`. Continue?"
     - If pending approvals exist, append: "Any pending tool approvals will be cancelled."
     - Cancel → picker reverts visually (no state mutation).
     - Confirm → `runtime.setModelId(newId, { persist: true })`.
  - Gate the picker click handler with an `isSwapInProgress` flag set between `confirm` and `setModelId` resolution to prevent overlapping swaps.
- **`canSend()` scaffold**: Add a `canSend(): { ok: true } | { ok: false; reason: string }` helper used by send-button enable logic and Enter handling (`src/ui/ChatView.ts:320-348, 521-534`). In Phase 4 it only returns `ok: true` (Phase 5 adds the four blocked states). One source of truth for both the button state and Enter dispatch.

### Tests

- `modelPickerLogic.test.ts` (new, pure): all six render states; keyboard state machine; identity-swap detection; assistant-turn count → confirmation-required derivation; current-id reflects the active conversation.
- `ChatView.test.ts` (extend) / `ModelPicker.integration.test.ts`: confirmation dialog appears for swap with assistant turns; cancel reverts the picker label; confirm calls `runtime.setModelId`; empty-transcript swap skips the dialog; identity re-select is a no-op; status-pill merge does not regress the existing auth/connection rendering covered by `ChatView.ts:432-467`.

### Validation

#### Automated Verification:
- [ ] Tests pass: `npm test`
- [ ] Typecheck: `npm run typecheck`
- [ ] Build: `npm run build`

#### Manual Verification:
- [ ] Open chat — picker shows the active conversation's model.
- [ ] Switch conversations — picker label updates within one render frame (NFR-002 budget).
- [ ] Mid-conversation swap with assistant turns shows the modal; cancel reverts; confirm triggers a swap; next response is demonstrably from the new model; prior scrollback intact.
- [ ] Identity re-select: no dialog, no swap.
- [ ] Empty-transcript swap: immediate, no dialog.
- [ ] Keyboard: focus the picker, Enter opens, arrows navigate, Enter selects, Escape closes.

### Risks & Mitigations

- **Risk**: status-pill merge surprises v0.3 users. **Mitigation**: keep an adjacent connection dot/badge; mention in CHANGELOG; fall back to a sibling-pill layout if reviewers push back (no logic change).
- **Risk**: confirmation copy is ambiguous in the pending-approvals case. **Mitigation**: dedicated test asserts the conditional copy fragment.
- **Risk**: blocked-send logic drifts from rendered guidance. **Mitigation**: the inline message and the send gate both derive from the same `canSend()` / `modelPickerLogic` state.

---

## Phase 5: Recovery flows + inline-error + send gating

### Goals

Wire the four blocked states (unavailable id, catalog failure, catalog empty, unresolved id) into a single `canSend()` taxonomy with matching inline guidance, retry affordance, and lazy-resolution-on-first-use for migrated v0.3 conversations.

### Scope

- `src/sdk/ModelCatalog.ts` (extend Phase 2 — `isModelAvailable` already added; add retry triggers)
- `src/ui/ChatView.ts` (inline-error banner; extend `canSend()`; precedence rules; retry button)
- `src/ui/modelPickerLogic.ts` (extend — unavailable-id row + selection clears the error)
- `src/domain/ConversationManager.ts` (lazy-resolve `modelId === null` on first activation, default-then-heuristic, write-through)
- `src/main.ts` (onload no longer aborts on list-fetch failure; token rotation refreshes catalog)
- Tests: `src/ui/ChatView.test.ts`, `src/sdk/ModelCatalog.test.ts`, `src/domain/ConversationManager.test.ts`, end-to-end fabricated-id reload test

### Implementation

- **Deferred `createSession()` contract (introduced in this phase, S1)**: `AgentSession` gains a subscription to `ModelCatalog`. New construction order under degraded conditions:
  1. If the catalog is `ready` at runtime construction, `AgentSession` resolves an id and calls `createSession()` exactly as Phase 3.
  2. If the catalog is `error|empty` at runtime construction AND no usable persisted `modelId` exists, `AgentSession` stores `selectedModel = null`, **does not call `createSession()`**, and exposes a `state === "deferred-init"` flag that `canSend()` reads.
  3. When the catalog transitions `error|empty → ready` (typically after the user clicks the FR-018 retry button or after token rotation) AND the runtime has not yet created an SDK session, `AgentSession` resolves an id (`settings.defaultModelId` if available else heuristic) and constructs the SDK session in-place — no plugin reload. Listeners are notified so the picker re-renders and `canSend()` re-evaluates.
  4. If the user sends a message while still deferred, send is blocked by `canSend()` (one of the four blocked states in the inline-error banner below).
- **Inline-error banner** above the chat input (similar shape to existing stream-error rendering at `src/ui/ChatView.ts:727-733`), triggered when:
  - Active `modelId` is non-null AND `!catalog.isModelAvailable(modelId)` → `"Model `<id>` is no longer available. Pick a model to continue."` (FR-010).
  - Catalog state is `error` → `"Models unavailable: <message>"` + inline **Retry** button calling `catalog.refresh()` (FR-018).
  - Catalog state is `empty` → `"No chat models available."` (no retry button, distinct from failure) (FR-016).
  - Active `modelId === null` AND catalog is not `ready` → blocked state inherited from above.
  - **Precedence** (single banner only): `unavailable-id > catalog-error > catalog-empty > stream-error`.
- **`canSend()` extension**: Returns `{ ok: false, reason }` for each blocked state above; wires into the existing send-button disable logic and the Enter key dispatch (`src/ui/ChatView.ts:320-348, 492-534`). Coexists with v0.3's connection-loss block by extending the existing block-reason taxonomy — one source of truth for "is send allowed".
- **Picker unavailable-id row**: When the active conversation's persisted id is missing, the picker prepends a disabled `<id> (unavailable)` row with a checkmark above the separator + chat-capable list. Selecting any other row clears the inline error on the next render (the `setModelId` write replaces the unavailable id).
- **Onload flow** (`main.ts`): `catalog.refresh()` runs once; failure does **not** abort plugin init (unlike v0.3 `pickModel()` behavior). Each `ConversationRuntime` is still constructed; its `AgentSession.doInit()` defers `createSession()` until a usable model id is available — first-send remains the trigger that finally creates the SDK session if it wasn't created at runtime construction.
- **Token rotation** (`src/main.ts:373-410`): After token update, call `catalog.refresh()` so entitlement changes propagate to the picker without plugin reload.
- **Lazy resolution (FR-013)**: When a v0.3-migrated conversation with `modelId === null` is first activated, attempt resolution via `settings.defaultModelId` (if available) else heuristic; write through `setConversationModelId()`. If both paths fail (catalog not ready), the conversation enters the FR-010 inline-error state with copy adjusted (`<id>` replaced by `<unresolved>`).

### Tests

- `ChatView.test.ts`: inline-error appears for each of the four blocked states; send button disabled in each; picking an available model clears the error; precedence rules are honoured (only one banner at a time).
- `ModelCatalog.test.ts`: `isModelAvailable()` correctness across state transitions; retry-after-failure path.
- `ConversationManager.test.ts`: lazy resolution of `modelId === null` on first activation uses default-then-heuristic order and writes through; degenerate "catalog not ready" state leaves `modelId === null` and surfaces the FR-010 path.
- End-to-end: persist a conversation with `modelId: "fake-deprecated"`, reload, verify inline error + send-block + recoverability by selecting a real model. Stub an empty `listModels()` response → picker disabled with "No chat models available"; visually distinct from the failure state (no retry button). Force `listModels()` failure, verify retry state, succeed on retry without reloading the plugin.
- **Deferred-init regression (S1)**: catalog starts in `error`, runtime is constructed (no SDK `createSession()` issued), `canSend()` returns blocked, user clicks retry, catalog transitions to `ready`, `AgentSession` auto-creates the SDK session, and a subsequent `sendMessage()` succeeds — all without plugin reload. Assert exactly one `createSession()` call across the whole sequence and zero spurious calls before the catalog became ready.

### Validation

#### Automated Verification:
- [ ] Tests pass: `npm test`
- [ ] Typecheck: `npm run typecheck`
- [ ] Build: `npm run build`

#### Manual Verification:
- [ ] Stop the network → reload plugin → picker shows `Models unavailable — Retry`; send blocked with same message; restoring network + clicking retry repopulates the picker without plugin reload.
- [ ] Hand-edit `data.json` to set a conversation's `modelId: "gpt-banana"` → reload → that conversation shows inline error + `<id> (unavailable)` picker row; selecting a real model clears the error; next send works.
- [ ] Stub an empty `listModels()` response (or revoke entitlements) → picker disabled with `No chat models available`; visually distinct from the failure state (no retry button).
- [ ] A v0.3-migrated conversation (no `modelId`) opens, lazy-resolves to the default or heuristic id on first activation, and persists.

### Risks & Mitigations

- **Risk**: "block send" semantics conflict with v0.3's existing connection-loss block. **Mitigation**: extend the existing block-reason taxonomy rather than gating in parallel; one source of truth.
- **Risk**: a user enqueues a send during a catalog-refresh-after-rotation race. **Mitigation**: `swapModel()` and `createSession()` are inside try/catch; rejection messages surface via the existing stream-error path so the user always sees something useful.
- **Risk**: inline-error rendering above the chat input visually conflicts with the v0.3 stream-error path. **Mitigation**: render at most one banner; explicit precedence as listed above.

---

## Phase 6: Documentation

### Goals

Capture the as-built v0.4 behavior for future contributors and end users.

### Scope

- `.paw/work/model-picker/Docs.md` (new — load `paw-docs-guidance` skill)
- `README.md`
- `CHANGELOG.md`

### Implementation

- **`Docs.md`**: Architecture diagram (catalog + per-runtime swap + picker + recovery flows); persistence shape change (v1 → v2; `modelId` semantics: `string` vs `null`); SDK dependency notes (`listModels()`, `CopilotSession.setModel()`, `policy.state === "disabled"` filter, fail-open chat-capable rule, no public modality discriminator); state machine for the picker (ready / empty / error / unavailable-id) with allowed transitions; swap orchestration order (stream interrupt → approval cancel → `setModel()` → `selectedModel` update → metadata persist); recovery walkthroughs for the three blocked states; FR/NFR/SC traceability.
- **`README.md`**: New section under release notes describing per-conversation model selection, the Settings default, recovery affordance, and keyboard accessibility; update any "current limitations" copy that referenced single-model behavior.
- **`CHANGELOG.md`**: `## v0.4` entry with `### Added` (per-conversation model picker, default-model setting, model-list catalog with retry/empty states), `### Changed` (header layout: status pill merged into model picker), `### Migration` (schema v1 → v2, additive only).

### Tests

No new code tests; rerun the full verification suite so documented commands remain current.

### Validation

#### Automated Verification:
- [ ] Tests pass: `npm test`
- [ ] Typecheck: `npm run typecheck`
- [ ] Build: `npm run build`

#### Manual Verification:
- [ ] `Docs.md` covers every FR + NFR + SC (cross-reference the matrix below).
- [ ] `README` and `CHANGELOG` entries follow v0.3 conventions (versioned H2, bullet release notes).

### Risks & Mitigations

- **Risk**: docs describe the spec rather than the final implementation. **Mitigation**: write only after Phases 1–5 are green and validated.

---

## FR / NFR / SC Coverage Matrix

| Spec ID | Title (abbrev.) | Primary Phase(s) | Notes |
|---------|-----------------|------------------|-------|
| FR-001 | Per-conversation `modelId` field | 1 | Optional, nullable; round-trip tested. |
| FR-002 | Header surfaces model picker | 4 | Replaces/merges with status pill (FR-015). |
| FR-003 | Picker selection persists | 1 (storage) + 4 (call site) | Uses `persistMetadataOnly()` debounce. |
| FR-004 | Confirmation when prior assistant turns + non-identity | 4 | `confirmDestructive()` reuse; assistant-turn count check. |
| FR-005 | In-place swap via `CopilotSession.setModel()` | 3 | No session teardown; never calls `resetConversation()`. |
| FR-006 | Interrupt in-flight stream before swap | 3 | Reuses `cancelCurrent()` + placeholder→`interrupted` path. |
| FR-007 | Initial `modelId` resolution at creation | 2 (resolver) + 3 (call site) | Default-then-heuristic; written immediately. |
| FR-008 | Settings exposes default-model control with `Auto` | 2 | `null` = `Auto` sentinel. |
| FR-009 | Changing default does not mutate existing convs | 2 + 3 | Resolution happens once at creation. |
| FR-010 | Inline error on unavailable persisted id | 5 | Banner + `<id> (unavailable)` picker row. |
| FR-011 | Send blocked while FR-010 active | 5 | `canSend()` extension. |
| FR-012 | Filter to chat-capable, fail-open | 2 | Family-prefix is positive signal only, never an exclusion gate. |
| FR-013 | Migration-safe lazy resolution | 1 (shape) + 5 (resolve-on-first-use) | Reuses FR-007 rule. |
| FR-014 | No sibling-key regression | 1 | Top-level merge preserved; schema bump tested. |
| FR-015 | Header indicator in sync with picker | 4 | Picker IS the model indicator. |
| FR-016 | Empty model list → disabled + send-block | 2 + 5 | Distinct visual from failure (no retry button). |
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

---

## NFR-005 Phase-Local Regression Matrix

Per GPT finding-3, mapping each NFR-005 baseline behavior to the existing v0.3 test/smoke that protects it AND the phase(s) most likely to disturb it. These are the targeted re-runs each phase MUST keep green in addition to the full-suite `npm test`.

| v0.3 baseline behavior | Existing v0.3 protection | Phases most likely to disturb |
|------------------------|--------------------------|-------------------------------|
| Streaming (placeholder lifecycle, finalization buckets `complete`/`interrupted`/`error`) | `src/ui/ChatView.test.ts` streaming + finalization cases (cf. `src/ui/ChatView.ts:521-620, 727-805`) | Phase 3 (`swapModel()` interrupts streams), Phase 5 (deferred-init send path) |
| Stop button (`handleStop()` + `cancelCurrent()`) | `ChatView.test.ts` Stop coverage (cf. `src/ui/ChatView.ts:492-519`) | Phase 3 (swap reuses `cancelCurrent()`), Phase 4 (UI button wiring near picker) |
| Pending-approval cancellation (`cancelAllPendingApprovals`) | `AgentSession.test.ts` approval-cancel cases (cf. `src/sdk/AgentSession.ts:1351-1367`) | Phase 3 (swap calls bulk-cancel), Phase 4 (modal copy when approvals present) |
| Token rotation (entitlement refresh + live-runtime iteration) | `main.ts` token-rotation tests (cf. `src/main.ts:373-410`) | Phase 2 (catalog refresh hook), Phase 5 (catalog-driven deferred init re-trigger) |
| Archive flow (21st conversation; sibling-key preservation) | `ConversationsStore.test.ts` archive tests + `ConversationManager.test.ts` (cf. `src/persistence/ConversationsStore.ts:455-471`) | Phase 1 (schema bump, sibling preservation), Phase 3 (`createInternal` change) |
| Undo across restart | `UndoJournal` round-trip tests + manual smoke from v0.3 plan | Phase 1 (persisted shape change), Phase 3 (runtime construction order) |
| Raw-FS gating | `SafetySettingsStore.test.ts` + raw-FS integration tests | Phase 2 (settings store extension) |
| Vault-aware preamble | Existing preamble tests in `AgentSession.test.ts` | Phase 2 (`doInit()` callsite touched), Phase 5 (deferred-init flow) |

Per-phase obligation: when a phase touches a row's "most likely to disturb" cell, its Validation block runs the named existing test(s) explicitly and they MUST stay green. Whole-suite `npm test` remains the catch-all.

---

## References

- Spec: `C:\Repos\obsidian-copilot-agent\.paw\work\model-picker\Spec.md`
- Research: `C:\Repos\obsidian-copilot-agent\.paw\work\model-picker\CodeResearch.md`
- Workflow context: `C:\Repos\obsidian-copilot-agent\.paw\work\model-picker\WorkflowContext.md`
- v0.3 planning reference: `C:\Repos\obsidian-copilot-agent\.paw\work\multi-conversation-persistence\ImplementationPlan.md`
- Per-model drafts (traceability): `C:\Repos\obsidian-copilot-agent\.paw\work\model-picker\plans\PLAN-gpt-5.4.md`, `PLAN-claude-opus-4.7.md`, `PLAN-gemini-3.1-pro-preview.md`

---

## Synthesis Notes

- **Phase structure (6 phases)**: Adopted Claude's 6-phase decomposition over GPT-5.4's 5-phase grouping. Splitting "runtime swap" (Phase 3) from "UI picker" (Phase 4) and from "recovery flows" (Phase 5) yields strictly smaller, independently-shippable increments — the swap mechanic can be integration-tested via direct API calls before any DOM exists, which lowers NFR-005 risk. Gemini's 5-phase plan was too shallow on test strategy to use as the spine.
- **Persistence-first ordering**: Consensus across all three drafts; adopted unchanged.
- **`ModelCatalog` as a session-scoped service with `loading | ready | empty | error` states**: GPT-5.4 and Claude both proposed it; adopted Claude's explicit four-state surface and `subscribe()`/`isModelAvailable()` API because it lets `SettingsTab`, `ChatView`, and the picker share one source of truth and one retry path (FR-018 + FR-016 + FR-010 collapse into one taxonomy).
- **Heuristic refactor into a pure `resolveHeuristicModelId()`**: Both top drafts agreed; chose Claude's exported-function shape over GPT-5.4's "thin reusable helper" wording because the call-site count (onload, `Auto` default, lazy resolution) makes a named pure export easier to test.
- **Schema bump to v2**: Adopted from Claude. GPT-5.4 left this implicit. The bump is no-op transformation but signals "new field landed" to future migrations and matches the v0.3 sibling-preservation tests already in the repo.
- **Family-prefix list as positive signal only**: Adopted Claude's explicit "never an exclusion gate" framing because FR-012 is fail-open and the implementer most likely failure mode is to misuse the prefix list as a filter. Pinned with a dedicated unit fixture.
- **Header layout — merge picker with status pill (FR-015 Option A)**: Claude proposed both options; adopted Option A as recommended because it produces one source of truth for "which model" and matches how `ConversationPicker` owns conversation identity. GPT-5.4 implicitly endorsed this as well.
- **`canSend()` as a single helper**: GPT-5.4 emphasized "blocked-send logic and rendered guidance must derive from one helper". Adopted that framing and made it the explicit precedence rule in Phase 5 (`unavailable-id > catalog-error > catalog-empty > stream-error`).
- **Lazy resolution moved to Phase 5** rather than Phase 1: Claude's placement; adopted because lazy resolution depends on the catalog and on the inline-error path, both of which only exist in later phases. Phase 1 just stores `null`.
- **Pure-logic split for the picker (`modelPickerLogic.ts`)**: Adopted from both Claude and GPT-5.4; mirrors the established `chatKeydown.ts` pattern in the repo and keeps the keyboard reducer + render-state derivation testable in node.
- **`liveRuntimes` invariant testing on swap**: Both top drafts called this out for NFR-004. Adopted as an explicit regression test in Phase 3.
- **Settings UI rendering of an unavailable persisted default**: Adopted Claude's "preserve and mark as `(unavailable)`" pattern over silently clearing — preserves user intent and matches Spec.md Edge Cases (`Spec.md:169`, "Global default unavailable at conversation creation").
- **Documentation last (Phase 6)**: Consensus across all three drafts.

---

## Revision Notes

Changes applied to address consensus review findings (gpt-5.4 BLOCK; claude-opus-4.7 PASS-with-fixes; gemini-3.1-pro-preview PASS).

- **GPT finding-1 + Opus M1 (must-fix) — Phase shippability under degraded catalog states.** Reworked the Phase Status bullets and added a new "Phase shippability invariant" paragraph in Overview: while Phases 2-4 land without Phase 5 UX, the plugin behaves as v0.3 under rror|empty catalog state (existing `pickModel()`/`listModels()` retained, no deferred `createSession()`, no degraded user surface). Phase 2 no longer changes `doInit()` signature beyond catalog injection; Phase 3 falls back to a fresh `listModels()` + heuristic when the catalog is non-ready instead of storing `modelId: null`; Phase 4 picker degrades to a v0.3-equivalent label/hidden state when the catalog is non-ready; Phase 5 is now the sole introducer of the deferred-init contract and every error/empty/unavailable user surface. Phase 2 shippability claim reworded per Opus M1 to "Settings UI lands and the catalog is wired; default-model creation semantics activate in Phase 3."
- **Opus M2 (must-fix) — Schema v1→v2 migration safety.** Phase 1 Implementation now spells out the structural restructuring of `loadFromRaw()` (recognize `obj.schemaVersion === 1` BEFORE the equality check, upcast each conversation by adding `modelId: null`, stamp v2, preserve `recovered: false`). A gating regression test was added at the top of Phase 1 Tests: a `schemaVersion: 1` payload with full v0.3 conversation rows MUST round-trip to v2 with `modelId: null` per conversation AND `recovered: false`. Unrecognized versions still trigger recovery.
- **GPT finding-2 (must-fix) — FR-012 filtering concreteness.** Phase 2 `filterChatCapable` now applies a CONCRETE exclusion rule: drop `policy.state === "disabled"`, drop `disabled === true`, AND drop ids whose substring (case-insensitive) matches the non-chat keyword list `embedding | image | dall-e | whisper | tts`. Family-prefix list is explicitly only a positive sort/score signal, never an exclusion gate. Test fixture added with `text-embedding-ada-002`, `dall-e-3`, `whisper-1`, `tts-1` (must be filtered out), `gpt-4o` (must pass), and `some-future-frobnicator` (ambiguous; must pass through fail-open).
- **Opus S1 (should-fix) — Deferred-init contract.** Phase 5 Implementation now opens with an explicit "Deferred `createSession()` contract" subsection naming the trigger (catalog `error|empty → ready` transition), the state `AgentSession` exposes while deferred (`state === "deferred-init"`, `canSend()` reads it), and reload-free recovery semantics. Companion automated test added: catalog starts in `error`, runtime constructed (no `createSession()` yet), retry succeeds, `sendMessage()` works without plugin reload; exactly one `createSession()` across the sequence.
- **Opus S3 (should-fix) — Spurious citations.** Removed both "FR-007 acceptance #4" references in Phase 2 Implementation and Phase 3 Implementation, plus the one in Synthesis Notes; replaced with a direct citation of Spec.md Edge Cases line 169 ("Global default unavailable at conversation creation"). (No "FR-004 acceptance #5" string was present in the plan; nothing to remove there.)
- **GPT finding-3 (should-fix) — NFR-005 phase-local regression matrix.** Added a new "## NFR-005 Phase-Local Regression Matrix" section between the FR/NFR/SC matrix and References. Each baseline behavior (streaming, Stop, approvals, token rotation, archive flow, Undo, raw-FS gating, vault-aware preamble) is mapped to the existing v0.3 test/smoke that protects it AND the phase(s) most likely to disturb it.
