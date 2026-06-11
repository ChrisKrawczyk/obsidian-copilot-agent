# WorkflowContext

Work Title: Per-Conversation Model Picker
Work ID: model-picker
Base Branch: main
Target Branch: feature/model-picker
Execution Mode: current-checkout
Repository Identity: none
Execution Binding: none
Workflow Mode: full
Review Strategy: local
Review Policy: milestones
Session Policy: continuous
Final Agent Review: enabled
Final Review Mode: multi-model
Final Review Interactive: smart
Final Review Models: gpt-5.4, gemini-3.1-pro-preview, claude-opus-4.7
Final Review Specialists: all
Final Review Interaction Mode: parallel
Final Review Specialist Models: none
Final Review Perspectives: auto
Final Review Perspective Cap: 2
Implementation Model: none
Plan Generation Mode: multi-model
Plan Generation Models: gpt-5.4, gemini-3.1-pro-preview, claude-opus-4.7
Planning Docs Review: enabled
Planning Review Mode: multi-model
Planning Review Interactive: smart
Planning Review Models: gpt-5.4, gemini-3.1-pro-preview, claude-opus-4.7
Planning Review Specialists: all
Planning Review Interaction Mode: parallel
Planning Review Specialist Models: none
Planning Review Perspectives: auto
Planning Review Perspective Cap: 2
Custom Workflow Instructions: none
Initial Prompt: v0.4 of the obsidian-copilot-agent plugin (follow-up to v0.3 PR #3, squash-merged as 7d15d7f). Adds a per-conversation model picker.

**Goals:**

1. **Per-conversation model selection.** Each conversation remembers its own model id. New conversations default to the existing pickModel() heuristic (gpt-4.1 / gpt-4o fallback). Switching conversations switches the active model along with the runtime.

2. **In-chat picker UI.** A dropdown in the chat header (alongside or replacing the current model status pill) lists every model the SDK exposes. The user picks one; the conversation's model id is updated and persisted.

3. **Mid-conversation model swap behavior — "apply on next message in the same conversation."** The user wants the simplest UX: swap the model and the next user send uses it. Implementation note: this likely requires resetConversation() under the hood (the SDK session is bound at createSession() time to a single model). Treat the conversation message history as the source of truth and replay it implicitly via the persisted shape — the SDK side loses in-memory accumulation, but the persisted/rendered transcript is preserved. If the SDK offers an in-place model swap that does not reset session state, prefer that.

4. **Persistence.** The selected model id is part of the per-conversation persisted shape (alongside name, createdAt, lastActiveAt, etc.). Surviving plugin reloads is required.

**Constraints carried from v0.3:**

- All new tools / behaviors route through the existing universal permission gate.
- Maintain 611/611 baseline test coverage; add tests for model selection, persistence, and the runtime swap path.
- No regression to streaming, Stop control, approval-prompt flow, token rotation, the v0.3 multi-conversation soft-cap / archive flow, the Undo journal (cross-restart + content divergence), the raw-FS gating, or the vault-aware preamble.
- README + Docs.md updated as items ship.

**Out of scope (deferred to a future workflow):**

- MCP integration.
- Extra-vault FS roots.
- Mid-session settings reload for non-model settings (raw-FS gating still applies on next session start per FR-015).
- Model allowlist / curation in settings (this workflow surfaces every SDK-available model).
- Tag rename / tag create capability surface.
- Conversation export/import.
- Snapshot compression for large undo payloads.
- "Show archived" / "Restore archived" picker gestures and the command-palette switch-by-name entry.

Issue URL: none
Remote: origin
Artifact Lifecycle: commit-and-persist
Artifact Paths: auto-derived
Additional Inputs: none
