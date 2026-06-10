# WorkflowContext

Work Title: Chat UX & Vault-Aware Tools
Work ID: chat-ux-vault-tools
Base Branch: main
Target Branch: feature/chat-ux-vault-tools
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
Plan Generation Mode: single-model
Plan Generation Models: latest Claude Opus
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
Initial Prompt: Workflow A of a v0.2 split. Three focused improvements to the obsidian-copilot-agent plugin shipped in v0.1 (#1, squash-merged):

1. **Chat UX — Enter-to-send (VS Code style)**: Pressing Enter in the chat input sends the message; Shift+Enter inserts a newline. The current "click Send" requirement is disruptive. Behavior should match VS Code's chat panel and Obsidian's broader UX expectations. Include accessibility considerations (IME composition, screen-reader announcement of send).

2. **Vault-aware system prompt**: Today the model has to run shell tool calls to discover the vault root path, list contents, etc. before it can create/edit a note — making "create a new note" require multiple approval prompts. Inject a system prompt at session start that tells the model: the vault root path, top-level vault structure (or recent notes), how to create/edit notes via the registered tools, and that it should prefer the dedicated note tools over `shell`. The prompt should be configurable / overridable in settings.

3. **Obsidian API-backed tools**: Replace or augment the current Node-`fs`-based vault read/write tools with first-class tools that use Obsidian's Vault API (`Vault.create`, `Vault.modify`, `Vault.delete`, `MetadataCache`, `app.workspace.openLinkText`, etc.) for vault-scoped operations. Where Obsidian/community plugins expose richer primitives (e.g., daily-note plugin's `createDailyNote`, periodic notes, templates), expose those as dedicated tools (`create_daily_note`, `open_note`, `insert_into_active_note`, etc.) so the agent can hit those scenarios in a single call instead of composing raw FS writes. Raw-`fs` paths remain only for extra-vault roots (deferred to workflow B).

Constraints carried from v0.1:
- All new tools route through the existing universal permission gate (deny-by-default; read-only exemption only for tools that satisfy the FR-022 checklist).
- Maintain 166/166 baseline test coverage; add tests for new tools and the keybinding handler.
- No regression to streaming, Stop control, approval-prompt flow, or token rotation.
- README's "What is NOT in v0.1" list should be amended as items ship.

Out of scope (workflow B):
- Phases 7-10 (extra-vault FS roots, MCP integration, model selection / cross-restart resume / polish, standalone Docs.md)
- Phase candidates 2, 4, 5, 6, 7, 8 (safeStorage, multi-conversation, cross-restart Undo, --no-tools mode, MCP cred UI, user-authored custom tools)
Issue URL: none
Remote: origin
Artifact Lifecycle: commit-and-persist
Artifact Paths: auto-derived
Additional Inputs: none
