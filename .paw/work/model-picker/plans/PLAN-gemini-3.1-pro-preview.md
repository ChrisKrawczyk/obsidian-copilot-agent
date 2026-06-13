# Model Picker v0.4 Implementation Plan

## Overview
Implement a per-conversation model picker in the chat header, allowing users to swap models mid-conversation (with confirmation), persist the selection per conversation, and configure a global default.

## Current State Analysis
- Model selection is static at plugin onload via a heuristic (`src/sdk/AgentSession.ts` lines 1017-1052).
- Single model is used for all conversations.
- `CopilotSession.setModel()` is available in SDK for in-place swapping (preserves history).
- `listModels()` returns `ModelInfo[]`.
- `PersistedShape.ts` defines conversation state, without model selection.

## Desired End State
Each conversation independently tracks and persists its `modelId`. The `ChatView.ts` header exposes a model picker. Swapping mid-conversation uses `setModel()` and prompts for confirmation if history exists. Unavailable models trigger an inline error and block the send button. Settings allow a global default.

## What We're NOT Doing
- MCP integration
- Extra-vault FS roots
- Curated model allowlist (using SDK capabilities instead)
- Manual "refresh models" independent of retry path

## Phase Status
- [ ] **Phase 1: Persistence & Settings** - Update conversation shape and global settings for default model.
- [ ] **Phase 2: SDK Model Management** - Fetch, filter, and cache models; implement in-place swap.
- [ ] **Phase 3: Model Picker UI** - Implement chat header picker, confirmation dialog, and swap handling.
- [ ] **Phase 4: Error States & Blocking** - Handle unavailable models and fetch failures with inline errors.
- [ ] **Phase 5: Documentation** - Document new model picker architecture.

## Phase Candidates
- [ ] Phase 1: Persistence & Settings
- [ ] Phase 2: SDK Model Management
- [ ] Phase 3: Model Picker UI
- [ ] Phase 4: Error States & Blocking
- [ ] Phase 5: Documentation

## Ordering Rationale
Phase 1 builds the foundational data structures. Phase 2 implements the business logic to fetch models and perform the swap. Phase 3 connects the UI to the data and logic. Phase 4 layers on the error states and edge cases once the happy path UI works. Phase 5 documents the final state.

---

## Phase 1: Persistence & Settings

### Changes Required:
- **`src/persistence/PersistedShape.ts`**: Add optional `modelId?: string` to conversation shape.
- **`src/persistence/migrate.ts`**: Ensure missing `modelId` is lazy-resolved on first use (FR-013).
- **`src/settings/SafetySettingsStore.ts`** (or main settings store): Add `globalDefaultModelId` property.
- **`src/ui/SettingsTab.ts`**: Add "Default model for new conversations" setting (FR-008).

### Success Criteria:

#### Automated Verification:
- [ ] Tests pass: `npm run test`
- [ ] Lint/typecheck: `npm run lint`

#### Manual Verification:
- [ ] Settings can be changed and persist across plugin reloads.
- [ ] Existing conversations load correctly with an unresolved model ID.

### Per-Phase Risks:
- Migration logic might inadvertently affect sibling keys. Mitigation: tests to ensure v0.3 sibling keys are preserved.

---

## Phase 2: SDK Model Management

### Changes Required:
- **`src/sdk/AgentSession.ts`**:
  - Fetch available models via `listModels()` and cache them.
  - Filter `ModelInfo[]` for chat-capable models, failing open (FR-012).
  - Expose `swapModel(modelId)` which uses `CopilotSession.setModel()` (FR-005).
  - Interrupt streaming turns when `swapModel` is invoked (FR-006).
- **`src/main.ts`**: Apply global default or onload heuristic upon conversation creation (FR-007).

### Success Criteria:

#### Automated Verification:
- [ ] Tests pass: `npm run test`
- [ ] Lint/typecheck: `npm run lint`

#### Manual Verification:
- [ ] Model fetch caching works correctly.
- [ ] In-place SDK swap changes the bound model successfully.

### Per-Phase Risks:
- SDK swap might conflict with in-flight tool calls. Mitigation: ensure stream is correctly interrupted.

---

## Phase 3: Model Picker UI

### Changes Required:
- **`src/ui/ChatView.ts`**:
  - Render model picker in the header bound to the active conversation's `modelId` (FR-002, FR-015).
  - Prompt with confirmation dialog if user swaps model and conversation history > 0 (FR-004).
  - Call `swapModel` and update persistence if confirmed (FR-003, FR-005).
  - Implement keyboard accessibility for the picker (FR-017).

### Success Criteria:

#### Automated Verification:
- [ ] Tests pass: `npm run test`
- [ ] Lint/typecheck: `npm run lint`

#### Manual Verification:
- [ ] Changing model mid-conversation shows confirmation dialog; next message uses new model.
- [ ] Empty conversation model swap happens immediately.
- [ ] Keyboard navigation works.

### Per-Phase Risks:
- UI placement might conflict with existing v0.3 status indicators. Mitigation: carefully integrate with existing header.

---

## Phase 4: Error States & Blocking

### Changes Required:
- **`src/ui/ChatView.ts`**:
  - Render "(unavailable)" and an inline error if persisted `modelId` is not in the cached model list (FR-010).
  - Block send button while model is unavailable (FR-011).
  - If onload fetch fails, show retry affordance and block send (FR-018).
  - Handle empty available models list gracefully (FR-016).

### Success Criteria:

#### Automated Verification:
- [ ] Tests pass: `npm run test`
- [ ] Lint/typecheck: `npm run lint`

#### Manual Verification:
- [ ] Simulating an unavailable model blocks send and displays the inline error.
- [ ] Selecting a valid model clears the error and unblocks send.

### Per-Phase Risks:
- Recovery flow might confuse users if model IDs change upstream. Mitigation: clear inline error with instructions to repick.

---

## Phase 5: Documentation

### Changes Required:
- **`.paw/work/model-picker/Docs.md`**: Technical reference for model picker.

### Success Criteria:
- [ ] Docs build cleanly.
- [ ] Content accurate, style consistent.

---

## FR/NFR/SC Coverage Matrix

| Phase | Covers FRs | Covers NFRs | Covers SCs |
|-------|------------|-------------|------------|
| 1 | FR-001, FR-007, FR-008, FR-009, FR-013, FR-014 | NFR-003 | SC-002, SC-003 |
| 2 | FR-005, FR-006, FR-012 | NFR-001, NFR-004 | SC-005, SC-007 |
| 3 | FR-002, FR-003, FR-004, FR-015, FR-017 | NFR-002, NFR-005 | SC-001, SC-006 |
| 4 | FR-010, FR-011, FR-016, FR-018 | NFR-005 | SC-004, SC-008 |

---

## References
- Issue: none
- Spec: `.paw/work/model-picker/Spec.md`
- Research: `.paw/work/model-picker/CodeResearch.md`