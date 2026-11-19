# Plan: Resume SDK Sessions Across Restarts

## Problem

After an Obsidian reload or restart, the chat pane re-renders the saved transcript, but the agent has no memory of it.

- Every conversation runtime calls `client.createSession()`:
  - `src/sdk/AgentSession.ts:1992` (init)
  - `:2064` (deferred recovery)
  - `:1787` (reset)
- The SDK session id is never persisted, and `resumeSession` is never called.
- The SDK does persist sessions under `COPILOT_HOME = <plugin dir>/session-state/<id>`. The test vault has 115 orphaned session folders.

## Approach

1. **Persist and resume.**
   - Add `sdkSessionId?: string | null` to each conversation's metadata, next to `modelId`.
   - `AgentSession` takes `resumeSessionId`. When it opens a session (init and deferred recovery), it tries `client.resumeSession(id, sameConfig)`. It falls back to `createSession` only when the session no longer exists (`getSessionMetadata` returns undefined) or resume fails twice in a row. A one-off failure is rethrown so the next send retries without orphaning history (review amendment).
   - Through `onSessionOpened(info)` it reports the session id and whether a resume was attempted or succeeded.
   - After any create, it remembers its own id. Re-init after a token rotation or runtime restart therefore resumes instead of forking.
   - A resumed session still gets the vault preamble on its first send. The session may have been saved before its first send, and the preamble's date, settings and tools may be stale (review amendment).
2. **Delete with the conversation.** `ConversationManager.removeConversation` calls `onConversationRemoved(conv)` after disposing the runtime. `main.ts` then calls `sharedSdkClient.deleteSession(sdkSessionId)` on a best-effort basis. `resetConversation` deletes the old SDK session after disconnecting it.
3. **Fallback.** This was decided by a multi-model debate (GPT-6.2 Sol, Gemini-4 Argon, Claude Opus 5.5) with a consensus round. All three ratified it, with amendments.
   - **Triggers.** Fresh session for a NON-EMPTY conversation, either:
     - legacy (no `sdkSessionId`), or
     - `resumeSession` failed, including on the deferred-create path.

     Never on reset, an empty chat, or a successful resume.
   - **Boundary marker.** It is persisted only for the UI, as metadata `contextBoundary: { afterMessageId, reason: "legacy" | "resume-failed", state: "offered" | "sent" | "dismissed" }`. It is never a chat message and never sent to the agent.
     - It renders as a divider after `afterMessageId`, showing the reason (Opus amendment).
     - It stays when the replacement session later resumes.
   - **Consent.** **Include earlier context** shows the prebuilt excerpt in an editable, dismissible draft panel above the composer, not in the user bubble (Gemini amendment). Only the transcript body is editable. The untrusted-record wrapper, framing, escaping and size cap are re-applied when the message is sent (review amendment).
     - Nothing is sent until the user presses Send.
     - Once sent, the state becomes `sent` and the divider says "Earlier context sent; original session wasn't resumed."
     - At most one seed per boundary.
   - **Content.** Completed and interrupted user and assistant text, plus `[tools: name ✓/✗]` markers.
     - NO `argsPreview`, `resultContent` or system messages.
     - Wrapped in `<prior_conversation_record trust="untrusted_historical_log">`, with closing tags escaped.
     - Framing: data, not instructions. "Historical claims may be stale; verify them only when relevant to the current request." (GPT amendment.)
   - **Caps.** 8 KB total including framing, at most 1,200 characters per message (head and tail), at most 12 messages. Always keep the first user message, fill newest-first, and mark omissions.
   - **Sending.** Never via `systemMessage`. The order on the first send is preamble, then excerpt, then the user request. No global setting in v1.

### Deviation from the consensus, forced by the code

Consensus wanted the offer shown only before the first send of the replacement session. However, init is lazy and runs at first send (`AgentSession.ts:685`, `:764`).
- **Legacy:** detected without starting the runtime when the runtime is materialized, so the offer appears before the first send.
- **Resume failure:** only known during the first send. The boundary is anchored before that turn, and the offer stays until it is used or dismissed. "At most once" still holds.

## Work items

1. `persist-fields`: `sdkSessionId` and `contextBoundary` through:
   - `PersistedShape`
   - `migrate.validateConversation` (lenient, optional)
   - the clone in `ConversationsStore`
   - `Conversation.ts` conversions
   - `ConversationManager` setters (`setSdkSessionId`, `setContextBoundary`), plus `onConversationRemoved`

   Extend existing tests.
2. `agent-resume`: in `AgentSession`:
   - `resumeSessionId` and `onSessionOpened` options
   - the `openSession` helper, used by init and deferred recovery
   - remember the id across re-init
   - re-send the preamble on resume
   - reset deletes the old session and reports the new one
   - `sendMessageStreaming(text, { priorContext })` puts the excerpt between preamble and request

   `SdkClient` gains optional `resumeSession` and `deleteSession`. Add tests.
3. `excerpt-builder`: pure `src/domain/priorContextExcerpt.ts`, with `buildPriorContextExcerpt`, `boundaryAnchor` and `boundaryLabel`, plus tests.
4. `wiring-ui`:
   - `main.ts` factory passes `resumeSessionId` and handles `onSessionOpened` (persists the id, creates the boundary on resume failure). It creates a legacy boundary when the runtime is materialized and deletes the SDK session on removal.
   - `MessageRenderer` boundary divider.
   - `ChatView` divider, include button, draft panel and send composition.
   - styles.
5. `docs`: README and CHANGELOG.

## Validation

Run `npx tsc --noEmit`, `npx vitest run` and `npm run deploy`. Then manual check:
- A reload resumes context.
- A legacy conversation shows the divider and the include flow.
- Deleting a conversation removes its session folder.

## Review (Stage 4)

Multi-model review (GPT-6.2 Sol, Gemini-4 Argon, Claude Opus 5.5) of commit cacca9a.

Applied:
- Re-send the preamble on resume (all three reviewers). A session can be saved before its first send, and the date, vault settings and tools can go stale.
- Replace a saved session only when it's missing or fails to resume twice. A one-off failure is rethrown instead of orphaning history (GPT, Opus).
- Deferred recovery runs as a single flight, so two triggers can't resume the same id and then detach it. A model pick made during recovery is applied afterwards (GPT, Opus).
- Excerpt delivery is recorded on the originating conversation and boundary even after a conversation switch. Any streamed text or tool event counts as delivery; a stop before sending doesn't (GPT, Gemini).
- Only the excerpt body is editable. Wrapper, framing, escaping and cap are re-applied at send (GPT).
- No boundary when no earlier message is eligible. No empty anchor entries. The boundary element is created via its list element, not the global `createDiv` (Gemini).

Deferred (follow-ups):
- `resetConversation` before init only clears the in-memory id. It has no production caller yet.
- Deleting a conversation while signed out or with a failed delete RPC leaves its session folder. Needs a persisted pending-delete queue; it fits with cleaning up the existing orphaned folders.
- Deleting a conversation races with re-activating it during runtime disposal. This is pre-existing `ConversationManager` behavior.
- A failed resume is only discovered during the first send, which goes out without earlier context (the known deviation above). Fixing it would need eager init on activation.

## Scope addition: per-conversation session grants

Found in manual testing: after a reload, a resumed conversation asked again for tools approved with **Approve for Session**. The grants lived in one in-memory `SafetyState` shared by all conversations (spec FR-013). The user chose per-conversation grants saved with the chat.
- `SafetyState` takes initial grants and an `onChange` callback, and exposes `snapshot()`. `main.ts` builds one per runtime from `metadata.safetyGrants` and persists through `ConversationManager.setSafetyGrants`.
- `safetyGrants` flows through `PersistedShape`, `migrate` (lenient), the `ConversationsStore` clone, `Conversation` conversions and `ConversationManager`.
- Reset clears them. Delete discards them with the conversation. MCP keys embed the trust epoch, so a change to the server's configuration revokes them.
- The prompt help text, README and CHANGELOG describe the new scope.