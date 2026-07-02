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

A small inline pill next to the composer, rendered while the plugin
is waiting on MCP servers to reach a terminal state. The pill:

- Uses `role="status"` so screen readers announce state changes as
  a live region.
- Only renders while the `mcpReadinessGate` cycle is in flight;
  disappears the moment the gate resolves.
- Fast-path guarded: if the gate resolves within `FAST_PATH_MS`
  (a static in `ChatView`, currently `100` ms — matches Spec FR-013
  / SC-008) the pill is never shown.

Event surface on `AgentSession` (`src/sdk/AgentSession.ts:163`):

```ts
onReadinessGateEvent?: (evt: "start" | "resolved") => void;
```

`start` fires immediately when a session enters
`awaitMcpReadinessGate()`. `resolved` fires when the gate returns.

Consumer implementation lives in `src/ui/ChatView.ts` — the pill's
lifecycle is driven through `enterReadinessPending()`,
`showReadinessPill()`, and `exitReadinessPending()`; the DOM node is
built once via `buildReadinessPill()` and shown/hidden thereafter.
`ChatView.ts:237` holds `FAST_PATH_MS`. Pill state is tracked as
`idle | pending` internally — the finer states (`waiting`,
`all-connected`, `partial`) live in `McpStatusWatcher`; the pill
does not distinguish them because the readiness gate resolves on
*any* terminal outcome.

### 2. Automatic live tool refresh (`AgentSession`)

When an MCP server reaches `connected` **after** the gate has closed,
the plugin refreshes the running session's tool list without
tearing down conversation state.

**Broadcast wiring** (`src/main.ts`):

- `McpStatusWatcher.onTransition("connected")` triggers
  `handleMcpTransitionForToolRefresh(...)` which iterates all live
  `AgentSession` instances and calls `applyToolListChange()` on each.
- `handleMcpNoticeForToolToast(...)` shows a per-server Notice
  `"Tools from <serverName> are now available."`, gated on
  `hasLiveToolUpdate()` so the toast only fires when the refresh
  actually took effect. Debounced against notice-spam.

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

- `src/ui/ChatView.ts` — readiness pill render + lifecycle
  (`buildReadinessPill`, `enterReadinessPending`,
  `showReadinessPill`, `exitReadinessPending`, `FAST_PATH_MS`)
- `src/sdk/AgentSession.ts` — readiness gate event stream
  (`onReadinessGateEvent`), `applyToolListChange`,
  `swapSessionForToolRefresh`, `hasLiveToolUpdate`,
  `canSwapForToolRefresh`
- `src/main.ts` — watcher-side wiring
  (`handleMcpTransitionForToolRefresh`,
  `handleMcpNoticeForToolToast`)
- `src/mcp/McpStatusWatcher.ts` — Phase 1 status coalescing and
  transition/notice event surface
- Tests: `src/sdk/AgentSession.test.ts`,
  `src/main.mcpToolRefresh.test.ts`,
  `src/ui/ChatView.readinessPill.test.ts`

## Testing notes

- 1559 tests across 109 files at v0.9.0. Full suite runs in ~17 s on
  CI-equivalent hardware.
- The session-swap path is covered by 9 dedicated tests including a
  streaming-latch drain-once test, a dispose-mid-round-trip test,
  and a streaming-started-mid-round-trip test that guards FR-006
  (in-flight turns are never interrupted by a swap).
- Reload-the-plugin escape hatch remains available: if for any reason
  the swap fails and the user has stale tools, restarting Obsidian
  still works exactly as before.
