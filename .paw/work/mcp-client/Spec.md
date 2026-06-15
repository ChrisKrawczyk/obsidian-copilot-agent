# Spec — v0.5 MCP Client Integration

## Summary

v0.5 adds MCP client support to obsidian-copilot-agent so users can manually configure external Model Context Protocol servers and surface their tools alongside the existing built-in vault tools. MCP is purely additive: the plugin must work end-to-end when no MCP servers are configured or when all MCP servers are disabled.

The release supports MCP tools only over stdio subprocesses and Streamable HTTP. It performs the MCP initialize/initialized lifecycle, discovers tools with full `tools/list` pagination, registers MCP tools into the existing SDK/session surface, and routes every MCP call through the existing universal approval gate. MCP tools are mutating-by-default and not undoable; approval is required per call unless the user explicitly allows the server through the existing `mcpAutoApprove` path.

Locked v0.5 decisions: advertise protocol version `2025-06-18`; accept `2024-11-05` only over stdio or Streamable HTTP; do not implement deprecated HTTP+SSE fallback; store server config and static HTTP `Authorization` headers in plugin `data.json`; use full-inherit-minus-denylist env filtering for stdio; prepend `/usr/local/bin` and `/opt/homebrew/bin` to macOS subprocess PATH; include server `instructions` in the preamble truncated to 4 KB per server; never persist HTTP `Mcp-Session-Id`; defer/coalesce `notifications/tools/list_changed`; and shut down stdio servers with stdin close → 5 s → SIGTERM → 5 s → SIGKILL. [SpecResearch §1.1, §1.2, §1.3, §1.4, §2a, §2b, §5.1, §5.2, §7.3, §9]

## Goals

- Let users add, edit, remove, enable/disable, reconnect, and inspect manually configured MCP servers in Settings → Copilot Agent → MCP Servers.
- Connect to MCP servers over stdio and Streamable HTTP, negotiate protocol/capabilities, and discover every tool exposed by each connected server.
- Surface MCP tools in the SDK tool list and vault-aware preamble with clear `(MCP / <server-name>)` attribution.
- Preserve existing safety wiring: `SafetySource = "mcp"`, `SafetyPolicy.decideSafety`, `SafetyState.grantMcp`, `AgentSession.buildSafetyInput`, approval prompts, and `mcpAutoApprove`.
- Suppress Undo for MCP tool calls while preserving all existing Undo behavior for vault write tools.
- Survive MCP server crashes, disconnects, stale HTTP sessions, tool-list changes, and plugin unload without crashing or orphaning stdio subprocesses.
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

## Functional Requirements

### FR-001 — Server config persistence
- **Statement:** The plugin MUST persist MCP server configurations in existing plugin `data.json` as additive `mcpServers: McpServerConfig[]`.
- **Acceptance criteria:** Missing field defaults to `[]`; each config has stable `id`, `name`, `enabled`, `transport`, status/error metadata, and transport-specific fields; stdio stores `command`, `args`, optional `cwd`, optional explicit `env`; HTTP stores `url` and optional `headers`; runtime `Mcp-Session-Id` is never persisted.
- **Test hooks:** New persistence tests for MCP config shape; existing sibling-key preservation tests under `src\persistence`.

### FR-002 — Server config lifecycle UI
- **Statement:** Settings MUST allow add, edit, remove, enable, disable, and reconnect for MCP servers.
- **Acceptance criteria:** Add/edit validates transport-required fields; remove confirms and stops active connection; disable stops active connection and hides tools; reconnect performs fresh initialize and updates status/last error; list rows show name, transport, enabled state, connection state, and last error.
- **Test hooks:** New settings UI/controller tests.

### FR-003 — Static HTTP Authorization header
- **Statement:** HTTP configs MUST support a static pasted `Authorization` header stored with the server config in `data.json`, same posture as current token storage.
- **Acceptance criteria:** Header is sent on initialize and subsequent HTTP requests; saved value is redacted in the UI except explicit edit/reveal; removing the server removes the header; no OAuth/PKCE/token refresh is introduced.
- **Test hooks:** HTTP config tests; settings redaction/removal tests.

### FR-004 — Stdio transport
- **Statement:** Enabled stdio servers MUST launch as child processes and speak newline-delimited JSON-RPC over stdin/stdout.
- **Acceptance criteria:** Configured command/args/cwd are used as displayed; stderr is captured only for diagnostics; spawn failure, invalid stdout, or early exit marks server disconnected with last error; Windows users can configure `cmd /c npx ...`; absolute paths always work.
- **Test hooks:** Fake child-process transport tests for launch, stderr, invalid output, and crash.

### FR-005 — Streamable HTTP transport
- **Statement:** Enabled HTTP servers MUST connect with MCP Streamable HTTP and MUST NOT fall back to deprecated HTTP+SSE.
- **Acceptance criteria:** Requests POST to the configured endpoint with required `Accept` headers; server notifications over Streamable HTTP are handled when exposed; stale session/404 reinitializes; legacy-SSE-only endpoint failures surface as unsupported transport errors.
- **Test hooks:** Mocked HTTP transport tests for initialize, request, notification, stale session, and legacy-SSE rejection.

### FR-006 — Protocol version negotiation
- **Statement:** The client MUST advertise `2025-06-18` and accept only `2025-06-18` or `2024-11-05` over stdio/Streamable HTTP.
- **Acceptance criteria:** Initialize sends `protocolVersion: "2025-06-18"`; `2025-06-18` proceeds; `2024-11-05` proceeds only on supported transports; any other version fails with clear last error; post-init HTTP requests include `MCP-Protocol-Version` for the negotiated version.
- **Test hooks:** Version matrix tests.

### FR-007 — Capabilities negotiation
- **Statement:** The client MUST declare no unsupported capabilities and MUST only use tools when `capabilities.tools` is present.
- **Acceptance criteria:** Client capabilities are `{}`; roots/sampling/elicitation/resources/prompts are not advertised; tools-absent servers stay connected but contribute zero tools; `tools.listChanged` registers a notification handler when true.
- **Test hooks:** Capabilities tests for tools present/absent and listChanged registration.

### FR-008 — Full tools/list pagination
- **Statement:** On connect/reconnect, the plugin MUST follow `nextCursor` until `tools/list` is exhausted.
- **Acceptance criteria:** All pages are included; mid-pagination failure marks inventory unavailable with last error; duplicate tool names within a server are rejected or deterministically de-duplicated with visible error.
- **Test hooks:** Tool discovery tests for single page, multiple pages, failures, and duplicates.

### FR-009 — SDK tool registration
- **Statement:** Discovered MCP tools from enabled connected servers MUST register into the agent SDK tool surface without changing built-in vault tool registration.
- **Acceptance criteria:** Registered tool identity is globally unambiguous and preserves server attribution; description/input schema are passed through; disabled/disconnected servers stop contributing tools for subsequent sessions/calls; zero MCP tools behaves like v0.4.
- **Test hooks:** MCP registry tests; `src\sdk\AgentSession.test.ts`.

### FR-010 — Preamble inventory and instructions
- **Statement:** The vault-aware preamble MUST list MCP tools with `(MCP / <server-name>)` and include server `instructions` truncated to 4 KB per server.
- **Acceptance criteria:** Tool entries identify server/source; instructions appear only after initialize and are omitted when absent; each server is independently truncated at 4096 chars with a marker; instructions never change approval policy.
- **Test hooks:** Preamble assembler tests under `src\domain`.

### FR-011 — Universal permission gate routing
- **Statement:** Every MCP tool call MUST route through the existing approval gate as `SafetySource = "mcp"` before execution.
- **Acceptance criteria:** SDK `kind === "mcp"` maps in `AgentSession.buildSafetyInput` to `source: "mcp"` and server-name scope; `SafetyPolicy.decideSafety` requires approval by default; approval prompt shows server/tool/args; rejected calls are not sent to the server.
- **Test hooks:** `src\domain\SafetyPolicy.test.ts`; `src\sdk\AgentSession.test.ts`; approval UI tests.

### FR-012 — MCP auto-approval allowlist
- **Statement:** MCP calls MAY auto-approve only when the user explicitly allows that server via `mcpAutoApprove` or an in-session MCP grant.
- **Acceptance criteria:** `mcpAutoApprove[serverName]` applies to that server only; Approve for session calls `SafetyState.grantMcp` and clears with other session grants; MCP tool annotations such as `readOnlyHint` never bypass approval.
- **Test hooks:** SafetyPolicy MCP tests; AgentSession approve-for-session tests.

### FR-013 — MCP calls are not undoable
- **Statement:** MCP tool calls MUST NOT create Undo journal entries and MUST suppress the Undo button in `ToolCallBlock`.
- **Acceptance criteria:** MCP blocks render status/input/result/error; Undo is absent for MCP success and failure; vault write Undo behavior is unchanged.
- **Test hooks:** `src\ui\ToolCallBlock` tests; Undo regression tests.

### FR-014 — Tool call execution and result rendering
- **Statement:** Approved MCP calls MUST invoke `tools/call` on the originating server and render text, structured, and error results in the existing tool-call surface.
- **Acceptance criteria:** `isError: true` renders as tool execution error; JSON-RPC errors render as protocol errors; structured content is readable; text uses existing truncation behavior.
- **Test hooks:** MCP call adapter tests; ToolCallBlock rendering tests.

### FR-015 — Image/binary placeholders
- **Statement:** MCP image, audio, blob, or other binary result content MUST render as a placeholder such as `[image: <mime>, N bytes]` in v0.5, not raw base64.
- **Acceptance criteria:** Byte count is computed from decoded base64 where possible; audio/blob/resource binary content uses equivalent typed placeholders; text in the same result still renders; base64 is not passed through to the model.
- **Test hooks:** Result-normalization tests for mixed content.

### FR-016 — Crash/disconnect resilience
- **Statement:** MCP server crashes, exits, transport errors, and disconnects MUST never crash the plugin and MUST surface as status changes and tool-call errors.
- **Acceptance criteria:** In-flight failures render failed tool-call blocks; stdio exit records exit code/signal when available; HTTP network failure leaves server eligible for fresh connect on next call; built-in tools/chat remain usable.
- **Test hooks:** Resilience tests for stdio exit, HTTP failure, in-flight rejection, and post-failure built-in use.

### FR-017 — Manual reconnect
- **Statement:** Users MUST be able to reconnect any enabled server, refreshing capabilities, instructions, and full tool inventory.
- **Acceptance criteria:** Reconnect clears volatile transport state including HTTP session id; success updates status/capabilities/tools; failure preserves config and records last error.
- **Test hooks:** Reconnect controller and registry refresh tests.

### FR-018 — Stdio auto-reconnect
- **Statement:** Unexpected stdio disconnects MUST attempt bounded exponential-backoff auto-reconnect while the server remains enabled.
- **Acceptance criteria:** No auto-reconnect for disable/remove/unload; attempts are cancellable and visible in status; success re-runs initialize and full pagination; repeated failure never blocks chat UI.
- **Test hooks:** Fake-timer reconnect tests.

### FR-019 — HTTP session id lifecycle
- **Statement:** HTTP `Mcp-Session-Id` MUST be in-memory only and MUST NOT persist across plugin reloads.
- **Acceptance criteria:** Same-load requests include assigned session id; reload/reconnect starts without old session id and initializes fresh; clean shutdown attempts HTTP DELETE with current session id and tolerates 405.
- **Test hooks:** HTTP session lifecycle tests.

### FR-020 — list_changed coalescing
- **Statement:** `notifications/tools/list_changed` MUST trigger a deferred, coalesced refresh only after no MCP tool call is in flight for that server.
- **Acceptance criteria:** No in-flight call schedules one refresh; multiple notifications coalesce; notification during a call waits until it settles; refresh failure preserves previous inventory and records last error.
- **Test hooks:** Coalescing/concurrency tests.

### FR-021 — Cancellation and Stop
- **Statement:** The plugin MUST handle MCP cancellation notifications gracefully and SHOULD send `notifications/cancelled` when Stop cancels an in-flight MCP call.
- **Acceptance criteria:** Known-request cancellation marks call cancelled/interrupted; unknown or already-complete cancellations are ignored; Stop settles UI state and sends cancellation when request id support exists.
- **Test hooks:** Cancellation/Stop tests.

### FR-022 — Stdio environment filtering
- **Statement:** Stdio subprocess env MUST be full inherit minus denylist, plus explicit per-server env entries.
- **Acceptance criteria:** Denylist includes `GITHUB_TOKEN`, `COPILOT_*`, `COPILOT_AGENT_*`, and plugin-owned auth/session env keys such as any process-env representation of the in-memory GitHub token or `COPILOT_HOME`/base-directory state; Windows matching is case-insensitive; explicit per-server env applies after filtering; ordinary usability vars (`PATH`, `HOME`, `USERPROFILE`, `TMP`, `TEMP`, `TMPDIR`, locale vars) remain unless denied.
- **Test hooks:** Env-filter unit tests for exact keys, wildcard prefixes, Windows case behavior, and explicit overrides.

### FR-023 — macOS PATH amendment
- **Statement:** On macOS stdio launches, subprocess `PATH` MUST prepend `/usr/local/bin` and `/opt/homebrew/bin`.
- **Acceptance criteria:** Prepended paths come before inherited entries; duplicates are harmless/de-duplicated; absolute command paths bypass PATH resolution and remain the documented escape hatch; non-macOS behavior is unchanged except env filtering.
- **Test hooks:** PATH builder tests for macOS/Windows/Linux.

### FR-024 — Stdio shutdown sequence
- **Statement:** Disable/remove/reconnect and plugin unload MUST shut down every spawned stdio server by closing stdin, waiting 5 s, sending SIGTERM, waiting 5 s, then sending SIGKILL.
- **Acceptance criteria:** Clean exit after stdin close sends no kill; still-alive after 5 s receives SIGTERM; still-alive 5 s later receives SIGKILL; unload attempts this for every tracked process and is idempotent.
- **Test hooks:** Fake child-process/fake-timer shutdown tests; plugin unload integration test.

### FR-025 — HTTP URL and TLS posture
- **Statement:** HTTP MCP URLs MUST use normal TLS validation and MUST not silently connect to insecure non-localhost HTTP endpoints.
- **Acceptance criteria:** HTTPS uses default certificate validation; no `rejectUnauthorized: false` option is exposed; HTTP is allowed only for localhost/loopback or requires explicit warning/confirmation; malformed URLs fail validation.
- **Test hooks:** URL/TLS validation tests.

### FR-026 — MCP-disabled baseline
- **Statement:** With no MCP servers configured or all disabled, v0.5 MUST behave like v0.4 for chat, model picker, persistence, approvals, Undo, streaming, Stop, auth, and vault tools.
- **Acceptance criteria:** Empty server list attempts no MCP initialization; disabled servers spawn/open no transports and contribute no tools; existing v0.4 tests remain green at 724/724 before new MCP tests; preamble remains valid without MCP sections.
- **Test hooks:** Existing full suite; new no-MCP smoke test.

## Non-Functional Requirements (NFR)

- **NFR-001 Performance:** `tools/list` discovery for a typical server completes in ≤ 2 seconds and never blocks chat UI.
- **NFR-002 Resilience:** Server crash/malformed response/network failure/timeout never crashes the plugin; failures surface as status/errors.
- **NFR-003 Security:** Env filter, auth-header storage posture, untrusted annotations, TLS validation, and human approval are mandatory controls.
- **NFR-004 Compatibility:** `2025-06-18` and `2024-11-05` work over stdio/Streamable HTTP; HTTP+SSE is intentionally unsupported.
- **NFR-005 Bundle size:** MCP SDK v1.x client paths add ≤ 80 KB gzip to `main.js` as a sanity-check target, or the implementation documents why and verifies server-side SDK paths were tree-shaken.
- **NFR-006 Accessibility:** MCP server settings UI is keyboard-navigable with meaningful labels and accessible last-error text.
- **NFR-007 Baseline preservation:** Streaming, Stop, approval prompts, token rotation, multi-conversation archive flow, Undo journal, raw-FS gating, preamble, model picker/catalog/recovery, lazy modelId resolution, deferred-init recovery, and send-gate precedence remain intact.
- **NFR-008 Observability without telemetry:** Connection state, last error, and stderr/log snippets are locally visible; no telemetry/cost accounting is added.

## Success Criteria (SC)

- **SC-001:** A human configures a reference stdio server, reconnects successfully, sees all tools in the preamble with `(MCP / <server>)`, approves one call, and sees the result without an Undo button.
- **SC-002:** A human configures a Streamable HTTP server with static Authorization, connects, discovers paginated tools, approves one call, and observes negotiated protocol/session headers during that plugin load.
- **SC-003:** An untrusted MCP tool prompts by default; `mcpAutoApprove` or Approve for session allows that server only; tool annotations never bypass approval.
- **SC-004:** With no MCP servers or all disabled, the plugin behaves like v0.4 and the 724/724 baseline remains green.
- **SC-005:** If stdio exits mid-call or HTTP disconnects, the plugin stays running, the call renders an error block, built-in tools remain usable, and reconnect restores tools.
- **SC-006:** Three `tools/list_changed` notifications during one in-flight call cause no mid-call refresh and exactly one post-call refresh.
- **SC-007:** Stdio env excludes `GITHUB_TOKEN`, `COPILOT_*`, `COPILOT_AGENT_*`, and plugin-owned auth/session env keys; macOS PATH starts with `/usr/local/bin` and `/opt/homebrew/bin`; absolute commands work.
- **SC-008:** On unload, every stdio server receives stdin close; non-exiting servers receive SIGTERM after 5 s and SIGKILL after another 5 s; no tracked child is orphaned.
- **SC-009:** Binary MCP result content renders a placeholder such as `[image: image/png, 12345 bytes]` and does not pass base64 to the model.
- **SC-010:** Server configs and static Authorization headers survive reload in `data.json`; runtime `Mcp-Session-Id` values do not survive reload.

## Requirements Traceability table (FR/NFR/SC × test surface)

| Requirement | SCs | Test surface |
|---|---|---|
| FR-001 | SC-010 | MCP config persistence; `src\persistence` sibling-key tests |
| FR-002 | SC-001, SC-005 | Settings UI/controller tests |
| FR-003 | SC-002, SC-010 | HTTP config/redaction/persistence tests |
| FR-004 | SC-001, SC-005 | Stdio fake-process tests |
| FR-005 | SC-002, SC-005 | Streamable HTTP mocked transport tests |
| FR-006 | SC-001, SC-002 | Protocol version matrix tests |
| FR-007 | SC-001, SC-002 | Capabilities negotiation tests |
| FR-008 | SC-002 | Tool discovery pagination tests |
| FR-009 | SC-001, SC-004 | MCP registry; `src\sdk\AgentSession.test.ts` |
| FR-010 | SC-001 | Preamble assembler tests |
| FR-011 | SC-003 | `src\domain\SafetyPolicy.test.ts`; `src\sdk\AgentSession.test.ts`; approval UI |
| FR-012 | SC-003 | SafetyPolicy allowlist/session-grant tests |
| FR-013 | SC-001, SC-009 | `src\ui\ToolCallBlock`; Undo regressions |
| FR-014 | SC-001, SC-002, SC-005 | MCP call adapter; ToolCallBlock rendering |
| FR-015 | SC-009 | Result-normalization tests |
| FR-016 | SC-005 | Resilience/disconnect tests |
| FR-017 | SC-001, SC-002, SC-005 | Reconnect and registry refresh tests |
| FR-018 | SC-005 | Stdio auto-reconnect fake-timer tests |
| FR-019 | SC-002, SC-010 | HTTP session lifecycle tests |
| FR-020 | SC-006 | list_changed coalescing tests |
| FR-021 | SC-005 | Cancellation/Stop tests |
| FR-022 | SC-007 | Env-filter tests |
| FR-023 | SC-007 | PATH builder tests |
| FR-024 | SC-008 | Shutdown fake-process/fake-timer tests |
| FR-025 | SC-002 | URL/TLS validation tests |
| FR-026 | SC-004 | Existing full suite; no-MCP smoke test |
| NFR-001 | SC-001, SC-002 | Async discovery/performance check |
| NFR-002 | SC-005 | Failure-mode tests |
| NFR-003 | SC-003, SC-007, SC-010 | Security unit tests/manual review |
| NFR-004 | SC-001, SC-002 | Version matrix tests |
| NFR-005 | SC-004 | Bundle-size build check |
| NFR-006 | SC-001 | Accessibility checklist/tests |
| NFR-007 | SC-004 | Existing 724-test baseline |
| NFR-008 | SC-005 | Local diagnostics/status tests |

## Migration / Persistence

- Add `mcpServers: McpServerConfig[]` to existing plugin `data.json`.
- Schema is additive; no v0.4→v0.5 migration is needed beyond defaulting missing `mcpServers` to `[]`.
- Minimum config fields: `id`, `name`, `enabled`, `transport`, status/error metadata, plus stdio (`command`, `args`, optional `cwd`, optional `env`) or HTTP (`url`, optional `headers`, including static `Authorization`).
- Persist static HTTP Authorization headers with server config in `data.json`, matching the accepted v0.5 storage posture.
- Do not persist runtime client instances, child handles, in-flight calls, reconnect timers, negotiated capabilities, discovered inventories, server instructions cache, or HTTP `Mcp-Session-Id`.
- Reload reconstructs runtime state by connecting enabled configs; disabled configs remain persisted but inactive.

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
- v0.4 `Spec.md` §§Functional Requirements, Non-Functional Requirements, Success Criteria, Traceability for heading/table conventions and baseline-preservation style.
