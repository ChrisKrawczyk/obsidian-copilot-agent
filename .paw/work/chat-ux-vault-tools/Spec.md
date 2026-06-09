# Feature Specification: Chat UX & Vault-Aware Tools

**Branch**: `feature/chat-ux-vault-tools`  |  **Created**: 2026-06-09  |  **Status**: Draft
**Input Brief**: v0.2 workflow A — make the in-vault Copilot agent feel native to Obsidian by fixing chat keybinding ergonomics, giving the model vault context up front, and adding first-class Obsidian-API-backed note tools.

## Overview

Today's v0.1 plugin works end-to-end but has three friction points that block it from feeling like a native Obsidian companion. First, the chat input only sends on a Send button click, so every message requires a context switch from keyboard to mouse — at odds with both VS Code's chat panel and Obsidian's keyboard-first ethos. Second, the agent has no built-in awareness that a vault is mounted, so when a user says "create a new note," the model spends multiple turns running general-purpose shell tool calls to discover the vault root and list its contents — each gated behind an approval prompt — before it can produce the actual file. Third, all vault read/write tools route through the raw filesystem rather than Obsidian's own vault interface; this means writes don't trigger Obsidian's normal change notifications, daily-note formatting conventions are ignored, and integration with first-party features (active editor, recent files, daily/periodic notes) is unavailable.

This work delivers three user-visible changes that together let the model handle the most common scenarios — "create or edit a note", "log a task", "link related notes" — in a single approved tool call: keyboard-driven chat input (Enter sends, Shift+Enter inserts a newline, IME composition respected), a privacy-safe vault-aware system prompt automatically injected at session start (vault root path plus top-level folder names, with authoring-convention guidance for backlinks, tags, and tasks, all user-overridable), and a richer set of vault-aware capabilities — create note, edit note, open note, insert into the active note, create today's daily note, create a task, list recently modified notes, get the active note, and find backlinks to a note — that prefer Obsidian's own vault interface so that resulting changes look identical to user-authored changes, while transparently falling back to the v0.1 filesystem path if Obsidian's interface cannot satisfy the request.

The work preserves every safety property of v0.1: every new mutating capability routes through the same universal permission gate; read-only capabilities are exempted only if they satisfy the v0.1 read-only checklist (strict read-only, validated path inputs, bounded scope, no symlink escape, no unbounded walks); the vault-aware prompt sends only the vault root path and top-level folder names by default (no note titles, no recent activity), with the body of the prompt overridable in Settings for users who want richer context or stricter scrubbing. The system prompt also encodes Obsidian's authoring conventions — when and how to use wikilinks for backlinks, hash-prefixed tags for thematic grouping, and the Tasks-plugin-compatible checkbox syntax for actionable items — so the agent produces notes that integrate naturally with Obsidian's graph view, tag pane, and the Tasks/Calendar community plugins. The full v0.1 test baseline must remain green, with new coverage for each new capability, the keybinding handler, the system-prompt assembler, and the API-vs-filesystem fallback paths.

This is workflow A of a planned v0.2 split. Workflow B (extra-vault filesystem roots, MCP integration, model selection / cross-restart resume / standalone documentation, plus deferred candidates: secure-storage upgrade for tokens, multi-conversation support, cross-restart Undo, a no-tools chat-only mode, MCP credential UI, and user-authored custom tools) is explicitly out of scope here.

## Objectives

- Make sending a chat message a keyboard-first action consistent with VS Code's chat panel and Obsidian's editor (Rationale: this removes the per-message keyboard→mouse context switch that is the largest reported daily-use friction point in v0.1).
- Give the model enough vault awareness at session start to handle simple note operations without exploratory discovery calls (Rationale: each discovery call requires a separate approval prompt, so reducing exploration directly reduces approval fatigue and the chance of users approving away their safety posture).
- Make vault-scoped changes look indistinguishable from user-authored changes — same change notifications, same metadata indexing, same daily-note conventions, same active-editor integration (Rationale: notes created via the agent should integrate seamlessly with the rest of Obsidian rather than appearing as foreign content).
- Keep the universal permission gate as the only path to vault mutation (Rationale: the gate was the central safety property in v0.1's threat model and must not be bypassable by new capabilities).
- Preserve correct behavior on edge-case vaults where Obsidian's first-party interface cannot satisfy a request (Rationale: defensive fallback avoids a regression class where v0.2 fails on vaults that v0.1 handled).

## User Scenarios & Testing

### User Story P1 – Send a chat message with the keyboard
**Narrative**: A user types a question in the chat input and presses Enter. The message sends immediately, the input clears, and the streaming response begins — without ever touching the mouse.

**Independent Test**: Open the chat view, focus the input, type "hello", press Enter — message appears in transcript and a response begins streaming.

**Acceptance Scenarios**:
1. Given the chat input is focused with non-empty text, When the user presses Enter (no modifier), Then the message is sent and the input is cleared.
2. Given the chat input is focused, When the user presses Shift+Enter, Then a newline is inserted at the caret and no message is sent.
3. Given the user is composing with an IME (e.g. Japanese / Chinese / Korean input), When Enter commits the IME composition, Then the composition is committed into the input and no message is sent (Enter only sends after composition completes).
4. Given the chat input is empty or whitespace-only, When the user presses Enter, Then no message is sent and the input remains focused.
5. Given a message is currently streaming and Stop is available, When the user presses Enter with new text, Then the current stream is unaffected by the keypress (Send is disabled until streaming ends, matching the existing button state).

### User Story P2 – Create a new note in one tool call
**Narrative**: A user types "create a note titled Meeting Notes". The agent immediately invokes the create-note capability with the resolved title and content; the user sees one approval prompt; on approve, the note is created and appears in the file explorer immediately.

**Independent Test**: From a fresh session, ask the agent to create a named note. Observe exactly one mutation approval prompt before the file appears.

**Acceptance Scenarios**:
1. Given a fresh session in a vault, When the user asks to create a named note, Then the agent invokes the create-note capability directly (no preceding discovery tool calls) and the user sees one approval prompt for that single mutation.
2. Given approval is granted, When the create-note capability runs, Then the file is created such that it appears in Obsidian's file explorer immediately, is visible to Obsidian's link/tag indexing within the same session, and emits the same change notifications as a user-authored file (so other plugins respond identically).
3. Given the requested path collides with an existing note, When the create-note capability is invoked, Then the tool surfaces a structured error to the model (which can decide to choose a new name or ask the user) and does not silently overwrite.
4. Given Obsidian's first-party vault interface cannot satisfy the requested path (defensive case), When the create-note capability is invoked, Then the tool falls back to the v0.1 filesystem-based create path with the same path validation and the same approval gate.

### User Story P3 – Edit the note the user is currently looking at
**Narrative**: A user with a note open says "add a TODO list to this note." The agent retrieves the active note's content (read-only, exempt from approval), then invokes the edit-note or insert-into-active-note capability, which produces one approval prompt; on approve, the note updates in the active editor with cursor behavior as specified below.

**Independent Test**: Open any note, ask the agent to append text to the active note. One approval prompt appears; on approve, the active editor reflects the change.

**Acceptance Scenarios**:
1. Given a note is open in the active editor, When the agent retrieves the active note, Then the tool returns the file path and current content without an approval prompt (read-only exemption per v0.1's read-only checklist).
2. Given a note is open, When the agent inserts content into the active note with mode append, prepend, or replace, Then exactly one approval prompt appears, and on approve the change is applied through the editor surface so that: for append the cursor remains at its prior position; for prepend the cursor is shifted by exactly the number of inserted characters; for replace the cursor is placed at the end of the inserted content.
3. Given the active editor changes between retrieving the active note and a subsequent edit-note call, When the edit is invoked with stale content assumptions, Then the v0.1 stale-content guard applies and the edit either succeeds with explicit overwrite confirmation or fails with a structured error.
4. Given no note is currently active (workspace is empty or showing a non-markdown view), When the agent retrieves the active note or attempts to insert into it, Then the tool returns a structured "no active note" error rather than guessing a target.

### User Story P4 – Create today's daily note
**Narrative**: A user says "log this in today's daily note." The agent creates today's daily note, using the Daily Notes core plugin's configuration (folder, format, template) when enabled, or falling back to `YYYY-MM-DD.md` in the vault root. One approval prompt; the note opens.

**Independent Test**: Without the Daily Notes plugin enabled, ask the agent to create today's daily note. A `YYYY-MM-DD.md` file is created in the vault root via one approval prompt. Repeat with Daily Notes enabled and a custom folder; observe the note is created in the configured folder using the configured format.

**Acceptance Scenarios**:
1. Given the Daily Notes core plugin is enabled and configured, When the agent invokes the create-daily-note capability, Then the note is created in the configured folder with the configured filename format and template content (if any).
2. Given the Daily Notes core plugin is disabled, When the agent invokes the create-daily-note capability, Then the tool falls back to creating `YYYY-MM-DD.md` in the vault root with no template content.
3. Given today's daily note already exists, When the agent invokes the create-daily-note capability, Then the tool returns the existing path with a "noop" outcome — it does not duplicate or overwrite.
4. Given the path the daily note would be created at, When the tool performs the underlying create, Then the operation routes through the universal permission gate exactly like a regular create-note (one approval prompt, same modes, same allowlist).

### User Story P5 – Log a task that lands in the calendar
**Narrative**: A user says "remind me to follow up with Alice on Friday." The agent creates a task with the description and a parsed due date. On approve, the task is appended to today's daily note (or another configurable target) using the Tasks-plugin checkbox syntax, so it appears in the Tasks plugin's query views and on the Calendar plugin's date cells.

**Independent Test**: With the Tasks plugin and Calendar plugin installed, ask the agent to add a task with a due date. The task appears in the configured target note, in the Tasks-plugin format, and shows up on the Calendar view for the due date.

**Acceptance Scenarios**:
1. Given the Tasks plugin is installed, When the agent invokes the create-task capability with description and optional due-date / scheduled-date / priority, Then a checkbox line is appended to the configured target (default: today's daily note) using Tasks-plugin emoji syntax (📅 YYYY-MM-DD for due, ⏳ YYYY-MM-DD for scheduled, ⏫ / 🔼 / 🔽 for priority) so Tasks-plugin queries pick it up.
2. Given the Tasks plugin is not installed, When the agent invokes the create-task capability, Then a plain GitHub-flavored markdown checkbox is appended to the same target, with date metadata embedded as inline text the user can later upgrade — and the tool result reports that the fallback format was used.
3. Given the configured task target note does not exist (e.g., today's daily note hasn't been created), When the agent invokes the create-task capability, Then the tool ensures the target exists (creating it via the same daily-note logic when applicable) inside the same single approval flow.
4. Given the user is asking for "follow up Friday" and Friday is ambiguous (next Friday vs. this Friday), When the agent assembles the create-task arguments, Then it resolves the date deterministically against the user's local timezone (provided in the system prompt) and surfaces the resolved date in the chat for the user to correct.

### User Story P6 – Vault-aware system prompt with privacy guardrails
**Narrative**: At session start, the agent receives a small system prompt that names the vault root path and lists top-level folder names. The user can view and override the prompt body in Settings, and the override surface includes presets (none / default / custom) so users in sensitive vaults can dial it down.

**Independent Test**: Open a vault with folders `Notes`, `Projects`, `Archive`. Start a fresh session and ask "what's in my vault?" The agent answers with the three folder names without making any tool calls. Switch the prompt mode to "none" in Settings, restart the session, and observe the agent now requires tool calls to answer the same question.

**Acceptance Scenarios**:
1. Given a fresh session in a vault with top-level folders A, B, C, When the session initializes, Then the system prompt sent to the model includes the absolute vault root path, the three folder names, and a fixed authoring-conventions block (backlink/tag/task guidance) — and no recent note titles, file counts, or per-file metadata.
2. Given the user opens Settings → Vault Awareness and selects "None", When a new session starts, Then no vault context is injected (neither folder list nor authoring-conventions block) and the model behaves as in v0.1.
3. Given the user selects "Custom" and provides a body, When a new session starts, Then the user-provided body is injected verbatim (with vault root path still substituted via a documented placeholder) and the default folder list and authoring-conventions block are suppressed unless their placeholders are present.
4. Given the prompt mode is the default, When the user toggles between vaults at runtime, Then the next session reflects the new vault's root path and folder list.
5. Given the default authoring-conventions block, When the model is asked to create or edit a note, Then it (a) prefers wikilink syntax over bare paths or markdown links for any reference to another vault note, (b) uses hash-prefixed tag syntax for thematic grouping when the user implies grouping, and (c) uses Tasks-plugin checkbox syntax (or the create-task capability) for any actionable item — without needing per-message reminders.

### User Story P7 – Navigate and discover related notes
**Narrative**: A user says "open my Project Plan note", or "what have I been working on this week?", or "what links to this note?" The agent answers using read-only tools where possible (no approvals) and uses the open-note capability (no mutation, no approval beyond what v0.1 already exempts for navigation) to focus a note in the workspace.

**Independent Test**: With several notes in the vault and at least one note that links to another, ask the agent each of: "open Project Plan", "list my recent notes", and "what notes link to Project Plan?" Each answer returns within a single response without producing approval prompts beyond those already exempted by v0.1's read-only checklist.

**Acceptance Scenarios**:
1. Given a note named "Project Plan" exists, When the agent invokes the open-note capability with that name, Then the note becomes the active workspace pane and the chat reports success — no filesystem mutation occurs.
2. Given the user asks for recent activity, When the agent invokes the list-recent-notes capability, Then it returns up to 20 entries (the default) ordered by modification time descending, each with note path and modification timestamp; no approval prompt is shown because the capability is read-only and within v0.1's read-only-exemption checklist.
3. Given a target note exists and several other notes reference it, When the agent invokes the find-backlinks capability, Then it returns the list of referencing notes including the link form used (wikilink vs. markdown link); on a vault where Obsidian's resolved-link index is populated, results match what Obsidian's own Backlinks pane shows.
4. Given a target note exists in a very large vault and the index path is unavailable, When the agent invokes the find-backlinks capability, Then the bounded fallback scan runs within the same caps as v0.1's content-search capability and the result indicates whether any results were truncated.
- A vault with 0 top-level folders (only files at root): system prompt includes vault root path and lists files at root capped at 50, alphabetical, truncated with "(N more)" if there are additional files.
- A vault with thousands of top-level folders (rare but possible): truncate at 50 alphabetically, append "(N more)" so the prompt stays bounded.
- Daily Notes plugin enabled but its target folder doesn't exist: the create-daily-note capability creates the folder before creating the note, gated by the same approval.
- Insert-into-active-note while the active file is read-only or unsaved-with-conflicts: tool returns a structured error and does not attempt write.
- Settings change to system-prompt mode while a session is active: takes effect on next session start, not mid-session (avoids replaying transcripts with conflicting context).
- Plugin update from v0.1 → v0.2 with an existing approved-this-session permission state: new capabilities default to deny like all other capabilities; user re-approves on first use.

## Requirements

### Functional Requirements

- FR-001: Pressing Enter in the chat input with non-empty, non-whitespace text shall send the message and clear the input. (Stories: P1)
- FR-002: Pressing Shift+Enter in the chat input shall insert a newline at the caret position without sending. (Stories: P1)
- FR-003: While an IME composition is active in the chat input, Enter shall complete the composition and shall not send the message. (Stories: P1)
- FR-004: While a response is streaming, Enter shall not send a new message; the input may accept text but the send action remains disabled until the stream completes (matching the Send button's existing disabled state). (Stories: P1)
- FR-005: A vault-aware system prompt shall be injected at session start when the user's selected mode is anything other than "None". (Stories: P6)
- FR-006: The default system prompt body shall include the vault's absolute root path, the names of its top-level folders (sorted alphabetically, capped at 50 entries; if more, append "(N more)"), and a fixed authoring-conventions block covering backlinks, tags, and tasks (see FR-006a/b/c). (Stories: P6)
- FR-006a: The authoring-conventions block shall instruct the model to prefer wikilink syntax over bare paths or markdown links for any reference to another vault note, briefly explain that wikilinks power Obsidian's graph view and backlinks pane, and recommend creating a backlink whenever a new note semantically relates to an existing note (e.g., "Notes about meetings should link to the project they pertain to"). (Stories: P6)
- FR-006b: The authoring-conventions block shall instruct the model to use hash-prefixed tag syntax (including nested tags) for thematic grouping when the user expresses categorization intent, recommend reusing existing tags from the vault when known rather than minting near-duplicates, and instruct the model to ask before introducing a brand-new tag taxonomy in a vault that already has tags. (Stories: P6)
- FR-006c: The authoring-conventions block shall instruct the model to use the Tasks-plugin emoji syntax for actionable items when the Tasks plugin is detected, and standard GFM checkbox syntax when it is not, and to invoke the create-task capability rather than hand-writing the markdown when the user asks for a reminder/todo with a date. (Stories: P5, P6)
- FR-007: The system prompt shall not include note titles, file counts, recent-activity metadata, or per-file timestamps in any default mode. (Stories: P6)
- FR-008: Settings shall expose a "Vault Awareness" mode selector with at least: "None", "Default" (FR-006), and "Custom" (user-supplied body); changes shall take effect at the next session start. (Stories: P6)
- FR-009: A create-note capability shall be available that creates a markdown note at a vault-relative path using Obsidian's first-party vault interface; on path collision the tool shall return a structured error without overwriting. (Stories: P2)
- FR-010: An edit-note capability shall be available that modifies an existing vault note via Obsidian's first-party vault interface and shall preserve the v0.1 stale-content guard. (Stories: P3)
- FR-011: An open-note capability shall be available that focuses an existing vault note in the active workspace. (Stories: P7)
- FR-012: An insert-into-active-note capability shall be available with insertion modes append, prepend, or replace, with cursor-position behavior as specified in P3 acceptance scenario 2; if the active file is read-only or has unsaved conflicts, the tool returns a structured error and does not attempt write. (Stories: P3)
- FR-013: A create-daily-note capability shall be available that uses the Daily Notes core plugin's configuration when enabled and falls back to `YYYY-MM-DD.md` at the vault root when disabled; calling it on an existing daily note shall return that path as a noop without overwriting. (Stories: P4)
- FR-014: A list-recent-notes capability shall be available (read-only) that returns the N most recently modified notes in the vault; default N is 20, maximum N is 100; results are ordered by modification time descending. (Stories: P7)
- FR-015: A get-active-note capability shall be available (read-only) that returns the path and content of the note currently focused in the workspace, or a structured "no active note" error if none. (Stories: P3)
- FR-015a: A create-task capability shall be available that appends a task line to a configurable target note (default: today's daily note, resolved via FR-013), accepting a required description and optional due date, scheduled date, priority (high / medium / low), and tags. The line shall be formatted with Tasks-plugin emoji syntax when the Tasks plugin is installed and a plain GFM checkbox otherwise; the result shall report which format was used. (Stories: P5)
- FR-015b: A find-backlinks capability shall be available (read-only) that, given a vault note path, returns the list of vault notes that reference it via wikilink or markdown link, using Obsidian's resolved-link index when available and falling back to a bounded markdown-file scan otherwise (bounded by the same per-file size cap and total-file cap as v0.1's content-search capability; when the cap is hit the result reports it). (Stories: P7)
- FR-016: All new mutating capabilities (FR-009, FR-010, FR-012, FR-013, FR-015a) shall route through the existing universal permission gate with the same approval, allowlist, and session-allow-all modes as v0.1 vault writes. (Stories: P2, P3, P4, P5)
- FR-017: All new read-only capabilities (FR-014, FR-015, FR-015b) shall qualify for v0.1's read-only exemption (strict read-only, validated path inputs, bounded scope, no symlink escape, no unbounded walks); each capability's source shall include the same documented checklist established in v0.1. (Stories: P3, P7)
- FR-018: When Obsidian's first-party vault interface cannot satisfy a given operation (interface throws, returns malformed response, or the resolved path falls outside the vault), the capability shall fall back to the v0.1 filesystem-based implementation with identical path validation and identical permission gating; the result shall observably indicate that the fallback was used. (Stories: P2, P3, P4)
- FR-019: A create-note collision, an edit-note stale-content failure, or any "no active note" condition shall surface as a structured error result the model can interpret — not as an exception that aborts the turn. (Stories: P2, P3)
- FR-020: The plugin shall continue to expose v0.1's read-file, list-files, search-content, create-file, modify-file, and delete-file capabilities so existing chats and any not-yet-migrated callers continue to function. (Stories: P2, P3, P4)
- FR-021: The system-prompt assembler shall produce identical output for identical inputs (vault root path, top-level folder list, selected mode, user custom body) so its output is deterministic and unit-testable. (Stories: P6)

### Key Entities
- **Vault Awareness Mode**: One of *none*, *default*, *custom*. Drives system-prompt assembly.
- **Note Tool Result**: Structured result returned by every new capability — note path, outcome (success / noop / collision / stale / no-active-note), optional message, and a flag indicating whether the fallback path was used.
- **Daily Note Resolution**: The folder, filename format, and template content used by the create-daily-note capability at invocation time, plus an indicator of whether the values came from the Daily Notes plugin or from the v0.2 fallback.
- **Task Input**: A description (required) plus optional due date, scheduled date, priority, tags, and target note — the user-visible inputs to the create-task capability.
- **Task Format Source**: Indicates whether a created task line used Tasks-plugin emoji syntax or the GFM-checkbox fallback; surfaced in the result so the model and user know what was emitted.
- **Authoring Conventions**: A fixed block of guidance text included in the default system prompt covering backlinks (FR-006a), tags (FR-006b), and tasks (FR-006c); content does not vary per vault.

### Cross-Cutting / Non-Functional
- New capability registrations shall not increase chat-view first-paint latency by more than 50 ms over v0.1.
- Keybinding handler shall not interfere with Obsidian's global hotkeys when the chat input is unfocused.
- Vault-aware prompt size shall be bounded such that for vaults with up to 50 top-level folders the prompt body is under 4 KB.

## Success Criteria

- SC-001: From a fresh session in any vault, asking "create a note titled X" produces exactly one approval prompt before the file is created (no preceding discovery tool calls). (FR-005, FR-006, FR-009, FR-016)
- SC-002: 100% of chat messages can be sent with the keyboard alone (Enter to send, Shift+Enter newline) without the Send button being clicked, including during IME composition. (FR-001, FR-002, FR-003)
- SC-003: A user with the Daily Notes plugin disabled can ask for "today's daily note" and receive a `YYYY-MM-DD.md` at the vault root in one approval. (FR-013, FR-016)
- SC-004: A user with the Daily Notes plugin enabled and a custom folder/format receives the daily note at the configured location. (FR-013)
- SC-005: A new v0.2 install with default settings does not send any vault note titles, file counts, or per-file timestamps to the model in the system prompt. (FR-006, FR-007)
- SC-006: A user can set Vault Awareness to "None" in Settings and the next session's system prompt contains no vault context — neither folder list nor authoring-conventions block. (FR-008)
- SC-007: All existing v0.1 tests pass unchanged; the new capabilities and keybinding handler add at least 35 new tests covering happy paths, fallback paths, IME composition, stale-content edge cases, Tasks-plugin-present and Tasks-plugin-absent task formatting, and backlink resolution via the index path vs. the bounded-scan fallback. (FR-009 through FR-021)
- SC-008: When Obsidian's first-party vault interface fails for a create-note invocation, the resulting fallback produces the same on-disk file as v0.1 would have, with the same approval gate. (FR-018)
- SC-009: With the Tasks plugin installed, asking the agent for a task with a due date produces a single approval that yields one Tasks-plugin-compatible checkbox line in the configured target note; that line then appears in a Tasks-plugin query and on the Calendar plugin's date cell without further intervention. (FR-015a, FR-006c, FR-016)
- SC-010: A model session running with the default authoring-conventions block, when asked to create a note that mentions another note in the vault, produces output that uses wikilink syntax rather than markdown link or bare path. (FR-006a)

## Assumptions

- The chat input is a single text-input element in v0.1; Enter handling can be implemented as a keyboard event handler on that element without rewriting the input.
- Obsidian's first-party vault interface (note create, modify, delete, folder create, link/tag indexing, workspace navigation) behaves as documented in the type definitions shipped with the Obsidian Desktop release the plugin targets.
- The Daily Notes core plugin's configuration is reachable from a community plugin without elevated permissions; if it is not, FR-013 falls back to the `YYYY-MM-DD.md`-at-root behavior unconditionally and a planning note records the limitation.
- "Top-level folders" means direct children of the vault root that are folders (not files); files at the vault root are not enumerated by default (kept private to avoid leaking note titles).
- IME composition state is detectable via standard composition-start / composition-end keyboard events, which Electron supports as in standard browsers.
- Session restart is a low-friction action (handled by the existing v0.1 token-rotation flow), so requiring users to start a new chat to pick up Settings changes is acceptable for v0.2.
- The Tasks plugin's emoji syntax (📅 due, ⏳ scheduled, ⏫ / 🔼 / 🔽 priority) is stable enough to depend on without a runtime version probe; if a future Tasks plugin release breaks this format, the fallback path remains correct.
- The Calendar plugin reads task data from notes that match the daily-note path convention; placing tasks in today's daily note (the default create-task target) is therefore sufficient for Calendar integration without a Calendar-plugin-specific code path.
- "Existing tags from the vault" can be enumerated via Obsidian's tag indexing without a full content scan; if the index is unavailable (e.g., not yet built), the agent falls back to not making tag-reuse recommendations rather than performing an unbounded scan.

## Scope

**In Scope:**
- Enter / Shift+Enter / IME-aware keybinding in the chat input
- Vault-aware system prompt with *none* / *default* / *custom* modes, settings UI, and a deterministic assembler — including the fixed authoring-conventions block for backlinks, tags, and tasks
- Nine new vault-aware capabilities: create note, edit note, open note, insert into active note, create daily note, create task, list recent notes, get active note, find backlinks
- Augmenting (not replacing) v0.1's vault capabilities: new capabilities coexist with v0.1's read-file, list-files, search-content, create-file, modify-file, and delete-file capabilities
- A first-party-interface-first pattern with a documented filesystem fallback for every new mutating capability
- Permission gating for all new mutating capabilities; read-only-checklist exemption for the three new read-only capabilities (list recent notes, get active note, find backlinks)
- Tasks-plugin emoji-syntax detection and fallback to GFM checkbox syntax
- Updating README's "What is NOT in v0.1" list to reflect v0.2 ship state

**Out of Scope:**
- Extra-vault filesystem roots (workflow B / former Phase 7)
- MCP integration (workflow B / former Phase 8)
- Model selection settings, cross-restart resume, mobile-load guard, threat-model README disclosure beyond what v0.1 already has (workflow B / former Phase 9)
- Standalone documentation file (workflow B / former Phase 10)
- Secure-storage upgrade for the auth token (workflow B / candidate 2)
- Multi-conversation support (workflow B / candidate 4)
- Cross-restart Undo journal (workflow B / candidate 5)
- No-tools chat-only mode (workflow B / candidate 6)
- MCP server credential UI (workflow B / candidate 7)
- User-authored custom tool registration (workflow B / candidate 8)
- Replacing the existing v0.1 vault capabilities (explicit "augment, not replace" decision)
- Including note titles, file counts, or recent activity in the default system prompt
- Mobile (iOS/Android Obsidian) support — desktop only, consistent with v0.1
- Periodic Notes community plugin integration (Daily Notes core plugin only for v0.2; Periodic Notes can be a candidate)
- A Calendar-plugin-specific capability surface (Calendar reads from daily-note files; the create-task default target of today's daily note is sufficient)
- A tag-management capability (tag creation is implicit in note content; explicit tag-rename or tag-create capabilities are candidates for a future workflow)
- Migrating existing chats / sessions to the new system prompt mid-conversation (changes take effect on next session start, per FR-008)

## Dependencies

- Obsidian Desktop 1.4+ (same as v0.1) — the plugin depends on the Obsidian first-party APIs documented in the type definitions shipped with that release for vault, workspace, metadata indexing, and internal-plugin configuration access.
- Daily Notes core plugin (optional; capability falls back when disabled).
- Tasks community plugin (optional; create-task falls back to GFM checkbox syntax when absent).
- Calendar community plugin (optional; integration is achieved indirectly by writing tasks to daily notes — no direct dependency).
- v0.1 codebase: the existing universal permission gate, undo journal, path validator, scope registry, agent-session orchestrator, chat view, and read/write capabilities are reused and extended (no new safety primitives are introduced in this work).
- The Copilot SDK runtime (unchanged from v0.1).

## Risks & Mitigations

- **Risk: IME composition handling regression breaks chat for CJK users.** Impact: blocks users typing Chinese/Japanese/Korean. Mitigation: explicit composition-start / composition-end handling in the keybinding code, plus a unit test that simulates a composition cycle and asserts Enter does not send mid-composition.
- **Risk: Obsidian's first-party vault interface changes between minor versions and breaks the new capabilities.** Impact: tool failures after an Obsidian update. Mitigation: defensive fallback to v0.1's filesystem path (FR-018) means failures degrade rather than break, and tests assert both paths produce equivalent on-disk results.
- **Risk: Daily Notes core plugin internal configuration is undocumented and may break.** Impact: create-daily-note falls back to `YYYY-MM-DD.md` even when Daily Notes is enabled. Mitigation: the result reports which source was used so the model and user can see the actual outcome; planning will document the specific configuration access used and its versioning concerns.
- **Risk: Vault-aware system prompt leaks sensitive folder names (e.g. "Personal/Therapy").** Impact: privacy violation. Mitigation: prompt is purely top-level folder names by default (no titles, no metadata); user can switch to "None" mode for a fully scrubbed session; "Custom" mode allows hand-curated bodies; documentation calls this out explicitly in Settings.
- **Risk: Augment-not-replace bloats the capability surface and confuses the model.** Impact: model picks the v0.1 raw-filesystem capability over the new note-aware capability and the v0.2 ergonomics never materialize. Mitigation: the system prompt's default body explicitly directs the model to prefer the note-aware capabilities for vault content; v0.1 capabilities are documented as "raw filesystem" in their tool descriptions; planning will weigh visibility tweaks (e.g. ordering, doc strings) and may consider hiding v0.1 capabilities by default in a follow-up.
- **Risk: Enter-to-send inadvertently sends in-progress drafts when users are accustomed to Send button.** Impact: confused first-time experience. Mitigation: confirmed user request is to mimic VS Code; standard behavior; documentation note in README; no setting to disable for v0.2 (kept simple).
- **Risk: Tasks plugin's emoji syntax changes between releases, producing tasks that the user's Tasks plugin no longer recognizes.** Impact: tasks created by the agent become invisible to the Tasks plugin's query views. Mitigation: the result lets the user verify which format was used; the fallback path always produces a GFM checkbox the user can manually upgrade; planning will pin the documented syntax version and document the upgrade path.
- **Risk: Authoring-conventions block in the system prompt makes the model verbose or pedantic about wikilinks/tags when the user just wants a plain note.** Impact: degraded chat experience. Mitigation: the conventions block is written as guidance ("prefer", "when") rather than mandates; user can switch to "None" or "Custom" mode to remove or rewrite it; planning will include a chat-style smoke test where the user asks for a one-line note and verifies the model does not annotate it with unsolicited links/tags.
- **Risk: Find-backlinks bounded-scan fallback runs slowly on very large vaults.** Impact: long tool execution / approval timeout. Mitigation: fallback path bounded by file count and per-file size cap consistent with v0.1's content-search capability; when the cap is hit the result reports it as truncated and the model can iterate.

## References

- Issue: none (private repo, post-v0.1)
- Prior workflow: `.paw/work/copilot-sdk-spike/` (v0.1, merged in PR #1)
- v0.1 deferred work tracking: `.paw/work/copilot-sdk-spike/ImplementationPlan.md` § Phase Candidates and § Phase Status (Phases 7–10 marked `[deferred]`, candidates 2/4/5/6/7/8 carry forward to workflow B)
- Reference (inspiration only — do NOT vendor or copy code): the community **Copilot for Obsidian** plugin (`logancyang/obsidian-copilot`) ships chat-input keybindings, vault-aware prompting, and Obsidian-API-backed tools; reviewing its public behavior may inform UX choices but its implementation, prompts, and tool surfaces are not reused.
- Reference: **Tasks** community plugin (`obsidian-tasks-group/obsidian-tasks`) — canonical reference for the emoji syntax (📅 due, ⏳ scheduled, ⏫ / 🔼 / 🔽 priority) used by the create-task capability.
- Reference: **Calendar** community plugin (`liamcain/obsidian-calendar-plugin`) — relies on daily-note files; integration is via the daily-note write target rather than a direct dependency.
- Research: none — sufficient context exists from v0.1 and the referenced plugins; no SpecResearch.md is generated for this work.
