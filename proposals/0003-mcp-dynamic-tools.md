# 0003 — Mid-session MCP tool registry refresh

**Status:** Draft
**Created:** 2026-06-18
**Owner:** unassigned

## Problem

The Copilot SDK locks its tool list at `client.createSession()`. Today,
toggling an MCP server's enabled/disabled state, adding/removing a
server, or having a server's tool inventory change (`tools/list_changed`
notification) does not propagate to an already-open conversation.

Workarounds currently in place:

- A Notice on enable/disable that tells the user "Start a new
  conversation in the chat for the tool change to take effect."
- A stronger error from the tool bridge ("Do not retry — inform the
  user") when the model tries an unavailable tool.

These mitigate the symptom but don't fix the root cause. The model
still hallucinates the tool exists and a user has to manually start a
new conversation, losing context.

## Sketch

Two viable directions, depending on SDK capabilities:

### A) Recreate the SDK session in place, preserving messages

- On MCP toggle, capture the conversation's message history.
- Tear down the SDK session, build a fresh one with the new tool list.
- Replay the message history into the new session (if the SDK supports
  hydration), or just keep the UI history visible while the underlying
  context window restarts from scratch.
- UX caveat: model loses internal scratchpad / partial reasoning. Show a
  small inline notice in chat ("Tool list updated; the assistant has a
  fresh context window") so behavior changes are explainable.

### B) Notify the SDK of tool deltas without recreating the session

- Requires SDK-level support for runtime tool registration. Last we
  checked, `@github/copilot-sdk` does not expose this. Verify before
  pursuing.
- Cleanest UX if available — model would see tool list updates the same
  way it sees `tools/list_changed` on an MCP server.

### C) Stop locking tools at session creation in our wrapper

- Investigate whether `AgentSession.toolsForSession()` is called per-turn
  or once per session. Currently it's once at `createSession`. If the
  SDK consults its tool list on every turn, we may be able to update
  ours and have the SDK re-export.

## Risks

- **(A) Context loss.** Recreating the session wipes model memory. A
  user mid-debug-session would be surprised. Need clear inline UX.
- **(B) SDK dependency.** Bets on a feature that may not land soon.
- **Tool ID stability.** If we restart with a different synthetic ID for
  the same MCP tool (server renamed, etc.), historical tool calls in
  the transcript become orphaned. Keep synthetic IDs stable across
  refreshes.

## Open questions

- What does `@github/copilot-sdk` actually do with `tools` after
  `createSession`? Does it consult them per turn or freeze them?
- Can we get a `replayHistory()` or equivalent on the SDK session, or
  do we need to re-`sendMessage` each prior user turn (expensive,
  changes model behavior)?
- Should mid-session MCP changes be DISABLED entirely until this lands,
  with a clear "you must end this conversation to change MCP servers"
  modal? Less surprising than the current silent-no-op.

## References

- Today's mitigation: `setEnabled` Notice in
  `src/settings/McpServersSection.ts`
- Tool bridge error message: `src/mcp/McpToolBridge.ts`
- Session creation: `src/sdk/AgentSession.ts` (`createSession` call,
  `toolsForSession`)
- Precedent: `exposeRawFsToolsAtStartup` has the same "next session
  start" semantic for built-in tools (see FR-015).
