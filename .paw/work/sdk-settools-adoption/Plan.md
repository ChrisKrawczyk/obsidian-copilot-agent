# Plan: SDK setTools Adoption

## Approach

SDK `@github/copilot-sdk@1.0.34` (pinned since v0.10.3) ships the experimental
`session.setTools(tools)`, the upstream resolution of github/copilot-sdk#1896.
`AgentSession` already has the detection and turn-boundary plumbing from MCP
Readiness UX, but it probes a never-shipped name (`updateTools`), so every
refresh falls through to the `resumeSession` swap stop-gap. Switch the probe
and call to `setTools`, delete the swap stop-gap, and refresh stale comments
and docs.

Verified headlessly against SDK 1.0.34 + CLI 1.0.112: `setTools` replaces the
client tool set in place, and the next turn uses the new handlers.

## Key decisions

- **Keep turn-boundary deferral.** The SDK docs say the new tool list can take
  effect mid-turn, and that the agent may still call a removed tool from an
  in-flight model request, failing with an error the model sees. They
  recommend replacing tools while idle. The existing `isStreamingFlag` /
  `pendingToolUpdate` latch already does this, so it stays.
- **Empty-list semantics.** `toolsForSession()` returns `undefined` when empty
  (createSession convention). `setTools` takes a non-null array, and `[]` means
  "remove all of this client's tools", which is the correct outcome when the
  merged list is empty. Pass `toolsForSession() ?? []`.
- **Failure semantics.** If `setTools` rejects, the SDK keeps the previous
  tools and handlers. We log a warning and do not retry; the next transition
  retries with a fresh snapshot. This preserves today's never-throw contract.
- **Remove the swap stop-gap entirely**: `canSwapForToolRefresh`,
  `swapSessionForToolRefresh`, `SdkClient.resumeSession`,
  `SdkResumeSessionOptions`, and their tests. The SDK is exact-pinned and
  always has `setTools`. The duck-typed check stays so test fakes and a
  pre-init session still report `false`.
- **Keep the FR-011 debug no-op** for sessions without the primitive
  (defensive; only reachable with fakes).
- **Keep the MCP readiness gate.** It still guarantees the *first* turn sees
  connected MCP tools. Its comments are updated, since tools are no longer
  frozen for the session lifetime. Removing the gate in favor of
  "create now, setTools later" is a possible follow-up, out of scope here.
- **No CHANGELOG edit.** Release tooling drafts it from the PR body.

## Work items

1. **adopt-settools**: `src/sdk/AgentSession.ts`
   - `hasLiveToolUpdateInternal()` → probe `setTools`.
   - `hasLiveToolUpdate()` → just the internal probe (drop swap OR-branch).
   - `applyToolListChange()` → call `session.setTools(this.toolsForSession() ?? [])`;
     warn text "SDK setTools threw"; drop swap branch.
   - Delete `canSwapForToolRefresh`, `swapSessionForToolRefresh`,
     `SdkClient.resumeSession`, `SdkResumeSessionOptions`.
   - Refresh JSDoc on the interface (`applyToolListChange`, `hasLiveToolUpdate`)
     and the `mcpReadinessGate` option comment.
2. **update-tests**: `src/sdk/AgentSession.test.ts`
   - Rename `updateTools` fakes → `setTools`; update the warn-string assertion.
   - Delete the "Phase 4.5: resumeSession swap stop-gap" describe block.
   - Add: empty merged tool list → `setTools([])` (not `undefined`).
   - Add: an `updateTools`-only session (legacy name) reports `false` and is not called.
   - `src/main.mcpToolRefresh.test.ts`: rename the SDK-1.0.0 wording only if needed.
3. **refresh-comments-docs**
   - `src/main.ts` toast-gating comments (≈L133, ≈L462).
   - `src/mcp/McpManager.ts` `waitUntilEnabledReady` comment (≈L252).
   - `src/settings/McpServersSection.ts` enable/disable Notice: drop the
     now-false "Start a new conversation…" instruction (toggles reach open
     conversations via watcher → `setTools`).
   - `README.md` v0.9 "Preserves conversation state" / "Forward-looking work" bullets.
   - `proposals/0003-mcp-dynamic-tools.md` status → Shipped; `proposals/README.md` row.
4. **verify**: `npm run typecheck`, `npm test`, `npm run build`, `npm run deploy`,
   manual Obsidian check (connect/toggle an MCP server mid-conversation → toast →
   tool usable without reload, conversation history intact).
