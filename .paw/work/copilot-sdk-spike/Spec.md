# Feature Specification: Obsidian Copilot Agent — v0.1

**Branch**: feature/copilot-sdk-spike  |  **Created**: 2026-06-02  |  **Status**: Draft
**Input Brief**: An Obsidian desktop plugin that embeds an AI agent powered by the GitHub Copilot SDK, capable of conversing with the user, reading/writing notes in the vault, acting on user-configured filesystem roots beyond the vault (e.g., source repositories), and invoking MCP-server tools and built-in CLI tools — all under a uniform per-call approval gate.

## Overview

Knowledge workers using Obsidian today have limited options for AI-powered note authoring. The most popular community plugin offers strong read/index/Q&A capabilities but disables write actions on its free tier. Users who already have a GitHub Copilot subscription cannot leverage that capacity to edit their vault, and instead must paste content between Obsidian and an external chat client, losing context and breaking flow.

This work delivers v0.1 of a new Obsidian plugin: a persistent chat panel inside Obsidian where a user can converse with an agent that has read/write access to their vault and to additional filesystem roots they configure (such as local source repositories), and that can invoke MCP-server tools and the GitHub Copilot SDK's built-in CLI tools (shell, web-fetch, host-filesystem). The agent runs on the GitHub Copilot SDK, authenticated via the same OAuth flow the GitHub CLI uses, so it draws on the user's existing Copilot subscription with no separate API keys or per-token costs. Every tool call — vault, extra-vault, MCP, or built-in — flows through a uniform safety policy modeled on the GitHub Copilot CLI: per-action approval prompts, "allow all for this session" escape hatches, path/scope allowlists, and undo for applied filesystem writes.

The first release deliberately targets desktop only and does not include vault-wide semantic indexing. Retrieval is performed by tools the agent invokes on demand (read/list/grep) rather than by a precomputed embedding index. This keeps v0.1 scope narrow on retrieval while still delivering a knowledge-worker-grade integration: a user can ask "summarize my notes from last week," "rewrite this paragraph in active voice and save it," "open the README in `C:\Repos\my-project` and add a section on the new feature," or "list my open ADO work items" (via an MCP server) and the agent will execute end-to-end without leaving Obsidian.

## Objectives

- Enable a user with a GitHub Copilot subscription to converse with an AI agent inside Obsidian using their existing GitHub identity (no PATs, no per-provider API keys).
- Allow the agent to read content from the user's vault and from user-configured extra-vault filesystem roots on demand to ground its responses.
- Allow the agent to create, modify, and delete files in the vault and in those extra-vault roots under user-controlled safety policies.
- Allow the agent to invoke MCP-server tools (configured via a standard JSON config file) under the same safety policy.
- Allow the agent to invoke the SDK's built-in CLI tools (shell, web-fetch, host-filesystem) under the same safety policy — built-ins are not blocked; they are gated.
- Make all destructive filesystem actions reversible by the user immediately after they occur, until the chat session ends.
- Ensure that any tool call outside an approved scope (vault, configured extra-vault roots, configured MCP servers, built-in tools) is gated by the per-call approval flow rather than implicitly allowed.
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
**Narrative**: The user wants the agent to be helpful but not destructive. By default, every write/edit/delete action requires explicit approval before it is applied, but the user can loosen this behavior (auto-apply with Undo to act first and revert if needed, skip Undo prompts and allow all actions in the current session, or pre-allowlist specific paths). [Amended after Phase 6: the v0.1 default was changed from auto-apply-with-undo to require-approval as the conservative onboarding choice once the inline approval-prompt UI landed; users opt into auto-apply explicitly. Future versions may revisit.]

**Independent Test**: The user can change the safety policy in settings or via an in-chat control, then issue a request that triggers a write tool, and observe that the configured policy was honored.

**Acceptance Scenarios**:
1. Given the default safety policy (require approval), when the agent invokes a write tool, then the action is staged but not applied; the chat displays an Approve / Reject control; the file is unchanged until the user approves. After approval, the call applies and an Undo affordance appears in the chat.
2. Given the user has switched to "auto-apply with Undo", when the agent invokes a write tool, then the action is applied immediately and an Undo affordance appears in the chat.
3. Given the user clicks "Allow all for this session" on an approval prompt, when subsequent write tool calls occur in the same session, then they auto-apply without further prompting.
4. Given the user has configured a path allowlist (e.g., `/inbox/`), when the agent attempts to write within an allowlisted path, then no approval is required even if the global default is "require approval".
5. Given the user reloads or restarts the plugin, then session-level approvals reset (the "allow all for this session" escape hatch does not persist).

### User Story P5 – Conversation history persists across restarts
**Narrative**: The user has a conversation, closes Obsidian, reopens it, and finds the conversation still there with full context. They can continue the conversation and reference earlier turns, and the agent retains its model-side context from the previous session.

**Independent Test**: A multi-message exchange survives a restart of Obsidian. After restart, the user can ask "what was my project name?" referencing a name mentioned only in the pre-restart turns and the agent answers correctly.

**Acceptance Scenarios**:
1. Given a chat session with at least one user message and one agent response, when Obsidian is restarted, then the messages are still rendered when the chat panel is reopened.
2. Given a persisted chat session, when the user sends a new message after restart, then the agent's response demonstrates awareness of pre-restart turns (e.g., correctly references a name or fact mentioned earlier).
3. Given a persisted chat history, when the user clicks "Clear conversation", then the history is removed and a fresh session begins.

### User Story P6 – Agent acts in user-configured extra-vault filesystem roots
**Narrative**: The user configures one or more filesystem roots beyond the vault (e.g., `C:\Repos\`) in plugin settings. The agent can read and write files within those roots using the same tools and the same safety policy as for the vault. Paths outside any allowed root are rejected.

**Independent Test**: With `C:\Repos\my-project\` configured as an extra-vault root, the user can ask "open the README in my-project and add a 'Roadmap' heading" and observe the file change on disk.

**Acceptance Scenarios**:
1. Given the user has configured `C:\Repos\` as an extra-vault root, when the agent invokes a write tool against a path inside `C:\Repos\`, then the same auto-apply-with-undo (or require-approval) flow applies as for vault writes.
2. Given the agent invokes a read or write tool against a path outside both the vault and any configured extra-vault root, then the tool call is rejected with a clear error.
3. Given a write to an extra-vault root completes, then an Undo affordance is present in the chat that reverses the change for the duration of the active chat session.

### User Story P7 – Agent uses MCP server tools
**Narrative**: The user has an MCP server configured (e.g., an Azure DevOps MCP server) via a standard JSON config file. The plugin discovers it on startup and surfaces its tools to the agent. The agent can call those tools subject to the same approval gate as the plugin's own tools.

**Independent Test**: With a working MCP server configured, the user can ask the agent to perform a task that requires the MCP server's tools (e.g., "list my open work items") and observe the tool call in the chat with arguments and results.

**Acceptance Scenarios**:
1. Given a JSON config file declaring an MCP server, when the plugin starts, then the MCP server's tools are surfaced to the agent and visible in any "available tools" enumeration.
2. Given the agent invokes an MCP tool, when the safety policy applies, then the same per-call approval flow runs (approve once / approve for session / reject) as for any other tool.
3. Given a malformed MCP config file, when the plugin starts, then the failure is surfaced clearly in chat or settings without preventing the rest of the plugin from working.

### User Story P8 – Agent uses built-in SDK tools (shell, web-fetch, host-fs) with approval
**Narrative**: The agent can invoke the GitHub Copilot SDK's built-in CLI tools — including shell execution, web-fetch, and host-filesystem read/write — when they help the user. Each call goes through the same approval gate as custom tools. Built-ins are not disabled; they are gated.

**Independent Test**: The user can ask the agent to do something that requires shell execution (e.g., "run `git status` in `C:\Repos\my-project`"). The agent's tool call surfaces an approval prompt; on approve, the command runs and the output is reported back.

**Acceptance Scenarios**:
1. Given the agent invokes a built-in tool (e.g., `shell`), when the safety policy is "require approval" or the tool's scope is not pre-approved, then the user is prompted before the tool runs.
2. Given the user clicks "Approve all for this session" on a built-in tool prompt, when subsequent built-in tool calls occur in the same session, then they auto-apply without further prompting.
3. Given the user clicks Reject on a built-in tool prompt, then the tool does not run and the agent receives an error result.

### Edge Cases

- The user has no internet connection or the GitHub Models endpoint is unreachable: the chat clearly indicates the failure and the user can retry.
- The user's OAuth token has been revoked externally: the plugin detects authentication failure on the next request and prompts re-authentication without losing the in-memory chat history.
- The agent attempts a write to a non-existent directory within an allowed root: any missing intermediate directories are created automatically as part of the write, consistent with how a user creating a note at a nested path in Obsidian behaves.
- The agent attempts a write to a path that contains `..` or other path-traversal sequences resolving outside all allowed roots: rejected with an error.
- A user has an open editor with unsaved changes when the agent edits the same file: the agent's change must not silently discard the user's unsaved work; either Obsidian's normal conflict-handling applies or the agent's tool call fails with a clear message.
- The agent's response is interrupted (network error, user cancels): the partial response remains in chat history with a clear "interrupted" marker; the conversation can continue.
- The Copilot SDK reports the user's GitHub identity does not have access to the model in question: the chat displays a clear error explaining the situation and how to resolve it.
- The vault is on a synced location (iCloud, Dropbox, etc.) and a write conflicts with sync: out of scope for v0.1; agent edits are subject to the same sync risks any other write would have.
- An MCP server crashes or hangs: the plugin surfaces the failure as a tool error in chat and continues to function for non-MCP tools.
- A built-in shell tool call would run a destructive command (e.g., `rm -rf`): the per-call approval prompt surfaces the exact command before any execution occurs, giving the user the opportunity to reject.
- An extra-vault root configured by the user no longer exists at startup: the root is reported as unavailable in settings; tool calls targeting it return a clear error.
- Cross-restart `resumeSession` fails (corrupted SDK state, version mismatch): the plugin falls back to display-only history with a clear chat indicator that the prior context could not be resumed; the user can continue with a fresh session.

## Requirements

### Functional Requirements
- **FR-001**: The plugin SHALL provide a Connect to GitHub action that initiates an OAuth Device Flow against GitHub and obtains a long-lived user-to-server token. (Stories: P1)
- **FR-002**: The plugin SHALL persist the obtained authentication token securely on the user's machine such that it survives Obsidian restarts. The plugin SHALL also support a "do not persist token" mode in which the token is held only in memory and the user re-authenticates at every plugin load. (Stories: P1, P5)
- **FR-003**: The plugin SHALL provide a chat panel UI within Obsidian (right sidebar by default, repositionable per Obsidian's normal pane behavior) containing a scrollable transcript and a message input. (Stories: P1, P2, P3, P5)
- **FR-004**: The plugin SHALL render assistant responses with Markdown formatting consistent with Obsidian's note rendering. (Stories: P1)
- **FR-005**: The plugin SHALL stream assistant responses incrementally to the chat panel as they are produced by the model, rather than waiting for the full response. (Stories: P1)
- **FR-006**: The plugin SHALL expose to the agent a set of filesystem read tools (read a file by path, list files in a directory, search file contents by substring or pattern) whose effective scope covers the active vault and any user-configured extra-vault filesystem roots. (Stories: P2, P6)
- **FR-007**: The plugin SHALL expose to the agent a set of filesystem write tools (create a new file, modify an existing file, delete a file) whose effective scope covers the active vault and any user-configured extra-vault filesystem roots. (Stories: P3, P6)
- **FR-008**: The plugin SHALL reject any filesystem tool invocation whose target path resolves outside the union of (the active vault root) and (the user-configured extra-vault roots). Path-traversal sequences (`..`, etc.) that escape all allowed roots SHALL be rejected. (Stories: P2, P3, P6)
- **FR-009**: The chat UI SHALL render each tool invocation (filesystem, MCP, or built-in) as a labeled, collapsible block showing the tool name, its scope/source, and its arguments. (Stories: P2, P3, P6, P7, P8)
- **FR-010**: For each successfully applied filesystem write tool call (vault or extra-vault root), the chat UI SHALL display an Undo affordance whose activation reverses the change for the duration of the active chat session. (Stories: P3, P6)
- **FR-011**: The plugin SHALL support a configurable safety policy that applies uniformly to filesystem-write, MCP, and built-in tool calls, with at least the following modes: require approval before each action (**default for v0.1**), auto-apply with Undo, and "allow all for this session" override. [Amended after Phase 6: default changed from auto-apply-with-undo to require-approval — see User Story P4 narrative.] (Stories: P4, P7, P8)
- **FR-012**: The plugin SHALL allow the user to configure persistent trust scopes that bypass per-call approval prompts. Three independent kinds:
  1. **Path allowlist** — newline-separated entries; each entry is either a vault-relative directory (no leading slash, e.g., `inbox/`) or an absolute filesystem path matching a configured extra-vault root (e.g., `C:\Repos\my-project\sandbox\`). Filesystem write/read tool calls whose resolved target is at or below an allowlisted path skip the approval prompt.
  2. **Built-in tool toggles** — per-tool boolean checkboxes (e.g., "Auto-approve all `shell` calls", "Auto-approve all `web_fetch` calls"). When enabled, calls to that built-in skip the approval prompt; the user can revoke by unchecking. Defaults are off.
  3. **MCP server toggles** — per-server boolean checkboxes (one per server defined in `mcp_servers.json`, e.g., "Auto-approve all calls to `ado`"). Same behavior as built-in toggles. Defaults are off.
  All three kinds are persisted in plugin settings; "Approve for session" runtime clicks are layered on top and live in-memory only. (Stories: P3, P4, P7, P8)
- **FR-013**: Session-scoped approval grants (e.g., "allow all for this session") SHALL be discarded when the plugin reloads, the chat session is cleared, or Obsidian restarts. They SHALL NOT be discarded merely because the chat view (pane) is closed and reopened. (Stories: P4)
- **FR-014**: The chat history (user messages, assistant messages, and tool-call records) SHALL persist across Obsidian restarts within the active vault. (Stories: P5)
- **FR-015**: The plugin SHALL provide a "Clear conversation" action that removes the current chat history and resets session-scoped state. (Stories: P5)
- **FR-016**: The plugin SHALL allow the user to select which model the agent uses, from the set of models available via the GitHub Copilot SDK to that user, with a sensible default. Switching the active model SHALL cause the next user message to be sent to a session that uses the newly selected model. (Note: the SDK has no in-place model swap; switching the model implies tearing down and recreating the SDK session, which resets model-side context; this is documented in user-facing settings copy.) (Stories: P1)
- **FR-017**: The plugin manifest SHALL declare the plugin as desktop-only; it SHALL NOT load or operate on Obsidian mobile. (Stories: All)
- **FR-018**: When an authentication failure occurs at any point after initial connection, the plugin SHALL surface a clear error in the chat and offer a Reconnect action that re-runs the OAuth flow. (Stories: P1)
- **FR-019**: The plugin SHALL discover MCP servers from a JSON configuration file (e.g., `mcp_servers.json`) placed in a documented location, surface their tools to the agent on startup, and gate every MCP tool call through the same safety policy as custom tools. The plugin SHALL surface MCP-server startup or tool-discovery failures as visible errors in chat or settings without blocking the rest of the plugin. (Stories: P7)
- **FR-020**: The plugin SHALL not blanket-disable the GitHub Copilot SDK's built-in CLI tools. It SHALL override only the FS-overlapping built-ins (`read_file`, `edit_file`, and any others whose name collides with a custom vault-aware tool) using `overridesBuiltInTool: true`; the override implementation acts as a smart dispatcher — if the resolved path is inside the active vault, it routes through Obsidian's Vault adapter (preserving open-editor conflict detection, link updates, and metadata refresh); if the path resolves inside a configured extra-vault root, it uses Node `fs`; if the path is outside both, it is refused per FR-008. All non-FS built-ins (`shell`, `web_fetch`, `view`, `memory`, etc.) remain enabled and are gated through the same approval pipeline (`onPermissionRequest`) as custom and MCP tools. (Stories: P8)
- **FR-021**: The plugin SHALL provide a settings UI for adding, viewing, and removing extra-vault filesystem roots (absolute OS paths). Tool calls whose target resolves within any configured root participate in the same write-safety / undo / allowlist pipeline as vault-internal calls. (Stories: P6)
- **FR-022**: Read-only custom tools whose targets are strictly inside a path-validated, pre-declared scope (vault root for v0.1; extra-vault roots when added) MAY bypass the per-call approval prompt by registering with `skipPermission: true`. The deny-by-default invariant continues to apply to every other category (writes, MCP, shell, web_fetch, view, memory, etc.). Tool authors deciding whether to use this exemption MUST satisfy the checklist documented in `src/tools/ReadTools.ts`: strict read-only, validated path inputs, bounded resource scope, no symlink-escape, no unbounded walks. (Stories: P2)

### Key Entities
- **Auth Session**: The persisted state of a user's connection to GitHub Models — the OAuth token plus minimum metadata needed to validate it. May be ephemeral if the user enables "do not persist token".
- **Chat Session**: An ordered transcript of user messages, assistant messages, and tool-call records, plus session-scoped state (e.g., active "allow all" grants per scope, in-memory undo journal handles).
- **Tool Invocation Record**: A single agent-initiated tool call with name, source (custom / MCP / built-in), arguments, result/error, and (for filesystem writes) an undo handle.
- **Safety Policy**: User-configurable rules governing whether a tool call (filesystem write, MCP, or built-in) auto-applies, requires approval, or is allowlisted.
- **Extra-Vault Root**: A user-configured absolute filesystem path outside the active vault within which filesystem read/write tools are permitted to operate, subject to the safety policy.
- **MCP Server Registration**: An entry in `mcp_servers.json` describing how to launch and connect to an MCP server; on startup the plugin discovers each server's tools and surfaces them through the agent's tool registry.
- **Built-in Tool**: A tool provided by the GitHub Copilot SDK / Copilot CLI itself (e.g., `shell`, `web_fetch`, host filesystem). Not implemented by this plugin; gated by this plugin.

### Cross-Cutting / Non-Functional
- The plugin's filesystem operations performed via custom tools MUST be confined to the union of the active vault root and the configured extra-vault roots; path traversal attempts that escape all of these MUST be rejected.
- Built-in tool calls (shell, host filesystem) are not statically restricted to a path scope (the user may legitimately want shell access). They MUST be gated by the per-call approval flow so the user sees and authorizes each call.
- Tokens MUST be stored using the most secure mechanism the Obsidian plugin sandbox makes practical (final mechanism to be determined in code research; minimum bar is per-vault `loadData`/`saveData` rather than any world-readable location). The "do not persist token" mode MUST keep the token only in memory.
- The plugin MUST NOT block Obsidian's UI thread during model calls or tool execution.
- The plugin MUST function on Obsidian desktop versions consistent with the SDK's runtime requirements (specific minimum Obsidian/Node versions to be confirmed in code research).

## Success Criteria

- **SC-001**: A new user can install the plugin, complete the GitHub OAuth flow, and exchange at least one message with the agent end-to-end. (FR-001, FR-002, FR-003, FR-004)
- **SC-002**: An authenticated user can ask a question that requires reading at least one vault note, and the agent's response demonstrably incorporates content from that note. (FR-006, FR-009)
- **SC-003**: An authenticated user can issue a single chat message that results in a vault file being created, modified, or deleted, with the change visible in Obsidian's file explorer. (FR-007, FR-009)
- **SC-004**: An authenticated user can undo any single applied filesystem write/edit/delete tool call from the chat UI and observe the file returning to its prior state — for both vault and extra-vault writes. (FR-010)
- **SC-005**: An authenticated user can switch the safety policy to "require approval", request a write, and verify that no file change occurs until they explicitly approve. (FR-011)
- **SC-006**: An attempt by the agent to read or write a path that resolves outside both the active vault and all configured extra-vault roots is refused, the refusal is observable in chat, and no filesystem change occurs at the targeted path. (FR-008)
- **SC-007**: After Obsidian is closed and reopened, the user's authentication and chat history from the previous session are present, and a new user message demonstrates that the agent retains model-side context from pre-restart turns (e.g., correctly references a name introduced earlier). On `resumeSession` failure, the plugin falls back to display-only history with a clear chat indicator. (FR-002, FR-014)
- **SC-008**: An authenticated user can select a different available model in settings and the next user message is processed by a session using the newly selected model (verifiable via the chat session's metadata or a model-identifying response). The session recreation and resulting model-side context reset are surfaced to the user. (FR-016)
- **SC-009**: Loading the plugin on Obsidian mobile does not load the plugin's runtime; the user is informed in a non-disruptive way (e.g., the plugin manifest's desktop-only flag prevents installation, or a graceful no-op message is displayed). (FR-017)
- **SC-010**: With at least one extra-vault root configured (e.g., `C:\Repos\my-project\`), the user can ask the agent to read or write a file inside that root and observe the change on disk; an attempt to act on a path outside both the vault and any configured root is refused. (FR-006, FR-007, FR-008, FR-021)
- **SC-011**: With at least one MCP server configured in `mcp_servers.json`, the user can ask the agent to invoke one of its tools, observe the call (with arguments) in chat under the same approval flow as a vault write, and see the result. (FR-019)
- **SC-012**: The agent can invoke a built-in CLI tool (e.g., `shell` to run a benign command); the user is prompted before execution (unless a session-grant or allowlist applies); on approve, the command runs and the output is reported back. (FR-020)

## Assumptions
- Streaming responses are expected and the SDK supports a streaming mode; if it does not, the spec's streaming requirement (FR-005) downgrades to "render the response promptly when complete".
- A single chat thread per vault is sufficient for v0.1; multi-conversation support (named conversations, switching between them) is deferred.
- The agent's tool surface in v0.1 includes custom FS-overlap overrides (`read_file`, `edit_file`, etc., with smart vault/extra-vault dispatch), MCP-discovered tools, and the SDK's non-FS built-in CLI tools (`shell`, `web_fetch`, `view`, etc.) — all gated by the same approval pipeline. Arbitrary user-authored custom tool registration via UI is deferred.
- The GitHub Copilot SDK exposes an API for registering custom tools and receives tool-result responses in a multi-turn loop; this is consistent with the agent loop the SDK powers in Copilot CLI.
- The GitHub Copilot SDK supports a per-permission-request callback (`onPermissionRequest`) that fires for every tool call (custom, MCP-bridged, and built-in) and accepts return values mapping to approve-once / approve-for-session / reject. This is the foundation for FR-011 / FR-019 / FR-020.
- The GitHub Copilot SDK supports MCP server tool surfacing or, failing that, exposes enough primitives for the plugin to bridge MCP servers itself (start the MCP server process, list its tools, register them via `defineTool`). The exact mechanism is to be confirmed in code research.
- The GitHub Copilot SDK supports cross-restart session continuity (e.g., via a `resumeSession` API) such that the agent retains model-side context after an Obsidian restart. If this primitive is unavailable or unstable, the plugin falls back to display-only history with a clear user-facing indicator (still satisfying SC-007's first half).
- Token storage via Obsidian's `loadData`/`saveData` (which writes to the vault's `.obsidian/` plugin data) is the v0.1 baseline; OS-keychain integration may be evaluated in code research and adopted if practical, but is not a v0.1 hard requirement.
- The agent's vault writes go through Obsidian's plugin filesystem APIs (Vault adapter) rather than raw `fs` calls, ensuring consistency with Obsidian's open-editor and link-update behaviors. Extra-vault writes use Node `fs` APIs (Obsidian's Vault adapter is vault-scoped) and are not subject to Obsidian's open-editor semantics.
- "Undo for the duration of the active chat session" means: the undo button works as long as the chat session has not been cleared and Obsidian has not been restarted. Cross-restart undo is out of scope.
- The user is responsible for the contents and visibility of notes the agent reads and sends to the model; v0.1 does not implement per-folder data-residency redaction.
- For v0.1 the plugin uses the GitHub CLI's OAuth client identifier as a development convenience and is delivered as a private development spike with manual install only. This is documented to the user as a development posture (see §Risks); a dedicated OAuth App is required before any non-private distribution (BRAT, community store, or any install by users other than the work-unit author).

## Scope

**In Scope**:
- OAuth Device Flow authentication via a development OAuth client identifier (initially the GitHub CLI's), with a "do not persist token" option.
- Persistent right-sidebar chat view with Markdown rendering and streaming.
- Custom filesystem read tools (read file, list files, search content) covering the active vault and configured extra-vault roots.
- Custom filesystem write tools (create, edit, delete) covering the active vault and configured extra-vault roots, with path containment to the union of allowed roots.
- Configurable safety policy (auto-apply with Undo / require approval / allowlist) applied uniformly to filesystem write, MCP, and built-in tool calls, with session-scoped overrides.
- Per-tool-call Undo for applied filesystem writes (vault and extra-vault) within the active session.
- Persistent chat history per vault, plus cross-restart context continuity via SDK `resumeSession` (with display-only fallback on resume failure).
- User-selectable model from the SDK's available models, with a default; switching recreates the SDK session.
- Settings UI for managing extra-vault roots and the path/scope allowlist.
- MCP server discovery from a JSON config file and tool surfacing through the safety policy.
- Built-in CLI tools (shell, web-fetch, host-filesystem) gated through the safety policy (not blocked).
- Desktop-only manifest; graceful behavior when loaded on mobile (refusal or no-op).

**Out of Scope** (deferred to later work units):
- Vault-wide semantic embeddings or precomputed retrieval index.
- Mobile (iOS / Android) support.
- Multiple concurrent chat threads / conversation switching.
- MCP server credential management UI (users provide credentials via environment variables or per-server config in `mcp_servers.json`).
- User-authored custom tool registration via plugin UI.
- Cross-restart undo or full transactional grouping of multi-step writes.
- Per-note privacy controls / redaction before sending to the model.
- Bring-your-own-model providers other than GitHub Copilot SDK (OpenAI direct, Anthropic direct, local Ollama).
- Sync-conflict resolution beyond what Obsidian's normal write path provides.
- A dedicated OAuth App registration (gating any non-private distribution; deferred to a follow-up work unit).
- Publishing via BRAT or to the official Obsidian community plugins directory (v0.1 is a private development spike — manual install only by the work-unit author; broader distribution is deferred to a follow-up work unit alongside the dedicated OAuth App).
- OS-keychain (Windows Credential Manager / macOS Keychain / libsecret) integration for token storage; v0.1 uses Obsidian's per-vault `loadData`/`saveData` plus a "do not persist" mode (FR-002).
- End-to-end UI automation tests; v0.1 verification of UI flows is manual (per the success criteria's manual-verification checklists).

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
- **Risk**: The Copilot SDK is a JSON-RPC controller that spawns the `@github/copilot` CLI as a child subprocess. Obsidian's Electron plugin sandbox may not permit child-process spawning, the bundled CLI may include native modules incompatible with Obsidian's Node version, or the SDK's IPC may fail under Electron's renderer restrictions.  
  **Impact**: Critical — could block the entire approach. The whole architecture rests on subprocess spawning working from an Obsidian plugin, which is structurally riskier than a typical "import an SDK" dependency.  
  **Mitigation**: Phase 1 is a non-negotiable subprocess-smoke-test gate: validate that the plugin can spawn the CLI subprocess, exchange JSON-RPC, and produce a `createSession` round-trip before any UI investment. If a hard incompatibility surfaces, escalate before further investment.
- **Risk**: GitHub's OAuth Device Flow for the GitHub CLI client identifier may not return tokens with sufficient scope for the GitHub Models API on every account class (e.g., enterprise SSO, restricted orgs).  
  **Impact**: Medium — some users would be unable to authenticate.  
  **Mitigation**: Confirm scopes during code research. If the CLI client cannot be reused, fall back to creating a dedicated OAuth app for the plugin.
- **Risk**: Reusing the GitHub CLI's OAuth client identifier (`178c6fc778ccc68e1d6a`) for the plugin's Device Flow has multiple shipping risks: (a) the GitHub consent UI shows "GitHub CLI" as the requesting application, misrepresenting the actual client; (b) shared revocation — a user revoking GitHub CLI access also breaks this plugin; (c) shared rate-limit bucket with all `gh` users; (d) GitHub may rotate or restrict the client ID at any time, breaking the plugin without notice; (e) potential conflict with GitHub's Acceptable Use terms regarding identity representation in OAuth flows.  
  **Impact**: Medium for personal/spike use; High for any broader distribution.  
  **Mitigation**: Use the CLI client ID for v0.1 only as a documented development posture; surface this in the README. Register a dedicated OAuth App as a precondition for broader public distribution (tracked as a deferred follow-up).
- **Risk**: Write tools that call Obsidian's Vault APIs while a user has the same file open with unsaved changes could corrupt or silently overwrite their work.  
  **Impact**: High (user trust).  
  **Mitigation**: Use Obsidian's recommended write APIs that participate in editor-state conflict handling. Surface conflicts as tool errors in chat rather than silently winning.
- **Risk**: Path containment bugs could allow the agent to escape allowed roots (vault + extra-vault) via symlinks, normalized path tricks, or absolute paths.  
  **Impact**: High (security and trust).  
  **Mitigation**: Centralize all path resolution in a single tool wrapper; resolve to absolute paths and verify the resolved path is a descendant of one of the configured allowed roots before any I/O. Add unit tests targeting traversal patterns including cross-platform separator handling.
- **Risk**: Persisted authentication tokens stored via plain `loadData`/`saveData` are world-readable to anyone with filesystem access to the user's vault.  
  **Impact**: Medium — users with synced vaults effectively share the token with sync providers.  
  **Mitigation**: Document this limitation in the README; ship a "do not persist token" setting that keeps the token in memory only (per FR-002); investigate keychain integration in a follow-up.
- **Risk**: Streaming + tool-call interleaving in the chat UI is complex; a partially-streamed response interrupted by a tool call can render incoherently.  
  **Impact**: Medium (UX).  
  **Mitigation**: Adopt a clear render model in planning that handles message deltas and tool-call boundaries deterministically; reference `logancyang/obsidian-copilot`'s structure (without copying code).
- **Risk**: Built-in CLI tools (shell, web-fetch, host-filesystem) have a much broader blast radius than the plugin's own filesystem tools — a misclick on "Approve all for this session" could authorize arbitrary host-side actions for the rest of the session.  
  **Impact**: High (user trust / safety).  
  **Mitigation**: Approval prompts SHALL show full tool name and full arguments (e.g., the exact shell command) before any execution; "Approve all for this session" SHALL be presented with explicit copy that explains its scope; session-grants reset on plugin reload, "Clear conversation", or Obsidian restart per FR-013.
- **Risk**: Extra-vault filesystem writes (e.g., into `C:\Repos\`) bypass Obsidian's open-editor conflict handling because they use Node `fs` rather than Obsidian's Vault adapter. A concurrent edit in another editor could be silently overwritten.  
  **Impact**: Medium — narrower trust impact than vault writes since extra-vault files are usually under version control (git), but still a user-visible footgun.  
  **Mitigation**: Document the limitation in the README. Where feasible, the write tool snapshots the prior content for undo before writing, giving a one-step recovery path.
- **Risk**: MCP servers are user-supplied processes that the plugin spawns and trusts to enumerate their tools and respond to invocations. A buggy or malicious MCP server could surface deceptive tool names, return malformed payloads, or hang indefinitely.  
  **Impact**: Medium — limited by the same approval gate that fronts every MCP tool call, but a user who clicks "Approve all" trusts the MCP server's reported tool names.  
  **Mitigation**: Approval prompts for MCP tools SHALL include the source server name visibly; MCP server failures (startup or per-tool) SHALL be surfaced as errors in chat or settings without crashing the plugin; document that users are responsible for the MCP servers they configure.
- **Risk**: Cross-restart `resumeSession` may fail (corrupted SDK state, version drift, expired session) leaving the user with an unexpectedly empty agent context.  
  **Impact**: Low–Medium (UX surprise).  
  **Mitigation**: On resume failure, fall back to display-only history with a clear chat indicator; user can continue with a fresh session or "Clear conversation".

## References
- Issue: none
- Research: (none required at spec stage; technical investigation deferred to `paw-code-research`)
- Reference plugin: <https://github.com/logancyang/obsidian-copilot> (AGPL-3.0; structural reference only)
- Obsidian Plugin API: <https://docs.obsidian.md/Plugins>
- GitHub OAuth Device Flow: <https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps#device-flow>
