# v0.5 MCP Client Integration — Implementation Plan

<!-- Synthesized from plans/PLAN-gpt-5.4.md, plans/PLAN-gemini-3.1-pro-preview.md, and plans/PLAN-claude-opus-4.7.md. The per-model drafts remain in plans/ for traceability; this file is canonical from this point. -->

## Overview

v0.5 adds outbound Model Context Protocol (MCP) client support to `obsidian-copilot-agent`. Users can manually configure stdio and Streamable HTTP MCP servers, discover their tools, surface those tools to the Copilot SDK alongside built-in vault tools, and execute them through the existing approval UI.

The implementation is additive. With no MCP servers configured, or with every server disabled, the plugin must behave like v0.4: no spawned processes, no HTTP MCP connects, no MCP tools in the preamble or SDK surface, and the existing 724-test baseline remains green.

**Recommended SDK:** `@modelcontextprotocol/sdk@1.29.0`, the latest stable v1.x captured in `SpecResearch.md` and rechecked during planning with `npm view @modelcontextprotocol/sdk version`. Use client-only imports (`client/index.js`, `client/stdio.js`, `client/streamableHttp.js`, and `types.js`) and record the gzip bundle delta when the dependency lands.

**Phase shippability invariant:** MCP tool execution is impossible until the universal approval gate and stable identity model are in place. Phases can be paused after each quality gate; intermediate states must either be headless or keep chat behavior v0.4-equivalent.

## Current State Analysis

- `src\domain\SafetyPolicy.ts` already defines `SafetySource = "mcp"`, `SafetyState.grantMcp(...)`, `mcpAutoApprove`, and top-level `decideSafety(...)`. The current MCP scope is server-name-only; v0.5 must change it to stable `(serverId, toolName, trustEpoch)` semantics.
- `src\sdk\AgentSession.ts` owns permission routing, `buildSafetyInput(...)`, pending approval resolution, stream cancellation, and custom tool registration. It is the anchor for mapping synthetic MCP tools to `source: "mcp"` before `tools/call`.
- `src\ui\ToolCallBlock.ts` already centralizes tool-call rendering and Undo visibility. v0.5 must ensure MCP blocks never render Undo and safely render MCP-controlled strings/arguments.
- `src\domain\PreambleAssembler.ts` builds the vault-aware preamble and vault tool inventory. It needs an MCP inventory/instructions extension while preserving no-MCP output.
- `src\settings\SafetySettingsStore.ts`, `src\settings\SettingsTab.ts`, and `src\main.ts` provide the existing store, settings UI, and plugin lifecycle patterns. MCP settings/manager wiring should follow these patterns rather than living in chat UI.
- `src\persistence\PersistedShape.ts`, conversation stores, and settings stores demonstrate the repo’s sibling-preserving persistence requirement.
- Current checkout baseline is v0.4+ with model picker already present; planning must preserve streaming, Stop, token rotation, Undo, raw-FS gating, vault preamble, deferred-init recovery, and send-gate precedence.

## Desired End State

- `data.json` persists additive MCP configuration: stable server id/slug, display name, enabled flag, trust epoch, transport-specific fields, timeout, status/last-error metadata, stdio env/cwd, and HTTP URL/headers including static `Authorization`.
- Volatile runtime state is never persisted: clients, child handles, timers, in-flight calls, server instructions cache, inventories, stderr ring buffer, and HTTP `Mcp-Session-Id`.
- Settings → Copilot Agent → MCP Servers lets users add, edit, remove, enable, disable, reconnect, inspect status/last error, and manage redacted static Authorization headers.
- Enabled servers connect over stdio or Streamable HTTP, advertise `2025-06-18`, accept `2025-06-18` or `2024-11-05` on supported transports, reject legacy HTTP+SSE-only servers, and perform bounded `tools/list` discovery.
- MCP tools register under deterministic `mcp__<server-id>__<tool-name>` ids, reject same-server duplicates and built-in collisions, and appear in the preamble as `<tool-name> (MCP / <display-name>)` with per-server instructions truncated to 4 KB.
- Every MCP call routes through `decideSafety(...)` as `SafetySource = "mcp"` and requires approval by default. Persistent and session grants apply only to matching `(stableServerId, toolName, trustEpoch)`.
- `tools/call` results render through the existing tool-call surface; `isError` and JSON-RPC errors are distinguishable; binary content becomes placeholders; Undo is absent for MCP.
- Crashes, timeouts, stale HTTP sessions, list changes, oversized payloads, cancellation, reconnect, and unload are deterministic and locally observable without telemetry.

## What We're NOT Doing

- Acting as an MCP server.
- OAuth/PKCE or token refresh for MCP servers.
- MCP resources, prompts, sampling, elicitation, roots, or server-initiated LLM calls.
- Legacy HTTP+SSE fallback.
- Public MCP registry browsing or config auto-import.
- Per-conversation MCP allowlists.
- Telemetry, cost accounting, or remote audit logs.
- Full image/audio passthrough to the model.
- Undo journal entries for MCP calls.
- Process sandboxing/containerization beyond the v0.5 process/env/cwd/URL controls.

## Phase Status

- [ ] **Phase 1: Persistence shape + stable MCP identity** — Add additive config/grant stores, trust epoch semantics, and no-MCP persistence invariants.
- [ ] **Phase 2: SafetyPolicy gate + safe approval rendering** — Wire stable MCP identity through `decideSafety`, session grants, approval prompts, and Undo suppression before transports execute.
- [ ] **Phase 3: MCP runtime substrate + bounded discovery** — Add SDK dependency and headless stdio/Streamable HTTP runtimes with protocol, security, timeout, pagination, and size bounds.
- [ ] **Phase 4: Settings UI + plugin lifecycle orchestration** — Add the MCP Servers settings section and lifecycle actions: load, start, stop, enable/disable, remove, reconnect, unload.
- [ ] **Phase 5: Tool registry, AgentSession bridge, preamble, and result rendering** — Publish discovered tools into SDK sessions, route calls, normalize results, and update preamble.
- [ ] **Phase 6: Resilience hardening, cancellation, list_changed, and crashloop UX** — Complete reconnect/backoff, atomic refresh, stale-session, Stop/cancel, and shutdown guarantees.
- [ ] **Phase 7: Documentation** — Produce Docs.md and update README/CHANGELOG with setup, security posture, bundle delta, and verification notes.

## Phase Candidates

- [x] [skipped] OAuth / PKCE for hosted MCP servers.
- [x] [skipped] MCP resources, prompts, sampling, elicitation, roots, and progress UX.
- [x] [skipped] Legacy HTTP+SSE fallback.
- [x] [skipped] Auto-import from `.vscode\mcp.json`, Claude Desktop config, or public registries.
- [x] [skipped] Per-conversation MCP allowlists or routing policies.
- [x] [skipped] Full image/audio passthrough to Copilot models.
- [x] [skipped] Dedicated MCP invocation audit log or telemetry dashboard.
- [x] [skipped] OS sandboxing/job-object hardening beyond required process shutdown and env filtering.

## Phase Ordering Rationale

1. **Persistence first** defines stable ids and trust epochs consumed by every later phase.
2. **Safety second** ensures any future MCP execution already has a tested universal approval path.
3. **Runtime third** proves protocol, security, and discovery behavior headlessly before UI/chat coupling.
4. **Settings fourth** surfaces configuration on top of known runtime/store contracts.
5. **Tool bridge fifth** is the first end-to-end user-visible MCP tool path and depends on the first four phases.
6. **Resilience sixth** hardens cross-cutting active-call/list/reconnect behavior after the happy path exists.
7. **Documentation last** records as-built behavior rather than planned intent.

---

## Phase 1: Persistence shape + stable MCP identity

### Goals

Add additive MCP configuration and auto-approval persistence with stable server identity and trust epochs. No transports, no settings UI, and no chat behavior change.

### Changes Required

- **`src\mcp\McpTypes.ts`** (new): persisted config types, runtime status types, redaction-safe snapshots, `McpServerId`, `McpTrustEpoch`, and transport-specific config discriminants.
- **`src\mcp\McpIdentity.ts`** (new): slug/id normalization, `computeTrustEpoch(config)`, and `formatMcpApprovalKey(serverId, toolName, trustEpoch)`.
- **`src\settings\McpSettingsStore.ts`** (new): load/save `mcpServers`, default missing field to `[]`, preserve sibling keys, serialize writes, and expose mutation helpers used by later phases.
- **`src\settings\SafetySettingsStore.ts`**: evolve `mcpAutoApprove` to stable server/tool/epoch entries and add revoke helpers for server remove/repoint/rename.
- **`src\main.ts`**: instantiate the MCP settings store and expose it to later lifecycle wiring without connecting anything yet.

### Required Tests

- **`src\mcp\McpIdentity.test.ts`**: stable server id does not change on display-name edits; trust epoch changes on name, command, args, URL, or transport change; enable/status edits do not rotate epoch.
- **`src\settings\McpSettingsStore.test.ts`**: missing `mcpServers` defaults to `[]`; stdio and HTTP configs round-trip; static `Authorization` persists; `Mcp-Session-Id` and runtime fields never serialize; sibling keys survive writes.
- **`src\settings\SafetySettingsStore.test.ts`**: persistent grant lookup is exact `(serverId, toolName, trustEpoch)`; stale epoch fails closed; server removal clears only that server’s grants.

### Quality Gates

- [ ] `npm test`
- [ ] `npm run typecheck`
- [ ] `npm run build`

### Manual Verification

- [ ] **SC-012:** Save an HTTP config with `Authorization`, reload, and verify the header survives while `Mcp-Session-Id` is absent from `data.json`.
- [ ] **SC-019:** Grant one server/tool, rename/repoint/remove the server, and verify stale grants are revoked exactly once.
- [ ] **SC-005:** Start with no MCP config and confirm no MCP keys or runtime effects appear unless the user explicitly configures servers.

---

## Phase 2: SafetyPolicy gate + safe approval rendering

### Goals

Upgrade the universal gate to exact MCP identity and safe UI semantics before MCP transports can execute. MCP remains headless in this phase.

### Changes Required

- **`src\domain\SafetyPolicy.ts`**: extend `SafetyPolicyInput` with `mcpServerId`, `mcpToolName`, and `mcpTrustEpoch`; change `SafetyState.grantMcp(...)` and `isMcpGranted(...)` to exact server/tool/epoch scope; keep vault/builtin behavior unchanged.
- **`src\sdk\AgentSession.ts`**: update `buildSafetyInput(...)`, approval resolution, and approve-for-session handling so synthetic MCP tools produce `source: "mcp"` and grant the exact MCP scope.
- **`src\mcp\McpToolIdentity.ts`** (new): parse/format `mcp__<server-id>__<tool-name>` ids and expose metadata consumed by `AgentSession`.
- **`src\sdk\approvalText.ts`** or existing approval helpers: escape MCP-controlled server/tool names, descriptions, and arguments as plain text; truncate displayed args at 4 KB with a visible marker.
- **`src\ui\ToolCallBlock.ts`**: ensure MCP-source calls never show Undo, even if a caller mistakenly attaches an `undoId`.

### Required Tests

- **`src\domain\SafetyPolicy.test.ts`**: MCP requires approval by default; persistent and session grants match only exact `(serverId, toolName, trustEpoch)`; `readOnlyHint`/annotations never bypass; stale trust epoch prompts.
- **`src\sdk\AgentSession.test.ts`**: synthetic MCP ids classify to `source: "mcp"`; rejected calls are not dispatched; approve-for-session grants exact scope; existing vault/builtin approval tests remain green.
- **`src\ui\ToolCallBlock.test.ts`** and approval text tests: Markdown/HTML/control-character inputs render as escaped plain text; 4 KB truncation marker appears; MCP Undo hidden and vault Undo preserved.

### Quality Gates

- [ ] `npm test`
- [ ] `npm run typecheck`
- [ ] `npm run build`

### Manual Verification

- [ ] **SC-003:** With test fixtures, approving one MCP tool does not approve another tool on the same server.
- [ ] **SC-004:** Malicious server/tool/args strings render as plain text and truncate at 4 KB.
- [ ] **SC-019:** After trust epoch rotation, a previously approved server/tool prompts again.

---

## Phase 3: MCP runtime substrate + bounded discovery

### Goals

Add `@modelcontextprotocol/sdk@1.29.0` and implement headless MCP runtimes for stdio and Streamable HTTP. Discover inventories with explicit protocol, timeout, pagination, I/O, URL, and environment bounds, but do not expose tools to chat yet.

### Changes Required

- **`package.json` / `package-lock.json`**: add `@modelcontextprotocol/sdk@1.29.0`.
- **`src\mcp\stdioEnv.ts`** (new): full-inherit-minus-denylist env builder, explicit per-server env injection after filtering, Windows case-insensitive matching, macOS PATH prepend for `/usr/local/bin` and `/opt/homebrew/bin`.
- **`src\mcp\httpPolicy.ts`** (new): URL validation, TLS posture, metadata-host rejection, private-network confirmation classification, redirect cap and Authorization stripping on cross-origin redirect.
- **`src\mcp\redact.ts`** (new): redact `Authorization`, `Mcp-Session-Id`, and URL userinfo from diagnostics.
- **`src\mcp\McpServerRuntime.ts`** (new): one server connection, SDK client wrapper, initialize/initialized lifecycle, `2025-06-18` advertise, supported version negotiation, capabilities check, bounded `tools/list` pagination, instructions capture, timeouts, I/O caps, stderr ring buffer.
- **`src\mcp\McpManager.ts`** (new): enabled-runtime map, status snapshots, immutable inventory snapshots, and manual lifecycle methods; still not injected into `AgentSession`.
- **`src\main.ts`**: construct the manager with stores and callbacks but keep the empty/disabled path a no-op.

### Required Tests

- **`src\mcp\stdioEnv.test.ts`**: deny exact and wildcard secret env vars (`GITHUB_TOKEN`, `GH_TOKEN`, `COPILOT_*`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `AWS_*`, `GCP_*`, `*_TOKEN`, `*_API_KEY`, `*_SECRET`, `*_PASSWORD`); preserve ordinary usability vars; inject explicit env after filtering; macOS PATH order.
- **`src\mcp\httpPolicy.test.ts`**: reject non-loopback `http://`; reject metadata IPs/hosts; require confirmation for private ranges; allow normal HTTPS; drop Authorization across origins; cap redirects at 3.
- **`src\mcp\McpServerRuntime.test.ts`**: stdio spawn uses array args and `shell: false`; initialize timeout 10 s; protocol matrix accepts `2025-06-18` and `2024-11-05` over supported transports; rejects legacy HTTP+SSE-only; tools-absent server contributes zero tools.
- **`src\mcp\McpManager.test.ts`**: `tools/list` follows up to 50 pages/1000 tools, fails same-server duplicates, enforces 10 s page timeout, 16 MiB frame/body/SSE caps, 64 KiB stderr ring buffer, and never persists HTTP session id.

### Quality Gates

- [ ] `npm test`
- [ ] `npm run typecheck`
- [ ] `npm run build`

### Manual Verification

- [ ] **SC-009:** Launch a reference stdio server and verify env filtering, explicit env injection, macOS PATH amendment, and absolute command behavior.
- [ ] **SC-012:** Connect/reload an HTTP server and confirm runtime `Mcp-Session-Id` is absent from persistence and diagnostics.
- [ ] **SC-013:** Fake no-response initialize/list/call paths fail at 10 s / 10 s / configured call timeout.
- [ ] **SC-014:** Oversized stdio/HTTP/SSE/stderr fixtures fail deterministically with capped diagnostics.
- [ ] **SC-017:** URL fixtures exercise loopback/private/metadata/public/redirect behavior.
- [ ] **SC-018:** Protocol matrix accepts supported `2024-11-05` servers and rejects legacy HTTP+SSE-only wording.

---

## Phase 4: Settings UI + plugin lifecycle orchestration

### Goals

Expose MCP server management in Settings and wire manager startup, shutdown, enable/disable, remove, and reconnect behavior through the plugin lifecycle without changing chat semantics.

### Changes Required

- **`src\settings\mcpServerFormLogic.ts`** (new): pure validation/normalization for server ids, required fields, command/args/url, timeouts, headers, private-network confirmation, and redaction/reveal state.
- **`src\settings\McpServersSection.ts`** (new): DOM owner for the MCP Servers settings section: list rows, add/edit modal, remove confirmation, enable/disable, reconnect, status, last-error, tool count, and accessibility labels.
- **`src\settings\SettingsTab.ts`**: mount the MCP section and subscribe to store/manager snapshots.
- **`src\settings\McpSettingsStore.ts`**: add controller-style mutations used by the section (`addServer`, `updateServer`, `removeServer`, `setEnabled`, `recordStatus`).
- **`src\main.ts`**: load enabled configs after plugin bootstrap, connect asynchronously, stop disabled/removed servers, dispose all runtime connections on unload.

### Required Tests

- **`src\settings\mcpServerFormLogic.test.ts`**: stdio/HTTP required fields, id uniqueness, timeout bounds, Authorization redaction, URL validation result handling.
- **`src\settings\McpServersSection.test.ts`**: add/edit/remove/enable/disable/reconnect flows, private-network confirmation copy, metadata-host error, redacted last-error rendering, accessible row labels.
- **`src\main.mcpLifecycle.test.ts`**: no servers means no spawn/fetch; enabled servers start asynchronously; disabled servers do not connect; unload disposes manager once; remove stops active runtime and clears grants.

### Quality Gates

- [ ] `npm test`
- [ ] `npm run typecheck`
- [ ] `npm run build`

### Manual Verification

- [ ] **SC-001:** Add a fake stdio server, reconnect successfully, and observe row status/tool count changes.
- [ ] **SC-012:** Add HTTP Authorization, reload, verify redaction by default and explicit edit/reveal behavior.
- [ ] **SC-017:** Attempt private-network and metadata-host HTTP configs and verify confirmation/rejection behavior.
- [ ] **SC-019:** Remove/repoint a server and verify grants clear and a one-shot Notice is shown.
- [ ] **SC-005:** All-disabled servers spawn/open no transports and no tools are visible to chat.

---

## Phase 5: Tool registry, AgentSession bridge, preamble, and result rendering

### Goals

Make MCP tools available to the model and UI: publish atomic inventories into `AgentSession`, route approved calls to originating servers, render results safely, and update the preamble.

### Changes Required

- **`src\mcp\McpToolRegistry.ts`** (new): immutable aggregate snapshot, synthetic id mapping, duplicate/collision checks, built-in `mcp__` prefix guard, per-server instructions metadata.
- **`src\mcp\McpToolBridge.ts`** (new): convert MCP tools into SDK custom tools, run approval before dispatch, call `McpManager.callTool(serverId, toolName, args)`, and normalize tool-call lifecycle events.
- **`src\mcp\normalizeMcpResult.ts`** (new): text, structured content, `isError`, JSON-RPC error, resource link/resource, and image/audio/blob placeholders with decoded byte counts where possible.
- **`src\sdk\AgentSession.ts`**: accept MCP tool snapshots/lookup in runtime options, register synthetic tools alongside built-ins, classify them as MCP, and keep built-in registration unchanged.
- **`src\domain\PreambleAssembler.ts`**: add optional MCP inventory/instructions input; render `<tool-name> (MCP / <display-name>)`; truncate instructions to 4096 chars per server; keep no-MCP output byte-for-byte compatible with v0.4 tests where possible.
- **`src\domain\types.ts` / `src\ui\ToolCallBlock.ts` / `src\ui\MessageRenderer.ts`**: carry MCP attribution through rendering and suppress Undo.
- **`src\main.ts`**: inject current registry snapshot into new runtimes and define safe handoff for snapshot updates between turns.

### Required Tests

- **`src\mcp\McpToolRegistry.test.ts`**: cross-server duplicate tool names create distinct ids; same-server duplicates reject inventory; built-in collision rejects MCP and built-ins win; disabled/disconnected servers contribute zero tools.
- **`src\mcp\McpToolBridge.test.ts`**: approved synthetic id routes to correct server/tool; rejection does not call server; `isError` vs JSON-RPC error surfaces correctly; no `undoId` is emitted.
- **`src\mcp\normalizeMcpResult.test.ts`**: mixed text/structured content is readable; image/audio/blob/resource binary placeholders do not pass raw base64.
- **`src\domain\PreambleAssembler.test.ts`**: MCP rows and instructions render with attribution/truncation; absent instructions omit; no-MCP preamble unchanged.
- **`src\sdk\AgentSession.test.ts` / `src\ui\ToolCallBlock.test.ts`**: synthetic MCP tools go through approval, render source `mcp`, and never show Undo.

### Quality Gates

- [ ] `npm test`
- [ ] `npm run typecheck`
- [ ] `npm run build`

### Manual Verification

- [ ] **SC-001:** Configure a reference stdio server, see tools in preamble, approve one call, and see result without Undo.
- [ ] **SC-002:** Configure Streamable HTTP with Authorization, discover two pages, approve one call, and verify headers/session during that load.
- [ ] **SC-003:** `readOnlyHint` still prompts by default; session/persistent grant scope is exact.
- [ ] **SC-004:** Approval prompt strings are escaped and args truncate at 4 KB.
- [ ] **SC-011:** Binary result content renders placeholders and no raw base64.
- [ ] **SC-016:** Two servers exposing `read_file` register distinct synthetic ids; built-in collisions are rejected.

---

## Phase 6: Resilience hardening, cancellation, list_changed, and crashloop UX

### Goals

Complete failure-mode semantics: stdio auto-reconnect/crashloop, HTTP stale-session retry, `notifications/tools/list_changed` coalescing, Stop/cancel, late-response discard, unload shutdown, and local diagnostics.

### Changes Required

- **`src\mcp\McpReconnectPolicy.ts`** (new): retry schedule 1 s → 2 s → 4 s → 8 s → 16 s → 32 s, cap later delays at 60 s, five failed attempts in five minutes → `crashloop`, manual Reconnect reset.
- **`src\mcp\McpNotificationQueue.ts`** (new): coalesce `tools/list_changed` per server, defer refresh until in-flight calls settle, and apply registry swap atomically.
- **`src\mcp\McpManager.ts`**: integrate reconnect policy, stale HTTP 404 handling, volatile session-id clearing, bounded HTTP DELETE on shutdown, refresh rollback on failure, in-flight rejection on disable/remove/reconnect.
- **`src\mcp\McpToolBridge.ts`**: propagate Stop/cancellation with `notifications/cancelled` when possible, settle UI state, and discard late responses.
- **`src\main.ts` / `src\sdk\AgentSession.ts`**: ensure dispose/reconnect/cancel ordering cannot leave pending approvals or hanging promises.
- **`src\settings\McpServersSection.ts`**: show reconnecting/crashloop/last-error/stderr diagnostics with non-color-only status and redaction.

### Required Tests

- **`src\mcp\McpReconnectPolicy.test.ts`**: schedule, cap, reset on successful initialize, crashloop threshold, manual reconnect reset, cancellation on disable/remove/unload.
- **`src\mcp\McpNotificationQueue.test.ts`**: three notifications during one in-flight call produce exactly one post-call refresh and no partial registry state.
- **`src\mcp\McpManager.resilience.test.ts`**: stdio exit mid-call, HTTP drop mid-call, stale-session 404, refresh failure preserves previous inventory, built-in tools remain usable.
- **`src\mcp\McpToolBridge.test.ts` / `src\sdk\AgentSession.test.ts`**: Stop sends cancellation when request id support exists, cancelled state is terminal, late responses ignored.
- **`src\main.mcpLifecycle.test.ts`**: unload sequence closes stdin → waits 5 s → SIGTERM → waits 5 s → SIGKILL; idempotent and no tracked child orphaned.

### Quality Gates

- [ ] `npm test`
- [ ] `npm run typecheck`
- [ ] `npm run build`

### Manual Verification

- [ ] **SC-006:** Kill stdio mid-call; call errors, built-in tools still work, first reconnect starts after 1 s.
- [ ] **SC-007:** Drop HTTP mid-call; no background auto-reconnect loop; next MCP call reinitializes.
- [ ] **SC-008:** Three `list_changed` notifications during an in-flight call result in one atomic post-call registry swap.
- [ ] **SC-010:** Unload with stubborn stdio child; verify stdin close → 5 s → SIGTERM → 5 s → SIGKILL.
- [ ] **SC-013:** Timeouts remain deterministic after cancellation/reconnect logic lands.
- [ ] **SC-015:** Five stdio failures inside five minutes enter `crashloop`; manual Reconnect resets and later success works.

---

## Phase 7: Documentation

### Goals

Record the as-built v0.5 architecture, user setup steps, security posture, bundle impact, and verification procedure.

### Changes Required

- **`.paw\work\mcp-client\Docs.md`**: technical reference covering stores, manager/runtime, transport/security bounds, approval scope, registry, preamble, result normalization, resilience, and traceability.
- **`README.md`**: user-facing MCP server setup for stdio and Streamable HTTP, Windows `cmd /c npx` guidance, static Authorization, private-network warning, no legacy SSE fallback, no Undo for MCP calls.
- **`CHANGELOG.md`**: v0.5 Added/Changed/Security/Migration notes, SDK version, protocol versions, bundle delta or waiver, and final test count.

### Required Tests

- No dedicated docs build is currently identified; rerun standard gates and validate examples against implemented code.

### Quality Gates

- [ ] `npm test`
- [ ] `npm run typecheck`
- [ ] `npm run build`

### Manual Verification

- [ ] **SC-001 / SC-002:** README setup reproduces one stdio and one Streamable HTTP server.
- [ ] **SC-005:** Docs state empty/all-disabled MCP preserves v0.4 behavior.
- [ ] **SC-017 / SC-018:** Docs state URL/TLS posture and legacy HTTP+SSE rejection.
- [ ] **NFR-005:** CHANGELOG records measured gzip bundle delta or mitigation/waiver.

---

## Requirements Traceability Matrix

### Functional Requirements

| Requirement | Phase(s) | Primary tests |
|---|---:|---|
| FR-001 Server config persistence | 1, 4 | `McpSettingsStore.test.ts`, `main.mcpLifecycle.test.ts` |
| FR-002 Server config lifecycle UI | 4 | `McpServersSection.test.ts`, `mcpServerFormLogic.test.ts` |
| FR-003 Static HTTP Authorization | 1, 4 | `McpSettingsStore.test.ts`, `McpServersSection.test.ts` |
| FR-004 Stdio transport | 3, 6 | `McpServerRuntime.test.ts`, `stdioEnv.test.ts`, lifecycle tests |
| FR-005 Streamable HTTP transport | 3 | `McpServerRuntime.test.ts`, `httpPolicy.test.ts` |
| FR-006 Protocol version negotiation | 3 | `McpServerRuntime.test.ts` protocol matrix |
| FR-007 Capabilities negotiation | 3 | `McpServerRuntime.test.ts` |
| FR-008 Full `tools/list` pagination | 3 | `McpManager.test.ts`, `McpServerRuntime.test.ts` |
| FR-009 SDK tool registration | 5 | `McpToolRegistry.test.ts`, `AgentSession.test.ts` |
| FR-010 Preamble inventory/instructions | 5 | `PreambleAssembler.test.ts` |
| FR-011 Universal permission gate routing | 2, 5 | `SafetyPolicy.test.ts`, `AgentSession.test.ts` |
| FR-012 MCP auto-approval allowlist | 1, 2, 4 | `SafetySettingsStore.test.ts`, `SafetyPolicy.test.ts`, settings tests |
| FR-013 MCP calls not undoable | 2, 5 | `ToolCallBlock.test.ts`, `McpToolBridge.test.ts` |
| FR-014 Tool-call execution/rendering | 5 | `McpToolBridge.test.ts`, `normalizeMcpResult.test.ts` |
| FR-015 Binary placeholders | 5 | `normalizeMcpResult.test.ts` |
| FR-016 Crash/disconnect resilience | 6 | `McpManager.resilience.test.ts` |
| FR-017 Manual reconnect | 4, 6 | `McpServersSection.test.ts`, `McpReconnectPolicy.test.ts` |
| FR-018 Stdio auto-reconnect | 6 | `McpReconnectPolicy.test.ts` |
| FR-019 HTTP session id lifecycle | 3, 6 | `McpManager.test.ts`, redaction/session tests |
| FR-020 `list_changed` coalescing | 6 | `McpNotificationQueue.test.ts` |
| FR-021 Cancellation and Stop | 6 | `McpToolBridge.test.ts`, `AgentSession.test.ts` |
| FR-022 Stdio env filtering | 3 | `stdioEnv.test.ts` |
| FR-023 macOS PATH amendment | 3 | `stdioEnv.test.ts` |
| FR-024 Stdio shutdown sequence | 3, 6 | `McpManager.test.ts`, `main.mcpLifecycle.test.ts` |
| FR-025 HTTP URL/TLS posture | 3, 4 | `httpPolicy.test.ts`, `mcpServerFormLogic.test.ts` |
| FR-026 MCP-disabled baseline | 1, 3, 4, 5, 6 | full `npm test`, `main.mcpLifecycle.test.ts` |
| FR-027 Request timeout policy | 3, 6 | `McpServerRuntime.test.ts`, `McpManager.resilience.test.ts` |
| FR-028 Bounded I/O/diagnostics | 3 | `McpServerRuntime.test.ts`, `McpManager.test.ts` |
| FR-029 `2024-11-05` compatibility / SSE rejection | 3 | protocol/transport matrix tests |
| FR-030 Approval prompt safe rendering | 2, 5 | approval text tests, `ToolCallBlock.test.ts` |

### Non-Functional Requirements

| Requirement | Phase(s) | Primary tests/checks |
|---|---:|---|
| NFR-001 Performance/bounded latency | 3, 6 | timeout tests, async discovery tests, manual responsiveness smoke |
| NFR-002 Resilience/bounded resources | 3, 6 | payload, crash, reconnect, stale-session tests |
| NFR-003 Security | 1, 2, 3, 4, 5 | identity, safety, env, URL, redaction, approval tests |
| NFR-004 Compatibility | 3 | protocol matrix |
| NFR-005 Bundle size | 3, 7 | `npm run build`, measured gzip delta documented |
| NFR-006 Accessibility | 4, 5 | settings/approval UI tests and manual keyboard smoke |
| NFR-007 Baseline preservation | all | full `npm test`, no-MCP lifecycle smoke |
| NFR-008 Local observability/no telemetry | 3, 4, 6 | status/last-error/stderr/redaction tests |

### Success Criteria

| SC | Phase(s) | Verification |
|---|---:|---|
| SC-001 stdio happy path + preamble + no Undo | 4, 5 | settings, registry, preamble, bridge tests; manual stdio smoke |
| SC-002 HTTP auth + pagination + headers/session | 3, 4, 5 | HTTP runtime, settings, bridge tests; manual HTTP smoke |
| SC-003 approval by default / exact grants | 2, 5 | `SafetyPolicy.test.ts`, `AgentSession.test.ts` |
| SC-004 safe prompt rendering/truncation | 2, 5 | approval text and `ToolCallBlock` tests |
| SC-005 no-MCP v0.4 baseline | all | full suite, no-MCP lifecycle smoke |
| SC-006 stdio exit mid-call + reconnect | 6 | resilience tests, manual crash smoke |
| SC-007 HTTP disconnect + next-call reconnect | 6 | resilience tests, manual HTTP drop smoke |
| SC-008 list_changed coalescing/atomic swap | 6 | `McpNotificationQueue.test.ts` |
| SC-009 env/PATH/absolute commands | 3 | `stdioEnv.test.ts` |
| SC-010 unload shutdown sequence | 6 | lifecycle fake-process tests |
| SC-011 binary placeholders | 5 | `normalizeMcpResult.test.ts` |
| SC-012 config/auth persist, session id volatile | 1, 3, 4 | store, session, redaction tests |
| SC-013 deterministic timeouts | 3, 6 | fake-timer timeout tests |
| SC-014 oversized payload/stderr caps | 3 | bounded I/O tests |
| SC-015 stdio crashloop/manual reset | 6 | `McpReconnectPolicy.test.ts` |
| SC-016 duplicate names/collisions | 5 | `McpToolRegistry.test.ts` |
| SC-017 URL/redirect posture | 3, 4 | `httpPolicy.test.ts`, form logic tests |
| SC-018 `2024-11-05` compatibility / SSE rejection | 3 | protocol matrix |
| SC-019 grant revocation on mutation/remove | 1, 2, 4 | store/safety/settings tests |

## Baseline Regression Matrix

| v0.4 behavior | Phase(s) most likely to disturb | Protection |
|---|---:|---|
| Streaming and Stop finalization | 5, 6 | `AgentSession.test.ts`, `ChatView` stream/Stop coverage, manual SC-006/SC-007 |
| Pending approval flow | 2, 5, 6 | `SafetyPolicy.test.ts`, `AgentSession.test.ts` |
| Undo journal and Undo button | 2, 5 | `ToolCallBlock.test.ts`, Undo regression tests |
| Token rotation / live runtimes | 4, 5, 6 | `main` lifecycle tests and full suite |
| Raw-FS and vault-tool gating | 2, 5 | existing safety/tool-gating tests |
| Vault-aware preamble | 5 | `PreambleAssembler.test.ts` no-MCP snapshot |
| Model picker / deferred init / send gate | 4, 5, 6 | existing model picker and ChatView tests |
| Persistence sibling preservation | 1, 4 | store/persistence tests |

## References

- Spec: `C:\Repos\obsidian-copilot-agent\.paw\work\mcp-client\Spec.md`
- Research: `C:\Repos\obsidian-copilot-agent\.paw\work\mcp-client\SpecResearch.md`
- Workflow context: `C:\Repos\obsidian-copilot-agent\.paw\work\mcp-client\WorkflowContext.md`
- Per-model drafts: `C:\Repos\obsidian-copilot-agent\.paw\work\mcp-client\plans\PLAN-gpt-5.4.md`, `PLAN-gemini-3.1-pro-preview.md`, `PLAN-claude-opus-4.7.md`
- Style reference: `C:\Repos\obsidian-copilot-agent\.paw\work\model-picker\ImplementationPlan.md`
- Verified anchors: `src\domain\SafetyPolicy.ts`, `src\sdk\AgentSession.ts`, `src\ui\ToolCallBlock.ts`, `src\domain\PreambleAssembler.ts`, `src\settings\SafetySettingsStore.ts`, `src\settings\SettingsTab.ts`, `src\main.ts`
