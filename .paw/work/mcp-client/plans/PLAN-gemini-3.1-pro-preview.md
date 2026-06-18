# v0.5 MCP Client Integration — Implementation Plan

<!-- Draft created by gemini-3.1-pro-preview based on PAW planning workflow -->

## Overview

v0.5 introduces Model Context Protocol (MCP) client capabilities to obsidian-copilot-agent, enabling users to augment the agent with external tools running over `stdio` and Streamable HTTP. This is purely additive: existing v0.4 baselines (multi-conversation, token rotation, undo, model picker, vault preamble) remain untouched and must stay green when MCP is unused. The integration leverages `@modelcontextprotocol/sdk` (v1.x) to handle JSON-RPC messaging, capabilities negotiation, and tool discovery.

A core safety invariant of v0.5 is the **Universal Approval Gate**: all discovered MCP tools are mutating-by-default and not undoable. They route through the same `SafetyPolicy` as vault tools, and any auto-approval relies on exact identity match (stable server ID + tool name) to prevent spoofing or stale trust. Furthermore, bounded I/O, strict timeouts, unescaped prompt text, and deterministically capped pagination ensure MCP servers cannot hang the plugin, exhaust memory, or deceive the user via markdown injection.

## Current State Analysis

- The plugin currently exposes built-in vault tools (FS read/write/search) via `src/sdk/AgentSession.ts` and UI in `src/ui/ToolCallBlock.ts`.
- `decideSafety` in `src/domain/SafetyPolicy.ts` and `AgentSession.buildSafetyInput` handle the permission gate.
- Reverting a state relies on `src/domain/UndoJournal.ts` with explicit `UndoEntry` payloads.
- `src/settings/SettingsTab.ts` defines UI via standard DOM composition and Obsidian controls.
- The v0.4 test suite ensures 724/724 baseline green before new features.

## Desired End State

- `data.json` contains `mcpServers: McpServerConfig[]` storing stdio configurations (command, args, env, cwd) and HTTP configurations (URL, static Authorization header).
- Settings UI provides add, edit, disable, remove, and reconnect affordances for each server, along with visible connection status and local diagnostics (last error, crashloop state).
- The client connects at plugin load (or setting enable), negotiates `2025-06-18` (or falls back to `2024-11-05`), and runs full paginated tool discovery.
- Discovered tools appear in the agent preamble with an `(MCP / <server-display-name>)` attribution and register with synthetic collision-resistant IDs (`mcp__<server-id>__<tool-name>`).
- All execution attempts trigger an approval modal (with unrendered plain-text arguments/descriptions) unless the stable ID + tool name holds a persistent grant in `mcpAutoApprove`.
- Execution errors and timeout failures are correctly bucketed as `isError` in tool call blocks.
- `Undo` is suppressed for MCP blocks. Binary content payloads render as text placeholders.
- A robust crash recovery pipeline handles auto-reconnect, prevents zombie child processes on plugin unload, and terminates requests cleanly without blocking the chat.

## Phase Status

- [ ] **Phase 1: Persistence Shape & Settings UI** — Add `mcpServers` schema, config management UI, URL/TLS validation, and grant revocation on config edits.
- [ ] **Phase 2: Protocol Transport & Discovery (Headless)** — Wrap `@modelcontextprotocol/sdk@1.29.0` for stdio process spawning (with env/PATH filters) and Streamable HTTP connection. Wire initialization, protocol negotiation, and capabilities exchange.
- [ ] **Phase 3: Tool Discovery, Registry & Preamble** — Implement tool pagination, synthetic ID collision-safe registration, atomic registry swap, and preamble integration with truncated instructions.
- [ ] **Phase 4: Safety Wiring & Universal Approval Gate** — Route MCP calls through `SafetySource = "mcp"`, enforce `mcpAutoApprove` rules, and implement plain-text safe rendering for approval modals.
- [ ] **Phase 5: Tool Execution, Rendering & Undo** — Call tools, handle `isError`, render results in `ToolCallBlock`, replace binaries with placeholders, and suppress Undo button.
- [ ] **Phase 6: Resilience, Recoverability & Lifecycle** — Add strict timeout caps, 16 MiB payload limits, stdio auto-reconnect with crashloop state, `list_changed` coalescing, HTTP session lifecycle, and plugin unload cleanup.
- [ ] **Phase 7: Documentation** — Produce Docs.md, update README.md, and append CHANGELOG.md.

## Phase Candidates (Deferred)

- Acting as an MCP server.
- OAuth flow for MCP servers.
- MCP resources, prompts, sampling, elicitation, roots.
- Live registry/browsing of public MCP servers.
- Deprecated HTTP+SSE transport fallback.
- Telemetry/cost accounting for MCP tool usage.
- Undo journal entries for MCP tool calls.

## Phase Ordering Rationale

1. **Phase 1 (Persistence & UI)** creates the static data structure and user touchpoints.
2. **Phase 2 (Transport)** relies on the configs from Phase 1 to establish connections securely without yet changing the agent's behavior.
3. **Phase 3 (Registry)** consumes the transport from Phase 2 to map external tools into the internal SDK surface.
4. **Phase 4 (Safety)** establishes the permission gates *before* we allow any actual execution.
5. **Phase 5 (Execution)** completes the loop by running the tools and displaying results.
6. **Phase 6 (Resilience)** hardens the integration against crashes and long-running hangs (best done once the core flow exists to verify edge cases).
7. **Phase 7 (Docs)** documents the final as-built state.

---

## Phase 1: Persistence Shape & Settings UI

### Goals
Introduce `mcpServers: McpServerConfig[]` in `data.json`. Implement the Settings tab to add, edit, disable, remove, and reconnect servers. Enforce URL and TLS validations, and ensure auto-approve grants are properly revoked when server configs mutate.

### Scope
- `src/persistence/PersistedShape.ts`, `src/persistence/migrate.ts`
- `src/settings/SettingsTab.ts`, `src/settings/SettingsStore.ts`
- `src/domain/SafetyPolicy.ts` (mcpAutoApprove grant clearing logic)

### Implementation
- **Schema**: Add `mcpServers` array. Config holds `id` (slug), `name`, `enabled`, `transport`, `status`, `lastError`, plus specific stdio (`command`, `args`, `env`, `cwd`) or HTTP (`url`, `headers`) fields.
- **UI**: Add sections to `SettingsTab`. Validate fields on Add/Edit.
- **Security Check**: Enforce `http://` rejection (unless loopback), cloud metadata blocks, and private network warnings (FR-025). Redact `Authorization` fields.
- **Grant Rotation**: Changing a server's name, command, args, or url rotates its trust epoch identity and revokes existing grants (FR-012, SC-019). Removing a server clears grants.

### Required Tests & Quality Gates
- **Quality Gates**: `npm test`, `npm run typecheck`, `npm run build`
- **Unit/Integration**: Config persistence, `src/persistence` sibling-key preservation, URL/TLS/SSRF validation tests, Settings UI/controller rendering, grant revocation on edit.
- **Manual Verification**: Add a fake stdio server, check rows. Disable, remove, reconnect, checking UI feedback. Edit name and confirm grants drop (SC-001, SC-019).

---

## Phase 2: Protocol Transport & Discovery (Headless)

### Goals
Introduce the `@modelcontextprotocol/sdk` (v1.29.0) wrapper. Manage the `stdio` (child process with exact environment filtering) and Streamable HTTP lifecycle without exposing tools to the agent yet.

### Scope
- `src/mcp/McpClientManager.ts` (new)
- `src/mcp/transports/*`

### Implementation
- **SDK**: Use `StdioClientTransport` and `StreamableHTTPClientTransport`.
- **Stdio Environment**: Launch with `shell: false`. Full inherit minus denylist (block tokens/API keys), plus explicit per-server env injections. On macOS, prepend `/usr/local/bin` and `/opt/homebrew/bin` to `PATH` (FR-004, FR-022, FR-023).
- **HTTP Transport**: POST to configured URL, handle Streamable HTTP headers. (FR-005). Drop Authorization on cross-origin redirects (FR-025).
- **Protocol**: Negotiate `2025-06-18`, fall back to `2024-11-05` if Streamable HTTP / stdio framing matches. Reject legacy HTTP+SSE outright (FR-006, FR-029).

### Required Tests & Quality Gates
- **Quality Gates**: `npm test`, `npm run typecheck`, `npm run build`
- **Unit/Integration**: Fake child-process transport tests (launch, crash, version negotiation), Streamable HTTP mock transport tests, Env-filter wildcard tests, macOS PATH tests, Protocol matrix (FR-029).
- **Manual Verification**: Connect a reference stdio server and verify process spawns with correct PATH. Connect an HTTP server and verify `2025-06-18` handshake.

---

## Phase 3: Tool Discovery, Registry & Preamble

### Goals
Paginate through `tools/list` on connect, generate collision-safe synthetic IDs, store instructions, and inject discovered tools into the vault-aware preamble.

### Scope
- `src/mcp/McpRegistry.ts` (new)
- `src/sdk/AgentSession.ts`
- `src/domain/PreambleAssembler.ts`

### Implementation
- **Pagination**: Traverse `nextCursor` up to a cap of 50 pages or 1000 tools per server (FR-008).
- **Synthetic IDs**: Register as `mcp__<server-id>__<tool-name>`. Prevent duplicates within same server. Reject if synthetic ID collides with a built-in vault tool (FR-009).
- **Preamble**: Assemble tools dynamically under `<tool-name> (MCP / <display-name>)`. Truncate `InitializeResult.instructions` to 4 KB per server and inject (FR-010).

### Required Tests & Quality Gates
- **Quality Gates**: `npm test`, `npm run typecheck`, `npm run build`
- **Unit/Integration**: Pagination logic (timeout, cap exceedance), Registry collision behavior (`src/sdk/AgentSession.test.ts`), Preamble assembler tests.
- **Manual Verification**: Two fake servers with shared `read_file` name, observe distinct IDs and correct preamble output. Verify empty MCP lists preserve v0.4 preamble baseline. (SC-016, SC-005).

---

## Phase 4: Safety Wiring & Universal Approval Gate

### Goals
Enforce permission gates for every MCP call via `SafetySource = "mcp"`, allowing auto-approval only via explicit `(stableServerId, toolName)` matches. Ensure safe UI rendering.

### Scope
- `src/domain/SafetyPolicy.ts`
- `src/ui/ApprovalModal.ts`

### Implementation
- **Integration**: Map `kind === "mcp"` to `source: "mcp"` in `buildSafetyInput`. All calls prompt by default.
- **Safe Rendering**: Truncate displayed arguments at 4 KB. Escape plain text for names/descriptions/args to avoid markdown/HTML injection in the prompt (FR-030).
- **Untrusted Annotations**: Ensure `readOnlyHint` never bypasses approval.

### Required Tests & Quality Gates
- **Quality Gates**: `npm test`, `npm run typecheck`, `npm run build`
- **Unit/Integration**: `SafetyPolicy.test.ts` for grant scopes, Approval UI rendering tests (markdown/HTML injection checks).
- **Manual Verification**: Inject malicious descriptions/HTML tags into tool args, ensure plain text rendering in modal. Verify `readOnlyHint` still prompts. (SC-003, SC-004).

---

## Phase 5: Tool Execution, Rendering & Undo

### Goals
Execute `tools/call`, manage execution errors, suppress the Undo mechanism, and render non-text content gracefully.

### Scope
- `src/mcp/McpCallAdapter.ts` (new)
- `src/ui/ToolCallBlock.ts`
- `src/domain/UndoJournal.ts`

### Implementation
- **Execution**: Route to server via synthetic ID map. `isError: true` renders as tool-execution error.
- **Undo**: Return void/null from Undo integration, suppress Undo UI button in `ToolCallBlock` for MCP blocks (FR-013).
- **Binary Content**: Replace `image`/`audio` payload responses with `[image: <mime>, N bytes]` placeholder to avoid bloated context injection (FR-015).

### Required Tests & Quality Gates
- **Quality Gates**: `npm test`, `npm run typecheck`, `npm run build`
- **Unit/Integration**: MCP call adapter execution, Result-normalization tests for mixed binary/text content, Undo regression tests.
- **Manual Verification**: Run a successful call and verify missing Undo button (SC-001). Run a tool returning base64, confirm placeholder text renders (SC-011).

---

## Phase 6: Resilience, Recoverability & Lifecycle

### Goals
Implement robustness bounds: timeout policies, 16 MiB payload caps, HTTP session drop, auto-reconnect loops, atomic list updates, and safe `onunload` teardown.

### Scope
- `src/mcp/McpClientManager.ts`
- `src/main.ts`

### Implementation
- **Timeouts**: Initialize (10 s), list (10 s), call (default 60 s, cap 300 s). Cancel in-flight on Stop (FR-021, FR-027).
- **Caps**: Stdio frames and HTTP bodies max 16 MiB. Stdio stderr ring buffer keeps last 64 KiB for diagnostics (FR-028).
- **Reconnect**: Stdio uses exponential backoff (1s→32s capped at 60s). Max 5 attempts per 5 mins puts server in `crashloop` terminal UI state (FR-018). HTTP drops volatile `Mcp-Session-Id` and reinitializes on next call (FR-019).
- **list_changed**: Coalesce notifications; wait for in-flight calls to settle, fetch diff, and execute atomic registry swap (FR-020).
- **Shutdown**: On disable/remove or `onunload`, stdio gracefully tears down: close stdin → wait 5s → SIGTERM → wait 5s → SIGKILL (FR-024).

### Required Tests & Quality Gates
- **Quality Gates**: `npm test`, `npm run typecheck`, `npm run build`
- **Unit/Integration**: Fake-timer timeout tests, Oversized stdio/HTTP payload tests, Reconnect loop/crashloop state tests, `list_changed` concurrency tests, Fake-process shutdown tests.
- **Manual Verification**: Kill stdio child process mid-call, observe error and 1s auto-reconnect (SC-006). Trigger 5 immediate failures, observe crashloop state (SC-015). Trigger HTTP mid-call drop (SC-007).

---

## Phase 7: Documentation

### Goals
Ensure complete external documentation and verify bundle limits.

### Scope
- `README.md`, `CHANGELOG.md`
- `.paw/work/mcp-client/Docs.md`

### Implementation
- Generate user-facing markdown guides covering how to configure servers, macOS pathing nuances, explicit env variables, and private IP warnings.
- Check bundle size metric; confirm SDK client tree-shaking yields ≤ 80 KB gzip diff or explicitly waive with notes.

### Required Tests & Quality Gates
- **Quality Gates**: `npm test`, `npm run typecheck`, `npm run build` (full final pass)
- **Manual Verification**: Full v0.4 724-test baseline remains green when no MCP servers are enabled (SC-005).

---

## Requirements Traceability

| ID | Description | Phase | Test Surface / Specifics |
|---|---|---|---|
| FR-001 | Server config persistence | 1 | Persistence + sibling-key tests. |
| FR-002 | Server config lifecycle UI | 1 | Settings UI/controller tests. |
| FR-003 | Static HTTP Authorization header | 1 | HTTP config/redaction tests. |
| FR-004 | Stdio transport | 2 | Stdio fake-process tests. |
| FR-005 | Streamable HTTP transport | 2 | HTTP mocked transport tests. |
| FR-006 | Protocol version negotiation | 2 | Protocol version matrix tests. |
| FR-007 | Capabilities negotiation | 2 | Capabilities checks on init. |
| FR-008 | Full tools/list pagination | 3 | Tool discovery/pagination limits tests. |
| FR-009 | SDK tool registration | 3 | Collision handling, AgentSession registry test. |
| FR-010 | Preamble inventory and instructions | 3 | Preamble assembler test. |
| FR-011 | Universal permission gate routing | 4 | `SafetyPolicy.test.ts`. |
| FR-012 | MCP auto-approval allowlist | 1, 4 | Grant rotation, identity checks. |
| FR-013 | MCP calls are not undoable | 5 | `ToolCallBlock` and Undo regression tests. |
| FR-014 | Tool call execution & rendering | 5 | MCP adapter and block execution test. |
| FR-015 | Image/binary placeholders | 5 | Result-normalization checks. |
| FR-016 | Crash/disconnect resilience | 6 | Resilience/disconnect tests. |
| FR-017 | Manual reconnect | 1, 6 | Reconnect controller logic. |
| FR-018 | Stdio auto-reconnect | 6 | Fake-timer reconnect/crashloop test. |
| FR-019 | HTTP session id lifecycle | 6 | Lifecycle / redaction checks. |
| FR-020 | list_changed coalescing | 6 | Concurrency/atomic-swap tests. |
| FR-021 | Cancellation and Stop | 6 | Cancellation/Stop tests. |
| FR-022 | Stdio env filtering | 2 | Env-filter exact keys/wildcard tests. |
| FR-023 | macOS PATH amendment | 2 | PATH builder checks. |
| FR-024 | Stdio shutdown sequence | 6 | Teardown sequence timers/SIGKILL tests. |
| FR-025 | HTTP URL and TLS posture | 1 | TLS/SSRF validation / warning modal tests. |
| FR-026 | MCP-disabled baseline | 3 | Existing v0.4 test suite + smoke test. |
| FR-027 | Request timeout policy | 6 | Fake-timer timeout test. |
| FR-028 | Bounded I/O & payload | 6 | Payload >16MiB teardown tests. |
| FR-029 | Transport compatibility (`2024-11-05`) | 2 | Legacy HTTP+SSE rejection tests. |
| FR-030 | Approval safe rendering | 4 | HTML/Markdown injection prompt test. |
| NFR-001 | Performance (latencies) | 6 | Async discovery performance timeout tests. |
| NFR-002 | Resilience (no crashes) | 6 | Malformed response tests. |
| NFR-003 | Security (env, URLs, prompts) | 1, 2, 4 | Validation rules + human approvals. |
| NFR-004 | Compatibility (`2025-06-18`) | 2 | Matrix compatibility. |
| NFR-005 | Bundle size (≤80 KB gzip) | 7 | ESBuild inspection. |
| NFR-006 | Accessibility | 1, 4 | UI audits. |
| NFR-007 | Baseline preservation | All | Green v0.4 724/724 suite. |
| NFR-008 | Observability (no telemetry) | 6 | Local diagnostics checking. |

### Success Criteria Mappings
- **SC-001** (Stdio end-to-end, no Undo): Phases 1, 2, 5
- **SC-002** (Streamable HTTP end-to-end): Phases 2, 3, 5
- **SC-003** (Grants tie to stable IDs): Phase 4
- **SC-004** (Escape text in prompts): Phase 4
- **SC-005** (No-MCP behaves like v0.4): Phase 3, 7
- **SC-006** (Stdio exit mid-call recovers): Phase 6
- **SC-007** (HTTP disconnect recovers): Phase 6
- **SC-008** (list_changed atomic coalescing): Phase 6
- **SC-009** (Env/PATH injection checks): Phase 2
- **SC-010** (Clean stdio unload via 5s sequence): Phase 6
- **SC-011** (Binary placeholders render): Phase 5
- **SC-012** (HTTP config survives, session ID vanishes): Phase 1, 6
- **SC-013** (Deterministic timeouts): Phase 6
- **SC-014** (Oversized failure caps): Phase 6
- **SC-015** (Crashloop state max 5 failures): Phase 6
- **SC-016** (Duplicate tool IDs resolve, built-ins win): Phase 3
- **SC-017** (HTTP checks reject invalid/private): Phase 1
- **SC-018** (2024-11-05 fallback accepted, legacy SSE rejected): Phase 2
- **SC-019** (Config edit revokes grants): Phase 1
