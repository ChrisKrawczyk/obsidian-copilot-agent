# Spec Review — Perspective: Operational Resilience

- **Specialist:** Operational Resilience reviewer (PAW planning-review)
- **Spec under review:** `.paw\work\mcp-client\Spec.md` (v0.5 MCP Client Integration)
- **Date:** 2026-06-15
- **Verdict:** **NEEDS-REVISION**

## Scope

I reviewed the v0.5 spec exclusively through an operational-resilience lens:
startup/shutdown of stdio child processes, network resilience for Streamable HTTP,
state consistency under disconnects/notifications/concurrent calls, user-visible
diagnosability, and testability of failure-mode acceptance criteria. I did not
modify Spec.md, SpecResearch.md, or any other artifact.

The spec is structurally solid and many resilience concerns are already named
(FR-016/017/018/019/020/021/024). However, several operationally important
behaviors are either underspecified or absent, leaving open questions that an
implementer could resolve in incompatible ways and that QA cannot pin to
testable criteria. I'm calling these out below.

---

## Findings

### Must-fix (M1–M4)

#### M1. No tool-call request timeout requirement

**Evidence:**
- `Spec.md:135-138` (FR-021) covers user-initiated Stop and incoming
  `notifications/cancelled`, but never establishes a *client-side* request
  timeout for `tools/call` (or for `initialize` / `tools/list`).
- `SpecResearch.md:822-839` explicitly flags this and recommends a configurable
  default (e.g., 30 s / 120 s) plus progress-notification clock-reset semantics.
- The MCP spec itself (`SpecResearch.md:824-826`) makes timeouts a SHOULD.

**Why it matters:** A hung MCP server (stdio child wedged after `initialize`,
or HTTP endpoint that accepts the POST and never responds) will pin an in-flight
tool call, an "approving / running" UI state, and any user expectation of
liveness indefinitely until the user happens to click Stop. There is no
automatic safety net. This is the single largest resilience gap.

**Suggested direction:** Add an FR that requires (a) a default per-request
timeout for `tools/call`, (b) a separate handshake timeout for
`initialize`/`tools/list`, (c) defined behavior on timeout (synthesize
`notifications/cancelled`, reject the in-flight promise, render error block,
do not mark the server disconnected on its own), and (d) progress-notification
clock-reset with an absolute upper bound. Also add a matching SC.

---

#### M2. Auto-reconnect is "bounded exponential-backoff" with no bounds

**Evidence:**
- `Spec.md:120-123` (FR-018) requires "bounded exponential-backoff
  auto-reconnect" but does not define base delay, cap, max attempts,
  jitter, total wall-clock budget, or what "bounded" means.
- "Repeated failure never blocks chat UI" (FR-018 acceptance) is observable
  but not parametric.

**Why it matters:** Without a defined schedule, two implementations could
both claim to satisfy the FR while one retries forever every 100 ms (CPU
churn, log spam, possible quota burn) and another gives up after one
attempt. There is also no requirement to *reset* backoff on successful
connection (so a long-lived server that flaps once enters and stays in a
slow-retry state). And there is no crashloop suppression — N rapid
spawn-then-exit cycles must eventually stop and demand manual reconnect,
which is an operational property, not a stylistic detail.

**Suggested direction:** Tighten FR-018 to specify (or reference a normative
section that specifies) initial delay, exponential factor, jitter policy,
maximum delay, attempt cap (or wall-clock cap) per "session" of failures,
backoff reset rule on success, and a crashloop terminal state ("after K
attempts the server is marked failed; user must use Reconnect"). Add an SC
that asserts the schedule shape and the terminal state.

---

#### M3. HTTP transport has no liveness / SSE-stream lifecycle policy

**Evidence:**
- `Spec.md:120-123` (FR-018) limits auto-reconnect to stdio.
- `Spec.md:110-113` (FR-016) and `Spec.md:125-128` (FR-019) state that HTTP
  failures "leave server eligible for fresh connect on next call."
- `Spec.md:55-58` (FR-005) acknowledges "server notifications over
  Streamable HTTP are handled when exposed" but never defines the lifecycle
  of the optional GET SSE stream that carries
  `notifications/tools/list_changed` and `notifications/cancelled` between
  user-initiated calls.

**Why it matters:** Three concrete operational failures are unspecified:
1. **Silent staleness.** If the GET SSE stream drops between user calls,
   the server status remains "connected" but `tools/list_changed`
   notifications are silently lost — exactly the case the coalescing logic
   in FR-020 was added to handle. The user's tool inventory may diverge
   from the server's indefinitely.
2. **Thundering herd.** "Fresh connect on next call" with no
   single-flight requirement means N concurrent queued/restarted tool
   calls during a brief outage can each kick off independent
   `initialize` handshakes against a freshly-recovered server.
3. **No HTTP keepalive contract.** Resumability via `Last-Event-ID` is
   mentioned in research (`SpecResearch.md:344-346`) but the spec is silent
   on whether v0.5 attempts SSE resumption or just abandons the stream.

**Suggested direction:** Add explicit FR text or expand FR-005/FR-016
to specify (a) whether v0.5 maintains a GET SSE stream at all and, if so,
its reconnect/resume policy and how its absence is reflected in UI status;
(b) single-flight `initialize` per server (only one in-flight handshake at
a time, queued waiters share the result); (c) explicit "no SSE resumption
in v0.5; on stream drop we either reopen or surface stale status" and a
matching SC.

---

#### M4. Tool identity model under cross-server name collisions

**Evidence:**
- `Spec.md:75-78` (FR-009) requires "globally unambiguous and preserves
  server attribution" for registered tools, but does not state the
  registration *key*.
- `Spec.md:70-73` (FR-008) addresses *intra-server* duplicates but is
  silent on *cross-server* duplicates (e.g., two enabled servers each
  exposing `read_file`).

**Why it matters:** This is operational because it touches state
consistency on (re)connect, on `tools/list_changed` refresh, and on
disable/enable cycles. If the registration key is `(serverId, toolName)`
the system is robust to collisions; if it is `toolName` alone, then
adding/enabling a second server can shadow or be shadowed by the first,
silently changing routing — and the visibility of that change depends on
ordering of refresh callbacks. Also: when a server is disabled, FR-009
says it "stop[s] contributing tools for subsequent sessions/calls" but
does not say what happens to a tool whose name now resolves only to the
*other* still-enabled server (re-resolution rules during a chat turn that
already saw the first inventory).

**Suggested direction:** Pin the registration key explicitly (recommend
`(serverId, toolName)`), state the SDK-surface naming pattern shown to
the model (e.g., `mcp__<server>__<tool>` or similar), and define refresh
atomicity (replace inventory atomically per server; a refresh is either
fully applied or not applied so an in-flight assistant turn never sees a
half-mutated inventory). Add an SC for cross-server collision.

---

### Should-fix (S1–S9)

#### S1. Plugin unload total time is unbounded with N stdio servers

`Spec.md:150-153` (FR-024) requires per-process "stdin → 5 s → SIGTERM →
5 s → SIGKILL". With N tracked stdio children executed sequentially the
worst case is 10 N seconds blocking Obsidian unload. The spec does not
require the per-process timers to run in parallel, nor cap aggregate
unload latency. SC-008 (`Spec.md:185`) inherits the same gap.

**Direction:** Require parallel per-process shutdown so total worst case
is ~10 s regardless of N; or impose an aggregate cap; specify that the
unload path resolves promptly even if a child blocks SIGKILL delivery.

#### S2. In-flight call disposition on disable / remove / reconnect / disconnect

The spec does not explicitly state what happens to in-flight tool calls
when the user disables, removes, or reconnects a server, or when the
transport drops mid-call. `Spec.md:111-113` (FR-016) says in-flight
failures "render failed tool-call blocks" only for *crash* paths.
FR-002 (`Spec.md:42`) says remove/disable "stops active connection" but
does not address in-flight requests. FR-017 (`Spec.md:117`) does not
either.

**Direction:** Make explicit (a) every transition that tears down a
transport MUST reject all in-flight request promises with a defined
error class; (b) reject MUST happen *before* the connection state flips
to disconnected for UI purposes (or define ordering); (c) v0.5 MUST send
`notifications/cancelled` on user-initiated stop where request id is
known, but is not required to wait for ack before tearing down. Add SCs.

#### S3. Late responses after cancellation are ignored

`SpecResearch.md:204` notes the spec's "sender SHOULD ignore any response
that arrives after sending cancellation," but FR-021 (`Spec.md:135-138`)
only describes outbound cancellation and inbound `notifications/cancelled`
handling — it does not state that a tardy `tools/call` *response* arriving
after cancellation MUST NOT be applied to UI state, nor that JSON-RPC id
de-duplication is required. Without this, a slow server can flip a UI
block from "cancelled" back to "success."

**Direction:** Add "responses for cancelled requests MUST be discarded;
the cancelled UI state is terminal" to FR-021's acceptance criteria, and
add an SC.

#### S4. No defined liveness/health for "connected" status

There is no requirement that the plugin verify a server is still alive
between calls. For stdio the SDK transport will surface child exit; for
HTTP, in the absence of a maintained GET SSE stream, the plugin only
discovers death on the next call attempt. UI may report "connected" for
a server that died hours ago. NFR-008 (`Spec.md:174`) is silent on this.

**Direction:** Either require a periodic lightweight health check (e.g.,
heartbeat on stdio process state; HTTP server's `ping` is not part of MCP
2025-06-18, so this would be local-only), or require the UI to label HTTP
status as "last connected: <time>" rather than asserting current
connectedness. Add an SC.

#### S5. Stderr / log buffer growth is unbounded

`Spec.md:52` (FR-004) says "stderr is captured only for diagnostics" and
`Spec.md:174` (NFR-008) says snippets are locally visible — neither
imposes a ring-buffer size or per-server cap. A chatty subprocess can
slowly inflate plugin memory.

**Direction:** Specify a per-server stderr ring buffer cap (e.g., last
N KiB or last K lines) and require last-error/log views to read from it.

#### S6. Initialize / handshake timeout is implicit

`Spec.md:60-63` (FR-006) and `Spec.md:65-68` (FR-007) describe the
content of the initialize handshake, but never bound how long the client
will wait. A child that opens stdio and never responds to `initialize`
should not keep "Connecting…" indefinitely. (Related to but distinct from
M1: the per-call timeout.)

**Direction:** Add a handshake timeout to FR-006 (or a new FR), with a
defined behavior: on timeout, mark disconnected with "initialize
timeout" last-error and run shutdown sequence per FR-024.

#### S7. Stale grants on server identity changes

`Spec.md:90-93` (FR-012) defines `mcpAutoApprove[serverName]` and
session grants via `SafetyState.grantMcp`. The spec does not state what
happens to those grants when the *same `id`* server is reconfigured —
e.g., its `name` changes (auto-approve key drift), or `transport` flips
stdio↔HTTP, or HTTP `url` is changed. FR-002 (`Spec.md:42`) defines
edit/remove/reconnect but not grant revocation.

**Direction:** Require revocation of session grants and a re-evaluation
of `mcpAutoApprove` when (a) a server's `name` changes, (b) its
`transport` changes, (c) its HTTP `url` changes, or (d) its stdio
`command` changes. Add an SC for "grant doesn't survive server identity
shift."

#### S8. No upper bound on tool-call response size / line length

stdio is newline-delimited JSON — a hostile or buggy server can emit a
single multi-megabyte line that the client must buffer fully before
parsing. FR-014 (`Spec.md:100-103`) and FR-015 (`Spec.md:105-108`) shape
the rendering of results but never cap *transport-level* response size.
Truncation policy in `SpecResearch.md:849-854` is acknowledged as a
quality decision but not made normative.

**Direction:** Specify a per-message size cap for stdio JSON-RPC frames
and per-response size cap (with synthesized error block on breach) so
that a single bad call cannot OOM the renderer or the plugin host.

#### S9. HTTP DELETE on shutdown lacks a timeout / cancellation

`Spec.md:127` (FR-019) requires a clean-shutdown HTTP DELETE that
"tolerates 405". It does not require tolerance of connection
failure/hangs. If the server is dead at plugin unload, an unbounded
DELETE attempt can block.

**Direction:** Bound the DELETE attempt with a short timeout (e.g., 2 s)
and require unload to proceed regardless of its outcome.

---

### Consider (C1–C4)

#### C1. Crashloop / repeated failure terminal state has no SC

FR-018 acceptance ends with "repeated failure never blocks chat UI"
which is necessary but not sufficient — the user-visible state during a
crashloop is unspecified (still "Reconnecting…" forever? or "Failed —
manual Reconnect required"?). Even if M2 specifies a cap, an SC like
"after K consecutive failed attempts the server displays a terminal
'failed' status with last error and the auto-reconnect timer is
cancelled" makes the behavior testable.

#### C2. SC-005 is a single happy-path resilience scenario

`Spec.md:182` covers "stdio exits mid-call OR HTTP disconnects" in one
SC. Operational confidence calls for separate SCs for: timeout
cancellation, auto-reconnect actually firing on stdio exit, crashloop
terminal state, in-flight rejection on user-disable, late-response
discard after cancellation, and aggregate unload time bound. Several
align with the must-fix items above.

#### C3. NFR-001 perf bound is for `tools/list` only

`Spec.md:167` bounds `tools/list` to ≤ 2 s. There is no parallel bound
on aggregate connect time at plugin load (N enabled servers connecting
during plugin init), nor a requirement that connects run concurrently
rather than serially. Connecting 5 servers serially at 2 s each makes
plugin startup 10 s slower than necessary.

**Direction:** Add NFR (or expand NFR-001) for "MCP server connects MUST
run concurrently; plugin load completion MUST NOT block on MCP
connect."

#### C4. Reconnect button concurrency

If a user clicks Reconnect twice (or clicks Reconnect while auto-reconnect
is mid-attempt), the spec doesn't define behavior. Two simultaneous
spawn/initialize sequences for the same server could occur transiently
unless single-flight is required. Less severe than M3's HTTP thundering
herd because user-driven, but worth pinning.

---

## Coverage of operational-resilience surface (summary)

| Concern                              | Spec status                | Notes |
|--------------------------------------|----------------------------|-------|
| Stdio shutdown sequence              | Covered (FR-024, SC-008)   | Solid except S1 (parallelism) |
| Stdio orphan prevention on unload    | Covered (FR-024, SC-008)   | OK |
| Stdio crash mid-call                 | Covered (FR-016, SC-005)   | OK except in-flight rejection ordering (S2) |
| Stdio auto-reconnect                 | Covered but underspecified | M2 |
| HTTP stale-session reinit            | Covered (FR-005, FR-019)   | OK |
| HTTP transport reconnect / SSE       | **Not covered**            | M3 |
| Tool-call timeout                    | **Not covered**            | M1 |
| Initialize/handshake timeout         | **Not covered**            | S6 |
| Cancellation outbound                | Covered (FR-021)           | OK |
| Cancellation inbound                 | Covered (FR-021)           | OK |
| Late-response after cancel           | **Not covered**            | S3 |
| `tools/list_changed` coalescing      | Covered (FR-020, SC-006)   | OK; refresh atomicity (M4) |
| Cross-server tool identity           | Underspecified             | M4 |
| In-flight on disable/remove/reconn.  | **Not covered**            | S2 |
| Liveness / health between calls      | **Not covered**            | S4 |
| Stderr buffer cap                    | **Not covered**            | S5 |
| Concurrent connect single-flight     | **Not covered**            | M3, C4 |
| Stale auth grant on identity change  | **Not covered**            | S7 |
| Response/frame size cap              | **Not covered**            | S8 |
| Plugin-unload aggregate latency      | **Not covered**            | S1 |
| Plugin-load aggregate latency        | **Not covered**            | C3 |
| Crashloop terminal UI state          | **Not covered**            | C1 |

---

## Verdict rationale

The spec is well-organized and resilience is *named* prominently
(FR-016/017/018/019/020/021/024 plus NFR-002), but several operationally
load-bearing behaviors are missing or underspecified — most importantly
M1 (no tool-call timeout), M2 (auto-reconnect schedule undefined), M3
(HTTP liveness / single-flight / SSE lifecycle), and M4 (tool identity
under cross-server collisions). Each is the kind of gap that an
implementer can resolve in good faith in a way that satisfies the
written acceptance criteria yet still produces incidents in the field
(hung calls, log spam, silent staleness, ambiguous routing).

These are addressable with targeted FR/SC additions; no architectural
rework is required. After those additions and tightening of the
should-fix items, this spec is ready to plan against from a resilience
standpoint.

**Verdict: NEEDS-REVISION.**
