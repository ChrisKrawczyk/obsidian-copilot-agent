# MCP Readiness UX Implementation Plan

## Overview

Deliver the three v0.8.0 follow-ups from Spec.md as a coherent flow: an
inline readiness indicator in the chat composer, an automatic
live-tool-refresh path that picks up MCP servers after they finish
authenticating, and the upstream Copilot SDK primitive that makes the
refresh possible without recreating agent sessions. Plugin-side changes
are structured so that they can ship independently of the upstream SDK
merge cadence — the refresh path falls back to a strict no-op when
running against an SDK version that lacks the primitive, preserving
today's "reload to see new tools" behavior verbatim while still
delivering the visible indicator win.

## Current State Analysis

- The readiness gate exists: `McpManager.waitUntilEnabledReady(timeoutMs)`
  waits until every enabled server is in `connected` / `error` /
  `crashloop` / `disabled`, or resolves on timeout
  (`src/mcp/McpManager.ts:268-313`).
- Only three sites gate on it, all inside `AgentSession.doInit` /
  `resetConversation` / `tryRecoverDeferred`
  (`src/sdk/AgentSession.ts:1196-1204`, `1381-1389`, `1453-1461`). The
  gate is invoked with a fixed `15_000` ceiling from `main.ts:625-635`.
- Composer disable logic is in `ChatView.setBusy` and `renderAuth`
  (`src/ui/ChatView.ts:1082-1093`, `685-692`). `pending` / `streaming`
  are per-view fields that do not reset on `active-changed`; the manager
  subscription only rebinds runtime references
  (`src/ui/ChatView.ts:459-480`, `104-112`).
- Runtimes are created lazily on first `getActiveRuntime()`
  (`src/domain/ConversationManager.ts:288-297`, `574-590`). All live
  runtimes are tracked in `main.ts` via
  `liveRuntimes = new Set<{ session, conversationId }>()`
  (`src/main.ts:329-332`), and an established broadcast pattern iterates
  that set for token push and reconnect
  (`src/main.ts:784-803`, `804-825`).
- The installed SDK (`@github/copilot-sdk` `1.0.0`) exposes
  `send`, `sendAndWait`, `on`, `getEvents`, `disconnect`, `abort`,
  `setModel`, and `log`, but no public method for updating an active
  session's tool list
  (`node_modules/@github/copilot-sdk/dist/session.d.ts:33-290`,
  `package.json:33-35`). RPC-layer `session.options.update` exists with
  `availableTools`/`excludedTools`/`toolFilterPrecedence` but no wrapper
  covers replacing the `tools?: Tool[]` array
  (`node_modules/@github/copilot-sdk/dist/generated/rpc.d.ts:8088-8124`).
- `Notice` is imported and used throughout (`src/ui/ChatView.ts:1-6`).
  Existing debounce is `setTimeout`-based, not lodash/Obsidian
  (`src/persistence/ConversationsStore.ts:437-453`,
  `src/main.ts:162-184`).
- Test framework is Vitest with `src/**/*.test.ts` and an Obsidian mock
  alias (`vitest.config.ts:4-18`). `waitUntilEnabledReady` has existing
  tests (`src/mcp/McpManager.test.ts:110-193`).

## Desired End State

- The chat composer shows a visible pill co-located with the input
  within 250 ms of render whenever the readiness gate is waiting; the
  pill names the pending servers and disappears when the gate resolves.
  Fast path adds ≤ 100 ms; hard ceiling ≤ 15.25 s.
- When any MCP server transitions to `connected` after its owning
  session was created, tools from that server become usable in every
  currently-open conversation within 2 s, without a plugin reload,
  without recreating the session, and without interrupting an in-flight
  turn. A subtle transient Notice confirms the change once per server
  per 5 s window.
- The same flow applies in reverse for disconnect / error / crashloop /
  disabled transitions.
- An upstream `@github/copilot-sdk` contribution adds a supported
  primitive for updating a live session's tool list; the plugin adopts
  it behind a version-guarded feature-detection so that older SDK
  versions still load without crashes and simply skip the refresh (FR-011).
- Docs (Docs.md + README + CHANGELOG) describe the indicator, the
  refresh flow, and the SDK primitive.

Verification: automated Vitest suite covering the coalescing watcher,
the ChatView pill state machine, the plugin's refresh method and its
no-op fallback, plus manual smoke steps for the observed slow-auth
server scenarios documented in Spec.md P1/P2/P3.

## What We're NOT Doing

- Changing the MCP status model (no new lifecycle states).
- Changing the readiness gate's 15 s ceiling or its timeout semantics.
- Introducing a session-recreation shim as a fallback for missing SDK
  primitives — the fallback is a strict no-op with log; a shim would
  require re-planning.
- Persistent auth token diagnostics or refresh handling (tracked
  separately).
- Multi-tenant or workspace-wide MCP status sharing.
- Reworking the settings "add server" flow.
- Mutating conversation history when tools disappear (past tool call
  entries remain in place).
- Blocking plugin release on upstream SDK merge cadence — Phases 1-3
  and 6 can ship as a plugin release with the no-op fallback engaged;
  Phase 5 lands in a subsequent release once Phase 4 merges.

## Phase Status

- [x] **Phase 1: MCP status watcher (pure module)** — Depends on: nothing. Coalescing, per-server debounce, subscribe/unsubscribe surface for Phase 2 and Phase 3 to consume.
- [x] **Phase 2: Readiness indicator in ChatView** — Depends on: Phase 1. Inline pill, fast-path guard, gate-lifecycle state machine, event bridge from `AgentSession` to `ChatView`.
- [x] **Phase 3: Plugin refresh flow with SDK-feature-detect fallback** — Depends on: Phase 1. Broadcast to all live runtimes, turn-boundary queueing (last-write-wins), Notice toast, strict no-op path.
- [ ] **Phase 4: Upstream SDK contribution** — Depends on: nothing in this repo (external). PR to `github/copilot-sdk` adding a live tool-list update primitive plus docs.
- [ ] **Phase 5: SDK adoption in plugin** — Depends on: Phase 4 published to npm. Bump `@github/copilot-sdk`, wire the real primitive in the refresh method, remove the no-op branch (or leave it behind a version guard).
- [ ] **Phase 6: Documentation** — Depends on: Phases 1-3 (minimum) or Phases 1-5 (full). Docs.md + README section + CHANGELOG entry.

## Phase Candidates

<!-- None at plan time. If Phase 4 review surfaces API-shape variants,
     they will be added here as unresolved candidates for the promotion
     flow. -->

---

## Phase 1: MCP status watcher (pure module)

**Depends on**: nothing (leaf).

**Consumers**: Phase 2 (indicator uses `snapshotPending()`), Phase 3 (refresh uses the fast emission surface + notice throttle).

### Changes Required:

- **New: `src/mcp/McpStatusWatcher.ts`**: Pure module that:
  - Takes a `McpManager` and an injectable clock/timer pair (for
    testability, mirroring `ConversationsStore`'s pattern at
    `src/persistence/ConversationsStore.ts:437-453`).
  - Subscribes to `McpManager.subscribe(fn)` and computes per-server
    diffs by comparing consecutive `statusSnapshot()` results, driven
    by the `isTerminal` classification already documented at
    `src/mcp/McpManager.ts:269-273`.
  - **Exposes TWO independent emission surfaces** (the design fix
    called out by plan review — the FR-004/005/007 2 s refresh path
    must not inherit FR-012's 5 s coalescing which applies only to
    user-visible notices):
    1. **`onTransition(listener)` — leading-edge, no debounce**: fires
       synchronously (or on the next microtask) on every observed
       terminal-status transition. Payload: `{ serverId, kind: "connected" | "disconnected" }`.
       Latency budget: ≤ 200 ms from the source `emit()` on
       `McpManager` (`src/mcp/McpManager.ts:743-749`), which gives
       Phase 3 headroom to complete its dispatch within the 2 s
       bound.
    2. **`onNotice(listener)` — trailing-edge, 5 s per-server window**:
       fires at most once per serverId per 5 s window. If multiple
       transitions arrive inside the window, the terminal state at
       window close wins.
  - Exposes `snapshotPending(): { id: string; state: "connecting" | "reconnecting" | "disconnected" | "no-runtime-yet" }[]`.
    **Includes enabled servers that have no runtime snapshot at all
    yet** (the case where `getOrCreate` has not fired — Phase 2 needs
    these to correctly name the servers the gate is waiting on for
    FR-002). Derivation:
    `serversProvider().filter(c => c.enabled)` cross-referenced with
    `statusSnapshot()` map (`src/mcp/McpManager.ts:274-293`).
  - Handles server list mutation (add/remove servers) — removed
    servers are silently dropped from any pending 5 s window; added
    servers get a fresh window.
  - Provides `disposeAll()` that clears pending timers and
    unsubscribes.

- **Tests: `src/mcp/McpStatusWatcher.test.ts`** (new): Uses Vitest fake
  timers per existing MCP tests (`src/mcp/McpReconnectPolicy.test.ts:66-88`).
  - **Latency**: single connect transition fires `onTransition` within
    the ≤ 200 ms budget (measured via fake timers).
  - **Coalescing**: 30 flips over 30 s on one server → `onTransition`
    fires 30 times, `onNotice` fires ≤ 6 times (SC-007). Verifies the
    two surfaces are independent.
  - `snapshotPending()` includes enabled-but-runtime-less servers
    (FR-002 coverage).
  - Fresh connect / fresh disconnect emit correct payloads on both
    surfaces (notice after window close).
  - Adding/removing a server does not fire spurious events for
    unrelated servers.
  - `disposeAll()` clears pending timers and unsubscribes.

### Success Criteria:

#### Automated Verification:
- [ ] Tests pass: `npm test -- src/mcp/McpStatusWatcher.test.ts`
- [ ] Typecheck: `npm run typecheck`

#### Manual Verification:
- [ ] Reading the module shows no `Notice` / DOM / UI imports (pure module).
- [ ] Two-surface design is present and documented in the module's header comment.
- [ ] Follows the existing debounce pattern in `ConversationsStore` (setTimeout-based, no external debounce dependency).

---

## Phase 2: Readiness indicator in ChatView

**Depends on**: Phase 1 (uses `snapshotPending()` from `McpStatusWatcher`).

### Changes Required:

- **`src/sdk/AgentSession.ts`**: Add optional callback
  `onReadinessGateEvent?: (evt: "start" | "resolved") => void`
  to `AgentSessionOptions` alongside `mcpReadinessGate`
  (`src/sdk/AgentSession.ts:131-151`). `awaitMcpReadinessGate` fires
  `start` before awaiting and `resolved` when the gate promise
  fulfills. Because `McpManager.waitUntilEnabledReady` already
  encapsulates the 15 s timeout and resolves silently in either the
  all-connected or timed-out outcome (`src/mcp/McpManager.ts:268-313`),
  the SDK layer does not need to distinguish those cases at the event
  boundary — the pill removes on `resolved` regardless of cause
  (Spec P1 scenario 4). No `Promise.race` wrapper is introduced
  (planning-docs review S6 — the wrapper would duplicate the
  manager's own timeout).

- **`src/sdk/AgentSession.ts` — synchronous state getter**: Expose
  `isReadinessGateWaiting(): boolean` as a read-only accessor on
  `AgentSession`. It flips to `true` inside `awaitMcpReadinessGate`
  immediately before the `start` event and back to `false` when the
  gate resolves (or when the session is disposed). This is the hook
  `ChatView.bindActiveRuntime` interrogates on conversation switch
  so the pill correctly initializes when the user activates a
  conversation whose gate is already in progress (planning-docs
  review S2 — transient `start` events would otherwise be missed on
  late-bound observers).

- **`src/main.ts` — event bridge**: The wiring channel from
  session-level events to `ChatView` (called out by plan review):
  each `CopilotAgentSession` in `runtimeFactory`
  (`src/main.ts:695-724`) receives an `onReadinessGateEvent`
  callback that forwards to a single new plugin-scope
  `ReadinessGateBus` (a tiny EventEmitter created in `main.ts` and
  passed via `ChatViewDeps`). Payload includes the `conversationId`
  so `ChatView` can filter to its bound conversation. This mirrors
  how `liveRuntimes` (`src/main.ts:329-332`) already fans out
  session events to plugin-scope handlers.

- **`src/main.ts`**: Instantiate `McpStatusWatcher` alongside the
  existing `McpManager` and pass its `snapshotPending()` accessor
  and the `ReadinessGateBus` down into `ChatViewDeps`. Wire it near
  where `mcpReadinessGate` is wired
  (`src/main.ts:625-635`, `695-724`).

- **`src/ui/ChatView.ts`**:
  - Add a new UI element inside the composer container, adjacent to
    the input, that renders "Preparing MCP tools…" plus a comma-joined
    display-name list of pending server ids from `snapshotPending()`.
    Style follows the existing auth pill patterns near `renderAuth`
    (`src/ui/ChatView.ts:685-724`). The pill element MUST carry a
    tooltip (accessible `title` attribute plus `aria-describedby`
    where feasible) with copy along the lines of
    "One or more MCP servers are still authenticating and will
    provide tools once ready." This satisfies Spec P1 AC2
    (planning-docs review S5).
  - Subscribe to the `ReadinessGateBus` in `onOpen()`, filtered by
    `boundConversationId` (`src/ui/ChatView.ts:198-207`). Introduce
    a `ReadinessGateState` field: `pending | idle`. Bus `start`
    events flip to `pending`; `resolved` events flip to `idle`
    (both the "all connected" and the "timed out" outcomes surface
    as `resolved` — see AgentSession bullet above). In `idle` state
    the pill is removed and no new blocking indicator replaces it
    (spec P1 scenario 4).
  - On `bindActiveRuntime`, interrogate
    `activeRuntime.session.isReadinessGateWaiting()` synchronously
    and seed `ReadinessGateState` to `pending` when it returns true
    (planning-docs review S2). Bus subscription then handles
    subsequent transitions. Without this seed, activating a
    conversation whose gate is already in progress would miss the
    `start` event and never render the pill.
  - **Fast-path guard (measured from composer render)**: To satisfy
    Spec FR-013 / SC-008 (render→input-usable ≤ 100 ms), capture the
    composer render timestamp in `onOpen()` and, on `start`, check
    whether the gate is expected to resolve within
    `100 - (now - renderTs)` ms. If so, arm a `setTimeout(showPill, remaining)`
    and cancel on `resolved` inside the window. The wall-clock
    origin used for SC-008 is composer render, not gate-start
    (planning-docs review C1 / F1 — earlier wording anchored the
    100 ms at gate-start, which is not the same instant as render
    given lazy `init()`). For the guarantee that gate-start is
    observable at bind time, the synchronous
    `isReadinessGateWaiting()` seed above closes the gap: bind sees
    an in-progress gate immediately even if no `start` event has
    yet been dispatched to this ChatView instance.
  - Manager subscription updates the pill on `active-changed` since
    each conversation has its own runtime and gate cycle
    (`src/ui/ChatView.ts:459-480`).
  - Extend `setBusy()`/`refreshSendGate()` awareness so the pill
    coexists with existing disabled/streaming states without visual
    conflict (`src/ui/ChatView.ts:1082-1093`, `542-580`).

- **Tests: `src/ui/ChatView.test.ts`** (**new file** — the existing
  test coverage is `src/ui/ChatView.modelPick.test.ts` only; a
  general suite does not yet exist):
  Verify pill appears/disappears on the two gate transitions
  (`start`, `resolved`); tooltip/help text is present on the pill
  element (planning-docs S5); fast-path guard suppresses < 100 ms
  flashes measured from **composer render** with fake timers
  (SC-008 wall-clock automated assertion — planning-docs C1/F4);
  the 15.25 s ceiling is respected in a fake-timer scenario where
  the gate times out (SC-002 automated verification — planning-docs
  S4); `bindActiveRuntime` seeds `pending` state when
  `isReadinessGateWaiting()` returns true (planning-docs S2);
  per-conversation state is preserved across active-changed events;
  and no regressions in existing setBusy/streaming disabled logic.

- **Tests: `src/sdk/AgentSession.test.ts`** (extend existing file at
  `src/sdk/AgentSession.test.ts:23-50`): Verify `onReadinessGateEvent`
  fires in the correct order (`start` before `resolved`, exactly
  once per event kind per session) for `doInit`,
  `resetConversation`, and `tryRecoverDeferred` paths.
  `isReadinessGateWaiting()` returns `true` between the internal
  `start` dispatch and gate resolution, `false` at all other times
  including before init and after dispose.

### Success Criteria:

#### Automated Verification:
- [ ] Tests pass: `npm test`
- [ ] Typecheck: `npm run typecheck`
- [ ] Build: `npm run build`
- [ ] Wall-clock timing test asserts render→input-usable ≤ 100 ms on the fast path (SC-008 — planning-docs C1/F4).
- [ ] Fake-timer test asserts composer becomes usable within 15.25 s when gate hits ceiling (SC-002 — planning-docs S4).

#### Manual Verification:
- [ ] Fresh vault, slow-auth server configured: pill visible within 250 ms of chat view render, names the server, disappears when server connects. Hovering the pill shows explanatory tooltip (P1 AC2 / planning-docs S5).
- [ ] Fast path with all servers pre-connected: no visible pill flash on cold start (verify by log-instrumenting the fast-path suppression).
- [ ] Gate timeout (server never connects): composer becomes usable after ceiling; no leftover blocking indicator.
- [ ] Switching active conversation while a gate is pending: pill state reflects the new conversation's gate, not the previous one (verified via `isReadinessGateWaiting()` seed on `bindActiveRuntime`).

---

## Phase 3: Plugin refresh flow with SDK-feature-detect fallback

**Depends on**: Phase 1 (subscribes to `onTransition` for the refresh dispatch and `onNotice` for the toast).

**Deferred verification**: End-to-end verification of FR-004 / FR-005 / FR-007 (real tools actually appearing in the model's tool list) is deferred to Phase 5, because Phase 3 lands behind the FR-011 no-op fallback until the SDK primitive is available. Phase 3's own success criteria therefore assert **dispatch correctness** (the right calls are made against every live runtime, coalescing operates as specified), not end-to-end tool-list mutation.

### Changes Required:

- **`src/sdk/AgentSession.ts`**:
  - Expose an internal read-only `isStreaming` flag on `AgentSession`
    (set to `true` inside `sendMessageStreaming` at
    `src/sdk/AgentSession.ts:690-692` before iterating, cleared in
    the finally/completion path). This is the exact hook Phase 3
    reads for turn-boundary queueing (called out by plan review — the
    prior "or equivalent existing state" wording was under-specified).
  - Add a new public method `applyToolListChange(): Promise<void>`
    (**no arguments** — planning-docs review S1: passing an
    externally-computed MCP-only list would overwrite the session's
    conversation-specific custom tools merged inside
    `toolsForSession()` at `src/sdk/AgentSession.ts:1129-1140`). The
    method:
    1. Guards against `this.session` being undefined — early-returns
       if the session has not yet been created (transition arrived
       during a pre-`doInit` window). No error, no log spam.
    2. Builds the current combined tool list internally by calling
       `this.toolsForSession()`, which merges the live `mcpTools()`
       snapshot with the session's own custom/built-in tools. This
       preserves per-session tool composition across refreshes.
    3. Feature-detects whether `this.session` exposes a live update
       capability. Detection is a duck-type check for a well-known
       method name matching the primitive to be added in Phase 4
       (e.g., `if (typeof (this.session as any).updateTools ===
       "function")`). This lookup MUST be centralized in a single
       private helper (`private hasLiveToolUpdate(): boolean`) so
       Phase 5 can flip it to a real typed import in one place. The
       helper is also exposed to the plugin scope via
       `AgentSession.hasLiveToolUpdate()` (public read-only proxy)
       so `main.ts` can gate the "tools now available" Notice on it
       (planning-docs S3).
    4. If the capability is present, calls it with the internally
       built tool list.
    5. If the capability is absent, logs once at debug level via
       `this.opts.log` (following the existing pattern) and returns —
       strict no-op (FR-011). Subsequent calls in the same session do
       not re-log.
    6. **Turn-boundary queueing with last-write-wins**: maintains a
       single `pendingToolUpdate: true | false` slot on the session
       (a boolean latch — the tool list is always rebuilt at drain
       time from the live `mcpTools()` snapshot, so no payload
       queueing is needed). If `isStreaming` is true, set the latch
       and return; on stream completion, if the latch is set, rebuild
       and apply. If `isStreaming` is false, apply immediately.
  - Ensure disposal path (`stopRuntime()` / `dispose()`) clears
    `pendingToolUpdate` and cancels any in-flight drain to avoid
    calling into a disposed session
    (`src/sdk/AgentSession.ts:1295-1303`).

- **`src/main.ts`**:
  - Instantiate `McpStatusWatcher` (Phase 1) and subscribe to both
    surfaces:
    - **`onTransition`** (fast, no-debounce): iterate `liveRuntimes`
      (`src/main.ts:784-803`, `804-825`) and invoke
      `session.applyToolListChange()` (no arguments — the session
      rebuilds its own list internally, per S1 above) on each. This
      is the 2-second-bound path (FR-004 / FR-005 / FR-007).
      **Metadata-only conversations** (open in the picker but whose
      runtime has not yet been instantiated via
      `ConversationManager.getActiveRuntime()`) are *not* iterated
      here; they acquire the new tool set on their next
      `createSession()` because `toolsForSession()` reads the live
      `mcpTools()` snapshot at that time
      (`CodeResearch.md:197`). This semantic satisfies FR-005 for
      both instantiated and lazy conversations — the plan-side
      dispatch handles the former; SDK-side snapshot capture
      handles the latter (planning-docs review C2).
    - **`onNotice`** (5 s coalesced): show a single
      `new Notice("Tools from <serverName> are now available", 4000)`
      per connect emission, **but only when at least one live
      runtime returns `session.hasLiveToolUpdate() === true`**. If
      the SDK primitive is unavailable on all live runtimes
      (Phase 3 with SDK 1.0.0), suppress the toast entirely because
      tools are not actually available until reload / new
      conversation (planning-docs S3 — FR-011 strict no-op).
      Durations match existing informational Notices at
      `src/ui/ChatView.ts:483-490`. Do not toast on disconnect
      (silent removal).
  - Register the watcher's `disposeAll()` in the plugin's
    `onunload()` alongside other teardown hooks.

- **Tests: `src/sdk/AgentSession.test.ts`** (extend existing file):
  - `applyToolListChange` no-ops when session has no update method
    (fallback branch, log recorded, no throw).
  - `applyToolListChange` no-ops silently when `this.session` is
    undefined (pre-init edge case).
  - `applyToolListChange` calls the session's update method with the
    list produced by `toolsForSession()` (verify with a fake SDK
    session exposing an `updateTools` stub and a spy on
    `toolsForSession`). Confirms MCP + custom tools are merged
    (planning-docs S1 — regression guard against MCP-only overwrite).
  - **Turn-boundary last-write-wins**: two calls arriving mid-stream
    result in exactly one drain that rebuilds tools from the current
    `mcpTools()` snapshot; verified by counting `toolsForSession`
    invocations and asserting drain uses the latest snapshot.
  - Call arriving when idle is applied immediately.
  - Disposal drops any pending call and prevents post-dispose SDK
    invocation.
  - `hasLiveToolUpdate()` returns `false` on a fake session without
    the primitive, `true` on one that exposes `updateTools`.

- **Tests: `src/main.integration.test.ts`** (or nearest existing
  integration point — check `src/main.integration*.ts` glob first,
  otherwise create a new one):
  - `onTransition` connect emission triggers `applyToolListChange`
    on every entry in `liveRuntimes`, not only the active one
    (FR-005 dispatch coverage).
  - `onTransition` disconnect emission triggers refresh with the
    reduced tool list (FR-007 dispatch coverage).
  - `onNotice` fires exactly once per server per 5 s window under a
    flapping harness (FR-012 / SC-007). `onTransition` fires on
    every flip (independence verified).
  - **Toast gating**: `onNotice` connect with all live runtimes
    reporting `hasLiveToolUpdate() === false` (SDK 1.0.0 fallback)
    produces **zero** `Notice` calls; the same emission with at
    least one runtime returning `true` produces exactly one Notice
    (planning-docs S3 / FR-011).

### Success Criteria:

#### Automated Verification:
- [ ] Tests pass: `npm test`
- [ ] Typecheck: `npm run typecheck`
- [ ] Build: `npm run build`

#### Manual Verification:
- [ ] With current SDK 1.0.0 installed (no update primitive): plugin loads without errors; after a slow-auth server connects, the internal log records the no-op fallback; **no "Tools now available" toast is shown** (planning-docs S3 — toast gated on `hasLiveToolUpdate`); user still sees the pre-existing "reload to see new tools" behavior — no regression.
- [ ] Flapping server (repeatedly toggled in settings): at most 1 Notice per server per 5 s window regardless of flip rate (only when `hasLiveToolUpdate` is true); `applyToolListChange` dispatch count matches transition count (verified via a log-tap or spied test double).
- [ ] Multi-conversation open: refresh call is dispatched to every entry in `liveRuntimes`, not only the active one. Conversations that are open in the picker but have not been activated (no live runtime) will pick up the new tools on their next activation via `toolsForSession()`.
- [ ] Note: FR-004 / FR-005 / FR-007 end-to-end (tools actually appearing in the model's tool list) verification is deferred to Phase 5.

---

## Phase 4: Upstream SDK contribution

### Changes Required:

- **External repo `github/copilot-sdk`** (not this repo):
  - Add a new public method on `CopilotSession` (`session.d.ts`) named
    `updateTools(tools: Tool[]): Promise<void>` (final name subject
    to maintainer review — Phase 5 adopts whatever name lands). The
    method:
    1. Replaces the session's active custom tool list in place
       without terminating conversation state.
    2. Takes effect from the next user turn onward when called mid-stream (Spec P4 scenario 3).
    3. Documents ordering: if multiple calls are in flight, the last-committed one wins.
    4. Documents error semantics: rejects if the session is disconnected; otherwise resolves once the new list has been applied.
  - Implementation likely wraps the existing RPC-level
    `session.options.update` capability
    (`node_modules/@github/copilot-sdk/dist/generated/rpc.d.ts:8088-8124`)
    plus a companion RPC or extension for replacing the custom
    `tools?: Tool[]` array. Exact wiring is a maintainer decision.
  - SDK-side tests covering: post-update turn sees new list; mid-stream call takes effect next turn; ordering guarantee under overlapping calls; error path on disconnected session.
  - README docs entry with purpose, mid-turn behavior, error
    semantics, ordering guarantees, and a minimal working example.
- **This repo**: no code changes in Phase 4 itself. The PR link is
  recorded in Docs.md (Phase 6).

### Success Criteria:

#### Automated Verification:
- [ ] SDK PR CI green.

#### Manual Verification:
- [ ] SDK PR approved and merged by maintainers.
- [ ] SDK published to npm at a new minor/patch version containing the primitive.
- [ ] Published docs cover purpose, mid-turn behavior, error semantics, ordering, and a minimal example (SC-005 / FR-010).

**Blockability note**: This phase is external. If maintainer review
exceeds a reasonable window (e.g., > 4 weeks) or the API shape needs
substantive redesign, the plan yields Phases 1-3 + 6 as a plugin
release and re-enters Phase 4/5 as a follow-up workflow. That
decision is a human call, not automated.

---

## Phase 5: SDK adoption in plugin

**Depends on**: Phase 4 (upstream SDK PR merged and a new SDK version published to npm containing the primitive).

### Changes Required:

- **`package.json`**: Bump `@github/copilot-sdk` to the minimum
  version that contains the new primitive (`package.json:33-35`).
- **`src/sdk/AgentSession.ts`**: In the feature-detect helper added
  in Phase 3 (`hasLiveToolUpdate()`), replace the duck-typed lookup
  with a typed reference to the SDK's now-exported primitive.
  Retain the `typeof method === "function"` guard as a
  defense-in-depth for users on older SDK builds, gated by SDK
  version at compile time.
- **Types**: Update any local structural SDK types
  (`src/sdk/AgentSession.ts:164-176`) to include the new method
  signature so `tsc --noEmit` catches drift.
- **Tests**: Replace the fake-SDK stub for `updateTools` with the
  real SDK import. Add coverage for:
  - **Connect path**: connected-after-init server causes tools to
    appear in the next turn against a real SDK session (SC-003).
  - **Disconnect path**: disconnecting a previously-connected server
    causes its tools to disappear within 2 s (SC-004). Called out
    by plan review — Phase 3's tests only cover dispatch, not
    end-to-end removal.
  - **Multi-conversation propagation**: with two open conversations,
    a server connect causes both sessions to see the new tool list
    on their next respective turns (SC-003 across all live
    runtimes, FR-005).
  - **Mid-stream connect**: in-flight turn completes with its
    original tool list; next turn sees the new tools (P2 scenario 3,
    FR-006).

### Success Criteria:

#### Automated Verification:
- [ ] Tests pass: `npm test`
- [ ] Typecheck: `npm run typecheck`
- [ ] Build: `npm run build`
- [ ] `npm ls @github/copilot-sdk` shows the new version.

#### Manual Verification:
- [ ] Fresh vault, slow-auth server: after the server finishes authenticating, its tools show up in an already-open conversation within 2 s; the assistant can call them in the next turn without reload.
- [ ] Mid-stream connect: in-flight turn completes with its original tool list; next turn sees new tools.
- [ ] Disconnect / crashloop of a previously-connected server: its tools disappear within 2 s across all open conversations.
- [ ] With three or more open conversations, a single connect event propagates tools to every one of them without focus-switching.

---

## Phase 6: Documentation

### Changes Required:

- **`.paw/work/mcp-readiness-ux/Docs.md`** (new): Technical reference.
  Load `paw-docs-guidance` for template. Cover the watcher, the
  refresh flow, the SDK primitive contract, the feature-detect
  fallback, the ChatView pill state machine, and the acceptance
  scenarios in Spec.md.
- **`README.md`**: Add a short subsection under `## What's new in
  v0.9` (or the current release header) noting the readiness pill and
  auto-refresh behavior. Link relevant troubleshooting: replace any
  existing "reload to see new tools" language with the new flow, or
  scope it to old-SDK fallback.
- **`CHANGELOG.md`**: Top-section entries for the readiness pill,
  auto-refresh, and SDK primitive. Follow the release-agent rules
  hardened in v0.8.0: no dead links, no PAW-workflow-speak; describe
  user-visible behavior.
- **Documentation build verification**: `npm run schema:check` (if
  any schema touched — none expected here) and manual read-through
  for style consistency with `docs/preset-packs.md:16-36`.

### Success Criteria:

#### Automated Verification:
- [ ] Typecheck: `npm run typecheck`
- [ ] Build: `npm run build`

#### Manual Verification:
- [ ] Docs.md exists and covers all Phase 1-5 changes with file:line references.
- [ ] README section is present and follows existing style.
- [ ] CHANGELOG entry passes the v0.8.0-hardened release rules: no `.paw/` links; no PAW/workflow phrasing; no dead links (`git cat-file -e HEAD:<path>` for each linked path).

---

## References

- Issue: none (v0.8.0 internal follow-up)
- Spec: `.paw/work/mcp-readiness-ux/Spec.md`
- Research: `.paw/work/mcp-readiness-ux/CodeResearch.md`
- Related proposals: `proposals/0003-mcp-dynamic-tools.md`, `proposals/0005-mcp-slice7-followup.md`
