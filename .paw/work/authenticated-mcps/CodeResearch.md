---
date: 2026-06-19T16:41:17.766-07:00
git_commit: 611656bf706f6a78f5146bc69ce3a7f6904dfba4
branch: feature/authenticated-mcps
repository: obsidian-copilot-agent
topic: "Authenticated MCP Servers"
tags: [research, codebase, mcp, http-transport, settings, credentials]
status: complete
last_updated: 2026-06-19
---

# Research: Authenticated MCP Servers

## Research Question

Ground the Authenticated MCP Servers spec in the current codebase: identify HTTP MCP transport integration points, HTTP guardrails, stdio command-spawn patterns, MCP settings UI/store shape, trust-epoch grants, logging/redaction seams, test/doc infrastructure, and prior MCP-client decisions.

## Summary

The current MCP client is centralized under `src\mcp\`. Streamable HTTP uses `McpServerRuntime.createStreamableHttpTransport(...)`, which validates the configured URL, passes static `authorization` into `StreamableHTTPClientTransport.requestInit.headers`, and wraps network requests in `createMcpHttpFetchWrapper(...)` for redirect/TLS/body-limit policy (`src\mcp\McpServerRuntime.ts:492-538`). HTTP session id is private runtime state on `McpServerRuntime`, copied from the SDK transport after initialize and cleared on disable/reconnect/error paths (`src\mcp\McpServerRuntime.ts:64-80`, `src\mcp\McpServerRuntime.ts:116-123`, `src\mcp\McpServerRuntime.ts:235-248`, `src\mcp\McpServerRuntime.ts:451-466`).

MCP server config is persisted by `McpSettingsStore` as `mcpServers` in Obsidian plugin `data.json`, with unknown future keys preserved by the config index signature and `stripRuntimeFields(...)` behavior (`src\mcp\McpTypes.ts:15-38`, `src\settings\McpSettingsStore.ts:341-356`). No secure/keychain/encryption helper exists in current source; existing OAuth and MCP static authorization values use `Plugin.loadData`/`saveData`, and the MCP settings UI says Authorization is plaintext in `data.json` (`src\auth\TokenStore.ts:1-20`, `src\settings\mcpServerFormLogic.ts:12-13`, `src\settings\McpServersSection.ts:191-194`).

Trust grants are keyed by `mcp:<serverId>:<trustEpoch>:<toolName>`. HTTP trust epoch material is currently only `name`, `transport`, and `url`; credential material is not part of the trust epoch or runtime identity key (`src\mcp\McpIdentity.ts:27-50`, `src\settings\SafetySettingsStore.ts:92-99`, `src\settings\SafetySettingsStore.ts:213-239`, `src\mcp\McpManager.ts:440-454`).

## Documentation System

- **Framework**: Plain Markdown; no docs framework config found. User-facing docs are currently `README.md`, `RELEASING.md`, `CHANGELOG.md`, `proposals\*.md`, and PAW docs under `.paw\work\...` (`README.md:1-13`, `RELEASING.md:1-4`, `proposals\README.md:1-17`).
- **Docs Directory**: No repo-root `docs\` directory exists. `README.md` links detailed technical references to PAW artifacts such as `.paw\work\mcp-client\Docs.md` (`README.md:52-61`).
- **Navigation Config**: N/A.
- **Style Conventions**: README uses release-section headings, concise bullets, JSON examples, and explicit security posture paragraphs (`README.md:7-52`). `RELEASING.md` uses runbook headings, command blocks, prerequisites, recovery procedures, and Keep-a-Changelog section names (`RELEASING.md:19-55`, `RELEASING.md:69-101`). `proposals\README.md` specifies short proposal docs with Problem, Sketch, and Open questions (`proposals\README.md:5-17`).
- **Build Command**: N/A for docs; no docs build command in `package.json` scripts (`package.json:8-27`).
- **Standard Files**: `README.md`, `CHANGELOG.md`, `RELEASING.md`, `proposals\README.md`.

## Verification Commands

- **Test Command**: `npm test` (`package.json:12`). Verified during research: 72 files / 1107 tests passed.
- **Lint Command**: No lint script in `package.json` (`package.json:8-27`).
- **Build Command**: `npm run build` (`package.json:9`).
- **Type Check**: `npm run typecheck` (`package.json:11`).
- **Deploy Command**: `npm run deploy` builds and deploys to the configured vault (`package.json:13`).

## Detailed Findings

### HTTP MCP Transport and Request Construction

- `McpServerRuntime` imports `StreamableHTTPClientTransport` and owns the HTTP runtime path (`src\mcp\McpServerRuntime.ts:1-20`).
- Advertised protocol constants are `MCP_ADVERTISED_PROTOCOL_VERSION = "2025-06-18"` and `MCP_COMPAT_PROTOCOL_VERSION = "2024-11-05"` (`src\mcp\McpServerRuntime.ts:22-23`).
- `connect()` creates the transport, starts it, sends `initialize` with the advertised version, negotiates the returned protocol, calls `transport.setProtocolVersion?.(...)`, and captures `transport.sessionId` (`src\mcp\McpServerRuntime.ts:83-123`).

Quoted symbols:

```ts
export const MCP_ADVERTISED_PROTOCOL_VERSION = "2025-06-18";
export const MCP_COMPAT_PROTOCOL_VERSION = "2024-11-05";
```

(`src\mcp\McpServerRuntime.ts:22-23`)

```ts
this.protocolVersion = negotiateProtocolVersion(
  result.protocolVersion,
  this.config.transport,
);
transport.setProtocolVersion?.(this.protocolVersion);
this.sessionId = transport.sessionId;
```

(`src\mcp\McpServerRuntime.ts:116-122`)

- Outbound HTTP transport construction is in `createStreamableHttpTransport`. This is the current place static Authorization is stamped: `if (config.authorization) headers.Authorization = config.authorization;` and then passed as `requestInit: { headers }` to the SDK transport (`src\mcp\McpServerRuntime.ts:492-503`).

```ts
export function createStreamableHttpTransport(
  config: McpHttpServerConfig,
  baseFetch: typeof fetch,
): Transport {
  const validation = validateMcpHttpUrl(config.url, { allowPrivateNetwork: true });
  if (validation.hostClass === "metadata") throw new Error("MCP HTTP URL targets metadata.");
  const headers: Record<string, string> = {};
  if (config.authorization) headers.Authorization = config.authorization;
  return new StreamableHTTPClientTransport(validation.url, {
    requestInit: { headers },
    fetch: createMcpHttpFetchWrapper(baseFetch),
  });
}
```

(`src\mcp\McpServerRuntime.ts:492-503`)

- `createMcpHttpFetchWrapper(...)` asserts no TLS bypass options, forces manual redirects, validates each URL before fetch, enforces metadata blocking, follows only 301/302/303/307/308 with `location`, validates each redirect hop, strips auth/session headers on cross-origin redirects, and wraps responses in body-size enforcement (`src\mcp\McpServerRuntime.ts:506-538`).
- Protocol negotiation accepts `2025-06-18` and `2024-11-05` for stdio/http and rejects legacy SSE (`src\mcp\McpServerRuntime.ts:540-555`). Tests cover HTTP and stdio acceptance for both versions (`src\mcp\McpServerRuntime.test.ts:371-400`).

### HTTP Session Id, Reconnects, and 401-Relevant Behavior

- `McpServerRuntime` has private runtime-only `sessionId` state (`src\mcp\McpServerRuntime.ts:64`). It is reset at connect start, initialize failure, disable, close, and HTTP request-failure paths (`src\mcp\McpServerRuntime.ts:80`, `src\mcp\McpServerRuntime.ts:137`, `src\mcp\McpServerRuntime.ts:168`, `src\mcp\McpServerRuntime.ts:231-237`, `src\mcp\McpServerRuntime.ts:353-357`).
- Best-effort HTTP DELETE includes `Mcp-Session-Id`, optional `MCP-Protocol-Version`, and static Authorization (`src\mcp\McpServerRuntime.ts:451-466`).

```ts
headers: {
  "Mcp-Session-Id": sessionId,
  ...(this.protocolVersion ? { "MCP-Protocol-Version": this.protocolVersion } : {}),
  ...(this.config.authorization ? { Authorization: this.config.authorization } : {}),
},
```

(`src\mcp\McpServerRuntime.ts:460-464`)

- `McpManager.callTool(...)` lazily initializes HTTP if inventory is absent, and on HTTP call failure clears volatile session state and deletes inventory so a later call can initialize again (`src\mcp\McpManager.ts:218-258`).
- `McpReconnectPolicy` exists, but `McpManager` records failures for stdio only (`src\mcp\McpManager.ts:60-66`, `src\mcp\McpManager.ts:250-253`). v0.5 docs say HTTP has no background auto-reconnect and reconnects on next call/manual reconnect (`.paw\work\mcp-client\Docs.md:113-119`).
- Current code has no HTTP-401-specific branch. JSON-RPC errors are redacted and surfaced generically (`src\mcp\McpServerRuntime.ts:380-388`), and request failures are sanitized and rethrown through the request catch path (`src\mcp\McpServerRuntime.ts:339-360`).

### HTTP Guardrails (`src\mcp\httpPolicy.ts`)

Public surface:

```ts
export type HostClass = "loopback" | "private" | "metadata" | "public";
export interface HttpPolicyOptions { allowPrivateNetwork?: boolean; }
export interface HttpPolicyResult {
  url: URL;
  hostClass: HostClass;
  confirmationRequired: boolean;
}
export interface SafeRequestInit extends Omit<RequestInit, "redirect"> {
  redirect?: "manual";
}
export const MAX_REDIRECT_HOPS = 3;
```

(`src\mcp\httpPolicy.ts:1-17`)

```ts
export function validateMcpHttpUrl(...): HttpPolicyResult
export function assertNoTlsBypassOptions(...): void
export function validateRedirectHop(...): { url: URL; crossOrigin: boolean }
export function stripCrossOriginAuthHeaders(...): Headers
export function classifyHost(rawHost: string): HostClass
```

(`src\mcp\httpPolicy.ts:26-104`)

- URL validation allows only `http:`/`https:`, rejects cloud metadata hosts, rejects non-loopback plaintext HTTP, and returns `confirmationRequired: true` for private hosts unless `allowPrivateNetwork` is set (`src\mcp\httpPolicy.ts:26-45`).
- Redirect validation caps redirects at 3, reuses URL validation, rejects private-network redirects unless allowed, and returns cross-origin status (`src\mcp\httpPolicy.ts:55-70`).
- Cross-origin redirects remove `Authorization` and `Mcp-Session-Id` (`src\mcp\httpPolicy.ts:72-82`).
- Tests cover host classification, metadata/non-loopback HTTP rejection, private confirmation, TLS-bypass rejection, and redirect metadata/private rejection (`src\mcp\httpPolicy.test.ts:9-68`).

### Stdio Transport Command Resolution and Windows `findOnPath`

- `StdioTransport.start()` uses `child_process.spawn` with separate command/args, `shell: false`, filtered env, cwd, piped stdio, and `windowsHide: true` (`src\mcp\transport\StdioTransport.ts:54-80`).

```ts
this.child = spawn(command.command, command.args, {
  cwd: this.config.cwd ?? this.options.vaultRoot,
  env: envResult.env,
  shell: false,
  stdio: "pipe",
  windowsHide: true,
});
```

(`src\mcp\transport\StdioTransport.ts:69-75`)

- Windows `.cmd` resolution is handled by `resolveCommandForSpawn(...)`. On Win32 `.cmd`, it resolves the command path and invokes `cmd.exe /d /s /c <resolved> ...args` (`src\mcp\transport\StdioTransport.ts:203-217`).
- `findOnPath` uses `path.win32.delimiter` and `path.win32.join`; the same block is present on `main` by `git show main:src/mcp/transport/StdioTransport.ts` during research.

```ts
function findOnPath(command: string, env: Record<string, string>): string | null {
  const pathKey = Object.keys(env).find((key) => key.toUpperCase() === "PATH");
  const pathValue = pathKey ? env[pathKey] : "";
  for (const entry of pathValue.split(path.win32.delimiter)) {
    if (!entry) continue;
    const candidate = path.win32.join(entry, command);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}
```

(`src\mcp\transport\StdioTransport.ts:219-228`)

- Tests assert `.cmd` resolution through `cmd.exe`, preservation of metacharacters as args, and fallback when PATH candidates do not exist (`src\mcp\transport\StdioTransport.test.ts:41-70`).

### MCP Server Settings UI

- `McpServersSection` mounts a region, subscribes to the store and manager, renders “Add server”, and renders one row per configured server with runtime status from `manager.statusSnapshot()` (`src\settings\McpServersSection.ts:45-94`).
- The per-server status row is `renderRow(...)`. It displays name, id, transport, enabled state, status icon+label, tool count, last error, stderr tail, denylist warnings, and Edit/Disable/Enable/Reconnect/Remove buttons (`src\settings\McpServersSection.ts:96-150`). This is the existing row surface for credential state.
- Add/edit is a single `openForm(existing?)` modal. Current fields are Server ID, Display name, Transport, Command, Arguments, URL, Authorization, Reveal sensitive fields, Working directory, Environment, Tool call timeout seconds, private-network confirmation, Save, and Cancel (`src\settings\McpServersSection.ts:152-253`).
- `Save` builds `McpServerFormInput`, preserves existing redacted Authorization if not revealed, validates with `validateMcpServerForm`, and calls `saveForm(...)` (`src\settings\McpServersSection.ts:221-251`).
- `saveForm(...)` updates/adds through `McpSettingsStore`, fires denylist notices, fires the one-shot Authorization plaintext notice, revokes grants on trust epoch changes, and enables the server if configured enabled (`src\settings\McpServersSection.ts:255-270`).
- No preset registry/dropdown exists in current source; search for `preset|Microsoft 365|Graph|az account` in `src\*.ts` found no MCP preset code. The only current modal dropdown is `Transport` (`src\settings\McpServersSection.ts:176-178`, `src\settings\McpServersSection.ts:382-394`).
- UI tests use a fake DOM class and verify add/edit/remove/enable/disable/reconnect, private confirmation, redacted last errors/logs, one-shot Authorization notice, and trust epoch revocation notices (`src\settings\McpServersSection.test.ts:8-93`, `src\settings\McpServersSection.test.ts:96-307`).

### Server-Level Validation and Form Logic

- Validation is factored into DOM-free `src\settings\mcpServerFormLogic.ts` and tested separately (`src\settings\mcpServerFormLogic.ts:17-66`, `src\settings\mcpServerFormLogic.test.ts:1-117`).
- `McpServerFormInput` currently includes `authorization?: string`, `headers?: Record<string, string>`, and rejected TLS-bypass fields typed as `never` (`src\settings\mcpServerFormLogic.ts:17-36`).
- Stdio validation requires command, parses arg string into argv entries, applies cwd defaults, path existence check, env denylist warnings, and emits canonical `callTimeoutMs` (`src\settings\mcpServerFormLogic.ts:108-140`).
- HTTP validation requires URL, asserts no TLS bypass fields, calls `validateMcpHttpUrl(...)`, returns private confirmation warnings, emits URL href, optional Authorization, and canonical `callTimeoutMs` (`src\settings\mcpServerFormLogic.ts:141-169`).
- Authorization helpers are `buildHeaderDisplay(...)`, `redactAuthorizationValue(...)`, and `displaySensitiveValue(...)` (`src\settings\mcpServerFormLogic.ts:203-224`).
- Existing argv tokenization is `parseArgs(raw: string)` using a regex for double-quoted, single-quoted, or non-space tokens; tests cover quoted argument strings (`src\settings\mcpServerFormLogic.ts:249-255`, `src\settings\mcpServerFormLogic.test.ts:52-56`).

### Settings Persistence, Sensitive Values, and Config Shape

Current public shape:

```ts
export interface McpServerConfigBase {
  id: McpServerId;
  name: string;
  enabled: boolean;
  trustEpoch: McpTrustEpoch;
  callTimeoutMs?: number;
  [futureKey: string]: unknown;
}
export interface McpStdioServerConfig extends McpServerConfigBase {
  transport: "stdio";
  command: string;
  args: string[];
  env?: Record<string, string>;
  cwd?: string;
}
export interface McpHttpServerConfig extends McpServerConfigBase {
  transport: "http";
  url: string;
  authorization?: string;
}
export type McpServerConfig = McpStdioServerConfig | McpHttpServerConfig;
```

(`src\mcp\McpTypes.ts:15-38`)

- `McpSettingsStore.load()` reads `raw.mcpServers`, validates each entry with `parseServerConfig`, drops malformed/duplicate entries, and caches cloned configs (`src\settings\McpSettingsStore.ts:51-84`).
- `persist()` re-reads shared plugin data and writes `{ ...base, mcpAuthorizationNoticeShown, mcpServers: snap.map(toPersistedServerConfig) }`, preserving sibling top-level keys (`src\settings\McpSettingsStore.ts:197-218`).
- Runtime-only keys stripped before persistence include `status`, `lastError`, timestamps, `mcpSessionId`, `Mcp-Session-Id`, `sessionId`, `tools`, and `instructions` (`src\settings\McpSettingsStore.ts:25-35`, `src\settings\McpSettingsStore.ts:341-356`).
- `TokenStore` persists the main Copilot OAuth token and `persistEnabled` through `Plugin.loadData`/`saveData`, not a keychain helper (`src\auth\TokenStore.ts:1-20`, `src\auth\TokenStore.ts:34-63`, `src\auth\TokenStore.ts:93-109`).
- Tests verify stdio, HTTP, unknown future keys, and static Authorization round-trip (`src\settings\McpSettingsStore.test.ts:83-100`), and runtime fields including `Mcp-Session-Id` do not serialize (`src\settings\McpSettingsStore.test.ts:124-142`).
- Proposal `0001` references “encrypted storage notice,” but current code and UI copy say plaintext `data.json` (`proposals\0001-m365-graph-mcp.md:30-32`, `src\settings\mcpServerFormLogic.ts:12-13`).

### SafetyPolicy and Trust-Epoch Grants

- In-memory MCP session grants in `SafetyState` are keyed by `formatMcpGrantKey(serverId, toolName, trustEpoch)` and cover exact `(stable server id, tool name, trust epoch)` (`src\domain\SafetyPolicy.ts:60-70`, `src\domain\SafetyPolicy.ts:83-109`).
- Persistent grants live in `safety.mcpAutoApprove` and use `formatMcpApprovalKey(serverId, toolName, trustEpoch)` (`src\settings\SafetySettingsStore.ts:92-99`, `src\settings\SafetySettingsStore.ts:213-239`).

```ts
export function formatMcpApprovalKey(
  serverId: McpServerId,
  toolName: string,
  trustEpoch: McpTrustEpoch,
): string {
  return `mcp:${serverId}:${trustEpoch}:${toolName}`;
}
```

(`src\mcp\McpIdentity.ts:44-50`)

- `computeTrustEpoch` material is stdio `name`, `transport`, `command`, `args`; HTTP `name`, `transport`, `url` (`src\mcp\McpIdentity.ts:27-41`).
- Settings revokes persistent grants when `trustEpochChanged`, and removal calls `revokeGrantsForServer(server.id)` (`src\settings\McpServersSection.ts:285-301`). `SafetySettingsStore.revokeGrantsForServer` deletes keys with prefix `mcp:${serverId}:` (`src\settings\SafetySettingsStore.ts:242-250`).
- Tests assert trust epoch rotates on name/command/args/url/transport, not enable/status, and non-epoch edits such as env do not revoke grants (`src\mcp\McpIdentity.test.ts:42-84`, `src\settings\McpServersSection.test.ts:275-295`).
- `McpManager.runtimeIdentityKey` also excludes HTTP authorization from runtime identity (`src\mcp\McpManager.ts:440-454`).

### Logging, Redaction, and Error Surfacing

- MCP redaction helper is `redactSensitive(text: string)` (`src\mcp\redactSensitive.ts:9-47`). It redacts Authorization headers, Bearer values, `Mcp-Session-Id` headers/query parameters, URL userinfo, token-like query params, and denylisted env assignments (`src\mcp\redactSensitive.ts:12-44`). Tests cover each category (`src\mcp\redactSensitive.test.ts:4-68`).
- MCP runtime/manager surfaces redact snapshots, inventory instructions, tool descriptions, JSON-RPC errors, stderr ring buffer, forced-kill warnings, normalized results, notify messages, and persisted snapshots (`src\mcp\McpServerRuntime.ts:198-232`, `src\mcp\McpServerRuntime.ts:293-295`, `src\mcp\McpServerRuntime.ts:380-388`, `src\mcp\McpServerRuntime.ts:435-440`, `src\mcp\McpServerRuntime.ts:659-676`, `src\mcp\McpManager.ts:60-66`, `src\mcp\McpManager.ts:246-258`, `src\mcp\McpManager.ts:427-438`, `src\mcp\transport\StdioTransport.ts:131-144`, `src\mcp\normalizeMcpResult.ts:17-24`).
- Settings UI renders last error and server log as redacted text in `<pre>` (`src\settings\McpServersSection.ts:109-123`). Tests assert no `innerHTML` rendering (`src\settings\McpServersSection.test.ts:154-178`).
- Console sinks outside `src\mcp\` log raw `Error` objects for lifecycle/startup paths, including MCP settings load and lifecycle startup/reconcile failures (`src\main.ts:297-305`, `src\main.ts:335-343`, `src\lifecycle.ts:30-68`). MCP forced-kill reason is redacted before manager callback by `StdioTransport.forceKill` (`src\mcp\transport\StdioTransport.ts:189-199`, `src\main.ts:317-333`).

### Test Infrastructure

- Vitest uses `environment: "node"` and `include: ["src/**/*.test.ts"]`; Obsidian is aliased to `src\test\obsidianMock.ts` (`vitest.config.ts:4-18`).
- `npm test` verified baseline: 72 test files, 1107 passing tests. This supersedes older v0.5 docs noting 944 tests (`.paw\work\mcp-client\Docs.md:161-174`).
- UI logic is factored into pure modules for tests. Example: `src\ui\chatKeydown.ts` exports `decideKeydownAction(...)` and tests import it directly (`src\ui\chatKeydown.ts:1-77`, `src\ui\chatKeydown.test.ts:1-84`). Settings form validation follows the same pattern (`src\settings\mcpServerFormLogic.ts:68-201`, `src\settings\mcpServerFormLogic.test.ts:1-117`).
- HTTP transport tests stub network by passing `vi.fn` fetch into `createMcpHttpFetchWrapper(...)` and returning synthetic `Response` objects (`src\mcp\McpServerRuntime.httpFetch.test.ts:1-115`).
- MCP runtime tests use fake transports injected through `transportFactory` (`src\mcp\McpServerRuntime.test.ts:403-412`, `src\mcp\McpServerRuntime.test.ts:445-507`).

### Existing Process-Spawn Timeout / Credential-Command Patterns

- Existing direct spawn pattern is long-lived MCP stdio transport, not short-lived credential command execution (`src\mcp\transport\StdioTransport.ts:31-35`, `src\mcp\transport\StdioTransport.ts:54-80`).
- File-local `withTimeout(...)` helpers exist in `McpServerRuntime.ts` and `McpManager.ts`, but they are not exported (`src\mcp\McpServerRuntime.ts:637-657`, `src\mcp\McpManager.ts:395-415`).
- `BinaryFetcher` uses `execSync("ldd --version 2>&1", { timeout: 2000 })` for Linux libc detection (`src\sdk\BinaryFetcher.ts:69-78`); release CLI tests use `spawnSync`. Search for `spawnSync|execSync|execFile|nodeSpawn|child_process` found no reusable “run command, cap at 15s, collect stdout/stderr, parse JSON” credential helper.

### Prior MCP-Client PAW Decisions

- `.paw\work\mcp-client\Docs.md` is the as-built v0.5 technical reference. It documents stores, manager/runtime, stdio and Streamable HTTP transport bounds, protocol compatibility, approval scope, result normalization, resilience, and redaction (`.paw\work\mcp-client\Docs.md:1-177`).
- Locked v0.5 decisions included: advertise `2025-06-18`; accept `2024-11-05`; reject legacy HTTP+SSE; store static Authorization in `data.json`; spawn stdio with `shell: false`; keep HTTP `Mcp-Session-Id` only in memory and never log it (`.paw\work\mcp-client\Spec.md:7-10`, `.paw\work\mcp-client\Spec.md:107-125`).
- The v0.5 plan required owned stdio spawn, HTTP redirect/header/TLS enforcement, stable `(serverId, toolName, trustEpoch)` grant semantics, and redaction seams (`.paw\work\mcp-client\ImplementationPlan.md:7-18`, `.paw\work\mcp-client\ImplementationPlan.md:25-55`).
- Proposal `proposals\0001-m365-graph-mcp.md` says Graph MCP is mostly “auth + configuration,” sketches HTTP bearer and stdio launcher paths, and asks whether server templates should exist (`proposals\0001-m365-graph-mcp.md:7-18`, `proposals\0001-m365-graph-mcp.md:23-40`, `proposals\0001-m365-graph-mcp.md:57-64`). Its older endpoint is `https://graph.microsoft.com/mcp`, while the current spec uses `https://mcp.svc.cloud.microsoft/enterprise` (`proposals\0001-m365-graph-mcp.md:27-29`, `.paw\work\authenticated-mcps\Spec.md:87-95`).

## Code References

- `src\mcp\McpServerRuntime.ts:22-31` - MCP protocol/timeout/body-size constants.
- `src\mcp\McpServerRuntime.ts:74-143` - Connect/initialize/protocol negotiation/status/error flow.
- `src\mcp\McpServerRuntime.ts:306-360` - JSON-RPC request timeout, cancellation, HTTP stale-session cleanup path.
- `src\mcp\McpServerRuntime.ts:451-466` - Best-effort HTTP DELETE with session/protocol/auth headers.
- `src\mcp\McpServerRuntime.ts:492-538` - Streamable HTTP transport and guarded fetch wrapper.
- `src\mcp\McpServerRuntime.ts:540-555` - Protocol negotiation function.
- `src\mcp\httpPolicy.ts:1-120` - HTTP URL classification, TLS bypass rejection, redirect policy, cross-origin auth stripping.
- `src\mcp\transport\StdioTransport.ts:54-80` - Direct child-process spawn with no shell.
- `src\mcp\transport\StdioTransport.ts:203-228` - Windows `.cmd` resolution and `findOnPath`.
- `src\mcp\McpTypes.ts:15-38` - MCP server config discriminated union.
- `src\mcp\McpIdentity.ts:27-50` - Trust epoch material and approval key format.
- `src\mcp\redactSensitive.ts:9-47` - Redaction helper.
- `src\mcp\McpManager.ts:218-258` - Tool-call routing, HTTP lazy enable, HTTP failure inventory/session clearing.
- `src\mcp\McpManager.ts:440-454` - Runtime identity key material.
- `src\settings\McpServersSection.ts:70-150` - Settings list and row status/error surface.
- `src\settings\McpServersSection.ts:152-253` - Add/edit modal fields and save flow.
- `src\settings\mcpServerFormLogic.ts:17-66` - Form input/result public types.
- `src\settings\mcpServerFormLogic.ts:68-201` - Pure validation and config construction.
- `src\settings\McpSettingsStore.ts:51-84` - MCP settings load/parse/drop behavior.
- `src\settings\McpSettingsStore.ts:197-218` - Persistence merge/write behavior.
- `src\settings\SafetySettingsStore.ts:92-99` - Persistent MCP grant key contract.
- `src\settings\SafetySettingsStore.ts:213-250` - Persistent grant lookup/set/revoke helpers.
- `src\domain\SafetyPolicy.ts:60-121` - In-memory session grant shape.
- `src\sdk\AgentSession.ts:1757-1782` - SDK MCP permission input/cache key mapping.
- `src\auth\TokenStore.ts:1-20` - Current persisted auth/token store shape.
- `vitest.config.ts:12-18` - Node-only test environment and include glob.
- `README.md:14-52` - Current user-facing MCP setup/security docs.
- `.paw\work\mcp-client\Docs.md:38-52` - v0.5 HTTP transport and protocol docs.
- `proposals\0001-m365-graph-mcp.md:7-18` - Earlier M365 Graph MCP motivation.

## Architecture Documentation

### Current MCP HTTP Architecture

Configured HTTP server entries flow from Settings → `McpSettingsStore` → `McpManager` → `McpServerRuntime` → SDK `StreamableHTTPClientTransport`. Static Authorization is part of the persisted HTTP config and is injected into SDK transport `requestInit.headers`. The fetch path stays inside `createMcpHttpFetchWrapper`, so redirect rules and response size bounds are centralized (`src\settings\McpServersSection.ts:221-270`, `src\settings\McpSettingsStore.ts:197-218`, `src\mcp\McpManager.ts:273-281`, `src\mcp\McpServerRuntime.ts:251-262`, `src\mcp\McpServerRuntime.ts:492-538`).

### Current Credential Storage Posture

Existing persisted sensitive values use Obsidian plugin `data.json`; no code-level encryption/keychain abstraction is present. Current MCP Authorization UI is password-masked/redacted for display but persisted as plaintext with a one-shot warning (`src\settings\McpServersSection.ts:191-197`, `src\settings\McpServersSection.ts:262-265`, `src\settings\mcpServerFormLogic.ts:12-13`, `src\settings\McpSettingsStore.test.ts:83-100`).

### Current Trust/Runtime Identity Boundary

Persistent and in-session grants depend on server id, exact tool name, and trust epoch. For HTTP servers, trust epoch and runtime identity currently do not include Authorization or any credential field, so changing credential material without changing name/url does not rotate grants under current semantics (`src\mcp\McpIdentity.ts:27-50`, `src\mcp\McpManager.ts:440-454`, `src\settings\McpServersSection.test.ts:287-295`).

### Testing Conventions

The suite is DOM-free by Vitest environment, with UI behavior tested through pure logic modules or fake DOM shims. MCP transport tests avoid real network/process effects by injecting fake `fetch`, fake `Transport`, fake child processes, and fake timers (`vitest.config.ts:12-18`, `src\ui\chatKeydown.ts:1-77`, `src\settings\McpServersSection.test.ts:8-93`, `src\mcp\McpServerRuntime.httpFetch.test.ts:4-115`, `src\mcp\transport\StdioTransport.test.ts:7-122`).

## Observed Planning Constraints (Descriptive)

1. **No secure-storage helper exists today.** Current code and UI copy describe plaintext `data.json` storage for OAuth token and static MCP Authorization, so any encrypted-at-rest requirement is not backed by an existing helper symbol (`src\auth\TokenStore.ts:1-20`, `src\settings\mcpServerFormLogic.ts:12-13`, `src\settings\McpServersSection.ts:191-194`).
2. **HTTP 401 is not currently special-cased.** Existing HTTP failure behavior clears volatile session/inventory and surfaces redacted errors; no 401-specific invalidate/retry branch exists in the current runtime/manager paths (`src\mcp\McpServerRuntime.ts:306-360`, `src\mcp\McpManager.ts:246-258`).
3. **No preset registry exists.** The MCP settings form has only transport selection and manual fields; no M365/Graph/Azure CLI preset source exists in `src` (`src\settings\McpServersSection.ts:152-253`, search result for `preset|Microsoft 365|Graph|az account`).
4. **Credential rotation currently does not affect trust epoch.** Current trust epoch/runtime identity material excludes Authorization and any future credential field; this aligns with existing non-identity edit behavior not revoking grants (`src\mcp\McpIdentity.ts:27-41`, `src\mcp\McpManager.ts:440-454`, `src\settings\McpServersSection.test.ts:287-295`).
5. **Command stdout credential execution helper is absent.** Existing process code covers long-lived MCP stdio transports and binary detection, not short-lived credential command execution with stdout JSON parsing and a 15s cap (`src\mcp\transport\StdioTransport.ts:54-80`, `src\sdk\BinaryFetcher.ts:69-78`).
6. **HTTP guardrails are centralized in the fetch wrapper.** Credential-bearing requests that use existing `StreamableHTTPClientTransport` + `createMcpHttpFetchWrapper` inherit URL/redirect/header/body guardrails (`src\mcp\McpServerRuntime.ts:492-538`, `src\mcp\httpPolicy.ts:47-82`).

## Open Questions

- No current code artifact shows where a future `docs\m365-graph-mcp.md` should be linked from, because no `docs\` directory or docs navigation config exists. Current user-facing documentation anchors are README/CHANGELOG/RELEASING/proposals and PAW Docs artifacts (`README.md:52-61`, `RELEASING.md:69-101`, `proposals\README.md:5-17`).
- No encrypted/keychain symbol was found for MCP static bearer persistence. Current stores are `TokenStore`, `McpSettingsStore`, and `SafetySettingsStore`, all using `loadData`/`saveData` (`src\auth\TokenStore.ts:22-32`, `src\settings\McpSettingsStore.ts:37-49`, `src\settings\SafetySettingsStore.ts:127-132`).
