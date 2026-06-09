# Obsidian Copilot Agent v0.1 Implementation Plan

## Overview

We are building v0.1 of an Obsidian desktop plugin that embeds a GitHub Copilot–powered AI agent capable of conversing with the user, reading/writing files in the user's vault and in user-configured extra-vault filesystem roots, invoking MCP-server tools, and invoking the GitHub Copilot SDK's built-in CLI tools — all under a uniform per-call approval gate. The plugin authenticates via GitHub OAuth Device Flow, runs entirely on the user's machine, and is delivered as a TypeScript Obsidian plugin. **v0.1 is a private development spike** — no public distribution (BRAT, community store, or otherwise) in this work unit; install is manual (`main.js` + `manifest.json` dropped into the user's `.obsidian/plugins/obsidian-copilot-agent/`) for the work-unit author's own use. Public distribution is gated on a follow-up work unit that registers a dedicated GitHub OAuth App.

The single most consequential finding from code research is that `@github/copilot-sdk` is **not** an HTTP client — it is a JSON-RPC controller that spawns the `@github/copilot` CLI binary as a child subprocess. Every architectural decision in this plan flows from that fact: Phase 1 is a non-negotiable subprocess-smoke-test gate before any UI investment, plugin packaging must bundle (or transitively npm-install) the CLI binary, the Node version floor is the SDK's (`^20.19.0 || >=22.12.0`), and the agent's "tools" are JS handlers registered via the SDK's `defineTool` API rather than HTTP endpoints we expose.

The architecture is a four-layer separation: **(1) Adapter layer** wrapping the SDK and exposing a typed `AgentSession` interface (insulates us from SDK churn); **(2) Domain layer** holding chat state, safety policy, tool registry, scope registry, MCP integration, and undo journal; **(3) Obsidian-plugin layer** with the `Plugin` lifecycle, `ItemView`, settings tab, and Vault adapter; **(4) UI layer** rendering streaming Markdown messages, tool-call blocks, and approval prompts. Each phase below extends one or more layers in a way that is independently reviewable.

A key design decision flowing from the v0.1 scope: **built-in SDK tools are not disabled; they are gated.** The plugin's `onPermissionRequest` callback is the universal choke point — every tool call (custom filesystem, MCP, or built-in) flows through it and consults the Safety Policy. This means Phase 1 must locate the permission-callback wiring (rather than a "disable built-ins" mechanism), and Phase 2 must wire the permission pipeline from day one (with a deny-by-default policy until later phases install richer rules).

## Current State Analysis

The repository is greenfield — only `README.md`, `.gitignore`, and `.paw/work/copilot-sdk-spike/` exist on `feature/copilot-sdk-spike`. There is no `package.json`, no TypeScript configuration, no plugin manifest, and no source tree.

Key constraints surfaced by `CodeResearch.md`:

- **SDK runtime model**: `@github/copilot-sdk` constructs a `CopilotClient` whose default `RuntimeConnection.forStdio` spawns the `@github/copilot` CLI as a child process and communicates via JSON-RPC. The plugin must therefore inherit the SDK's Node version floor (`^20.19.0 || >=22.12.0`) and have the `@github/copilot` package available on the runtime path.
- **SDK auth**: The SDK accepts `gho_` / `ghu_` / `github_pat_` tokens directly via a `gitHubToken` option. Classic `ghp_` PATs are unsupported. Device Flow → `gho_` token → SDK is a clean path.
- **SDK streaming**: `assistant.message_delta` events provide token-by-token streaming. Tool calls surface as separate event types in the same stream.
- **SDK tools**: `defineTool(name, { parameters: zodSchema, handler })` registers a tool whose `parameters` is a Zod schema and whose `handler` is an async JS function returning a result object.
- **SDK permissions**: A single `onPermissionRequest` callback receives every privileged action — for custom tools, MCP-bridged tools, and built-in CLI tools alike — and must return one of `approve-once`, `approve-for-session`, or `reject` (verbatim string values per CodeResearch). This callback is the architectural choke point that makes "every tool through one approval gate" possible.
- **SDK built-in tools**: The CLI ships with first-party tools including shell exec, web-fetch, and host-filesystem. By default these are enabled. **v0.1 design choice**: do not disable them — gate them through `onPermissionRequest` so the user is prompted (or auto-approved per session-grant or allowlist) on each call. Phase 1 verifies the permission-callback fires for built-in tool calls.
- **SDK session continuity**: The SDK exposes `resumeSession(sessionId)` and persists session state under `~/.copilot/session-state/...`. v0.1 uses this for cross-restart context continuity (per spec SC-007), with display-only fallback on resume failure.
- **Obsidian plugin API**: `ItemView` for the chat pane, `MarkdownRenderer.render` for message bodies, `Vault.create` / `Vault.modify` / `Vault.delete` for vault filesystem ops (these respect open editors and trigger Obsidian's normal change events), `vault.adapter.getBasePath()` to resolve the vault root for path-containment checks, `Plugin.loadData()` / `saveData()` for token and history persistence, `PluginSettingTab` for settings UI. Extra-vault filesystem ops use Node `fs` directly (the Vault adapter is vault-scoped).
- **Token storage**: No realistic alternative to `loadData/saveData` plain JSON for v0.1 — `safeStorage` is unreachable from the renderer process and `keytar` is impractical for plugin distribution. A "do not persist token" mode keeps the token in memory only.
- **OAuth client**: The GitHub CLI client ID `178c6fc778ccc68e1d6a` works for Device Flow today. Reusing it is acceptable for v0.1 development but documented as a development-only posture (impersonation, shared revocation, and AUP risks per Spec §Risks); registering a dedicated OAuth App is a precondition for broader public distribution and tracked in Phase Candidates.
- **MCP integration**: The plugin discovers MCP servers from a JSON config file (mirroring Claude Desktop / VS Code's `mcp_servers.json` convention), spawns each server, enumerates its tools, and bridges them through `defineTool` so they pass through the same `onPermissionRequest` gate as everything else. Whether the SDK provides native MCP support or the plugin must bridge MCP itself is to be confirmed in Phase 1 / Phase 8.
- **Reference plugin**: `logancyang/obsidian-copilot` (AGPL-3.0) was inspected at the directory-structure level only; no source was read or copied. License isolation is enforced.

## Desired End State

A user (the work-unit author) installs the plugin manually on Obsidian desktop, clicks "Connect to GitHub", completes the OAuth flow, and immediately uses a right-sidebar chat panel where they can:

1. Have streaming, multi-turn conversations with the agent;
2. Ask the agent questions about their vault and any extra-vault filesystem roots they've configured (the agent reads files on demand);
3. Ask the agent to create, edit, or delete files in the vault and in those roots (writes auto-apply with per-action Undo by default; user can switch to require-approval, allow-all-for-session, or pre-allowlist paths);
4. Have the agent invoke MCP-server tools (configured via `mcp_servers.json`) through the same approval gate;
5. Have the agent invoke the SDK's built-in CLI tools (shell, web-fetch, host-filesystem) through the same approval gate — the user is prompted on each call (unless a session-grant or allowlist applies);
6. Have all custom-filesystem tool calls confined to the union of the active vault and configured extra-vault roots (path traversal rejected);
7. Restart Obsidian and find their authentication, conversation history, and agent context preserved (via SDK `resumeSession`, with display-only fallback on resume failure);
8. Switch the active model in settings (which recreates the SDK session with the new model).

**Verification approach**: Each spec-level success criterion (SC-001 through SC-012) maps to a specific phase's manual verification checklist. Automated coverage focuses on path-containment correctness, safety-policy decision logic, MCP config parsing, and Device Flow polling state machines — areas where unit tests genuinely add value. UI behavior is verified manually against a real Obsidian instance with a small test vault.

## What We're NOT Doing

- **Vault-wide semantic embeddings or precomputed retrieval index** — agent retrieves on demand via tools.
- **Mobile (iOS / Android) support** — `manifest.json` declares `isDesktopOnly: true`.
- **Multiple concurrent chat threads** — single conversation per vault.
- **MCP server credential management UI** — users supply credentials to MCP servers via environment variables or per-server config in `mcp_servers.json`.
- **User-authored custom tool registration via plugin UI** — only filesystem (vault + extra-vault), MCP-discovered, and SDK built-in tools are supported.
- **Cross-restart Undo** — Undo works only within the active chat session.
- **Per-note redaction or privacy controls** before sending content to the model.
- **Bring-your-own-model providers** other than GitHub Copilot SDK (no direct OpenAI / Anthropic / Ollama in v0.1).
- **Sync-conflict resolution beyond what Obsidian's normal write path provides.**
- **Publication to the official Obsidian community plugins directory or via BRAT** — v0.1 is a private dev spike, manual install only. Public distribution paths are deferred to a follow-up work unit that also registers a dedicated OAuth App.
- **OS-keychain token storage** — `loadData/saveData` plain JSON with disclosed threat model is the v0.1 baseline (with optional "do not persist" memory-only mode).
- **Dedicated OAuth App registration** — reuse the GitHub CLI's client ID for v0.1 as a documented development posture; register a plugin-specific app as a follow-up before broader public distribution.
- **End-to-end automated UI tests** — manual verification against a real Obsidian instance.

## Phase Status

- [x] **Phase 1: SDK Subprocess Smoke Test + Permission-Callback Verification** — Prove `@github/copilot-sdk` can be loaded, a session opened, and `onPermissionRequest` fires for both custom and built-in tool calls from inside an Obsidian plugin process; gate the rest of the work on success.
- [x] **Phase 2: Plugin Scaffold, Chat View Shell, and Permission Pipeline** — Establish the build pipeline, plugin manifest, settings infrastructure, right-sidebar `ItemView`, a non-streaming end-to-end message round-trip against a hardcoded token, and a permission-pipeline skeleton that defaults to deny (so freeform chat is never exposed with built-in tools un-gated).
- [x] **Phase 3: Device Flow OAuth, Token Persistence, and "Do Not Persist" Mode** — Replace the hardcoded token with a "Connect to GitHub" Device Flow; persist the resulting `gho_` token (or hold it in memory only when "do not persist" is enabled); handle reconnect.
- [x] **Phase 4: Streaming Responses** — Wire the SDK's `assistant.message_delta` events into the chat view so users see tokens as they are produced.
- [ ] **Phase 5: Vault Read Tools and Tool-Call Rendering** — Register `read_file`, `list_files`, `search_content` for the vault scope; render tool calls (custom + built-in) as collapsible blocks in chat; verify built-in tool calls (e.g., synthetic `shell` invocation) flow through the permission pipeline.
- [ ] **Phase 6: Vault Write Tools, Safety Policy, and Undo** — Register `create_file`, `modify_file`, `delete_file` for the vault scope; implement the Safety Policy state machine that gates filesystem writes, MCP calls, and built-in calls uniformly (auto-apply-with-undo for filesystem writes / require-approval / allow-all-for-session / path-or-scope allowlist); record undo handles per filesystem write.
- [ ] **Phase 7: Extra-Vault Filesystem Roots** — Add settings UI for managing extra-vault roots; expand `VaultPath`/`ScopeRegistry` to validate against the union of allowed roots; extend the filesystem tools to operate on extra-vault paths via Node `fs`; extend `UndoJournal` to cover extra-vault writes.
- [ ] **Phase 8: MCP Integration** — Discover MCP servers from `mcp_servers.json`; spawn each server; enumerate its tools; bridge them as `defineTool` registrations that route through `onPermissionRequest`; surface MCP server failures gracefully in chat or settings.
- [ ] **Phase 9: Model Selection, Cross-Restart Resume, and Polish** — Settings UI for model choice (with "next message uses new model" semantics); persist chat transcript; integrate SDK `resumeSession` for cross-restart context continuity (with display-only fallback); "Clear conversation" action; mobile-load guard; auth-failure recovery UX; threat-model README disclosure.
- [ ] **Phase 10: Documentation** — Author `Docs.md` and finalize README.

## Phase Candidates

<!-- Ideas surfaced during planning that are intentionally out of scope for v0.1 but worth tracking. -->

- [x] [deferred] Register a dedicated OAuth App for the plugin and migrate from the GitHub CLI client ID before any non-private distribution (BRAT, community store, or any release where the plugin is installed by users other than the work-unit author). When this work unit is promoted, amend spec FR-001 In-Scope wording and demote the CLI client ID to dev-only.
- [x] [deferred] Investigate Electron `safeStorage` access from a plugin (or evaluate whether Obsidian could expose it through a plugin API request) to upgrade token storage above plain JSON.
- [x] [deferred] Pre-built local index (embeddings) for retrieval, replacing on-demand grep with vector search for large vaults.
- [x] [deferred] Multi-conversation support (named threads, switch between them, archive).
- [x] [deferred] Cross-restart Undo backed by a small change-journal persisted to plugin data.
- [x] [deferred] Optional `--no-tools` "chat only" mode for high-sensitivity vaults.
- [x] [deferred] MCP server credential management UI (per-server credential fields with secure storage).
- [x] [deferred] User-authored custom tool registration via plugin UI.
- [x] [deferred] Per-folder redaction or "do not send" rules before chunks are passed to the model.
- [x] [deferred] Headless integration tests that drive the SDK against a fixture vault.
- [x] [deferred] Open-editor conflict detection for extra-vault writes (currently vault-only since Obsidian's open-editor APIs are vault-scoped).

---

## Phase 1: SDK Subprocess Smoke Test + Permission-Callback Verification

**Objective**: Prove `@github/copilot-sdk` loads and runs a complete request/response cycle from inside an Obsidian plugin process on the user's actual desktop, AND verify that the SDK's `onPermissionRequest` callback fires for both custom-tool and built-in-tool calls. This is a gate — if the subprocess model fails inside Obsidian's Electron renderer, or if the permission callback is not the universal choke point we expect, we redesign before investing in UI.

### Changes Required:
- **`package.json`**: Initialize with `name: "obsidian-copilot-agent"`, type `module`, dependencies `@github/copilot-sdk` (pinned exact version) and `obsidian` (peer/dev), devDependencies `esbuild`, `typescript`, `@types/node`, `@types/obsidian`. Engines `node` set to the SDK's floor.
- **`tsconfig.json`**: Strict TS targeting ES2022, module `ESNext`, `moduleResolution: bundler`.
- **`esbuild.config.mjs`**: Bundle `src/main.ts` to `main.js`, external `obsidian` and Node built-ins, sourcemap on for dev.
- **`manifest.json`**: `id: "obsidian-copilot-agent"`, `isDesktopOnly: true`, placeholder `minAppVersion` to be tightened after measuring on the user's Obsidian build.
- **`src/main.ts`**: Minimal `Plugin` subclass with a single command `Copilot Agent: SDK smoke test` whose handler:
  1. Reads a hardcoded `gho_` or `github_pat_` token from a constant (gitignored dev file `src/dev-token.local.ts`, or environment variable read at build time — implementer's call between these two equally acceptable options).
  2. Logs Node version (`process.versions.node`) and Electron version to console.
  3. Constructs a `CopilotClient` with the token AND an `onPermissionRequest` callback that logs every request and returns `approve-once`. Calls `start()`, then performs a minimum viable round-trip (e.g., `ping()` and one `createSession` + `sendAndWait("Reply with the single word: hello.")`).
  4. Performs a permission-pipeline probe: register one trivial custom tool via `defineTool` (e.g., `echo({ text })`), and ask the model "call the echo tool with the word 'hi'"; verify `onPermissionRequest` fired for that custom tool.
  5. Performs a built-in permission probe: ask the model to invoke a built-in (e.g., `shell` with `echo hi` — a benign command); verify `onPermissionRequest` fires for the built-in tool call before the command would run. If the callback does NOT fire for built-ins, this is a Phase-1 blocker — escalate. (The premise that every tool flows through one callback is the architectural foundation of v0.1.)
  6. Renders the result (or any thrown error, full stack) into an Obsidian `Notice`.
- **`src/dev-token.local.ts`** (gitignored): Single-line token export for development. Implementer can obtain a token via `gh auth token` (if the GitHub CLI is installed and authenticated), or by creating a fine-grained PAT with `models:read` permission. Document the chosen method in `Phase1-SmokeTest-Notes.md`.
- **`.gitignore`**: Add `src/dev-token.local.ts`, `manifest.json` build artifacts to existing entries (the existing `.gitignore` already covers `main.js`, `node_modules/`, etc.).
- **No tests in this phase** — the value is empirical, not regressable.
- **`.paw/work/copilot-sdk-spike/Phase1-SmokeTest-Notes.md`** (working artifact, committed): Implementer captures observed Node version, Electron version, SDK version, the exact incantation that worked, any errors encountered and their resolutions, the verified `onPermissionRequest` behavior for custom and built-in tools, the location of the SDK's MCP-bridging primitive (or the absence thereof, in which case Phase 8 must implement its own MCP bridge), the SDK's `resumeSession` API signature (for Phase 9), and an exploratory Device Flow attempt to determine the minimum OAuth scopes the SDK requires (resolves CodeResearch open-questions item on OAuth scopes ahead of Phase 3). This document is the empirical answer to the CodeResearch open questions on permission-callback fan-out, native-module presence, Electron-renderer feasibility, MCP integration story, and `resumeSession` signature.

### Success Criteria:

#### Automated Verification:
- [ ] Build succeeds: `npm run build`
- [ ] Type check passes: `npx tsc --noEmit`

#### Manual Verification:
- [ ] Plugin loads in Obsidian without console errors on a desktop install (Windows is the primary target since that is the user's environment).
- [ ] The smoke-test command runs to completion and shows a Notice containing a model response that includes the word "hello" (case-insensitive substring check).
- [ ] `onPermissionRequest` fires for the custom `echo` tool call (logged in console).
- [ ] `onPermissionRequest` fires for the built-in `shell` tool call (logged in console) BEFORE any command would execute. If this does not fire, halt the plan and escalate.
- [ ] No process leakage: after the command completes, `@github/copilot` child processes have been cleaned up (verify via Task Manager / `ps`).
- [ ] `Phase1-SmokeTest-Notes.md` documents the working Node version, the verified permission-callback behavior for both custom and built-in tools, the SDK's MCP integration story (native vs. plugin-bridged), the `resumeSession` API signature and storage location, and any platform-specific gotchas encountered.

### Gate condition: If the smoke test fails in a way that cannot be remediated within Phase 1 — including the permission callback failing to fire for built-in tools — halt the plan and revisit the SDK strategy with the user before proceeding.

---

## Phase 2: Plugin Scaffold, Chat View Shell, and Permission Pipeline ✓

**Objective**: Build the plugin's public surface — a right-sidebar chat panel with input and transcript — wire a non-streaming end-to-end exchange against the same hardcoded token from Phase 1, AND wire the `onPermissionRequest` callback from day one with a deny-by-default policy. This validates the SDK adapter, the chat UI shell, the rendering pipeline, and the universal-approval-gate architecture before we layer streaming, OAuth, and richer policies on top. The deny-by-default posture means freeform chat in Phase 2 cannot inadvertently invoke shell, host-fs, or any other tool — they are denied at the callback boundary until Phase 6 installs richer rules.

### Changes Required:
- **`src/sdk/AgentSession.ts`**: Adapter layer. Defines an `AgentSession` interface with `sendMessage(text): Promise<AssistantMessage>` (non-streaming) plus `dispose()`. Concrete `CopilotAgentSession` wraps `CopilotClient` and a single SDK session, encapsulating start/stop lifecycle. Wires `onPermissionRequest` to a pluggable decision function (in Phase 2 the function returns `reject` for everything; Phase 6 replaces it with the SafetyPolicy). Insulates the rest of the codebase from the SDK's API.
- **`src/domain/PermissionDecision.ts`**: A small typed interface `(request: PermissionRequest) => Promise<"approve-once" | "approve-for-session" | "reject">`. Phase 2 ships a stub `denyAll` implementation. Phase 6 replaces it with the SafetyPolicy decision function.
- **`src/domain/ChatState.ts`**: In-memory model of the conversation: ordered list of `Message { role, content, toolCalls?, status }`. Pure data; no Obsidian or SDK imports.
- **`src/domain/types.ts`**: Shared types — `Message`, `ToolCall`, `Role`, `MessageStatus`, `PermissionRequest`.
- **`src/ui/ChatView.ts`**: `ItemView` subclass registered under view type `copilot-agent-chat`. Renders the message list (each via `MarkdownRenderer.render`) and a textarea + send button. On send: appends user message to `ChatState`, calls `AgentSession.sendMessage`, appends the response, re-renders. If the model attempts a tool call in Phase 2 it will be rejected by `denyAll` and the rejection surfaces as a tool error in chat.
- **`src/ui/ChatViewRegistration.ts`**: `Plugin.registerView` + ribbon icon + command "Open Copilot Agent".
- **`src/settings/SettingsTab.ts`**: Minimal `PluginSettingTab` with a single "Connection" section currently showing "Using hardcoded development token (Phase 2)". Phase 3 will replace this content.
- **`src/main.ts`**: Replace smoke-test command with full plugin lifecycle — `onload` registers the view, ribbon, settings, and a single shared `AgentSession` (constructed with `denyAll` permission decision); `onunload` disposes it.
- **`styles.css`**: Minimal styles for chat layout; rely on Obsidian CSS variables for theme compatibility.
- **Tests**: `src/domain/ChatState.test.ts` — exercise message append, ordering, clearing. `src/sdk/AgentSession.test.ts` (with mocked SDK) — verify the permission decision function is wired and called when the SDK signals a permission request. Use Vitest (`devDependency`); add `npm test` script.

### Success Criteria:

#### Automated Verification:
- [ ] `npm run build` succeeds.
- [ ] `npm test` passes.
- [ ] `npx tsc --noEmit` passes.

#### Manual Verification:
- [ ] Opening Obsidian shows a ribbon icon for the plugin.
- [ ] Clicking the ribbon icon opens the chat panel in the right sidebar; closing and reopening works.
- [ ] Typing a message and clicking Send shows the message in the transcript and, after a brief delay, the assistant's response rendered as Markdown (with bold, lists, and code blocks honored if the model produces them). _Note: Phase 2 ships a non-streaming round-trip; FR-005 (incremental streaming) is intentionally deferred to Phase 4._
- [ ] If the assistant attempts to invoke a tool (built-in or otherwise), the call is denied at the permission boundary and the denial surfaces in chat as a tool error rather than executing.
- [ ] Settings tab opens and shows the placeholder Phase-3 section.
- [ ] Closing Obsidian disposes the session cleanly (no zombie child processes).

---

## Phase 3: Device Flow OAuth, Token Persistence, and "Do Not Persist" Mode

**Objective**: Replace the hardcoded token with a real "Connect to GitHub" button that performs OAuth Device Flow against client ID `178c6fc778ccc68e1d6a` (the GitHub CLI's, used as a documented v0.1 development posture per Spec §Risks), persists the resulting `gho_` token via `Plugin.saveData` (or holds it in memory only when "do not persist" is enabled), and handles disconnect / reconnect.

### Changes Required:
- **`src/auth/DeviceFlow.ts`**: Implements `requestDeviceCode()` → `pollForToken()` against the documented GitHub endpoints. Handles `slow_down`, `authorization_pending`, `expired_token`, `access_denied` per the spec. Returns `{ token, scopes, expiresAt? }`. No SDK or Obsidian imports.
- **`src/auth/TokenStore.ts`**: Wrapper over `Plugin.loadData`/`saveData` exposing `get(): Promise<string|null>`, `set(token: string): Promise<void>`, `clear(): Promise<void>`. Persists into the plugin data file under key `auth.token`. Honors a `persistEnabled: boolean` flag from settings — when false, `set` keeps the token in memory only and `get` returns the in-memory value within the current process (returns null after restart).
- **`src/auth/AuthController.ts`**: Domain controller — combines DeviceFlow + TokenStore + emits state events (`disconnected | connecting | connected | error`). Settings tab and chat view subscribe to render state.
- **`src/settings/SettingsTab.ts`**: Replace placeholder section with full Connection section: shows current state and a "Connect to GitHub" button. On click: triggers `AuthController.connect`, displays the user code + verification URI in a modal with "Copy code" and "Open in browser" buttons, polls until success/failure, then closes the modal and updates state. Includes a "Disconnect" button that clears the token and tears down the session. Adds a "Do not persist token (memory-only)" toggle that controls `TokenStore.persistEnabled`.
- **`src/sdk/AgentSession.ts`**: Accept the token from `AuthController` via dependency injection; reconstruct the session when the token changes; expose a `reconnect()` method.
- **`src/ui/ChatView.ts`**: Render different states — "Not connected" (with Connect CTA), "Connecting…" (with the Device Flow code visible inline as a fallback to the modal), "Connected" (input enabled), "Auth error" (with Reconnect CTA).
- **Tests**:
  - `src/auth/DeviceFlow.test.ts` — mock `fetch`, exercise the polling state machine for each documented response code (`authorization_pending`, `slow_down`, success, `expired_token`, `access_denied`).
  - `src/auth/TokenStore.test.ts` — round-trip via in-memory `loadData`/`saveData` doubles; verify "do not persist" mode keeps the token only in memory.
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
- [ ] Restarting Obsidian preserves the connection — no re-auth needed (default persist mode).
- [ ] Enabling "Do not persist token", reconnecting, and restarting Obsidian shows "Not connected" state with no stored token.
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

**Objective**: Give the agent on-demand read access to the active vault via three tools, render tool invocations and results in the chat UI, and verify that built-in CLI tool calls (e.g., a synthetic `shell` invocation) flow through the same `onPermissionRequest` pipeline already wired in Phase 2 — i.e., the universal-approval-gate architecture works in practice.

### Changes Required:
- **`src/tools/VaultPath.ts`**: Single source of truth for vault-scope path safety. Exports `resolveVaultPath(input: string, vault: Vault): string` that:
  1. Rejects absolute paths and paths containing `..` segments.
  2. Resolves the input relative to `vault.adapter.getBasePath()`.
  3. Resolves `realpath` on the deepest existing ancestor (symlink defense).
  4. Verifies the resolved path is a strict descendant of the vault root using `path.relative(root, resolved).startsWith("..")` checks (cross-platform, including Windows separators).
  5. Throws `VaultPathError` with a clear message on any violation.
  Also exports `lookupTFile(path, vault)` which validates against Obsidian's known-files index as a second line of defense for read tools (so the agent cannot read files Obsidian doesn't track). Phase 7 generalizes this into a `ScopeRegistry` that handles vault + extra-vault roots; Phase 5 keeps it vault-only.
  **Path normalization rule** (resolves the inconsistency previously surfaced in cross-artifact review): tool inputs and allowlist entries are first classified by `path.isAbsolute(input)`. Absolute inputs (Windows `C:\…`, POSIX `/…`) are treated as candidates for extra-vault scope (see Phase 7); they are NOT stripped of their leading slash. Only relative inputs are normalized vault-relative — a leading slash on a relative-style input (e.g., `/inbox/file.md`) is stripped before matching, so `inbox/` and `/inbox/` resolve to the same vault scope. Tests cover absolute (POSIX + Windows), leading-slash relative, and clean-relative forms.
- **`src/tools/ReadTools.ts`**: Two SDK `defineTool` registrations that **override built-in counterparts** via `overridesBuiltInTool: true`. The override implementations are smart dispatchers — they route based on path resolution:
  - `read_file({ path: string })` — if path resolves inside the active vault, read via `vault.read(tFile)`; if it resolves inside any configured extra-vault root (Phase 7), read via `fs.readFile`; if outside both, return an "outside allowed roots" error. Returns `{ content }`.
  - `view({ path?: string, directory?: string })` — overrides the built-in `view`/`list`-style tool similarly: vault paths via `vault.getFiles()`, extra-vault paths via `fs.readdir`, outside → error.
  Plus one truly-custom tool (no built-in counterpart):
  - `search_content({ query: string, regex?: boolean })` — substring or regex search across markdown files in vault and extra-vault roots; returns `{ matches: Array<{ path, line, snippet }> }` capped at 50.
  Non-FS built-ins (`shell`, `web_fetch`, `memory`, etc.) are NOT overridden — they remain enabled and flow through `onPermissionRequest` as Phase 6 wires up.
- **`src/sdk/AgentSession.ts`**: Register the Phase-5 read tools. **Built-in tool handling**: do NOT disable built-in tools. Keep the Phase-2 `onPermissionRequest` wiring; the Phase-2 `denyAll` decision function still rejects everything (including built-ins) until Phase 6 installs the SafetyPolicy. Phase 5's contribution is verifying that built-in tool calls actually flow through the callback (i.e., the architectural premise holds in real use, not just smoke-test).
- **`src/ui/ToolCallBlock.ts`**: New component rendering an SDK `tool_call` event as a collapsible block in the chat transcript: header with tool name + source (custom / built-in) + summary; expanded view with arguments (JSON, syntax-highlighted) and result/error.
- **`src/domain/ChatState.ts`**: Extend `Message` to include `toolCalls: ToolCall[]` interleaved with text deltas in stream order; the UI renders them inline.
- **`src/ui/MessageRenderer.ts`**: Extend to render the interleaved text + tool-call sequence.
- **Tests**:
  - `src/tools/VaultPath.test.ts` — comprehensive: absolute paths, `..` traversal (single, nested, mixed separators), Windows-specific `C:\…` paths, symlinks (use a temp dir fixture), valid relative paths, vault-root-edge-case (`""`, `.`, `/`, `inbox/` vs `/inbox/`).
  - `src/tools/ReadTools.test.ts` — round-trip a fake vault, including the path-rejection paths.

### Success Criteria:

#### Automated Verification:
- [ ] `npm test` passes including new path-containment and read-tool tests.
- [ ] `npm run build` and `tsc --noEmit` pass.

#### Manual Verification (covers SC-002, SC-006):
- [ ] Asking the agent a question that requires reading at least one note (e.g., "What does my note titled X say about Y?") triggers a `read_file` or `search_content` tool call, visible as a collapsible block in chat.
- [ ] The agent's textual answer demonstrably reflects the contents of the consulted note.
- [ ] An attempt to read a path outside the vault (use a debugging command that injects a synthetic tool call with `../../etc/hosts`) is rejected at the wrapper layer and the agent receives an error result.
- [ ] **Built-in gating verification**: ask the agent to run a benign shell command (e.g., "run `echo hi` in the shell"). With the Phase-2 `denyAll` decision still in effect, the call is rejected at the permission boundary; the rejection is visible as a tool error in chat. This confirms built-in calls flow through the callback. (Phase 6 will replace `denyAll` with the SafetyPolicy that prompts the user.)

---

## Phase 6: Vault Write Tools, Safety Policy, and Undo

**Objective**: Wire the differentiated value of v0.1 — the agent can create, modify, and delete notes in the vault, with user-controlled safety, per-action Undo, and a uniform SafetyPolicy that gates filesystem writes, MCP tool calls, and built-in tool calls (the latter two land in later phases but the policy is built once here).

### Changes Required:
- **`src/domain/SafetyPolicy.ts`**: State machine encapsulating the safety decision for any tool call. Inputs: tool name, tool source (`custom-fs-vault | custom-fs-extra-vault | mcp | builtin`), target path (for filesystem tools), configured default mode, current session-grants (keyed by source + scope), configured allowlist. Output: `auto-apply | require-approval | rejected`. The output then maps to SDK return values: `auto-apply` → `approve-once`; `require-approval` → block on UI prompt, then return one of `approve-once | approve-for-session | reject` per user click; `rejected` → `reject`. **Source-classification table** (SDK `request.kind` → SafetyPolicy source bucket): `read`, `write` against a vault path → `custom-fs-vault`; `read`, `write` against an extra-vault root path → `custom-fs-extra-vault`; `mcp` → `mcp`; `shell`, `url`, `memory`, `hook`, `custom-tool` (when not one of our registered FS tools) → `builtin`. Modes: `auto-apply-with-undo` (default for filesystem writes), `require-approval`. For MCP and built-in tool calls, the default is always `require-approval` (no auto-apply) since they have no path-scoped containment story; the user opts into broader trust via "approve for session" or per-source allowlist entries (see allowlist grammar in Phase 6 settings). Session-grants tracked in-memory only (cleared on plugin reload, "Clear conversation", or Obsidian restart — NOT on chat-view close, per Spec FR-013). Pure logic, no IO.
- **`src/domain/UndoJournal.ts`**: Per-session journal of applied filesystem write actions (vault scope in this phase; extended to extra-vault in Phase 7): `{ id, kind: "create" | "modify" | "delete", scope: "vault" | "extra-vault", path, before?, after? }`. Provides `record(entry)` and `undo(id)`. Undo operations:
  - `create` undo → `vault.delete(path)`.
  - `modify` undo → `vault.modify(path, before)`.
  - `delete` undo → `vault.create(path, before)`.
  Journal cleared on plugin reload, "Clear conversation", or Obsidian restart — NOT on chat-view close (so reopening the view leaves Undo buttons functional for the active chat session). MCP and built-in tool calls are NOT recorded in the undo journal; their effects are out of scope for one-step revert.
- **`src/tools/WriteTools.ts`**: Three `defineTool` registrations using `overridesBuiltInTool: true` for `edit_file` and any other write-overlap built-ins; smart dispatch based on resolved path:
  - `create_file({ path, content })` — vault path → `vault.create` (intermediate dirs auto-created); extra-vault path → `fs.mkdir { recursive: true } + fs.writeFile`; outside roots → refusal.
  - `edit_file({ path, content })` — vault path: read existing for `before` snapshot via `vault.read`, perform unsaved-editor-conflict detection (iterate `app.workspace.getLeavesOfType("markdown")`, find any whose `MarkdownView.file` matches the target, compare `MarkdownView.editor.getValue()` against on-disk content; if differ, return a clear "file has unsaved changes in an open editor" error and do not write); then `vault.modify`. Extra-vault path: read existing for `before` snapshot via `fs.readFile`, write via `fs.writeFile` (no conflict detection — Obsidian's editor APIs are vault-scoped; documented limitation per Phase 7). Outside roots → refusal.
  - `delete_file({ path })` — vault path → `vault.read` for snapshot, then `vault.delete`. Extra-vault path → `fs.readFile` for snapshot, then `fs.unlink`. Outside roots → refusal.
  All three resolve paths via `ScopeRegistry` (introduced as a stub in Phase 5 covering vault-only; generalized in Phase 7) and run through the `SafetyPolicy` decision before any I/O.
- **`src/sdk/AgentSession.ts`**: Replace the Phase-2 `denyAll` permission decision with the `SafetyPolicy` decision function. The callback now: (1) classifies the tool source from the SDK request shape; (2) consults `SafetyPolicy`; (3) for `auto-apply` returns `approve-once` immediately; (4) for `require-approval` blocks on a UI prompt and returns `approve-once`, `approve-for-session`, or `reject` per user click; (5) for `rejected` returns `reject` immediately. Register the write tools alongside the read tools.
- **`src/ui/ApprovalPrompt.ts`**: Inline chat element rendered when a tool call is pending approval. Displays tool name, source (custom / MCP / built-in), and full arguments (e.g., the exact shell command for a `shell` call). Buttons: Approve Once, Approve All for Session (with explicit copy explaining its scope and that the grant resets on plugin reload / clear / restart), Reject. The "Approve All" button updates the session-grants in `SafetyPolicy` keyed by tool source so e.g. "approve all built-in" doesn't also auto-approve future MCP calls.
- **`src/ui/ToolCallBlock.ts`**: Extended to render an Undo button on completed filesystem write tool calls (vault scope here; extra-vault in Phase 7). Click → `UndoJournal.undo(id)` → updates the block to a "reverted" state. Built-in and MCP tool calls render without an Undo button (their effects are not journaled).
- **`src/settings/SettingsTab.ts`**: New "Safety" section: dropdown for default policy mode for filesystem writes (the only writes with a true "auto-apply" default); multi-line input for the **path allowlist** (one entry per line; vault-relative entries with no leading slash, or absolute paths for extra-vault entries — see Phase 7); a per-built-in **boolean toggles** group ("Auto-approve `shell`", "Auto-approve `web_fetch`", etc., one per non-FS-overlap built-in surfaced by the SDK at runtime — populated dynamically); the per-MCP-server toggles group is added in Phase 8. All toggles default off. The SafetyPolicy decision treats a toggled-on built-in or MCP-server entry as an effective `auto-apply` for that source, bypassing the approval prompt while still being visible in the chat tool-call block.
- **Tests**:
  - `src/domain/SafetyPolicy.test.ts` — every combination of (default mode × tool source × allowlist hit/miss × session-grants present/absent × tool name); cover the rule that MCP/built-in have no auto-apply default.
  - `src/domain/UndoJournal.test.ts` — record-undo-record sequences for all three write kinds against a fake vault.
  - `src/tools/WriteTools.test.ts` — path containment, directory auto-creation, error-on-conflict.

### Success Criteria:

#### Automated Verification:
- [ ] `npm test` passes including new safety/undo/write tests.
- [ ] `npm run build` and `tsc --noEmit` pass.

#### Manual Verification (covers SC-003, SC-004, SC-005):
- [ ] Default mode: asking the agent to "Create a note in `inbox/` with these bullets…" creates the file immediately; the chat shows an Undo button; clicking Undo removes the file.
- [ ] Switch default mode to "Require approval"; ask for a write; verify no file change occurs until Approve is clicked.
- [ ] Click "Approve all for this session"; verify subsequent vault writes auto-apply with no prompt; close and reopen the chat view; verify the next write STILL auto-applies (view close is NOT a reset trigger). Then disable+re-enable the plugin (reload); verify the next write prompts again (plugin reload IS a reset trigger).
- [ ] Configure an allowlist entry `inbox/` (no leading slash); with default mode "Require approval", verify writes within `inbox/` skip the prompt while writes outside still prompt. Repeat with `/inbox/` (with leading slash) and confirm the path normalization matches the same scope.
- [ ] Have a file open with unsaved changes; ask the agent to modify it; verify the tool fails with a clear error in chat rather than overwriting silently.
- [ ] Attempt a write to a path outside the vault (synthetic injected tool call); verify rejection with a clear error.
- [ ] **Built-in gating in action**: ask the agent to run `echo hi` in the shell. Now that `SafetyPolicy` is wired, the call surfaces an approval prompt with the full command visible. Click Approve Once; the command runs. Run the same prompt again; click Reject; the command does not run.

---

## Phase 7: Extra-Vault Filesystem Roots

**Objective**: Allow the user to configure additional filesystem roots beyond the vault (e.g., `C:\Repos\my-project\`). The same read/write tools, safety policy, and undo journal apply uniformly across the vault and all configured roots.

### Changes Required:
- **`src/domain/ScopeRegistry.ts`**: Generalizes the path-validation function from Phase 5's `VaultPath`. Inputs: an absolute candidate path; outputs: which root it belongs to (`{ kind: "vault" } | { kind: "extra-vault", root: string }` | rejection). Uses the same realpath + descendant-of-root verification logic as Phase 5 across the union of (vault root) and (configured extra-vault roots). Tool inputs are accepted as either vault-relative (no leading slash, treated as vault-rooted) or absolute (matched against the union of allowed roots).
- **`src/settings/SettingsTab.ts`**: Add "Extra-Vault Roots" section — list of absolute filesystem paths the user wants in scope. Add / remove buttons. Validates each entry on save: must be an absolute existing directory, not the vault itself, not nested within the vault. Persists via `loadData/saveData`.
- **`src/tools/ReadTools.ts`**: Update each tool to accept either vault-relative or absolute paths; route through `ScopeRegistry`; for `extra-vault` roots, use Node `fs.promises.readFile` / `readdir` / `stat` instead of the Vault adapter (the adapter is vault-scoped). `search_content` extends to walk extra-vault roots up to a sane depth/file-count cap.
- **`src/tools/WriteTools.ts`**: Update similarly — extra-vault writes use Node `fs.promises.writeFile` / `unlink` / `mkdir { recursive: true }`. Note: the unsaved-editor-conflict check is vault-only (Obsidian's open-editor APIs are vault-scoped); document the limitation and add a Phase Candidate for an extra-vault open-editor heuristic. SafetyPolicy is consulted exactly as in Phase 6, with `tool source = custom-fs-extra-vault` so session grants and allowlist entries can target either source.
- **`src/domain/UndoJournal.ts`**: Extend `record` / `undo` to handle `scope: "extra-vault"`:
  - `create` undo → `fs.unlink(absolutePath)`.
  - `modify` undo → `fs.writeFile(absolutePath, before)`.
  - `delete` undo → `fs.writeFile(absolutePath, before)` (and `mkdir -p` parent if needed).
- **`src/domain/SafetyPolicy.ts`**: Allowlist entries can now be vault-relative (e.g., `inbox/`) or absolute (e.g., `C:\Repos\my-project\`); the matcher chooses the right comparison based on entry shape.
- **Tests**:
  - `src/domain/ScopeRegistry.test.ts` — vault path, extra-vault path, ambiguous path (matches both), traversal escape attempts targeting extra-vault roots.
  - `src/tools/ReadTools.test.ts` and `src/tools/WriteTools.test.ts` — extended for extra-vault paths against a tmp-dir fixture.
  - `src/domain/UndoJournal.test.ts` — extra-vault create/modify/delete undo round-trips against tmp-dir.

### Success Criteria:

#### Automated Verification:
- [ ] `npm test` passes including extra-vault path and tool tests.
- [ ] `npm run build` and `tsc --noEmit` pass.

#### Manual Verification (covers SC-010, partial SC-004 for extra-vault):
- [ ] Configure `C:\Repos\<some-project>\` as an extra-vault root; ask the agent "list the files in `<some-project>`"; verify a `list_files` tool call returns the expected files under the same approval-gate flow as the vault.
- [ ] Ask the agent to modify a file in `<some-project>`; verify the same auto-apply-with-undo (or require-approval) flow; verify Undo reverts the file.
- [ ] Configure an allowlist entry `C:\Repos\<some-project>\sandbox\` and a default mode of "Require approval"; verify writes inside `sandbox/` skip the prompt while writes elsewhere in `<some-project>` still prompt.
- [ ] Attempt a write to a path outside both the vault and any configured root (e.g., `C:\Windows\` synthetic injection); verify rejection with a clear error.
- [ ] Restart Obsidian after deleting (or renaming) the configured root directory on disk; verify the plugin starts without errors and tool calls targeting the missing root produce a clear "extra-vault root no longer exists" error rather than crashing.
- [ ] Remove the configured root; verify subsequent tool calls targeting it now produce a clear "outside allowed roots" error.

---

## Phase 8: MCP Integration

**Objective**: Discover MCP servers from a JSON config file; spawn each server; enumerate its tools; bridge them through the agent's `defineTool` registry so they pass through the same `onPermissionRequest` gate as everything else.

### Changes Required:
- **MCP config location**: documented as `<vault>/.obsidian/plugins/obsidian-copilot-agent/mcp_servers.json` (per-vault) or a global default if absent. Format mirrors Claude Desktop / VS Code conventions: `{ "servers": { "<name>": { "command": "...", "args": [...], "env": { ... }, "type": "stdio" } } }`.
- **`src/mcp/McpRegistry.ts`**: On startup, reads the config file (gracefully no-op if missing). For each server entry, spawns the configured command/args (Node `child_process.spawn` with stdio pipes); performs the MCP `initialize` handshake; calls `tools/list`; for each returned tool, registers a corresponding `defineTool` in the SDK with name `<server>__<tool>` (or per Phase-1 finding, via the SDK's native MCP support if it exists). Each tool's handler forwards the call via the MCP `tools/call` JSON-RPC method and returns the result. Tool source classified as `mcp` for SafetyPolicy purposes.
- **`src/mcp/McpClient.ts`**: Minimal MCP JSON-RPC client (only the subset we need: `initialize`, `tools/list`, `tools/call`, `notifications/cancelled`). Imports nothing Obsidian- or SDK-specific.
- **`src/mcp/McpHealth.ts`**: Surfaces server state (`starting | ready | failed | crashed`) in chat or settings. On crash, the registry attempts a single re-init; further failures are reported and the affected tools are marked unavailable.
- **`src/sdk/AgentSession.ts`**: Initialize `McpRegistry` after the session is constructed and before tools are first exposed. Wait for at least the `initialize` round-trip to settle (or time out per server) so the agent's tool list is reasonably stable on first user message.
- **`src/settings/SettingsTab.ts`**: Add "MCP Servers" section — read-only list of configured servers showing name + status; an "Open mcp_servers.json" button that opens the file in the user's default editor; a "Restart MCP servers" button.
- **Documentation**: README section "Configuring MCP servers" with a worked example (e.g., a generic stdio server).
- **`Phase1-SmokeTest-Notes.md`**: this phase relies on the Phase-1 finding about whether the SDK natively bridges MCP. If yes, this phase is mostly configuration; if no (likely), this phase implements the bridge as described above.
- **Tests**:
  - `src/mcp/McpClient.test.ts` — JSON-RPC framing, request/response correlation, initialize handshake, tools/list, tools/call success/error.
  - `src/mcp/McpRegistry.test.ts` — server lifecycle (spawn, init, tool registration, crash handling) against a fake child process.

### Success Criteria:

#### Automated Verification:
- [ ] `npm test` passes including new MCP tests.
- [ ] `npm run build` and `tsc --noEmit` pass.

#### Manual Verification (covers SC-011):
- [ ] Configure at least one MCP server in `mcp_servers.json` (e.g., a public filesystem MCP server in a sandbox directory); restart the plugin; verify the server's tools appear in the agent's available-tool list (visible by asking "what tools do you have?").
- [ ] Ask the agent to invoke one of those tools; verify the call surfaces an approval prompt under the same SafetyPolicy as a vault write; on Approve Once the call runs and the result is reported.
- [ ] Configure an MCP server with a deliberately bad command; verify the failure is surfaced in the Settings "MCP Servers" status and in chat the first time a user references that server, without crashing the rest of the plugin.
- [ ] Click "Approve all for this session" on an MCP tool; verify subsequent calls to that server's tools auto-apply; verify built-in tool calls still prompt (sources are tracked separately).

---

## Phase 9: Model Selection, Cross-Restart Resume, and Polish

**Objective**: Close the spec gap on model selection, conversation persistence with model-side context continuity (via SDK `resumeSession`), and remaining edge-case UX. Land the threat-model README disclosure.

### Changes Required:
- **`src/sdk/Models.ts`**: Helper that enumerates models available to the current SDK session via the SDK's `client.listModels()` API (confirmed available per CodeResearch §R1). A defensive fallback to a small hardcoded curated list applies only on enumeration error (e.g., transient network failure), with a warning in the chat. Exposes `listModels()` and `setActiveModel(id)`.
- **`src/settings/SettingsTab.ts`**: Add "Model" section — dropdown of available models with current selection persisted via `loadData/saveData`. Default chosen at first connection. Settings copy explicitly notes: "Switching model recreates the agent session; the new model will not have context from prior turns until you continue the conversation. Existing chat history remains visible."
- **`src/sdk/AgentSession.ts`**: On model change, dispose the current SDK session and create a new one with the new model. Subsequent user messages flow into the new session. The chat UI surfaces a thin separator labeled "Model switched to <name>" so the user sees the boundary.
- **`src/domain/ChatState.ts`**: Add serialization — `serialize(): Json` and `deserialize(Json)`. Persist after every message transition; load on plugin start. Includes the SDK session ID (if known) so resume can target it.

### Cross-Restart SDK Session Continuity (Resume):

For v0.1 we adopt **SDK `resumeSession`-based context continuity**. On plugin load, if a persisted SDK session ID is present in `ChatState`, `AgentSession` calls `client.resumeSession(sessionId)` (signature confirmed in Phase 1) before exposing the chat view as ready. On success, the user can send a new message that references pre-restart turns and the agent retains its model-side context.

**Failure handling**: if `resumeSession` throws (corrupted SDK state, version drift, expired session, missing session-state directory), the plugin falls back to display-only history: the persisted `ChatState` is rendered and a clear chat-level indicator is shown ("Resumed history is shown, but the agent's prior context could not be restored. Continuing the conversation will start a fresh agent context."). A fresh `createSession` proceeds for subsequent messages. The fallback is identical to what would otherwise have been Phase 7's display-only design.

**SDK-side persistence isolation**: the SDK persists its own session state under `~/.copilot/session-state/<sessionId>/` and enables `infiniteSessions: true` by default. v0.1 does not attempt to disable this; it accepts that SDK-side persistence is global to the user's machine and trusts the SDK's session-ID scoping. Multi-vault behavior: each vault's `ChatState` references its own session ID, so opening vault A then vault B resumes B's session; A's session is preserved on disk but inert until A is reopened. README Known-Limitations section documents this.

- **`src/main.ts`**: Persistence wiring; "Clear conversation" command + button in chat header; "Clear conversation" also abandons the persisted session ID so the next message starts fresh (the abandoned SDK session-state directory is best-effort deleted).
- **`src/main.ts`** (mobile guard): Although `manifest.json` declares `isDesktopOnly`, defend in code as well — if `Platform.isMobile`, refuse to register the view and show a one-time Notice.
- **Auth-failure recovery**: If a streamed response fails with an auth error, surface a clear chat error block with a Reconnect button that triggers `AuthController.connect`. (Most of the wiring exists from Phase 3; this phase ties it into the streaming error path.)
- **`README.md`**: Section "Security and Privacy" disclosing the token-storage model (plain JSON in vault `.obsidian/plugins/` data file by default; in-memory only when "Do not persist token" is enabled), the implication for synced vaults (sync providers see the persisted token), the broader blast radius of built-in tools and extra-vault writes, the trust model for MCP servers, and the recommendation to use a separate test vault for sensitive data. Section "Known Limitations" listing v0.1 deferrals (cross-restart undo, MCP credential UI, dedicated OAuth App, etc.).
- **Tests**: `src/domain/ChatState.test.ts` — round-trip serialization for transcripts containing tool calls and a session ID. `src/sdk/AgentSession.test.ts` — resume-success and resume-fallback paths against a mocked SDK.

### Success Criteria:

#### Automated Verification:
- [ ] `npm test` passes.
- [ ] `npm run build` and `tsc --noEmit` pass.

#### Manual Verification (covers SC-007, SC-008, SC-009):
- [ ] Restarting Obsidian preserves the chat transcript (user messages, assistant messages, and tool-call records all reload). After restart, send "what was my project name?" referencing a name introduced in a pre-restart turn — the agent answers correctly, demonstrating model-side context continuity via `resumeSession`.
- [ ] Simulate a `resumeSession` failure (e.g., delete the SDK's session-state directory while Obsidian is closed, then reopen). The plugin falls back to display-only with a clear chat indicator; subsequent messages work in a fresh context.
- [ ] "Clear conversation" empties the transcript, resets session-grants, and abandons the persisted SDK session.
- [ ] Switching the active model in settings causes the next user message to be processed by a session using the new model; a chat-level indicator marks the model boundary; asking the model to identify itself confirms the switch.
- [ ] Loading the plugin on Obsidian mobile (or simulating `Platform.isMobile`) does not register the chat view; a one-time Notice indicates desktop-only.
- [ ] Manually revoking the token and sending a message shows the auth-error chat block with a working Reconnect button.

---

## Phase 10: Documentation

**Objective**: Author the as-built technical reference and finalize the README.

### Changes Required:
- **`.paw/work/copilot-sdk-spike/Docs.md`**: Technical reference. Sections: architecture overview (the four-layer separation), SDK adapter contract, universal-approval-gate design (one `onPermissionRequest` for custom + MCP + built-in), safety/undo/scope-registry design, Device Flow flow diagram, persistence layout (what lives in `loadData` keys, where `mcp_servers.json` lives, where SDK session state lives), MCP integration architecture, known limitations, threat model, and a section "Notes for v0.2" listing the items in Phase Candidates. Load `paw-docs-guidance` for style.
- **`README.md`**: Audience is the work-unit author (and any future contributor reviewing the spike). Sections: features at a glance (with one screenshot placeholder), **manual installation** (clone repo → `npm install` → `npm run build` → copy `main.js` + `manifest.json` into `<vault>/.obsidian/plugins/obsidian-copilot-agent/` → reload Obsidian → enable in community-plugin settings), first-run / Connect-to-GitHub flow, configuration (model, safety policy, allowlist with FS paths + per-built-in toggles + per-MCP-server toggles, extra-vault roots, MCP servers), security & privacy disclosure (private-spike posture, CLI client ID dev-only caveat, vault + extra-vault + shell + web-fetch blast radius), troubleshooting, follow-up-work-unit pointer for OAuth App + BRAT.
- **`CHANGELOG.md`**: New file — entry for v0.1 listing high-level capabilities (vault read/write, extra-vault FS, MCP, gated built-ins, OAuth, resume continuity).

### Success Criteria:

#### Automated Verification:
- [ ] `npm run build` succeeds.

#### Manual Verification:
- [ ] `Docs.md` accurately describes the implemented architecture (cross-checked against final code in each layer).
- [ ] README installation steps walk a fresh checkout from clone → build → manual install → Connect → first message without ambiguity.
- [ ] Threat-model section explicitly addresses synced-vault token exposure, the broader blast radius of built-in tools (shell, web-fetch, host-fs) and extra-vault writes, the user's responsibility for the MCP servers they configure, and the recommendation to use a dedicated vault for sensitive notes.
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
