# v0.5 MCP Client Integration — Implementation Plan

## Overview

This plan delivers v0.5 of `obsidian-copilot-agent`: outbound MCP (Model Context
Protocol) client support that lets a user configure stdio and Streamable HTTP MCP
servers, surfaces their tools to the SDK alongside built-in vault tools, and
routes every MCP tool call through the existing universal approval gate.

The plan is purely additive on top of v0.4. The plugin must continue to behave
exactly like v0.4 when zero MCP servers are configured, including loading
`data.json` written by v0.4, passing the existing 724/724 test baseline, and
keeping the bundle within the size budget (NFR-005).

SDK target: **`@modelcontextprotocol/sdk@^1.29.0`** (latest stable 1.x at
the time of planning, per `SpecResearch.md` §1). Protocol version negotiated:
`2025-06-18` with documented fallback to `2024-11-05` (FR-029).

### Phase shippability invariant

Each phase below ships a working plugin with `npm test`, `npm run typecheck`,
and `npm run build` all green. After every phase the plugin behaves like v0.4
in the no-MCP-configured case (FR-026): no new network or process activity, no
new persisted keys written if none were configured, no UI noise. We can pause
between any two phases and ship.

## Current State Analysis (v0.4 anchors)

The integration depends on these v0.4 anchors verified in the source tree.

- `src/domain/SafetyPolicy.ts`
  - `SafetySource = "vault" | "extra-vault" | "mcp" | "builtin"` already
    enumerates `"mcp"`.
  - `SafetyState.grantMcp(serverName: string)` exists but is keyed by server
    name only (line ~74); v0.5 must extend it to a `(stableServerId, toolName)`
    pair plus a trust epoch.
  - Top-level `decideSafety(input, config, state, opts)` is the universal gate
    (line ~146); the `kind === "mcp"` branch (≈199–220) consults
    `mcpAutoApprove`, currently `Record<string, boolean>`.
- `src/sdk/AgentSession.ts`
  - `buildSafetyInput()` (≈line 1610) already maps tool stream events whose
    `mcpServerName` is set into `{ kind: "mcp", source: "mcp", toolName }`.
  - The approval prompt summary/detail builders (`buildApprovalSummary`,
    `buildApprovalDetail`, ≈line 1527) are the rendering anchor for FR-030.
  - Tool stream classification at ≈682–756 already produces an MCP source for
    SDK-emitted MCP tool calls; v0.5 only needs to register the tools.
- `src/persistence/PersistedShape.ts` — `CURRENT_SCHEMA_VERSION = 2`; the file
  enforces sibling-key preservation. `mcpServers` and `mcpAutoApprove` shape
  changes are additive; no schema bump is required.
- `src/settings/SafetySettingsStore.ts` — tail-promise serialized writes with
  sibling preservation; `McpServersStore` will mirror this exactly.
- `src/main.ts` (≈285–415) — runtime factory wires `safety: { config, state,
  extractVaultPath }` into every `CopilotAgentSession`. The MCP registry,
  dispatcher, and `mcpServerName → server config` resolver are injected here.
- `src/domain/ConversationRuntime.ts` — per-conversation lazy session;
  `setModelId`/`dispose` already exist and are how we will plumb MCP teardown.
- `src/ui/ToolCallBlock.ts` — `shouldRenderUndoButton()` (≈line 45) is the
  single anchor for FR-013 (suppress Undo for `source === "mcp"`).
- `src/domain/PreambleAssembler.ts` — `MAX_DEFAULT_PREAMBLE_BYTES = 8 * 1024`;
  v0.5 will append MCP tool inventory and per-server instructions inside this
  same 8 KB cap (FR-010).
- `src/settings/SettingsTab.ts` — host for the new "MCP Servers" section;
  re-renders on `display()` and already subscribes to controllers.
- `package.json` — currently only depends on `@github/copilot-sdk@1.0.0`;
  Phase 3 adds `@modelcontextprotocol/sdk@^1.29.0`.

## Desired End State & Verification Approach

End state:

- Users can add stdio and Streamable HTTP MCP servers from Settings.
- Connected servers' tools appear in the SDK's tool registry under stable
  `mcp__<stableServerId>__<toolName>` ids; the model can call them.
- Every MCP tool call goes through `decideSafety()`. Auto-approve is
  per-(server, tool) and revoked on identity-defining changes (FR-012).
- Stdio uses newline-delimited JSON-RPC; Streamable HTTP uses POST JSON or
  SSE streams with an opaque `Mcp-Session-Id` header that is never persisted.
- Reconnect, crashloop backoff, redaction, and tool-call stream cancellation
  match the spec.
- Bundle size grows by ≤80 KB gzip (NFR-005) and v0.4 behavior is unchanged
  when no MCP servers are configured (FR-026, NFR-007).

Verification approach:

- **Automated (Vitest):** new unit tests live alongside existing files; new
  integration tests exercise the SDK tool-call path against an in-process
  fake stdio child harness and an HTTP mock. We use the same patterns as
  `AgentSession.test.ts`, `SafetyPolicy.test.ts`, and persistence stores.
- **Manual:** each phase has an SC-tied checklist run against a real
  `mcp-server-everything` (stdio) and a public Streamable HTTP demo server.

## What We're NOT Doing (v0.5)

Copied verbatim from `Spec.md` §"Out of Scope":

- Acting as an MCP **server** (inbound). v0.5 is client-only.
- OAuth or any non-static-bearer HTTP auth.
- Resources, prompts, sampling, roots, elicitation, image/audio tool
  results, or `notifications/progress`.
- Per-conversation tool allowlists; allowlist is per-server enable/disable.
- Telemetry, observability dashboards, or logs persisted to disk.
- Sandboxing of stdio children (we use OS process isolation only; FR-027
  caveat documented in user-facing copy).
- A registry/marketplace UI; servers are added by command/url.

## Phase Status

- [ ] Phase 1 — Persistence shape (`mcpServers`, per-tool auto-approve, trust epoch)
- [ ] Phase 2 — Universal approval gate extension + Undo suppression (gate first, no transports yet)
- [ ] Phase 3 — Stdio transport + fake-process harness
- [ ] Phase 4 — Streamable HTTP transport + URL/TLS posture + session-id discipline
- [ ] Phase 5 — Tool discovery, SDK registration, preamble, execution
- [ ] Phase 6 — Settings UI, reconnect, auto-reconnect/crashloop UX
- [ ] Phase 7 — Resilience hardening, 2024-11-05 compat, bundle check, no-MCP smoke
- [ ] Phase 8 — Documentation

## Phase Candidates (deferred)

These are out of v0.5 but explicitly listed so they aren't lost:

- OAuth / dynamic credentials for HTTP MCP servers.
- Acting as an MCP server (inbound).
- A registry browser / "install from catalog" UX.
- Resources, prompts, sampling, roots, elicitation, image/audio result
  passthrough, `notifications/progress`.
- Per-conversation tool allowlists (we ship per-server enable only).
- Process sandboxing (seatbelt / firejail / job objects) for stdio children.
- Telemetry / metrics export.
- Multi-instance (multiple stdio processes per server config) and pooled HTTP
  connections.

## Phase Ordering Rationale

We deliberately wire the **safety gate before any transport** (Phase 2). This
guarantees that when transports land in Phases 3–4 there is no window in which
a tool can execute without going through `decideSafety()`. The persistence
shape lands first (Phase 1) so the gate has stable keys to read in Phase 2.
Phase 5 (tool discovery + SDK registration + preamble + execution) is the
first phase where the user-visible MCP feature works end-to-end, but it
relies on Phases 3–4 having shipped the connectivity. UI (Phase 6) follows
the engine; resilience hardening and the v0.4 regression sweep (Phase 7) sit
between feature-complete and documentation; Phase 8 ships the docs and
CHANGELOG.

---

## Phase 1 — Persistence shape

### Goals

- Introduce additive top-level keys `mcpServers` (list) and extend
  `mcpAutoApprove` to a per-(server, tool) shape, without bumping
  `CURRENT_SCHEMA_VERSION` (the existing sibling-preservation discipline
  handles forward/backward compat).
- Define `McpServerConfig` and `McpServerConfig.trustEpoch` (FR-012).
- Provide `McpServersStore` and `McpAutoApproveStore` mirroring
  `SafetySettingsStore`'s tail-promise serialized-write pattern.
- Migrate any v0.4 `mcpAutoApprove: Record<string, boolean>` (server-keyed)
  to the new shape on load by treating each entry as the server-wide grant
  being absent and dropping it (per FR-012, identity-defining change rotates
  epoch and revokes; v0.4 had no concept of stable server id, so the
  conservative path is to drop the legacy entries).

### Files to add/edit

- Add `src/domain/McpServerConfig.ts` — types: `McpStdioConfig`,
  `McpHttpConfig`, `McpServerConfig` (discriminated by `transport`),
  `stableServerId(config): string`, `computeTrustEpoch(config): string`.
- Add `src/persistence/mcp/McpPersistedShape.ts` — `mcpServers: McpServerConfig[]`,
  `mcpAutoApprove: Record<string, Record<string, { granted: true; trustEpoch: string }>>`.
- Edit `src/persistence/PersistedShape.ts` — add the two top-level fields
  next to `safety` / `auth`, both optional, both default to empty.
- Add `src/settings/McpServersStore.ts` — load/save/list/upsert/remove with
  tail-promise discipline; emits change events.
- Add `src/settings/McpAutoApproveStore.ts` — `grant(serverId, toolName,
  trustEpoch)`, `revokeAllForServer(serverId)`, `lookup(serverId, toolName,
  trustEpoch)` (returns false if epoch mismatches; this is how FR-012 grant
  revocation works).
- Edit `src/domain/SafetyPolicy.ts` — bridge: `mcpAutoApprove` accessor on
  `SafetyConfig` keeps backward-compatible signature but is now backed by the
  new shape via an adapter; `SafetyState.grantMcp(serverId, toolName,
  trustEpoch)`.

### Implementation notes

- `stableServerId` is generated once on add and stored in the config; it
  does NOT depend on command/args/url/name — those rotate `trustEpoch`
  instead. This is exactly the model spec FR-012 requires.
- `computeTrustEpoch` hashes the identity-defining fields (transport,
  command, args, url, name); any change yields a new epoch and any existing
  per-tool grants for that server become stale and require fresh approval.
- Sibling preservation is mandatory; reuse the `mergePersistedSnapshot`
  helper used by the existing safety store (or a parallel helper), do not
  rewrite the whole `data.json`.

### Required tests

- `McpServerConfig.test.ts` — `stableServerId` is stable across restarts,
  `computeTrustEpoch` changes iff identity-defining fields change.
- `McpServersStore.test.ts` — concurrent upserts serialize, sibling top-level
  keys (`auth`, `safety`) are preserved.
- `McpAutoApproveStore.test.ts` — grant/lookup/epoch-mismatch returns false
  (revocation), cross-server isolation.
- `PersistedShape.test.ts` — round-trips a v0.4 `data.json` with no MCP
  fields without writing the new keys; round-trips a v0.5 `data.json` with
  populated keys.
- Update `SafetyPolicy.test.ts` — keep the existing
  `state.grantMcp("trusted-server")` tests passing via the
  backward-compatible adapter (server-only grants treat `toolName` as
  wildcard for legacy callers in tests; production code paths always pass
  `toolName`).

### Quality gates

- `npm test`
- `npm run typecheck`
- `npm run build`

### Manual verification checklist

- [ ] SC-019: launch v0.5 with a v0.4 `data.json` containing no MCP keys; no
      new keys appear in `data.json` after first run.
- [ ] SC-019 (cont.): write a fake `mcpAutoApprove` legacy entry, launch
      v0.5, confirm legacy entry is dropped (no auto-approval) and a fresh
      approval is required.

### Risks & mitigations

- **Risk:** an additive top-level key conflicts with a future schema change.
  **Mitigation:** centralize the read/write through `McpServersStore` and
  document the contract in `PersistedShape.ts`.
- **Risk:** legacy `mcpAutoApprove` data confuses users.
  **Mitigation:** drop on load (FR-012 spirit), surface a one-time notice
  in Phase 6 settings (deferred copy work, no migration code).

---

## Phase 2 — Universal approval gate extension + Undo suppression

### Goals

- Extend `SafetyState.grantMcp` and the `decideSafety` MCP branch to operate
  on `(stableServerId, toolName, trustEpoch)`.
- Update `AgentSession.buildSafetyInput()` to thread `(serverId, toolName)`
  into the gate.
- Suppress the Undo button for `source === "mcp"` in `ToolCallBlock`
  (FR-013).
- Approval prompt rendering does NOT markdown-render MCP-supplied strings
  (FR-030); add an explicit `escapeForApprovalText` step in the summary and
  detail builders.

### Files to add/edit

- Edit `src/domain/SafetyPolicy.ts` — MCP branch consults
  `mcpAutoApproveStore.lookup(serverId, toolName, trustEpoch)`; `SafetyState`
  exposes `grantMcp(serverId, toolName, trustEpoch)` and a back-compat
  helper for tests.
- Edit `src/sdk/AgentSession.ts` — `buildSafetyInput()` populates `serverId`
  and `toolName`; approval summary/detail run inputs through
  `escapeForApprovalText`.
- Add `src/sdk/escapeForApprovalText.ts` — strips/escapes characters that
  would Markdown-render in Obsidian (backticks, square brackets, HTML, link
  forms). Pure function with comprehensive tests.
- Edit `src/ui/ToolCallBlock.ts` — `shouldRenderUndoButton()` returns false
  when `source === "mcp"`.
- Edit `src/main.ts` — pass `mcpAutoApproveStore` (Phase 1) into the
  `SafetyConfig` factory used by `decideSafety()` callers.

### Implementation notes

- Phase 2 ships **with no transports yet**: `SafetyState.grantMcp` is reachable
  only through tests in this phase. The point is to land the contract so
  Phase 3+ code can never accidentally bypass it.
- `escapeForApprovalText` must round-trip the original text into a code-style
  region in approval UI; we do not "render" any MCP-supplied string.

### Required tests

- `SafetyPolicy.test.ts` — gate paths for: never-granted, granted with
  matching epoch (auto-approve), granted with stale epoch (must re-prompt),
  cross-server bleed-through (denied).
- `escapeForApprovalText.test.ts` — backticks, brackets, autolinks, HTML
  tags, embedded backslashes, unicode controls.
- `ToolCallBlock.test.ts` — Undo hidden for MCP source; visible for vault.
- `AgentSession.test.ts` — `buildSafetyInput()` sets `serverId`/`toolName`
  for an MCP-classified tool stream event.

### Quality gates

- `npm test`
- `npm run typecheck`
- `npm run build`

### Manual verification checklist

- (No user-visible behavior yet; gate is wired but no transport exists.)
- [ ] SC-013: code review confirms every MCP code path invokes
      `decideSafety()` (grep `kind === "mcp"`).
- [ ] SC-014: code review confirms Undo is suppressed for MCP source.
- [ ] SC-018: handcraft a fake MCP tool stream event in a unit test with
      adversarial Markdown in name/args; approval surface renders it as
      escaped text.

### Risks & mitigations

- **Risk:** test fixtures relying on `state.grantMcp("server")` break.
  **Mitigation:** keep a back-compat overload that maps server-only grants
  to a wildcard tool entry in tests only; production callers must use the
  `(serverId, toolName, trustEpoch)` form.

---

## Phase 3 — Stdio transport + fake-process harness

### Goals

- Add `@modelcontextprotocol/sdk@^1.29.0` to dependencies.
- Implement `McpStdioClient` using the SDK's stdio transport against a real
  `child_process.spawn` adapter.
- Provide a Vitest fake-process harness so all stdio behavior can be tested
  without a real binary.
- Enforce process-spawn discipline: explicit `cwd`, denylisted env vars
  (`PATH`, `LD_PRELOAD`, `LD_LIBRARY_PATH`, `DYLD_*`, `NODE_OPTIONS`,
  `npm_*`), no shell, frame size cap (FR-028).

### Files to add/edit

- `package.json`, `package-lock.json` — add `@modelcontextprotocol/sdk@^1.29.0`.
- Add `src/mcp/transport/McpStdioClient.ts`.
- Add `src/mcp/transport/StdioProcessAdapter.ts` — wraps `child_process.spawn`,
  enforces env scrubbing, exit code observation, kill-on-dispose, max
  message frame size, newline-delimited JSON-RPC framing (NOT
  Content-Length).
- Add `src/mcp/transport/__tests__/FakeStdioProcess.ts` — in-memory
  bidirectional stream pair the tests can drive.
- Edit `src/main.ts` — register the stdio client factory in the runtime.

### Implementation notes

- **Critical framing detail:** stdio MCP is newline-delimited JSON-RPC, NOT
  the LSP `Content-Length` framing. The SDK's `StdioClientTransport` already
  handles this; our adapter just provides `Readable`/`Writable` streams.
- Spawn arguments come from `McpStdioConfig.command` and `args` (array form,
  never a single shell string); we never invoke `/bin/sh -c`.
- Env: start from a clean object; copy through only an explicit allowlist
  passed by the user as `env: Record<string, string>` from settings; deny
  the FR-027 list regardless of what the user provides.
- Lifecycle: `dispose` sends `process.kill('SIGTERM')`, then `SIGKILL` after
  a 2 s grace period. The kill path must be safe to call multiple times.

### Required tests

- `McpStdioClient.test.ts` — initialize → list_tools → call_tool happy
  path against `FakeStdioProcess`.
- `StdioProcessAdapter.test.ts` — env denylist enforced (FR-027), explicit
  `cwd` enforced, max frame size enforced (FR-028), graceful + force kill.
- `McpStdioClient.disconnect.test.ts` — pending `tools/call` is rejected
  with a cancellation error on disconnect (FR-024).

### Quality gates

- `npm test`
- `npm run typecheck`
- `npm run build` (verify gzip bundle delta vs v0.4 baseline; track for
  Phase 7 NFR-005 budget check).

### Manual verification checklist

- [ ] SC-001: configure a real `mcp-server-everything` stdio server; the
      plugin spawns the child with the env scrubbed (verify with `ps auxe`
      / Process Explorer that `LD_PRELOAD` etc. are not present).
- [ ] SC-022: kill the child manually (`kill -9`); the plugin observes
      EOF and surfaces a disconnect.

### Risks & mitigations

- **Risk:** Obsidian's Electron renderer cannot spawn children directly on
  some platforms.
  **Mitigation:** SpecResearch §2a confirms `child_process.spawn` is
  available; if a target platform fails, fall back to the SDK's stdio
  example. We do not ship a worker-thread variant in v0.5.

---

## Phase 4 — Streamable HTTP transport + URL/TLS + session-id discipline

### Goals

- Implement `McpHttpClient` using the SDK's `StreamableHTTPClientTransport`.
- Enforce URL/TLS posture (FR-025): only `http://localhost`, `http://127.0.0.1`,
  `http://[::1]`, or `https://` with a valid TLS chain. No mixed-scheme
  redirects. No SSRF to private network ranges from a loopback config (the
  scheme/host check happens before each request).
- Treat `Mcp-Session-Id` as in-memory only: it is never written to
  `data.json`, error logs, or notice surfaces (FR-019). A redaction helper
  ensures this.
- Static bearer auth via `Authorization: Bearer <token>` from the user's
  config; tokens are stored in `data.json` under `mcpServers[].auth.bearer`
  but redacted from any error/diagnostic surface.

### Files to add/edit

- Add `src/mcp/transport/McpHttpClient.ts`.
- Add `src/mcp/transport/HttpUrlGuard.ts` — pure function that accepts a
  config and returns a normalized URL or rejects with a typed reason
  (`scheme-disallowed`, `redirect-cross-scheme`, `tls-required`).
- Add `src/mcp/redact.ts` — redacts `Mcp-Session-Id`, `Authorization`, and
  any URL with embedded userinfo from a string or `Error.message`.
- Edit `src/sdk/AgentSession.ts` (only error surface paths) — wrap
  diagnostic output through `redact` for MCP-originated errors.

### Implementation notes

- The SDK transport handles SSE streams; we layer the URL/TLS guard around
  every outgoing request and around any redirect callback the SDK exposes.
  If the SDK does not expose a redirect hook, we use `fetch` with
  `redirect: 'manual'` and re-validate.
- Session-id discipline: store the header in a private field on the client
  instance; expose nothing publicly. `client.dispose()` clears it.
- Bundle-size: HTTP client adds the bulk of the SDK gzip cost; we measure
  here to flag for Phase 7's budget enforcement.

### Required tests

- `McpHttpClient.test.ts` — initialize → list_tools → call_tool against an
  HTTP mock.
- `HttpUrlGuard.test.ts` — accepts loopback `http`, accepts `https`,
  rejects `http://example.com`, rejects redirects that cross schemes,
  rejects redirects to private RFC1918 from a public host.
- `redact.test.ts` — round-trips representative error messages with session
  ids, bearer tokens, and userinfo URLs to confirm redaction.
- `McpHttpClient.session.test.ts` — session id is never returned through
  any public method; reads of `data.json` in tests confirm absence.

### Quality gates

- `npm test`
- `npm run typecheck`
- `npm run build` (record gzip delta).

### Manual verification checklist

- [ ] SC-002: configure a Streamable HTTP MCP server; tools list returns.
- [ ] SC-002 (cont.): try to configure `http://example.com` — UI rejects.
- [ ] SC-018: trigger an HTTP error containing the session id; verify the
      Notice and any error surfaces redact it.

### Risks & mitigations

- **Risk:** SDK transport opens a long-lived SSE that prevents `dispose`
  from completing.
  **Mitigation:** wrap the SDK client in our own AbortController; dispose
  aborts and waits up to 1 s before resolving anyway.

---

## Phase 5 — Tool discovery, SDK registration, preamble, execution

### Goals

- After connect, call `tools/list` and register each tool with the SDK
  under `mcp__<stableServerId>__<toolName>` (FR-007, FR-008, FR-009).
- Reject built-in tools that try to use the `mcp__` prefix (registry-time
  guard).
- Append per-server tool inventory and server-supplied instructions
  (capped at 4 KB per server) to the preamble within the existing 8 KB cap
  (FR-010).
- Wire tool-call execution: SDK calls our handler → we map tool id back
  to `(serverId, toolName)`, send `tools/call`, stream results, route
  through the universal approval gate (FR-014), surface progress and
  cancellation (FR-015).
- ToolCallBlock renders MCP origin and (when present) server-defined
  `dangerLevel`/`destructive` hints next to the approval prompt
  (FR-020, FR-021).

### Files to add/edit

- Add `src/mcp/McpRegistry.ts` — owns the live set of `McpClient`
  instances keyed by `stableServerId`, knows which are connected, exposes
  `listTools()` aggregated, and a `dispatch(toolId, args)` entry point.
- Add `src/mcp/McpToolDispatcher.ts` — pure mapping
  `toolId → (serverId, toolName)` and the dispatch implementation.
- Edit `src/sdk/AgentSession.ts` — register MCP tools on session creation;
  enforce `mcp__` prefix guard for built-ins.
- Edit `src/domain/PreambleAssembler.ts` — append MCP tool inventory and
  per-server instructions inside the existing 8 KB cap; truncation policy
  is "drop-from-end with explicit notice" so v0.4 vault tools always make
  it in.
- Edit `src/ui/ToolCallBlock.ts` — render MCP origin chip and danger hints.

### Implementation notes

- `mcp__` prefix is reserved (FR-009); add a runtime assertion in the
  built-in tool registry that throws on plugin load if any built-in tool's
  id matches `^mcp__`. This is a build-time invariant we want to fail loud.
- Cancellation: SDK exposes `AbortSignal`; we forward it to the MCP
  transport which sends a JSON-RPC cancel notification (FR-015).
- Approval flow: `decideSafety()` runs before `tools/call`. On
  "remember for this session", call `state.grantMcp(serverId, toolName,
  trustEpoch)`; on "remember always", call
  `mcpAutoApproveStore.grant(serverId, toolName, trustEpoch)`.
- Result rendering: text → escaped block; structured JSON → fenced JSON
  block; image/audio → "unsupported in v0.5" placeholder (out of scope).

### Required tests

- `McpRegistry.test.ts` — register/connect/disconnect, aggregated
  `listTools` excludes disabled servers.
- `McpToolDispatcher.test.ts` — round-trip mapping; collisions across
  servers disambiguate by `stableServerId`.
- `PreambleAssembler.test.ts` — MCP inventory fits within 8 KB, vault
  tools are never dropped, per-server cap of 4 KB is enforced.
- `AgentSession.test.ts` (extension) — model-emitted `mcp__a__b` call
  routes through `decideSafety()`, gets approved, executes, returns;
  cancellation propagates a JSON-RPC cancel.
- `BuiltinPrefixGuard.test.ts` — built-in registry asserts no `mcp__*`
  tool id.

### Quality gates

- `npm test`
- `npm run typecheck`
- `npm run build`

### Manual verification checklist

- [ ] SC-003: connect to `mcp-server-everything`; tools appear in the
      conversation; ask the model to call `echo`.
- [ ] SC-004: approval prompt shows server name, tool name, args; approve;
      result renders as escaped text.
- [ ] SC-005: "remember always" persists across plugin reload.
- [ ] SC-006: rename the server in settings; the auto-approve grant is
      revoked (next call re-prompts).
- [ ] SC-008: cancel mid-call; the plugin sends a cancel notification and
      surfaces a cancelled state.
- [ ] SC-014: Undo button absent on MCP tool call render.
- [ ] SC-015: tool with `dangerLevel: "high"` shows the danger chip.

### Risks & mitigations

- **Risk:** preamble overflow when many MCP servers are configured.
  **Mitigation:** drop-from-end policy plus an explicit
  "+N more tools omitted from preamble" notice; the SDK can still call
  them (registration is independent of preamble visibility).

---

## Phase 6 — Settings UI + reconnect + auto-reconnect/crashloop UX

### Goals

- New "MCP Servers" section in `SettingsTab` with: list, add, edit,
  remove, enable/disable, reconnect, "view last error" (redacted).
- Connect on plugin load for enabled servers; reconnect with capped
  exponential backoff; crashloop detection (5 failed connects in 5 min →
  disable with notice; FR-016, FR-017).
- Settings show connection state (connected, connecting, disabled,
  errored) and tool count.
- Auto-reconnect when the user toggles enabled or edits config; trust
  epoch rotation revokes per-tool grants (FR-012).

### Files to add/edit

- Edit `src/settings/SettingsTab.ts` — mount `McpServersSection`.
- Add `src/settings/sections/McpServersSection.ts` — pure rendering, calls
  into `McpRegistry` and the stores.
- Add `src/mcp/Reconnector.ts` — backoff state machine; emits state
  transitions the section subscribes to.
- Edit `src/main.ts` — start `Reconnector` for each enabled server on
  plugin load; subscribe `McpRegistry` for restart on settings change.

### Implementation notes

- Backoff: 1 s, 2, 4, 8, 16, 30 (cap), with ±20% jitter. Reset on a
  successful connect that lasts > 60 s.
- Crashloop: 5 connect failures within 300 s → disable the server, set a
  user-visible "auto-disabled" badge, surface the redacted last error.
  Manual reconnect re-arms.
- All copy in this section uses `escapeForApprovalText` for any string
  that originated from the server (server name override, last error
  message).

### Required tests

- `Reconnector.test.ts` — schedule, jitter bounds, cap, success-reset,
  crashloop trigger, manual reconnect re-arm.
- `McpServersSection.test.ts` — rendering of every state; add/edit/remove
  flows wire to the stores.
- `SettingsTab.test.ts` (existing, extended) — section mounts/unmounts
  cleanly; no leaked subscriptions.

### Quality gates

- `npm test`
- `npm run typecheck`
- `npm run build`

### Manual verification checklist

- [ ] SC-009: add a server; it connects; tools appear.
- [ ] SC-010: edit the command; server reconnects with rotated trust epoch;
      previously auto-approved tool re-prompts.
- [ ] SC-011: disable a server; tools disappear from the next conversation
      preamble.
- [ ] SC-012: stop the server externally; the plugin reconnects within the
      backoff window. Stop-and-fail-5x within 5 min triggers auto-disable.
- [ ] SC-016: any error string shown in the section is the redacted form.

### Risks & mitigations

- **Risk:** rapid edit/save cycles spawn duplicate clients.
  **Mitigation:** `Reconnector` cancels any in-flight connect on config
  change; `McpRegistry.upsert` is idempotent.

---

## Phase 7 — Resilience hardening + 2024-11-05 compat + bundle check + no-MCP smoke

### Goals

- Explicit protocol-version negotiation: prefer `2025-06-18`; on a
  `protocol-version` mismatch from the server, fall back to `2024-11-05`
  with a one-line user notice (FR-029).
- Verify NFR-005 bundle delta ≤ 80 KB gzip; if exceeded, document tree-
  shaking or transport-split mitigation in CHANGELOG.
- Add a no-MCP smoke harness: with no `mcpServers` configured, no
  `child_process.spawn`, no outbound HTTP, no `mcp__` tool ids, and
  `data.json` is byte-identical to v0.4 input across a startup/shutdown
  cycle (FR-026).
- Add a transport/protocol compatibility matrix test pass.
- Sweep v0.4 baseline tests (NFR-007); confirm 724/724 still green plus
  the new tests added in Phases 1–6.

### Files to add/edit

- Add `src/mcp/protocol/Negotiate.ts` — version preference and fallback.
- Add `src/mcp/__tests__/NoMcpSmoke.test.ts` — startup/shutdown without
  any MCP config; spies on `child_process.spawn` and global `fetch`.
- Add `src/mcp/__tests__/CompatMatrix.test.ts` — `2025-06-18` and
  `2024-11-05` × stdio and HTTP, four scenarios.
- Add `scripts/check-bundle-delta.ts` — measures gzip delta vs a stored
  v0.4 baseline; CI-friendly exit code.
- Edit `package.json` — `npm run check:bundle` script.

### Implementation notes

- Negotiation: send the preferred version on `initialize`; if the server
  responds with a different supported version we accept up to
  `2024-11-05` and warn; anything older is a hard error.
- The bundle check is informational in CI but blocks tagged releases via
  the `check:bundle` script.

### Required tests

- `Negotiate.test.ts` — preferred path, fallback path, hard-fail path.
- `NoMcpSmoke.test.ts` — no spawn, no fetch, no preamble change, no
  `data.json` mutation.
- `CompatMatrix.test.ts` — four-cell matrix.
- All v0.4 baseline tests continue to pass; total project tests count is
  recorded in CHANGELOG.

### Quality gates

- `npm test`
- `npm run typecheck`
- `npm run build`
- `npm run check:bundle` (warn or fail per delta)

### Manual verification checklist

- [ ] SC-007: a `2024-11-05` server connects via fallback with the notice.
- [ ] SC-017: with no servers configured, network panel shows zero
      outbound traffic on plugin start.
- [ ] SC-019: `data.json` byte-identical before/after a no-MCP-configured
      session.
- [ ] NFR-005: gzip delta is reported; under 80 KB or documented mitigation.
- [ ] NFR-007: v0.4 test count baseline preserved and reported.

### Risks & mitigations

- **Risk:** a third-party MCP server reports an unexpected protocol
  version string.
  **Mitigation:** `Negotiate` treats any unrecognised version as a
  hard-fail with a redacted error; user can still disable the server.

---

## Phase 8 — Documentation

### Goals

- `.paw/work/mcp-client/Docs.md` — internal docs covering the MCP module
  layout, transports, safety contract, and known caveats.
- README — user-facing "Configure an MCP Server" section; security model
  (env scrubbing, no shell, TLS posture, redaction); supported transport
  matrix; out-of-scope list.
- CHANGELOG — v0.5 entry: SDK added, bundle delta, protocol versions,
  test count.
- Update `.paw/work/mcp-client/WorkflowContext.md` "Stage" to
  `documentation` when this phase is the active one (per the v0.4
  reference plan style).

### Files to add/edit

- Add `.paw/work/mcp-client/Docs.md`.
- Edit `README.md`.
- Edit `CHANGELOG.md`.
- Edit `.paw/work/mcp-client/WorkflowContext.md` (stage transition only).

### Required tests

- None (documentation-only).

### Quality gates

- `npm test`
- `npm run typecheck`
- `npm run build`

### Manual verification checklist

- [ ] README "Configure an MCP Server" walkthrough succeeds end-to-end on
      a clean install with `mcp-server-everything`.
- [ ] CHANGELOG entry includes bundle-size delta and protocol versions.
- [ ] `Docs.md` covers each phase's anchors and links to the
      requirements traceability matrix.

### Risks & mitigations

- **Risk:** docs drift from code.
  **Mitigation:** Docs.md cites file paths and symbol names so future
  changes surface in code review.

---

## Requirements Traceability Matrix

Every requirement is mapped to the phase that delivers it and the test
surface that exercises it. Where a requirement is satisfied by an
invariant rather than a single test, the phase column shows the phase
that establishes the invariant.

### Functional Requirements

| Req | Phase(s) | Primary tests |
|---|---|---|
| FR-001 (add server) | 6 | `McpServersSection.test.ts` |
| FR-002 (edit server) | 6 | `McpServersSection.test.ts`, `Reconnector.test.ts` |
| FR-003 (remove server) | 6 | `McpServersSection.test.ts`, `McpServersStore.test.ts` |
| FR-004 (stdio transport) | 3 | `McpStdioClient.test.ts`, `StdioProcessAdapter.test.ts` |
| FR-005 (Streamable HTTP) | 4 | `McpHttpClient.test.ts` |
| FR-006 (HTTP session id discipline) | 4 | `McpHttpClient.session.test.ts` |
| FR-007 (tools/list discovery) | 5 | `McpRegistry.test.ts` |
| FR-008 (SDK tool registration) | 5 | `AgentSession.test.ts` (MCP path) |
| FR-009 (`mcp__` prefix reserved) | 5 | `BuiltinPrefixGuard.test.ts` |
| FR-010 (preamble inventory + 8 KB cap) | 5 | `PreambleAssembler.test.ts` |
| FR-011 (universal approval gate) | 2 | `SafetyPolicy.test.ts`, `AgentSession.test.ts` |
| FR-012 (per-(server, tool) auto-approve + epoch revocation) | 1, 2 | `McpAutoApproveStore.test.ts`, `SafetyPolicy.test.ts` |
| FR-013 (Undo suppressed for MCP) | 2 | `ToolCallBlock.test.ts` |
| FR-014 (tool call routes through gate) | 5 | `AgentSession.test.ts` |
| FR-015 (cancellation propagates) | 5 | `McpStdioClient.disconnect.test.ts`, `AgentSession.test.ts` |
| FR-016 (auto-reconnect with backoff) | 6 | `Reconnector.test.ts` |
| FR-017 (crashloop auto-disable) | 6 | `Reconnector.test.ts` |
| FR-018 (settings: state + last error) | 6 | `McpServersSection.test.ts` |
| FR-019 (session-id never persisted/logged) | 4 | `McpHttpClient.session.test.ts`, `redact.test.ts` |
| FR-020 (origin chip on tool render) | 5 | `ToolCallBlock.test.ts` |
| FR-021 (danger hints) | 5 | `ToolCallBlock.test.ts` |
| FR-022 (env denylist) | 3 | `StdioProcessAdapter.test.ts` |
| FR-023 (no shell, array args) | 3 | `StdioProcessAdapter.test.ts` |
| FR-024 (graceful disconnect rejects pending) | 3 | `McpStdioClient.disconnect.test.ts` |
| FR-025 (URL/TLS posture) | 4 | `HttpUrlGuard.test.ts` |
| FR-026 (no-MCP behavior == v0.4) | 7 | `NoMcpSmoke.test.ts` |
| FR-027 (env scrubbing list enumerated) | 3 | `StdioProcessAdapter.test.ts` |
| FR-028 (frame size cap) | 3 | `StdioProcessAdapter.test.ts` |
| FR-029 (protocol version negotiate + fallback) | 7 | `Negotiate.test.ts`, `CompatMatrix.test.ts` |
| FR-030 (no Markdown render of MCP strings) | 2 | `escapeForApprovalText.test.ts`, `AgentSession.test.ts` |

### Non-Functional Requirements

| Req | Phase(s) | Primary tests / verification |
|---|---|---|
| NFR-001 (no blocking on the UI thread) | 3, 4 | transport tests run async; manual: smooth typing during a long tool call |
| NFR-002 (typed errors) | 3, 4 | `HttpUrlGuard.test.ts`, `McpStdioClient.test.ts` (typed reasons) |
| NFR-003 (idempotent dispose) | 3, 4, 6 | `McpStdioClient.test.ts`, `McpHttpClient.test.ts`, `Reconnector.test.ts` |
| NFR-004 (no globals, no module-level state) | all | code review + `NoMcpSmoke.test.ts` (no module-level fetch hooks) |
| NFR-005 (≤80 KB gzip delta) | 7 | `npm run check:bundle` |
| NFR-006 (zero new persistent caches) | 1, 4 | `McpHttpClient.session.test.ts`, `PersistedShape.test.ts` |
| NFR-007 (v0.4 baseline preserved) | 7 | full `npm test` run, baseline count recorded in CHANGELOG |
| NFR-008 (style/lint conformance) | all | existing project lint task in `npm run typecheck` / `npm run build` |

### Success Criteria

| SC | Phase(s) | Verification |
|---|---|---|
| SC-001 (stdio connects) | 3 | manual + `McpStdioClient.test.ts` |
| SC-002 (HTTP connects, scheme rejected) | 4 | manual + `HttpUrlGuard.test.ts` |
| SC-003 (tools appear, model calls one) | 5 | manual + `AgentSession.test.ts` |
| SC-004 (approval prompt content + escaped result) | 5 | manual + `AgentSession.test.ts` |
| SC-005 (remember-always persists across reload) | 5, 1 | manual + `McpAutoApproveStore.test.ts` |
| SC-006 (rename revokes grants) | 1, 6 | manual + `McpAutoApproveStore.test.ts` |
| SC-007 (2024-11-05 fallback) | 7 | manual + `Negotiate.test.ts` |
| SC-008 (cancellation) | 5, 3 | manual + `AgentSession.test.ts`, `McpStdioClient.disconnect.test.ts` |
| SC-009 (add → connect → tools) | 6 | manual |
| SC-010 (edit → reconnect → epoch rotation) | 6 | manual + `Reconnector.test.ts`, `McpAutoApproveStore.test.ts` |
| SC-011 (disable hides tools) | 6 | manual + `McpRegistry.test.ts` |
| SC-012 (auto-reconnect + crashloop disable) | 6 | manual + `Reconnector.test.ts` |
| SC-013 (every MCP path through gate) | 2 | code review + `AgentSession.test.ts` |
| SC-014 (Undo suppressed) | 2 | manual + `ToolCallBlock.test.ts` |
| SC-015 (danger hint surfaces) | 5 | manual + `ToolCallBlock.test.ts` |
| SC-016 (errors redacted in UI) | 4, 6 | manual + `redact.test.ts` |
| SC-017 (zero outbound when no servers) | 7 | manual + `NoMcpSmoke.test.ts` |
| SC-018 (Markdown not rendered + session-id redacted in errors) | 2, 4 | `escapeForApprovalText.test.ts`, `redact.test.ts` |
| SC-019 (data.json byte-identical when no MCP) | 1, 7 | `PersistedShape.test.ts`, `NoMcpSmoke.test.ts` |

## NFR-007 Phase-Local Regression Matrix (v0.4 baseline behaviors × phase most likely to disturb)

| v0.4 behavior | Phase | Why disturbed | Coverage |
|---|---|---|---|
| `decideSafety()` shape | 2 | adds `serverId`/`toolName` plumbing | `SafetyPolicy.test.ts` (existing + extended) |
| `data.json` byte-stability | 1, 7 | adds top-level keys | `PersistedShape.test.ts`, `NoMcpSmoke.test.ts` |
| `AgentSession` tool stream classification | 2, 5 | adds MCP registration / approval routing | `AgentSession.test.ts` |
| `ToolCallBlock` Undo button visibility | 2 | adds source-based suppression | `ToolCallBlock.test.ts` |
| `PreambleAssembler` 8 KB cap | 5 | injects MCP inventory | `PreambleAssembler.test.ts` |
| `SettingsTab` mount/unmount | 6 | adds new section | `SettingsTab.test.ts` |
| Bundle size | 3, 4, 7 | adds SDK | `npm run check:bundle` |
| Module-level globals | 3, 4 | could leak fetch/spawn hooks | `NoMcpSmoke.test.ts` |

## References

- `.paw/work/mcp-client/Spec.md` — 30 FRs, 8 NFRs, 19 SCs (revised at b1aaf40
  to address must/should items from the multi-model spec review).
- `.paw/work/mcp-client/SpecResearch.md` — `@modelcontextprotocol/sdk@1.29.0`
  is the latest stable 1.x; `2025-06-18` is the current MCP protocol version
  with `2024-11-05` documented as the fallback.
- `.paw/work/mcp-client/WorkflowContext.md` — v0.5 goals and carried v0.4
  constraints (NFR-005, NFR-007, FR-026).
- `.paw/work/mcp-client/reviews/SPEC-REVIEW-SYNTHESIS.md` — multi-model spec
  review synthesis confirming b1aaf40 closure of must-fix items.
- `.paw/work/model-picker/ImplementationPlan.md` — v0.4 reference style
  for the per-phase structure used here.
- `src/domain/SafetyPolicy.ts`, `src/sdk/AgentSession.ts`,
  `src/persistence/PersistedShape.ts`, `src/settings/SafetySettingsStore.ts`,
  `src/main.ts`, `src/domain/ConversationRuntime.ts`,
  `src/ui/ToolCallBlock.ts`, `src/domain/PreambleAssembler.ts`,
  `src/settings/SettingsTab.ts` — verified v0.4 anchors.

## Synthesis Notes

- **Phase 2 before transports** is intentional: the gate's contract must be
  tested and merged before any code path can call out to a real MCP server,
  so that transport phases cannot accidentally bypass it.
- **Trust epoch over manual revocation**: rotating an epoch on identity-
  defining changes is cheaper and more reliable than reasoning about every
  edit-shape that should revoke grants. Lookup is constant-time and the
  store stays simple.
- **Preamble drop-from-end**: vault tools are always more important to the
  model's preamble than MCP tools, because MCP tools are still callable
  via SDK registration; preamble visibility is a hint, not a gate.
- **Bundle size as informational gate**: NFR-005 is sanity-checked in CI
  but only blocks tagged releases via `check:bundle`, so a development
  branch can iterate on transport code without thrashing on size deltas.
- **No-MCP smoke as a phase 7 deliverable**: the smoke harness is the
  single mechanical proof that v0.4 behavior is preserved; it asserts
  `child_process.spawn`, `fetch`, and persisted-shape mutations are all
  zero in the no-config path.

## Revision Notes

- 2025-XX-XX — Initial draft for v0.5 MCP Client Integration produced as
  one of three independent planning subagent outputs (claude-opus-4.7).
  Targets `@modelcontextprotocol/sdk@^1.29.0` per SpecResearch §1.
