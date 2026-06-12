# Per-Conversation Model Picker (v0.4) — Implementation Plan Draft

<!-- Independent multi-model planning draft produced by gpt-5.4 -->

## Overview

Implement per-conversation model selection on top of the v0.3 multi-conversation architecture by:

- caching SDK model metadata with a session-scoped catalog built from `listModels()`
- persisting an optional `modelId` on each conversation
- switching the active runtime in place with `CopilotSession.setModel()`
- surfacing a keyboard-accessible header picker, unavailable-model recovery, retry/empty states, and a global default for new conversations

The design deliberately reuses v0.3 patterns: `ConversationManager` owns durable metadata, `PersistedShape`/`migrate.ts` own schema evolution, `main.ts` owns live runtime bookkeeping, `ChatView` owns header/composer behavior, and `SafetySettingsStore`/`SettingsTab` own runtime-adjacent settings.

## Current State Analysis

- `src/sdk/AgentSession.ts` still owns model selection internally via `pickModel()` and picks one model per runtime with no shared catalog state.
- `src/persistence/PersistedShape.ts`, `src/persistence/migrate.ts`, and `src/domain/Conversation.ts` have no per-conversation `modelId`.
- `src/domain/ConversationManager.ts` eagerly persists conversation metadata, but conversation creation has no hook for resolved model assignment or lazy migration repair.
- `src/ui/ChatView.ts` renders the v0.3 conversation picker plus a status pill; there is no model control, unavailable-model banner, or send-blocking logic for model state.
- `src/main.ts` already tracks `liveRuntimes` and disposes one runtime per conversation, which is the right place to verify no leaks across model changes.
- `src/settings/SafetySettingsStore.ts` already stores runtime-adjacent configuration, making it the natural home for the global default model.
- Baseline verification is green today: `npm test` (611/611), `npm run typecheck`, and `npm run build`.

## Desired End State

- Every conversation stores its own optional `modelId`; new conversations resolve and persist immediately, while v0.3 conversations lazily resolve on first use.
- A shared cached model catalog is refreshed from the SDK on plugin startup and on explicit retry, with distinct `ready`, `empty`, and `error` states.
- The active runtime can switch models in place with `setModel()` so the next send uses the new model without tearing down the conversation session.
- The chat header exposes a keyboard-accessible model picker that stays in sync with the active conversation and replaces the current “Connected · model” responsibility.
- Unavailable persisted models, empty model lists, and list-fetch failures block send with clear inline recovery guidance.
- Settings can define a prospective-only default model for new conversations, with `Auto (heuristic)` preserving the existing `pickModel()` ordering.

## What We're NOT Doing

- MCP integration.
- Extra-vault FS roots.
- Mid-session reload of unrelated settings.
- Model allowlist / curation in settings.
- Per-tool or per-message model routing.
- Advanced model capability editing or manual reasoning-effort tuning.
- Conversation export/import.
- Archived-conversation picker gestures or command-palette switch-by-name.
- A standalone “Refresh models” control separate from FR-018 retry.

## Phase Status

- [ ] **Phase 1: Model catalog and conversation metadata foundation** — Introduce shared model-list state, reusable heuristic/filter helpers, and persisted per-conversation `modelId`.
- [ ] **Phase 2: Runtime model binding and swap plumbing** — Bind runtimes to persisted models and add in-place swap mechanics using the SDK session.
- [ ] **Phase 3: Header picker, recovery UX, and blocked-send states** — Ship the in-chat picker, confirmation flow, unavailable/retry/empty UX, and keyboard behavior.
- [ ] **Phase 4: Global default model settings** — Add the prospective-only default-model control for new conversations.
- [ ] **Phase 5: Documentation** — Update Docs.md and user-facing repository docs for v0.4.

## Phase Ordering Rationale

1. **Catalog + persistence first** so every later UI action reads and writes durable state instead of ephemeral runtime state.
2. **Runtime swap second** because the picker must call a verified in-place session API, not recreate sessions.
3. **Header UX third** to ship the smallest end-user slice once the backend state and swap contract are stable.
4. **Settings fourth** because it reuses the same catalog/resolution logic and should not ship until create-time behavior is already correct.
5. **Documentation last** so docs describe the as-built UX and final validation surface.

## Phase Candidates

- [x] [deferred] Dedicated “Refresh models” button independent of the FR-018 retry state.
- [x] [deferred] Richer model metadata in the picker (provider badges, context window, pricing/reasoning hints).
- [x] [deferred] Per-conversation reasoning-effort controls layered onto model selection.
- [x] [deferred] Soft warning when switching to a materially smaller context window.

---

## Phase 1: Model catalog and conversation metadata foundation

### Changes Required:

- **`src/domain/ModelCatalog.ts`** (new): Add a session-scoped catalog service that stores `ModelInfo[]` plus derived UI state (`ready`, `empty`, `error`, `loading`), exposes `refresh()`, and centralizes chat-capable filtering with FR-012 fail-open behavior.
- **`src/sdk/AgentSession.ts`**: Extract the current `pickModel()` ordering into a reusable helper so the runtime auto-path and the new settings `Auto` path share the exact same heuristic; add a public model-list read surface that reuses the runtime client instead of issuing picker-time RPCs.
- **`src/persistence/PersistedShape.ts`**: Add optional `modelId?: string` to `PersistedConversation`.
- **`src/persistence/migrate.ts`**: Preserve/validate optional `modelId` while keeping v0.3 sibling-key behavior unchanged.
- **`src/domain/Conversation.ts`**: Mirror `modelId` into `Conversation` metadata and conversion helpers.
- **`src/domain/ConversationManager.ts`**: Add create/hydrate hooks for model resolution so new conversations write a resolved auto-picked model immediately and migrated v0.3 rows can remain unresolved until first activation/use.
- **`src/main.ts`**: Construct the catalog service, refresh it during startup/auth recovery, and inject model-resolution callbacks into `ConversationManager`.
- **Tests**:
  - New `src/domain/ModelCatalog.test.ts`
  - Extend `src/sdk/AgentSession.test.ts`
  - Extend `src/persistence/migrate.test.ts`
  - Extend `src/domain/ConversationManager.test.ts`

### Coverage:

- **Delivers**: FR-001, FR-013, FR-014, FR-007 (auto-resolution path for creation/migration), NFR-003
- **Contributes to**: SC-002, SC-003, SC-005, SC-008

### Test Strategy:

- **Unit**
  - Heuristic preserves `gpt-4.1 -> gpt-4o -> first gpt-* -> first available`.
  - Disabled-policy filtering stays identical to v0.3.
  - Chat-capable filtering fails open when metadata is ambiguous.
  - Migration accepts missing `modelId`, valid string `modelId`, and rejects structurally invalid values.
  - Conversation creation writes the resolved `modelId`; migrated nulls resolve once and persist.
- **Integration**
  - Hydrate three conversations with three distinct `modelId`s, reload through `ConversationManager`, and verify the IDs survive round-trip.
  - Warm the active runtime after load and verify catalog refresh does not mutate persisted conversation IDs.

### Success Criteria:

#### Automated Verification:
- [ ] Tests pass: `npm test`
- [ ] Typecheck: `npm run typecheck`
- [ ] Build: `npm run build`

#### Manual Verification:
- [ ] Fresh conversations created under Auto persist a concrete `modelId` in plugin data immediately.
- [ ] A v0.3 conversation missing `modelId` resolves on first activation/use and persists without disturbing sibling keys.
- [ ] Reloading the plugin keeps distinct `modelId` values attached to their original conversations.

### Risks & Mitigations:

- **Risk**: ambiguous SDK capability metadata hides usable chat models.  
  **Mitigation**: keep classifier fail-open and test only clearly non-chat exclusions.
- **Risk**: migration work accidentally drops unknown per-conversation keys.  
  **Mitigation**: update every projection/clone path together and keep focused migration round-trip tests.

---

## Phase 2: Runtime model binding and swap plumbing

### Changes Required:

- **`src/sdk/AgentSession.ts`**: Add a public in-place switch method that wraps `CopilotSession.setModel()`, updates the selected model only after success, and reuses existing pending-approval cancellation helpers where needed.
- **`src/domain/ConversationManager.ts`**: Add an explicit per-conversation model update path that mirrors rename/archive durability semantics and keeps runtime/session state aligned with persisted metadata.
- **`src/domain/ConversationRuntime.ts`**: Extend runtime construction expectations so `metadata.modelId` is the source of truth for initial session binding.
- **`src/main.ts`**: Pass persisted `modelId` into each `CopilotAgentSession` via `preferredModel`, and verify the `liveRuntimes` registry remains one entry per conversation across swaps.
- **`src/auth/AuthController.ts` / `src/ui/ChatView.ts`**: Stop treating auth-state model text as the authoritative active-conversation model once runtime-bound model state exists; connection state remains auth-driven, picker state becomes conversation-driven.
- **Tests**:
  - Extend `src/sdk/AgentSession.test.ts`
  - Extend `src/domain/ConversationManager.test.ts`
  - Extend `src/domain/ConversationRuntime.test.ts`

### Coverage:

- **Delivers**: FR-003, FR-005, FR-006, NFR-004, NFR-005
- **Contributes to**: SC-001, SC-006, SC-007

### Test Strategy:

- **Unit**
  - `setModel()` success updates the selected model and preserves the existing session object.
  - `setModel()` failure leaves the prior selected model and metadata unchanged.
  - Model metadata updates use the same debounced persistence semantics as rename/archive.
  - Pending approvals are cancelled with the existing rejection path before a committed swap completes.
- **Integration**
  - Swap models mid-conversation and assert `liveRuntimes.size` is unchanged.
  - Confirm a streaming turn is interrupted before the next-message model switch is applied.
  - Verify switching active conversations rebinds to the correct runtime/session-selected model without cross-talk.

### Success Criteria:

#### Automated Verification:
- [ ] Tests pass: `npm test`
- [ ] Typecheck: `npm run typecheck`
- [ ] Build: `npm run build`

#### Manual Verification:
- [ ] Start on model A, switch to model B, send the next message, and observe that the same conversation history remains visible.
- [ ] Swap during a stream and confirm the visible placeholder finishes as `interrupted` before the next send uses the new model.
- [ ] Switch between conversations on different models and confirm each runtime resumes on its persisted model.

### Risks & Mitigations:

- **Risk**: a failed swap leaves metadata and runtime out of sync.  
  **Mitigation**: treat runtime `setModel()` as the commit point; only persist/announce success after the SDK confirms.
- **Risk**: stream/approval races orphan state.  
  **Mitigation**: reuse the existing captured-originating-session stop path and the existing `cancelAllPendingApprovals()` flow.

---

## Phase 3: Header picker, recovery UX, and blocked-send states

### Changes Required:

- **`src/ui/ModelPicker.ts`** (new): Add a DOM owner for the header model control, following the same split as `ConversationPicker.ts` + pure logic helpers.
- **`src/ui/modelPickerLogic.ts`** (new): Keep picker state derivation DOM-free: selection labels, unavailable suffixes, retry/empty disabled states, keyboard navigation, and “should confirm swap?” decisions.
- **`src/ui/ChatView.ts`**: Replace the current model-in-status-pellet responsibility with a dedicated header picker; add inline model-state messaging, composer send blocking, retry affordance, and confirmation flow for mid-conversation swaps.
- **`src/ui/ConversationPicker.ts`** or shared modal helper: Reuse the lightweight overlay pattern for the model-switch confirmation dialog.
- **`styles.css`**: Add layout/styles for the header picker, unavailable/error emphasis, disabled/retry variants, and inline guidance.
- **`src/main.ts`**: Pass catalog accessors/subscriptions and retry callbacks into the chat view so rendering remains synchronous from cached state.
- **Tests**:
  - New `src/ui/modelPickerLogic.test.ts`
  - Extend `src/sdk/AgentSession.test.ts`
  - Add/extend pure chat-view helper tests for blocked-send and confirmation decisions

### Coverage:

- **Delivers**: FR-002, FR-004, FR-010, FR-011, FR-012, FR-015, FR-016, FR-017, FR-018, NFR-001, NFR-002, NFR-005
- **Contributes to**: SC-001, SC-004, SC-005, SC-006, SC-007, SC-008

### Test Strategy:

- **Unit**
  - Picker rows show only chat-capable models plus an unavailable persisted ID row when needed.
  - Identity re-select is a no-op.
  - No confirmation for zero-assistant-turn conversations; confirmation required once a completed assistant turn exists.
  - Retry, empty, and unavailable states are visually distinct and produce distinct blocked-send reasons.
  - Keyboard behavior matches Enter/Space open, arrows navigate, Enter selects, Escape dismisses.
- **Integration**
  - Persist a fabricated model ID, load the conversation, and verify inline error + blocked send + recovery after re-pick.
  - Force `listModels()` failure, verify retry state, then succeed on retry without reloading the plugin.
  - Force an empty catalog and verify disabled picker + “No chat models available” + blocked send.

### Success Criteria:

#### Automated Verification:
- [ ] Tests pass: `npm test`
- [ ] Typecheck: `npm run typecheck`
- [ ] Build: `npm run build`

#### Manual Verification:
- [ ] The chat header picker always matches the active conversation’s model and updates within one render frame when switching conversations.
- [ ] Canceling a mid-conversation swap restores the prior picker value and leaves the active stream/approval state unchanged.
- [ ] A missing persisted model shows `<id> (unavailable)`, blocks send, and clears immediately after selecting a valid replacement.
- [ ] A model-list fetch failure shows “Models unavailable — retry”; successful retry repopulates the picker in-place.

### Risks & Mitigations:

- **Risk**: header space becomes crowded next to the conversation picker.  
  **Mitigation**: make the model picker the model-status surface instead of adding a second redundant pill.
- **Risk**: blocked-send logic drifts from rendered guidance.  
  **Mitigation**: derive both the inline message and the send gate from the same pure helper state.

---

## Phase 4: Global default model settings

### Changes Required:

- **`src/settings/SafetySettingsStore.ts`**: Add optional `defaultModelId: string | null` (`null` = `Auto`) to the existing settings snapshot and persistence merge path.
- **`src/settings/SettingsTab.ts`**: Add a “Default model for new conversations” dropdown populated from the cached chat-capable catalog plus `Auto (heuristic)`; when the saved value is unavailable, keep it visible with an unavailable marker rather than silently clearing it.
- **`src/domain/ConversationManager.ts`**: Use the settings-backed resolver for new conversations only; existing conversations remain unchanged when the default changes.
- **`src/main.ts`**: Surface the one-time fallback notice when a configured default is unavailable during conversation creation and the manager falls back to Auto.
- **Tests**:
  - Extend `src/settings/SafetySettingsStore.test.ts`
  - Extend `src/domain/ConversationManager.test.ts`
  - Extend `src/lifecycle.test.ts` or add a focused settings/create flow test

### Coverage:

- **Delivers**: FR-007, FR-008, FR-009, NFR-003, NFR-005
- **Contributes to**: SC-003, SC-005, SC-006

### Test Strategy:

- **Unit**
  - Settings store round-trips `defaultModelId` including `null` (`Auto`).
  - Settings option builder preserves an unavailable saved value instead of dropping it.
  - New-conversation resolution chooses configured default when available and Auto when unset/unavailable.
  - Changing the default never mutates existing conversation metadata.
- **Integration**
  - Set default X, create conversation A, change default to Y, verify A remains on X and new conversation B uses Y.
  - Set an unavailable default, create a conversation, verify fallback to Auto and a single notice.

### Success Criteria:

#### Automated Verification:
- [ ] Tests pass: `npm test`
- [ ] Typecheck: `npm run typecheck`
- [ ] Build: `npm run build`

#### Manual Verification:
- [ ] Selecting a default model in Settings affects only newly created conversations.
- [ ] `Auto (heuristic)` reproduces the existing v0.3 model-selection behavior.
- [ ] An unavailable configured default falls back cleanly and informs the user once.

### Risks & Mitigations:

- **Risk**: settings UI snapshots stale model data.  
  **Mitigation**: drive settings from the same catalog subscription as the chat header, with fallback rendering for unavailable saved values.
- **Risk**: the default model leaks into existing conversations retroactively.  
  **Mitigation**: resolve/write on create only; never run a bulk metadata mutation on settings change.

---

## Phase 5: Documentation

### Changes Required:

- **`.paw/work/model-picker/Docs.md`**: Record the as-built architecture, picker states, persistence/migration behavior, and verification approach.
- **`README.md`**: Document per-conversation model selection, header picker behavior, unavailable/retry states, and the default-model setting.
- **`CHANGELOG.md`**: Add the v0.4 release entry for model picker, persistence, and settings.

### Coverage:

- **Delivers**: user-facing documentation obligations from WorkflowContext/Spec; supports NFR-005 rollout confidence

### Test Strategy:

- **Unit / Integration**
  - No new code tests; rerun the full existing verification suite after docs land so the documented commands remain current.

### Success Criteria:

#### Automated Verification:
- [ ] Tests pass: `npm test`
- [ ] Typecheck: `npm run typecheck`
- [ ] Build: `npm run build`

#### Manual Verification:
- [ ] Docs.md matches the shipped architecture and references the actual verification commands.
- [ ] README and CHANGELOG explain the new user-visible model picker/default-model behavior accurately.

### Risks & Mitigations:

- **Risk**: docs describe the spec rather than the final implementation.  
  **Mitigation**: write documentation only after all prior phases are green and validated.

---

## References

- Spec: `C:\Repos\obsidian-copilot-agent\.paw\work\model-picker\Spec.md`
- Research: `C:\Repos\obsidian-copilot-agent\.paw\work\model-picker\CodeResearch.md`
- Workflow context: `C:\Repos\obsidian-copilot-agent\.paw\work\model-picker\WorkflowContext.md`
- v0.3 planning reference: `C:\Repos\obsidian-copilot-agent\.paw\work\multi-conversation-persistence\ImplementationPlan.md`
