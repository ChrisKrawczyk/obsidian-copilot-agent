# MCP Readiness UX — Technical Reference

Reference for the readiness pill + live tool refresh flow shipped in
v0.9.0 (built on top of v0.8.0's readiness gate).

## Problem shipped in v0.8.0, followed up here

v0.8.0 added a readiness gate that holds new chat sessions until every
configured MCP server reaches a terminal state (connected, disabled,
error, timed out). The gate fixed tool flakiness on cold start, but
left two gaps:

1. **Visibility.** During the wait, the composer sat greyed-out with no
   explanation of what was blocking it. Wait times range from sub-second
   to ~15 s (the ceiling), and users reasonably assumed the plugin was
   broken.
2. **Slow-auth servers.** Servers that authenticated past the 15 s
   ceiling (device-flow logins, cloud-CLI token refresh, etc.) reached
   `connected` in the MCP layer but couldn't inject their tools into
   the already-created SDK session. The only recourse was to reload
   the plugin.

## Shipped surface

### 1. Inline readiness pill (`ChatView`)

A small inline pill next to the composer that reflects the gate's
state machine. The pill:

- Is announced via `aria-live="polite"` and is keyboard/focus-safe.
- Emits at most one state per second (rAF-coalesced).
- Only renders while `AgentSession` is in `awaiting-mcp-readiness`; it
  is torn down as soon as `sdkReady` fires.
- Fast-path guarded: if the gate resolves within `readinessFastPathMs`
  (default 200 ms) the pill is never shown.

State machine surfaced by `AgentSession` via
`onReadinessGateEvent({ phase, pending, resolved, timedOut })`:

- `waiting` — one or more MCP servers not yet terminal
- `all-connected` — every server terminal in `connected`
- `partial` — at least one terminal but some errored/timed-out
- `resolved` — gate closed (session about to send)

Consumer implementation lives in `src/ChatView.ts` under
`renderReadinessPill()` and is fully driven by the event stream — no
polling.

### 2. Automatic live tool refresh (`AgentSession`)

When an MCP server reaches `connected` **after** the gate has closed,
the plugin refreshes the running session's tool list without
tearing down conversation state.

**Broadcast wiring** (`src/main.ts`):

- `McpStatusWatcher.onTransition("connected")` fires
  `handleMcpTransitionForToolRefresh(...)` which iterates all live
  `AgentSession` instances and calls `applyToolListChange()` on each.
- `handleMcpNoticeForToolToast(...)` shows a single
  `"MCP tools refreshed"` Notice per burst (5 s coalescing window),
  gated on `hasLiveToolUpdate()` so the toast only fires when the
  refresh actually took effect.

**`AgentSession.applyToolListChange()`** — three branches evaluated in
order:

1. **Live primitive path** (Phase 5, blocked on
   [github/copilot-sdk#1896](https://github.com/github/copilot-sdk/issues/1896)).
   If `session.updateTools([...])` exists, call it with the fresh
   snapshot. This is the ideal path — no session teardown, no
   server-side conversation reshaping.
2. **Session-swap path** (Phase 4.5, shipped in v0.9.0). If the SDK
   exposes `client.resumeSession(sessionId, { tools, ... })` but not
   the live primitive, swap the SDK session in place. `resumeSession`
   preserves server-side conversation history via the stable
   `sessionId`, so the user sees no visible reset. The old session is
   disconnected in the background.
3. **No-op path** (FR-011 fallback). If neither primitive is
   available, log once at debug and no-op. This branch is currently
   unreachable in production because SDK 1.0.0+ exposes
   `resumeSession`, but preserved for very-old-SDK safety.

**Turn-boundary queueing**: if a transition arrives mid-stream,
`applyToolListChange` sets the `pendingToolUpdate` latch and returns.
The drain in `sendMessageStreaming`'s finally re-enters
`applyToolListChange` with the *latest* snapshot (last-write-wins), so
even a rapid burst of transitions during a long stream produces
exactly one refresh at the turn boundary.

**Race safety**: dispose during the `resumeSession` round-trip
disconnects the freshly-built session and bails without swapping.
Failed resumes leave the old session in place and log a warning —
the next transition retries with a fresh snapshot.

**Handler surface**: the only cross-turn subscription on the SDK
session is `onPermissionRequest`. Every `session.on("...")` listener
in `sendMessageStreaming` is per-turn (subscribed at the top of the
loop, unsubscribed in the finally). The swap re-passes
`onPermissionRequest` to the same `handlePermission` method the
initial `createSession` call used, so decider routing is preserved.

## Follow-ups (external / future work)

- **[github/copilot-sdk#1896](https://github.com/github/copilot-sdk/issues/1896)** —
  re-triage of the closed #735 proposal for a `session.updateTools()`
  primitive. Blocked on maintainer response. Filed 2026-07-02.
- **Phase 5: SDK adoption.** Once #1896 lands and is published, bump
  `@github/copilot-sdk`, wire the real primitive in
  `applyToolListChange`'s branch 1, and remove the
  `swapSessionForToolRefresh` fallback (branch 2). Small diff.

The session-swap stop-gap is production-grade and works indefinitely;
Phase 5 is tidying, not a fix.

## Files touched in v0.9.0

- `src/ChatView.ts` — readiness pill render + lifecycle
- `src/sdk/AgentSession.ts` — readiness gate event stream,
  `applyToolListChange`, `swapSessionForToolRefresh`,
  `hasLiveToolUpdate`, `canSwapForToolRefresh`
- `src/main.ts` — watcher-side wiring
  (`handleMcpTransitionForToolRefresh`,
  `handleMcpNoticeForToolToast`)
- `src/domain/McpStatusWatcher.ts` — Phase 1 status coalescing (may
  have shipped in an earlier release; see the plan file for
  provenance)
- Tests: `src/sdk/AgentSession.test.ts`,
  `src/main.mcpToolRefresh.test.ts`, `src/ChatView.test.ts`

## Testing notes

- 1559 tests across 109 files at v0.9.0. Full suite runs in ~17 s on
  CI-equivalent hardware.
- The session-swap path is covered by 8 dedicated tests including a
  streaming-latch drain-once test and a dispose-mid-round-trip test.
- Reload-the-plugin escape hatch remains available: if for any reason
  the swap fails and the user has stale tools, restarting Obsidian
  still works exactly as before.
