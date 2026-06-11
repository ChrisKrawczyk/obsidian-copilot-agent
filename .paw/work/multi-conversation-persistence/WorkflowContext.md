# WorkflowContext

Work Title: Multi-Conversation & Persistence
Work ID: multi-conversation-persistence
Base Branch: main
Target Branch: feature/multi-conversation-persistence
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
Initial Prompt: v0.3 of the obsidian-copilot-agent plugin (follow-up to v0.2 PR #2, squash-merged as 0f9222a). Bundles three deferred v0.2 phase candidates plus two items previously carved out of v0.2 scope:

1. **Hide v0.1 raw-FS tools behind an opt-in advanced setting**: After v0.2 dogfooding, the new vault-aware tools cover the realistic workflows. The v0.1 raw-filesystem tools (`view`, `read_file`, `search_content`, `create_file`, `edit_file`, `delete_file`) should be gated behind an opt-in "Advanced: expose raw filesystem tools" setting (default OFF) so the model stops reaching for them as a shortcut over the dedicated vault tools. Existing users who rely on them must be able to re-enable.

2. **Per-vault Daily Notes target override**: Independent of Obsidian's core Daily Notes plugin, allow users to specify a custom path/template for `create_daily_note` in plugin settings. Falls back to the core plugin's config (current behavior) when override is empty.

3. **Richer vault search tools** (3 new tools, all read-only, FR-017 auto-approved):
   - `search_by_tag(tag: string)` — list notes tagged with a given tag (via `metadataCache.getTags()` + `getFileCache().tags`)
   - `search_by_name(query: string)` — fuzzy match against note basenames (via `app.vault.getMarkdownFiles()`)
   - `list_all_tags()` — enumerate every tag in the vault (via `metadataCache.getTags()`)
   v0.1's `search_content` already handles full-text substring search.

4. **Multi-conversation support**: Today the chat panel holds a single in-memory `CopilotAgentSession`. Add the ability to maintain multiple named conversations (create / switch / rename / delete), with each one keeping its own message history, undo journal, and pending-approval state. Persistent across plugin reloads (writes to a plugin-data store, not user vault). Includes UI affordances (conversation list / picker) and reasonable limits (max conversations, max messages per conversation before pruning).

5. **Cross-restart Undo**: The v0.2 UndoJournal resets on plugin reload. Persist the journal (or a sufficient subset — last N undoable operations per conversation) so that a user who undoes a tool call after restarting Obsidian still gets correct restoration. Define a clear retention policy (e.g., keep last 50 entries per conversation, drop after 7 days). Honor existing UndoJournal API; storage backend is the only new concern.

Constraints carried from v0.2:
- All new tools route through the existing universal permission gate (deny-by-default; read-only auto-approve only when FR-017 / FR-022 checklist is satisfied).
- Maintain 410/410 baseline test coverage; add tests for new tools, conversation manager, and persistence layer.
- No regression to streaming, Stop control, approval-prompt flow, token rotation, or the 13 vault tools shipped in v0.2.
- README + Docs.md updated as items ship.

Out of scope (deferred to a future workflow):
- MCP integration
- Extra-vault FS roots
- Model picker UI
- Mid-session settings reload (settings still apply on next session start)
- Tag-rename / tag-create capability surface
- SDK changes (transport preamble continues via first-message prepending in `CopilotAgentSession`)
Issue URL: none
Remote: origin
Artifact Lifecycle: commit-and-persist
Artifact Paths: auto-derived
Additional Inputs: none
