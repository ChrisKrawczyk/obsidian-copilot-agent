# Obsidian Copilot Agent v0.1 Implementation Plan

## Overview

We are building v0.1 of an Obsidian desktop plugin that embeds a GitHub Copilot–powered AI agent capable of conversing with the user and reading/writing notes in their vault. The plugin authenticates via GitHub OAuth Device Flow, runs entirely on the user's machine, and ships as a TypeScript Obsidian plugin distributed via BRAT (community-store publication is deferred).

The single most consequential finding from code research is that `@github/copilot-sdk` is **not** an HTTP client — it is a JSON-RPC controller that spawns the `@github/copilot` CLI binary as a child subprocess. Every architectural decision in this plan flows from that fact: Phase 1 is a non-negotiable subprocess-smoke-test gate before any UI investment, plugin packaging must bundle (or transitively npm-install) the CLI binary, the Node version floor is the SDK's (`^20.19.0 || >=22.12.0`), and the agent's "tools" are JS handlers registered via the SDK's `defineTool` API rather than HTTP endpoints we expose.

The architecture is a four-layer separation: **(1) Adapter layer** wrapping the SDK and exposing a typed `AgentSession` interface (insulates us from SDK churn); **(2) Domain layer** holding chat state, safety policy, tool registry, and undo journal; **(3) Obsidian-plugin layer** with the `Plugin` lifecycle, `ItemView`, settings tab, and Vault adapter; **(4) UI layer** rendering streaming Markdown messages and tool-call blocks. Each phase below extends one or more layers in a way that is independently reviewable.

## Current State Analysis

The repository is greenfield — only `README.md`, `.gitignore`, and `.paw/work/copilot-sdk-spike/` exist on `feature/copilot-sdk-spike`. There is no `package.json`, no TypeScript configuration, no plugin manifest, and no source tree.

Key constraints surfaced by `CodeResearch.md`:

- **SDK runtime model**: `@github/copilot-sdk` constructs a `CopilotClient` whose default `RuntimeConnection.forStdio` spawns the `@github/copilot` CLI as a child process and communicates via JSON-RPC. The plugin must therefore inherit the SDK's Node version floor (`^20.19.0 || >=22.12.0`) and have the `@github/copilot` package available on the runtime path.
- **SDK auth**: The SDK accepts `gho_` / `ghu_` / `github_pat_` tokens directly via a `gitHubToken` option. Classic `ghp_` PATs are unsupported. Device Flow → `gho_` token → SDK is a clean path.
- **SDK streaming**: `assistant.message_delta` events provide token-by-token streaming. Tool calls surface as separate event types in the same stream.
- **SDK tools**: `defineTool(name, { parameters: zodSchema, handler })` registers a tool whose `parameters` is a Zod schema and whose `handler` is an async JS function returning a result object.
- **SDK permissions**: A single `onPermissionRequest` callback receives every privileged action and must return one of `approve-once`, `approve-for-session`, or `reject` (verbatim string values per CodeResearch).
- **SDK built-in tools** (HIGH risk): The CLI ships with first-party tools including shell exec and host-filesystem access. By default these are enabled. We must disable them or override them so the agent can only act through our vault-scoped tools. Exact disable mechanism not yet pinned — Phase 1 must locate it by reading the installed `dist/index.d.ts`.
- **Obsidian plugin API**: `ItemView` for the chat pane, `MarkdownRenderer.render` for message bodies, `Vault.create` / `Vault.modify` / `Vault.delete` for filesystem ops (these respect open editors and trigger Obsidian's normal change events), `vault.adapter.getBasePath()` to resolve the vault root for path-containment checks, `Plugin.loadData()` / `saveData()` for token and history persistence, `PluginSettingTab` for settings UI.
- **Token storage**: No realistic alternative to `loadData/saveData` plain JSON for v0.1 — `safeStorage` is unreachable from the renderer process and `keytar` is impractical for plugin distribution.
- **OAuth client**: The GitHub CLI client ID `178c6fc778ccc68e1d6a` works for Device Flow today. Reusing it is acceptable for development but registering a dedicated OAuth App is recommended before BRAT distribution to avoid impersonation and ToS concerns.
- **Reference plugin**: `logancyang/obsidian-copilot` (AGPL-3.0) was inspected at the directory-structure level only; no source was read or copied. License isolation is enforced.

## Desired End State

A user with a GitHub Copilot subscription can install the plugin via BRAT on Obsidian desktop, click "Connect to GitHub", complete the OAuth flow, and immediately use a right-sidebar chat panel where they can:

1. Have streaming, multi-turn conversations with the agent;
2. Ask the agent questions about their vault (the agent reads notes on demand);
3. Ask the agent to create, edit, or delete notes (writes auto-apply with per-action Undo by default; user can switch to require-approval, allow-all-for-session, or pre-allowlist paths);
4. Have all such actions confined to the active vault (path traversal rejected);
5. Restart Obsidian and find their authentication and conversation history preserved;
6. Switch the active model in settings.

**Verification approach**: Each spec-level success criterion (SC-001 through SC-009) maps to a specific phase's manual verification checklist. Automated coverage focuses on path-containment correctness, safety-policy decision logic, and Device Flow polling state machines — areas where unit tests genuinely add value. UI behavior is verified manually against a real Obsidian instance with a small test vault.

## What We're NOT Doing

- **Vault-wide semantic embeddings or precomputed retrieval index** — agent retrieves on demand via tools.
- **Mobile (iOS / Android) support** — `manifest.json` declares `isDesktopOnly: true`.
- **Multiple concurrent chat threads** — single conversation per vault.
- **Tools beyond filesystem** — no web search, no shell exec, no MCP server bridges, no custom tool registration UI.
- **Cross-restart Undo** — Undo works only within the active chat session.
- **Per-note redaction or privacy controls** before sending content to the model.
- **Bring-your-own-model providers** other than GitHub Copilot SDK (no direct OpenAI / Anthropic / Ollama in v0.1).
- **Sync-conflict resolution beyond what Obsidian's normal write path provides.**
- **Publication to the official Obsidian community plugins directory** — BRAT or manual install is sufficient.
- **OS-keychain token storage** — `loadData/saveData` plain JSON with disclosed threat model is the v0.1 baseline.
- **Dedicated OAuth App registration** — reuse the GitHub CLI's client ID for v0.1; register a plugin-specific app as a follow-up before broader distribution.
- **End-to-end automated UI tests** — manual verification against a real Obsidian instance.

## Phase Status

- [ ] **Phase 1: SDK Subprocess Smoke Test** — Prove `@github/copilot-sdk` can be loaded and a session opened from inside an Obsidian plugin process; gate the rest of the work on success.
- [ ] **Phase 2: Plugin Scaffold and Chat View Shell** — Establish the build pipeline, plugin manifest, settings infrastructure, right-sidebar `ItemView`, and a non-streaming end-to-end message round-trip against a hardcoded token.
- [ ] **Phase 3: Device Flow OAuth and Token Persistence** — Replace the hardcoded token with a "Connect to GitHub" Device Flow; persist the resulting `gho_` token; handle reconnect.
- [ ] **Phase 4: Streaming Responses** — Wire the SDK's `assistant.message_delta` events into the chat view so users see tokens as they are produced.
- [ ] **Phase 5: Vault Read Tools and Tool-Call Rendering** — Disable built-in CLI tools; register `read_file`, `list_files`, `search_content`; render tool calls as collapsible blocks in chat; centralize path containment.
- [ ] **Phase 6: Vault Write Tools, Safety Policy, and Undo** — Register `create_file`, `modify_file`, `delete_file`; implement the safety policy state machine (auto-apply-with-undo / require-approval / allow-all-for-session / path allowlist); record undo handles per tool call.
- [ ] **Phase 7: Model Selection, History Persistence, and Polish** — Settings UI for model choice; persist chat transcript; "Clear conversation" action; mobile-load guard; auth-failure recovery UX; threat-model README disclosure.
- [ ] **Phase 8: Documentation** — Author `Docs.md` and finalize README.

## Phase Candidates

<!-- Ideas surfaced during planning that are intentionally out of scope for v0.1 but worth tracking. -->

- [ ] Register a dedicated OAuth App for the plugin and migrate from the GitHub CLI client ID before BRAT public distribution. (Note: spec FR-001 currently says "GitHub CLI's OAuth client identifier" — when this work unit is promoted, amend the spec to "a dedicated OAuth App registered for the plugin".)
- [ ] **Cross-restart SDK session continuity** — replace v0.1's display-only history restoration with true context continuity using the SDK's `resumeSession` API (or feeding history into a fresh session under `infiniteSessions: { enabled: false }`). Requires synchronization design between `ChatState` and the SDK's own session-state directory, including handling of SDK auto-compaction.
- [ ] Investigate Electron `safeStorage` access from a plugin (or evaluate whether Obsidian could expose it through a plugin API request) to upgrade token storage above plain JSON.
- [ ] Pre-built local index (embeddings) for retrieval, replacing on-demand grep with vector search for large vaults.
- [ ] Multi-conversation support (named threads, switch between them, archive).
- [ ] Cross-restart Undo backed by a small change-journal persisted to plugin data.
- [ ] Optional `--no-tools` "chat only" mode for high-sensitivity vaults.
- [ ] Web-search and MCP-server tool bridges so the agent can act outside the vault when explicitly enabled.
- [ ] Per-folder redaction or "do not send" rules before chunks are passed to the model.
- [ ] Headless integration tests that drive the SDK against a fixture vault.

---

## Phase 1: SDK Subprocess Smoke Test

**Objective**: Prove `@github/copilot-sdk` loads and runs a complete request/response cycle from inside an Obsidian plugin process on the user's actual desktop. This is a gate — if the subprocess model fails inside Obsidian's Electron renderer (native module mismatch, sandboxed `child_process`, blocked spawn, Node version mismatch, etc.), we redesign before investing in UI.

### Changes Required:
- **`package.json`**: Initialize with `name: "obsidian-copilot-agent"`, type `module`, dependencies `@github/copilot-sdk` (pinned exact version) and `obsidian` (peer/dev), devDependencies `esbuild`, `typescript`, `@types/node`, `@types/obsidian`. Engines `node` set to the SDK's floor.
- **`tsconfig.json`**: Strict TS targeting ES2022, module `ESNext`, `moduleResolution: bundler`.
- **`esbuild.config.mjs`**: Bundle `src/main.ts` to `main.js`, external `obsidian` and Node built-ins, sourcemap on for dev.
- **`manifest.json`**: `id: "obsidian-copilot-agent"`, `isDesktopOnly: true`, placeholder `minAppVersion` to be tightened after measuring on the user's Obsidian build.
- **`src/main.ts`**: Minimal `Plugin` subclass with a single command `Copilot Agent: SDK smoke test` whose handler:
  1. Reads a hardcoded `gho_` or `github_pat_` token from a constant (gitignored dev file `src/dev-token.local.ts`, or environment variable read at build time — implementer's call between these two equally acceptable options).
  2. Logs Node version (`process.versions.node`) and Electron version to console.
  3. Constructs a `CopilotClient` with the token, calls `start()`, then performs a minimum viable round-trip (e.g., `ping()` and one `createSession` + `sendAndWait("Reply with the single word: hello.")`).
  4. Renders the result (or any thrown error, full stack) into an Obsidian `Notice`.
- **`src/dev-token.local.ts`** (gitignored): Single-line token export for development. Implementer can obtain a token via `gh auth token` (if the GitHub CLI is installed and authenticated), or by creating a fine-grained PAT with `models:read` permission. Document the chosen method in `Phase1-SmokeTest-Notes.md`.
- **`.gitignore`**: Add `src/dev-token.local.ts`, `manifest.json` build artifacts to existing entries (the existing `.gitignore` already covers `main.js`, `node_modules/`, etc.).
- **No tests in this phase** — the value is empirical, not regressable.
- **`.paw/work/copilot-sdk-spike/Phase1-SmokeTest-Notes.md`** (working artifact, committed): Implementer captures observed Node version, Electron version, SDK version, the exact incantation that worked, any errors encountered and their resolutions, the located mechanism for disabling built-in CLI tools (which is a pre-requisite for Phase 5), and an exploratory Device Flow attempt to determine the minimum OAuth scopes the SDK requires (resolves CodeResearch §R4 open question 3 ahead of Phase 3). This document is the empirical answer to CodeResearch's open questions 1, 2, 3, and 5.

### Success Criteria:

#### Automated Verification:
- [ ] Build succeeds: `npm run build`
- [ ] Type check passes: `npx tsc --noEmit`

#### Manual Verification:
- [ ] Plugin loads in Obsidian without console errors on a desktop install (Windows is the primary target since that is the user's environment).
- [ ] The smoke-test command runs to completion and shows a Notice containing a model response that includes the word "hello" (case-insensitive substring check).
- [ ] No process leakage: after the command completes, `@github/copilot` child processes have been cleaned up (verify via Task Manager / `ps`).
- [ ] `Phase1-SmokeTest-Notes.md` documents the working Node version, the exact SDK option(s) (if any) needed to disable built-in tools, and any platform-specific gotchas encountered.

### Gate condition: If the smoke test fails in a way that cannot be remediated within Phase 1, halt the plan and revisit the SDK strategy with the user before proceeding.

---

## Phase 2: Plugin Scaffold and Chat View Shell

**Objective**: Build the plugin's public surface — a right-sidebar chat panel with input and transcript — and wire a non-streaming end-to-end exchange against the same hardcoded token from Phase 1. This validates the SDK adapter, the chat UI shell, and the rendering pipeline before we layer streaming and OAuth on top.

### Changes Required:
- **`src/sdk/AgentSession.ts`**: Adapter layer. Defines an `AgentSession` interface with `sendMessage(text): Promise<AssistantMessage>` (non-streaming) plus `dispose()`. Concrete `CopilotAgentSession` wraps `CopilotClient` and a single SDK session, encapsulating start/stop lifecycle. Insulates the rest of the codebase from the SDK's API.
- **`src/domain/ChatState.ts`**: In-memory model of the conversation: ordered list of `Message { role, content, toolCalls?, status }`. Pure data; no Obsidian or SDK imports.
- **`src/domain/types.ts`**: Shared types — `Message`, `ToolCall`, `Role`, `MessageStatus`.
- **`src/ui/ChatView.ts`**: `ItemView` subclass registered under view type `copilot-agent-chat`. Renders the message list (each via `MarkdownRenderer.render`) and a textarea + send button. On send: appends user message to `ChatState`, calls `AgentSession.sendMessage`, appends the response, re-renders.
- **`src/ui/ChatViewRegistration.ts`**: `Plugin.registerView` + ribbon icon + command "Open Copilot Agent".
- **`src/settings/SettingsTab.ts`**: Minimal `PluginSettingTab` with a single "Connection" section currently showing "Using hardcoded development token (Phase 2)". Phase 3 will replace this content.
- **`src/main.ts`**: Replace smoke-test command with full plugin lifecycle — `onload` registers the view, ribbon, settings, and a single shared `AgentSession`; `onunload` disposes it.
- **`styles.css`**: Minimal styles for chat layout; rely on Obsidian CSS variables for theme compatibility.
- **Tests**: `src/domain/ChatState.test.ts` — exercise message append, ordering, clearing. Use Vitest (`devDependency`); add `npm test` script.

### Success Criteria:

#### Automated Verification:
- [ ] `npm run build` succeeds.
- [ ] `npm test` passes.
- [ ] `npx tsc --noEmit` passes.

#### Manual Verification:
- [ ] Opening Obsidian shows a ribbon icon for the plugin.
- [ ] Clicking the ribbon icon opens the chat panel in the right sidebar; closing and reopening works.
- [ ] Typing a message and clicking Send shows the message in the transcript and, after a brief delay, the assistant's response rendered as Markdown (with bold, lists, and code blocks honored if the model produces them).
- [ ] Settings tab opens and shows the placeholder Phase-3 section.
- [ ] Closing Obsidian disposes the session cleanly (no zombie child processes).

---

## Phase 3: Device Flow OAuth and Token Persistence

**Objective**: Replace the hardcoded token with a real "Connect to GitHub" button that performs OAuth Device Flow against client ID `178c6fc778ccc68e1d6a` (the GitHub CLI's), persists the resulting `gho_` token via `Plugin.saveData`, and handles disconnect / reconnect.

### Changes Required:
- **`src/auth/DeviceFlow.ts`**: Implements `requestDeviceCode()` → `pollForToken()` against the documented GitHub endpoints. Handles `slow_down`, `authorization_pending`, `expired_token`, `access_denied` per the spec. Returns `{ token, scopes, expiresAt? }`. No SDK or Obsidian imports.
- **`src/auth/TokenStore.ts`**: Wrapper over `Plugin.loadData`/`saveData` exposing `get(): Promise<string|null>`, `set(token: string): Promise<void>`, `clear(): Promise<void>`. Persists into the plugin data file under key `auth.token`.
- **`src/auth/AuthController.ts`**: Domain controller — combines DeviceFlow + TokenStore + emits state events (`disconnected | connecting | connected | error`). Settings tab and chat view subscribe to render state.
- **`src/settings/SettingsTab.ts`**: Replace placeholder section with full Connection section: shows current state and a "Connect to GitHub" button. On click: triggers `AuthController.connect`, displays the user code + verification URI in a modal with "Copy code" and "Open in browser" buttons, polls until success/failure, then closes the modal and updates state. Includes a "Disconnect" button that clears the token and tears down the session.
- **`src/sdk/AgentSession.ts`**: Accept the token from `AuthController` via dependency injection; reconstruct the session when the token changes; expose a `reconnect()` method.
- **`src/ui/ChatView.ts`**: Render different states — "Not connected" (with Connect CTA), "Connecting…" (with the Device Flow code visible inline as a fallback to the modal), "Connected" (input enabled), "Auth error" (with Reconnect CTA).
- **Tests**:
  - `src/auth/DeviceFlow.test.ts` — mock `fetch`, exercise the polling state machine for each documented response code (`authorization_pending`, `slow_down`, success, `expired_token`, `access_denied`).
  - `src/auth/TokenStore.test.ts` — round-trip via in-memory `loadData`/`saveData` doubles.
- **`src/dev-token.local.ts`**: Removed (gitignored, but file no longer referenced by source).

### Success Criteria:

#### Automated Verification:
- [ ] `npm test` passes including new auth tests.
- [ ] `npm run build` and `tsc --noEmit` pass.

#### Manual Verification (covers SC-001):
- [ ] Fresh install (clear plugin data) shows "Not connected" state in chat view; input is disabled.
- [ ] Clicking "Connect to GitHub" displays the user code and verification URL.
- [ ] Completing OAuth in the browser causes the chat view to transition to "Connected" within ~5 seconds of the polling cycle.
- [ ] Sending a message after connection succeeds end-to-end.
- [ ] Restarting Obsidian preserves the connection — no re-auth needed.
- [ ] Clicking Disconnect clears the token and returns the plugin to the "Not connected" state.
- [ ] Revoking the token externally (https://github.com/settings/applications) and sending a message produces a clear auth-error state in chat with a Reconnect CTA.

---

## Phase 4: Streaming Responses

**Objective**: Switch from `sendAndWait` to streaming so the user sees tokens incrementally. Establishes the rendering pattern that Phase 5 (tool calls in the same stream) will reuse.

### Changes Required:
- **`src/sdk/AgentSession.ts`**: Add `sendMessageStreaming(text): AsyncIterable<StreamEvent>` returning the SDK's `assistant.message_delta`, `assistant.message_complete`, and (already present in the event taxonomy) `assistant.tool_call_*` events normalized into a small internal taxonomy: `{ type: "delta", text } | { type: "complete" } | { type: "tool_call", … }`. Phase 4 only consumes `delta` and `complete`; `tool_call` event handling lands in Phase 5.
- **`src/domain/ChatState.ts`**: Support partial messages — assistant message appended in `streaming` status, deltas append to its `content`, `complete` event flips to `done`, errors flip to `interrupted` and freeze the partial content.
- **`src/ui/ChatView.ts`**: Re-render strategy: when an assistant message is in `streaming` state, re-render only its DOM node on each delta (avoid re-running `MarkdownRenderer.render` on every token; debounce / batch deltas at ~16ms / animation-frame cadence). When the message transitions to `done`, do a final full Markdown render.
- **`src/ui/MessageRenderer.ts`**: Extracted helper that owns the streaming-vs-done re-render decision; keeps `ChatView` simple.
- **Cancel support**: Send button transforms to a Stop button while a stream is active; clicking it calls `AgentSession.cancelCurrent()`, which delegates to the SDK's `session.abort()` API (confirmed available per CodeResearch §R1). As a defensive fallback in case `abort()` does not flush in-flight deltas, the chat-state layer also freezes the in-flight message at `interrupted` and ignores any subsequent deltas.
- **Tests**: `src/domain/ChatState.test.ts` — extend with delta accumulation, complete-after-delta, interrupted-mid-stream cases.

### Success Criteria:

#### Automated Verification:
- [ ] `npm test` passes including new streaming-state tests.
- [ ] `npm run build` and `tsc --noEmit` pass.

#### Manual Verification:
- [ ] Sending a message that produces a long response shows tokens streaming into the chat panel rather than appearing all at once.
- [ ] Markdown formatting is correct in the final rendered message (lists, code blocks, headings).
- [ ] Clicking Stop mid-stream halts rendering; the partial message remains visible with an "interrupted" indicator; the user can send a new message immediately.
- [ ] Streaming a response while a second user message is queued is rejected (or queued — implementer's call, but behavior must be consistent and documented in `Docs.md` later).

---

## Phase 5: Vault Read Tools and Tool-Call Rendering

**Objective**: Give the agent on-demand read access to the active vault via three tools, render tool invocations and results in the chat UI, and ensure the SDK's built-in CLI tools (shell exec, host-filesystem) are disabled or cannot be invoked.

### Changes Required:
- **`src/tools/VaultPath.ts`**: Single source of truth for path safety. Exports `resolveVaultPath(input: string, vault: Vault): string` that:
  1. Rejects absolute paths and paths containing `..` segments.
  2. Resolves the input relative to `vault.adapter.getBasePath()`.
  3. Resolves `realpath` on the deepest existing ancestor (symlink defense).
  4. Verifies the resolved path is a strict descendant of the vault root using `path.relative(root, resolved).startsWith("..")` checks (cross-platform, including Windows separators).
  5. Throws `VaultPathError` with a clear message on any violation.
  Also exports `lookupTFile(path, vault)` which validates against Obsidian's known-files index as a second line of defense for read tools (so the agent cannot read files Obsidian doesn't track).
- **`src/tools/ReadTools.ts`**: Three SDK `defineTool` registrations:
  - `read_file({ path: string })` — reads via `vault.read(tFile)`, returns `{ content }`.
  - `list_files({ directory?: string })` — enumerates `vault.getFiles()` (or directory subset), returns `{ paths: string[] }`.
  - `search_content({ query: string, regex?: boolean })` — substring or regex search across markdown files; returns `{ matches: Array<{ path, line, snippet }> }` capped at a sensible result limit (e.g., 50). For v0.1, implementation is a straightforward iteration; performance optimization is out of scope.
- **`src/sdk/AgentSession.ts`**: Apply the SDK option(s) located in Phase 1 to disable built-in CLI tools so only the tools registered via `defineTool` are exposed. **Fallback strategy**: if no global disable option exists, the SDK's per-tool `overridesBuiltInTool: true` mechanism (confirmed in CodeResearch §R1) is used to override every dangerous built-in by name. The complete list of tools to override is captured in `Phase1-SmokeTest-Notes.md` during Phase 1 by inspecting the installed SDK's tool registry; expected categories include shell exec, host filesystem (read/write/list), and web fetch. Register the Phase-5 read tools when constructing the session. (Phase 6 adds write tools to the same registration site.)
- **`src/ui/ToolCallBlock.ts`**: New component rendering an SDK `tool_call` event as a collapsible block in the chat transcript: header with tool name + summary; expanded view with arguments (JSON, syntax-highlighted) and result/error.
- **`src/domain/ChatState.ts`**: Extend `Message` to include `toolCalls: ToolCall[]` interleaved with text deltas in stream order; the UI renders them inline.
- **`src/ui/MessageRenderer.ts`**: Extend to render the interleaved text + tool-call sequence.
- **Tests**:
  - `src/tools/VaultPath.test.ts` — comprehensive: absolute paths, `..` traversal (single, nested, mixed separators), Windows-specific `C:\…` paths, symlinks (use a temp dir fixture), valid relative paths, vault-root-edge-case (`""`, `.`, `/`).
  - `src/tools/ReadTools.test.ts` — round-trip a fake vault, including the path-rejection paths.

### Success Criteria:

#### Automated Verification:
- [ ] `npm test` passes including new path-containment and read-tool tests.
- [ ] `npm run build` and `tsc --noEmit` pass.

#### Manual Verification (covers SC-002, SC-006):
- [ ] Asking the agent a question that requires reading at least one note (e.g., "What does my note titled X say about Y?") triggers a `read_file` or `search_content` tool call, visible as a collapsible block in chat.
- [ ] The agent's textual answer demonstrably reflects the contents of the consulted note.
- [ ] An attempt to read a path outside the vault (use a debugging command that injects a synthetic tool call with `../../etc/hosts`) is rejected at the wrapper layer and the agent receives an error result.
- [ ] No `shell` or host-filesystem tools are listed when inspecting the SDK session's tool registry at runtime; the agent cannot perform shell commands.

---

## Phase 6: Vault Write Tools, Safety Policy, and Undo

**Objective**: Wire the differentiated value of v0.1 — the agent can create, modify, and delete notes, with user-controlled safety and per-action Undo.

### Changes Required:
- **`src/domain/SafetyPolicy.ts`**: State machine encapsulating the safety decision for a write tool call. Inputs: tool name, target path, configured default mode, current session-grants, configured allowlist. Output: `auto-apply | require-approval | rejected`. Modes: `auto-apply-with-undo` (default), `require-approval`. Session-grants tracked in-memory only (cleared on plugin reload, view close, or "Clear conversation"). Pure logic, no IO.
- **`src/domain/UndoJournal.ts`**: Per-session journal of applied write actions: `{ id, kind: "create" | "modify" | "delete", path, before?, after? }`. Provides `record(entry)` and `undo(id)`. Undo operations:
  - `create` undo → `vault.delete(path)`.
  - `modify` undo → `vault.modify(path, before)`.
  - `delete` undo → `vault.create(path, before)`.
  Journal cleared on plugin reload, view close, or "Clear conversation".
- **`src/tools/WriteTools.ts`**: Three `defineTool` registrations:
  - `create_file({ path, content })` — uses `vault.create`; missing intermediate directories auto-created (matches spec edge case).
  - `modify_file({ path, content })` — reads existing for `before` snapshot, then `vault.modify`. **Unsaved-editor-conflict detection**: before writing, iterate `app.workspace.getLeavesOfType("markdown")`, find any whose `MarkdownView.file` matches the target, and compare `MarkdownView.editor.getValue()` against the on-disk content from `vault.read(tFile)`. If they differ, surface a clear "file has unsaved changes in an open editor" error to the agent as the tool result and do not write (per spec edge case + Risk R-4).
  - `delete_file({ path })` — reads existing for `before` snapshot, then `vault.delete`.
  All three use `VaultPath.resolveVaultPath` and run through the `SafetyPolicy` decision before any I/O.
- **`src/sdk/AgentSession.ts`**: Implement `onPermissionRequest` callback — when SDK asks permission for one of our write tools, consult `SafetyPolicy`. Map decisions to SDK return values: auto-apply → `approve-once`; require-approval → block on UI prompt and return `approve-once` or `reject`; allow-all-for-session → `approve-for-session`; rejected → `reject`. Register the write tools alongside the read tools.
- **`src/ui/ApprovalPrompt.ts`**: Inline chat element rendered when a write tool call is pending approval. Buttons: Approve Once, Approve All for Session, Reject. The "Approve All" button updates the session-grants in `SafetyPolicy`.
- **`src/ui/ToolCallBlock.ts`**: Extended to render an Undo button on completed write tool calls. Click → `UndoJournal.undo(id)` → updates the block to a "reverted" state.
- **`src/settings/SettingsTab.ts`**: New "Safety" section: dropdown for default policy mode, multi-line input for path allowlist (one path per line; matched as prefix against `path.relative(root, target)`).
- **Tests**:
  - `src/domain/SafetyPolicy.test.ts` — every combination of (default mode × allowlist hit/miss × session-grants present/absent × tool name).
  - `src/domain/UndoJournal.test.ts` — record-undo-record sequences for all three write kinds against a fake vault.
  - `src/tools/WriteTools.test.ts` — path containment, directory auto-creation, error-on-conflict.

### Success Criteria:

#### Automated Verification:
- [ ] `npm test` passes including new safety/undo/write tests.
- [ ] `npm run build` and `tsc --noEmit` pass.

#### Manual Verification (covers SC-003, SC-004, SC-005):
- [ ] Default mode: asking the agent to "Create a note in /inbox/ with these bullets…" creates the file immediately; the chat shows an Undo button; clicking Undo removes the file.
- [ ] Switch default mode to "Require approval"; ask for a write; verify no file change occurs until Approve is clicked.
- [ ] Click "Approve all for this session"; verify subsequent writes auto-apply with no prompt; close and reopen the chat view; verify the next write again prompts (session-scope reset).
- [ ] Configure an allowlist entry `/inbox/`; with default mode "Require approval", verify writes within `/inbox/` skip the prompt while writes outside still prompt.
- [ ] Have a file open with unsaved changes; ask the agent to modify it; verify the tool fails with a clear error in chat rather than overwriting silently.
- [ ] Attempt a write to a path outside the vault (synthetic injected tool call); verify rejection with a clear error.

---

## Phase 7: Model Selection, History Persistence, and Polish

**Objective**: Close the spec gap on model selection, conversation persistence, and remaining edge-case UX. Land the threat-model README disclosure.

### Changes Required:
- **`src/sdk/Models.ts`**: Helper that enumerates models available to the current SDK session via the SDK's `client.listModels()` API (confirmed available per CodeResearch §R1). A defensive fallback to a small hardcoded curated list applies only on enumeration error (e.g., transient network failure), with a warning in the chat. Exposes `listModels()` and `setActiveModel(id)`.
- **`src/settings/SettingsTab.ts`**: Add "Model" section — dropdown of available models with current selection persisted via `loadData/saveData`. Default chosen at first connection.
- **`src/sdk/AgentSession.ts`**: Apply the active model to each new SDK session.
- **`src/domain/ChatState.ts`**: Add serialization — `serialize(): Json` and `deserialize(Json)`. Persist after every message transition; load on plugin start.

### Cross-Restart SDK Session Continuity (design decision):

For v0.1 we adopt **display-only history restoration**: persisted `ChatState` is rendered to show the user their prior conversation, but a **fresh SDK session is created** on each plugin load. The agent does not retain model-side context from messages produced before the restart. The chat view displays a subtle visual marker at the boundary between restored history and the new session (e.g., a thin separator with the text "Resumed — earlier messages are not in the agent's context"). This is the minimum that satisfies SC-007 ("messages still rendered when chat panel reopened") while keeping the implementation correct and avoiding the state-divergence pitfalls of trying to keep our `ChatState` in lockstep with the SDK's own session-state directory and auto-compaction behavior. True cross-restart context continuity (via the SDK's `resumeSession`) is added to Phase Candidates for a follow-up work unit.
- **`src/main.ts`**: Persistence wiring; "Clear conversation" command + button in chat header.
- **`src/main.ts`** (mobile guard): Although `manifest.json` declares `isDesktopOnly`, defend in code as well — if `Platform.isMobile`, refuse to register the view and show a one-time Notice.
- **Auth-failure recovery**: If a streamed response fails with an auth error, surface a clear chat error block with a Reconnect button that triggers `AuthController.connect`. (Most of the wiring exists from Phase 3; this phase ties it into the streaming error path.)
- **`README.md`**: Section "Security and Privacy" disclosing the token-storage model (plain JSON in vault `.obsidian/plugins/` data file), the implication for synced vaults (sync providers see the token), and the recommendation to use a separate test vault for sensitive data. Section "Known Limitations" listing v0.1 deferrals.
- **Tests**: `src/domain/ChatState.test.ts` — round-trip serialization for transcripts containing tool calls.

### Success Criteria:

#### Automated Verification:
- [ ] `npm test` passes.
- [ ] `npm run build` and `tsc --noEmit` pass.

#### Manual Verification (covers SC-007, SC-008, SC-009):
- [ ] Restarting Obsidian preserves the chat transcript (user messages, assistant messages, and tool-call records all reload).
- [ ] "Clear conversation" empties the transcript and resets session-grants.
- [ ] Switching the active model in settings causes the next assistant response to be produced by the new model (verifiable by asking the model to identify itself).
- [ ] Loading the plugin on Obsidian mobile (or simulating `Platform.isMobile`) does not register the chat view; a one-time Notice indicates desktop-only.
- [ ] Manually revoking the token and sending a message shows the auth-error chat block with a working Reconnect button.

---

## Phase 8: Documentation

**Objective**: Author the as-built technical reference and finalize the README.

### Changes Required:
- **`.paw/work/copilot-sdk-spike/Docs.md`**: Technical reference. Sections: architecture overview (the four-layer separation), SDK adapter contract, safety/undo/path-containment design, Device Flow flow diagram, persistence layout (what lives in `loadData` keys), known limitations, threat model, and a section "Notes for v0.2" listing the items in Phase Candidates. Load `paw-docs-guidance` for style.
- **`README.md`**: Audience is end users + curious devs. Sections: features at a glance (with one screenshot placeholder), installation via BRAT, first-run / Connect-to-GitHub flow, configuration (model, safety policy, allowlist), security & privacy disclosure (already drafted in Phase 7 — refine here), troubleshooting, contributing.
- **`CHANGELOG.md`**: New file — entry for v0.1 listing high-level capabilities.

### Success Criteria:

#### Automated Verification:
- [ ] `npm run build` succeeds.

#### Manual Verification:
- [ ] `Docs.md` accurately describes the implemented architecture (cross-checked against final code in each layer).
- [ ] README installation steps walk a new user from BRAT install → Connect → first message without ambiguity.
- [ ] Threat-model section explicitly addresses synced-vault token exposure and the recommendation to use a dedicated vault for sensitive notes.
- [ ] CHANGELOG present and correctly formatted.

---

## References
- Issue: none
- Spec: `.paw/work/copilot-sdk-spike/Spec.md`
- Research: `.paw/work/copilot-sdk-spike/CodeResearch.md` (no `SpecResearch.md` — greenfield)
- Reference plugin (structural reference only, AGPL-3.0, license isolated): <https://github.com/logancyang/obsidian-copilot>
- GitHub Copilot SDK: <https://www.npmjs.com/package/@github/copilot-sdk>
- Obsidian Plugin API: <https://docs.obsidian.md/Plugins>
- GitHub OAuth Device Flow: <https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps#device-flow>
