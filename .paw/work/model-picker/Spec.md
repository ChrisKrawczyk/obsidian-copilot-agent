# Spec: Per-Conversation Model Picker (v0.4)

> Follow-up to v0.3 multi-conversation persistence (PR #3, squash-merged as 7d15d7f). v0.4 surfaces per-conversation model selection in the chat header, persists the selected model alongside conversation metadata, and adds a configurable global default in Settings. Mid-conversation swaps are supported with explicit user confirmation because they reset SDK session context.

## Problem Statement

Users on GitHub Copilot Enterprise have access to many chat models (GPT family, Claude family, Gemini family, etc.). The plugin today picks one model at plugin onload via the `pickModel()` heuristic and uses it for every conversation, with no in-app affordance to change it. Users cannot:

1. Compare answers across models on the same prompt.
2. Use a fast cheap model (e.g. `gpt-4o`) for routine questions and a stronger model (e.g. `claude-opus-4.7`) for hard reasoning, switching as needed.
3. Tell which model produced an existing conversation when reviewing scrollback.
4. Recover gracefully when their preferred model is unavailable — today the heuristic silently picks something else.

Goal: each conversation owns its model id, the user picks via the chat-header picker, the choice persists across reloads, and the system handles the "model went away" case with a clear in-chat affordance to re-pick.

## User Stories

### P1 — In-chat model picker

**As an** Obsidian user with multiple Copilot models available,
**I want** to pick the model for the active conversation from a dropdown in the chat header,
**so that** I can route routine questions to a fast model and hard problems to a stronger one without leaving the chat.

**Acceptance Scenarios:**

1. **Given** I'm in a conversation using the default model, **When** I open the model dropdown in the chat header and select a different model, **Then** the dropdown updates to show the new selection AND the next message I send uses that model.
2. **Given** I select a different model mid-conversation, **When** the swap is confirmed, **Then** the conversation transcript stays intact (visible scrollback unchanged) AND the next assistant turn comes from the newly selected model.
3. **Given** I create a new conversation while the current one is on `claude-opus-4.7`, **When** the new conversation is created, **Then** it uses the configured global-default model (NOT inheriting from the prior conversation).

**Independent Test**: With at least two chat-capable models available, send one message under model A, swap to model B, send another, and verify the second response originated from B (assertable via the model id surfaced in the chat status pill / picker label).

### P1 — Persistence across reloads

**As an** Obsidian user who configures one conversation per project,
**I want** each conversation to remember its model across plugin reloads and Obsidian restarts,
**so that** my "Claude for spec drafting" and "GPT for refactors" workflow stays consistent without re-picking every time.

**Acceptance Scenarios:**

1. **Given** I've assigned `claude-opus-4.7` to a conversation, **When** I reload the plugin, **Then** that conversation re-opens still bound to `claude-opus-4.7`.
2. **Given** I have ten conversations on five different models, **When** I switch between them via the picker, **Then** each one shows its own persisted model.

**Independent Test**: Persist three conversations with three different model ids. Reload. Verify each reads back the correct id.

### P1 — Mid-conversation swap with confirmation

**As an** Obsidian user mid-way through a conversation,
**I want** a confirmation dialog when I switch models so I understand SDK session context will reset,
**so that** I'm not surprised when the new model "doesn't remember" something the old one knew implicitly.

**Acceptance Scenarios:**

1. **Given** I have an in-flight conversation with several turns, **When** I select a different model from the picker, **Then** a confirmation dialog explains "Switching models will reset session context — the new model will see the persisted transcript but lose any in-flight turn state. Continue?"
2. **Given** the confirmation dialog appears, **When** I cancel, **Then** the picker reverts to the previous selection AND no SDK session reset occurs.
3. **Given** I confirm the swap, **When** the next message is sent, **Then** the SDK session is recreated with the new model AND the persisted transcript is sent as the start of the new session (so the new model has the conversation history as context).
4. **Given** a swap is confirmed mid-stream (a turn is currently streaming), **Then** the in-flight turn is interrupted, the placeholder is finalized as `interrupted`, and the swap takes effect for the next user message.

**Independent Test**: Start a turn, select a different model, observe the confirmation dialog. Cancel — picker reverts. Reselect, confirm — verify the next response comes from the new model and the prior transcript is in the SDK session's input.

### P2 — Global default model in Settings

**As an** Obsidian user with a clear "favorite" model,
**I want** a Settings field for the default model used by new conversations,
**so that** every fresh conversation starts on my preferred model without per-creation picking.

**Acceptance Scenarios:**

1. **Given** the Settings field is set to `claude-opus-4.7`, **When** I create a new conversation, **Then** it starts on `claude-opus-4.7`.
2. **Given** the Settings field is unset / set to "Auto", **When** I create a new conversation, **Then** the existing `pickModel()` heuristic resolves the model (gpt-4.1 → gpt-4o → first GPT family → first available).
3. **Given** the Settings default changes from `gpt-4.1` to `claude-opus-4.7`, **When** I view existing conversations, **Then** their per-conversation models are unchanged (the default applies prospectively to NEW conversations only).

**Independent Test**: Set the default to model X. Create a conversation. Verify it uses X. Change the default to Y. Open the existing conversation — still on X. Create a new one — uses Y.

### P2 — Recovery when persisted model is unavailable

**As an** Obsidian user whose Copilot access changed since last session,
**I want** a clear in-chat error when a persisted model id is no longer available,
**so that** I know to pick a replacement instead of getting confusing failures from the SDK.

**Acceptance Scenarios:**

1. **Given** a persisted conversation references model id `gpt-deprecated-1`, **When** I open that conversation and the SDK's available-models list does NOT include `gpt-deprecated-1`, **Then** the picker shows the missing model id with a "(unavailable)" suffix AND an inline error message appears in chat: "Model `gpt-deprecated-1` is no longer available. Pick a model to continue."
2. **Given** the inline error is showing, **When** I pick a replacement from the dropdown, **Then** the error clears AND the conversation can resume normally.
3. **Given** a fresh plugin load with a persisted model id that's unavailable, **When** I attempt to send a message before re-picking, **Then** the send is blocked with the same inline error AND the picker is highlighted.

**Independent Test**: Persist a conversation with an arbitrary fake model id. Reload. Verify the inline error renders, the send button blocks, and re-picking unblocks send.

### P3 — Filter picker to chat-capable models

**As an** Obsidian user who shouldn't have to know which models are embedding-only or image-only,
**I want** the picker to show only chat/completion-capable models,
**so that** I can't accidentally pick a model that fails on first send.

**Acceptance Scenarios:**

1. **Given** the SDK exposes embedding and image models alongside chat models, **When** I open the picker, **Then** only chat-capable models appear.
2. **Given** the SDK metadata is ambiguous about a model's capabilities, **When** I open the picker, **Then** that model appears (failing closed → pickable; the SDK will surface a usage error if the user chooses badly, which is preferable to hiding a usable model).

**Independent Test**: Stub the SDK's model list with one embedding model and one chat model. Open the picker. Verify only the chat model is shown.

## Functional Requirements

| ID | Requirement |
|------|-------------|
| FR-001 | Each conversation MUST own a `modelId: string \| null` field in its persisted shape. `null` means "use the global default." |
| FR-002 | The chat header MUST include a model picker dropdown that reflects the active conversation's model id. |
| FR-003 | Selecting a model in the picker MUST update the active conversation's `modelId` in memory and persist via the existing debounced flush path. |
| FR-004 | Mid-conversation model swaps MUST require explicit user confirmation via a modal dialog before the SDK session is reset. |
| FR-005 | A model swap MUST be applied at the next `sendMessage` boundary: the existing SDK session is disposed, a new one is created with the new model id, the persisted transcript is replayed as initial context, and only then is the user's next message sent. |
| FR-006 | If a swap is confirmed while a turn is streaming, the in-flight turn MUST be interrupted (placeholder → `interrupted` status) before the swap takes effect. |
| FR-007 | A new conversation MUST inherit its initial `modelId` from the configured global default (Settings) if set, or from the existing `pickModel()` heuristic if unset. |
| FR-008 | Settings MUST expose a "Default model for new conversations" dropdown. The dropdown lists chat-capable models from the SDK, plus an "Auto (heuristic)" option. |
| FR-009 | Changing the global default MUST NOT mutate any existing conversation's `modelId`. |
| FR-010 | On plugin load, if a conversation's persisted `modelId` is not in the SDK's current available-models list, the picker MUST surface that id with a "(unavailable)" suffix AND the chat MUST render an inline error: "Model `<id>` is no longer available. Pick a model to continue." |
| FR-011 | While the inline error is active, `sendMessage` MUST be blocked with the same inline guidance until the user picks an available model. |
| FR-012 | The picker MUST filter the SDK's model list to chat/completion-capable models. Models with ambiguous capability metadata pass through (fail-open). |
| FR-013 | Persistence MUST be migration-safe: existing v0.3 conversations missing `modelId` MUST treat the field as `null` (i.e. fall back to global default at use time, not write-time). |
| FR-014 | Migration MUST NOT break v0.3 sibling-key preservation. The `modelId` field is a per-conversation property, not a top-level one; `auth` / `safety` / `settings` keys remain unaffected. |
| FR-015 | The model id displayed in the existing status pill MUST stay in sync with the picker selection (they're the same concept, surfaced in two places — picker = control, pill = status). The visual implementation MAY merge them into one element. |
| FR-016 | The picker MUST handle the empty state: if the SDK exposes zero chat-capable models, the picker is disabled with text "No chat models available" AND `sendMessage` is blocked. |
| FR-017 | The picker MUST be keyboard-accessible (open with Enter / Space, navigate with arrow keys, select with Enter, dismiss with Escape) consistent with v0.3 chat keybinding ergonomics. |

## Non-Functional Requirements

| ID | Requirement |
|------|-------------|
| NFR-001 | Opening the picker MUST render synchronously from a cached model list (no SDK round-trip on click). The model list is fetched at plugin onload and cached. |
| NFR-002 | Switching the active conversation MUST update the picker selection within one render frame (≤ 16 ms) — same budget as the existing v0.3 picker swap. |
| NFR-003 | Picker rendering and persistence MUST not regress the 611 baseline test count from v0.3; new tests are additive. |
| NFR-004 | The model swap path MUST NOT leak SDK sessions: every swap disposes the prior `CopilotAgentSession` before constructing the replacement (verifiable via the existing `liveRuntimes` set in `main.ts`). |

## Success Criteria

| ID | Criteria |
|------|----------|
| SC-001 | A user can pick any of the currently-available chat models from the chat header picker, confirm the swap, send a message, and observe a response demonstrably from the chosen model (model id reflected in status pill / picker label). |
| SC-002 | A conversation persisted with model X reloads with model X selected after plugin reload. |
| SC-003 | Setting the global default to Y in Settings, creating a new conversation, and observing the new conversation starts on Y. |
| SC-004 | A persisted conversation with an unavailable model id surfaces the inline error AND blocks send AND unblocks once the user picks an available replacement. |
| SC-005 | The picker shows only chat-capable models when the SDK's model metadata distinguishes them. |
| SC-006 | All v0.3 baseline behaviors remain green: streaming, Stop control, approval prompts, token rotation, multi-conversation soft-cap / archive, Undo journal (cross-restart + content-divergence), raw-FS gating, vault-aware preamble. |
| SC-007 | Mid-conversation swap correctly interrupts in-flight streams, and the new model receives the persisted transcript as context for its first reply. |

## Assumptions

- The Copilot SDK exposes a way to list available models with capability metadata (chat / completion / embedding / image). Specific API shape will be confirmed in CodeResearch — if metadata is missing, FR-012's fail-open clause covers the ambiguity.
- The SDK's `client.createSession({ model, ... })` accepts any model id from the listing, and binds the session to that model for its lifetime. (This is the v0.3 pattern in `src/sdk/AgentSession.ts`.)
- Replaying the persisted transcript as initial context for a new SDK session is achievable by sending it as the first message body or using whatever the SDK's "seed history" affordance is. CodeResearch will determine the exact mechanism (likely either an explicit `messages` parameter on `createSession` or a structured first-prompt). If neither is available, the swap path MAY accept that the new model starts with no transcript context and surfaces this clearly to the user as a known limitation.
- The chat-capable set is "models with `family` in {gpt, claude, gemini, ...} AND `kind` in {chat, completion}" — final classifier deferred to CodeResearch but the spec's contract is "filter to what users can productively chat with."
- Settings persistence already works via the existing `SafetySettingsStore` / generic plugin data store; v0.4 adds a sibling field there or in a parallel store. Final placement is a planning decision.

## Scope

### In Scope

- Per-conversation `modelId` field in the persisted conversation shape, with `null` semantics for "use default."
- Chat-header picker dropdown listing SDK chat-capable models, including the "(unavailable)" suffix path.
- Settings field for global default model with "Auto (heuristic)" option.
- Confirmation dialog before mid-conversation swap.
- SDK session reset on swap, with persisted-transcript seeding for the new session if SDK supports it.
- Inline-error / send-blocking flow when the persisted model is unavailable.
- Migration-safe load of existing v0.3 conversations (treat missing field as `null`).

### Out of Scope (deferred)

- MCP integration.
- Extra-vault FS roots.
- Mid-session settings reload for non-model settings (raw-FS gating still applies on next session start per FR-015 of v0.3).
- Curated model allowlist in settings (this workflow shows ALL chat-capable models from the SDK; allowlist would be a follow-up).
- Per-tool model selection (i.e. "use cheaper model for tool-call summaries").
- Tag rename / tag create capability surface.
- Conversation export/import.
- Snapshot compression for large undo payloads.
- "Show archived" / "Restore archived" picker gestures and the command-palette switch-by-name entry.

## Risks

| Risk | Mitigation |
|------|------------|
| SDK does not expose a clean "list available models with capability" API | Fall back to a hardcoded chat-family allowlist (gpt-*, claude-*, gemini-*) at build time. Document the limitation. CodeResearch must confirm SDK shape before planning. |
| SDK session reset on swap is expensive (model latency + reauth) and surprises users mid-task | Confirmation dialog (FR-004) sets expectation. Future enhancement: warm a parallel session in the background once a swap is confirmed but before the next user send. Out of scope for v0.4. |
| Persisted transcript replay as initial context exceeds SDK input-token limits for large conversations | Add a soft trim that takes the last N turns; surface a Notice when trimming. CodeResearch will determine SDK input limits. Initial implementation: send full transcript and let the SDK error if oversized; iterate if observed in practice. |
| Recovery flow (FR-010, FR-011) blocks user from a conversation whose model id changed casing or got renamed by Copilot | Recovery is permissive: if the picker is open with the unavailable id at the top + the inline error, one click resumes use. We do not auto-pick because that would silently drop the user's prior choice. |
| Picker UI competes for header real estate with the conversation picker (v0.3) | Place the model picker on the same row as the existing status pill (which it semantically replaces or augments). Final layout in CodeResearch. |
| Swap during a pending-approval prompt could orphan the approval | Confirmation dialog: if any approval prompts are pending in the conversation, surface a stronger warning ("This will cancel pending approvals."). Implementation: cancel approvals before disposing the session. |

## Traceability

| User Story | FRs | SCs |
|------------|-----|-----|
| In-chat model picker | FR-002, FR-003, FR-005, FR-012, FR-015, FR-017 | SC-001, SC-005 |
| Persistence across reloads | FR-001, FR-013, FR-014 | SC-002 |
| Mid-conversation swap with confirmation | FR-004, FR-005, FR-006, NFR-004 | SC-001, SC-007 |
| Global default in Settings | FR-007, FR-008, FR-009 | SC-003 |
| Recovery when persisted model is unavailable | FR-010, FR-011, FR-016 | SC-004 |
| Filter picker to chat-capable models | FR-012 | SC-005 |
| (Cross-cutting baseline preservation) | — | SC-006 |
