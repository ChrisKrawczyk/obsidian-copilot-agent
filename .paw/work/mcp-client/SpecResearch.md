---
date: 2026-06-15 09:51:08 PDT
git_commit: (current checkout)
branch: feature/mcp-client
repository: obsidian-copilot-agent
topic: "MCP Client Integration — Spec Research"
tags: [research, specification, mcp, v0.5]
status: complete
---

# MCP Client Integration — Spec Research

## Summary

The **Model Context Protocol 2025-06-18** is the latest stable spec version (confirmed by
`LATEST_PROTOCOL_VERSION = "2025-06-18"` in the authoritative TypeScript schema). It mandates a
three-phase lifecycle (initialize/initialized/shutdown), newline-delimited JSON-RPC over stdio
(NOT Content-Length-prefixed frames as in LSP), and a new **Streamable HTTP** transport that
replaces the deprecated 2024-11-05 HTTP+SSE transport. The official TypeScript SDK v1.29.0
(`@modelcontextprotocol/sdk`) is the current production-stable release; a v2 split into
`@modelcontextprotocol/client` and `@modelcontextprotocol/server` is pre-alpha, expected stable
Q3 2026. For v0.5 we should target SDK v1.x. The plugin's `SafetyPolicy` already contains
`SafetySource = "mcp"` wiring and `mcpAutoApprove` config — the permission-gate infrastructure
is pre-built. No existing community Obsidian plugin acts as an MCP **client**; all known plugins
(notably `jacksteamdev/obsidian-mcp-tools`, 87k installs, now archived) act as MCP **servers**
exposing the vault to external AI clients, not the reverse.

---

## 1. MCP Spec Essentials

### 1.1 JSON-RPC Initialize / Initialized Handshake

**Spec version**: `2025-06-18` — latest stable.
**Source**: https://modelcontextprotocol.io/specification/2025-06-18/basic/lifecycle

**Three-phase lifecycle:**
1. **Initialization** — client sends `initialize`, server responds, client sends
   `notifications/initialized`
2. **Operation** — normal protocol messaging
3. **Shutdown** — transport-specific (no `shutdown` request method in MCP; see §1.4)

**initialize request** (client → server, MUST be first interaction):
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "initialize",
  "params": {
    "protocolVersion": "2025-06-18",
    "capabilities": { },
    "clientInfo": { "name": "obsidian-copilot-agent", "version": "0.5.0" }
  }
}
```

**initialize response** (server → client):
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "protocolVersion": "2025-06-18",
    "capabilities": { "tools": { "listChanged": true } },
    "serverInfo": { "name": "ExampleServer", "version": "1.0.0" },
    "instructions": "Optional hint string for the model"
  }
}
```

**initialized notification** (client → server, after receiving initialize response):
```json
{ "jsonrpc": "2.0", "method": "notifications/initialized" }
```

**Version negotiation rules:**
- Client MUST send the *latest* version it supports (send `"2025-06-18"`)
- If server supports that version, it MUST respond with the same version string
- If server does not support the client's version, server responds with *its* latest supported
  version; client SHOULD disconnect if it cannot handle the server's version
- For HTTP: after init, client MUST include `MCP-Protocol-Version: 2025-06-18` header on all
  subsequent requests

**Behavioral constraints during init:**
- Client SHOULD NOT send requests (except ping) before server responds to `initialize`
- Server SHOULD NOT send requests (except ping and logging) before receiving `initialized`

**Sources:**
- https://modelcontextprotocol.io/specification/2025-06-18/basic/lifecycle (full lifecycle spec)
- https://raw.githubusercontent.com/modelcontextprotocol/modelcontextprotocol/main/schema/2025-06-18/schema.ts
  (canonical TypeScript schema — `InitializeRequest`, `InitializeResult`, `InitializedNotification`)

---

### 1.2 `tools/list` and `tools/call` — Request/Response Shape

**Source:** https://modelcontextprotocol.io/specification/2025-06-18/server/tools

**tools/list (client → server):**
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/list",
  "params": { "cursor": "optional-cursor-for-pagination" }
}
```
Response:
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "tools": [ { "name": "...", "description": "...", "inputSchema": { "type": "object", ... } } ],
    "nextCursor": "next-page-cursor-or-absent-if-last-page"
  }
}
```
`tools/list` supports cursor-based **pagination** (`nextCursor` in result). If `nextCursor` is
absent there are no more pages. Must auto-paginate to discover all tools.

**Tool definition fields** (from schema.ts `Tool` interface):
| Field | Required | Description |
|---|---|---|
| `name` | ✅ | Unique identifier (programmatic use) |
| `title` | ❌ | Human-readable display name |
| `description` | ❌ | Human-readable description (context hint to model) |
| `inputSchema` | ✅ | JSON Schema object (`{type:"object", properties:{...}, required:[...]}`) |
| `outputSchema` | ❌ | JSON Schema for `structuredContent` field in results |
| `annotations` | ❌ | `ToolAnnotations` — UNTRUSTED hints (readOnlyHint, destructiveHint, idempotentHint, openWorldHint) |

**tools/call (client → server):**
```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "tools/call",
  "params": { "name": "tool_name", "arguments": { "key": "value" } }
}
```
Response:
```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "result": {
    "content": [
      { "type": "text", "text": "result text" }
    ],
    "isError": false,
    "structuredContent": { }
  }
}
```

**Multi-content response types:**
| Type | Fields | Notes |
|---|---|---|
| `text` | `text: string` | UTF-8 text |
| `image` | `data: string` (base64), `mimeType: string` | e.g. `"image/png"` |
| `audio` | `data: string` (base64), `mimeType: string` | e.g. `"audio/wav"` |
| `resource_link` | `uri`, `name`, `mimeType`, `description` | URI to a resource (not inline) |
| `resource` (embedded) | `resource: { uri, mimeType, text\|blob }` | Full embedded resource |

All content types support optional `annotations` with `audience` and `priority` metadata.

**`isError` flag:**
- `isError: true` → tool **execution error** (API failure, business logic error). Response is
  still a valid JSON-RPC *result* (not an error). The spec requires this so the LLM can see the
  error and self-correct.
- JSON-RPC *error* response → protocol-level error (unknown tool name, server doesn't support
  tool calls, invalid args)
- If `isError` is absent it is assumed `false`

**Sources:**
- https://modelcontextprotocol.io/specification/2025-06-18/server/tools
- schema.ts `Tool`, `CallToolRequest`, `CallToolResult`, `ListToolsRequest`, `ListToolsResult`

---

### 1.3 Server-Sent Notifications

**`notifications/tools/list_changed`**
```json
{ "jsonrpc": "2.0", "method": "notifications/tools/list_changed" }
```
- Server sends when its tool list changes
- Server SHOULD send this only if it declared `capabilities.tools.listChanged: true`
- Client SHOULD re-fetch `tools/list` on receipt
- **For v0.5:** YES, honor this — re-fetch tool list and re-register tools. The spec says
  "refresh happens on (re)connect" and WorkflowContext excludes "live tool-list refresh while a
  tool is mid-stream", so we should re-fetch after current tool calls complete.

**`notifications/cancelled`**
```json
{
  "jsonrpc": "2.0",
  "method": "notifications/cancelled",
  "params": { "requestId": "123", "reason": "User cancelled" }
}
```
- Either side can send to cancel an in-flight request
- Receiver SHOULD stop processing; MAY ignore if already complete or request ID unknown
- Sender SHOULD ignore any response that arrives after sending cancellation
- Client MUST NOT cancel its `initialize` request
- Race condition expected: cancellation may arrive after response already sent — both sides MUST
  handle gracefully
- **For v0.5:** Honor incoming `notifications/cancelled` (stop MCP tool call processing). Send
  outgoing `notifications/cancelled` when user hits Stop during an MCP tool call.

**`notifications/initialized`** — sent by client (see §1.1)
**`notifications/message`** — server log messages to client (if server declares `logging`
capability). Clients MAY capture or ignore.

**Sources:**
- https://modelcontextprotocol.io/specification/2025-06-18/basic/utilities/cancellation
- https://modelcontextprotocol.io/specification/2025-06-18/server/tools (list_changed)
- schema.ts `CancelledNotification`, `ToolListChangedNotification`

---

### 1.4 Lifecycle: Shutdown Semantics

**There is no MCP `shutdown` request method** (unlike LSP). Shutdown is transport-specific.

**stdio shutdown** (spec — lifecycle page):
1. Client closes the input stream (stdin) to the child process
2. Client waits for the server process to exit
3. If server doesn't exit within a "reasonable time", client sends SIGTERM
4. If server still doesn't exit within a "reasonable time" after SIGTERM, client sends SIGKILL
- "Reasonable time" is not defined by spec — implementation choice
- Server MAY also initiate shutdown by closing its stdout and exiting

**HTTP shutdown** (spec — lifecycle page):
- Close the associated HTTP connection(s)
- If using session management: client SHOULD send HTTP DELETE to the MCP endpoint with the
  `Mcp-Session-Id` header to explicitly terminate the session
- Server MAY respond with 405 Method Not Allowed (meaning it doesn't allow client-initiated
  session termination)

**Sources:**
- https://modelcontextprotocol.io/specification/2025-06-18/basic/lifecycle (Shutdown section)

---

## 2. Transports

### 2a. stdio

**Source:** https://modelcontextprotocol.io/specification/2025-06-18/basic/transports

**Framing: newline-delimited JSON-RPC (NOT Content-Length headers)**
- Messages are delimited by newlines (`\n`)
- Messages MUST NOT contain embedded newlines
- This is **different** from LSP (which uses `Content-Length:` headers). MCP stdio uses simple
  newline framing.
- Messages MUST be UTF-8 encoded

**Protocol behavior:**
- Client spawns server as a child process
- Server reads JSON-RPC messages from **stdin**; writes messages to **stdout**
- Server MAY write to **stderr** for logging; client MAY capture, forward, or ignore
- Server MUST NOT write anything to stdout that is not a valid MCP message
- Client MUST NOT write anything to server's stdin that is not a valid MCP message

**Process lifecycle:**
- Client launches the subprocess (via `child_process.spawn` or equivalent)
- Subprocess stays alive for the session duration
- Shutdown: close stdin → SIGTERM → SIGKILL (see §1.4)
- On Obsidian plugin unload: MUST terminate child processes to prevent orphans

**Environment variable inheritance:**
- Child process inherits the parent process's environment by default
- **Risk:** user shell env may contain sensitive tokens (`GITHUB_TOKEN`, `ANTHROPIC_API_KEY`,
  AWS credentials, etc.)
- Reference server configs pass credentials explicitly via the `env` field (e.g.,
  `{"env": {"GITHUB_PERSONAL_ACCESS_TOKEN": "..."}}`) — this does NOT prevent inheriting other
  env vars unless the SDK transport is configured to pass a restricted env
- `StdioClientTransport` accepts an optional `env` config object; if provided, it is **merged**
  with or **replaces** inherited env (exact SDK behavior to confirm)

**PATH resolution on macOS:**
- Obsidian launched via Spotlight or Dock has a minimal PATH that does NOT include shell profile
  dirs (`/usr/local/bin`, Homebrew, nvm, conda, etc.)
- `npx`, `uvx`, `node`, `python` may not resolve unless their full path is specified
- Reference solution: require user to provide full path OR prepend common PATH dirs
- VS Code handles this by adding known tool paths; Claude Desktop has same issue

**PATH resolution on Windows:**
- `npx` does not work directly on Windows without `cmd /c`
- Claude Desktop / VS Code docs show: `{ "command": "cmd", "args": ["/c", "npx", "-y", "@..."] }`
- The plugin SHOULD use `cmd /c` wrapper on Windows for `npx`-based servers, or handle via a
  path-resolution helper

**Sources:**
- https://modelcontextprotocol.io/specification/2025-06-18/basic/transports (stdio section)
- https://github.com/modelcontextprotocol/servers (Windows `cmd /c` examples)
- https://raw.githubusercontent.com/modelcontextprotocol/typescript-sdk/v1.x/docs/client.md
  (`StdioClientTransport` config: `{ command, args, env, cwd }`)

---

### 2b. HTTP (Streamable HTTP + Legacy SSE)

**Source:** https://modelcontextprotocol.io/specification/2025-06-18/basic/transports

#### Current Standard: Streamable HTTP

The **Streamable HTTP** transport (introduced in 2025-03-26, current in 2025-06-18) **replaces**
the deprecated HTTP+SSE transport from protocol version 2024-11-05.

**Single MCP endpoint:**
- Server exposes ONE URL that handles both POST and GET
- Example: `https://example.com/mcp`

**Client → Server (POST):**
- Every JSON-RPC message from client is a new HTTP POST to the MCP endpoint
- Client MUST include `Accept: application/json, text/event-stream` header
- Body is a single JSON-RPC request, notification, or response
- Server responds with either:
  - `Content-Type: application/json` — single response
  - `Content-Type: text/event-stream` — SSE stream (for streaming or server→client messages)
- For notifications/responses from client: server returns HTTP 202 Accepted (no body)

**Server → Client (SSE stream from GET):**
- Client MAY issue HTTP GET to MCP endpoint to open a server-push SSE stream
- Server can use this to send notifications (e.g., `notifications/tools/list_changed`) 
  independently of client requests
- Server MUST include `Accept: text/event-stream` header

**Session management:**
- Server MAY assign `Mcp-Session-Id` header on the `InitializeResult` response
- If assigned, client MUST include `Mcp-Session-Id` on all subsequent requests
- Session ID SHOULD be globally unique and cryptographically secure (UUID, JWT, or hash)
- Session ID MUST contain only visible ASCII characters (0x21–0x7E)
- HTTP 404 response to a session ID → client MUST re-initialize (new `initialize` without session)
- Client SHOULD send HTTP DELETE with session ID when done

**Protocol version header:**
- After init: client MUST include `MCP-Protocol-Version: 2025-06-18` on all subsequent requests
- If server receives invalid version: MUST respond 400 Bad Request
- If server receives no version header: SHOULD assume `2025-03-26` for backwards compat

**Resumability:**
- Server MAY attach SSE event `id` fields; client MAY send `Last-Event-ID` header when
  reconnecting to resume a broken stream

#### Legacy: HTTP+SSE (2024-11-05 — Deprecated)

The old transport used:
1. A GET endpoint that opened a persistent SSE stream (client listens for server→client messages)
2. A separate POST endpoint for client→server messages
3. First SSE event was `endpoint` pointing to the POST URL

This transport is **deprecated**. The current Streamable HTTP transport replaces it. Servers
built before 2025-03-26 may still use the old transport.

**Backwards compatibility detection for clients:**
1. Try POST `InitializeRequest` to the URL
2. If 4xx response (e.g., 405 Method Not Allowed or 404): fall back — issue a GET, wait for
   `endpoint` SSE event, then use old transport
3. SDK provides `SSEClientTransport` for legacy servers and `streamableHttpWithSseFallbackClient`
   example for auto-detection

**For v0.5:** Both Streamable HTTP and legacy SSE fallback are in scope per WorkflowContext
("http" transport includes "streamable HTTP per the MCP spec"). Whether to implement SSE
fallback in v0.5 is an open question (see §9).

**GitHub MCP Server URL** (reference hosted HTTP server):
```
https://api.githubcopilot.com/mcp/
```
Auth: static `Authorization: Bearer <PAT>` header, OR OAuth (out of scope for v0.5).
This server is Streamable HTTP compatible.

**Sources:**
- https://modelcontextprotocol.io/specification/2025-06-18/basic/transports (full transport spec)
- https://github.com/github/github-mcp-server (remote server URL and PAT auth example)

---

## 3. Official TypeScript SDK

**Source:** https://registry.npmjs.org/@modelcontextprotocol/sdk/latest,
https://ts.sdk.modelcontextprotocol.io/,
https://raw.githubusercontent.com/modelcontextprotocol/typescript-sdk/v1.x/docs/client.md

### Latest version

**`@modelcontextprotocol/sdk@1.29.0`** — current production-stable (v1.x branch)

> ⚠️ The `main` branch contains **v2 (pre-alpha)**; stable v2 expected Q3 2026. The npm package
> `@modelcontextprotocol/sdk@1.29.0` is on the `v1.x` branch and is recommended for production.
> v2 will split into `@modelcontextprotocol/client` and `@modelcontextprotocol/server` separate
> packages but is not yet usable.

### Client public API (v1.x)

The `Client` class is the high-level entry point. Transport classes are imported separately.

**Import paths (for bundled ESM/CJS):**
```typescript
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'; // legacy
```

**Typical client usage pattern:**
```typescript
// 1. Create client with name, version, capabilities
const client = new Client(
  { name: 'obsidian-copilot-agent', version: '0.5.0' },
  { capabilities: {} }   // tools-only: declare no extra capabilities
);

// 2. Create transport
const transport = new StdioClientTransport({
  command: 'npx',
  args: ['-y', '@modelcontextprotocol/server-filesystem', '/vault'],
  env: { ...process.env, SOME_TOKEN: 'value' },
  cwd: '/some/path'
});

// 3. Connect (automatically sends initialize + initialized)
await client.connect(transport);

// 4. List tools (with auto-pagination if needed)
const { tools, nextCursor } = await client.listTools();

// 5. Call a tool
const result = await client.callTool({ name: 'read_file', arguments: { path: 'note.md' } });
// result.content = ContentBlock[], result.isError = boolean

// 6. Subscribe to tool list changes
client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
  const updated = await client.listTools();
  // re-register tools
});

// 7. Close (sends shutdown signal)
await client.close();
```

**SDK connects + initializes atomically:** `client.connect(transport)` calls
`transport.start()` (spawning the subprocess or opening HTTP connection), then performs the
`initialize` handshake and sends `notifications/initialized`. The caller does not need to
perform these steps manually.

**Notification handler registration:**
- `client.setNotificationHandler(schema, handler)` subscribes to a notification type
- Schemas come from `@modelcontextprotocol/sdk/types.js`

**HTTP client transport (`StreamableHTTPClientTransport`):**
```typescript
const transport = new StreamableHTTPClientTransport(
  new URL('https://api.githubcopilot.com/mcp/'),
  {
    requestInit: {
      headers: { Authorization: 'Bearer <PAT>' }
    }
  }
);
```

### Dependency analysis for Obsidian

From `@modelcontextprotocol/sdk@1.29.0` package.json `dependencies`:

| Dependency | Version | Used by | Obsidian compatibility |
|---|---|---|---|
| `cross-spawn` | ^7.0.5 | `StdioClientTransport` | ✅ Uses `child_process.spawn`; available in Obsidian desktop (Electron exposes Node.js) |
| `eventsource` | ^3.0.2 | `SSEClientTransport` (legacy) | ✅ Polyfill; Electron has native EventSource too. Not needed if only Streamable HTTP. |
| `pkce-challenge` | ^5.0.0 | OAuth PKCE auth flow | ✅ Web Crypto based; available in Electron. NOT needed for static auth (out of scope v0.5). |
| `jose` | ^6.1.3 | JWT auth in auth-extensions | ✅ Requires `globalThis.crypto` (Web Crypto); available in Electron/Chromium. Not needed for v0.5 static auth. |
| `zod` | ^3.25 \|\| ^4.0 | Schema validation (required peer dep) | ✅ Pure JS, no native deps |
| `ajv` | ^8.17.1 | JSON Schema validation | ✅ Pure JS |
| `express` | ^5.2.1 | Server-side only | ✅ Tree-shaken away for client-only imports |
| `hono` | ^4.11.4 | Server-side only | ✅ Tree-shaken away for client-only imports |
| `@hono/node-server` | ^1.19.9 | Server-side only | ✅ Tree-shaken away |
| `raw-body` | ^3.0.0 | Server-side HTTP | ✅ Tree-shaken away |

**Unpacked size:** 4.27 MB, 677 files. After esbuild tree-shaking for client-only paths, actual
bundle contribution is estimated ~300–600 KB (ajv + zod + cross-spawn + eventsource +
client protocol code). The server-side deps (express, hono) are eliminated by tree-shaking.

**Node.js version requirement:**
- SDK requires `node >= 18`
- Plugin's own `package.json` declares `engines: { "node": ">=20.0.0" }`
- Obsidian desktop runs on Electron which includes Node.js ≥ 20 — fully compatible

**Key constraint:** The SDK MUST be bundled by esbuild (cannot be `require()`'d at runtime from
Node modules in Obsidian). The plugin already uses esbuild bundling.

**Sources:**
- https://registry.npmjs.org/@modelcontextprotocol/sdk/latest (package.json dependencies,
  version, size)
- https://raw.githubusercontent.com/modelcontextprotocol/typescript-sdk/main/README.md (v2
  warning, v1 branch info)
- https://raw.githubusercontent.com/modelcontextprotocol/typescript-sdk/v1.x/docs/client.md
  (StdioClientTransport API, Client API, notification handlers)
- https://ts.sdk.modelcontextprotocol.io/ (high-level overview)

---

## 4. Reference / Hosted Servers

### Anthropic Reference Servers (all stdio via `npx`/`uvx`)

**Source:** https://github.com/modelcontextprotocol/servers

| Server | Package | Transport | Sample tools |
|---|---|---|---|
| `server-filesystem` | `@modelcontextprotocol/server-filesystem` | stdio (`npx`) | read_file, write_file, create_directory, list_directory, delete_file |
| `server-fetch` | `@modelcontextprotocol/server-fetch` (via npm or Python) | stdio | fetch (URL fetching + Markdown conversion) |
| `mcp-server-git` | Python (`uvx mcp-server-git`) | stdio | git_log, git_diff, git_commit, git_status, etc. |
| `server-memory` | `@modelcontextprotocol/server-memory` | stdio (`npx`) | create_entities, search_nodes, add_observations |
| `server-time` | `@modelcontextprotocol/server-time` | stdio (`npx`) | get_current_time, convert_time |
| `server-sequential-thinking` | `@modelcontextprotocol/server-sequential-thinking` | stdio | sequentialthinking |

**Windows invocation pattern** (from reference repo README):
```json
{
  "command": "cmd",
  "args": ["/c", "npx", "-y", "@modelcontextprotocol/server-memory"]
}
```

**Environment-based credentials** (from reference repo examples):
```json
{
  "command": "npx",
  "args": ["-y", "@modelcontextprotocol/server-github"],
  "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "<token>" }
}
```

### GitHub MCP Server (Hosted HTTP)

**Source:** https://github.com/github/github-mcp-server

| Field | Value |
|---|---|
| URL | `https://api.githubcopilot.com/mcp/` |
| Transport | Streamable HTTP |
| Auth options | (a) OAuth via GitHub Copilot (requires VS Code 1.101+); (b) Static Bearer PAT |
| PAT config | `"headers": { "Authorization": "Bearer <PAT>" }` |

GitHub Enterprise with data residency: `https://copilot-api.<tenant>.ghe.com/mcp`

This server directly validates v0.5's HTTP auth model: a static `Authorization: Bearer` header
passed at connection time is the established pattern for PAT-authenticated hosted MCP servers.

**Sources:**
- https://github.com/github/github-mcp-server (README)
- https://github.com/modelcontextprotocol/servers (reference servers list)

---

## 5. Security & Sandboxing

### 5.1 Spawning Child Processes from Obsidian

**PATH resolution:**
- Obsidian (macOS, launched via Dock/Spotlight) inherits a minimal `/usr/bin:/bin:/usr/sbin:/sbin`
  PATH — NOT the user's shell profile PATH
- `npx` (via npm), `uvx` (via uv), `node`, `python3` may not resolve without full paths
- Known safe absolute paths on macOS: `/usr/local/bin/node`, `/opt/homebrew/bin/node`, etc.
- Recommendation: UI should show resolved path or warn if command not found; consider allowing
  full-path specification in the command field; consider prepending `$HOME/.local/bin`,
  `/usr/local/bin`, `/opt/homebrew/bin` to the subprocess env PATH

**Windows:**
- `npx` requires `cmd /c` wrapper: `{ command: "cmd", args: ["/c", "npx", "-y", "..."] }`
- `uvx` (Python) works without wrapper
- Source: https://github.com/modelcontextprotocol/servers (README Windows note)

**Environment variable inheritance risk:**
- By default, `child_process.spawn` inherits the parent's entire environment
- Obsidian's parent environment (inherited from shell or Electron app) may contain:
  `GITHUB_TOKEN`, `ANTHROPIC_API_KEY`, `AWS_ACCESS_KEY_ID`, `OPENAI_API_KEY`, etc.
- A malicious or compromised MCP server (or one the user runs by mistake) could exfiltrate these
- **Mitigation options:**
  - Pass a filtered `env` (whitelist only `PATH`, `HOME`, `TMPDIR`, `USERPROFILE` + explicit
    secrets from the server config)
  - OR pass the full env (simpler, matches Claude Desktop behavior) with documented risk
- The v0.5 WorkflowContext says credentials for a server are "entered at server-add time" and
  stored — these should be injected via the `env` field at connection time

**Working directory:**
- `StdioClientTransport` `cwd` option; if unset, inherits plugin process CWD (unspecified in
  Obsidian — typically `/`)
- Could matter for servers that resolve relative paths
- Recommendation: expose as an optional config field; default to undefined

**Orphan process risk:**
- If `onunload()` does not terminate child processes, they survive Obsidian reload/restart
- Must track spawned process handles and call `kill()` / send SIGTERM in plugin `onunload()`
- SEP-1024: clients supporting one-click server installation MUST show consent dialog with exact
  command before execution. For v0.5 manual entry, this maps to the settings UI displaying the
  exact command + args before first connection.

**Source:**
- https://modelcontextprotocol.io/seps/1024-mcp-client-security-requirements-for-local-server-.md
  (SEP-1024, Final status — consent dialog requirement)
- https://code.visualstudio.com/docs/agent-customization/mcp-servers (VS Code trust dialog)

### 5.2 HTTP Transport Security

**TLS validation:**
- Node.js `https.request` validates TLS certificates by default (uses system trust store)
- Electron inherits this behavior — no special action needed for standard HTTPS servers
- Self-signed certs or localhost dev servers: would need `rejectUnauthorized: false` workaround
  (not recommended by default; could be an advanced option)

**Static auth header storage:**
- v0.5 design: static `Authorization` header value entered at server-add time
- WorkflowContext: "Stored alongside other safety/auth state, not in plain JSON if the platform
  offers a safer store (best-effort only — same posture as v0.3 token storage)"
- Obsidian desktop: `localStorage` (Electron stores in vault's `.obsidian/` SQLite) — not a
  hardware-backed secrets vault but adequate for desktop-local use
- Risk: vault sync (e.g., Obsidian Sync, iCloud) could expose tokens if plugin settings are
  synced and storage is not filtered

**DNS rebinding / SSRF:**
- The spec warns servers MUST validate the `Origin` header; DNS rebinding can allow websites to
  interact with local MCP servers
- As a CLIENT, the plugin's risk is more SSRF-like: a malicious server config URL could point to
  internal network services (`http://192.168.1.1/`, `http://169.254.169.254/`)
- Mitigation: validate that HTTP MCP server URLs use HTTPS (not HTTP) for non-localhost; warn
  on HTTP URLs; block private IP ranges by default

**Source:**
- https://modelcontextprotocol.io/docs/tutorials/security/security_best_practices.md
  (SSRF, token passthrough, confused deputy)
- https://modelcontextprotocol.io/specification/2025-06-18/basic/transports (Origin validation
  warning in Streamable HTTP section)

### 5.3 Prompt Injection from MCP Tool Results

**Spec guidance (tools spec, Security Considerations):**
> "Clients SHOULD: ... Validate tool results before passing to LLM ... Show tool inputs to the
> user before calling the server, to avoid malicious or accidental data exfiltration"

**On tool annotations being untrusted:**
> "Clients MUST consider tool annotations to be untrusted unless they come from trusted servers."
> (from tools spec security warning)

This means: the `annotations.readOnlyHint`, `annotations.destructiveHint` fields on tools MUST
NOT be used to automatically bypass the approval gate. All MCP tool calls require approval
regardless of what the annotations claim.

**Prompt injection risk from results:**
- A tool result containing crafted text (e.g., `"Ignore previous instructions and..."`) could
  attempt to redirect the model
- The spec does not prescribe specific countermeasures beyond human-in-the-loop for calls
- The existing universal permission gate (human sees the tool call before it executes) provides
  the primary protection
- Result content is passed to the model as tool-result context — this is an inherent risk of
  MCP tool use and matches industry-standard practice

**Sources:**
- https://modelcontextprotocol.io/specification/2025-06-18/server/tools (Security Considerations
  section)
- https://modelcontextprotocol.io/specification/2025-06-18 (Key Principles — Tool Safety)

---

## 6. Prior Art (Obsidian / VS Code)

### 6.1 Obsidian Community Plugins

**`jacksteamdev/obsidian-mcp-tools`** (github.com/jacksteamdev/obsidian-mcp-tools)
- Role: MCP **server** (exposes vault to external MCP clients like Claude Desktop) — NOT a client
- 87,000+ installs; now **archived** (author no longer uses Obsidian)
- Architecture: monorepo with obsidian-plugin + mcp-server binary + shared packages
- Transport: stdio; server distributed as a signed native binary placed in vault plugin folder
- Credentials: uses the vault's "Local REST API" plugin key; stored using platform credential APIs
- Author's note: "at least five alternatives published to the Community Plugins store, with many
  more MCP-related beta plugins available through BRAT"
- **None of the known Obsidian community plugins act as an MCP client** (connecting to external
  MCP servers to surface their tools to an AI agent inside Obsidian). v0.5 would be novel.

**Search performed:** Searched `obsidian-releases/community-plugins.json` (GitHub),
GitHub topics (`obsidian-plugin + mcp`), community forum. No plugins found matching
"MCP client for Obsidian" use case.

**Sources:**
- https://github.com/jacksteamdev/obsidian-mcp-tools
- https://github.com/topics/obsidian-plugin?q=mcp
- obsidianmd/obsidian-releases community-plugins.json (searched)

### 6.2 VS Code Copilot Chat MCP Integration

**Source:** https://code.visualstudio.com/docs/agent-customization/mcp-servers

**Config file location and format (`.vscode/mcp.json` or profile `mcp.json`):**
```json
{
  "servers": {
    "github": {
      "type": "http",
      "url": "https://api.githubcopilot.com/mcp"
    },
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path"]
    },
    "playwright": {
      "command": "npx",
      "args": ["-y", "@microsoft/mcp-server-playwright"]
    }
  }
}
```
- stdio servers: `command` + `args` (+ optional `env`)
- HTTP servers: `type: "http"` + `url` + optional `headers`
- No explicit `type: "stdio"` needed for subprocess servers

**VS Code UX conventions worth borrowing:**
- **Trust dialog:** must confirm trust before first server start (maps to SEP-1024 consent)
- **Enable/disable toggle** per server (independent of config)
- **Last error display:** "Shows error indicator in Chat view, Show Output option"
- **MCP: List Servers** command to manage, view logs, reconnect
- **Auto-discovery** from Claude Desktop config (optional, not in v0.5 scope)
- **Input variables:** `${input:token-id}` for secrets to avoid hardcoding in config
- **sandbox** option (macOS/Linux only) — not applicable to Obsidian plugin context

**Notes on `inputs` array for VS Code:**
```json
"inputs": [{
  "type": "promptString",
  "id": "github_mcp_pat",
  "description": "GitHub Personal Access Token",
  "password": true
}]
```
This VS Code pattern prompts users for secrets without storing them in the config file. V0.5
uses a simpler approach: enter the Authorization header value once at server-add time, store
securely.

**Sources:**
- https://code.visualstudio.com/docs/agent-customization/mcp-servers
- https://github.com/github/github-mcp-server (VS Code configuration examples)

---

## 7. Capabilities Negotiation

**Sources:**
- https://modelcontextprotocol.io/specification/2025-06-18/basic/lifecycle (Capability table)
- schema.ts `ClientCapabilities`, `ServerCapabilities` interfaces

### 7.1 Client Capabilities to Declare (Tools-Only Client)

For a tools-only client that does NOT support sampling, roots, or elicitation, the correct
capabilities object is:
```json
{
  "capabilities": {}
}
```

The spec `ClientCapabilities` interface (schema.ts) defines optional fields:
- `roots` — filesystem roots support — **OMIT** (not in v0.5 scope)
- `sampling` — server-initiated LLM completions — **OMIT** (explicitly out of scope)
- `elicitation` — server-initiated user input requests — **OMIT** (out of scope)
- `experimental` — non-standard capabilities — **OMIT** unless needed

An empty `{}` capabilities object is valid. DO NOT advertise `sampling` or `elicitation` — this
would cause well-behaved servers to send sampling/elicitation requests the plugin cannot handle.

### 7.2 Server Capabilities to Check

After receiving the `InitializeResult`, check:

| Check | Action |
|---|---|
| `capabilities.tools` present | Proceed with `tools/list`; server supports tools |
| `capabilities.tools` absent | Log warning; no tools available from this server |
| `capabilities.tools.listChanged === true` | Subscribe to `notifications/tools/list_changed` |
| `capabilities.tools.listChanged` absent/false | No notifications; re-fetch only on reconnect |
| `capabilities.logging` present | MAY send `logging/setLevel`; server sends `notifications/message` |
| `serverInfo.instructions` present | Consider including in preamble as model context hint |

**Do NOT check or use:** `capabilities.resources`, `capabilities.prompts` (out of scope for v0.5)

### 7.3 `instructions` Field in InitializeResult

The `InitializeResult.instructions` field is a spec-supported string:
> "Instructions describing how to use the server and its features. This can be used by clients to
> improve the LLM's understanding of available tools, resources, etc. It can be thought of like a
> 'hint' to the model."

For v0.5: This SHOULD be included in the preamble alongside tool listings when present. It can
be formatted as `(MCP / <server-name> server instructions: <text>)` in the preamble block.

**Sources:**
- schema.ts `InitializeResult` interface
- https://modelcontextprotocol.io/specification/2025-06-18/basic/lifecycle

---

## 8. Error & Failure Modes

### 8.1 Server Crash Mid-Call

**stdio:**
- Child process death causes stdin/stdout to close
- `StdioClientTransport` should emit an error event; in-flight requests should reject
- SDK `Client` wraps transport errors and rejects pending request promises
- Plugin MUST catch these rejections at call sites and surface as tool-call errors (via existing
  tool-call error block UI per WorkflowContext)
- Mark server as `disconnected`; trigger auto-reconnect with exponential backoff (in scope for v0.5)

**HTTP:**
- Underlying HTTP request fails with connection error or timeout
- Session ID becomes invalid (server no longer maintains state)
- HTTP 404 response to session ID → MUST reinitialize per spec
- For v0.5: next HTTP call attempts fresh connect (per WorkflowContext)

### 8.2 Tool-Call Timeout

**Spec defines:** Implementations SHOULD establish timeouts. When a request exceeds the timeout,
the sender SHOULD issue a `notifications/cancelled` for that request and stop waiting.
(Source: https://modelcontextprotocol.io/specification/2025-06-18/basic/lifecycle — Timeouts section)

**Spec does NOT define:** a specific timeout value. This is left to implementations.

**Timeout clock reset:** MAY reset on receipt of a `notifications/progress` for the request
(indicating work is ongoing). BUT implementations SHOULD always enforce a maximum timeout
regardless of progress notifications.

**SDK behavior:** `StdioClientTransport` and `StreamableHTTPClientTransport` accept optional
`requestInit` / per-request timeout config (exact API from SDK docs).

**For v0.5:** Implement a configurable timeout (default recommendation: 30 seconds for regular
tools, 120 seconds for potentially long-running operations). Respect progress notifications for
clock reset but enforce absolute maximum.

### 8.3 Tool-Result Content Larger Than Model's Context

**Spec:** No guidance on content size limits; tool results can be arbitrarily large.

**Binary content sizes:** Image content is base64-encoded in the JSON response. A 1 MB PNG = ~1.33
MB base64 string ≈ substantial token count, potentially consuming significant context window.

**For v0.5 mitigation (to spec in design phase):**
- Truncate text content at a configurable character limit with ellipsis
- For image/audio content: pass base64 to model API only if the model supports vision/audio;
  otherwise surface as `[Image content: <mimeType>, <size> bytes]` text placeholder
- For resource_link content: fetch and inline only if size is within budget; otherwise include
  URI only
- The spec does not mandate any of these mitigations — they are client-side quality decisions

### 8.4 Unicode / Binary Content (Image Tools)

**Spec framing for image results:**
```json
{
  "type": "image",
  "data": "iVBORw0KGgo...",
  "mimeType": "image/png",
  "annotations": { "audience": ["user"], "priority": 0.9 }
}
```

**Text content:** Always UTF-8 per spec ("JSON-RPC messages MUST be UTF-8 encoded")

**`isError` for binary tool failure:** When a tool that should return an image fails, spec
convention is `isError: true` with a text content block describing the error — NOT binary error
content.

**Model API compatibility:** The GitHub Copilot SDK used by the plugin accepts image content in
tool results only if the underlying model supports vision. Unknown whether the Copilot API passes
image content from MCP tool results through. This is an open question.

**Sources:**
- https://modelcontextprotocol.io/specification/2025-06-18/server/tools (content types)
- https://modelcontextprotocol.io/specification/2025-06-18/basic/lifecycle (timeout SHOULD)
- schema.ts `CallToolResult`, `ContentBlock`, `ImageContent`, `AudioContent`

---

## 9. Open Questions for the Spec Author

1. **Protocol version advertisement:** Should v0.5 advertise `"2025-06-18"` as `protocolVersion`
   in `initialize`? Many existing community servers were built for `"2024-11-05"`. If a server
   responds with `"2024-11-05"`, should the plugin accept it (and use the older HTTP+SSE
   transport)? Or hard-require `"2025-06-18"` and fail otherwise?

2. **Legacy SSE fallback for HTTP transport:** The spec provides a backwards-compatibility
   detection algorithm (try POST first, fall back to GET+SSE). Should v0.5 implement this
   fallback? The alternative is "Streamable HTTP only" — simpler but excludes older servers like
   some community-built pre-2025-03-26 servers.

3. **stdio env filtering:** Should the plugin pass a filtered environment (whitelist + explicit
   server credentials only) or the full inherited env to spawned MCP server subprocesses? Filtered
   is more secure but may break servers that rely on ambient env vars (e.g., `HOME`, `TMPDIR`,
   locale vars). What is the v0.5 stance?

4. **PATH resolution strategy for stdio:** How should the plugin handle the Obsidian-on-macOS
   minimal-PATH problem? Options: (a) require full absolute paths in `command` field, (b) prepend
   known directories (`/usr/local/bin`, `/opt/homebrew/bin`, etc.) to subprocess PATH, (c)
   provide a "test connection" button that shows a resolution error with guidance. Which approach
   fits the v0.5 UX scope?

5. **Pagination for `tools/list`:** Should the plugin auto-paginate `tools/list` (follow
   `nextCursor` until exhausted) or only fetch the first page? Most servers have < 50 tools and
   won't paginate, but some (e.g., GitHub MCP server) expose 50+ tools. The spec supports
   pagination; should v0.5 implement it?

6. **Image/audio content from tool results:** How should the plugin handle binary content (image,
   audio) in `tools/call` results? Pass base64 to the Copilot SDK? Surface as placeholder text?
   Does the Copilot SDK/model even accept image content from tool results?

7. **`instructions` field from `InitializeResult`:** Should server-provided `instructions` appear
   in the preamble? If yes, is there a character limit before it's truncated?

8. **Session persistence across plugin reload:** For HTTP transport, if a server assigns an
   `Mcp-Session-Id`, should the plugin persist this across Obsidian reloads? Or always
   re-initialize on load? (Re-initializing is simpler and avoids stale-session issues.)

9. **`notifications/tools/list_changed` — timing:** The WorkflowContext says "Live tool-list
   refresh while a tool is mid-stream is out of scope." Exactly when should a received
   `notifications/tools/list_changed` trigger a re-fetch — immediately, or deferred until no
   tool call is in flight?

10. **Shutdown timeout values:** When stdio servers don't exit after stdin close, how long to
    wait before SIGTERM? After SIGTERM, how long before SIGKILL? VS Code appears to use ~5s each;
    what value does the spec author want for v0.5?

---

## User-Provided External Knowledge (Manual Fill)

- [ ] What Electron (Node.js) version does the current Obsidian desktop ship with? (Needed to
      confirm exact Web Crypto / EventSource API availability at runtime.)
- [ ] Does the `@github/copilot-sdk` used by the plugin accept image-type content in tool results?
      (Determines whether MCP image tool results can be passed to the model.)
- [ ] Are there any specific MCP servers users of the plugin are expected to connect to first
      (beyond GitHub MCP server)? This would inform test coverage priorities.
- [ ] Should the MCP server config be stored in the plugin's settings JSON or in a separate
      `.obsidian/plugins/obsidian-copilot-agent/mcp-servers.json` for easier editing?
- [ ] Is the v0.5 target audience expected to run MCP servers via Docker? (If so, `docker run`
      command handling and PATH isolation need consideration.)