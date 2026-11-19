# Plan: Chat Steering and Queueing

## Goal

Let the user send messages while the agent is working, matching Copilot CLI and VS Code Copilot Chat:

| Action | Trigger (while a reply streams in this conversation) | SDK call |
|---|---|---|
| **Steer** (join the running turn; read before the next model request) | Enter, or menu → "Steer with message" | `session.send({ prompt, mode: "immediate" })` |
| **Queue** (run as a new turn after the current one) | Ctrl/Cmd+Enter, or menu → "Add to queue" | `session.send({ prompt, mode: "enqueue" })` |
| **Retract** an unread pending message | ArrowUp in an empty composer (restores text), or × on the pending row | `session.rpc.queue.withdrawMessage({ messageId, expectedPrompt })` |
| **Stop and send** | Menu → "Stop and send" | `abort()` then normal send |
| **Stop** (drops pending steer/queue, as CLI Ctrl+C does) | Stop button (unchanged) | `abort()` |

## Evidence (SDK 1.0.34)

- `MessageOptions.mode?: "enqueue" | "immediate"`: `node_modules/@github/copilot-sdk/dist/types.d.ts:3552-3556`. `send()` returns the user message ID: `dist/session.d.ts:160-161`.
- `user.message` carries `messageId` and `delivery: "idle" | "steering" | "queued"`: `dist/generated/session-events.d.ts:6224-6268, 763-771`.
- If an immediate message is not consumed before the turn ends, the SDK promotes it to the front of the queue as its own run. Queued runs drain before `session.idle` (SDK docs "steering-and-queueing").
- `queue.withdrawMessage`, `queue.pendingItems`: `dist/generated/rpc.d.ts:47209-47255, 29939-29965`. `session.rpc`: `dist/session.d.ts:108`.
- Today: the input is disabled for the whole turn (`src/ui/ChatView.ts:1316-1320`). Enter is inert while streaming (`src/ui/chatKeydown.ts:71-79`). There is one placeholder per turn (`src/ui/ChatView.ts:1056-1066`). The generator ends when `sendAndWait` settles (`src/sdk/AgentSession.ts:983-1013`).

## Key decisions

1. **The SDK owns delivery for both steer and queue.** There is no client-side queue. One stream generator observes the whole busy period, until `session.idle`, so steering messages promoted to their own run and queued runs both render live. This also avoids races between the runtime's queue and a client-side queue.
2. **Turn segmentation.** When a follow-up's `user.message` arrives, the current assistant bubble is finalized and the user bubble is inserted. A new assistant placeholder then continues the stream. If the current placeholder is still empty, it is converted into the user message instead, to avoid an empty bubble. Persistence already supports replacing `role`.
3. **Per-segment final content** keeps today's "prefer the SDK's final message over concatenated deltas" rule. Each segment uses the last root `assistant.message` content seen in it. With no follow-ups, behaviour is unchanged (the `sendAndWait` result).
4. **Tool-call ownership.** ChatView maps each tool-call ID to the segment placeholder where it first appeared. Later tool events and the final `toolCalls` merge land in that bubble.
5. **Pending messages** show in a strip above the composer, each with a × to withdraw. On Stop or error, pending messages are dropped, and a Notice reports how many.
6. **Follow-ups are only possible for the conversation that owns the live stream.** After a mid-stream conversation switch, Enter stays inert (as today).
7. New `AgentSession` methods are **optional** on the interface, so existing fakes keep compiling.

## Work items

1. **AgentSession follow-ups** (`src/sdk/AgentSession.ts`, tests in `AgentSession.test.ts`)
   - Extend `SdkSession` with `send`, `rpc.queue.withdrawMessage`, and `on` overloads for `user.message`, `assistant.message`, and `session.idle`.
   - `sendFollowUp(text, "steer" | "queue")` throws if no stream is active. `withdrawFollowUp(messageId)` returns whether the message was removed.
   - Generator: track follow-ups. Emit `{ type: "follow_up_consumed", messageId, text, mode, previousSegmentContent }`. After `sendAndWait` settles, keep waiting until no sends are in flight, nothing is unconsumed, and (if a follow-up started its own run) `session.idle` has been seen. Wake on timeout or cancel. On failure with pending follow-ups, abort so no orphan runs remain.
2. **Keydown policy** (`src/ui/chatKeydown.ts` + test): add the `steer`, `queue` and `retract` actions and the snapshot fields `modKey`, `canFollowUp`, `hasRetractable`.
3. **Segment helper** (`src/ui/followUpFlow.ts` + test): a pure `splitTurnAtFollowUp(state, placeholderId, text, previousSegmentContent)`.
4. **ChatView wiring** (`src/ui/ChatView.ts`, `styles.css`)
   - Keep the composer enabled while streaming.
   - Add the pending strip, the follow-up menu button (Obsidian `Menu`), steer/queue/retract/stop-and-send handlers, and segment-aware stream handling, persistence and tool ownership.
5. **Docs**: README section "Sending while the agent works". Update the v0.2 "Enter is inert" note and the `chatKeydown.ts` header comment.

## Verification

- `npm test`, `npx tsc --noEmit`, `npm run build`, then `npm run deploy`.
- Manual test in Obsidian:
  1. Steer mid-turn and check that the model adapts.
  2. Queue two messages; each runs as its own turn.
  3. Retract with ArrowUp and with ×.
  4. Stop drops pending messages.
  5. Stop and send.
  6. Reload Obsidian and check that the transcript order persists.
