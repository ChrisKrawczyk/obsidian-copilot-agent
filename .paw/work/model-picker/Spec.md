# Spec: Per-Conversation Model Picker (v0.4)

## Overview

v0.4 of the obsidian-copilot-agent plugin gives each conversation its own model selection. Today the plugin picks one model at plugin onload via a static heuristic and uses it for every conversation, with no in-app affordance to change it. Users on GitHub Copilot Enterprise have access to many chat models (GPT family, Claude family, Gemini family, etc.) and want to route prompts to different models per conversation.

This release introduces a model picker in the chat header that reflects and controls the active conversation's bound model, persists the selection alongside other conversation metadata, and adds a configurable global default in Settings for new conversations. Mid-conversation swaps are supported via the SDK's in-place model-switch capability, which preserves the underlying session and conversation history; the next user message is dispatched to the newly bound model. A confirmation dialog is shown before mid-conversation swaps to set user expectations that subsequent responses may differ in style, latency, and capability profile.

The change is additive to v0.3 (multi-conversation persistence): the persisted shape grows one optional per-conversation field, and the existing chat header gains one new control. All v0.3 behaviors (streaming, Stop, approvals, token rotation, archive flow, Undo journal, raw-FS gating, vault-aware preamble) MUST remain intact.

## Objectives

- Each conversation owns and remembers its model selection across reloads.
- Users can swap models from the chat header without leaving the conversation.
- Mid-conversation swaps preserve transcript continuity and warn the user before resetting session context.
- A configurable global default applies prospectively to new conversations, never retroactively to existing ones.
- Unavailable persisted models surface a clear, recoverable in-chat error instead of a confusing SDK failure.
- The picker shows only models the user can productively chat with.
- v0.3 baseline behaviors remain unchanged.

## Problem Statement

Users cannot:

1. Compare answers across models on the same prompt within the plugin.
2. Use a fast cheap model for routine questions and a stronger model for hard reasoning, switching as needed.
3. Tell which model produced an existing conversation when reviewing scrollback.
4. Recover gracefully when their preferred model is unavailable — today the heuristic silently picks something else with no in-app indication.

## User Stories

### P1 — In-chat model picker

**As an** Obsidian user with multiple Copilot models available,
**I want** to pick the model for the active conversation from a dropdown in the chat header,
**so that** I can route routine questions to a fast model and hard problems to a stronger one without leaving the chat.

**Acceptance Scenarios:**

1. **Given** I'm in a conversation using the default model, **When** I open the model dropdown in the chat header and select a different model, **Then** the dropdown updates to show the new selection AND (after any required confirmation) the next message I send uses that model.
2. **Given** I select a different model mid-conversation and confirm the swap, **Then** the conversation transcript stays intact (visible scrollback unchanged) AND the next assistant turn comes from the newly selected model.
3. **Given** I create a new conversation while the current one is on model A, **When** the new conversation is created, **Then** it uses the configured global-default model (NOT inheriting from the prior conversation).

**Independent Test**: With at least two chat-capable models available, send one message under model A, swap to model B, send another, and verify the second response originated from B (assertable via the model id surfaced in the chat header).

### P1 — Persistence across reloads

**As an** Obsidian user who configures one conversation per project,
**I want** each conversation to remember its model across plugin reloads and Obsidian restarts,
**so that** my per-conversation model assignments stay consistent without re-picking every time.

**Acceptance Scenarios:**

1. **Given** I've assigned model X to a conversation, **When** I reload the plugin, **Then** that conversation re-opens still bound to model X.
2. **Given** I have ten conversations on five different models, **When** I switch between them via the conversation picker, **Then** each one shows its own persisted model in the header.

**Independent Test**: Persist three conversations with three different model ids. Reload. Verify each reads back the correct id.

### P1 — Mid-conversation swap with confirmation

**As an** Obsidian user mid-way through a conversation,
**I want** a confirmation dialog when I switch models so I understand subsequent responses will come from a different model,
**so that** I'm not surprised by behavior, latency, or capability differences from the new model.

**Acceptance Scenarios:**

1. **Given** an in-flight conversation that already contains at least one assistant turn, **When** I select a different model from the picker, **Then** a confirmation dialog explains "Switching to `<new-model>`. The conversation history is preserved; your next message will be answered by `<new-model>`. Continue?"
2. **Given** the confirmation dialog appears, **When** I cancel, **Then** the picker reverts to the previously bound model AND no model swap occurs.
3. **Given** I confirm the swap, **When** the next message is sent, **Then** the underlying session's bound model is updated in place (via the SDK's in-place switch capability, preserving conversation history) AND the next user message is dispatched to the new model.
4. **Given** a swap is confirmed while a turn is streaming, **Then** the in-flight turn is interrupted, its placeholder is finalized as `interrupted`, and the swap takes effect for the next user message.
5. **Given** a conversation with zero assistant turns (freshly created, no responses yet), **When** I select a different model, **Then** no confirmation dialog appears AND the swap is applied immediately.
6. **Given** I open the picker and re-select the currently-bound model, **Then** no confirmation dialog appears AND no swap occurs (identity swap is a no-op).

**Independent Test**: Start a conversation, send one message, receive one assistant turn. Select a different model. Observe the confirmation dialog. Cancel — picker reverts. Reselect, confirm — verify the next response comes from the new model and the prior visible transcript is preserved end-to-end.

### P2 — Global default model in Settings

**As an** Obsidian user with a clear "favorite" model,
**I want** a Settings field for the default model used by new conversations,
**so that** every fresh conversation starts on my preferred model without per-creation picking.

**Acceptance Scenarios:**

1. **Given** the Settings default is set to model X, **When** I create a new conversation, **Then** that conversation is created with model X bound and persisted.
2. **Given** the Settings default is unset / set to "Auto", **When** I create a new conversation, **Then** the existing onload heuristic resolves the model (preferred chat-family order, then first available).
3. **Given** the Settings default changes from X to Y, **When** I view existing conversations, **Then** their bound models are unchanged (the default applies prospectively to NEW conversations only).
4. **Given** the Settings default points to a model id that is not in the SDK's current available-models list, **When** I create a new conversation, **Then** the onload heuristic is used as a fallback AND a one-time Notice surfaces in Settings to inform the user the default is unavailable.

**Independent Test**: Set the default to model X. Create a conversation. Verify it uses X. Change the default to Y. Open the existing conversation — still on X. Create a new one — uses Y.

### P2 — Recovery when persisted model is unavailable

**As an** Obsidian user whose Copilot access changed since last session,
**I want** a clear in-chat error when a persisted model id is no longer available,
**so that** I know to pick a replacement instead of getting confusing failures.

**Acceptance Scenarios:**

1. **Given** a persisted conversation references model id `gpt-deprecated-1`, **When** I open that conversation and the SDK's available-models list does NOT include `gpt-deprecated-1`, **Then** the picker shows the missing model id with a "(unavailable)" suffix AND an inline error message appears in chat: "Model `gpt-deprecated-1` is no longer available. Pick a model to continue."
2. **Given** the inline error is showing, **When** I pick a replacement from the dropdown, **Then** the error clears AND the conversation can resume normally on the next send.
3. **Given** a fresh plugin load with a persisted model id that's unavailable, **When** I attempt to send a message before re-picking, **Then** the send is blocked with the same inline error AND the picker is highlighted.

**Independent Test**: Persist a conversation with a fabricated model id. Reload. Verify the inline error renders, the send button blocks, and re-picking unblocks send.

### P3 — Filter picker to chat-capable models

**As an** Obsidian user who shouldn't have to know which models are embedding-only or image-only,
**I want** the picker to show only chat/completion-capable models,
**so that** I can't accidentally pick a model that fails on first send.

**Acceptance Scenarios:**

1. **Given** the SDK exposes embedding and image models alongside chat models, **When** I open the picker, **Then** only chat-capable models appear.
2. **Given** the SDK metadata is ambiguous about a model's capabilities, **When** I open the picker, **Then** that model appears (failing open — the SDK will surface a usage error if the user chooses badly, which is preferable to hiding a usable model).

**Independent Test**: Stub the SDK's model list with one embedding model and one chat model. Open the picker. Verify only the chat model is shown.

## Functional Requirements

| ID | Requirement |
|------|-------------|
| FR-001 | Each conversation MUST own an optional `modelId` property in its persisted shape. The property is a resolved model id once the conversation has been opened or used. A missing/`null` value indicates "not yet resolved" and exists only for conversations migrated from v0.3. |
| FR-002 | The chat header MUST surface a model picker that reflects the active conversation's bound model id. |
| FR-003 | Selecting a model in the picker MUST update the active conversation's bound model id and persist it under the same durability guarantee the plugin uses for other per-conversation metadata changes (e.g., rename). |
| FR-004 | A model swap MUST require explicit user confirmation via a modal dialog if and only if the persisted visible transcript already contains at least one completed assistant turn AND the selected model id is different from the currently-bound model id. Swaps that would impact no prior session context (no assistant turns yet) and identity swaps (same model re-selected) MUST proceed without a dialog. |
| FR-005 | A confirmed swap MUST take effect at the next user-message boundary by updating the underlying session's bound model in place via the SDK's in-place model-switch capability. The conversation history (both plugin-visible scrollback and SDK-side session history) MUST be preserved across the swap; the underlying session MUST NOT be torn down or recreated solely to effect a model change. |
| FR-006 | If a swap is confirmed while a turn is streaming, the in-flight turn MUST be interrupted (its placeholder finalized as `interrupted`) before the model swap takes effect on the next user message. |
| FR-007 | When a new conversation is created, its initial `modelId` MUST be the configured global default (if set and available), or the onload heuristic resolution (if the global default is unset OR currently unavailable). The resolved model id MUST be written to the conversation at creation time so that subsequent changes to the global default do not retroactively affect it. |
| FR-008 | Settings MUST expose a "Default model for new conversations" control. The control lists chat-capable models from the SDK, plus an "Auto (heuristic)" option that defers to the onload heuristic. |
| FR-009 | Changing the global default MUST NOT mutate any existing conversation's bound model id. |
| FR-010 | On plugin load, if a conversation's persisted `modelId` is not in the SDK's current available-models list, the picker MUST surface that id with a "(unavailable)" suffix AND the chat MUST render an inline error: "Model `<id>` is no longer available. Pick a model to continue." |
| FR-011 | While the inline error from FR-010 is active for the open conversation, send MUST be blocked with the same inline guidance until the user picks an available model. |
| FR-012 | The picker MUST filter the SDK's model list to chat/completion-capable models. Models with ambiguous capability metadata MUST pass through (fail-open). |
| FR-013 | Persistence MUST be migration-safe: existing v0.3 conversations missing the `modelId` property MUST treat the property as unresolved and lazily resolve it on first use, at which point the resolved id is written and persisted. Lazy resolution uses the same rule as FR-007 (global default if available, else onload heuristic). |
| FR-014 | Migration MUST NOT break v0.3 sibling-key preservation. The `modelId` property is a per-conversation property only; top-level persisted state (auth, safety, settings) is unaffected. |
| FR-015 | The model id surfaced in the existing header status indicator MUST stay in sync with the picker selection. The visual implementation MAY merge the indicator and picker into one element. |
| FR-016 | The picker MUST handle the empty available-models case: if the SDK returns zero chat-capable models, the picker is disabled with the message "No chat models available" AND send is blocked. |
| FR-017 | The picker MUST be keyboard-accessible (open with Enter / Space, navigate with arrow keys, select with Enter, dismiss with Escape) consistent with v0.3 chat keybinding ergonomics. |
| FR-018 | If the onload fetch of the SDK's available-models list FAILS (transport error, auth not yet ready, SDK exception), the picker MUST enter a "Models unavailable — retry" state with a user-visible retry affordance AND send MUST be blocked with the same inline guidance. Successful retry MUST repopulate the picker without requiring a plugin reload. |

## Non-Functional Requirements

| ID | Requirement |
|------|-------------|
| NFR-001 | Opening the picker MUST render synchronously from a cached model list (no SDK round-trip on click). The model list is fetched at plugin onload and cached for the session, with refresh available via FR-018's retry affordance and via user-initiated plugin reload. |
| NFR-002 | Switching the active conversation MUST update the picker selection within one render frame (≤ 16 ms) — same budget as the existing v0.3 conversation switch. |
| NFR-003 | v0.4 MUST NOT cause any previously-passing v0.3 test to fail. New behaviors are covered by additive tests. |
| NFR-004 | The model swap path MUST NOT leak runtime sessions. Because swaps use the SDK's in-place model-switch capability (FR-005), no session replacement occurs and the existing live-session bookkeeping continues to track exactly one runtime per conversation across model changes. If implementation circumstances ever require a session recreate, the prior session MUST be disposed before the replacement is constructed. |
| NFR-005 | All v0.3 baseline behaviors MUST remain intact and observable end-to-end: streaming, Stop control, approval prompts (with persistence across plugin reload), token rotation, multi-conversation soft-cap / archive flow, Undo journal (cross-restart + content-divergence detection), raw-FS gating policy, and the vault-aware preamble. |

## Success Criteria

| ID | Criteria | FRs / NFRs |
|------|----------|-----|
| SC-001 | A user can pick any of the currently-available chat models from the chat header picker, complete any required confirmation, send a message, and observe a response demonstrably from the chosen model (model id reflected in chat header). | FR-002, FR-003, FR-004, FR-005, FR-015 |
| SC-002 | A conversation persisted with model X reloads with model X selected after plugin reload. | FR-001, FR-003, FR-013, FR-014 |
| SC-003 | Setting the global default to Y in Settings, then creating a new conversation, results in the new conversation being created with Y bound and persisted. Changing the default to Z thereafter does not change the prior conversation's bound model. | FR-007, FR-008, FR-009 |
| SC-004 | A persisted conversation with an unavailable model id surfaces the inline error AND blocks send AND unblocks once the user picks an available replacement. | FR-010, FR-011 |
| SC-005 | The picker shows only chat-capable models when the SDK's model metadata distinguishes them; ambiguous metadata models still appear. | FR-012 |
| SC-006 | All v0.3 baseline behaviors remain green (see NFR-005 enumeration). | NFR-005 |
| SC-007 | A confirmed mid-conversation swap correctly interrupts any in-flight stream, applies the new model binding to the existing session in place, and the next user message is answered by the new model with the prior conversation history preserved end-to-end. | FR-004, FR-005, FR-006 |
| SC-008 | If the onload model-list fetch fails, the user sees a retry affordance and a blocked-send state; a successful retry restores the picker without reload. The empty-list and failure cases are visually distinguishable. | FR-016, FR-018 |

## Edge Cases

- **Identity swap**: Re-selecting the currently-bound model in the picker is a no-op — no confirmation dialog, no session reset. (FR-004)
- **Empty transcript swap**: Swapping in a conversation with no assistant turns yet is immediate, no confirmation dialog. (FR-004 acceptance #5)
- **Cancel during stream**: Cancelling the confirmation dialog while a turn is streaming leaves the streaming turn untouched; only confirmation triggers interruption. (FR-006)
- **Global default unavailable at conversation creation**: Falls back to onload heuristic per FR-007; a Notice in Settings surfaces the situation. The conversation is created with the heuristically-resolved id (not with the broken default id).
- **Migrated v0.3 conversation lazy-resolves to currently-unavailable default**: When a `null` `modelId` is encountered and the global default is also unavailable, the onload heuristic resolves the id; if THAT id is also unavailable (degenerate SDK state), FR-010's inline error fires.
- **Undo journal interaction**: The Undo journal restores conversation TRANSCRIPT state only. A model swap that occurred between snapshot and undo is NOT reverted by Undo — the conversation's currently-bound model persists across undo operations. The Undo UI MAY note this if it is otherwise confusing.
- **Model-list fetch failure vs empty-list**: Failure (FR-018) and empty (FR-016) are distinct states with distinct UX: failure shows a retry affordance, empty shows "No chat models available" with no retry.
- **Swap during pending approval**: If the conversation has an outstanding approval prompt when the user confirms a swap, the approval is cancelled before the in-place model swap is invoked. The user is informed via the confirmation dialog copy when pending approvals exist.

## Assumptions

- The Copilot SDK exposes a way to list available models with capability metadata. CodeResearch confirmed `CopilotClient.listModels()` returns a `ModelInfo[]`. Capability metadata (chat vs embedding vs image) is not explicit in the public type, so FR-012's fail-open clause governs filtering.
- The SDK supports binding a session to a specified model id at session-creation time (v0.3 already relies on this for the heuristically-picked model). CodeResearch confirmed this via `SessionConfig.model`.
- The SDK supports in-place model swap on an existing session with history preserved. CodeResearch confirmed this via `CopilotSession.setModel(model, options)` documented as "applies to next message, conversation history preserved." This is the mechanism FR-005 depends on. If a future SDK version removes this capability, FR-005 would need re-specification (no current risk).
- Per-conversation metadata persistence already supports adding new optional fields without breaking sibling-key preservation (v0.3 established this property).
- Settings persistence already supports adding new fields; the global default field can live in the existing settings store or a sibling store as a planning decision.
- The chat-capable set is "models the SDK metadata identifies as chat / completion capable." Exact classifier rules are a CodeResearch deliverable but the spec contract is "filter to what users can productively chat with, fail-open on ambiguity."

## Scope

### In Scope

- Per-conversation `modelId` field in the persisted conversation shape, with eager resolution at creation and lazy resolution on first use for migrated v0.3 conversations.
- Chat-header picker dropdown listing SDK chat-capable models, including the "(unavailable)" suffix path.
- Settings field for global default model with "Auto (heuristic)" option.
- Confirmation dialog before mid-conversation swap with prior session context.
- In-place SDK model swap on the existing session (history preserved) when the user confirms a mid-conversation change.
- Inline-error / send-blocking flow when the persisted model is unavailable.
- Retry affordance / send-blocking flow when the onload model-list fetch fails.
- Migration-safe load of existing v0.3 conversations (treat missing field as unresolved).

### Out of Scope (deferred)

- MCP integration.
- Extra-vault FS roots.
- Mid-session reload of non-model settings (raw-FS gating still applies on next session start per v0.3).
- Curated model allowlist in settings (this workflow shows ALL chat-capable models from the SDK; allowlist would be a follow-up).
- Per-tool model selection (e.g. "use cheaper model for tool-call summaries").
- Manual "refresh models" affordance independent of the FR-018 retry path (worth noting but deferred unless CodeResearch surfaces an obvious need).
- Tag rename / tag create capability surface.
- Conversation export/import.
- Snapshot compression for large undo payloads.
- "Show archived" / "Restore archived" picker gestures and the command-palette switch-by-name entry.

## Risks

| Risk | Mitigation |
|------|------------|
| SDK does not expose a clean "list available models with capability" API. | CodeResearch confirmed `listModels()` exists but capability metadata is not explicit. Mitigation: FR-012 fail-open. A hardcoded chat-family allowlist (gpt-*, claude-*, gemini-*) is the planning fallback if observed model lists contain too many non-chat surprises. |
| In-place SDK model swap behaves unexpectedly under load (e.g., partial application, race with in-flight tool calls). | FR-006 interrupts streaming turns before swap takes effect. Tests must cover swap-during-stream and swap-during-pending-approval paths. |
| Session reset on conversation creation under a different default is expensive and surprises users (cold-start latency). | One-time at conversation creation only; documented as expected. Future enhancement: warm a session in the background. Out of scope for v0.4. |
| Recovery flow (FR-010, FR-011) blocks user from a conversation whose model id changed casing or got renamed upstream. | Recovery is permissive: the picker presents the unavailable id at the top of the list, the inline error explains the situation, and one click resumes use. We do not auto-pick because that would silently drop the user's prior choice. |
| Picker UI competes for header real estate with the conversation picker (v0.3) and status indicator. | Placement is a planning decision. Spec contract is "picker reflects and controls the active conversation's bound model and is keyboard-accessible." |
| Swap during a pending-approval prompt could orphan the approval. | Confirmation dialog surfaces stronger warning copy when pending approvals exist. Implementation cancels approvals before invoking the in-place model swap. |
| Cached model list goes stale if user's Copilot entitlements change mid-session. | Acknowledged limitation. FR-018's retry affordance plus plugin reload cover the recovery paths. A dedicated "refresh models" affordance is deferred. |

## Traceability

| User Story | FRs | SCs |
|------------|-----|-----|
| In-chat model picker | FR-002, FR-003, FR-005, FR-012, FR-015, FR-017 | SC-001, SC-005 |
| Persistence across reloads | FR-001, FR-013, FR-014 | SC-002 |
| Mid-conversation swap with confirmation | FR-004, FR-005, FR-006 | SC-001, SC-007 |
| Global default in Settings | FR-007, FR-008, FR-009 | SC-003 |
| Recovery when persisted model is unavailable | FR-010, FR-011, FR-016, FR-018 | SC-004, SC-008 |
| Filter picker to chat-capable models | FR-012 | SC-005 |
| (Cross-cutting baseline preservation) | NFR-005 | SC-006 |
| (Cross-cutting model-list availability) | FR-016, FR-018, NFR-001 | SC-008 |
