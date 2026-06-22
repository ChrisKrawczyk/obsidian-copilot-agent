# Authenticated MCP Servers Implementation Plan

## Overview

Add a `credentials` field to HTTP MCP server configs supporting three behavioral variants (`none`, `static-bearer`, `command-based`) plus a reserved-but-inert `oauth-pkce` shape that round-trips losslessly through save/load. A runtime credential resolver caches tokens in memory per server, executes user-configured commands with a hard 15s timeout (direct spawn, `shell: false`), parses JSON output via configurable dotted paths, and stamps the `Authorization` header on every outbound HTTP MCP request through the existing `createMcpHttpFetchWrapper` path — so credentials never bypass redirect / private-IP / metadata-host guardrails (FR-017). On HTTP 401, the resolver invalidates the cache and the manager re-resolves + retries exactly once; a second 401 surfaces a single chat-side "credentials rejected" error with a copyable remediation hint (FR-007, FR-014). A preset registry seeds a single "Microsoft 365 Graph (via Azure CLI)" entry that pre-fills URL, command, and refresh buffer (FR-008). Settings UI gains a credential editor, masked inputs, last-resolution state, a Test-connection action that issues a one-shot `initialize` on a transient runtime, and a preset-time preflight `findOnPath` probe (FR-013, FR-018). Trust-epoch material is unchanged so credential rotation does not revoke MCP approvals (FR-011). Documentation explicitly calls out the plaintext-on-disk reality of static-bearer values (FR-002) and recommends command-based for long-lived secrets.

## Current State Analysis

- HTTP transport stamps a static `authorization` string into `requestInit.headers` once at transport creation and never re-evaluates it (`src/mcp/McpServerRuntime.ts`).
- `McpHttpServerConfig` carries `authorization?: string` but no credential variant. Settings persist under `mcpServers` in plugin `data.json` with unknown-key preservation (`src/mcp/McpTypes.ts`, `src/settings/McpSettingsStore.ts`).
- HTTP guardrails (URL classification, redirect cap, cross-origin auth stripping, body limits, TLS-bypass rejection) flow through `createMcpHttpFetchWrapper` + `httpPolicy.ts`. The credential layer must integrate WITHOUT a parallel path.
- No 401-specific branch today: `McpManager.callTool` clears volatile session/inventory on any HTTP failure and rethrows a redacted error string. The wrapper today does not surface the underlying HTTP status, so a typed error carrier is needed.
- Trust epoch for HTTP servers covers `name`, `transport`, `url` only; runtime identity excludes auth material. Grant revocation triggers off trust-epoch change in settings. FR-011 requires this invariant to be preserved (and tested).
- Settings form is a single modal with manual fields and no preset registry. Validation/build is DOM-free in `mcpServerFormLogic.ts` and tested in isolation — preserve this invariant for the new logic.
- Direct spawn pattern (`shell: false`, `windowsHide: true`) and Windows `findOnPath` already exist for stdio transport but are not factored out as utilities. The credential command runner shares the same hardening needs.
- Redaction helper `redactSensitive` covers Authorization, Bearer, Session-Id, userinfo, env tokens.
- **No encryption layer / OS-keychain helper exists.** Settings persist as plaintext JSON in the vault's plugin data file. Static-bearer token values therefore land on disk in plaintext (acknowledged in spec FR-002).
- Test baseline: **1107 passing tests across 72 files**, node-only Vitest environment, no DOM. Pattern for UI testability: refactor logic into pure sibling modules (`mcpServerFormLogic.ts` next to `McpServersSection.ts`, `chatKeydown.ts` next to `ChatView.ts`).
- No `docs/` directory exists today. README + `proposals/` are the current user-facing anchors. The new `docs/m365-graph-mcp.md` is the first content under `docs/`.

## Desired End State

- Discriminated `ServerCredentials` union (`none` | `static-bearer` | `command-based` | reserved `oauth-pkce`) persists alongside HTTP server configs and round-trips losslessly with byte equality on every enumerated `oauth-pkce` field (FR-012, SC-008).
- A pure `CredentialResolver` resolves the live `Authorization` value on demand, caches per `serverId`, honors a 300s default refresh buffer, rate-limits re-runs to ≥5s when expiry is missing, and never logs token material (FR-005, FR-010).
- `McpServerRuntime` requests the header from the resolver immediately before each outbound HTTP send via a `getAuthorization` callback passed through the fetch wrapper (transport `fetch` and best-effort DELETE both honor it). `McpManager` performs exactly one re-resolve + retry on HTTP 401 and surfaces a single chat error on the second 401, distinguishable from a 403 (FR-006, FR-007).
- A `PresetRegistry` exposes "Microsoft 365 Graph (via Azure CLI)" with pre-filled URL `https://mcp.svc.cloud.microsoft/enterprise`, command `az account get-access-token --scope api://e8c77dc2-69b3-43f4-bc51-3213c9d915b4/.default --output json`, refresh buffer 300s; the add-server form lists it in a preset dropdown (FR-008).
- Settings UI shows per-server credential state (last outcome, time-to-refresh, redacted error + remediation hint), provides a Test-connection button that performs an isolated MCP `initialize` round-trip without disturbing the live runtime, and runs a preflight `findOnPath('az')` probe at preset selection with a non-blocking install hint when missing (FR-009, FR-013, FR-018).
- Credential changes do NOT rotate trust epoch — existing grants survive across token rotation (FR-011, locked by regression test).
- `docs/m365-graph-mcp.md` documents preset usage, plaintext-storage caveat with recommendation to prefer command-based, `az login` remediation, tenant-side `Grant-EntraBetaMCPServerPermission` prerequisite, and the JSON-output shape for custom commands.
- All 1107 existing tests continue to pass. New tests cover schema round-trip, resolver behavior (pure + spawn), 401-retry, trust-epoch invariance, preflight detection, and preset application.

## What We're NOT Doing

- **No in-plugin OAuth 2.1 + PKCE behavior.** Only the schema slot is reserved (FR-012). No browser/system-handler integration, no PKCE code, no refresh-token storage.
- **No keychain / OS-secret-store integration.** Static-bearer values remain plaintext in `data.json`; we document this, not encrypt it.
- **No new HTTP transport.** All credential-bearing traffic continues through `StreamableHTTPClientTransport` + `createMcpHttpFetchWrapper` so FR-017 is satisfied by construction.
- **No changes to stdio MCP transport behavior** (FR-016) — the only stdio-adjacent change is extracting `findOnPath` to a reusable module; the existing test surface must stay green unchanged.
- **No persistent on-disk token cache.** Cache lives in resolver memory only and is cleared on plugin reload.
- **No cross-server token sharing.** Each server resolves independently even if the configured commands are identical.
- **No additional presets** beyond M365 — the registry shape supports them but only M365 ships in this workflow.
- **No global refresh-buffer override**, no user-configurable command timeout (15s fixed, FR-015).
- **No per-tool consent UI changes** — SafetyPolicy continues unchanged.
- **No auto-detection of installed CLIs** beyond the M365 preset's `findOnPath` preflight.
- **No trust-epoch rotation on credential edits** — explicit non-goal (FR-011).
- **No retry on HTTP 403** — distinct UI path (scopes/consent message); user is pointed at the tenant-admin grant docs.
- **No interactive prompts triggered by preflight** — `az --version` only; never `az login`.
- **No automatic CLI installation**, no telemetry, no analytics.

## Phase Status

- [ ] **Phase 1: Credential schema, types, and persistence round-trip** — Discriminated union; `oauth-pkce` reserved fields preserved.
- [ ] **Phase 2: Pure credential resolver utility** — JSON path, expiry math, in-memory cache, rate limit; no I/O.
- [ ] **Phase 3: Command runner backend with timeout** — Direct spawn, 15s cap, shared `findOnPath` extracted.
- [ ] **Phase 4: HTTP transport integration + 401 retry + trust-epoch invariance** — Header stamped per request via resolver callback; exactly-one retry; grants survive rotation.
- [ ] **Phase 5: Preset registry, settings UI, Test connection, preflight** — Data-driven preset + DOM-thin UI with all logic in pure helpers.
- [ ] **Phase 6: Documentation** — `docs/m365-graph-mcp.md`, README, CHANGELOG, PAW Docs.md, smoke checklist.

## Phase Candidates

<!-- No additional implementation phases planned beyond the scoped release path above. -->

---

## Phase 1: Credential schema, types, and persistence round-trip

**Covers:** FR-001, FR-002, FR-012, FR-016; SC-007, SC-008

### Changes Required:
- **`src/mcp/McpTypes.ts`**: Add `ServerCredentials` discriminated union with kinds `none` | `static-bearer` | `command-based` | `oauth-pkce` (reserved). Field set per kind:
  - `none`: `{ kind: "none" }`
  - `static-bearer`: `{ kind: "static-bearer", token: string }`
  - `command-based`: `{ kind: "command-based", command: string, args?: string[], tokenPath?: string, expiryPath?: string, refreshBufferSeconds?: number }` — `args` is the canonical post-parse argv; `tokenPath` and `expiryPath` default to `accessToken` / `expiresOn` (matching Azure CLI output); `refreshBufferSeconds` defaults to 300.
  - `oauth-pkce`: exact field set enumerated in FR-012 (`kind`, `authorizationEndpoint`, `tokenEndpoint`, `clientId`, `tenantId?`, `scopes[]`, `redirectUri?`, `refreshTokenRef?`, `pkceMethod?`).
  
  Add optional `credentials?: ServerCredentials` to `McpHttpServerConfig`. Keep legacy `authorization?: string` for one release of read-only backward compatibility.
- **`src/settings/McpSettingsStore.ts`**: Extend the parser to accept `credentials` for HTTP entries, validating the discriminator and known fields per kind. Preserve any extra fields on `oauth-pkce` via the existing unknown-key index-signature pattern. Migrate legacy `authorization: "<token>"` to `credentials: { kind: "static-bearer", token: "<token>" }` on load (without rewriting the file unless the user touches it). Ensure `stripRuntimeFields` does not strip credential subfields. Ensure persistence emits `credentials` unchanged.
- **`src/settings/mcpServerFormLogic.ts`**: Update the HTTP form result contract so it emits canonical credential configs instead of raw `authorization`, while preserving unauthenticated HTTP behavior when no credential variant is selected (variant `none`).
- **`src/mcp/credentials/CredentialTypes.ts`** (new): Type guards (`isCommandBased`, `isStaticBearer`, etc.) and constant defaults (`DEFAULT_TOKEN_PATH = "accessToken"`, `DEFAULT_EXPIRY_PATH = "expiresOn"`, `DEFAULT_REFRESH_BUFFER_SECONDS = 300`).
- **Tests**:
  - `src/mcp/credentials/CredentialTypes.test.ts`: type-guard and default exports.
  - `src/settings/McpSettingsStore.test.ts`: add cases for each variant; assert byte-equivalent save → load → save round-trip for `oauth-pkce` with the FULL FR-012 field set (SC-008); assert legacy `authorization` migrates to `static-bearer` on load; assert runtime credential status fields never serialize.
  - `src/settings/mcpServerFormLogic.test.ts`: variant switching, command-line parsing, canonical argv emission.

### Success Criteria:

#### Automated Verification:
- [ ] Tests pass: `npm test`
- [ ] Typecheck: `npm run typecheck`
- [ ] New round-trip test asserts every FR-012 field survives save → load → save with byte equality (SC-008).

#### Manual Verification:
- [ ] Hand-edit `data.json` to include an `oauth-pkce` credential block on an HTTP server; reload plugin; reopen settings; export `data.json`; diff the credential block — no changes.
- [ ] Existing unauthenticated HTTP and stdio MCP server entries still load without migration errors; an existing entry with a legacy `authorization` string still works.

---

## Phase 2: Pure credential resolver utility

**Covers:** FR-005, FR-010 (resolver scope), FR-015 (timeout contract surfaces here); SC-006 (logging redaction)

### Changes Required:
- **`src/mcp/credentials/jsonPath.ts`** (new): Pure helper `extractAtPath(obj: unknown, dotPath: string): unknown` supporting dotted keys only (no brackets, no array indices in this release). Returns `undefined` if any segment missing.
- **`src/mcp/credentials/expiry.ts`** (new): Pure helpers `parseExpiry(value: unknown): number | null` accepting ISO-8601 strings, Unix epoch numbers (seconds or ms detected by magnitude), and Azure CLI's `"YYYY-MM-DD HH:mm:ss.SSSSSS"` form. Returns null for missing/unparseable.
- **`src/mcp/credentials/CommandRunner.ts`** (new, interface only this phase): `interface CommandRunner { run(argv: string[], timeoutMs: number): Promise<{ stdout: string; stderr: string; exitCode: number; timedOut: boolean }> }`. Real implementation lands Phase 3; a fake is used here for tests.
- **`src/mcp/credentials/CredentialResolver.ts`** (new): `CredentialResolver` class with injected deps (clock, `CommandRunner`, redacted logger). Public surface:
  - `resolve(serverId: string, credentials: ServerCredentials): Promise<{ authorization: string; expiresAt: number | null; tenantId: string | null } | null>`
  - `invalidate(serverId: string): void` — called on 401 and on credential-config change
  - `clear(serverId: string): void` — called on server removal
  
  Internal cache keyed by `serverId`. Returns cached entry when `now < expiresAt - refreshBuffer`. Enforces minimum 5s between re-resolves per server (rate-limit guard for missing/unparseable `expiresOn`). Static-bearer returns immediately with `expiresAt = null, tenantId = null`. `none` returns `null`. `oauth-pkce` returns a structured "not implemented in this release; see docs" error that downstream code converts into a user-facing remediation hint.

  **Tenant-id capture (FR-014 input)**: After a successful command-based resolution, the resolver attempts to extract a non-secret `tenantId` value from the resolved JSON in this priority order: (1) a top-level `tenant` field (Azure CLI's `az account get-access-token` JSON output includes this); (2) the `tid` claim parsed from the JWT payload (the access token's middle segment, base64url-decoded — note: the resolver decodes only the JWT *header* and *payload* claims, never the signature, and treats the payload as opaque metadata; `tid` is a non-secret GUID, not credential material). The extracted `tenantId` is cached alongside the token. Tests assert that extraction failure leaves `tenantId = null` and that the value never appears prefixed/suffixed by token bytes in any log output (FR-010).
- **Tests**:
  - `src/mcp/credentials/jsonPath.test.ts`: dotted key happy path, missing segment, non-object values, leading/trailing dots.
  - `src/mcp/credentials/expiry.test.ts`: ISO, epoch s, epoch ms, Azure CLI string, garbage strings, null/undefined.
  - `src/mcp/credentials/CredentialResolver.test.ts` with a fake clock + fake `CommandRunner`. Cases: static-bearer pass-through; cache hit within refresh buffer; cache miss outside refresh buffer re-runs the command; missing expiry → opaque-once then 5s rate limit; `invalidate()` clears cache forcing next resolve; command failure surfaces structured error (exit code, redacted stderr capped at 200 chars); JSON parse failure surfaces structured error referencing field *names* only (FR-010); `oauth-pkce` surfaces "not implemented" structured error; **tenant-id extraction** — happy path from `tenant` field; happy path from JWT `tid` claim when `tenant` field absent; both absent → `tenantId = null`; malformed JWT → `tenantId = null` and no exception; cached `tenantId` survives subsequent cache hits.
  - Logging-sink assertion: no token literal or substring ever appears in any captured log/error message (SC-006).

### Success Criteria:

#### Automated Verification:
- [ ] Tests pass: `npm test`
- [ ] Typecheck: `npm run typecheck`
- [ ] Coverage includes the "log sink contains no token substring" assertion (SC-006).

#### Manual Verification:
- N/A (pure module phase).

---

## Phase 3: Command runner backend with timeout

**Covers:** FR-003, FR-004, FR-015

### Changes Required:
- **`src/mcp/transport/findOnPath.ts`** (new): Extract the existing Windows `findOnPath` implementation from `StdioTransport.ts` (the block using `path.win32` for `.cmd` / `.exe` resolution) into a standalone reusable module. Update `StdioTransport.ts` to import from the new module so existing tests stay green unchanged.
- **`src/mcp/credentials/argv.ts`** (new): Re-export or wrap the `parseArgs` helper already living in `mcpServerFormLogic.ts` so command strings can be tokenized once at validation time and the canonical `args[]` persisted in config.
- **`src/mcp/credentials/SpawnCommandRunner.ts`** (new): Implements `CommandRunner` (interface defined Phase 2) using `child_process.spawn` with `shell: false`, `windowsHide: true`, and a filtered env mirroring `StdioTransport.start()`. Enforces the hard timeout via `setTimeout` + `child.kill('SIGKILL')` after grace. Collects stdout/stderr into bounded buffers (stderr capped at 200 chars before discard to honor FR-010 and the spec's edge-case rule). Resolves `{ stdout, stderr, exitCode, timedOut }` even on failure paths.

  **Windows `.cmd` execution contract**: On Windows, `az` is typically installed as `az.cmd` (a batch wrapper). Node's `child_process.spawn` with `shell: false` cannot directly execute `.cmd`/`.bat` files. The runner therefore mirrors the existing pattern used by `StdioTransport` for this exact case: after `findOnPath` resolves the executable path, if the resolved file extension is `.cmd` or `.bat`, the runner spawns `process.env.ComSpec` (or `cmd.exe`) with `/d /s /c` plus the resolved path and argv as a SINGLE argv array — NOT as a joined command-line string — so cmd.exe's parser receives properly quoted arguments via Node's existing Windows argv-quoting (avoiding shell-metacharacter injection). `shell: false` is preserved on the spawn call itself. Argv passed through to the underlying executable is NEVER interpreted by a shell, even when cmd.exe is the wrapper. This satisfies FR-003's "direct spawn (no shell interpolation)" contract for the user-controlled argv tail.
- **`src/main.ts` or equivalent wiring point**: Construct a single `CredentialResolver(new SpawnCommandRunner(), realClock, redactedLogger)` per plugin instance and pass it into `McpManager`. (No actual integration wiring yet — that's Phase 4.)
- **Tests**:
  - `src/mcp/transport/findOnPath.test.ts`: factored from existing stdio tests; covers the Windows `.cmd` / `.exe` resolution behavior with no regressions.
  - `src/mcp/credentials/SpawnCommandRunner.test.ts`: portable test commands — `node -e "process.stdout.write(JSON.stringify({accessToken:'x',expiresOn:Date.now()/1000+3600}))"` for happy path; `node -e "setTimeout(()=>{},60000)"` with a 500ms timeout to validate kill + `timedOut: true`; pass `"; echo x"` and `& whoami` as arg literals and assert they arrive in the child process verbatim (no shell expansion) on both POSIX and Windows code paths; on Windows specifically, test the `.cmd` wrapper path by creating a temporary `test-token.cmd` (e.g., `echo {"accessToken":"x","expiresOn":...}`), resolving it via `findOnPath`, and confirming both successful invocation and that an argv element like `& whoami` is delivered as a single literal arg to the cmd script rather than being interpreted by cmd.exe.
  - `src/mcp/transport/StdioTransport.test.ts`: confirm still green after `findOnPath` extraction.

### Success Criteria:

#### Automated Verification:
- [ ] Tests pass: `npm test` (including new spawn integration tests).
- [ ] Typecheck: `npm run typecheck`
- [ ] Build: `npm run build`

#### Manual Verification:
- [ ] Running `az account get-access-token --scope api://e8c77dc2-69b3-43f4-bc51-3213c9d915b4/.default --output json` from inside the plugin process (via a one-off dev test harness, not the live UI yet) returns a valid token JSON parseable into the resolver's expected shape.

---

## Phase 4: HTTP transport integration + 401 retry + trust-epoch invariance

**Covers:** FR-006, FR-007, FR-009 (snapshot fields), FR-010 (transport scope), FR-011, FR-014 (chat-side error format), FR-016, FR-017; SC-002, SC-003, SC-004 (chat side), SC-007, SC-009

### Changes Required:
- **`src/mcp/McpServerRuntime.ts`**:
  - `createStreamableHttpTransport` (or equivalent) accepts a `getAuthorization: () => Promise<string | null>` callback. Because the SDK's static `requestInit.headers` cannot be re-evaluated per request, integration goes through the existing `createMcpHttpFetchWrapper`: extend the wrapper to call `getAuthorization()` immediately before delegating to the underlying fetch and inject/overwrite the `Authorization` header. Preserve the existing cross-origin redirect strip in `httpPolicy.ts`.
  - Best-effort HTTP DELETE (session cleanup) calls `getAuthorization()` to populate the header.
  - Replace `config.authorization` reads with `credentials`-driven resolution; on runtime construction, the runtime is wired with a `CredentialResolver` reference (injected by `McpManager`).
  - Extend `McpServerRuntimeSnapshot` with credential-state fields needed by settings/chat surfaces (last-resolution outcome, next refresh time, remediation hint, variant label) — never storing token material.
- **`src/mcp/httpPolicy.ts`** (or sibling): The wrapper today throws a sanitized string error on non-OK responses. Introduce a typed `McpHttpError` carrying `status` (number) and `wwwAuthenticate` (optional string, scheme/realm — the auth challenge is not a secret; embedded `Bearer <token>` forms are still redacted) while preserving the existing redacted message contract. All existing callers continue to receive the redacted message.
- **`src/mcp/McpManager.ts`**:
  - Owns the single `CredentialResolver` instance.
  - `callTool` HTTP path: on a caught `McpHttpError` with `status === 401`, calls `resolver.invalidate(serverId)`, retries the call exactly once, and on a second 401 surfaces a chat-side error using the new remediation-formatter contract (see below): the chat error string is `"Credentials rejected" + (wwwAuthenticate ? ": " + wwwAuthenticate : "")` plus the formatter's remediation hint.
  - `status === 403` does NOT trigger retry; surfaces a "server denied access — check that you've consented to the required scopes" message with a docs link.
  - Subsequent failures within a short rolling window for the same server are coalesced into a single rolled-up chat error using the existing `McpManager` failure-tracking surface (no error flood).
  - New method `testConnection(serverId: string): Promise<{ ok: true } | { ok: false; reason: string }>` — constructs a transient runtime, runs `initialize`, tears it down without touching the live runtime or its inventory or grants.
- **`src/mcp/credentials/RemediationFormatter.ts`** (new — defined in Phase 4 so Phase 4's chat-side error path is self-contained; Phase 5 supplies the M365-specific overrides without changing this contract):
  - Exports `interface RemediationFormatter { format(variant: ServerCredentials["kind"], lastTenantId: string | null, error: { kind: "command-failed" | "unauthorized" | "denied" | "timeout"; detail?: string }): { text: string; copyable: string } }`.
  - Exports a default implementation `DefaultRemediationFormatter` returning generic-but-actionable text per `(variant, error.kind)` pair. For `command-based` + `unauthorized`, the default copyable hint is `"<command> --help"` plus a generic "ensure your credential command is signed in and emits valid JSON". This is replaced by the M365-aware formatter in Phase 5 (`M365RemediationFormatter`) which emits `az login --tenant <lastTenantId>` when `lastTenantId` is non-null, `az login` otherwise. The manager calls `formatter.format(...)` so the chat-side error format is testable in Phase 4 against `DefaultRemediationFormatter` without depending on Phase 5 code.
  - `McpManager` accepts the formatter via constructor injection (defaulting to `DefaultRemediationFormatter` if no override supplied); Phase 5's `main.ts` wiring swaps in the M365-aware formatter.
- **`src/mcp/McpIdentity.ts`**: No behavior change. Add an explicit comment block near the trust-epoch computation referencing FR-011 so future maintainers cannot silently fold credentials into trust-epoch material.
- **`src/mcp/redactSensitive.ts`**: Confirm and extend if needed: `WWW-Authenticate` scheme tokens are NOT redacted (they're not secrets); any embedded `Bearer <token>` form within them IS redacted.
- **Tests**:
  - `src/mcp/McpServerRuntime.httpFetch.test.ts`: every outbound fetch carries `Authorization` from the resolver callback; the value can change between calls within one runtime instance (cache invalidation case); session DELETE also carries it; **on a cross-origin redirect, the dynamic `Authorization` header is NOT re-injected after the existing redirect-strip path runs** (proves the credential layer respects `httpPolicy.ts`'s redirect contract; FR-017 + SC-009).
  - `src/mcp/httpPolicy.test.ts`: existing redirect / private-IP / metadata-host tests stay green; new tests confirm `McpHttpError` carries `status` and `wwwAuthenticate`.
  - `src/mcp/McpManager.test.ts`:
    - Single 401 triggers exactly one re-resolve + one retry.
    - Second 401 throws to chat with rolled-up error format.
    - 403 does NOT trigger retry and surfaces consent message.
    - 200 after invalidation is the happy path.
    - **Trust-epoch invariance**: changing only the `credentials` field on an HTTP config produces an identical trust epoch and runtime identity key as before (FR-011).
    - **Grant-survival**: `resolver.invalidate(serverId)` on 401 does not touch SafetyPolicy session grants.
  - `src/mcp/McpIdentity.test.ts`: assertion that the trust-epoch input set excludes the `credentials` field.
  - `src/settings/McpServersSection.test.ts`: editing only the credential command on a saved server does NOT call `revokeGrantsForServer`.

### Success Criteria:

#### Automated Verification:
- [ ] Tests pass: `npm test`
- [ ] Typecheck: `npm run typecheck`
- [ ] Build: `npm run build`
- [ ] All HTTP guardrail tests still pass unchanged — credentials never bypass redirect / private-IP / metadata-host blocking (FR-017, SC-009).
- [ ] Explicit regression test asserts no grant key (`mcp:<serverId>:*`) is deleted when only credentials change (FR-011).

#### Manual Verification:
- [ ] With a deliberately wrong static-bearer token configured against a local MCP echo server that returns 401, observe in chat: ONE error appears, not a flood; settings row shows "credentials rejected" (SC-004 chat side).
- [ ] An authenticated HTTP MCP server sends `Authorization: Bearer ...` on initialize, tools/list, tools/call, and session cleanup requests.
- [ ] Approve a tool call (persistent grant). Change the credential command and save. Re-invoke the same tool — no re-prompt for approval (FR-011).

---

## Phase 5: Preset registry, settings UI, Test connection, preflight

**Covers:** FR-008, FR-009 (settings-row scope), FR-013, FR-014 (settings + hint formatter), FR-018; SC-001, SC-004 (settings side), SC-005, SC-010

### Changes Required:
- **`src/settings/presets/McpServerPresets.ts`** (new):
  ```ts
  interface McpServerPreset {
    id: string;
    label: string;
    description?: string;
    build(): {
      server: PartialHttpServerInput;
      credentials: ServerCredentials;
      preflight?: { type: "findOnPath"; command: string; installHint?: string };
    };
  }
  ```
  Export `BUILT_IN_PRESETS` array with one entry: id `m365-graph-az-cli`, label `"Microsoft 365 Graph (via Azure CLI)"`. Builder returns URL `https://mcp.svc.cloud.microsoft/enterprise`, transport `http`, credentials `command-based` with the exact command + scope from FR-008, refresh buffer 300, token path `accessToken`, expiry path `expiresOn`, preflight `findOnPath('az')` with install hint `winget install Microsoft.AzureCLI` on Windows (docs link elsewhere).
- **`src/mcp/credentials/M365RemediationFormatter.ts`** (new): Implements the `RemediationFormatter` interface defined in Phase 4. For `(command-based, unauthorized)` returns `text = "Azure CLI credentials are not signed in or have expired."` and `copyable = lastTenantId ? "az login --tenant " + lastTenantId : "az login"`. Falls back to `DefaultRemediationFormatter` for variants/error-kinds it does not specialize.
- **`src/main.ts`**: Replace the default `RemediationFormatter` injected into `McpManager` with an instance of `M365RemediationFormatter` (composed with `DefaultRemediationFormatter` as fallback).
- **`src/settings/mcpServerFormLogic.ts`** (pure helpers — node-only testable):
  - Extend `McpServerFormInput` with `credentialKind: 'none' | 'static-bearer' | 'command-based'` and per-kind sub-fields. (`oauth-pkce` is not exposed in the UI but the validator accepts and preserves it on existing configs.)
  - Extend `validateMcpServerForm` with per-kind validation: non-empty token for static-bearer; non-empty command for command-based; JSON paths default-filled when blank; refresh buffer in 0–86400 range.
  - Extend `McpServerFormResult` so canonical credentials (with parsed argv) flow into the persisted config.
  - Add pure helper `buildCredentialStatusText(state): string` used by the row renderer (last-resolution outcome, time-to-refresh formatting). (The remediation hint formatting now lives in `RemediationFormatter` introduced in Phase 4; this helper merely composes the status text from inputs the manager already exposes via the runtime snapshot.)
- **`src/settings/McpServersSection.ts`** (DOM thin — delegates to the helpers above):
  - Add a preset dropdown at the top of the add form; selecting a preset calls `preset.build()` and populates the form. Non-preset selection (or "Custom") leaves the form blank for manual entry.
  - Add a credential editor block visibility-driven by the selected `credentialKind`: masked token input with reveal toggle (mirrors existing Authorization reveal pattern), command string, optional token path / expiry path / refresh buffer overrides. `oauth-pkce`-configured servers display "configured via raw data file; reserved for future release" with no editable controls.
  - Per-row credential status display: last-resolution outcome (success / failed / not yet resolved), redacted time-to-refresh, copyable remediation hint when failed.
  - "Test connection" button per row: invokes `McpManager.testConnection(serverId)` (added Phase 4) and reports success/failure inline. Does not disconnect or perturb the live runtime.
  - At preset-selection time, if the preset declares a `findOnPath` preflight, run it. If the executable is not found, show a non-blocking inline hint with the install command. Saving is still allowed (FR-018).
  - Static-bearer field shows a plaintext-storage warning ("token is stored in plain text in data.json; consider command-based for long-lived secrets") referencing FR-002 and the M365 docs.
- **Tests**:
  - `src/settings/presets/McpServerPresets.test.ts`: snapshot test pinning every field listed in FR-008 (URL, command verbatim, refresh buffer, JSON paths, preflight command and install hint).
  - `src/mcp/credentials/M365RemediationFormatter.test.ts`: `(command-based, unauthorized, lastTenantId="72f988bf-...")` → `copyable === "az login --tenant 72f988bf-..."`; same inputs with `lastTenantId = null` → `copyable === "az login"`; non-M365 variants fall through to the default formatter.
  - `src/settings/mcpServerFormLogic.test.ts`: extend with credential validation cases per kind, command tokenization, refresh-buffer bounds.
  - `src/settings/McpServersSection.test.ts`: extend with preset-dropdown population, preflight hint surfaced when `findOnPath` returns null, credential editor visibility per kind, Test-connection happy-path and failure messaging (uses existing fake DOM + injected fake `findOnPath` and fake `McpManager`).

### Success Criteria:

#### Automated Verification:
- [ ] Tests pass: `npm test`
- [ ] Typecheck: `npm run typecheck`
- [ ] Build: `npm run build`
- [ ] All new UI-adjacent logic lives in pure helpers exported from `mcpServerFormLogic.ts` or `presets/` (preserves the node-only test invariant).
- [ ] Preset snapshot test pins every field in FR-008 (regressions detected on any drift).

#### Manual Verification (vault smoke — requires `npm run deploy` first):
- [ ] Settings → MCP servers → Add → preset dropdown lists "Microsoft 365 Graph (via Azure CLI)"; selecting it pre-fills URL, transport, credential variant, and command exactly per FR-008 (SC-001).
- [ ] After saving the preset with `az` signed in: server connects, Graph tools appear within 5 seconds, a chat tool call returns tenant-grounded data (SC-001, SC-002).
- [ ] Uninstall `az` (or rename it on PATH) and re-select the preset: inline install hint appears proactively before save (SC-010).
- [ ] Configure a server with a deliberately bad static bearer: settings row shows "credentials rejected"; chat-side error includes a copyable remediation hint; only one error per call (SC-004).
- [ ] Long chat exceeds token lifetime: subsequent tool call succeeds with no visible re-auth (SC-003).
- [ ] Configure a custom command-based server using a shell helper that emits a non-Azure JSON shape; tweak `tokenPath`/`expiryPath` accordingly — server connects with no code changes (SC-005).
- [ ] Test connection button reports success on the M365 preset and a clear failure on a known-bad URL.

---

## Phase 6: Documentation

**Covers:** FR-002 (docs obligation), FR-008 (preset narrative), FR-010 (security posture), FR-014 (troubleshooting matrix), FR-018 (preflight in user docs); SC-001, SC-002, SC-004, SC-006, SC-010 (verifiable from docs)

### Changes Required:
- **`docs/m365-graph-mcp.md`** (new — first content under `docs/`): Sections:
  - "What this is" — Microsoft 365 Graph MCP server, the three Graph tools the agent gets.
  - "Quick start" — install `az` (link to install docs), `az login`, Settings → preset → save.
  - "Tenant prerequisites" — admin-side `Grant-EntraBetaMCPServerPermission -ApplicationName VisualStudioCode` reference and link to the official Microsoft Graph MCP docs.
  - "How the credentials work" — command-based variant explained, JSON paths, refresh buffer, in-memory cache, plaintext-on-disk for static-bearer with explicit recommendation to use command-based for long-lived secrets.
  - "Troubleshooting" matrix — maps each surfaced error (settings row + chat) to a remediation: missing `az`, not signed in, wrong tenant, 401, 403, command timeout, malformed JSON, missing token field.
  - "Custom commands" — shape of acceptable JSON output (`accessToken` + `expiresOn` defaults) and how to wrap a bare-token CLI in a JSON-emitting shell helper.
  - "Security posture" — explicit statement that static-bearer values persist in `data.json` in plaintext (FR-002); recommendation to prefer command-based for long-lived secrets; statement that resolved tokens never persist and never appear in logs (FR-010).
  - "Forward compatibility" — note that `oauth-pkce` config blocks are preserved verbatim today even though the variant is not yet active (FR-012, SC-008).
- **`README.md`**: Add an "Authenticated MCP servers" subsection under the existing MCP section linking to `docs/m365-graph-mcp.md`, naming the three supported credential variants and the plaintext caveat for static-bearer. Update the status line if it still claims no MCP authentication.
- **`CHANGELOG.md`**: Entry under the next release header summarizing the credential model, the M365 preset, the 401-retry behavior, and the plaintext-on-disk caveat.
- **`.paw/work/authenticated-mcps/Docs.md`** (new — PAW as-built reference, load `paw-docs-guidance` for template): Technical reference covering the credential resolver design, 401-retry, preset registry shape, trust-epoch invariance, plaintext-persistence reality, and pointers to the implementing files.
- **`.paw/work/authenticated-mcps/SmokeChecklist.md`** (new): Step-by-step manual smoke for SC-001 through SC-010, derived from the Manual Verification bullets in Phases 4 and 5.

### Success Criteria:

#### Automated Verification:
- [ ] Tests pass: `npm test` (no regressions).
- [ ] Typecheck: `npm run typecheck` (no regressions).
- [ ] Build: `npm run build`.
- [ ] No docs build script exists in `package.json`; markdown link accuracy verified by manual review.

#### Manual Verification:
- [ ] Following `docs/m365-graph-mcp.md` from a fresh setup gets a signed-in Azure CLI user to a connected Graph MCP server without consulting source.
- [ ] The README accurately warns that static-bearer tokens persist in plaintext `data.json` and recommends command-based for long-lived secrets.
- [ ] Smoke checklist runs clean end-to-end on a real vault with `az` installed and signed in; all SC-001 through SC-010 verifiable.

---

## References

- Spec: `.paw/work/authenticated-mcps/Spec.md`
- Research: `.paw/work/authenticated-mcps/CodeResearch.md`
- WorkflowContext (spike findings inlined): `.paw/work/authenticated-mcps/WorkflowContext.md`
- Per-model planning drafts (gitignored): `.paw/work/authenticated-mcps/planning/PLAN-*.md`
- Prior MCP client docs: `.paw/work/mcp-client/Docs.md`
- Original proposal: `proposals/0001-m365-graph-mcp.md`
