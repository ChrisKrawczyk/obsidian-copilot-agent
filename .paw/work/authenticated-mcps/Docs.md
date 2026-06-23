# v0.7 Authenticated MCP Servers Technical Reference

## Overview

v0.7 adds **authenticated MCP server support** to obsidian-copilot-agent.
The plugin continues to act as an MCP client; this release teaches the
HTTP transport how to fetch fresh credentials per request, ships a
preset registry, and lands the first preset for the Microsoft 365
Graph MCP server.

The credential model is **additive and backward compatible.** Existing
v0.5 / v0.6 servers (stdio and HTTP, with or without a static
`Authorization`) load unchanged, including their stored shape — a v0.6
HTTP server with `authorization: "Bearer <token>"` is migrated to the
new `static-bearer` credential variant in memory but the on-disk shape
is preserved unless re-saved through the new settings UI.

## Architecture and Design

### Credential schema

`ServerCredentials` is a discriminated union (`src/mcp/credentials/CredentialTypes.ts`):

- `none` — anonymous server.
- `static-bearer` — `{ kind, token }`. Token is written to `data.json`
  in plaintext (parity with v0.5/v0.6 `authorization`). Plaintext is
  documented; the settings UI warns at edit time.
- `command-based` — `{ kind, command, tokenPath, expiryPath, refreshBufferSeconds }`.
  Token resolved by spawning a process; never persisted.
- `oauth-pkce` — **reserved.** Fully enumerated field set (kind,
  endpoints, clientId, tenantId, scopes, redirectUri, refreshTokenRef,
  pkceMethod). Persistence round-trips byte-equivalently
  (`McpSettingsStore.test.ts`) but no runtime resolver is wired.

The settings store migrates any pre-v0.7 server with a top-level
`authorization` string into an in-memory `static-bearer` credential on
read. Writes preserve the new shape.

### Resolver and runner

`CredentialResolver` (`src/mcp/credentials/CredentialResolver.ts`) is
pure: given a `ServerCredentials` and an injected `CommandRunner` +
clock, it returns the access token (and, for command-based, caches it
until `expiresOn - refreshBufferSeconds`). Cache is per-resolver-
instance and in-memory only. Each `McpManager` owns one resolver.

`SpawnCommandRunner` (`src/mcp/credentials/SpawnCommandRunner.ts`)
spawns commands without a shell (`shell: false`), capturing stdout
within a configurable byte cap and enforcing a hard timeout. Windows
specifics:

- Bare commands (no extension) are resolved via `PATHEXT` before
  spawn. `az` resolves to `az.cmd` on a typical install.
- `.cmd` / `.bat` targets are wrapped in `cmd.exe /d /s /c` to
  preserve the shebang-less batch interpreter semantics that
  Node's `spawn` otherwise mishandles.
- `setTimeout` / `clearTimeout` are captured at constructor time as
  arrow wrappers so calls survive Obsidian's renderer process, where
  the receiver of the bare global must be `globalThis`.

### HTTP fetch integration

`McpServerRuntime.createMcpHttpFetchWrapper` (`src/mcp/McpServerRuntime.ts`)
threads the resolver into the SDK's `StreamableHTTPClientTransport`:

- Before each initial-hop fetch the wrapper calls
  `options.getAuthorization()` and either sets or deletes the
  `Authorization` header. Existing v0.5 cross-origin-strip and
  redirect-cap policies run unchanged on subsequent hops; cross-
  origin redirects do **not** re-inject the dynamic value.
- On a 401 with the previous token, `McpManager` invalidates the
  resolver cache for that server, asks for a fresh token, and retries
  the call exactly once (`McpManager.credentials.test.ts`).
- HTTP 405 is passed through to the SDK as a `Response`, not thrown,
  because the SDK treats 405 on the optional SSE GET stream and on
  the session DELETE as the spec's "feature not supported" signal.
- All other ≥400 responses still throw `McpHttpError` with the
  redacted `WWW-Authenticate` value preserved for error formatting.

### Obsidian fetch adapter

Obsidian's Electron renderer enforces CORS on `fetch`. The Microsoft
Graph MCP server (and most enterprise MCP servers) does not emit
`Access-Control-Allow-Origin: app://obsidian.md`. `src/mcp/transport/obsidianFetch.ts`
adapts Obsidian's `requestUrl()` API to a `fetch`-compatible
signature, routing requests through the Electron main process where
CORS does not apply. `src/main.ts` injects this adapter as the
`fetch` option on `McpManager`. The runtime falls back to
`globalThis.fetch.bind(globalThis)` when no adapter is supplied (test
environments).

Trade-offs accepted:

- `requestUrl` follows HTTP redirects internally; the manual-redirect
  policy in `createMcpHttpFetchWrapper` therefore only sees the
  initial URL and the final response. Pre-fetch URL validation
  (private-network, metadata block) still applies. Cross-origin
  `Authorization` strip on intermediate hops is currently a
  trust-but-verify property of `requestUrl` — out of scope to fix in
  v0.7.
- Response body is fully buffered before being synthesized into a
  `Response`. MCP initialize / list / call complete with a single
  response, so this is acceptable.

### Preset registry

`src/settings/presets/McpServerPresets.ts` exposes a frozen
`BUILT_IN_PRESETS` array. A preset's `build()` returns a partial HTTP
server config + a `ServerCredentials` value + an optional preflight
descriptor. The settings UI's Add Server flow surfaces presets in a
dropdown; selecting one populates the form. The shipped preset is
**M365 Graph (via Azure CLI)**, pinned to FR-008 values and asserted
by a snapshot test.

### Preflight

`src/settings/isCommandOnPath.ts` resolves bare commands against the
process `PATH` (with `PATHEXT` probing on Windows). The settings UI
calls it after a preset is selected and surfaces a non-blocking
install hint when the command is missing. Saving is never blocked by
a failing preflight (FR-018).

### Remediation formatter

`src/mcp/credentials/M365RemediationFormatter.ts` (wired in
`src/main.ts`) attaches a remediation hint to chat-side credential
failures. The default branch detects whether `az` is on PATH; absent,
the hint links to the Azure CLI install docs. Present but failing,
the hint suggests `az login --tenant <tenant>`. Custom commands
fall through to a generic "check your credential command" message.

## Known limitations

### Permission scopes via `az`

The M365 Graph MCP server publishes only
`api://e8c77dc2-.../.default` as a supported scope. Calls that touch
Microsoft Graph areas beyond what the Azure-CLI client's pre-consent
covers (typically `User.Read`) return **HTTP 403** server-side via
the OBO exchange. This is documented in
[`docs/m365-graph-mcp.md`](../../../docs/m365-graph-mcp.md) §
"Permission scopes and 403 errors". The forward path is tracked in
[`proposals/0006`](../../../proposals/0006-tool-picker-and-scope-aware-credentials.md)
and [`proposals/0007`](../../../proposals/0007-importable-preset-packs.md).
v0.7 ships with this limit documented and accepted.

### Obsidian renderer environment

Three V8-strict-mode binding issues are mitigated rather than fixed
upstream:

- `setTimeout`/`clearTimeout` rebinding (see Spawn runner section).
- `fetch` requires `globalThis` receiver — `boundFetch()` uses
  `globalThis.fetch.bind(globalThis)`.
- `az` resolves to `az.cmd` on Windows; Node's `spawn(..., { shell: false })`
  does not consult `PATHEXT`. The resolver does, then dispatches via
  the existing `cmd /d /s /c` wrapper.

All three are covered by regression tests in
`src/mcp/credentials/SpawnCommandRunner.test.ts` and
`src/mcp/McpServerRuntime.httpFetch.test.ts`.

### No OAuth implementation

`oauth-pkce` is schema-only. Manual smoke for SC-001 / SC-002
confirmed identity-level Graph calls work end-to-end; broader scopes
need either the OAuth implementation or an alternative per-product
MCP source (see proposal 0007 for importable preset packs as the
distribution mechanism).

## Files

| Area | Path |
| --- | --- |
| Credential types | `src/mcp/credentials/CredentialTypes.ts` |
| Pure resolver | `src/mcp/credentials/CredentialResolver.ts` |
| Spawn runner | `src/mcp/credentials/SpawnCommandRunner.ts` |
| Remediation formatter | `src/mcp/credentials/M365RemediationFormatter.ts` |
| HTTP fetch wrapper | `src/mcp/McpServerRuntime.ts` (`createMcpHttpFetchWrapper`, `boundFetch`) |
| Obsidian fetch adapter | `src/mcp/transport/obsidianFetch.ts` |
| Settings store migration | `src/settings/McpSettingsStore.ts` |
| Settings form logic | `src/settings/mcpServerFormLogic.ts` |
| Settings UI | `src/settings/McpServersSection.ts` |
| Preset registry | `src/settings/presets/McpServerPresets.ts` |
| Command preflight | `src/settings/isCommandOnPath.ts` |
| Manager wiring | `src/main.ts` |

## References

- Spec: [`.paw/work/authenticated-mcps/Spec.md`](Spec.md)
- Plan: [`.paw/work/authenticated-mcps/ImplementationPlan.md`](ImplementationPlan.md)
- Code research: [`.paw/work/authenticated-mcps/CodeResearch.md`](CodeResearch.md)
- User guide: [`docs/m365-graph-mcp.md`](../../../docs/m365-graph-mcp.md)
- Smoke checklist: [`SmokeChecklist.md`](SmokeChecklist.md)
- Prior MCP reference: [`.paw/work/mcp-client/Docs.md`](../mcp-client/Docs.md)
- Original proposal: [`proposals/0001-m365-graph-mcp.md`](../../../proposals/0001-m365-graph-mcp.md)
- Forward proposals: [`proposals/0006`](../../../proposals/0006-tool-picker-and-scope-aware-credentials.md), [`proposals/0007`](../../../proposals/0007-importable-preset-packs.md)
