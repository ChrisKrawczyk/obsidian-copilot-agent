# Spec — v0.5 MCP Client Integration

## Summary

v0.5 adds MCP client support to obsidian-copilot-agent so users can manually configure external Model Context Protocol servers and surface their tools alongside the existing built-in vault tools. MCP is purely additive: the plugin must work end-to-end when no MCP servers are configured or when all MCP servers are disabled.

The release supports MCP tools only over stdio subprocesses and Streamable HTTP. It performs the MCP initialize/initialized lifecycle, discovers tools with bounded `tools/list` pagination, registers MCP tools into the existing SDK/session surface with collision-safe synthetic ids, and routes every MCP call through the existing universal approval gate. MCP tools are mutating-by-default and not undoable; approval is required per call unless the user explicitly allows the stable server/tool identity through the existing `mcpAutoApprove` path.

Locked v0.5 decisions: advertise protocol version `2025-06-18`; accept `2024-11-05` only over stdio or Streamable HTTP; reject legacy HTTP+SSE-only servers at initialize with a clear error; store server config and static HTTP `Authorization` headers in plugin `data.json`; use full-inherit-minus-denylist env filtering for stdio; spawn stdio with `shell: false`; prepend `/usr/local/bin` and `/opt/homebrew/bin` to macOS subprocess PATH; include server `instructions` in the preamble truncated to 4 KB per server; keep HTTP `Mcp-Session-Id` only in memory and never log it; handle `notifications/tools/list_changed` in two phases (Phase 5 idle refresh-on-event; Phase 6 deferred/coalesced atomic refresh while calls are in flight); and shut down stdio servers with stdin close → 5 s → SIGTERM → 5 s → SIGKILL. [SpecResearch §1.1, §1.2, §1.3, §1.4, §2a, §2b, §5.1, §5.2, §7.3, §8, §9]

## Goals

- Let users add, edit, remove, enable/disable, reconnect, and inspect manually configured MCP servers in Settings → Copilot Agent → MCP Servers.
- Connect to MCP servers over stdio and Streamable HTTP, negotiate protocol/capabilities, and discover every tool exposed by each connected server within explicit time and size bounds.
- Surface MCP tools in the SDK tool list and vault-aware preamble with stable synthetic ids and clear `(MCP / <server-display-name>)` attribution.
- Preserve existing safety wiring: `SafetySource = "mcp"`, the top-level `decideSafety(...)` function in `src\domain\SafetyPolicy.ts`, `SafetyState.grantMcp`, `AgentSession.buildSafetyInput`, approval prompts, and `mcpAutoApprove`.
- Suppress Undo for MCP tool calls while preserving all existing Undo behavior for vault write tools.
- Survive MCP server crashes, disconnects, stale HTTP sessions, tool-list changes, timeouts, oversized payloads, and plugin unload without crashing or orphaning stdio subprocesses.
- Maintain the v0.4 724/724 baseline test suite and add focused MCP coverage.

## Non-Goals (Out of Scope)

- Acting as an MCP server.
- OAuth flow for MCP servers.
- MCP resources, prompts, sampling, elicitation, roots, or server-initiated LLM calls.
- Live registry/browsing of public MCP servers.
- Deprecated HTTP+SSE transport fallback.
- Per-conversation MCP allowlist.
- Telemetry or cost accounting for MCP tool usage.
- Full image/audio passthrough to the model.
- Undo journal entries for MCP tool calls.

## Problem Statement

Users want to bring trusted external capabilities, such as GitHub, local filesystem helpers, or custom team tools, into Obsidian Copilot Agent without losing the plugin's existing approval, Undo, and vault-safety posture. Today the plugin only exposes built-in tools; users cannot configure MCP servers, inspect their connection health, or invoke MCP tools from chat.

MCP servers are powerful and untrusted by default. A usable v0.5 must therefore define not only the happy path but also exact behavior for subprocess spawning, HTTP transport safety, tool identity collisions, bounded I/O, approval persistence, and crash recovery.

## User Stories

### US-1 — Configure and manage MCP servers (P1)

**As an** Obsidian user, **I want** to add, edit, enable, disable, remove, reconnect, and inspect MCP servers in Settings, **so that** I control which external tools are available to the agent.

- **Acceptance scenarios:** add a stdio or HTTP server and see transport/status/last-error fields; disable/remove a connected server and see tools disappear; reconnect a failed server and see a fresh initialize attempt update status.
- **Independent test:** Add a fake stdio server, connect it, disable it, reconnect it, and verify row status/tool inventory changes at each step.

### US-2 — Use discovered MCP tools from chat (P1)

**As an** Obsidian user, **I want** connected MCP tools to appear in the agent's tool inventory and preamble, **so that** the assistant can call them with clear server attribution.

- **Acceptance scenarios:** two servers can both expose `read_file` and both appear under distinct synthetic ids; server instructions appear after initialize and are truncated per server; successful calls render results without Undo.
- **Independent test:** Connect two fake servers with a shared tool name and call one tool from each; verify the correct originating server receives each call.

### US-3 — Keep MCP calls approval-gated and non-undoable (P1)

**As an** Obsidian user, **I want** every MCP call to show a safe approval prompt unless I explicitly grant that server/tool, **so that** untrusted tools cannot act silently or spoof built-ins.

- **Acceptance scenarios:** `readOnlyHint` never bypasses approval; grants apply only to the matching stable server/tool identity; modal text escapes MCP-controlled names/descriptions/arguments and truncates displayed args at 4 KB.
- **Independent test:** Attempt a call with malicious display strings, verify escaped prompt text, then approve only that stable server/tool and verify grant scope.

### US-4 — Recover predictably from failures (P2)

**As an** Obsidian user, **I want** crashes, timeouts, reconnect attempts, oversized responses, and tool-list changes to have deterministic behavior, **so that** chat remains usable and I can understand what failed.

- **Acceptance scenarios:** stdio crash mid-call renders an error and follows bounded auto-reconnect; HTTP disconnect has no background auto-reconnect and next call reconnects; oversized frames/bodies/pages fail with diagnostics.
- **Independent test:** Use fake stdio/HTTP transports with timers to reproduce crash, timeout, and oversized payload paths and verify UI status/call output.

### US-5 — Connect securely to local and remote servers (P2)

**As an** Obsidian user, **I want** HTTP and stdio configuration to guard token, redirect, and SSRF risks, **so that** connecting a server does not expose unrelated credentials or internal services.

- **Acceptance scenarios:** non-loopback `http://` is rejected; private network URLs require confirmation; metadata hosts are rejected; denied secret env vars are absent from child processes.
- **Independent test:** Validate URL fixtures for loopback/private/metadata/public hosts and environment fixtures containing cloud and AI secrets.

### US-6 — Preserve compatibility and baseline behavior (P3)

**As an** existing plugin user, **I want** MCP to be additive and protocol-compatible within v0.5 scope, **so that** existing chat, approvals, Undo, and vault-tool workflows remain unchanged.

- **Acceptance scenarios:** no MCP or all-disabled MCP behaves like v0.4; `2024-11-05` stdio/Streamable HTTP servers are accepted; legacy HTTP+SSE-only servers are rejected with a clear error.
- **Independent test:** Run the v0.4 baseline suite plus a protocol-version matrix over stdio, Streamable HTTP, and legacy HTTP+SSE-only fixtures.

## Edge Cases

- **No MCP configured:** Empty or disabled MCP server list attempts no MCP initialization and contributes no tools. (FR-026)
- **Cross-server duplicate tool names:** Two MCP servers can both expose `read_file`; both register with distinct synthetic IDs. Cross-server name collisions are not an error. (FR-009)
- **Same-server duplicate tool names:** Duplicate tool names within one server inventory are rejected for that server with a visible error; no partial duplicate inventory is registered. (FR-008, FR-009)
- **Built-in collision/source spoofing:** If an MCP synthetic id would collide with a built-in tool id, MCP registration is rejected and built-ins always win. Built-ins must not use the reserved `mcp__` prefix. (FR-009)
- **Legacy HTTP+SSE-only server:** Deprecated 2024-11-05 two-endpoint HTTP+SSE is rejected at initialize; v0.5 does not fall back to `SSEClientTransport`. (FR-005, FR-029)
- **HTTP stale session:** HTTP 404 for a session id clears volatile HTTP state and reinitializes on the next call; `Mcp-Session-Id` is never persisted or logged. (FR-019)
- **Stdio crashloop:** Five failed reconnect attempts within five minutes put the server in `crashloop` terminal state until manual Reconnect. (FR-018)
- **Oversized I/O:** Frames/bodies/SSE accumulators over 16 MiB fail deterministically with diagnostics rather than exhausting memory. (FR-028)
- **Approval text injection:** MCP-supplied tool names, server names, descriptions, and arguments are escaped as plain text in approval UI; no markdown rendering occurs in the modal. (FR-031)

## Functional Requirements

### FR-001 — Server config persistence
- **Statement:** The plugin MUST persist MCP server configurations in existing plugin `data.json` as additive `mcpServers: McpServerConfig[]`. (Stories: US-1, US-6)
- **Acceptance criteria:** Missing field defaults to `[]`; each config has stable user-assigned `id`/slug, trust epoch identity, display `name`, `enabled`, `transport`, status/error metadata, and transport-specific fields; stdio stores `command`, `args`, optional `cwd`, optional explicit `env`; HTTP stores `url` and optional `headers`; runtime `Mcp-Session-Id` is never persisted.
- **Test hooks:** New persistence tests for MCP config shape; existing sibling-key preservation tests under `src\persistence`.

### FR-002 — Server config lifecycle UI
- **Statement:** Settings MUST allow add, edit, remove, enable, disable, and reconnect for MCP servers. (Stories: US-1)
- **Acceptance criteria:** Add/edit validates transport-required fields; remove confirms, stops active connection, and clears all grants for that server; disable stops active connection and hides tools; reconnect performs fresh initialize and updates status/last error; list rows show display name, slug/id, transport, enabled state, connection state, and last error.
- **Test hooks:** New settings UI/controller tests.

### FR-003 — Static HTTP Authorization header
- **Statement:** HTTP configs MUST support a static pasted `Authorization` header stored with the server config in `data.json`, same posture as current token storage. (Stories: US-1, US-5)
- **Acceptance criteria:** Header is sent on initialize and subsequent same-origin HTTP requests; saved value is redacted in the UI except explicit edit/reveal; the Settings UI shows a one-time Notice on first HTTP-server-with-Authorization add: `Authorization headers are stored in plain text in data.json. If your vault is synced (Obsidian Sync, iCloud, Dropbox, etc.) this credential will sync too.`; removing the server removes the header; redirects follow FR-025; no OAuth/PKCE/token refresh is introduced.
- **Test hooks:** HTTP config tests; settings redaction/removal tests.

### FR-004 — Stdio transport
- **Statement:** Enabled stdio servers MUST launch as child processes and speak newline-delimited JSON-RPC over stdin/stdout without shell interpolation. (Stories: US-1, US-5)
- **Acceptance criteria:** `command` and `args` are passed to `child_process.spawn` as separate values with `shell: false` and never via a concatenated command string; default `cwd` is the vault root unless overridden per server; configured command/args/cwd are shown before launch; stderr is captured only for diagnostics per FR-028; spawn failure, invalid stdout, or early exit marks server failed/disconnected with last error; Windows users can explicitly configure `cmd` with args `["/c", "npx", ...]`; absolute paths always work.
- **Test hooks:** Fake child-process transport tests for launch, stderr, invalid output, and crash.

### FR-005 — Streamable HTTP transport
- **Statement:** Enabled HTTP servers MUST connect with MCP Streamable HTTP and MUST NOT fall back to deprecated HTTP+SSE. (Stories: US-2, US-5, US-6)
- **Acceptance criteria:** Requests POST to the configured endpoint with required `Accept` headers; implementation uses exactly `@modelcontextprotocol/sdk@1.29.0` for v0.5 client protocol paths; server notifications over Streamable HTTP are handled when exposed; stale session/404 reinitializes; legacy-SSE-only endpoint failures surface as unsupported transport errors.
- **Test hooks:** Mocked HTTP transport tests for initialize, request, notification, stale session, and legacy-SSE rejection.

### FR-006 — Protocol version negotiation
- **Statement:** The client MUST advertise `2025-06-18` and accept only `2025-06-18` or `2024-11-05` over stdio/Streamable HTTP. (Stories: US-2, US-6)
- **Acceptance criteria:** Initialize sends `protocolVersion: "2025-06-18"`; `2025-06-18` proceeds; `2024-11-05` proceeds only on supported stdio or Streamable HTTP framing; any other version fails with clear last error; post-init HTTP requests include `MCP-Protocol-Version` for the negotiated version.
- **Test hooks:** Version matrix tests.

### FR-007 — Capabilities negotiation
- **Statement:** The client MUST declare no unsupported capabilities and MUST only use tools when `capabilities.tools` is present. (Stories: US-2, US-6)
- **Acceptance criteria:** Client capabilities are `{}`; roots/sampling/elicitation/resources/prompts are not advertised; tools-absent servers stay connected but contribute zero tools; `tools.listChanged` registers a notification handler when true.
- **Test hooks:** Capabilities tests for tools present/absent and listChanged registration.

### FR-008 — Full tools/list pagination
- **Statement:** On connect/reconnect, the plugin MUST follow `nextCursor` until `tools/list` is exhausted or FR-027/FR-028 bounds are reached. (Stories: US-2, US-4)
- **Acceptance criteria:** Each `tools/list` page has a 10 s timeout and aggregate discovery is capped at 30 s per server; all pages are included until exhausted; total pages followed is capped at 50; total tools per server is capped at 1000; mid-pagination failure or cap exceedance marks inventory unavailable with last error; duplicate tool names within a single server are rejected for that server with visible error.
- **Test hooks:** Tool discovery tests for single page, multiple pages, timeout, cap exceedance, failures, and duplicates.

### FR-009 — SDK tool registration
- **Statement:** Discovered MCP tools from enabled connected servers MUST register into the agent SDK tool surface under deterministic synthetic IDs without changing built-in vault tool registration. (Stories: US-2, US-3)
- **Acceptance criteria:** Every MCP tool registers with synthetic id `mcp__<server-id>__<tool-name>`, where `<server-id>` is the user-assigned slug/stable config id, not mutable display name; two MCP servers can both expose `read_file` and both register distinct synthetic ids with no cross-server dedupe; if a synthetic id collides with a built-in tool id (`view`, `read_file`, etc.) the MCP registration is rejected with a server-config UI error and one-shot Notice; built-ins always win; built-in ids MUST NOT use the reserved `mcp__` prefix; description/input schema are passed through; disabled/disconnected servers stop contributing tools for subsequent sessions/calls; zero MCP tools behaves like v0.4.
- **Test hooks:** MCP registry tests; `src\sdk\AgentSession.test.ts`.

### FR-010 — Preamble inventory and instructions
- **Statement:** The vault-aware preamble MUST list MCP tools with display name `<tool-name> (MCP / <display-name>)` and include server `instructions` truncated to 4 KB per server. (Stories: US-2, US-3)
- **Acceptance criteria:** Preamble display uses the server display name while SDK identity uses FR-009 synthetic id; instructions appear only after initialize and are omitted when absent; each server is independently truncated at 4096 chars with a marker; instructions and MCP descriptions never change approval policy.
- **Test hooks:** Preamble assembler tests under `src\domain`.

### FR-011 — Universal permission gate routing
- **Statement:** Every MCP tool call MUST route through the existing approval gate as `SafetySource = "mcp"` before execution. (Stories: US-3)
- **Acceptance criteria:** SDK `kind === "mcp"` maps in `AgentSession.buildSafetyInput` to `source: "mcp"` and stable server/tool scope; the top-level `decideSafety(...)` function requires approval by default; approval prompt shows escaped server/tool/args per FR-031; rejected calls are not sent to the server.
- **Test hooks:** `src\domain\SafetyPolicy.test.ts`; `src\sdk\AgentSession.test.ts`; approval UI tests.

### FR-012 — MCP auto-approval allowlist
- **Statement:** MCP calls MAY auto-approve only when the user explicitly allows the stable server/tool identity via `mcpAutoApprove` or an in-session MCP grant. (Stories: US-3, US-5)
- **Acceptance criteria:** Persistent grants in `mcpAutoApprove` are keyed by `(stableServerId, toolName)`, not display name; Approve for session uses the same stable server/tool identity and clears with other session grants; renaming a server or changing its `command`, `args`, or `url` rotates that server's trust epoch, revokes all persistent grants for the server, and notifies the user once; removing a server clears all grants for it; MCP tool annotations such as `readOnlyHint` never bypass approval.
- **Test hooks:** SafetyPolicy MCP tests; AgentSession approve-for-session and grant-revocation tests.

### FR-013 — MCP calls are not undoable
- **Statement:** MCP tool calls MUST NOT create Undo journal entries and MUST suppress the Undo button in `ToolCallBlock`. (Stories: US-2, US-3, US-6)
- **Acceptance criteria:** MCP blocks render status/input/result/error; Undo is absent for MCP success and failure; vault write Undo behavior is unchanged.
- **Test hooks:** `src\ui\ToolCallBlock` tests; Undo regression tests.

### FR-014 — Tool call execution and result rendering
- **Statement:** Approved MCP calls MUST invoke `tools/call` on the originating server and render text, structured, and error results in the existing tool-call surface. (Stories: US-2, US-4)
- **Acceptance criteria:** Calls route by FR-009 synthetic id to the originating server and original MCP `tool-name`; `isError: true` renders as tool execution error; JSON-RPC errors render as protocol errors; structured content is readable; text uses existing truncation behavior; timeout follows FR-027.
- **Test hooks:** MCP call adapter tests; ToolCallBlock rendering tests.

### FR-015 — Image/binary placeholders
- **Statement:** MCP image, audio, blob, or other binary result content MUST render as a placeholder such as `[image: <mime>, N bytes]` in v0.5, not raw base64. (Stories: US-2, US-4)
- **Acceptance criteria:** Byte count is computed from decoded base64 where possible; audio/blob/resource binary content uses equivalent typed placeholders; text in the same result still renders; base64 is not passed through to the model.
- **Test hooks:** Result-normalization tests for mixed content.

### FR-016 — Crash/disconnect resilience
- **Statement:** MCP server crashes, exits, transport errors, and disconnects MUST never crash the plugin and MUST surface as status changes and tool-call errors. (Stories: US-4, US-6)
- **Acceptance criteria:** In-flight failures render failed tool-call blocks; stdio exit records exit code/signal when available; stdio reconnect follows FR-018; HTTP network failure leaves server eligible for fresh connect on next call and does not start a background auto-reconnect loop; built-in tools/chat remain usable.
- **Test hooks:** Resilience tests for stdio exit, HTTP failure, in-flight rejection, and post-failure built-in use.

### FR-017 — Manual reconnect
- **Statement:** Users MUST be able to reconnect any enabled server, refreshing capabilities, instructions, and full tool inventory. (Stories: US-1, US-4)
- **Acceptance criteria:** Reconnect clears volatile transport state including HTTP session id and stdio reconnect/crashloop counters; success updates status/capabilities/tools; failure preserves config and records last error.
- **Test hooks:** Reconnect controller and registry refresh tests.

### FR-018 — Stdio auto-reconnect
- **Statement:** Unexpected stdio disconnects MUST attempt bounded exponential-backoff auto-reconnect while the server remains enabled. (Stories: US-4)
- **Acceptance criteria:** No auto-reconnect for disable/remove/unload; retry schedule is 1 s → 2 s → 4 s → 8 s → 16 s → 32 s, then capped at 60 s for any further allowed delay; successful initialize resets the next delay to 1 s; at most 5 attempts may occur within any 5-minute window; hitting that cap puts the server in terminal `crashloop` UI state; manual Reconnect resets the crashloop state and counters; attempts are cancellable and visible in status; success re-runs initialize and full pagination; repeated failure never blocks chat UI.
- **Test hooks:** Fake-timer reconnect tests.

### FR-019 — HTTP session id lifecycle
- **Statement:** HTTP `Mcp-Session-Id` MUST be in-memory only and MUST NOT persist across plugin reloads or appear in logs/errors/UI diagnostics. (Stories: US-5, US-6)
- **Acceptance criteria:** Same-load requests include assigned session id during initialize, bounded `tools/list` discovery, and `tools/call`; HTTP discovery also observes the 30 s aggregate `tools/list` cap; reload/reconnect starts without old session id and initializes fresh; clean shutdown attempts HTTP DELETE with current session id and tolerates 405; session ids are redacted from local diagnostics, last-error text, and `data.json`.
- **Test hooks:** HTTP session lifecycle tests.

### FR-020 — list_changed refresh and coalescing
- **Statement:** `notifications/tools/list_changed` MUST refresh MCP tool inventories without exposing partial registry state, with Phase 5 providing idle refresh-on-event and Phase 6 adding deferred/coalesced refresh while calls are in flight. (Stories: US-2, US-4)
- **Acceptance criteria:** Phase 5: when no MCP call is in flight for that server, one notification triggers one immediate non-coalesced full registry refresh between tool calls only, and refresh failure preserves the previous inventory with last error. Phase 6: multiple notifications coalesce; notifications during a call defer until it settles; successful refresh computes add/remove/replace as a complete diff and swaps the SDK-visible registry atomically with no partial state visible mid-flight.
- **Test hooks:** Idle refresh-on-event tests; coalescing/concurrency/atomic-swap tests.

### FR-021 — Cancellation and Stop
- **Statement:** The plugin MUST handle MCP cancellation notifications gracefully and SHOULD send `notifications/cancelled` when Stop cancels an in-flight MCP call. (Stories: US-4, US-6)
- **Acceptance criteria:** Known-request cancellation marks call cancelled/interrupted; unknown or already-complete cancellations are ignored; Stop settles UI state and sends cancellation when request id support exists using payload `{ requestId, reason: "user_cancelled" }`; late responses after cancellation are discarded.
- **Test hooks:** Cancellation/Stop tests.

### FR-022 — Stdio environment filtering
- **Statement:** Stdio subprocess env MUST be full inherit minus denylist, plus explicit per-server allowlisted env entries. (Stories: US-1, US-5)
- **Acceptance criteria:** Before spawn, filter out `GITHUB_TOKEN`, `GH_TOKEN`, `COPILOT_*`, `COPILOT_AGENT_*`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `AZURE_OPENAI_*`, `AWS_*`, `GCP_*`, `GOOGLE_APPLICATION_CREDENTIALS`, `SSH_AUTH_SOCK`, `SSH_PRIVATE_KEY`, anything matching `*_TOKEN`, `*_API_KEY`, `*_SECRET`, and `*_PASSWORD`; Windows matching is case-insensitive; explicit per-server env entries are injected after filtering; ordinary usability vars (`PATH`, `HOME`, `USERPROFILE`, `TMP`, `TEMP`, `TMPDIR`, locale vars) remain unless denied; when user-configured explicit env keys match the denylist, Settings shows an inline warning and a one-shot Notice on save before the override is injected.
- **Test hooks:** Env-filter unit tests for exact keys, wildcard prefixes, Windows case behavior, and explicit overrides.

### FR-023 — macOS PATH amendment
- **Statement:** On macOS stdio launches, subprocess `PATH` MUST prepend `/usr/local/bin` and `/opt/homebrew/bin`. (Stories: US-1, US-6)
- **Acceptance criteria:** Prepended paths come before inherited entries; duplicates are harmless/de-duplicated; absolute command paths bypass PATH resolution and remain the documented escape hatch; non-macOS behavior is unchanged except env filtering.
- **Test hooks:** PATH builder tests for macOS/Windows/Linux.

### FR-024 — Stdio shutdown sequence
- **Statement:** Disable/remove/reconnect and plugin unload MUST shut down every spawned stdio server by closing stdin, waiting 5 s, sending SIGTERM, waiting 5 s, then sending SIGKILL. (Stories: US-1, US-4)
- **Acceptance criteria:** Clean exit after stdin close sends no kill; still-alive after 5 s receives SIGTERM; still-alive 5 s later receives SIGKILL; unload attempts this for every tracked process in parallel, is idempotent, and enforces a 20 s aggregate wall-clock cap with forced kill and redacted warning for any still-running child.
- **Test hooks:** Fake child-process/fake-timer shutdown tests; plugin unload integration test.

### FR-025 — HTTP URL and TLS posture
- **Statement:** HTTP MCP URLs MUST use normal TLS validation and MUST reject or warn on risky destinations before connecting. (Stories: US-5)
- **Acceptance criteria:** URL must be `https://` unless host is `localhost`, `127.0.0.1`, or `::1`; plaintext `http://` to any non-loopback host is rejected at config-add with an error; HTTPS uses default certificate validation and no `rejectUnauthorized: false` option is exposed; malformed URLs fail validation; URL host is classified at config time: loopback has no warning; private-IP ranges (`10/8`, `172.16/12`, `192.168/16`, link-local, `fc00::/7`) require confirmation modal text `This server is on a private network. Continue?`; cloud metadata IPs/hosts including `169.254.169.254` and AWS/GCP/Azure metadata hosts are rejected; redirects follow at most 3 hops, reclassify each hop host against the same loopback/private/metadata policy before following it, and drop the `Authorization` header on cross-origin redirects.
- **Test hooks:** URL/TLS/SSRF/redirect validation tests.

### FR-026 — MCP-disabled baseline
- **Statement:** With no MCP servers configured or all disabled, v0.5 MUST behave like v0.4 for chat, model picker, persistence, approvals, Undo, streaming, Stop, auth, and vault tools. (Stories: US-6)
- **Acceptance criteria:** Empty server list attempts no MCP initialization; disabled servers spawn/open no transports and contribute no tools; existing v0.4 tests remain green at 724/724 before new MCP tests; preamble remains valid without MCP sections.
- **Test hooks:** Existing full suite; new no-MCP smoke test.

### FR-027 — Request timeout policy
- **Statement:** MCP initialize, discovery, and tool calls MUST use explicit timeouts with deterministic failure behavior. (Stories: US-2, US-4)
- **Acceptance criteria:** Initialize handshake timeout is 10 s, after which the server is marked `failed` with last error; each `tools/list` page timeout is 10 s; `tools/call` timeout defaults to 60 s, is configurable per server, and is capped at 300 s; on timeout the plugin synthesizes a failed tool call or server status error, rejects in-flight waiters, sends `notifications/cancelled` when possible, and keeps chat UI responsive.
- **Test hooks:** Fake-timer initialize/list/call timeout tests.

### FR-028 — Bounded I/O, payload, and diagnostics caps
- **Statement:** MCP stdio and HTTP I/O MUST enforce explicit size caps to prevent hangs and memory exhaustion. (Stories: US-1, US-4, US-5)
- **Acceptance criteria:** Stdio JSON-RPC frame/line max is 16 MiB; over-limit stdio frames tear down the stdio transport and surface a diagnostic; HTTP response body max is 16 MiB; Streamable HTTP SSE accumulator max is 16 MiB; stderr capture for stdio is a ring buffer retaining the last 64 KiB and surfaced in server-config UI on failure with control characters escaped/neutralized and truncation visibly marked; `tools/list` caps from FR-008 apply before registry publication.
- **Test hooks:** Oversized stdio frame, HTTP body, SSE accumulator, stderr ring-buffer, tool-count, and page-count tests.

### FR-029 — 2024-11-05 supported-transport compatibility
- **Statement:** `2024-11-05` servers using Streamable HTTP or stdio MUST be accepted, while legacy HTTP+SSE-only servers MUST be rejected at initialize with a clear error. (Stories: US-2, US-6)
- **Acceptance criteria:** A stdio server negotiating `2024-11-05` proceeds; a Streamable HTTP server negotiating `2024-11-05` proceeds if it uses the single-endpoint Streamable HTTP request/response framing accepted by v0.5; a server requiring the deprecated two-endpoint HTTP+SSE flow fails with `Unsupported MCP transport: legacy HTTP+SSE is not supported in v0.5` or equivalent user-visible wording.
- **Test hooks:** Protocol/transport compatibility matrix tests.

### FR-030 — Documentation
- **Statement:** v0.5 MCP client behavior MUST be documented for users and maintainers before release. (Stories: US-1, US-5, US-6)
- **Acceptance criteria:** README is updated with an MCP Servers section covering stdio and Streamable HTTP setup, static Authorization storage warning, no legacy SSE fallback, and no-Undo behavior; `.paw\work\mcp-client\Docs.md` covers identity model, transports, security posture, troubleshooting, resilience/list_changed behavior, and verification guidance; CHANGELOG includes a coherent v0.5 entry with SDK version, bundle delta or waiver, security posture, and migration notes.
- **Test hooks:** Documentation review for README, Docs.md, and CHANGELOG against SC-020.

### FR-031 — Approval prompt safe rendering and truncation
- **Statement:** MCP approval prompts MUST render tool name, server name, and arguments safely as escaped plain text. (Stories: US-3, US-5)
- **Acceptance criteria:** The modal does not markdown-render MCP-supplied descriptions, tool names, server display names, or argument values; HTML/markdown/control characters are escaped or neutralized consistently with existing safe text rendering; arguments display is truncated at 4 KB with a visible truncation marker; full arguments are sent to the server only after approval.
- **Test hooks:** Approval modal rendering tests for markdown injection, HTML injection, long args, and control characters.

## Non-Functional Requirements (NFR)

- **NFR-001 Performance and bounded latency:** `tools/list` discovery for a typical server completes in ≤ 2 seconds and never blocks chat UI; hard operation bounds are initialize 10 s, `tools/list` page 10 s, and `tools/call` default 60 s configurable per server up to 300 s.
- **NFR-002 Resilience and bounded resources:** Server crash, malformed response, network failure, timeout, unload over the 20 s aggregate cap, over-16-MiB frame/body/SSE accumulator, or pagination cap exceedance never crashes the plugin; failures surface as status/errors and built-in tools remain usable.
- **NFR-003 Security:** Env filter, `shell: false` process launch, auth-header storage posture, untrusted annotations, TLS validation, SSRF checks, redirect auth stripping, session-id redaction, built-in collision prevention, and human approval are mandatory controls.
- **NFR-004 Compatibility:** `2025-06-18` and `2024-11-05` work over stdio/Streamable HTTP; HTTP+SSE-only legacy transport is intentionally unsupported and rejected with a clear error.
- **NFR-005 Bundle size:** The exact `@modelcontextprotocol/sdk@1.29.0` client paths SHOULD add ≤ 80 KB gzip to `main.js`. If the SDK exceeds this, document the addition in CHANGELOG and mitigate via tree-shaking; the limit is a sanity check, not a blocker.
- **NFR-006 Accessibility:** MCP server settings UI and approval prompts are keyboard-navigable with meaningful labels, accessible last-error text, and non-color-only status indicators.
- **NFR-007 Baseline preservation:** Streaming, Stop, approval prompts, token rotation, multi-conversation archive flow, Undo journal, raw-FS gating, preamble, model picker/catalog/recovery, lazy modelId resolution, deferred-init recovery, and send-gate precedence remain intact.
- **NFR-008 Observability without telemetry:** Connection state, last error, crashloop state, and stderr ring-buffer snippets are locally visible; no telemetry/cost accounting is added; sensitive values including `Authorization`, `Mcp-Session-Id`, tokenized URLs/userinfo, bearer values, denylisted env-like lines, and SDK error/stack strings are redacted.

## Success Criteria (SC)

| ID | Criteria | Specific reproducer |
|---|---|---|
| SC-001 | A user configures a reference stdio server, reconnects successfully, sees all tools in the preamble as `<tool-name> (MCP / <display-name>)`, approves one call, and sees the result without an Undo button. | Fake stdio server exposing one text tool and `instructions`. |
| SC-002 | A user configures a Streamable HTTP server with static Authorization, connects, discovers two pages of tools, approves one call, and observes negotiated protocol/session headers during that plugin load. | Mock HTTP server returning `Mcp-Session-Id`, two `tools/list` pages, and one call result. |
| SC-003 | An MCP tool prompts by default even with `readOnlyHint`; persistent and session grants apply only to the matching `(stableServerId, toolName)`. | Fake MCP server with `readOnlyHint: true`; two tools on the same server. |
| SC-004 | Approval prompt text escapes MCP-controlled tool/server/argument strings and truncates displayed args at 4 KB. | Tool name/description/args containing markdown links, HTML tags, and >4 KB JSON args. |
| SC-005 | With no MCP servers or all disabled, v0.4 behavior is preserved and the 724/724 baseline remains green. | Empty `mcpServers` and all-disabled `mcpServers` fixtures. |
| SC-006 | If stdio exits mid-call, the plugin stays running, the call renders an error block, built-in tools remain usable, and the first reconnect attempt begins after 1 s. | Fake stdio server exits after receiving `tools/call`. |
| SC-007 | If HTTP disconnects mid-call, the call renders an error block and no background auto-reconnect occurs; the next MCP call triggers a fresh initialize. | Mock HTTP server drops the call connection, then accepts a subsequent initialize. |
| SC-008 | Three `tools/list_changed` notifications during one in-flight call cause no mid-call refresh and exactly one atomic post-call registry swap. | Fake server sends three notifications while a delayed call is pending. |
| SC-009 | Stdio env excludes denied secrets, explicit config env is injected afterward, macOS PATH starts with `/usr/local/bin` and `/opt/homebrew/bin`, and absolute commands work. | Env fixture containing GitHub/Copilot/OpenAI/AWS/GCP/token/password variables plus explicit server env. |
| SC-010 | On unload, every stdio server receives stdin close; non-exiting servers receive SIGTERM after 5 s and SIGKILL after another 5 s; no tracked child is orphaned. | Fake child that ignores stdin close and SIGTERM until SIGKILL. |
| SC-011 | Binary MCP result content renders a placeholder such as `[image: image/png, 12345 bytes]` and does not pass base64 to the model. | Tool result containing mixed text and base64 image/audio content. |
| SC-012 | Server configs and static Authorization headers survive reload in `data.json`; runtime `Mcp-Session-Id` values do not survive reload and are absent from logs/errors/UI diagnostics. | Persisted HTTP config plus mock assigned session id; reload and inspect persisted state/diagnostics. |
| SC-013 | Initialize, `tools/list`, and `tools/call` timeouts fail deterministically at 10 s, 10 s, and configured/default call timeout respectively without blocking chat UI. | Fake transports that never answer initialize/list/call with fake timers. |
| SC-014 | Over-16-MiB stdio frames, HTTP bodies, and SSE accumulators fail with diagnostics; stderr diagnostics show only the last 64 KiB. | Fake stdio/HTTP servers emitting oversized payloads and >64 KiB stderr. |
| SC-015 | Repeated stdio crashes follow 1/2/4/8/16 second delays and the fifth failed attempt inside five minutes sets UI state to `crashloop`; manual Reconnect resets it. | Fake stdio server exits during initialize for five attempts, then succeeds after manual reconnect. |
| SC-016 | Two MCP servers exposing `read_file` both register distinct synthetic ids; a synthetic id colliding with a built-in is rejected and built-ins always win. | Two fake servers with shared tool name plus a registry fixture containing a conflicting built-in id. |
| SC-017 | HTTP config rejects non-loopback `http://`, rejects metadata hosts, warns on private network, follows at most 3 redirects, and strips Authorization on cross-origin redirect. | URL validation and redirect fixtures for loopback, private IP, metadata IP/host, same-origin redirect, cross-origin redirect. |
| SC-018 | `2024-11-05` stdio and Streamable HTTP servers initialize successfully, while a legacy HTTP+SSE-only server is rejected with a clear unsupported-transport error. | Protocol matrix fixtures for stdio, Streamable HTTP, and legacy two-endpoint SSE. |
| SC-019 | Renaming a server or changing command/args/url revokes persistent grants once; removing a server clears all grants for it. | Grant store fixture with one stable server and two tools; mutate display name, command, URL, then remove. |
| SC-020 | README, Docs.md, and CHANGELOG document MCP setup, identity model, transports, security posture, troubleshooting, bundle impact, and final verification status. | Human review of Phase 7 documentation against implemented behavior and this spec. |

## Requirements Traceability table (FR/NFR/SC × test surface)

| Requirement | SCs | Test surface |
|---|---|---|
| FR-001 | SC-012 | MCP config persistence; `src\persistence` sibling-key tests |
| FR-002 | SC-001, SC-019 | Settings UI/controller tests |
| FR-003 | SC-002, SC-012 | HTTP config/redaction/persistence tests |
| FR-004 | SC-001 | Stdio fake-process tests |
| FR-005 | SC-002, SC-018 | Streamable HTTP mocked transport tests |
| FR-006 | SC-001, SC-002, SC-018 | Protocol version matrix tests |
| FR-007 | SC-001, SC-002 | Capabilities negotiation tests |
| FR-008 | SC-001, SC-002, SC-014 | Tool discovery pagination/cap tests |
| FR-009 | SC-008, SC-016 | MCP registry/collision/atomic refresh; `src\sdk\AgentSession.test.ts` |
| FR-010 | SC-001 | Preamble assembler tests |
| FR-011 | SC-003, SC-004 | `src\domain\SafetyPolicy.test.ts`; `src\sdk\AgentSession.test.ts`; approval UI |
| FR-012 | SC-003, SC-019 | SafetyPolicy allowlist/session-grant/revocation tests |
| FR-013 | SC-001 | `src\ui\ToolCallBlock`; Undo regressions |
| FR-014 | SC-001, SC-002, SC-006, SC-007 | MCP call adapter; ToolCallBlock rendering |
| FR-015 | SC-011 | Result-normalization tests |
| FR-016 | SC-006, SC-007 | Resilience/disconnect tests |
| FR-017 | SC-001, SC-015 | Reconnect and registry refresh tests |
| FR-018 | SC-006, SC-015 | Stdio auto-reconnect fake-timer tests |
| FR-019 | SC-002, SC-007, SC-012 | HTTP session lifecycle/redaction tests |
| FR-020 | SC-008 | list_changed coalescing/atomicity tests |
| FR-021 | SC-006, SC-007 | Cancellation/Stop tests |
| FR-022 | SC-009 | Env-filter tests |
| FR-023 | SC-009 | PATH builder tests |
| FR-024 | SC-010 | Shutdown fake-process/fake-timer tests |
| FR-025 | SC-002, SC-017 | URL/TLS/SSRF/redirect validation tests |
| FR-026 | SC-005 | Existing full suite; no-MCP smoke test |
| FR-027 | SC-013 | Fake-timer timeout tests |
| FR-028 | SC-014 | Oversized payload/stderr cap tests |
| FR-029 | SC-018 | Protocol/transport compatibility matrix |
| FR-030 | SC-020 | README/Docs.md/CHANGELOG documentation review |
| FR-031 | SC-004 | Approval modal safe-rendering tests |
| NFR-001 | SC-013 | Async discovery/performance check |
| NFR-002 | SC-006, SC-007, SC-010, SC-014 | Failure-mode tests |
| NFR-003 | SC-003, SC-004, SC-009, SC-017 | Security unit tests/manual review |
| NFR-004 | SC-018 | Version/transport matrix tests |
| NFR-005 | SC-005 | Bundle-size build check / documented waiver |
| NFR-006 | SC-004 | Accessibility checklist/tests |
| NFR-007 | SC-005 | Existing 724-test baseline |
| NFR-008 | SC-012, SC-014 | Local diagnostics/status tests |

## Migration / Persistence

- Add `mcpServers: McpServerConfig[]` to existing plugin `data.json`.
- Schema is additive; no v0.4→v0.5 migration is needed beyond defaulting missing `mcpServers` to `[]`.
- Minimum config fields: stable `id`/slug, trust epoch identity, display `name`, `enabled`, `transport`, status/error metadata, plus stdio (`command`, `args`, optional `cwd`, optional `env`) or HTTP (`url`, optional `headers`, including static `Authorization`).
- Persist static HTTP Authorization headers with server config in `data.json`, matching the accepted v0.5 storage posture.
- Persist `mcpAutoApprove` grants by `(stableServerId, toolName)` and revoke grants when a server is renamed, removed, or has `command`, `args`, or `url` changed.
- Do not persist runtime client instances, child handles, in-flight calls, reconnect timers, negotiated capabilities, discovered inventories, server instructions cache, stderr ring buffer, or HTTP `Mcp-Session-Id`.
- Reload reconstructs runtime state by connecting enabled configs; disabled configs remain persisted but inactive.

## Assumptions

- The vault root is available at stdio spawn time and is the safest default `cwd`; users who need another working directory can override per server. [SpecResearch §5.1]
- `child_process.spawn` is available in Obsidian desktop's Electron/Node environment and can be invoked with `shell: false`; Windows `npx` workflows can be represented explicitly as `cmd` plus `["/c", "npx", ...]`. [SpecResearch §2a]
- The exact `@modelcontextprotocol/sdk@1.29.0` client can be bundled through existing esbuild infrastructure and client-only imports can tree-shake server-side paths; if the gzip delta exceeds 80 KB, NFR-005's waiver process applies. [SpecResearch §3]
- The current safety policy exports a top-level `decideSafety(...)` function and `SafetyState`; implementation may refactor names, but the spec anchors behavior to approval-gate outcomes rather than a class method.
- Config-time URL host classification is sufficient for v0.5; runtime DNS rebinding protections beyond configured host/IP checks are future hardening unless planning identifies a low-risk additive check.
- MCP tool annotations and server instructions are untrusted context hints, not security policy inputs. [SpecResearch §5.3, §7.3]

## Scope

### In Scope

- Manual MCP server configuration in Settings for stdio and Streamable HTTP.
- Static HTTP `Authorization` header entry/storage/redaction and plaintext/sync warning.
- Stdio subprocess launch, environment filtering, PATH amendment, stderr diagnostics, bounded I/O, shutdown, and reconnect.
- MCP initialize/initialized lifecycle, version/capability negotiation, bounded `tools/list` pagination, `tools/call`, cancellation, and `notifications/tools/list_changed` refresh.
- SDK registration of MCP tools under `mcp__<server-id>__<tool-name>` synthetic ids with preamble display attribution.
- Universal approval-gate integration, stable server/tool grants, safe approval prompt rendering, and non-undoable MCP calls.
- Crash/disconnect/timeout/oversized-payload recovery and local diagnostics.
- v0.4 baseline preservation.
- README, Docs.md, and CHANGELOG updates for MCP setup, security, troubleshooting, and release notes.

### Out of Scope

- Acting as an MCP server.
- OAuth flow for MCP servers.
- MCP resources, prompts, sampling, elicitation, roots, or server-initiated LLM calls.
- Live registry/browsing of public MCP servers or auto-import from other tools.
- Deprecated HTTP+SSE transport fallback.
- Per-conversation MCP allowlist beyond existing session grant behavior.
- Telemetry, cost accounting, or remote audit reporting for MCP tool usage.
- Full image/audio passthrough to the model.
- Undo journal entries for MCP tool calls.
- Sandboxing/containerization of stdio servers beyond process/env/cwd controls.

## Risks & Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Malicious stdio server exfiltrates ambient credentials. | Token leakage from Obsidian/Electron environment. | FR-004 `shell: false`, FR-022 denylist, explicit env injection, and server trust UI. |
| HTTP server URL targets internal or metadata services. | SSRF-like access to local/private/cloud metadata endpoints. | FR-025 rejects metadata and non-loopback plaintext, warns on private network, and uses normal TLS validation. |
| Redirect leaks static Authorization to another origin. | Credential exposure to attacker-controlled endpoint. | FR-025 limits redirects and drops Authorization on cross-origin redirect. |
| Large frames/results or endless pagination exhaust memory or hang chat. | Plugin instability or degraded Obsidian UX. | FR-008, FR-027, FR-028 cap pages/tools/time/payload sizes and surface diagnostics. |
| Tool name collisions cause spoofing or wrong-server execution. | Built-in tool spoofing or cross-server confusion. | FR-009 synthetic ids, reserved `mcp__` prefix, built-in collision rejection, and atomic refresh. |
| Mutable display names keep stale auto-approve grants. | User may trust a renamed/repointed server unintentionally. | FR-012 keys grants by stable server/tool identity and revokes on rename/command/args/url changes. |
| Auto-reconnect loops consume resources. | Battery/CPU churn and noisy UI. | FR-018 bounded schedule, five attempts per five minutes, terminal crashloop state, manual reset. |
| MCP prompt text injects markdown/HTML into approval UI. | User deception in the approval modal. | FR-031 escapes user-controlled strings and truncates args. |
| SDK bundle delta exceeds target. | Larger plugin package and slower load. | NFR-005 uses 80 KB gzip as sanity check with CHANGELOG waiver and tree-shaking mitigation. |
| v0.4 behavior regresses when MCP is unused. | Existing users lose trust. | FR-026 and NFR-007 require the existing 724/724 baseline and no-MCP smoke coverage. |

## Open Questions

None. The ten known research questions are resolved by the locked decisions in this spec.

## Citations

- [SpecResearch §1.1] MCP initialize/initialized lifecycle and protocol version negotiation.
- [SpecResearch §1.2] `tools/list`, pagination, `tools/call`, result content types, and `isError`.
- [SpecResearch §1.3] `notifications/tools/list_changed` and cancellation.
- [SpecResearch §1.4] Stdio and HTTP shutdown semantics.
- [SpecResearch §2a] Stdio framing, process lifecycle, env inheritance risk, macOS PATH, and Windows invocation.
- [SpecResearch §2b] Streamable HTTP, session management, stale sessions, and deprecated HTTP+SSE.
- [SpecResearch §3] TypeScript SDK v1.x client, transports, notification handlers, and bundle/dependency notes.
- [SpecResearch §4] Reference stdio servers and GitHub hosted Streamable HTTP server with static bearer auth.
- [SpecResearch §5.1] Child-process security, PATH, env filtering, and orphan-process risk.
- [SpecResearch §5.2] TLS validation, static auth header storage posture, and HTTP URL risks.
- [SpecResearch §5.3] MCP tool annotations are untrusted and must not bypass approval.
- [SpecResearch §6.2] VS Code MCP UX conventions for enable/disable, reconnect, and last error.
- [SpecResearch §7] Tools-only capabilities, server capability checks, and server `instructions`.
- [SpecResearch §8] Crash/disconnect, timeout, large-result, and binary-result failure modes.
- [SpecResearch §9] Resolved open questions encoded as locked v0.5 decisions.
- v0.4 `Spec.md` §§User Stories, Edge Cases, Assumptions, Scope, Risks, Functional Requirements, Non-Functional Requirements, Success Criteria, Traceability for heading/table conventions and baseline-preservation style.
