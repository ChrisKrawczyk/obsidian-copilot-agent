# Feature Specification: Authenticated MCP Servers

**Branch**: feature/authenticated-mcps  |  **Created**: 2026-06-19  |  **Status**: Draft
**Input Brief**: Let users connect the plugin to MCP servers that require an `Authorization` header — with Microsoft 365 Graph MCP as the marquee preset — without forcing them to paste short-lived bearer tokens.

## Overview

The plugin already speaks MCP over both stdio (local tools like Foam and OneDrive) and HTTP (remote tools). The HTTP path today has no credential story — every request goes out anonymously, which makes the entire class of enterprise MCP servers (Microsoft 365 Graph, GitHub Apps, internal company APIs) unreachable. The most valuable of those for an Obsidian-on-Microsoft user is the **Microsoft 365 Graph MCP server**, which exposes the user's mail, calendar, files, and tenant directory to the agent.

The blocker until now has not been the protocol — the plugin's HTTP MCP transport already negotiates the right protocol version against the live Microsoft endpoint — but the **credentials**. A static bearer token works for about an hour and then forces the user to copy a fresh token out of a terminal. That cadence destroys the experience for anything beyond a demo.

This feature introduces a generalized **credential model** for MCP servers and a built-in preset that wires it up to Microsoft 365 Graph. The two credential variants that ship: a **static bearer** (for the simplest "I have a token, just use it" case) and a **command-based credential** that the plugin re-executes whenever the cached token is near expiry. The latter lets the user lean on whatever token-producing helper they already have on their machine — the Azure CLI's `account get-access-token` command for Microsoft, or any wrapper script the user controls that prints a JSON object containing the bearer token and (optionally) its expiry timestamp. Tools whose native output is a bare token rather than JSON (such as some GitHub CLI sub-commands) are supported by having the user wrap them in a one-line shell helper that emits the expected JSON shape; the plugin itself never accepts a raw-token-on-stdout contract. No in-plugin OAuth flow is involved. The credential model is shaped as a discriminated union so a future in-plugin OAuth 2.1 + PKCE variant slots in without rewriting callers.

The user-visible win: open Settings → MCP servers → Add → pick **Microsoft 365 Graph (via Azure CLI)** → done. The plugin transparently refreshes the token in the background. The user never sees an expiry banner, never pastes a JWT.

## Objectives

- Let users configure HTTP MCP servers that require an `Authorization` header without breaking the experience every hour.
- Generalize beyond Microsoft 365 — any HTTP MCP server reachable via a token-producing shell command works through the same code path.
- Ship Microsoft 365 Graph as a first-party one-click preset (Rationale: the marquee use case; demonstrates the framework works against a non-trivial enterprise server).
- Preserve the existing safety model: a credential refresh is not a new server identity, so trust-epoch grants survive token rotation.
- Surface credential failures clearly in both Settings and chat with actionable, copyable remediation hints.
- Leave a forward-compatible slot for in-plugin OAuth 2.1 + PKCE without locking the data shape today.

## User Scenarios & Testing

### User Story P1 – Connect Microsoft 365 Graph in under a minute

Narrative: A Microsoft employee using Obsidian wants their copilot agent to read their mailbox and calendar via the official M365 MCP server. They open MCP server settings, click "Add server", choose "Microsoft 365 Graph (via Azure CLI)" from the preset dropdown, and click Save. The plugin asks `az` for a token, initializes the MCP session, and lists the available Graph tools. From that point forward, the user can ask the agent "summarize my unread mail" and get an answer without ever touching another auth UI.

Independent Test: From a fresh plugin install, applying the preset (no manual field edits) results in a working MCP server that returns at least one successful tool result in a chat turn.

Acceptance Scenarios:
1. Given the user is signed in to `az` and is on the Microsoft tenant, When they apply the Microsoft 365 Graph preset and save, Then the server row shows status "connected" and the Graph tools appear in the agent's available-tools list within 5 seconds.
2. Given a connected M365 server and an existing chat, When the user asks a question that requires a Graph tool call, Then the agent issues the call, the call returns successfully, and the response references real data from the user's tenant.
3. Given an active M365 server whose token expires during a long chat session, When the next tool call goes out, Then the plugin transparently refreshes the token and the tool call succeeds with no user-visible interruption.

### User Story P2 – Connect any token-producing helper

Narrative: A user wants to point the plugin at a non-Microsoft authenticated MCP server (an internal company server, a self-hosted experiment, or any HTTP MCP server behind a bearer token). They configure the server's URL, choose "Command-based" credentials, paste in the shell command that prints a JSON object containing their auth token (and optionally the JSON paths to the token field and the expiry field), and save. If their preferred CLI prints a bare token instead of JSON (e.g., some GitHub CLI sub-commands), they wrap it in a one-line shell helper that emits the expected JSON shape. The plugin runs the configured command, parses its output, and uses the resulting bearer token until expiry — at which point it re-runs the command. The same plumbing that powers the M365 preset powers their custom server.

Independent Test: Configuring a non-preset HTTP MCP server with a custom credential command results in a connected server whose tools are callable from chat, with at least one observed token refresh logged at debug level.

Acceptance Scenarios:
1. Given a valid HTTP MCP endpoint and a command that prints `{"accessToken": "...", "expiresOn": "..."}` to stdout, When the user configures the server and saves, Then the plugin caches the token and uses it on outbound MCP requests.
2. Given a configured command-based server whose token is within the refresh buffer of expiry, When a tool call goes out, Then the plugin re-runs the command, gets a fresh token, and uses it on that call without surfacing the refresh to the user.
3. Given a custom JSON path configuration (e.g., the user's CLI outputs `{"data": {"token": "..."}}`), When the resolver runs, Then it correctly extracts the token from the configured path.

### User Story P3 – Static bearer for quick experiments

Narrative: A developer wants to try an MCP server they hand-printed a token for. They pick "Static bearer" credentials, paste the token in (the field is masked), save, and start using the server.

Independent Test: Configuring a server with a static bearer results in a connected server where the configured token is stamped on outbound requests.

Acceptance Scenarios:
1. Given a server configured with a static bearer token, When a request goes out, Then the request bears the configured token as its `Authorization: Bearer ...` header.
2. Given a static-bearer server whose token has expired and the server returns 401, When the next request goes out, Then the plugin surfaces a clear "credentials rejected" error in chat with a Settings deep-link.

### User Story P4 – Recover from a broken auth setup

Narrative: A user has the M365 preset configured but isn't signed in to `az` (or `az` isn't installed, or they're on the wrong tenant). They try a Graph query.

Independent Test: When the credential command cannot produce a valid token, the user sees both a row-level error in MCP settings AND a chat-side error that names the remediation command.

Acceptance Scenarios:
1. Given `az` is not on PATH, When the resolver runs, Then the settings row for the server shows an error state with the message "command not found: az" and a hint linking to the M365 doc.
2. Given `az` is on PATH but the user is not signed in, When a tool call attempts to use the server, Then the chat shows a one-line error with a copyable remediation hint such as `az login --tenant 72f988bf-86f1-41af-91ab-2d7cd011db47`.
3. Given the user runs the remediation command and retries, When they invoke a tool, Then the server reconnects automatically without requiring a settings revisit.

### Edge Cases

- The credential command times out (default 15s) → the server enters error state, settings row shows "command timed out", chat shows a copyable remediation hint.
- The credential command exits non-zero or prints non-JSON to stdout → settings row shows "credential command failed (exit N)" and includes the first 200 chars of stderr at debug level (never the stdout body).
- The credential command prints a malformed token (missing `accessToken` field at the configured JSON path) → settings row shows "token field not found at path: <path>".
- The token's `expiresOn` field is missing or unparseable → the plugin treats the token as opaque, uses it once, and re-runs the command on the next request (with rate limiting — minimum 5s between re-runs).
- The server returns HTTP 401 even after a fresh token → the plugin attempts exactly one re-resolve + retry, then surfaces "credentials rejected" with the server's `WWW-Authenticate` header text (if any) for diagnostic context.
- The token survives but the server returns HTTP 403 → the plugin does NOT retry; the user is shown "server denied access — check that you've consented to the required scopes" with a link to the relevant docs.
- Two MCP servers configured to use the same command and the same scope → the plugin still resolves each independently; cross-server token sharing is out of scope (see Assumptions).
- A long chat turn issues many MCP requests during a single token's lifetime → the plugin uses the cached token without re-running the command per request.
- The user changes the credential command in settings → the cached token is invalidated immediately; the next request triggers a fresh resolution.
- The user toggles a server off and back on → cached credentials are retained (the toggle doesn't imply a credential reset).

## Requirements

### Functional Requirements

- FR-001: The plugin SHALL support attaching one credential variant to each HTTP MCP server. Variants supported in this release: none, static-bearer, command-based. (Stories: P1, P2, P3)
- FR-002: The plugin SHALL persist credential configuration per server in the same encrypted-at-rest settings store currently used for sensitive plugin configuration. (Stories: P1, P2, P3)
- FR-003: For `command-based` credentials, the plugin SHALL execute the configured command using a direct process spawn (no shell interpolation) and parse the resulting stdout as JSON. (Stories: P1, P2)
- FR-004: For `command-based` credentials, the plugin SHALL extract the bearer token and expiry timestamp from the parsed JSON, using configurable JSON paths whose defaults match the Azure CLI output (`accessToken`, `expiresOn`). (Stories: P1, P2)
- FR-005: The plugin SHALL cache resolved credentials in memory keyed by server id and re-resolve them when the cached token is within the configured refresh buffer of expiry. (Stories: P1, P2)
- FR-006: The plugin SHALL stamp resolved credentials as the `Authorization` header on outbound HTTP MCP requests for the corresponding server. (Stories: P1, P2, P3)
- FR-007: On HTTP 401 from a server with configured credentials, the plugin SHALL invalidate the cached credential, re-resolve once, retry the request, and on a second 401 surface a "credentials rejected" error to the chat. (Stories: P1, P2, P3, P4)
- FR-008: The plugin SHALL ship a built-in preset named "Microsoft 365 Graph (via Azure CLI)" selectable from the MCP server add dropdown. The preset SHALL pre-fill: URL `https://mcp.svc.cloud.microsoft/enterprise`, transport `http`, credential variant `command-based`, command `az account get-access-token --scope api://e8c77dc2-69b3-43f4-bc51-3213c9d915b4/.default --output json`, refresh buffer 300 seconds. (Story: P1)
- FR-009: The MCP servers settings UI SHALL display per-server credential state including last-resolution outcome, time-to-refresh, and inline error messages with remediation hints when the credential command fails or the server rejects the token. (Stories: P1, P2, P3, P4)
- FR-010: Credential command output, raw token values, and any JSON containing them SHALL NOT be written to logs, telemetry, or notifications at any log level. (Cross-cutting; all stories)
- FR-011: The credential refresh model SHALL NOT cause the existing per-server trust-epoch grants to be revoked. A credential rotation is not a server identity change. (Stories: P1, P2, P3)
- FR-012: The credential configuration schema SHALL reserve an `oauth-pkce` discriminated-union variant whose persisted shape includes (at minimum) the following fields, with the listed types and semantics, such that data written today by the settings UI for this variant — should it ever be present in stored configuration — round-trips losslessly through a save / reload / save cycle of any future plugin version that implements OAuth 2.1 + PKCE:
  - `kind`: string literal `"oauth-pkce"` (variant discriminator)
  - `authorizationEndpoint`: string URL
  - `tokenEndpoint`: string URL
  - `clientId`: string
  - `tenantId`: optional string (null/absent when not applicable)
  - `scopes`: array of strings
  - `redirectUri`: optional string URL
  - `refreshTokenRef`: optional opaque string handle (the plugin's keychain/secret-store reference; never the token itself)
  - `pkceMethod`: optional string, one of `"S256"` or `"plain"` (default `"S256"` when absent)

  This release does not write or read values for this variant at runtime; it MUST, however, preserve any such fields it encounters on load and emit them unchanged on save. (Cross-cutting)
- FR-013: The settings UI SHALL provide a "Test connection" action per HTTP MCP server that performs an MCP `initialize` request and reports success or failure inline, without disturbing the live chat session. (Stories: P1, P2, P3)
- FR-014: When the credential command fails or times out, the plugin SHALL surface a chat-side error on the next tool invocation that includes a copyable remediation hint specific to the configured variant. For the M365 preset specifically, the hint SHALL be the `az login` command — including `--tenant <id>` when a tenant id is available from a prior successful token resolution for that server, and `az login` alone (without `--tenant`) when no prior tenant id is known (first-run failures, fresh installs, or after a user changes the command). (Story: P4)
- FR-015: The credential resolver SHALL enforce a maximum command execution time (default 15 seconds, not user-configurable in this release). (Cross-cutting)
- FR-016: Existing stdio MCP servers (Foam, OneDrive) and unauthenticated HTTP MCP servers SHALL continue to work with no configuration changes. (Cross-cutting)
- FR-017: The credential layer SHALL operate within the plugin's existing HTTP request guardrails (redirect handling, private-IP blocking, allowlist). It SHALL NOT introduce a new outbound HTTP path that bypasses these checks. (Cross-cutting)

### Key Entities

- **MCP Server Configuration**: An entry in the plugin's MCP servers settings. Today has fields `name`, `transport`, `url` (HTTP only), `command`/`args` (stdio only), `enabled`. Gains an optional `credentials` field.
- **Server Credentials**: The new entity. A discriminated union of variants (`none`, `static-bearer`, `command-based`, with a reserved `oauth-pkce` shape). Each variant carries its own configuration fields.
- **Resolved Credential**: The runtime cache entry. Carries the header value to stamp on requests and the timestamp at which it expires (or null for variants without expiry).

### Cross-Cutting / Non-Functional

- The token cache lives in process memory only. It is not persisted across plugin reloads. (Rationale: fresh resolution on every reload is cheap and avoids stale-cache edge cases.)
- Resolved tokens are not surfaced through any debug, log, telemetry, or notification mechanism. Diagnostic messages reference token *presence* and *expiry* only.
- The credential resolver is opt-in per server. Servers without configured credentials retain their current behavior exactly.

## Success Criteria

- SC-001: A user with `az` signed in to the Microsoft tenant can connect the M365 Graph MCP server by selecting the preset and saving — no manual field edits, no manual JSON paste, no separate token copy step. (FR-008, FR-001, FR-003, FR-004, FR-006)
- SC-002: A connected M365 server completes at least one Graph tool call returning tenant-grounded data within 5 seconds of the user's prompt in a real chat turn. (FR-006, FR-008)
- SC-003: A token whose configured expiry crosses while a chat session is active triggers an automatic re-resolution and the subsequent tool call succeeds with no chat-visible interruption. (FR-005, FR-006)
- SC-004: When the credential command fails for any reason, the user sees both a settings row error AND a chat-side error on the next tool invocation, each containing a copyable remediation hint. (FR-009, FR-014)
- SC-005: A custom HTTP MCP server configured with a non-`az` command (for example, a one-line shell helper that wraps a token-producing CLI and emits `{ "accessToken": "...", "expiresOn": "..." }` on stdout) can be connected by adjusting only the configured command and optional JSON path fields — no plugin code changes. (FR-003, FR-004)
- SC-006: No automated test, log file, or notification produced during normal operation, error states, or test runs contains a real access token value or its substring. (FR-010)
- SC-007: All existing 970+ tests continue to pass; the existing stdio MCP servers (Foam, OneDrive) and any pre-existing unauthenticated HTTP server configurations continue to work with zero configuration changes. (FR-016)
- SC-008: A user who saved a credential configuration in this release — including, hypothetically, a configuration written manually with the reserved `oauth-pkce` variant fields enumerated in FR-012 — can open the same vault in a future plugin version that implements that variant and have their stored configuration read cleanly (no migration error, no data loss, no field re-encoding). Tests in this release SHALL cover round-tripping the reserved `oauth-pkce` shape through the persistence layer's save → load → save path and asserting byte-equivalence of every enumerated field. (FR-012)
- SC-009: The plugin's HTTP request guardrails (redirect rules, private-IP block, allowlist) apply to every credential-bearing request just as they do to today's unauthenticated requests. (FR-017)

## Assumptions

- The user has Azure CLI (`az`) installed and on PATH to use the M365 preset. Documenting this in `docs/m365-graph-mcp.md` is sufficient; the plugin does not bundle or install `az`. (Rationale: `az` is already the standard Microsoft developer auth tool; bundling is out of scope.)
- The user's tenant admin has granted Azure CLI the `MCP.*` delegated scopes (or otherwise enabled the M365 MCP server for `az`-issued tokens). Tenants where this hasn't happened will see a 403 from the server; the doc covers the admin-side `Grant-EntraBetaMCPServerPermission` step.
- Credential refresh does not need to share tokens across multiple MCP servers in this release. Each server resolves independently. (Rationale: shared-cache complexity isn't justified until a real use case demands it; today's M365 user has one server entry.)
- Refresh buffer defaults to 300 seconds. Per-server override allowed via configuration; no global default override in this release.
- The command-execution path uses direct process spawn, not a shell. The user types `az account get-access-token --scope ...`; the plugin tokenizes this into argv and spawns directly. (Rationale: avoids shell-injection class of bugs; matches how the plugin's existing stdio MCP transport already resolves CLI commands on Windows.)
- For the "Test connection" action, an MCP `initialize` round-trip is sufficient evidence of working credentials. The action does not need to also call `tools/list` or invoke a real tool.
- The user, not the plugin, is responsible for granting tenant-admin consent. The plugin's role is to surface clear errors when consent is missing and point the user at the relevant remediation docs.

## Scope

In Scope:
- A `ServerCredentials` model with `none`, `static-bearer`, and `command-based` variants.
- HTTP MCP transport integration including 401 re-resolve-and-retry.
- Settings UI for the credential model, the per-server status display, and the test-connection action.
- The "Microsoft 365 Graph (via Azure CLI)" built-in preset.
- A new `docs/m365-graph-mcp.md` user-facing guide.
- Forward-compatible reserved schema for an OAuth 2.1 + PKCE variant.
- Unit + integration tests for the credential resolver, JSON-path extraction, expiry math, 401-retry logic, and preset application.

Out of Scope:
- An in-plugin OAuth 2.1 + PKCE implementation (the reserved schema is the only carry-forward in this release).
- ID-JAG / enterprise-managed SSO.
- An in-plugin Entra app registration flow or any UI for custom client ids.
- Token sharing across multiple MCP servers.
- Auto-detection of installed CLIs in the settings UI (manual configuration only).
- Built-in presets for non-Microsoft authenticated MCP servers (GitHub, etc.) — the framework supports them but no additional presets ship in this workflow.
- Changes to the stdio MCP transport.
- Persistent on-disk caching of resolved tokens.
- Per-tool consent UI changes (the existing SafetyPolicy continues to apply unchanged).

## Dependencies

- The plugin's existing HTTP MCP transport (must be the integration point; no parallel transport is introduced).
- The plugin's existing HTTP request guardrails (redirect, private-IP, allowlist).
- The plugin's existing MCP servers settings panel and its add-server flow.
- The plugin's existing settings persistence layer (and its encryption helper, if one is in use, for storing static-bearer token values).
- The plugin's existing process-spawn primitive used by the stdio MCP transport, including its Windows command path-resolution behavior.
- User-side: Azure CLI installed and signed in (for the M365 preset only).
- Tenant-side: `MCP.*` scope grant on Azure CLI's app id in the user's Entra tenant.

## Risks & Mitigations

- **Risk**: A misconfigured credential command leaks secrets into a log file via stderr or stdout. **Mitigation**: FR-010 prohibits any log path that captures command output verbatim. Diagnostic messages are templated and reference field *names* (e.g., "token field not found at path X") not field *values*. Tests assert log output never contains the test token literal.
- **Risk**: A long-running credential command stalls the plugin's main thread or blocks an in-flight chat turn. **Mitigation**: FR-015 caps execution at 15s; the resolver runs off the UI thread; chat-side errors surface promptly on timeout rather than spinning forever.
- **Risk**: Token refresh thrashing — a malformed `expiresOn` value causes the plugin to re-run the command on every request. **Mitigation**: Edge-case handling enforces a minimum 5s between consecutive resolutions for the same server; an unparseable expiry is treated as "treat once as opaque and rate-limit retries".
- **Risk**: The discriminated-union schema chosen today blocks an elegant future OAuth variant. **Mitigation**: FR-012 enumerates the exact reserved `oauth-pkce` field set (kind, endpoints, clientId, tenantId, scopes, redirectUri, refreshTokenRef, pkceMethod). SC-008 makes round-tripping these fields through save → load → save a test obligation in this release. Any later OAuth implementation can therefore land as a behavior change on a fixed data shape, not a schema migration.
- **Risk**: 401-retry loops against a server that always returns 401 saturate the chat with errors. **Mitigation**: FR-007 caps the retry at exactly one re-resolve attempt per failed request; subsequent failures within a short window for the same server surface a single rolled-up error, not one per tool call.
- **Risk**: Microsoft changes the M365 MCP server endpoint, app id, or scope semantics, breaking the preset. **Mitigation**: The preset is a default users can edit. Settings UI shows the resolved fields; users can pivot to a custom command-based config without a plugin update.
- **Risk**: A user's tenant has different `MCP.*` scope availability and the preset silently issues a token that gets 403'd. **Mitigation**: FR-014 + the 403 edge case ensure the user sees a clear "scopes not consented" message with a docs link, distinguishing it from generic auth failure.

## References

- Issue: none (proposal: `proposals/0001-m365-graph-mcp.md`)
- Spike findings: recorded in `.paw/work/authenticated-mcps/WorkflowContext.md` (Initial Prompt section)
- VS Code MCP auth precedent: https://code.visualstudio.com/docs/agent-customization/mcp-servers
- Microsoft Graph MCP Server onboarding: https://learn.microsoft.com/en-us/graph/mcp-server/get-started
- Custom MCP clients (tenant-side prerequisite): linked from the same Graph MCP docs page (`Grant-EntraBetaMCPServerPermission`)
- AWS `credential_process` (industry precedent for the command-based pattern): https://docs.aws.amazon.com/sdkref/latest/guide/feature-process-credentials.html
