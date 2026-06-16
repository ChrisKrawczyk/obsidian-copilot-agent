# PLAN REVIEW PERSPECTIVE - operational-resilience

## Verdict
NEEDS-REVISION

The plan covers the major resilience surfaces (timeouts, backoff, crashloop, stdin→SIGTERM→SIGKILL ladder, list_changed coalescing, env filtering, redaction, oversized-I/O caps) and anchors them in real files. However, Phase 5 ships live MCP tool execution **before** Phase 6 lands cancellation, in-flight rejection, stale-session retry, and reconnect, which violates the plan's own "intermediate states must keep chat behavior v0.4-equivalent" invariant (plan L13). Several ordering, parallelism, and corruption-tolerance gaps must be closed or sequenced differently before this is mergeable phase-by-phase.

## Specialist Findings

### MUST-FIX

**M1. Phase 5 ships MCP execution without resilience; phase invariant is broken.**
- Evidence: Plan L13 ("intermediate states must either be headless or keep chat behavior v0.4-equivalent"); Phase 5 (L226–264) makes MCP calls live end-to-end via `McpToolBridge.callTool`; Phase 6 (L267–303) is when stdio auto-reconnect (FR-018), HTTP stale 404 (FR-019), in-flight rejection on disable/remove/reconnect, Stop/cancel propagation (FR-021), and `list_changed` coalescing (FR-020) land.
- Impacted requirements: FR-016, FR-018, FR-019, FR-020, FR-021; SC-006, SC-007, SC-008, SC-013, SC-015; NFR-002.
- Operational consequence: If a user merges at the Phase 5 gate, a stdio crash mid-call leaves a hanging promise; HTTP 404 wedges the session forever; concurrent `list_changed` swaps the registry mid-call (partial state); Stop does not cancel an MCP `tools/call`. Chat behavior is no longer "v0.4-equivalent" once a user enables a single MCP server.
- Recommended plan change: Either (a) move minimum-viable resilience (in-flight rejection on disable/remove/reconnect, stale-HTTP 404 reinit, Stop cancellation, list_changed deferral) into Phase 5's Changes Required and tests, OR (b) gate Phase 5 behind a feature flag/UI message ("MCP tool calls in preview — resilience pending Phase 6") and explicitly call out that Phase 5 is NOT a green stopping point for end users. Update Phase Status / Phase Ordering Rationale (L72–78) accordingly.

**M2. Onunload shutdown budget and parallelism are unspecified.**
- Evidence: Phase 6 L288 "unload sequence closes stdin → waits 5 s → SIGTERM → waits 5 s → SIGKILL"; Phase 4 L202 "dispose all runtime connections on unload"; existing `main.ts:713` `onunload` already awaits `flushThenDispose` and shared SDK client dispose serially.
- Impacted requirements: FR-024, SC-010, NFR-007 (baseline preservation).
- Operational consequence: With N stdio servers, a serial 10s-per-server ladder plus per-server HTTP DELETE wait can block Obsidian quit/reload for tens of seconds. `lifecycle.ts:57–68` notes that throwing from the quit handler can "block the app close indefinitely" — the MCP shutdown sequence has the same risk if not bounded and parallel.
- Recommended plan change: In Phase 6 Changes Required, require: (a) per-server shutdown runs in parallel (e.g., `Promise.allSettled`); (b) the HTTP DELETE has an explicit bound (e.g., 2 s) and is wrapped in try/catch; (c) the entire MCP shutdown wraps in `Promise.race` against an outer cap (e.g., 12 s) so SIGKILL stragglers cannot prevent Obsidian from exiting; (d) the dispose path is idempotent and re-entrant safe (already promised at L288 but the test must assert "called twice" too). Add a quality-gate manual step: "Reload plugin with 3 stdio servers; verify reload completes within ~12 s even when all three ignore stdin and SIGTERM."

**M3. Persistence corruption / shape-violation handling is not specified.**
- Evidence: Phase 1 tests only cover "missing `mcpServers` defaults to `[]`" and round-trip (L99); Spec L327–328 says "schema is additive; no migration needed beyond defaulting missing `mcpServers` to `[]`". `SafetySettingsStore.ts:237–260` shows the repo's defensive `mergeWithDefaults` pattern (filtering non-strings, dropping unknown types) — the plan does not require analogous defense for `mcpServers`.
- Impacted requirements: FR-001 ("Missing field defaults to `[]`" is partial — corrupt fields are unspecified), NFR-002, SC-005, SC-012.
- Operational consequence: A user (or a future migration bug) writing `mcpServers: "[]"` (string), an entry with `transport: "sse"`, `command: 123`, or `headers: null` would either throw on hydrate or pass invalid data into spawn/fetch. With no fail-closed normalization, the plugin can fail to load and lose access to all other features — there is no recovery path because the persisted blob also holds `auth`/`safety`/`conversations`.
- Recommended plan change: Phase 1 Changes Required must specify a `mergeWithDefaults`-style normalizer in `McpSettingsStore` that: (i) coerces non-array `mcpServers` to `[]`; (ii) drops entries failing schema validation (unknown transport, missing required fields, wrong types); (iii) records a one-shot diagnostic so the user sees that N entries were dropped; (iv) preserves the original blob's sibling keys (the test on L99 covers the sibling case; add a "corrupt entry" test). Add a manual gate: "Hand-edit `data.json` to inject `mcpServers: { broken: true }` and verify plugin still loads with empty MCP list and a Notice/log."

**M4. Cancellation must not target `initialize`, and Stop during initialize/discovery is unspecified.**
- Evidence: SpecResearch L205 "Client MUST NOT cancel its `initialize` request"; Spec FR-021 L198–199 covers Stop on `tools/call` only; Phase 6 L278 "propagate Stop/cancellation with `notifications/cancelled` when possible" does not enumerate the initialize exception or what Stop does during a 10 s initialize/`tools/list` wait.
- Impacted requirements: FR-021, FR-027, SC-013.
- Operational consequence: A bridge that uncritically sends `notifications/cancelled` on any in-flight request risks violating MCP spec for initialize (server may reject or behave undefined); conversely, Stop during a hung initialize that only triggers our 10 s timeout means the user has no way to abort a stuck connection between phases.
- Recommended plan change: Phase 6 Changes Required must explicitly say: "Stop and cancellation never send `notifications/cancelled` for `initialize`; instead, Stop during initialize/discovery resolves the local waiter, marks the server `failed` with last error `cancelled by user`, and tears down the transport via the FR-024 shutdown ladder." Add a test in `McpToolBridge.test.ts` or `McpServerRuntime.test.ts` for this exact case.

### SHOULD-FIX

**S1. Phase 4 ships disable/remove without in-flight call rejection (sequencing gap).**
- Evidence: Phase 4 L202 "stop disabled/removed servers"; Phase 6 L277 "in-flight rejection on disable/remove/reconnect"; Phase 5 ships tool execution between them.
- Impacted requirements: FR-016, FR-024.
- Operational consequence: Between Phase 4 ship and Phase 6 ship, if Phase 5 also ships, disabling a server with an in-flight `tools/call` could leave the AgentSession waiter pending forever, defeating the L34 "deterministic and locally observable" goal.
- Recommended plan change: Either pull in-flight rejection on disable/remove into Phase 4's Changes Required (it logically belongs with the lifecycle action), or note in Phase 4 that disable/remove is allowed only because Phase 5 hasn't shipped tool execution yet — and tighten the gating in Phase 5/6.

**S2. `list_changed` coalescing deferred until Phase 6, but tools go live in Phase 5.**
- Evidence: Phase 5 L226–264 publishes MCP inventories into AgentSession; Phase 6 L276 adds `McpNotificationQueue`.
- Impacted requirements: FR-020, SC-008.
- Operational consequence: In Phase 5 the server can send `notifications/tools/list_changed` and either be silently ignored (stale inventory) or naively re-listed mid-call (partial-state registry swap → potential mismatch between approval scope and actual tool).
- Recommended plan change: Phase 5 Changes Required should add a stub behavior: "Until Phase 6 lands `McpNotificationQueue`, `tools/list_changed` is dropped (not refreshed), and the runtime marks the inventory as `staleSince` for status display." Then Phase 6 replaces the stub with full coalescing.

**S3. Phase 4 manager subscription cleanup is unspecified.**
- Evidence: Phase 4 L200 "subscribe to store/manager snapshots"; existing pattern at `SafetySettingsStore.ts:146–149` returns an unsubscribe function but plan does not require that the settings section drops the subscription on tab close.
- Impacted requirements: NFR-007 (no regression), SC-005.
- Operational consequence: Leaked subscriptions across settings open/close cycles can fire callbacks against a destroyed DOM after plugin reload, surfacing as console noise or partial UI updates that are confusing during shutdown.
- Recommended plan change: Add to Phase 4 Required Tests a case: "Opening/closing the Settings tab N times does not retain references in `McpSettingsStore`/`McpManager` listener sets." Mention an explicit `dispose()` on `McpServersSection`.

**S4. Manual reconnect must clear backoff timers, not just counters.**
- Evidence: Phase 6 L275 "manual Reconnect reset" applies to crashloop counters; FR-017 L179 "Reconnect clears volatile transport state including HTTP session id and stdio reconnect/crashloop counters" — but if a backoff timer is already armed (e.g., next attempt in 16 s), manual Reconnect must also cancel that pending timer and start immediately.
- Impacted requirements: FR-017, FR-018, SC-015.
- Operational consequence: User clicks Reconnect, expects an immediate attempt, but a queued backoff timer fires later and overlaps a successful manual reconnect — racy state and confusing diagnostics.
- Recommended plan change: Phase 6 Changes Required for `McpReconnectPolicy` should explicitly list "manual Reconnect cancels any armed backoff timer and starts a new attempt immediately." Add a test in `McpReconnectPolicy.test.ts`: "Armed timer plus manual reconnect produces exactly one initialize attempt."

**S5. Logging namespace / redaction discipline is not standardized.**
- Evidence: Existing code uses `[copilot-agent]` prefix (e.g., `main.ts:714,732,469`; `lifecycle.ts:38,45,65`). Plan calls for `redact.ts` (L161) and forbids logging `Authorization`/`Mcp-Session-Id`/URL userinfo, but does not specify that all MCP diagnostics go through a single logger that auto-applies redaction.
- Impacted requirements: NFR-003 (Security), NFR-008 (Observability without telemetry), FR-019, FR-031.
- Operational consequence: Ad-hoc `console.log/warn/error` calls inside `McpManager`/`McpServerRuntime` that forget to pre-redact will leak secrets into devtools/stderr (especially during exception paths where someone logs the whole config object).
- Recommended plan change: In Phase 3 add `src\mcp\McpLogger.ts` (or extend `redact.ts`) as the single logging seam (`mcp.warn(serverId, msg, payload)`) and require all MCP modules to use it. Add a lint/test: "No `console.*` calls outside `McpLogger` within `src\mcp\`."

**S6. `tools/call` timeout configurable up to 300 s vs. unload responsiveness.**
- Evidence: Spec FR-027 L229 "`tools/call` timeout defaults to 60 s, configurable per server, capped at 300 s"; Phase 6 L279 "ensure dispose/reconnect/cancel ordering cannot leave pending approvals or hanging promises."
- Impacted requirements: FR-021, FR-024, FR-027.
- Operational consequence: An MCP call configured at 300 s that is mid-flight when the user reloads the plugin should NOT block onunload for up to 300 s. The plan does not explicitly say in-flight call promises are settled (rejected) before/while the FR-024 shutdown ladder runs.
- Recommended plan change: Phase 6 Changes Required should state explicitly: "On disable/remove/unload, in-flight `tools/call` waiters are settled with a cancelled/disconnected error BEFORE the stdio shutdown ladder starts so AgentSession can resolve approval/tool-call UI state without waiting on the configured call timeout."

### CONSIDER

**C1. Reconnect schedule and tools/list page timeout share the 10 s budget; combined worst-case is not bounded.**
- Evidence: FR-027 page timeout 10 s; FR-009 up to 50 pages → up to 500 s on a pathological reconnect; FR-018 attempt schedule.
- Recommended: Document an aggregate "discovery wall-clock cap" (e.g., 30 s) so a slow-but-not-timing-out server cannot keep one reconnect attempt occupying the runtime for 8+ minutes. This is currently invisible behavior.

**C2. Server startup ordering on plugin load.**
- Evidence: Phase 4 L202 "load enabled configs after plugin bootstrap, connect asynchronously" — implies parallel, but not stated.
- Recommended: Phase 4 should explicitly require parallel `Promise.allSettled` startup so one slow server (10 s initialize) does not delay others. Existing onload pattern at `main.ts:577–583` is already non-blocking; mirror that.

**C3. `data.json` write serialization across stores.**
- Evidence: `SafetySettingsStore.ts:117,201–234` serializes writes via `tail` and re-reads disk before merging. Plan L92 says `McpSettingsStore` will "serialize writes" but does not require coordination with the other stores. A simultaneous safety + mcp write can clobber sibling keys if both re-read at the same moment.
- Recommended: Either share a single write queue across stores at the `PluginDataIO` layer, or document that each store's read-modify-write is per-store and any new top-level key (`mcpServers`) is preserved by all existing stores' merge logic. Verify `SafetySettingsStore.persist` is updated to preserve `mcpServers` in its `base` spread (line 215–222).

**C4. `Mcp-Session-Id` clearing on every failure path.**
- Evidence: FR-019 L189 clears session id on stale 404 and reconnect; Phase 6 L277 "volatile session-id clearing."
- Recommended: Add an explicit invariant test: "After ANY initialize failure (timeout, parse error, transport error, oversized response), the volatile `Mcp-Session-Id` is null." Currently only the 404/reconnect path is named.

**C5. Stderr ring buffer overflow during silent storms.**
- Evidence: FR-028 64 KiB stderr ring buffer; Phase 3 test mentions "64 KiB stderr ring buffer" (L171).
- Recommended: Make the cap a write-into-ring with newline-respecting truncation marker so diagnostics aren't a torn UTF-8 mid-sequence. Plan should call out the marker explicitly (e.g., `… [stderr truncated to 64 KiB]`).

## Resilience Notes

**Failure modes covered:**
- Initialize / `tools/list` / `tools/call` timeouts with deterministic fail-closed and capped chat impact (Phase 3, Phase 6).
- Stdio crash → bounded exponential backoff → crashloop terminal state (Phase 6 / FR-018).
- HTTP disconnect / stale session 404 (Phase 6 / FR-019).
- Oversized payloads (16 MiB frames/bodies/SSE; 64 KiB stderr) (Phase 3 / FR-028).
- `notifications/tools/list_changed` coalescing + atomic registry swap (Phase 6 / FR-020).
- Subprocess shutdown ladder stdin → 5 s → SIGTERM → 5 s → SIGKILL (Phase 6 / FR-024).
- Secret env filtering + macOS PATH amendment (Phase 3 / FR-022, FR-023).
- URL/TLS posture, metadata-host rejection, private-net confirmation, cross-origin Authorization stripping, 3-redirect cap (Phase 3 / FR-025).
- Trust epoch rotation invalidates persistent grants (Phase 1+2 / FR-012, SC-019).
- Sibling-key preservation on persistence (Phase 1 tests).

**Failure modes missing or under-specified:**
- Onunload aggregate wall-clock cap and per-server parallel shutdown (see M2).
- In-flight `tools/call` waiter settlement BEFORE the stdio shutdown ladder (see S6).
- Cancellation guard for `initialize` (must not cancel) and Stop semantics during initialize/discovery (see M4).
- Corrupt / malformed persisted `mcpServers` entries (non-array, unknown transport, missing required fields) — no fail-closed normalizer specified (see M3).
- Manual Reconnect cancelling armed backoff timers (see S4).
- Aggregate discovery wall-clock cap across paginated `tools/list` (see C1).
- Cross-store data.json write coordination invariant (see C3).
- Volatile-state clearing on ALL initialize failure paths (see C4).

**Lifecycle / cleanup observations:**
- Plan correctly identifies `main.ts` (`onunload` at line 713) and the `lifecycle.ts` `flushThenDispose` pattern as anchors. Adding `manager.disposeAll()` (or similar) into this chain should keep the existing flush-then-dispose ordering: flush settings/conversations first, then tear down MCP, so any last "recordStatus" write lands before runtimes go.
- Phase 6 L288 promises idempotency for unload — good. The Phase 4 deferred-init/recovery path (mentioned in Spec NFR-007 L255) is not explicitly mapped to MCP startup; ensure MCP failures during onload cannot block conversation hydrate (Phase 4 must connect MCP asynchronously after the synchronous bootstrap, mirroring `main.ts:577–583`).
- Persistence corruption could indirectly take down conversations/auth/safety because they all share `data.json`. The plan must guarantee MCP-config corruption is contained.

## Anchor Check

**Verified anchors:**
- `src\domain\SafetyPolicy.ts` — `SafetySource = "mcp"` at line 19; `mcpAutoApprove?: Record<string, boolean>` at line 49; `grantMcp(serverName)` at line 74; `isMcpGranted(serverName)` at line 88; `case "mcp":` decision branch at line 199. Plan correctly identifies that scope must change from server-name-only to `(serverId, toolName, trustEpoch)`.
- `src\sdk\AgentSession.ts` — present; `buildSafetyInput` and approval routing are the right anchors.
- `src\ui\ToolCallBlock.ts` — present; Undo suppression for MCP is appropriate (no MCP undo per FR-013).
- `src\domain\PreambleAssembler.ts` — present; preamble extension for MCP inventory/instructions is the right seam.
- `src\settings\SafetySettingsStore.ts:201–234` — sibling-preserving read-modify-write pattern is the documented model for `McpSettingsStore.persist` and is correctly referenced.
- `src\persistence\PersistedShape.ts:32` — `source?: "custom" | "mcp" | "builtin"` already exists on persisted tool calls; MCP attribution can flow through persistence without a schema migration.
- `src\main.ts:713` `onunload` — exists with `flushThenDispose` + shared SDK dispose; MCP manager dispose must slot into this chain.
- `src\lifecycle.ts:30–48,57–68` — `flushThenDispose` and `makeQuitFlushHandler` are the right cleanup helpers to extend or mirror.

**Operational anchors missing or weakly anchored:**
- No anchor named for a single MCP logger/redaction seam (see S5). `src\mcp\redact.ts` is in scope but logging discipline is not enforced by structure.
- No anchor for the cross-store write coordination story; plan should call out which file mediates "preserve `mcpServers` when other stores write" (see C3) — likely a regression test added to `SafetySettingsStore.test.ts` and `ConversationsStore.test.ts`.
- No anchor for the aggregate unload budget; recommend it live alongside `lifecycle.ts` (e.g., add `mcpShutdownAll(manager, { budgetMs })`).
- The deferred-init recovery anchor (Spec NFR-007) is not mapped — recommend Phase 4 explicitly cite the `main.ts:577–583` non-blocking hydrate pattern for MCP startup.
