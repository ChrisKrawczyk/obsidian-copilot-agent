# Feature Specification: MCP Readiness UX

**Branch**: feature/mcp-readiness-ux  |  **Created**: 2026-07-01  |  **Status**: Draft
**Input Brief**: Address v0.8.0 follow-ups — surface readiness state, live-refresh tools after slow-auth servers connect, and add the SDK primitive that makes it possible.

## Overview

When users add a new MCP server (especially one that requires interactive
authentication such as device-flow logins or cloud-CLI sign-ins) and
start a new chat session, the chat composer sits silently disabled while
the plugin waits for MCP servers to reach a terminal state. Today the
wait can take anywhere from under a second to more than fifteen seconds,
and there is no visual signal that anything is happening — users see a
greyed-out input box with no explanation and assume the plugin is
broken. In v0.8.0 the readiness gate was added to prevent tool-flakiness
on cold starts, but it introduced this visibility gap.

A second, related problem: some MCP servers legitimately take longer
than the current 15-second ceiling to authenticate. When they exceed
the ceiling, the agent session is created without their tools. The
tools do eventually reach a connected state at the MCP layer, but the
already-created session has no way to learn about them, so users must
reload the plugin (or start yet another new conversation) to actually
use those tools. That is a poor experience for exactly the servers that
need authentication.

This work closes both gaps with a single coherent flow. While the
readiness gate is waiting, the chat composer displays an inline pill
that tells the user which servers it is waiting on and why. Servers
that finish authenticating after the gate closes are picked up
automatically: the plugin observes the status change, refreshes the
live agent session's tool list, and shows a small confirmation. To make
the refresh possible without rebuilding the entire session (and losing
conversation state), we require an upstream SDK-level primitive that
lets a consumer update a live session's tool list in place — a small,
general-purpose addition that replaces today's reload-the-plugin
workaround.

The result is that adding a slow-auth server and starting a chat "just
works": the user sees clear progress, doesn't have to guess whether the
plugin hung, and gets the new server's tools as soon as authentication
completes — no plugin reload required.

## Objectives

- Make the readiness wait visible so users never see an unexplained disabled composer.
- Bound the readiness wait so that a slow server can never permanently block starting a chat.
- Automatically expose tools from late-arriving servers in already-open sessions, including the current one.
- Provide a general upstream SDK capability for live tool-list updates that other SDK consumers can use for the same problem.
- Keep the existing quick-path fast: no user visible slowdown when all servers are already connected.

## User Scenarios & Testing

### User Story P1 – First-time slow-auth user starts a chat

Narrative: A user has just added a new MCP server that requires
interactive authentication on first use. They open the chat view and
start a new conversation.

Independent Test: Fresh vault, no cached auth tokens, at least one
configured MCP server that will exceed the readiness ceiling. Open the
chat view, start a new conversation, observe composer state and elapsed
time until the input is usable.

Acceptance Scenarios:
1. Given the readiness gate is waiting, When the composer first renders, Then a status indicator is visible within 250 ms co-located with the disabled input, showing "Preparing MCP tools…" plus the name(s) of the server(s) being awaited.
2. Given the readiness gate is waiting, When the user hovers the indicator, Then supplementary text is exposed explaining that one or more MCP servers are still authenticating.
3. Given all servers reach a connected state within the 15-second ceiling, When the last one reaches connected, Then the indicator disappears within 250 ms and the composer becomes usable.
4. Given at least one server exceeds the 15-second ceiling, When the ceiling elapses, Then the composer becomes usable within 250 ms, the "Preparing" indicator is removed, and no new blocking indicator replaces it.

### User Story P2 – Slow-auth server connects after gate expiry

Narrative: A user has an existing chat session that was created after
the readiness gate expired on one of their MCP servers. The server
continues authenticating in the background. When it finishes and
reaches a connected state, the user expects its tools to become
available in the existing session without a plugin reload.

Independent Test: Chat session started while at least one MCP server is
still in a pre-connected state. Complete that server's authentication
flow externally. Confirm its tools become available in the existing
session without a plugin reload and without opening a new conversation.

Acceptance Scenarios:
1. Given an existing agent session created without server X's tools, When server X transitions to connected, Then the session's active tool list gains server X's tools within 2 seconds of the transition.
2. Given the tool list has been extended, When the extension completes, Then a non-blocking transient confirmation identifies which server's tools are now available.
3. Given an assistant response is streaming when server X connects, When the refresh fires, Then the current turn completes with its original tool list unchanged, and the new tools become available from the next user turn onwards.
4. Given multiple conversations are open, When server X connects, Then every open conversation's session gains server X's tools within 2 seconds of the transition.

### User Story P3 – Server disconnects or fails after being connected

Narrative: A previously-connected MCP server crashes, errors out, or is
disabled. The user expects the affected tools to disappear from live
sessions so the assistant does not attempt to call them.

Independent Test: Session running with server A connected. Force
server A into a non-connected terminal state. Confirm A's tools are
removed from the session within a bounded time.

Acceptance Scenarios:
1. Given server A is connected and its tools are in the session, When server A transitions to any non-connected state, Then the session's tool list is updated to exclude server A's tools within 2 seconds of the transition.
2. Given server A's tools have been removed, When a subsequent turn is issued, Then the model sees the reduced tool list — no stale references from server A remain.

### User Story P4 – SDK consumer needs the same primitive

Narrative: A consumer of the upstream Copilot SDK — this plugin or any
other — needs to update a live agent session's tool list without
recreating the session and without losing accumulated conversation
state. The SDK exposes a supported way to do this.

Independent Test: Written from the SDK side — a minimal SDK-level
scenario that creates a session with an initial tool list, updates the
tool list in place, and issues a subsequent turn that exercises a tool
from the updated list.

Acceptance Scenarios:
1. Given an active SDK session, When a consumer invokes the SDK's live-tool-list-update capability with a new tool list, Then the call completes successfully and the session's conversation state (prior messages, memory, model context) is preserved.
2. Given the update has completed, When the next turn is issued, Then the model is presented with exactly the updated tool list — additions are visible, removals are gone.
3. Given the update is invoked while a turn is streaming, When the update is processed, Then the in-flight turn completes with its original tool list unchanged and the update takes effect from the next turn onward.
4. Given documentation for the SDK's live-tool-list-update capability, When another consumer reads it, Then they can find: purpose, mid-turn behavior, error semantics, ordering guarantees between overlapping updates, and a minimal working example.

### Edge Cases

- All servers already connected at gate time: the indicator is not shown (or is shown for less than 250 ms); startup path exhibits no more than 100 ms of added delay from composer render to input-usable.
- Server toggles between connected and non-connected repeatedly: the plugin coalesces updates so the user sees at most one confirmation per server per 5-second window regardless of how many transitions occur.
- Session is destroyed (conversation deleted, plugin unloaded) while an in-flight tool refresh is pending: the refresh is safely abandoned without user-visible errors.
- The SDK's live-tool-list-update capability is not present in the installed SDK version: the plugin degrades to a strict no-op for the refresh path — the readiness indicator still functions, no crashes occur, and users see the pre-existing "reload to refresh" behavior unchanged.
- User adds a new server mid-session from settings: if the readiness gate is currently running, the new server appears in the indicator; if the gate has closed, reaching connected triggers the standard refresh flow.

## Requirements

### Functional Requirements

- FR-001: The chat composer MUST display a visible status indicator, co-located with the disabled input, within 250 ms of composer render whenever the readiness gate is actively waiting on one or more MCP servers. (Stories: P1)
- FR-002: The status indicator MUST identify which servers are being awaited, either always-visible or exposed on hover. (Stories: P1)
- FR-003: The readiness gate MUST retain a hard upper bound of 15 seconds after which the composer becomes usable regardless of any still-pending servers. (Stories: P1)
- FR-004: When any MCP server transitions to a connected state after its owning session was created, the plugin MUST update that session's live tool list to include the newly-available tools, and that update MUST take effect within 2 seconds of the transition. (Stories: P2)
- FR-005: The tool-list update MUST be applied to every currently-open agent session, not only the active one, within the same 2-second bound. (Stories: P2)
- FR-006: The tool-list update MUST NOT interrupt or corrupt an in-progress assistant turn; updates that arrive during a streaming turn take effect no later than the start of the next user turn. (Stories: P2)
- FR-007: When any MCP server transitions away from a connected state after its owning session was created, the plugin MUST update the session's live tool list to remove the now-unavailable tools within 2 seconds of the transition. (Stories: P3)
- FR-008: The plugin MUST show a non-blocking transient confirmation naming the affected server whenever tools are added to a session by an update. (Stories: P2)
- FR-009: The upstream Copilot SDK MUST expose a supported live-tool-list-update capability that allows a consumer to change an active session's tool list in place without recreating the session and without discarding accumulated conversation state. (Stories: P4)
- FR-010: The SDK's live-tool-list-update capability MUST be documented, covering purpose, mid-turn behavior, error semantics, ordering guarantees between overlapping updates, and a minimal working example. (Stories: P4)
- FR-011: If the SDK's live-tool-list-update capability is not present in the installed SDK version, the plugin MUST fall back to a strict no-op for the refresh path (recording an internal log entry) and the readiness indicator (FR-001) MUST still function. (Stories: P1, P2)
- FR-012: The plugin MUST coalesce rapid MCP status changes such that a single server produces at most one user-visible confirmation per 5-second window regardless of how many transitions occur in that window. (Stories: P2, P3)
- FR-013: On the fast path — all MCP servers already in a connected state at composer render — the added delay from composer render to input-usable MUST be at most 100 ms. (Stories: P1)

### Key Entities

- **MCP Server Status**: The lifecycle state of an individual configured MCP server. Connected is the sole "tools available" state; all other states are treated as "tools unavailable" for the purpose of session tool lists.
- **Agent Session**: A live SDK-level conversation with its own tool list. One per open plugin conversation.
- **Readiness Gate**: The mechanism that keeps the composer disabled until either all MCP servers reach a terminal state or the 15-second ceiling elapses.
- **Tool Refresh**: An operation that updates the tool list attached to a live agent session in response to an MCP status change.

### Cross-Cutting / Non-Functional

- On the fast path (all MCP servers already connected when the composer renders), the added delay from composer render to input-usable MUST be at most 100 ms.
- The tool refresh MUST complete within 2 seconds of the driving MCP status change (matches FR-004, FR-005, FR-007).
- Under a synthetic flapping scenario (transitions at least once per second for 30 seconds), the plugin MUST NOT enqueue an unbounded backlog of updates and MUST NOT emit more than one confirmation per server per 5-second window (matches FR-012).

## Success Criteria

- SC-001: On a fresh install with a newly-added slow-auth server, the readiness indicator is visible within 250 ms of the composer rendering, and it names at least one specific server being awaited. (FR-001, FR-002)
- SC-002: In 100% of measured cold-start scenarios (including ones where a server never connects), the chat composer becomes usable within 15.25 seconds of composer render — the 15-second gate ceiling plus a 250 ms UI settle. (FR-003)
- SC-003: When a slow-auth server reaches connected after gate expiry, its tools become usable in every already-open conversation within 2 seconds of the transition and without requiring a plugin reload. (FR-004, FR-005, FR-009)
- SC-004: When a previously-connected server transitions to any non-connected state, its tools disappear from every open session within 2 seconds of the transition. (FR-007, FR-009)
- SC-005: The SDK's live-tool-list-update capability has published documentation covering purpose, mid-turn behavior, error semantics, ordering guarantees between overlapping updates, and a minimal working example. (FR-010)
- SC-006: When the plugin runs against an SDK version predating the live-tool-list-update capability, the plugin loads without errors, the readiness indicator functions per SC-001 and SC-002, and no crashes are produced by the refresh code path. (FR-011)
- SC-007: Under the flapping scenario defined in Cross-Cutting NFRs (≥1 transition per second for 30 seconds on a single server), the user sees no more than 6 confirmations for that server (one per 5-second window). (FR-012)
- SC-008: On the fast path (all MCP servers connected when the composer renders), the added delay from render to input-usable is at most 100 ms as measured by wall-clock timing in an automated test. (FR-013)

## Assumptions

- The existing MCP status model is sufficient to drive both the indicator and the refresh; no new lifecycle states are required.
- The upstream Copilot SDK maintainers will accept a well-scoped PR adding the live-tool-list-update capability. If they push back on the shape during code review, we will adapt the plugin's caller accordingly rather than re-designing this work.
- Assistant turns that are mid-stream when tool changes arrive can safely finish with their originally-attached tool list; there is no requirement to hot-swap tools within a single turn.
- Users expect newly-connected servers to be reflected in currently-open conversations, not only in ones created after the connect event.
- A single non-blocking transient element per coalesced refresh is acceptable UX for the confirmation; users do not need per-tool granularity within the confirmation itself.
- Plugin-side changes may ship in a release prior to the upstream SDK adopting the new capability; the FR-011 fallback covers that release window.

## Scope

In Scope:
- Composer-level readiness indicator (design, integration, telemetry-free implementation).
- Automatic tool-list refresh on MCP status changes in all open sessions.
- Coalescing of rapid status changes to bound user-visible feedback.
- Upstream SDK contribution adding the live tool-list-update capability, plus adoption in this plugin behind a version-guard.
- Plugin-side graceful fallback when running against pre-primitive SDK versions.
- Test coverage for readiness-wait UX, refresh-on-connect, refresh-on-disconnect, coalescing, and fallback behavior.
- Documentation updates: README, CHANGELOG, and any user-facing troubleshooting text that today says "reload to see new tools".

Out of Scope:
- Redesigning the MCP status model or the readiness gate's timeout semantics beyond keeping the current 15s ceiling.
- Persistent auth token management or diagnostics (that's a separate follow-up already tracked).
- Multi-tenant / workspace-wide MCP status sharing.
- SDK changes beyond the single primitive needed for tool refresh (no incidental API cleanup, no unrelated deprecations).
- Reworking the "add server" flow in Settings.
- Changing what happens to tool-invocation results already in the conversation history when tools disappear (they remain in history as-is).

## Dependencies

- Upstream Copilot SDK maintainers' willingness to accept the live-tool-list-update capability.
- Existing plugin-level subscription API for MCP status changes.
- Existing per-conversation runtime plumbing that the refresh flow will hook into for cross-conversation updates.

## Risks & Mitigations

- Risk: SDK PR is delayed or rejected. Impact: refresh flow cannot ship as originally designed. Mitigation: implement the plugin subscription, coalescing, and indicator regardless; if the SDK capability is unavailable, the refresh path is a strict no-op per FR-011 and the visible improvement is at least the indicator. A session-recreation shim is explicitly out of scope for this workflow — introducing one would require re-planning.
- Risk: Live tool refresh causes model confusion mid-conversation. Impact: assistant misbehaves after a refresh. Mitigation: FR-006 requires updates to take effect only at turn boundaries, and FR-010 requires the SDK to document the exact semantics so consumers pick the right cadence.
- Risk: Rapid server flapping produces a spam of confirmations. Impact: bad UX and potential performance regression. Mitigation: FR-012 mandates coalescing to at most one confirmation per server per 5-second window, verified with a synthetic flapping test (SC-007).
- Risk: Indicator adds visible latency on the fast path. Impact: perceived startup regression. Mitigation: SC-008 sets an explicit 100 ms budget from render to input-usable on the fast path, measured in an automated test; if the budget is exceeded, the indicator is deferred behind a minimum-visible-duration threshold before it becomes visible.

## References

- Issue: none (internal follow-up from v0.8.0 release)
- Related proposal: proposals/0003-mcp-dynamic-tools.md (adjacent, precedes this work's scope)
- Related proposal: proposals/0005-mcp-slice7-followup.md
- Research: (to be created by paw-code-research)
