# Feature Specification: Multi-Conversation & Persistence (v0.3)

**Branch**: feature/multi-conversation-persistence  |  **Created**: 2026-06-10  |  **Status**: Draft
**Input Brief**: Add multi-conversation chat support and cross-restart Undo to the obsidian-copilot-agent plugin, plus three deferred v0.2 enhancements (raw-FS tool gating, richer vault search).

## Overview

The v0.2 release of obsidian-copilot-agent gave users a vault-aware Copilot agent that can read, edit, link, and task-manage notes through a curated set of Obsidian-API-backed tools, plus a chat panel with VS Code–style keybindings. Real-world dogfooding surfaced two limits of that release: a chat panel can only hold one in-memory conversation (closing the pane or reloading Obsidian discards the thread), and the Undo journal that lets users reverse tool-driven file edits also resets on plugin reload — so a user who notices a bad edit the next morning has no way to roll it back. Together these gaps push users toward defensive workflows (manual back-ups, screenshotting threads) and undermine confidence in letting the agent operate autonomously.

v0.3 closes both gaps and rolls in three smaller usability wins that were deferred from v0.2 once enough usage had been observed to know they were worth doing. Users will be able to keep multiple named conversations (one per project, topic, or experiment), switch between them via a compact picker at the top of the chat pane, and trust that the conversation they were in when they last closed Obsidian will reopen exactly where they left off. Undoing a tool-driven file change will work the same way it does today within a session — and continue to work after a restart, for any change made within the last seven days. Finally, the model will be steered away from the v0.1 raw-filesystem tools by default (since the dedicated vault tools cover the realistic workflows better), with an opt-in setting for power users, and the agent gains three new auto-approved read-only search tools (`search_by_tag`, `search_by_name`, `list_all_tags`) so it can discover notes by structure instead of grepping content.

The overarching goal is to turn the chat panel from a single-shot scratch surface into a durable workspace, while sharpening the agent's tool kit so it leans on the right primitives. No SDK changes, no new model providers, no MCP, no extra-vault roots — those remain explicitly out of scope.

## Objectives

- Allow users to maintain multiple named conversations and switch between them in a single chat pane (Rationale: enables parallel work streams without losing context — e.g., a "writing" thread and a "task triage" thread).
- Persist the full chat history and per-conversation metadata across plugin reloads and Obsidian restarts (Rationale: removes the largest current source of user-visible data loss).
- Persist a bounded undo journal across plugin reloads so file-mutating tool calls remain reversible after a restart (Rationale: lets users review the agent's work the next day with confidence).
- Reduce the model's reliance on raw-filesystem tools by default, while retaining them as an opt-in advanced capability (Rationale: dedicated vault tools produce better outputs and safer permission scoping).
- Give the agent first-class read-only search-by-structure tools (`search_by_tag`, `search_by_name`, `list_all_tags`) so it can answer "find notes about X" without resorting to substring grep (Rationale: matches how Obsidian users actually organize their vaults).
- Maintain v0.2's invariants: universal permission gate, deny-by-default tool execution, read-only auto-approval gate (FR-017), no streaming/Stop regressions, no token-rotation regressions, 410/410 baseline test coverage.

## User Scenarios & Testing

### User Story P1 – Maintain parallel chat threads

Narrative: A vault owner keeps a long-running "Project Alpha" conversation where they work through writing tasks, and a separate "Daily ops" thread where they ask the agent to triage tasks and summarize daily notes. They switch between the two during the day without one thread polluting the other's context.

Independent Test: Create two conversations, send distinct messages in each, switch between them, and verify each conversation displays only its own message history and that the second conversation cannot see what was discussed in the first.

Acceptance Scenarios:
1. Given the chat pane is open with one default conversation, When the user clicks "New conversation" in the picker, Then a fresh empty conversation opens and the previous conversation is preserved and reachable from the picker.
2. Given the user has two conversations "Project Alpha" and "Daily ops" with different message histories, When the user opens the picker and selects "Project Alpha", Then the message stream displays only Project Alpha's history.
3. Given a conversation is active and the user is mid-stream (model is responding), When the user attempts to switch to a different conversation, Then the active stream is preserved (the in-progress response continues to land in the originating conversation, not the newly selected one) and the user can switch back to see the completed response.
4. Given a conversation has 3 messages, When the user renames the conversation from "Untitled 2026-06-10" to "Roadmap planning", Then the new name appears in the picker and persists across plugin reload.
5. Given a conversation exists, When the user selects "Delete conversation" and confirms, Then the conversation and its message history and undo journal are removed from storage and no longer appear in the picker.

### User Story P2 – Resume after restart

Narrative: A user closes Obsidian at the end of the day mid-conversation. The next morning they reopen Obsidian and expect to find the same conversation open, with the full message history intact and the picker showing the other conversations they had created.

Independent Test: With multiple conversations created and one of them active, fully restart Obsidian and verify the previously active conversation is the one that loads and that all conversations are present in the picker with intact histories.

Acceptance Scenarios:
1. Given the user had three conversations (A, B, C) with B active when Obsidian was closed, When the user reopens Obsidian and the plugin loads, Then conversation B is the active one and conversations A and C are accessible via the picker.
2. Given a conversation contains 50 messages including tool calls and approvals, When the plugin reloads, Then the displayed message history matches what the user saw before the reload (text, role, timestamps, tool-call summaries).
3. Given persisted conversation data on disk is corrupted or schema-incompatible, When the plugin loads, Then the plugin starts with a fresh empty conversation, surfaces a non-blocking notice describing the recovery, and preserves the corrupted data file with a `.bak` suffix for manual inspection.

### User Story P3 – Undo a tool change after a restart

Narrative: A user asks the agent to clean up frontmatter across a handful of notes. They close Obsidian. The next day they notice one of the changes was wrong and want to revert it without manually digging through file history.

Independent Test: Have the agent perform a file-mutating tool call, restart Obsidian, click Undo on the recorded entry, and verify the file content is restored to its pre-tool-call state.

Acceptance Scenarios:
1. Given the agent performed an `edit_note` tool call earlier in the session and Obsidian is restarted within 7 days, When the user clicks the Undo button next to the tool result, Then the file content is restored to its pre-edit state and the tool result is annotated as "Undone".
2. Given a tool call's undo entry is older than 7 days, When the plugin loads, Then that entry is dropped from storage and no Undo button is shown for it.
3. Given a conversation contains 60 undoable tool calls, When the plugin loads, Then only the last 50 retain Undo buttons (older entries are dropped from storage); already-completed tool messages still display, just without the Undo affordance.
4. Given the file targeted by an undo entry has been modified outside the agent (manually or by a different tool call) since the snapshot, When the user clicks Undo, Then the user sees a confirmation prompt explaining the file has changed and must confirm before the restore proceeds.
5. Given an undo restore writes to disk, When the restore completes, Then the undo entry is marked "Undone" persistently (so the same entry cannot be re-applied across a subsequent restart).

### User Story P4 – Default away from raw-FS tools

Narrative: A user (who hasn't touched the v0.1 advanced settings) asks "create a new note titled X". The agent uses the dedicated `create_note` vault tool rather than `create_file`, and never offers the v0.1 raw-FS path unless the user has explicitly opted in.

Independent Test: With the advanced setting OFF and a fresh session, prompt the agent for a sequence of 5 vault operations (create / read / list / search / edit) and verify the model never invokes any of `view`, `read_file`, `search_content`, `create_file`, `edit_file`, `delete_file`. Then enable the advanced setting and re-run the same prompts to verify those tools are available.

Acceptance Scenarios:
1. Given the "Expose v0.1 raw-filesystem tools" setting is OFF (default), When a new chat session starts, Then the tools list registered with the model excludes `view`, `read_file`, `search_content`, `create_file`, `edit_file`, and `delete_file`.
2. Given the setting is OFF, When the user types a prompt that the agent might naively answer with `read_file`, Then the agent uses `read_note` (or another vault tool) and never produces a tool call referencing one of the gated tools.
3. Given the setting is toggled from OFF to ON, When the user starts a new session (or the next session loads), Then the gated tools are present in the tools list and the agent may use them again.
4. Given the setting is OFF, When a previously saved conversation that contains historical references to the gated tools is reopened, Then the displayed history renders correctly (tool name and result still shown) even though those tools cannot be re-invoked in the current session.

### User Story P5 – Discover notes by structure

Narrative: A user asks the agent "show me all notes tagged #project". The agent calls `search_by_tag("project")`, gets a list of matching notes, and presents them to the user without a single approval prompt (since the search tools are read-only and FR-017 auto-approved).

Independent Test: Create three notes with tag `#project` and one without, prompt the agent "list all my notes tagged #project", and verify the agent uses `search_by_tag` and returns exactly the three matching notes without an approval prompt.

Acceptance Scenarios:
1. Given a vault with notes containing tags `#alpha`, `#beta`, `#gamma`, When the user asks "what tags are in my vault", Then the agent calls `list_all_tags` and returns all three tags without an approval prompt.
2. Given three notes are tagged `#meeting`, When the user asks "show me notes tagged #meeting", Then the agent calls `search_by_tag("meeting")` and returns exactly those three notes (their basenames and paths).
3. Given the user types a partial note name "weekly", When the user asks "find notes named weekly", Then the agent calls `search_by_name("weekly")` and returns matching notes (e.g., "Weekly Review.md", "weekly-status.md") ranked by closeness of match.
4. Given a vault with 1000 notes and 30 distinct tags, When `list_all_tags` is invoked, Then it returns all 30 tags within 500 ms (P95) on a typical developer laptop.

### Edge Cases

- Plugin loads on a v0.2 install (no persisted conversation data exists yet): the in-memory state is migrated into a single conversation named after the first user message (or "Untitled" if none), with no message history loss.
- A v0.3 install is rolled back to v0.2: v0.2 ignores the new persisted data; v0.3-written conversations remain on disk untouched and would re-load on a future v0.3 upgrade. Cross-restart Undo entries written by v0.3 are not visible in v0.2.
- The user creates the 21st conversation: the oldest non-active conversation is hidden from the picker (archived), but its data file is retained on disk so that a future "Show archived" gesture (out of scope) could restore it.
- The picker displays a conversation whose data file is unreadable: the conversation appears in the picker as "(corrupted)" and selecting it opens an empty thread with an explanatory notice.
- Two conversations have the same auto-derived name: the second one is suffixed with " (2)", " (3)", etc. on creation.
- The user rapidly clicks "New conversation" multiple times: each click creates a distinct empty conversation; no race conditions or duplicate entries.
- Cross-restart Undo: the file targeted by an entry no longer exists (was deleted manually or by a later tool call): the Undo prompt offers to recreate it from the snapshot, and the user must confirm.
- A vault with zero tags: `list_all_tags` returns an empty array and the agent reports "no tags found" without error.
- A `search_by_name` query with no matches: the tool returns an empty array and the agent reports "no notes found" rather than raising an error.
- A `search_by_tag` invocation where the tag is provided with or without the leading `#`: both forms are accepted and produce identical results.
- The persisted data file (`data.json`) crosses a size threshold (e.g., > 5 MB due to many large undo snapshots): a non-blocking notice warns the user and recommends pruning old conversations; behavior remains correct.

## Requirements

### Functional Requirements

- **FR-001**: A "Conversation" is the unit of chat thread; each conversation has a stable id, a display name, a created timestamp, a last-active timestamp, an ordered list of messages (user, assistant, tool), and a per-conversation undo journal. (Stories: P1, P2, P3)
- **FR-002**: The plugin maintains an ordered set of conversations with a soft cap of 20 active (non-archived) conversations. When a 21st conversation is created, the oldest non-active conversation is marked "archived" and hidden from the picker; archived conversations are retained on disk indefinitely. (Stories: P1)
- **FR-003**: A "Conversation picker" UI element is rendered at the top of the chat pane and shows the current conversation's name, a chevron-style indicator, and on click reveals a list of non-archived conversations plus a "New conversation" entry. (Stories: P1)
- **FR-004**: Users can create a new conversation, switch the active conversation, rename a conversation, and delete a conversation through the picker. (Stories: P1)
- **FR-005**: New conversations are auto-named from the first user message (truncated to ~40 characters, with ellipsis if truncated). Until the first message is sent, the conversation displays as "Untitled YYYY-MM-DD HH:MM". Users may rename a conversation at any time; the rename persists. (Stories: P1)
- **FR-006**: Conversation deletion requires user confirmation. On confirmation, the conversation, its message history, and its undo journal are removed from storage. (Stories: P1)
- **FR-007**: Conversation switching is non-disruptive to in-flight streams: an in-progress assistant response continues to land in the originating conversation regardless of which conversation is currently displayed; pending tool-approval prompts also remain bound to the originating conversation. (Stories: P1)
- **FR-008**: Conversation state — including conversation list, message history per conversation, and per-conversation undo journal entries — is persisted to plugin data storage so it survives plugin reload, Obsidian restart, and OS reboot. Storage uses Obsidian's standard plugin-data API; nothing is written into the user's vault. (Stories: P2, P3)
- **FR-009**: On plugin load, the conversation that was active when the plugin was last unloaded is restored as the active conversation. If that conversation no longer exists (e.g., it was the only one and was deleted), the most recently active remaining conversation is loaded; if none exist, a fresh empty conversation is created. (Stories: P2)
- **FR-010**: If persisted data fails to parse on load (corruption, schema mismatch), the plugin starts with a fresh empty conversation, surfaces a non-blocking Notice describing the recovery, and writes the malformed `conversations` subtree to a sibling backup file named `conversations_recovery.bak.json` (in the same plugin-data directory) before overwriting only the `conversations` key in plugin data with defaults. The shared `data.json` file is NOT renamed, so existing `auth` and `safety` subtrees remain intact. (Stories: P2)
- **FR-011**: The undo journal persists undoable tool-call entries across plugin reloads. Each conversation retains at most the last 50 undo entries (older entries are dropped on save); entries older than 7 days from their creation timestamp are dropped on plugin load. (Stories: P3)
- **FR-012**: When a user clicks Undo on a persisted entry from a previous session, the plugin verifies the target file has not been modified outside the agent since the snapshot was captured. If the file has been modified (or no longer exists), the user sees a confirmation prompt with a brief description of the divergence (file changed / file missing) and must explicitly confirm before the restore proceeds. (Stories: P3)
- **FR-013**: Successful undo operations mark the originating entry as "Undone" in persistent storage so the same entry cannot be re-applied after a subsequent restart. The Undo button is hidden for entries marked "Undone". (Stories: P3)
- **FR-014**: A new plugin setting "Expose v0.1 raw-filesystem tools" (default OFF) gates whether the six v0.1 raw-FS tools (`view`, `read_file`, `search_content`, `create_file`, `edit_file`, `delete_file`) are offered to the model. When OFF, the model is not offered these tools and cannot invoke them. When ON, they are offered with their existing v0.1 behavior and approval policy. (Stories: P4)
- **FR-015**: Toggling the "Expose v0.1 raw-filesystem tools" setting takes effect on the next session start (consistent with v0.2's "no mid-session settings reload" rule). The settings UI documents this. (Stories: P4)
- **FR-016**: Conversations whose persisted history references gated tools render correctly when the setting is OFF — the tool name and result text display normally, but no Undo button is shown for those historical entries when the gated tools are not currently registered (since re-invocation is not possible). (Stories: P4)
- **FR-017**: The agent gains three new read-only vault tools, all auto-approved under the v0.2 FR-017 read-only gate:
  - A search-by-tag tool that takes a tag string (with or without leading `#`) and returns every note whose metadata cache reports that tag, identifying each by its path and display name. Results are capped at 200; if exceeded, the response indicates truncation occurred.
  - A search-by-name tool that takes a query string and returns notes whose basename contains the query as a case-insensitive substring, ranked by closeness of match (exact match before prefix match before substring match), capped at 50 results.
  - A list-all-tags tool that returns every distinct tag observed in the vault's metadata cache, with the count of notes carrying each tag, sorted by note-count descending. (Stories: P5)
- **FR-018**: The new search tools route through the universal permission gate (deny-by-default) and are auto-approved per FR-017 read-only criteria; their tool-results render in the chat as a structured list with note links that open on click. (Stories: P5)
- **FR-019**: First-time v0.3 install: on the first `onload` with no persisted conversation data, a single empty "Untitled" conversation is created. Note: v0.2's in-memory message history is not recoverable across the plugin reload that ships v0.3 — `ChatState` lives on `ChatView`, which is destroyed on `onunload`, so the v0.3 `onload` cannot reach v0.2's ephemeral state. (Stories: P2)
- **FR-020**: The conversation picker renders responsively when the chat pane width is reduced. The picker control itself remains usable at all pane widths supported by Obsidian's leaf system; long conversation names truncate with ellipsis rather than wrapping. (Stories: P1)
- **FR-021**: All v0.2 invariants are preserved: universal permission gate, FR-017 read-only auto-approval, deny-by-default tool execution, no regressions to streaming, Stop control, approval-prompt flow, token rotation, the 13 v0.2 vault tools, or the 410/410 baseline test count. (Stories: P1, P2, P3, P4, P5)

### Key Entities

- **Conversation**: id (string), name (string), createdAt (timestamp), lastActiveAt (timestamp), archived (boolean), messages (array), undoEntries (array of UndoEntry).
- **UndoEntry**: id (string), conversationId (string), toolName (string), targetPath (string), capturedAt (timestamp), undone (boolean), restoreData (opaque snapshot used by the existing UndoJournal contract).
- **PersistedState** (conversations-store subtree): schemaVersion (integer), activeConversationId (string), conversations (array of Conversation). Existing settings continue to live in their separate top-level keys (`auth`, `safety`) owned by their respective stores.

### Cross-Cutting / Non-Functional

- Persisted state schema is versioned; on load, an unrecognized `schemaVersion` triggers the FR-010 corruption-recovery path rather than crashing.
- Persistence writes are debounced (≤1 write per 500 ms) to keep disk I/O low for chatty conversations.
- Persisted state is written through Obsidian's plugin-data API only; no files are written into the user's vault.
- The conversation picker and per-conversation message rendering complete within 100 ms (P95) for conversations with up to 200 messages on a typical developer laptop.

## Success Criteria

- **SC-001**: After creating two conversations, sending distinct messages in each, restarting Obsidian, and reopening the chat pane, both conversations are present in the picker, the conversation that was active before restart is active again, and message histories are byte-identical to what was on screen before restart. (FR-001, FR-002, FR-003, FR-008, FR-009)
- **SC-002**: Switching between conversations via the picker visibly updates the message stream within 100 ms (P95) and does not interrupt an in-flight assistant response in a non-displayed conversation. (FR-003, FR-007)
- **SC-003**: A user who performed an `edit_note` tool call before restarting Obsidian can click Undo on the persisted entry within 7 days of the original call and have the file content restored to its pre-call state. (FR-008, FR-011, FR-012, FR-013)
- **SC-004**: With the advanced setting OFF (default), 0 of the 6 gated raw-FS tools appear in the tools manifest exposed to the model in a fresh session. With the setting ON, all 6 are present. (FR-014, FR-015)
- **SC-005**: The agent answers "list all my notes tagged X" by invoking `search_by_tag` (observed via the chat panel's tool-call row showing `search_by_tag` as the tool name) without prompting the user for approval, and returns exactly the matching notes with no false positives or negatives. (FR-017, FR-018)
- **SC-006**: With 1000 notes and 30 tags in the vault, `list_all_tags` returns all distinct tags within 500 ms (P95), and `search_by_tag` returns matching notes within 200 ms (P95). (FR-017)
- **SC-007**: After deliberately corrupting the `conversations` subtree in plugin data and reloading the plugin, the user sees a recovery Notice, the plugin opens with a fresh empty conversation, and the malformed subtree is preserved at `conversations_recovery.bak.json` in the plugin-data directory. The `auth` and `safety` subtrees in `data.json` remain intact and functional after recovery. (FR-010)
- **SC-008**: The 21st conversation creation archives the oldest non-active conversation (oldest = lowest `lastActiveAt` among non-active conversations): it disappears from the picker but its data file is retained, and the active conversation count in the picker stays at 20. Archived conversations stay archived even if the active count later falls below 20 (showing/restoring archived conversations is Out of Scope). (FR-002)
- **SC-009**: A new test suite covers conversation CRUD, persistence load/save, cross-restart undo (within window, beyond window, file-modified-since-snapshot, undo-marked entries), the 3 new search tools, and the raw-FS gating toggle. The total project test count is at least 410 + new-test-count, with no regressions. (FR-021)
- **SC-010**: Across a 30-minute manual UX session that exercises all 5 user stories, no stream is interrupted, no approval-prompt regression occurs, the Stop button still works mid-stream, and token rotation continues to work as in v0.2. (FR-021)
- **SC-011**: The persisted-state file size remains under 5 MB for a representative workload (10 conversations × 100 messages average × 5 undo snapshots) without compression; if it exceeds 5 MB in real usage a non-blocking Notice surfaces. (FR-008, FR-011)
- **SC-012**: README and Docs.md are updated to describe multi-conversation, cross-restart undo, the raw-FS toggle, and the three new search tools. The "What is NOT in v0.3" section enumerates the deferred items.

## Assumptions

- Persisted conversation state lives in `data.json` via Obsidian's standard `Plugin.saveData()` / `Plugin.loadData()` API. This is shared with existing settings (each store owns its own top-level key and follows the merge-and-write pattern proven by `TokenStore` and `SafetySettingsStore`).
- The existing `UndoJournal` API (`record`, `undo`, query) remains the contract; v0.3 adds a persistence layer that hydrates / serializes its state but does not change the API consumed by tool implementations.
- Cross-restart undo's "file modified since snapshot" detection compares the current file content to the snapshot's `before` text (content-based), consistent with how the in-session UndoJournal already detects external edits. No mtime/size metadata is added to persisted entries.
- The `search_by_name` ranking does not need to be a fuzzy-match algorithm; case-insensitive substring + bucket ranking (exact > prefix > substring) is sufficient for v0.3. A future improvement could swap in `fzf`-style scoring.
- "Active conversation when Obsidian closed" is captured via two mechanisms in combination: a debounced `lastActiveAt` write whenever the user switches, plus a synchronous flush at `onunload` so a fast close after a switch does not lose the update.
- Conversations are ordered in the picker by `lastActiveAt` descending. New conversations appear at the top.
- The maximum undo snapshot size per entry is bounded by the size of the file being mutated; v0.3 inherits v0.2's behavior here without imposing a new cap.
- v0.3 supports at most one concurrent assistant stream per plugin instance (multi-leaf chat is Out of Scope). The conversation runtime is per-conversation, so tool execution naturally binds to the conversation that originated the stream.

## Scope

In Scope:
- Multi-conversation support (create, switch, rename, delete, archive at soft cap).
- Persistence of conversation list, per-conversation message history, and per-conversation undo journal across plugin reload, Obsidian restart, and OS reboot.
- Restoration of the previously active conversation on plugin load.
- Cross-restart Undo with last-50-per-conversation + 7-day TTL retention and file-modified-since-snapshot confirmation prompt.
- New plugin setting "Expose v0.1 raw-filesystem tools" (default OFF) gating the 6 raw-FS tools.
- Three new read-only vault tools: `search_by_tag`, `search_by_name`, `list_all_tags`.
- Conversation picker UI at the top of the chat pane (dropdown form factor).
- Corruption-recovery path for unreadable persisted state.
- Schema versioning of persisted state.
- Updated README, Docs.md, and CHANGELOG.

Out of Scope:
- MCP integration.
- Extra-vault filesystem roots.
- Model picker UI / per-conversation model selection.
- Mid-session settings reload (settings continue to apply on the next session start).
- Tag-rename / tag-create capability surface.
- SDK changes (transport preamble continues via first-message prepending in `CopilotAgentSession`).
- Per-vault Daily Notes target override (deferred candidate dropped after dogfooding showed no observed pain).
- Showing or restoring archived conversations from the picker.
- Sharing conversations across vaults or syncing them through Obsidian Sync (vault-local data only).
- Conversation export / import.
- Search-by-content fuzzy matching (current substring `search_content` continues unchanged).
- Cross-conversation tool-call inspection (each conversation's undo journal is private to that conversation).

## Dependencies

- Obsidian's `Plugin.saveData()` / `Plugin.loadData()` API for persistence.
- Obsidian's `MetadataCache` for tag enumeration and tag-to-note lookup (for the new search tools).
- Existing v0.2 `UndoJournal` API (extended, not replaced).
- Existing v0.2 universal permission gate, tool-registration pipeline, and FR-017 read-only auto-approval gate.
- Existing v0.2 `CopilotAgentSession` transport-preamble behavior (no SDK changes).

## Risks & Mitigations

- **Persisted-state corruption silently breaks every load**: Impact: data loss for all conversations. Mitigation: schema versioning; FR-010 corruption-recovery path with sibling `conversations_recovery.bak.json` preservation; aggressive automated tests for malformed inputs.
- **Cross-restart Undo restores stale content over later legitimate edits**: Impact: silent data loss when a user edits a file outside the agent and then absent-mindedly clicks an old Undo button. Mitigation: FR-012 file-modified-since-snapshot confirmation prompt with explicit description of divergence.
- **Persistence write latency degrades chat responsiveness**: Impact: UI hitches on every message. Mitigation: debounced writes (≤1 per 500 ms); writes happen off the render path; SC-002 performance budget enforced in tests.
- **Persisted-state file grows unbounded for power users**: Impact: slow load times, large `data.json`. Mitigation: SC-011 size budget surfaces as a non-blocking Notice; FR-002 archive policy caps active conversations at 20. Note: archived conversations are loaded into memory alongside active ones in v0.3 (lazy loading of archived headers is a Phase Candidate for a future release); the SC-011 Notice is the primary brake against unbounded growth.
- **Soft-archiving the 21st conversation surprises users who didn't realize they hit the cap**: Impact: "where did my conversation go?" support load. Mitigation: surface a one-time Notice on archive; document behavior in Docs.md; ensure archived data is preserved on disk so a future "Show archived" feature is non-lossy.
- **Disabling raw-FS tools by default breaks existing user workflows that rely on them**: Impact: regression for power users. Mitigation: opt-in setting clearly described in CHANGELOG and Settings UI; on first v0.3 load, surface a one-time Notice explaining the change and how to re-enable.
- **The new search tools depend on `MetadataCache` being populated**: Impact: empty results immediately after vault open. Mitigation: tools handle the not-yet-ready state by returning a structured "metadata-cache-not-ready" status instead of an empty array, and the agent can retry.
- **Schema migrations needed in a future version**: Impact: future code complexity. Mitigation: include `schemaVersion` from day one; document the migration path policy in Docs.md.

## References

- Issue: none (in-team prioritization)
- Prior art: `.paw/work/chat-ux-vault-tools/Spec.md` (v0.2 spec; FR-017 read-only auto-approval definition; UndoJournal contract).
- Prior art: `.paw/work/chat-ux-vault-tools/ImplementationPlan.md` (deferred candidates section that this spec addresses).
- Prior art: `.paw/work/chat-ux-vault-tools/Docs.md` (v0.2 user-facing docs to be amended).
- Research (this work): To be generated as `.paw/work/multi-conversation-persistence/SpecResearch.md` if needed during code-research.
