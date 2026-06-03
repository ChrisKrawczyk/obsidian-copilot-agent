# Feature Specification: Obsidian Copilot Agent — v0.1

**Branch**: feature/copilot-sdk-spike  |  **Created**: 2026-06-02  |  **Status**: Draft
**Input Brief**: An Obsidian desktop plugin that provides an in-vault AI agent powered by the GitHub Copilot SDK, capable of conversing with the user and reading/writing notes in the vault.

## Overview

Knowledge workers using Obsidian today have limited options for AI-powered note authoring. The most popular community plugin offers strong read/index/Q&A capabilities but disables write actions on its free tier. Users who already have a GitHub Copilot subscription cannot leverage that capacity to edit their vault, and instead must paste content between Obsidian and an external chat client, losing context and breaking flow.

This work delivers v0.1 of a new Obsidian plugin: a persistent chat panel inside Obsidian where a user can converse with an agent that has read and write access to their vault. The agent runs on the GitHub Copilot SDK, authenticated via the same OAuth flow the GitHub CLI uses, so it draws on the user's existing Copilot subscription with no separate API keys or per-token costs. The agent can read notes to ground its answers, then create, edit, or delete notes when the user asks it to — with safety controls modeled on the GitHub Copilot CLI (per-action approval prompts, "allow all for this session" escape hatches, path allowlists, and undo for applied changes).

The first release deliberately targets desktop only and does not include vault-wide semantic indexing. Retrieval is performed by tools the agent invokes on demand (read/list/grep) rather than by a precomputed embedding index. This keeps v0.1 scope narrow while still being immediately useful: a user can ask "summarize my notes from last week" or "rewrite this paragraph in active voice and save it" and the agent will execute end-to-end without leaving Obsidian.

## Objectives

- Enable a user with a GitHub Copilot subscription to converse with an AI agent inside Obsidian using their existing GitHub identity (no PATs, no per-provider API keys).
- Allow the agent to read content from the user's vault on demand to ground its responses in the user's notes.
- Allow the agent to create, modify, and delete notes in the vault under user-controlled safety policies.
- Make all destructive actions reversible by the user immediately after they occur, until the chat session ends.
- Constrain the agent's filesystem access to the active vault — it must not be able to read or modify files outside the vault.
- Ship as a normal Obsidian community-style plugin that can be installed on any desktop Obsidian instance (Windows, macOS, Linux).

## User Scenarios & Testing

### User Story P1 – Connect to GitHub and start chatting
**Narrative**: A user installs the plugin, opens it, clicks "Connect to GitHub", completes OAuth in their browser, returns to Obsidian, and immediately sees a chat panel where they can type a message and receive a response from an AI model.

**Independent Test**: From a freshly installed plugin with no stored credentials, the user can complete OAuth and successfully exchange one message with the agent.

**Acceptance Scenarios**:
1. Given the plugin is installed and not yet authenticated, when the user opens the chat panel, then they see a "Connect to GitHub" call to action and no input field.
2. Given the user clicks "Connect to GitHub", when the OAuth flow completes successfully, then the chat panel transitions to an authenticated state showing a message input.
3. Given an authenticated session, when the user submits a message, then the agent's response is rendered with Markdown formatting in the chat panel.
4. Given the user restarts Obsidian, when they reopen the plugin, then their authentication persists and they do not have to re-authenticate.

### User Story P2 – Agent reads from the vault to answer questions
**Narrative**: The user asks the agent a question that requires knowledge of their vault contents (e.g., "What did I write about Project Atlas last month?"). The agent autonomously decides to read or search files, consults them, and produces a grounded answer that cites the notes it consulted.

**Independent Test**: With at least one note containing the searched-for content, the user can ask a content-grounded question and receive an answer that demonstrably reflects the note's contents.

**Acceptance Scenarios**:
1. Given the vault contains note(s) relevant to a user query, when the user asks about that content, then the agent invokes a read or search tool and produces an answer that incorporates information from the relevant note(s).
2. Given the agent invokes a tool, when the tool runs, then the chat UI displays which tool was invoked and its arguments, in a collapsible block, so the user can verify the agent's actions.
3. Given the agent attempts to access a file outside the vault, then the access is denied and the agent is informed of the failure.

### User Story P3 – Agent edits the vault on the user's behalf
**Narrative**: The user asks the agent to make a change to their vault (e.g., "Create a new note titled 'Meeting Notes 2026-06-02' with these bullets..." or "Rewrite the second paragraph of my Atlas note in active voice"). The agent executes the change and the user can see the result in Obsidian immediately.

**Independent Test**: The user can issue a single message that results in a verifiable file change in the vault (file created, file modified, or file deleted) and observe that change in Obsidian's file explorer.

**Acceptance Scenarios**:
1. Given the user asks the agent to create a new note, when the agent invokes its create-file tool, then a new file appears in the vault with the requested content and the action is logged in the chat as a tool call.
2. Given the user asks the agent to modify an existing note, when the agent invokes its edit tool, then the file contents change and Obsidian's open editor reflects the new content (or warns of conflicts if the user has unsaved changes).
3. Given the user asks the agent to delete a note, when the delete tool runs, then the file is removed from the vault.
4. Given any successful write, modify, or delete tool call, when it is rendered in the chat, then an "Undo" affordance is present and clicking it reverses the change.

### User Story P4 – User controls write-safety policy
**Narrative**: The user wants the agent to be helpful but not destructive. By default, every write/edit/delete action is auto-applied with an Undo button, but the user can tighten this behavior (require approval before each action) or loosen it (skip Undo prompts and allow all actions in the current session, or pre-allowlist specific paths).

**Independent Test**: The user can change the safety policy in settings or via an in-chat control, then issue a request that triggers a write tool, and observe that the configured policy was honored.

**Acceptance Scenarios**:
1. Given the default safety policy, when the agent invokes a write tool, then the action is applied immediately and an Undo affordance appears in the chat.
2. Given the user has enabled "require approval", when the agent invokes a write tool, then the action is staged but not applied; the chat displays an Approve / Reject control; the file is unchanged until the user approves.
3. Given the user clicks "Allow all for this session" on an approval prompt, when subsequent write tool calls occur in the same session, then they auto-apply without further prompting.
4. Given the user has configured a path allowlist (e.g., `/inbox/`), when the agent attempts to write within an allowlisted path, then no approval is required even if the global default is "require approval".
5. Given the user reloads or restarts the plugin, then session-level approvals reset (the "allow all for this session" escape hatch does not persist).

### User Story P5 – Conversation history persists across restarts
**Narrative**: The user has a conversation, closes Obsidian, reopens it, and finds the conversation still there. They can continue the conversation or clear it.

**Independent Test**: A multi-message exchange survives a restart of Obsidian and is still visible and continuable when the user reopens the plugin.

**Acceptance Scenarios**:
1. Given a chat session with at least one user message and one agent response, when Obsidian is restarted, then the messages are still rendered when the chat panel is reopened.
2. Given a persisted chat history, when the user clicks "Clear conversation", then the history is removed and a fresh session begins.

### Edge Cases

- The user has no internet connection or the GitHub Models endpoint is unreachable: the chat clearly indicates the failure and the user can retry.
- The user's OAuth token has been revoked externally: the plugin detects authentication failure on the next request and prompts re-authentication without losing the in-memory chat history.
- The agent attempts a write to a non-existent directory within the vault: any missing intermediate directories are created automatically as part of the write, consistent with how a user creating a note at a nested path in Obsidian behaves.
- The agent attempts a write to a path that contains `..` or other path-traversal sequences resolving outside the vault: rejected with an error.
- A user has an open editor with unsaved changes when the agent edits the same file: the agent's change must not silently discard the user's unsaved work; either Obsidian's normal conflict-handling applies or the agent's tool call fails with a clear message.
- The agent's response is interrupted (network error, user cancels): the partial response remains in chat history with a clear "interrupted" marker; the conversation can continue.
- The Copilot SDK reports the user's GitHub identity does not have access to the model in question: the chat displays a clear error explaining the situation and how to resolve it.
- The vault is on a synced location (iCloud, Dropbox, etc.) and a write conflicts with sync: out of scope for v0.1; agent edits are subject to the same sync risks any other write would have.

## Requirements

### Functional Requirements
- **FR-001**: The plugin SHALL provide a Connect to GitHub action that initiates an OAuth Device Flow against GitHub and obtains a long-lived user-to-server token. (Stories: P1)
- **FR-002**: The plugin SHALL persist the obtained authentication token securely on the user's machine such that it survives Obsidian restarts. (Stories: P1, P5)
- **FR-003**: The plugin SHALL provide a chat panel UI within Obsidian (right sidebar by default, repositionable per Obsidian's normal pane behavior) containing a scrollable transcript and a message input. (Stories: P1, P2, P3, P5)
- **FR-004**: The plugin SHALL render assistant responses with Markdown formatting consistent with Obsidian's note rendering. (Stories: P1)
- **FR-005**: The plugin SHALL stream assistant responses incrementally to the chat panel as they are produced by the model, rather than waiting for the full response. (Stories: P1)
- **FR-006**: The plugin SHALL expose to the agent a set of read tools scoped to the active vault: read a file by path, list files in a directory, and search file contents by substring or pattern. (Stories: P2)
- **FR-007**: The plugin SHALL expose to the agent a set of write tools scoped to the active vault: create a new file, modify an existing file, and delete a file. (Stories: P3)
- **FR-008**: The plugin SHALL reject any tool invocation whose target path resolves outside the active vault root. (Stories: P2, P3)
- **FR-009**: The chat UI SHALL render each tool invocation as a labeled, collapsible block showing the tool name and its arguments. (Stories: P2, P3)
- **FR-010**: For each successfully applied write tool call, the chat UI SHALL display an Undo affordance whose activation reverses the change for the duration of the active chat session. (Stories: P3)
- **FR-011**: The plugin SHALL support a configurable write-safety policy with at least the following modes: auto-apply with Undo (default), require approval before each action, and "allow all for this session" override. (Stories: P4)
- **FR-012**: The plugin SHALL support a path allowlist in settings; tool calls whose target path matches an entry in the allowlist SHALL bypass approval requirements regardless of the active policy. (Stories: P4)
- **FR-013**: Session-scoped approval grants (e.g., "allow all for this session") SHALL be discarded when the plugin reloads, the chat session is cleared, or Obsidian restarts. (Stories: P4)
- **FR-014**: The chat history (user messages, assistant messages, and tool-call records) SHALL persist across Obsidian restarts within the active vault. (Stories: P5)
- **FR-015**: The plugin SHALL provide a "Clear conversation" action that removes the current chat history. (Stories: P5)
- **FR-016**: The plugin SHALL allow the user to select which model the agent uses, from the set of models available via the GitHub Copilot SDK to that user, with a sensible default. (Stories: P1)
- **FR-017**: The plugin manifest SHALL declare the plugin as desktop-only; it SHALL NOT load or operate on Obsidian mobile. (Stories: All)
- **FR-018**: When an authentication failure occurs at any point after initial connection, the plugin SHALL surface a clear error in the chat and offer a Reconnect action that re-runs the OAuth flow. (Stories: P1)

### Key Entities
- **Auth Session**: The persisted state of a user's connection to GitHub Models — the OAuth token plus minimum metadata needed to validate it.
- **Chat Session**: An ordered transcript of user messages, assistant messages, and tool-call records, plus session-scoped state (e.g., active "allow all" grant).
- **Tool Invocation Record**: A single agent-initiated tool call with name, arguments, result/error, and (for write tools) an undo handle.
- **Safety Policy**: User-configurable rules governing whether write tool calls auto-apply, require approval, or are allowlisted.

### Cross-Cutting / Non-Functional
- The plugin's filesystem operations MUST be confined to the active vault root; path traversal attempts MUST be rejected.
- Tokens MUST be stored using the most secure mechanism the Obsidian plugin sandbox makes practical (final mechanism to be determined in code research; minimum bar is per-vault `loadData`/`saveData` rather than any world-readable location).
- The plugin MUST NOT block Obsidian's UI thread during model calls or tool execution.
- The plugin MUST function on Obsidian desktop versions consistent with the SDK's runtime requirements (specific minimum Obsidian/Node versions to be confirmed in code research).

## Success Criteria

- **SC-001**: A new user can install the plugin, complete the GitHub OAuth flow, and exchange at least one message with the agent end-to-end. (FR-001, FR-002, FR-003, FR-004)
- **SC-002**: An authenticated user can ask a question that requires reading at least one vault note, and the agent's response demonstrably incorporates content from that note. (FR-006, FR-009)
- **SC-003**: An authenticated user can issue a single chat message that results in a vault file being created, modified, or deleted, with the change visible in Obsidian's file explorer. (FR-007, FR-009)
- **SC-004**: An authenticated user can undo any single applied write/edit/delete tool call from the chat UI and observe the vault returning to its prior state. (FR-010)
- **SC-005**: An authenticated user can switch the write-safety policy to "require approval", request a write, and verify that no file change occurs until they explicitly approve. (FR-011)
- **SC-006**: An attempt by the agent to read or write a path that escapes the active vault root is refused, the refusal is observable in chat, and no filesystem change occurs outside the vault. (FR-008)
- **SC-007**: After Obsidian is closed and reopened, the user's authentication and chat history from the previous session are present without re-authentication or manual restoration. (FR-002, FR-014)
- **SC-008**: An authenticated user can select a different available model in settings and the next agent response is produced by the newly selected model (verifiable via the chat session's metadata or a model-identifying response). (FR-016)
- **SC-009**: Loading the plugin on Obsidian mobile does not load the plugin's runtime; the user is informed in a non-disruptive way (e.g., the plugin manifest's desktop-only flag prevents installation, or a graceful no-op message is displayed). (FR-017)

## Assumptions
- Streaming responses are expected and the SDK supports a streaming mode; if it does not, the spec's streaming requirement (FR-005) downgrades to "render the response promptly when complete".
- A single chat thread per vault is sufficient for v0.1; multi-conversation support (named conversations, switching between them) is deferred.
- The agent's tool surface is limited to filesystem operations on the vault. Web search, shell execution, and arbitrary tool registration are deferred.
- The GitHub Copilot SDK exposes an API for registering custom tools and receives tool-result responses in a multi-turn loop; this is consistent with the agent loop the SDK powers in Copilot CLI.
- Token storage via Obsidian's `loadData`/`saveData` (which writes to the vault's `.obsidian/` plugin data) is the v0.1 baseline; OS-keychain integration may be evaluated in code research and adopted if practical, but is not a v0.1 hard requirement.
- The agent's writes go through Obsidian's plugin filesystem APIs (Vault adapter) rather than raw `fs` calls, ensuring consistency with Obsidian's open-editor and link-update behaviors.
- "Undo for the duration of the active chat session" means: the undo button works as long as the chat session has not been cleared and Obsidian has not been restarted. Cross-restart undo is out of scope.
- The user is responsible for the contents and visibility of notes the agent reads and sends to the model; v0.1 does not implement per-folder data-residency redaction.

## Scope

**In Scope**:
- OAuth Device Flow authentication via the GitHub CLI's OAuth client identifier.
- Persistent right-sidebar chat view with Markdown rendering and streaming.
- Vault-scoped read tools (read file, list files, search content).
- Vault-scoped write tools (create, edit, delete) with path containment.
- Configurable write-safety policy (auto-apply with Undo / require approval / allowlist) with session-scoped overrides.
- Per-tool-call Undo for applied writes within the active session.
- Persistent chat history per vault.
- User-selectable model from the SDK's available models, with a default.
- Desktop-only manifest; graceful behavior when loaded on mobile (refusal or no-op).

**Out of Scope** (deferred to later work units):
- Vault-wide semantic embeddings or precomputed retrieval index.
- Mobile (iOS / Android) support.
- Multiple concurrent chat threads / conversation switching.
- Tools beyond filesystem (web search, shell exec, MCP server integration).
- Cross-restart undo or full transactional grouping of multi-step writes.
- Per-note privacy controls / redaction before sending to the model.
- Bring-your-own-model providers other than GitHub Copilot SDK (OpenAI direct, Anthropic direct, local Ollama).
- Sync-conflict resolution beyond what Obsidian's normal write path provides.
- Publishing to the official Obsidian community plugins directory (BRAT or manual install is sufficient for v0.1).

## Dependencies
- **GitHub Copilot SDK** (`@github/copilot-sdk` or equivalent package name as confirmed in code research) for agent loop, tool registration, model invocation, and streaming.
- **Obsidian Plugin API** (`obsidian` package) for plugin lifecycle, Vault adapter, ItemView, MarkdownRenderer, and settings UI.
- **GitHub OAuth Device Flow endpoints** (`github.com/login/device/code`, `github.com/login/oauth/access_token`) for authentication.
- **GitHub Copilot subscription** held by the end user (personal or enterprise) — without this, the user has no model access regardless of plugin behavior.
- **Reference plugin** `logancyang/obsidian-copilot` (AGPL-3.0) for structural reference on Obsidian chat-pane UX. No code is copied; license isolation is enforced.

## Risks & Mitigations
- **Risk**: GitHub Copilot SDK is not yet stable and its public API may change between versions.  
  **Impact**: High — could require rework if API surfaces shift.  
  **Mitigation**: Pin a specific SDK version. Wrap the SDK behind an internal interface so future version bumps localize to one module.
- **Risk**: The Copilot SDK is designed for Node CLI environments and may rely on capabilities not present in Obsidian's Electron plugin sandbox (subprocesses, certain native modules, or specific token-storage paths).  
  **Impact**: High — could block the entire approach.  
  **Mitigation**: Validate SDK loadability and basic session creation as the first implementation milestone before building the full chat UI. If a hard incompatibility surfaces, escalate before further investment.
- **Risk**: GitHub's OAuth Device Flow for the GitHub CLI client identifier may not return tokens with sufficient scope for the GitHub Models API on every account class (e.g., enterprise SSO, restricted orgs).  
  **Impact**: Medium — some users would be unable to authenticate.  
  **Mitigation**: Confirm scopes during code research. If the CLI client cannot be reused, fall back to creating a dedicated OAuth app for the plugin.
- **Risk**: Write tools that call Obsidian's Vault APIs while a user has the same file open with unsaved changes could corrupt or silently overwrite their work.  
  **Impact**: High (user trust).  
  **Mitigation**: Use Obsidian's recommended write APIs that participate in editor-state conflict handling. Surface conflicts as tool errors in chat rather than silently winning.
- **Risk**: Path containment bugs could allow the agent to escape the vault root via symlinks, normalized path tricks, or absolute paths.  
  **Impact**: High (security and trust).  
  **Mitigation**: Centralize all path resolution in a single tool wrapper; resolve to absolute paths and verify the resolved path is a descendant of the vault root before any I/O. Add unit tests targeting traversal patterns.
- **Risk**: Persisted authentication tokens stored via plain `loadData`/`saveData` are world-readable to anyone with filesystem access to the user's vault.  
  **Impact**: Medium — users with synced vaults effectively share the token with sync providers.  
  **Mitigation**: Document this limitation in the README; investigate keychain integration in code research as a follow-up; consider a "do not persist token" setting for high-security users.
- **Risk**: Streaming + tool-call interleaving in the chat UI is complex; a partially-streamed response interrupted by a tool call can render incoherently.  
  **Impact**: Medium (UX).  
  **Mitigation**: Adopt a clear render model in planning that handles message deltas and tool-call boundaries deterministically; reference `logancyang/obsidian-copilot`'s structure (without copying code).

## References
- Issue: none
- Research: (none required at spec stage; technical investigation deferred to `paw-code-research`)
- Reference plugin: <https://github.com/logancyang/obsidian-copilot> (AGPL-3.0; structural reference only)
- Obsidian Plugin API: <https://docs.obsidian.md/Plugins>
- GitHub OAuth Device Flow: <https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps#device-flow>
