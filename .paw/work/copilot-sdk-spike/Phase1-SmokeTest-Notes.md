# Phase 1 Smoke-Test Notes

> Working artifact for the Phase 1 smoke test. The implementer captures empirical observations here as they run the plugin against the user's actual Obsidian build. Some sections are answered up-front from inspecting the SDK's published `dist/*.d.ts` types; others are populated after the manual smoke-test run.

## 1. Pre-run findings (from `node_modules/@github/copilot-sdk/dist/`)

These are answered before running the plugin in Obsidian — purely from reading the published type declarations.

### 1.1 SDK package

- **Package**: `@github/copilot-sdk@1.0.0` (matches what was pinned in `package.json`).
- **Engines**: `node >= 20.0.0` (looser than CodeResearch suggested `^20.19.0 || >=22.12.0`; Obsidian's bundled Node should satisfy this comfortably).
- **CLI dependency ships platform-specific binaries.** Installing `@github/copilot-sdk` pulled in `@github/copilot` (`1.0.59`) AND `@github/copilot-win32-x64` — confirming the CodeResearch open question that the underlying CLI is platform-specific. Distribution implication for any future cross-platform shipping: ship platform-conditional builds or document install-by-platform; not a v0.1 issue since v0.1 is a private dev spike on Windows.

### 1.2 SDK API surface (read directly from `dist/index.d.ts` and `dist/types.d.ts`)

- `CopilotClient` — main entry; created with `CopilotClientOptions` (includes `gitHubToken`, `useLoggedInUser`, plus runtime-connection options).
- `CopilotSession` — created via `client.createSession(...)`; methods include `send(prompt | MessageOptions)`, `sendAndWait(prompt | MessageOptions, timeout?)` returning `Promise<AssistantMessageEvent | undefined>`, `abort()`.
- `defineTool(name, def)` — registers a custom tool. Confirmed.
- `approveAll: PermissionHandler` — exported as a convenience for development. Confirmed.
- `PermissionHandler = (request: PermissionRequest, invocation: { sessionId: string }) => Promise<PermissionRequestResult> | PermissionRequestResult` — single callback for ALL permission asks. Confirmed.
- `PermissionRequestResult` is the discriminated union from `PermissionDecisionRequest["result"]` plus `{ kind: "no-result" }`. Variant kinds include `approve-once`, `approve-for-session`, `approve-for-location`, `approve-permanently`, `reject`, `user-not-available`, `no-result`.
- `SessionConfig.onPermissionRequest?: PermissionHandler` — the single choke point for all tool calls. **Architectural premise of v0.1 is preserved at the type level.**

### 1.3 Built-in tool control: ToolSet + BuiltInTools (NEW — affects Phase 6 design)

The SDK exposes a structured layer-1 control over which built-in tools are available, separate from the permission gate:

```ts
// from dist/toolSet.d.ts
const tools = new ToolSet()
    .addBuiltIn(BuiltInTools.Isolated)  // curated set, session-bounded
    .addMcp("*")                          // all MCP tools
    .addCustom("*");                      // all custom-defined tools

// BuiltInTools = { Isolated: readonly string[] }
//   "Built-in tools that operate only within the bounds of a single session —
//    no host filesystem access outside the session, no cross-session state,
//    no host environment access, no network."
```

**Implications for Phase 6 / 7 / 8:**

- The plan currently expresses built-in policy purely through `onPermissionRequest`. With `ToolSet`, we have **two layers** of control: (1) which built-ins are exposed at all (`ToolSet.addBuiltIn`), (2) per-call gating via the permission handler. This is materially better than gating-only.
- For v0.1's CLI-style behavior (Shape 1), we want broader-than-Isolated access — likely `addBuiltIn("*")` plus the permission gate, OR enumerate non-Isolated additions individually (e.g., `addBuiltIn("shell")`, `addBuiltIn("web_fetch")`).
- **Plan amendment recommended after smoke-test** — Phase 6 should construct sessions via a `ToolSet` and document the built-in inclusion policy explicitly.

### 1.4 MCP integration: NATIVE (resolves a Phase 1 open question)

The SDK exports MCP-related types directly:

- `MCPStdioServerConfig`, `MCPHTTPServerConfig`, `MCPServerConfig` — config types for MCP servers.
- `convertMcpCallToolResult` — helper to convert MCP `tools/call` results into the SDK's `ToolResultObject`.
- `ToolSet.addMcp(name | "*")` — explicit MCP tool selection in the tool set.
- `request.kind` permission discriminant includes `"mcp"`.

**Implication for Phase 8**: the SDK has first-class MCP support. **We should USE it, not bridge.** The plan currently describes a manual JSON-RPC client (`McpClient.ts`); that should be replaced with passing `MCPServerConfig` entries through to the SDK's `SessionConfig`. Keep `mcp_servers.json` as the user-facing config file; map its contents to `MCPServerConfig` records at session creation.

### 1.5 Resume session (resolves a Phase 1 open question)

- `ResumeSessionConfig` is exported and is one of the supported `SessionConfig` shapes.
- Phase 9's plan to use `client.resumeSession({...})` (or equivalent) is feasible; need to inspect the exact resume call signature on the client at runtime to settle whether it lives on `CopilotClient` or is implicit via a `SessionConfig` discriminant. (To be confirmed in §3.)

## 2. Build / typecheck (Automated Verification)

| Check                  | Status                                                  |
|------------------------|---------------------------------------------------------|
| `npx tsc --noEmit`     | ✅ passes                                               |
| `npm run build`        | ✅ produces `main.js` (~125 KB) on the implementer host |

## 3. Manual smoke-test results (POPULATED BY USER)

> The implementer cannot run the plugin inside the user's Obsidian build. The user follows §4 to install and run the smoke test, then reports results into the table below. Until populated, Phase 1's manual verification is incomplete and the gate has NOT passed.

| Observation                                        | Result                       |
|----------------------------------------------------|------------------------------|
| Obsidian app version                               | _(pending)_                  |
| `process.versions.node` reported                   | _(pending)_                  |
| `process.versions.electron` reported               | _(pending)_                  |
| Plugin loads with no console errors                | ✅ Loaded clean. Standard Electron WebGL warnings only (unrelated). |
| Notice rendered with model response                | ✅ Rendered (see JSON below).                                       |
| `hello` round-trip text contained "hello"          | ✅ Response: `"hello"` (lowercase, single word).                    |
| `onPermissionRequest` fired for custom `echo` tool | ✅ `kind: "custom-tool"`, `toolName: "echo"`.                       |
| `onPermissionRequest` fired for built-in `shell`   | ✅ **`kind: "shell"`, `toolName: undefined`** — gate confirmed.     |
| Child `@github/copilot` process cleaned up         | ✅ `client.dispose()` ran; no orphaned `copilot.exe` after run.     |
| Any other anomalies / stack traces                 | None after the iteration documented in §5.                          |

### 3.1 Final smoke-test JSON (run that passed)

```json
{
  "nodeVersion": "22.22.1",
  "electronVersion": "39.8.3",
  "sdkVersion": "1.0.0",
  "pingOk": true,
  "helloRoundTripOk": true,
  "helloResponse": "hello",
  "customToolPermissionFired": true,
  "customToolKindReceived": "custom-tool",
  "builtinPermissionFired": true,
  "builtinKindReceived": "shell",
  "errors": [],
  "permissionLog": [
    { "kind": "custom-tool", "toolName": "echo" },
    { "kind": "shell",       "toolName": null    }
  ]
}
```

Selected model (auto-picked from 22 entitled models): **`gpt-5.5`** (preferred `gpt-4.1` not in entitlement list).

## 4. How the user runs the smoke test

1. **Populate the dev token**: copy `src/dev-token.local.example.ts` to `src/dev-token.local.ts`, then replace the placeholder string with the output of `gh auth token` (or a fine-grained PAT that has `models:read`). The file is gitignored.

2. **Build**: from the repo root, `npm run build` (already verified to pass).

3. **Install into a vault**: pick a test vault. Create directory `<vault>/.obsidian/plugins/obsidian-copilot-agent/`. Copy `main.js` and `manifest.json` into it.

4. **Reload Obsidian** (or use the Reload command from a developer plugin). Open Settings → Community Plugins → enable "Copilot Agent (Spike)".

5. **Open DevTools** (`Ctrl+Shift+I`) → Console tab — leave it visible to capture the permission log and the SDK's `Object.keys(...)` dump.

6. **Run the command**: `Ctrl+P` → "Copilot Agent: SDK smoke test". Watch the Notice for the report; watch the console for the structured log.

7. **Capture observations** into the table in §3 (paste into a reply message; I'll fold them in and commit).

8. **Verify cleanup**: after the Notice fades, open Task Manager → Details, filter by `copilot` — confirm no orphaned child processes from the smoke test remain.

## 5. Anomalies / blockers encountered (and how they were resolved)

The first attempts produced three failures; each was triaged and fixed within Phase 1. The final run passed cleanly. Each finding has design implications recorded for Phase 2+.

### 5.1 SDK could not auto-discover the CLI (`Could not find @github/copilot package`)

- **Cause**: esbuild bundles `main.js` into a single file with no sibling `node_modules`. The SDK's `getBundledCliPath()` walks `require.resolve.paths("@github/copilot")` from the bundled file's location, and finds nothing.
- **Fix**: pass `connection: { kind: "stdio", path: <abs-path-to-CLI> }` to `CopilotClient`.
- **Distribution implication for v0.1+**: the plugin must ship the CLI binary alongside `main.js`. Pre-v0.1, document this; in Phase 2's bootstrap module we'll resolve the CLI path relative to the plugin directory (via `app.vault.adapter.getResourcePath()` or Obsidian's `manifest.dir`).

### 5.2 Obsidian.exe rejects `ELECTRON_RUN_AS_NODE` (CRITICAL — affects all v0.1+)

- **Cause**: when `cliPath` points at the JS entry (`@github/copilot/index.js`), the SDK spawns it via `process.execPath`, expecting a Node interpreter. In Obsidian's renderer that's `Obsidian.exe`, and Obsidian has fused out `ELECTRON_RUN_AS_NODE`. The first attempt produced this child stdout: _"Command line interface is not enabled. Please turn it on in Settings > General > Advanced."_ — which is **Obsidian's** message, not the CLI's. The child exited with code 0 and the SDK reported "CLI server exited unexpectedly."
- **Fix**: point `cliPath` at the **standalone Single-Executable App** shipped in the platform peer package — `@github/copilot-win32-x64/copilot.exe` (148 MB, no Node interpreter required). The SDK's spawn logic detects the non-`.js` extension and spawns the binary directly without using `process.execPath`. **`ELECTRON_RUN_AS_NODE` is no longer set.**
- **Distribution implications for v0.1+**:
  - The plugin must ship platform-specific binaries: `copilot.exe` (win32-x64) ~149 MB, plus equivalents for other platforms when we later cross-platform. Per `manifest.json` `isDesktopOnly: true` this is acceptable but increases plugin payload substantially. A future option is downloading the platform peer at install/first-run time — but that's out of scope for the v0.1 dev spike.
  - Phase 2's CopilotSdk module **must** resolve the CLI path to the SEA, not the JS entry. Helper proposed for Phase 2: `resolveCliBinaryPath()` that picks `copilot.exe` / `copilot` / `copilot-darwin-arm64` based on `process.platform` + `process.arch`.
  - Plan amendment recorded for Phase 2 / Phase 6 (see §7 below).

### 5.3 Node-builtin dynamic imports blocked by CORS in renderer

- **Cause**: `await import("node:fs/promises")` from a CJS bundle running in Obsidian's renderer is routed through the browser's fetch loader (because dynamic `import()` of unbundled specifiers stays as a native dynamic import). Renderer fetch refuses non-`http(s)/chrome*` schemes.
- **Fix**: use `(window as any).require(...)` for Node builtins (synchronous CJS require). Obsidian exposes the Node `require` on `window` for desktop plugins.
- **Implication for Phase 2+**: house this in a small `nodeRequire()` helper (or factor into a vault FS adapter directly). Static `import` from `@github/copilot-sdk` works fine because esbuild bundles it.

### 5.4 Default model `gpt-4o-mini` not in entitlement list

- **Cause**: my account's entitled model list does not include `gpt-4o-mini`.
- **Fix**: discover models via `client.listModels()` at session-creation time and pick the first reasonable match (preferring `gpt-4.1` → `gpt-4o` → any `gpt-*` → first available). Final picked: `gpt-5.5`.
- **Implication for Phase 2+**: the bootstrap should expose `listModels()` to the chat panel UI so users can pick — and persist their selection in plugin settings.

## 6. Decision

- [x] **PASS** — onPermissionRequest fires for both custom (`kind: "custom-tool"`) and built-in (`kind: "shell"`) tool calls; round-trip and tool execution succeed; Phase 2 unblocked.
- [ ] BLOCK

## 7. Plan amendments to fold into ImplementationPlan.md

Track these so paw-impl-review and Phase 2 planning don't lose them:

1. **Phase 2** — `CopilotSdk` module must resolve the CLI path to the SEA binary (`@github/copilot-{win32-x64,darwin-arm64,...}/copilot[.exe]`), not the JS entry. Add `resolveCliBinaryPath()` helper.
2. **Phase 2** — wrap `client.listModels()` in a small selection helper used by the chat-panel UI (Phase 4).
3. **Phase 6** — leverage `ToolSet` + `BuiltInTools.Isolated` as layer-1 control alongside the permission gate (already noted in §1.3).
4. **Phase 8** — replace planned manual JSON-RPC MCP bridge with the SDK's native `MCPServerConfig` + `ToolSet.addMcp` (already noted in §1.4).
5. **Phase 9** — `ResumeSessionConfig` is exported and supported (already noted in §1.5).
6. **Distribution** — document that v0.1 ships the per-platform SEA binary alongside `main.js`; this materially increases plugin payload. Out-of-scope alternatives (download-on-first-run) deferred.
