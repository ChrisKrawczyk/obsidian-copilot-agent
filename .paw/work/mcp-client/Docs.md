# v0.5 MCP Client Technical Reference

## Overview

v0.5 adds Model Context Protocol (MCP) client support to obsidian-copilot-agent. The plugin remains an Obsidian and GitHub Copilot client; it does not act as an MCP server. Users can configure external MCP servers, discover their tools, expose those tools to chat under collision-safe synthetic ids, and route every MCP call through the existing approval gate.

MCP is additive. With no configured MCP servers, with all servers disabled, or with disconnected servers, the plugin contributes zero MCP tools and preserves the v0.4 chat, built-in tool, model-picker, and vault Undo behavior.

## Architecture and Design

### Stores

`McpSettingsStore` persists additive `mcpServers` entries in plugin `data.json`. Each server has a stable normalized `id`, display `name`, `enabled` state, deterministic `trustEpoch`, per-server call timeout, and transport-specific fields:

- stdio: `command`, `args`, optional `cwd`, and optional explicit `env` overrides.
- Streamable HTTP: `url` and optional static `authorization` value.

Runtime-only fields such as active `Mcp-Session-Id`, current tool inventory, and server instructions are not persisted. The store preserves unrelated top-level data and drops malformed or duplicate server entries with redacted diagnostics.

`SafetySettingsStore` persists MCP grants in `safety.mcpAutoApprove`. Current grants use the canonical approval key `mcp:<serverId>:<trustEpoch>:<toolName>`. Legacy v0.4-shaped `mcpAutoApprove` keys are preserved on round-trip for compatibility, but they are ignored at decision time unless they already match the v0.5 canonical key.

### Manager and runtime

`McpManager` owns configured server lifecycles for the plugin instance. It reads enabled configs, starts runtimes, publishes immutable status/inventory snapshots, handles manual reconnect, routes synthetic tool calls back to the originating server, coalesces tool-list changes, and coordinates unload.

`McpServerRuntime` owns a single server connection. It performs MCP `initialize`/`initialized`, protocol negotiation, bounded `tools/list` pagination, `tools/call`, cancellation notifications, runtime status, and transport shutdown. Runtime snapshots are redacted before they reach settings, UI, logs, or persistence.

### Transport and security bounds

#### stdio

- Child processes are spawned with `shell: false`; command and arguments are passed separately and never concatenated into a shell string.
- Absolute command paths always work. Non-absolute command lookup uses the process environment after filtering.
- On macOS, `/usr/local/bin` and `/opt/homebrew/bin` are prepended to `PATH` so common Homebrew and npm shims are discoverable.
- The default working directory is the vault root; users may configure an explicit `cwd`.
- The child environment inherits the host environment minus denylisted secrets, then applies explicit env overrides that are also checked for denylist matches.

#### Streamable HTTP

- Only Streamable HTTP endpoints are supported. Legacy HTTP+SSE-only servers are rejected; v0.5 does not fall back to `SSEClientTransport`.
- Non-loopback `http://` URLs are rejected. Remote HTTP servers must use TLS (`https://`).
- TLS bypass options such as `rejectUnauthorized`, `insecure`, and `skipTls` are rejected; there is no UI or config path to disable TLS validation.
- Cloud metadata hosts are rejected outright.
- Private-network hosts, including `10.*`, `172.16.*`-`172.31.*`, `192.168.*`, link-local, and unique-local ranges, require explicit user confirmation before saving.
- Redirects are capped at three hops. Each hop is reclassified; redirects to metadata hosts are rejected and redirects to private networks require the same private-network policy.
- Static `Authorization` is sent only to the configured origin and same-origin redirects. It is dropped on cross-origin redirects.
- HTTP `Mcp-Session-Id` is kept in memory only, redacted everywhere, and cleared on reload, reconnect, stale-session handling, and initialize failure.

### Protocol compatibility

The client advertises MCP protocol version `2025-06-18`. It accepts `2025-06-18` and `2024-11-05` only over the supported stdio or Streamable HTTP transports. Unsupported protocol versions and legacy HTTP+SSE-only servers fail initialize with visible, redacted diagnostics.

## User-Facing Behavior

### Approval scope

Every MCP tool call enters the universal approval gate as source `mcp`. MCP annotations such as `readOnlyHint` never bypass approval. A persistent or in-session MCP grant applies only to the exact tuple:

```text
(serverId, toolName, trustEpoch)
```

The trust epoch is deterministic over the security-relevant identity material:

- stdio: display `name`, transport, `command`, and `args`.
- HTTP: display `name`, transport, and `url`.

Renaming a server or changing those transport identity fields rotates the trust epoch, causing old grants to stop matching. Removing a server clears grants for that server.

### Registry identity

Discovered MCP tools are registered with synthetic ids:

```text
mcp__<serverId>__<toolName>
```

Two different servers may expose the same tool name; their synthetic ids stay distinct because the stable server id is part of the id. Duplicate tool names from the same server are rejected for that server. If an MCP synthetic id would collide with a built-in tool id, the MCP registration is rejected and built-ins win. Disabled, disconnected, error, or crashloop servers contribute zero tools.

### Preamble attribution

The preamble lists MCP tools as:

```text
<tool-name> (MCP / <display-name>)
```

Server `instructions` are included only after initialize, truncated independently per server at 4096 characters, and treated as untrusted text. MCP tool descriptions and instructions can help the model decide which tool to request, but they cannot alter approval policy.

### Result normalization

MCP `tools/call` output is normalized before rendering or model handoff:

- Text content renders as text using existing truncation behavior.
- Structured content is rendered in readable structured form.
- MCP `isError: true` results render as tool execution errors.
- JSON-RPC errors render as protocol errors.
- Resource links render as links/placeholders rather than being fetched implicitly.
- Images, audio, blobs, and other binary payloads render as typed placeholders such as `[image: image/png, N bytes]`.
- Raw base64 is never rendered or passed through to the model.

MCP calls intentionally have no Undo. Vault Undo behavior for built-in vault write tools is unchanged.

## Resilience and Lifecycle

### Timeouts and bounds

- `initialize`: 10 seconds.
- `tools/list`: 10 seconds per page, 30 seconds aggregate discovery per server, 50-page cap, and 1000-tool cap.
- `tools/call`: 60 seconds by default; user-configurable per server up to 300 seconds.
- Oversized frames, bodies, and SSE accumulators fail deterministically rather than exhausting memory.

### Reconnect behavior

stdio reconnect uses exponential backoff of 1, 2, 4, 8, 16, and 32 seconds, then caps at 60 seconds. Five failures inside five minutes put the server in `crashloop` until the user manually reconnects. Manual reconnect cancels any armed timer, resets crashloop/backoff state, and performs one immediate attempt.

Streamable HTTP does not run a background auto-reconnect loop. A failed or stale HTTP session leaves the server eligible for a fresh initialize on the next MCP call or manual reconnect.

Initialize is single-flight per runtime: concurrent callers share the same in-progress initialize/discovery path instead of launching duplicate connections.

### Cancellation

When the user presses Stop during an MCP `tools/call`, the runtime sends:

```json
{ "requestId": <id>, "reason": "user_cancelled" }
```

as `notifications/cancelled`. Cancellation is sent only for cancellable `tools/call` requests and never for `initialize`. Late responses after cancellation are discarded. The only diagnostic for discarded late responses is a redacted `console.debug` entry.

### `notifications/tools/list_changed`

Tool-list changes are coalesced per server. If no call is in flight, one refresh runs. If a call is in flight, notifications are deferred and collapsed into one post-call refresh. Registry replacement is atomic: the old inventory remains visible until the refresh succeeds, and refresh failure preserves the prior inventory while surfacing a redacted error.

### Unload

Plugin unload first settles in-flight MCP tool calls as cancelled before closing transports. Server shutdown proceeds in parallel under a 20-second aggregate cap. stdio shutdown follows stdin close, wait 5 seconds, SIGTERM, wait 5 seconds, then forced kill. Shutdown warnings are redacted.

## Security Posture

### Redaction seams

Every display and persistence sink must pass through redaction before showing or saving diagnostics. `redactSensitive` covers:

- `Authorization` headers and bearer tokens.
- `Mcp-Session-Id` headers and query parameters.
- URL userinfo.
- Token-like query parameters such as `access_token`, `token`, `api_key`, `authorization`, `secret`, and `password`.
- Environment denylist patterns including GitHub/Copilot/OpenAI/Anthropic/Azure OpenAI/AWS/GCP secrets and generic `*_TOKEN`, `*_API_KEY`, `*_SECRET`, and `*_PASSWORD` names.

Static HTTP Authorization values are still stored in plaintext in `data.json` by design for v0.5, matching the existing plugin-data storage posture. Users are warned when adding one.

### Prompt-injection posture

MCP server `instructions`, server names, tool names, tool descriptions, arguments, and results are untrusted prompt-injection surfaces. They are rendered as plain text, escaped in approval UI, and cannot change policy. Users should review the exact requested arguments before approving an MCP call.

### DNS-rebinding deferral

Full runtime DNS-rebinding protection is explicitly deferred for v0.5. The implemented mitigation is to reject cloud metadata targets, classify configured hosts and every redirect hop, require confirmation for configured private-network targets, and reject metadata or unconfirmed private-network redirects according to the same URL policy. There is no TLS bypass option.

## Testing and Verification

Human verification for v0.5 should cover one stdio server and one Streamable HTTP server, confirm connected tools appear with `(MCP / <display-name>)` attribution, approve and reject at least one MCP call, press Stop during a long-running `tools/call`, and verify no Undo button appears for MCP results.

Regression gates for the documentation phase are:

```text
npm run typecheck
npm run build
npm test
```

The final v0.5 documentation pass leaves the Phase 6 test count unchanged at 944 passing tests.

## Limitations and Future Work

v0.5 intentionally does not include OAuth for MCP servers, MCP resources/prompts/sampling/elicitation/roots, public server registry browsing, per-conversation MCP allowlists, telemetry, cost accounting, full image/audio passthrough, MCP Undo, process sandboxing, or full DNS-rebinding protection.

## Traceability

- Spec: `.paw\work\mcp-client\Spec.md`, especially FR-001 through FR-031, NFR-003, NFR-005, and SC-020.
- Implementation plan: `.paw\work\mcp-client\ImplementationPlan.md`, Phases 1-7.
- Requirements Traceability Matrix: `.paw\work\mcp-client\ImplementationPlan.md` lines 405-472 map FRs, NFRs, and success criteria to phases and tests.
- Documentation requirement: FR-030 and Phase 7.
