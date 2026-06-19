---
date: 2026-06-18T17:22:44.711-07:00
git_commit: 4b5e07ebd87b96cc7fa10bf2f47c3a42c7beb55b
branch: feature/packaging-release
repository: obsidian-copilot-agent
topic: "Packaging release infrastructure and first-launch Copilot binary fetcher integration"
tags: [research, codebase, packaging-release, release-tooling, binary-fetcher, plugin-startup, brat]
status: complete
last_updated: 2026-06-18
---

# Research: Packaging Release Infrastructure and First-Launch Binary Fetcher Integration

## Research Question

Document the existing implementation terrain for `packaging-release`: plugin startup, Copilot CLI binary resolution and SDK consumption, deploy/build/test/release-adjacent infrastructure, settings/error UI patterns, documentation/PAW conventions, package metadata, and the current absence of release tooling, GitHub Actions workflows, release-agent infrastructure, and `versions.json`.

## Summary

- Plugin startup is centralized in `src/main.ts:onload()`, which resolves the Copilot CLI binary before constructing stores, managers, auth, settings, chat registration, and model-catalog infrastructure (`src/main.ts:102-119`, `src/main.ts:121-214`, `src/main.ts:746-789`).
- CLI binary resolution is currently synchronous and fail-fast: `resolveCliBinaryPath(plugin)` calculates `<plugin-dir>/copilot.exe` on Windows or `<plugin-dir>/copilot` on POSIX, checks `fs.existsSync`, and throws install-copy instructions when missing (`src/sdk/resolveCliBinaryPath.ts:17-46`).
- A missing CLI binary aborts `onload()` before auth/settings/chat wiring; the only user-facing surface at that point is an Obsidian `Notice` with a 12-second timeout and a console error (`src/main.ts:105-119`).
- The SDK is loaded dynamically in two places: a shared `CopilotClient` in `main.ts` for `ModelCatalog` and per-conversation clients in `CopilotAgentSession` (`src/main.ts:305-342`, `src/sdk/AgentSession.ts:2185-2188`, `src/sdk/AgentSession.ts:1260-1267`).
- Both SDK client construction paths pass `connection: { kind: "stdio", path: cliPath }`, so the resolved binary path is a required input to Copilot runtime use (`src/main.ts:336-342`, `src/sdk/AgentSession.ts:1260-1267`).
- `scripts/deploy.mjs` is the only existing artifact-moving script; it uses an ES module shebang script, resolves repo root from `import.meta.url`, resolves a local vault plugin target from `OBSIDIAN_PLUGIN_DIR` or `.deploy-target`, copies root-level plugin artifacts, and optionally copies the platform binary (`scripts/deploy.mjs:1-32`, `scripts/deploy.mjs:34-60`, `scripts/deploy.mjs:62-94`).
- `package.json` has `build`, `dev`, `typecheck`, `test`, `deploy`, and `deploy:no-build`; it has no `release`, `version`, `version-bump`, or GitHub-release script entry at this commit (`package.json:8-15`).
- `manifest.json` currently contains `id`, `name`, `version`, `minAppVersion`, `description`, `author`, and `isDesktopOnly`; it does not contain `authorUrl` or `fundingUrl` at this commit (`manifest.json:1-9`).
- There is no top-level `versions.json` at this commit, as verified by repo-root inspection.
- There is no `.github/workflows/` directory at this commit; `.github/` contains `copilot-instructions.md`, which documents deploy/test/PAW conventions (`.github/copilot-instructions.md:1-73`).
- Current tests run in Vitest node environment with an Obsidian alias to `src/test/obsidianMock.ts`; `npm test -- --reporter=dot` reported 60 test files and 968 passing tests (`vitest.config.ts:4-18`).
- Documentation is plain Markdown: top-level `README.md`, `CHANGELOG.md`, proposal files, `.github/copilot-instructions.md`, and PAW artifacts under `.paw/work/<work-id>/`; no docs-framework config was discovered (`README.md:1-181`, `CHANGELOG.md:1-120`, `.github/copilot-instructions.md:1-73`).
- `@github/copilot-sdk@1.0.0` depends on `@github/copilot@^1.0.57`; the lockfile resolved `@github/copilot@1.0.59`, whose optional dependencies include platform packages for darwin, linux, linuxmusl, and win32 arches (`package.json:19-22`, `package-lock.json:687-707`, `package-lock.json:805-818`).
- The installed Windows x64 optional package contains `node_modules\@github\copilot-win32-x64\copilot.exe`, observed at 148,731,168 bytes; the lockfile records `copilot-win32-x64: copilot.exe` (`package-lock.json:835-849`).

## Documentation System

- **Framework**: Plain Markdown; standard docs are `README.md`, `CHANGELOG.md`, `proposals\*.md`, `.github\copilot-instructions.md`, and PAW artifacts (`README.md:1-181`, `CHANGELOG.md:1-120`, `proposals/0002-packaging-release.md:1-87`, `.github/copilot-instructions.md:1-73`).
- **Docs Directory**: No conventional `docs/` or `documentation/` directory was present in the inspected repo root. Workflow docs live under `.paw\work\<work-id>\Docs.md`, for example `.paw\work\mcp-client\Docs.md` (`.paw/work/mcp-client/Docs.md:1-160`).
- **Navigation Config**: N/A. No navigation config file was discovered; README links directly to PAW docs such as `.paw\work\mcp-client\Docs.md` (`README.md:52`).
- **Style Conventions**: README uses release sections (`What's new`, `Local development setup`, `Safety model`, `Tests`, `Reference`) (`README.md:7-14`, `README.md:105-127`, `README.md:128-147`, `README.md:165-181`). CHANGELOG uses headings `Added`, `Changed`, `Security`, `Migration`, `Dependencies`, `Bundle Size`, and `Tests` (`CHANGELOG.md:6-40`). PAW `Docs.md` uses `Overview`, `Architecture and Design`, `User-Facing Behavior`, `Resilience and Lifecycle`, and `Security Posture` (`.paw/work/mcp-client/Docs.md:1-9`, `.paw/work/mcp-client/Docs.md:53-55`, `.paw/work/mcp-client/Docs.md:104-139`).
- **Build Command**: N/A for docs. No docs-specific build command exists in `package.json`; scripts are build/dev/typecheck/test/deploy/deploy:no-build (`package.json:8-15`).
- **Standard Files**: `README.md`, `CHANGELOG.md`, `.github/copilot-instructions.md`, `proposals/0002-packaging-release.md`; root inspection found no `CONTRIBUTING.md` (`README.md:1-181`, `CHANGELOG.md:1-120`, `.github/copilot-instructions.md:1-73`, `proposals/0002-packaging-release.md:1-87`).

## Verification Commands

- **Test Command**: `npm test` runs `vitest run` (`package.json:8-14`). Verified command `npm test -- --reporter=dot` completed with 60 test files and 968 tests passing.
- **Lint Command**: No `lint` script is present in `package.json` (`package.json:8-15`).
- **Build Command**: `npm run build` runs `node esbuild.config.mjs production` (`package.json:8-10`).
- **Type Check**: `npm run typecheck` runs `tsc --noEmit` (`package.json:8-12`).
- **Deploy Command**: `npm run deploy` runs `npm run build && node scripts/deploy.mjs`; `npm run deploy:no-build` runs only the deploy script (`package.json:13-14`).
- **TypeScript Config**: strict TypeScript, ES2022 target/module, bundler module resolution, DOM and ES2022 libs, `noEmit: true`, and tests excluded from typecheck (`tsconfig.json:2-22`).
- **Vitest Config**: aliases `obsidian` to `src/test/obsidianMock.ts`, uses `node` environment, and includes `src/**/*.test.ts` (`vitest.config.ts:4-18`).

## Detailed Findings

### Spec and Workflow Context

- `WorkflowContext.md` identifies work title, work id, base branch, target branch, execution mode, workflow mode, and continuous session policy (`.paw/work/packaging-release/WorkflowContext.md:1-14`).
- The initial prompt scopes Phase A to reproducible release tooling and CI and Phase B to BRAT compatibility and user-facing install path (`.paw/work/packaging-release/WorkflowContext.md:36-55`).
- Phase A names `scripts/version-bump.mjs`, a GitHub Actions tag-release workflow, explicit `copilot.exe` release handling documentation, and CI running typecheck/tests before build (`.paw/work/packaging-release/WorkflowContext.md:38-44`).
- Phase B names manifest hygiene, top-level `versions.json`, README BRAT installation instructions, and a documented smoke test (`.paw/work/packaging-release/WorkflowContext.md:45-55`).
- Constraints include baseline test coverage, no regression to deploy/build/dev workflows, deploy guidance remaining accurate, and README status-line updates (`.paw/work/packaging-release/WorkflowContext.md:56-61`).
- Out-of-scope items are Community Plugins catalog submission, multi-platform binary distribution, auto-update beyond BRAT, code signing, and telemetry/install analytics (`.paw/work/packaging-release/WorkflowContext.md:63-69`).
- The proposal describes current install-by-clone/deploy behavior and release artifacts, version-bump, BRAT, and community plugin considerations (`proposals/0002-packaging-release.md:7-22`, `proposals/0002-packaging-release.md:25-47`).

### Plugin Startup Entry Point

- `CopilotAgentPlugin` extends Obsidian `Plugin` and owns `ConversationManager`, `ConversationsStore`, shared SDK disposal, `McpSettingsStore`, and `McpManager` fields (`src/main.ts:91-100`).
- `onload()` begins with a console log and then resolves `cliPath` and `baseDirectory` before constructing stores or UI (`src/main.ts:102-119`).
- `cliPath` comes from `resolveCliBinaryPath(this)` and `baseDirectory` from `getAbsolutePluginDir(this) ?? process.cwd()` (`src/main.ts:105-110`).
- If resolution throws, `onload()` logs `[copilot-agent] CLI resolution failed`, creates a `[Copilot Agent] CLI binary not found:` Notice with timeout 12000, and returns (`src/main.ts:110-119`).
- The early `return` means missing binary prevents construction of token/safety/MCP stores, MCP manager, auth controller, settings tab, and chat view in that load attempt (`src/main.ts:121-214`, `src/main.ts:665-789`).
- After CLI resolution succeeds, startup constructs `TokenStore`, `SafetySettingsStore`, and `McpSettingsStore` from plugin `loadData`/`saveData` wrappers (`src/main.ts:121-135`).
- Startup constructs `ConversationsStore` with plugin data dir, adapter, and `notify: (message) => new Notice(message, 8000)` (`src/main.ts:141-157`).
- Startup loads safety and MCP settings in separate `try/catch` blocks and logs failures (`src/main.ts:168-177`).
- Startup captures `exposeRawFsToolsAtStartup` and computes `vaultRoot` from adapter `getBasePath()` or the plugin base directory (`src/main.ts:178-183`).
- Startup constructs `McpManager` with settings provider, Notice-based notify, status persistence, live runtime cancellation hooks, and forced-kill logging (`src/main.ts:188-205`).
- MCP lifecycle startup subscribes to settings changes for reconcile and kicks `startMcpLifecycle(mcpManager)` asynchronously with a catch logger (`src/main.ts:206-214`).
- The per-conversation runtime factory captures `cliPath` and `baseDirectory` and passes them into each `CopilotAgentSession` (`src/main.ts:374-445`).
- Startup constructs `ConversationManager`, token sink, `AuthController`, settings tab, and chat view registration after runtime-factory construction (`src/main.ts:571-615`, `src/main.ts:621-670`, `src/main.ts:746-789`).
- Startup registers a workspace `quit` handler via `makeQuitFlushHandler` and unregisters it if Obsidian returns a ref (`src/main.ts:791-808`).
- `onunload()` nulls owned fields, flushes/disposes conversations, unloads MCP, and stops the shared SDK client (`src/main.ts:811-842`).

### CLI Binary Path Resolution

- `resolveCliBinaryPath.ts` imports `Plugin`, `FileSystemAdapter`, and local `nodeRequire` (`src/sdk/resolveCliBinaryPath.ts:1-3`).
- The file comment documents two reasons not to let the SDK auto-discover: Obsidian cannot interpret `@github/copilot/index.js`, and the bundled `main.js` has no sibling `node_modules/@github/copilot-<platform>/` (`src/sdk/resolveCliBinaryPath.ts:5-16`).
- `resolveCliBinaryPath(plugin)` obtains CommonJS `require` through `nodeRequire()` and requires `node:path`, `node:fs`, and `node:os` (`src/sdk/resolveCliBinaryPath.ts:17-21`).
- The binary name is `copilot.exe` for `win32`, otherwise `copilot` (`src/sdk/resolveCliBinaryPath.ts:23-24`).
- `getAbsolutePluginDir(plugin)` is required; missing plugin dir throws an Obsidian Desktop install error (`src/sdk/resolveCliBinaryPath.ts:26-32`).
- The candidate path is `path.join(pluginDir, binaryName)`, returned only when `fs.existsSync(candidate)` is true (`src/sdk/resolveCliBinaryPath.ts:34-37`).
- Missing candidate throws an error containing the computed path, copy instruction from `node_modules/@github/copilot-${platformPkgSuffix(platform)}/${binaryName}`, and README pointer (`src/sdk/resolveCliBinaryPath.ts:39-46`).
- `getAbsolutePluginDir(plugin)` requires `FileSystemAdapter`, reads `adapter.getBasePath()`, reads `plugin.manifest.dir`, and joins them (`src/sdk/resolveCliBinaryPath.ts:49-60`).
- `platformPkgSuffix(platform)` maps win32/darwin/linux to `${platform}-${process.arch}` with a fallback for other platforms (`src/sdk/resolveCliBinaryPath.ts:62-68`).
- `nodeRequire()` reads `window.require` or `globalThis.require` and throws a Desktop/sandbox message if unavailable (`src/sdk/nodeRequire.ts:1-17`).

### SDK Consumption and Process Management

- `AgentSessionOptions` includes `cliPath`, `gitHubToken`, `baseDirectory`, decider, safety config, model/catalog options, log level, auth-error hook, tools, MCP tools, and preamble (`src/sdk/AgentSession.ts:61-143`).
- The public `AgentSession` surface exposes init, send, streaming send, cancel, reset, token rotation, reconnect, dispose, model access, model swap, approval resolution, and deferred-session status (`src/sdk/AgentSession.ts:226-319`).
- `CopilotAgentSession` stores SDK client/session fields, selected model, disposed flag, init epoch, current token, tool-call state, approvals, first-send state, and deferred-session state (`src/sdk/AgentSession.ts:372-523`).
- The constructor stores options, default SDK loader, current token, defensive tool list, custom tool names, and catalog subscription for deferred recovery (`src/sdk/AgentSession.ts:524-554`).
- `defaultSdkLoader()` dynamically imports `@github/copilot-sdk` (`src/sdk/AgentSession.ts:2185-2188`).
- `init()` rejects when disposed or missing token and memoizes `doInit()` until failure resets the promise (`src/sdk/AgentSession.ts:564-590`).
- `doInit()` constructs `CopilotClient` with token, `useLoggedInUser: false`, `mode: "empty"`, `baseDirectory`, `connection: { kind: "stdio", path: this.opts.cliPath }`, and log level (`src/sdk/AgentSession.ts:1248-1267`).
- `doInit()` optionally calls `client.start()` and `client.ping()` and checks stale init after awaits (`src/sdk/AgentSession.ts:1269-1293`).
- `doInit()` picks a model, can defer `createSession()` when a wired catalog is non-ready, then calls `client.createSession()` with `availableTools: ["builtin:*", "custom:*", "mcp:*"]`, streaming, tools, and permission callback (`src/sdk/AgentSession.ts:1295-1345`).
- `resetConversation()` reuses the client, disconnects the old session, picks a model if needed, and creates a fresh session with the same tool categories and permission callback (`src/sdk/AgentSession.ts:1120-1147`).
- `setToken(token)` cancels pending approvals, stops the runtime, and updates current token (`src/sdk/AgentSession.ts:1223-1233`).
- `reconnect()` stops runtime, calls `init()`, and returns selected model (`src/sdk/AgentSession.ts:1235-1244`).
- `stopRuntime()` increments `initEpoch`, waits briefly for in-flight init, clears runtime fields, disconnects session, stops client, and calls `forceStop` on stop timeout (`src/sdk/AgentSession.ts:1171-1221`).
- The shared model-catalog client in `main.ts` dynamically imports the SDK, constructs `CopilotClient`, calls `start()`/`ping()`, and passes the same `cliPath` through stdio connection (`src/main.ts:305-362`).
- The shared client is rebuilt on token rotation and stopped on plugin unload (`src/main.ts:315-364`, `src/main.ts:621-640`, `src/main.ts:829-840`).

### Current Missing-Binary User Flow

- The only binary existence check is `fs.existsSync(candidate)` inside `resolveCliBinaryPath` (`src/sdk/resolveCliBinaryPath.ts:34-46`).
- The missing-binary exception is caught only in `CopilotAgentPlugin.onload()` and handled as a console error and Notice, followed by `return` (`src/main.ts:105-119`).
- The current Settings tab includes a static `Copilot CLI binary` row describing where to place the binary, but this row is built only after startup reaches settings construction (`src/settings/SettingsTab.ts:194-200`, `src/main.ts:746-757`).
- README local setup instructs copying `main.js`, `manifest.json`, `styles.css`, and the platform binary into the plugin directory, with Windows, macOS, and Linux package paths listed (`README.md:105-123`).
- README explains that the SDK delegates execution to the `@github/copilot` CLI runtime and that the plugin uses the platform-specific single-executable application because Obsidian cannot reuse its Electron executable as Node (`README.md:161-163`).

### Deploy Script and Artifact Movement Pattern

- `scripts/deploy.mjs` is executable (`#!/usr/bin/env node`) and documents its purpose: deploy built plugin artifacts into the Obsidian vault plugin folder (`scripts/deploy.mjs:1-5`).
- The script documents target resolution order: `OBSIDIAN_PLUGIN_DIR`, then `.deploy-target` at repo root (`scripts/deploy.mjs:7-13`).
- Usage comments name `node scripts/deploy.mjs`, `npm run deploy`, and `npm run deploy:no-build` (`scripts/deploy.mjs:15-19`).
- The comment documents that `copilot.exe` is intentionally not redeployed every time because it is about 150 MB and changes only when `@github/copilot-sdk` is bumped; `--with-binary` force-copies it (`scripts/deploy.mjs:24-27`).
- The script imports Node builtins using ES module import syntax (`scripts/deploy.mjs:28-30`).
- `repoRoot` is resolved from `fileURLToPath(import.meta.url)` and two parent directories (`scripts/deploy.mjs:32`).
- `resolveTarget()` checks `process.env.OBSIDIAN_PLUGIN_DIR`, then reads the first line of `.deploy-target`, trims whitespace, and returns null if no target is found (`scripts/deploy.mjs:34-43`).
- Missing target prints a multi-line `console.error` and exits with code 2 (`scripts/deploy.mjs:45-53`).
- Nonexistent or non-directory target prints a target error and exits with code 2 (`scripts/deploy.mjs:55-58`).
- The default copy list is `main.js`, `manifest.json`, and `styles.css` (`scripts/deploy.mjs:60-62`).
- With `--with-binary`, Windows adds `node_modules/@github/copilot-win32-x64/copilot.exe`; Darwin and Linux select arm64 or x64 package paths depending on which exists (`scripts/deploy.mjs:63-75`).
- The copy loop joins source paths to `repoRoot`, skips missing sources with `console.error`, copies to target basename, logs basename and byte size, and counts copied files (`scripts/deploy.mjs:77-90`).
- Completion logs total copied files and a reminder to reload Obsidian through `Reload app without saving` (`scripts/deploy.mjs:92-93`).
- `.gitignore` ignores `.deploy-target`, `main.js`, `*.js.map`, `dist/`, and `build/` (`.gitignore:4-8`, `.gitignore:35-36`).
- `.github/copilot-instructions.md` repeats that Obsidian loads the plugin from the vault folder, not the repo root, and that `npm run deploy` builds then copies artifacts into the vault plugin folder (`.github/copilot-instructions.md:7-23`).

### Build Infrastructure

- `esbuild.config.mjs` imports `esbuild` and Node `builtinModules` (`esbuild.config.mjs:1-2`).
- Production mode is detected by `process.argv.includes("production")` (`esbuild.config.mjs:4`).
- The esbuild context has entry point `src/main.ts`, bundles to root `main.js`, CommonJS format, Node platform, ES2022 target, production sourcemap disabled, production minification enabled, tree shaking enabled, and log level `info` (`esbuild.config.mjs:6-16`).
- Externals are `obsidian`, `electron`, every Node builtin module, and every `node:<builtin>` specifier (`esbuild.config.mjs:17-22`).
- Production mode calls `ctx.rebuild()` then `ctx.dispose()`; non-production mode calls `ctx.watch()` (`esbuild.config.mjs:25-30`).
- `package.json` maps `npm run build` to `node esbuild.config.mjs production` and `npm run dev` to `node esbuild.config.mjs` (`package.json:8-10`).
- `package.json` declares `main` as `main.js`, `type` as `module`, Node engine `>=20.0.0`, and dependencies on `@github/copilot-sdk` and `@modelcontextprotocol/sdk` (`package.json:5-22`).

### Manifest and Package Metadata

- `manifest.json` currently sets `id` to `obsidian-copilot-agent` (`manifest.json:1-3`).
- `manifest.json` sets `name` to `Copilot Agent (Spike)` (`manifest.json:2-4`).
- `manifest.json` sets `version` to `0.1.0`, matching `package.json` version `0.1.0` (`manifest.json:4`, `package.json:2-4`).
- `manifest.json` sets `minAppVersion` to `1.5.0` (`manifest.json:5`).
- `manifest.json` description says this is a private development spike embedding a GitHub Copilot SDK-powered AI agent (`manifest.json:6`).
- `manifest.json` sets `author` to `Chris Krawczyk` (`manifest.json:7`).
- `manifest.json` sets `isDesktopOnly` to `true` (`manifest.json:8`).
- `manifest.json` does not contain `authorUrl` or `fundingUrl` at this commit (`manifest.json:1-9`).
- `package.json` sets `private` to `true` (`package.json:5`).
- `package.json` has no release-specific scripts beyond build/test/typecheck/deploy (`package.json:8-15`).
- `package.json` includes a comment key noting MCP SDK exact pinning for v0.5 transport security review (`package.json:30`).

### README and Changelog State

- README status line states v0.5 is working end-to-end on Windows desktop and is "Not yet packaged for distribution" (`README.md:1-6`).
- README has an MCP setup section for v0.5 with stdio and Streamable HTTP examples (`README.md:14-52`).
- README local development setup instructs dependency install, build, vault plugin directory creation, artifact copy, binary copy, deploy target setup, sign-in, and chat usage (`README.md:105-127`).
- README tests section lists `npm test`, `npm run typecheck`, and `npm run build` (`README.md:165-171`).
- README test-count text says v0.5 brings the suite to 944 tests, while the current verified test run reported 968 passing tests (`README.md:173`).
- CHANGELOG top heading is `[0.5.0] – Unreleased` (`CHANGELOG.md:6`).
- CHANGELOG records v0.5 MCP additions, changed approval scope, security notes, migration note, dependency note, bundle-size measurement, and test count of 944 (`CHANGELOG.md:8-40`).
- CHANGELOG v0.4 records model picker, settings default model, recovery flows including inline Retry, lazy model resolution, deferred SDK-session creation, and single-source send gate (`CHANGELOG.md:41-68`).

### Settings UI Patterns

- `CopilotAgentSettingTab` extends `PluginSettingTab` and stores unsubscribe handles, model dropdown container, one-shot unavailable notice flag, connection description/setting refs, and optional `McpServersSection` (`src/settings/SettingsTab.ts:24-37`).
- `display()` disposes any previous MCP section, empties the container, creates heading `Copilot Agent`, and builds the connection row before settings sections (`src/settings/SettingsTab.ts:51-67`).
- The token persistence setting uses Obsidian `Setting`, long description copy, and an async toggle `onChange` that calls `authController.setPersistEnabled(value)` (`src/settings/SettingsTab.ts:68-83`).
- The default-model settings section is rendered only when both safety store and model catalog are present (`src/settings/SettingsTab.ts:85-88`, `src/settings/SettingsTab.ts:366-454`).
- Safety settings use Obsidian `Setting` rows for default policy dropdown, vault allowlist textarea, raw-FS exposure toggle, and built-in auto-approve toggles (`src/settings/SettingsTab.ts:90-184`).
- The static `Copilot CLI binary` row describes binary placement and references README installation details (`src/settings/SettingsTab.ts:194-200`).
- Vault awareness settings use dropdowns, text areas, text inputs, and a `<details>` preview with a `<pre>` element (`src/settings/SettingsTab.ts:228-352`).
- `hide()` unsubscribes auth/catalog listeners, disposes MCP section, clears model dropdown state, resets one-shot notice flag, and calls `super.hide?.()` (`src/settings/SettingsTab.ts:354-364`).
- `renderConnection(state)` uses `describeState` and `buttonDesc`, clears and rebuilds the connection button row on every transition, and renders Connect/Reconnect/Cancel/Disconnect depending on auth state (`src/settings/SettingsTab.ts:456-491`).
- `describeState()` returns inline status copy for disconnected, connecting, validating, connected, and error auth states (`src/settings/SettingsTab.ts:504-520`).
- `buttonDesc()` returns per-state helper text; error state text is "Click Reconnect to start a fresh Device Flow." (`src/settings/SettingsTab.ts:523-534`).
- `openDeviceFlowModal()` calls `authController.connect()` before opening `DeviceFlowModal` (`src/settings/SettingsTab.ts:493-500`).

### MCP Settings UI Error and Retry Pattern

- `McpServersSectionOptions` accepts store, manager, safety store, vault root, optional path existence callback, and optional notify callback (`src/settings/McpServersSection.ts:16-23`).
- `mount()` creates a region with `aria-label="MCP servers settings"`, subscribes to store and manager changes, and renders immediately (`src/settings/McpServersSection.ts:45-54`).
- `dispose()` sets disposed state, clears form state, unsubscribes, and disposes DOM (`src/settings/McpServersSection.ts:56-68`).
- `render()` skips when disposed/rootless, defers re-render while form is open, creates heading/description/Add button, and renders configured rows (`src/settings/McpServersSection.ts:70-94`).
- Each server row displays server name, id, transport, enabled state, runtime status label/icon, and tool count (`src/settings/McpServersSection.ts:96-108`, `src/settings/McpServersSection.ts:332-341`).
- Last errors render in a `<pre>` with class `copilot-agent-mcp-last-error`, `role="status"`, an `aria-label`, and `redactSensitive(lastError)` text (`src/settings/McpServersSection.ts:109-116`).
- `stderrTail` renders similarly in a `<pre>` with class `copilot-agent-mcp-stderr` and redacted text (`src/settings/McpServersSection.ts:117-123`).
- Denylist env warnings render as a `role="alert"` div with class `copilot-agent-mcp-env-warning` (`src/settings/McpServersSection.ts:124-135`).
- Row actions are `Edit`, `Enable`/`Disable`, `Reconnect`, and `Remove` buttons (`src/settings/McpServersSection.ts:138-149`).
- The `Reconnect` button is disabled when the server is not enabled and calls `manager.manualReconnect(server.id)`, catching failures through `noticeError` (`src/settings/McpServersSection.ts:145-148`).
- Form validation errors and warnings are joined into a modal message element with `role="alert"` and `aria-label="MCP server form message"` (`src/settings/McpServersSection.ts:217-247`).
- `saveForm()` notifies for explicit denylisted env overrides, one-shot authorization storage notice, trust epoch changes, and calls `manager.enable(config.id)` for enabled servers with catch to `noticeError` (`src/settings/McpServersSection.ts:255-270`).
- `setEnabled()` saves enabled state, calls manager enable/disable, then notifies that a new conversation is needed for tool roster changes to take effect (`src/settings/McpServersSection.ts:272-283`).
- `noticeError(err)` surfaces `[Copilot Agent] MCP server operation failed: ...` through `notify`, after redaction (`src/settings/McpServersSection.ts:304-311`).
- The helper `notify(message)` uses injected `options.notify` when present, otherwise `new Notice(message, 8000)` (`src/settings/McpServersSection.ts:304-307`).
- MCP UI tests use fake DOM elements and injected `notify` arrays to assert flows and notices without a DOM environment (`src/settings/McpServersSection.test.ts:1-94`).
- Tests cover add/edit/remove/enable/disable/reconnect flow, expecting `manager.manualReconnect` to receive the normalized server id (`src/settings/McpServersSection.test.ts:96-127`).
- Tests assert last-error and server-log rendering are plain text, redacted, and use `<pre>` tags (`src/settings/McpServersSection.test.ts:154-178`).
- Lifecycle tests assert repeated mount/dispose cleans store and manager subscriptions and destroyed DOM nodes are not updated after dispose (`src/settings/McpServersSection.lifecycle.test.ts:31-62`).

### Chat Inline Error, Retry, and Notice Patterns

- `ChatView` imports Obsidian `Notice` and uses it for conversation, settings, send, model-swap, streaming, and undo errors (`src/ui/ChatView.ts:1-31`).
- Chat view fields include inline error elements (`inlineErrorEl`, `inlineErrorMsgEl`, `inlineErrorRetryEl`) for model/catalog blocked states (`src/ui/ChatView.ts:174-181`).
- `onOpen()` builds an inline error banner above the textarea, hidden by default, with message span and `Retry` button (`src/ui/ChatView.ts:359-380`).
- The Retry button calls `this.modelCatalog.refresh()` and logs `[ChatView] catalog retry failed` on catch (`src/ui/ChatView.ts:371-379`).
- `refreshSendGate()` computes `canSend()` from auth, streaming, pending, catalog state, and active model id, then uses four banner reasons: unavailable model, catalog error, catalog empty, and unresolved model (`src/ui/ChatView.ts:531-552`).
- When the send gate is blocked for a banner reason, the banner is shown, text is set to `result.reason`, and the retry button is shown only for `catalog-error` (`src/ui/ChatView.ts:553-560`).
- The send button is disabled when `canSend()` is not ok and the view is not pending or streaming (`src/ui/ChatView.ts:563-568`).
- `canSend()` is a pure function in `modelPickerLogic.ts` with precedence `connection-loss > streaming > pending > unavailable-model > catalog-error > catalog-empty > unresolved-model` (`src/ui/modelPickerLogic.ts:204-244`).
- `canSend()` returns user-facing reason text for connection loss, streaming, pending, unavailable model, catalog error, catalog empty, and unresolved model (`src/ui/modelPickerLogic.ts:245-306`).
- `modelPickerLogic.ts` documents the DOM-free extraction pattern for testing UI decisions in node (`src/ui/modelPickerLogic.ts:1-12`).
- `modelPickerLogic.test.ts` states these pure-logic tests run in node without DOM/Obsidian and mirror `chatKeydown` and `conversationPickerLogic` patterns (`src/ui/modelPickerLogic.test.ts:1-15`).
- Chat view uses Notice for model swap cancellation and failure (`src/ui/ChatView.ts:623-642`).
- Chat view uses immediate placeholder interruption before cancellation when Stop is clicked, so visible state updates before awaiting SDK cancellation (`src/ui/ChatView.ts:738-765`).
- Chat view send gating shows a Notice and returns before mutating state when `canSend()` blocks send (`src/ui/ChatView.ts:767-784`).
- Chat view reports missing runtime as `Conversation not ready yet — please retry.` Notice (`src/ui/ChatView.ts:785-792`).
- Chat view catches stream errors and surfaces `Copilot Agent error: ...` Notice with timeout 8000 (`src/ui/ChatView.ts:993-1001`).
- `ChatView.modelPick.test.ts` mocks Obsidian `Notice` and tests conversation-change cancellation and streaming placeholder interruption before model swap (`src/ui/ChatView.modelPick.test.ts:1-42`, `src/ui/ChatView.modelPick.test.ts:100-168`).

### User-Facing Error and Notice Surfaces

- Startup missing CLI binary uses a 12000-ms Notice (`src/main.ts:112-117`).
- Conversation history recovery uses a 12000-ms Notice naming the recovery path (`src/main.ts:689-697`).
- Auth hydrate failure uses an 8000-ms Notice with the error message (`src/main.ts:735-742`).
- Unavailable default model uses a 6000-ms Notice (`src/main.ts:608-612`).
- Settings fallback for opening settings uses a 6000-ms Notice instructing the user to open Settings → Community plugins → Copilot Agent (`src/main.ts:772-787`).
- `McpManager` notifies MCP server failures and inventory refresh failures through `options.notify` after redaction (`src/mcp/McpManager.ts:60-66`, `src/mcp/McpManager.ts:136-141`, `src/mcp/McpManager.ts:324-335`).
- `McpManager` sanitizes persisted snapshots by redacting `lastError`, `stderrTail`, and `instructions` before status persistence (`src/mcp/McpManager.ts:305-310`, `src/mcp/McpManager.ts:427-433`).
- `redactSensitive()` redacts Authorization headers, bearer tokens, MCP session IDs, token-like query parameters, URL userinfo, and denylisted env assignment values (`src/mcp/redactSensitive.ts:1-47`).
- CSS styles status errors with `var(--text-error)` (`styles.css:167-192`).
- CSS styles the inline error banner with flex layout, secondary background, error border, and Retry button spacing (`styles.css:558-583`).
- CSS styles MCP settings section, modal fields, checkboxes, and last-error/stderr blocks; error blocks are selectable, pre-wrapped, scrollable, monospace, and have an error-colored left border (`styles.css:585-675`).

### MCP Lifecycle and Disable/Freeze Related Context

- `McpManager.disable()` has idempotency guards for no runtime/no inventory/no reconnect policy and already-disabled runtime with no inventory (`src/mcp/McpManager.ts:70-82`).
- The disable guard comment states the settings-store subscriber re-invokes reconcile on every persist and the short-circuit prevents a self-feeding loop that freezes the UI (`src/mcp/McpManager.ts:72-76`).
- `disable()` bumps generation, cancels notification queue and reconnect policy, deletes inventory, settles tracked calls, disables runtime, persists snapshot, or emits when no runtime exists (`src/mcp/McpManager.ts:83-94`).
- `manualReconnect()` single-flights reconnect by returning any existing connect promise; otherwise it calls `manualReconnectInternal` and clears the promise in finally (`src/mcp/McpManager.ts:104-112`).
- `performManualReconnect()` deletes inventory, settles calls, rebinds runtime identity if changed, clears volatile session, calls runtime manual reconnect/reconnect, validates duplicate tools, rejects collisions, stores inventory, records success, and persists snapshot (`src/mcp/McpManager.ts:121-142`).
- `statusSnapshot()` overlays reconnecting/crashloop policy status on runtime snapshots and freezes the result (`src/mcp/McpManager.ts:196-208`).
- MCP lifecycle tests cover no-server startup, enabled servers starting in parallel with `allSettled`, disabled servers not connecting, unload idempotency, remove clearing grants, disable/remove settling tracked calls before runtime shutdown, and parallel unload cap (`src/main.mcpLifecycle.test.ts:29-156`).

### Model Catalog and Retry Infrastructure

- `ModelCatalog` wraps `client.listModels()` and exposes state to UI and AgentSession creation (`src/sdk/ModelCatalog.ts:1-27`).
- Catalog state is `loading`, `ready`, `empty`, or `error` (`src/sdk/ModelCatalog.ts:42-46`).
- `filterChatCapable()` hard-excludes disabled models and logs but retains soft-signal ids matching embedding/image/dall-e/whisper/tts (`src/sdk/ModelCatalog.ts:50-78`).
- The catalog client provider may return null; null transitions to error message `Not signed in to Copilot.` (`src/sdk/ModelCatalog.ts:80-90`, `src/sdk/ModelCatalog.ts:156-165`).
- `refresh()` single-flights concurrent refresh calls and queues a follow-up refresh when another call arrives mid-flight (`src/sdk/ModelCatalog.ts:130-154`).
- `doRefresh()` transitions to loading, checks client/listModels, handles thrown errors as error state, filters models, transitions empty for zero chat models, and ready otherwise (`src/sdk/ModelCatalog.ts:156-190`).
- `transition()` stores state and notifies listeners while swallowing listener errors (`src/sdk/ModelCatalog.ts:192-201`).
- ModelCatalog tests cover loading→ready, empty state, error state, missing listModels, null client, listener notifications, and retry after failure (`src/sdk/ModelCatalog.test.ts:114-180`).

### Test Infrastructure and Patterns

- Tests live alongside source under `src/**/*.test.ts` and are included by Vitest config (`vitest.config.ts:12-18`).
- `src/test/obsidianMock.ts` provides minimal mock classes for `ItemView`, `Plugin`, `PluginSettingTab`, `Setting`, `Notice`, `Modal`, `Menu`, and `MarkdownView` (`src/test/obsidianMock.ts:1-120`).
- The mock `Notice` stores message and timeout constructor args (`src/test/obsidianMock.ts:84-89`).
- The repo currently has 60 `.test.ts` files and 72 non-test `.ts` files under `src`, from filesystem inspection.
- Verified `npm test -- --reporter=dot` reported 60 passed test files and 968 passed tests.
- `AgentSession.test.ts` uses fake SDK handles, fake clients/sessions, and constructs `CopilotAgentSession` with fake `cliPath` and injected SDK loader (`src/sdk/AgentSession.test.ts:23-160`).
- `ConversationRuntime.test.ts` documents the pure-helper and cross-runtime isolation test pattern for runtime helpers (`src/domain/ConversationRuntime.test.ts:1-9`).
- `McpServersSection.test.ts` uses fake DOM classes and injected managers/stores to test settings UI behavior in node (`src/settings/McpServersSection.test.ts:8-94`).
- `ChatView.modelPick.test.ts` uses `vi.mock("obsidian")` and module mocks for conversation picker helpers (`src/ui/ChatView.modelPick.test.ts:1-42`).
- `.github/copilot-instructions.md` states Vitest runs in node, UI code needing unit tests should be extracted into pure functions, and jsdom/happy-dom should not be added for one-off UI tests (`.github/copilot-instructions.md:39-45`).

### `@github/copilot` Package Layout

- `package-lock.json` records `node_modules/@github/copilot` version `1.0.59`, package bin `copilot: npm-loader.js`, and dependency on `detect-libc` (`package-lock.json:687-697`).
- The same lockfile entry lists optional dependencies for darwin arm64/x64, linux arm64/x64, linuxmusl arm64/x64, and win32 arm64/x64 (`package-lock.json:698-707`).
- Darwin optional packages have `os: [darwin]`, matching CPU, and bin entries mapping package-specific command names to `copilot` (`package-lock.json:709-739`).
- Linux optional packages have `os: [linux]`, matching CPU, and bin entries mapping package-specific command names to `copilot` (`package-lock.json:741-803`).
- `@github/copilot-sdk` version `1.0.0` depends on `@github/copilot`, `vscode-jsonrpc`, and `zod`, and requires Node `>=20.0.0` (`package-lock.json:805-818`).
- Windows arm64 optional package has `os: [win32]`, `cpu: [arm64]`, and bin `copilot-win32-arm64: copilot.exe` (`package-lock.json:819-833`).
- Windows x64 optional package has `os: [win32]`, `cpu: [x64]`, and bin `copilot-win32-x64: copilot.exe` (`package-lock.json:835-849`).
- Installed `node_modules/@github/copilot` includes directories such as `builtin-skills`, `copilot-sdk`, `definitions`, `mxc-bin`, `prebuilds`, `sdk`, and files including `app.js`, `index.js`, `npm-loader.js`, `README.md`, and `LICENSE.md`, from filesystem inspection.
- Installed `node_modules/@github/copilot-win32-x64` includes `copilot.exe`, `LICENSE.md`, `package.json`, and `README.md`, from filesystem inspection.
- Installed `node_modules/@github/copilot-win32-x64/copilot.exe` was observed at 148,731,168 bytes, from filesystem inspection.

### Existing PAW Workflow Artifacts

- `.github/copilot-instructions.md` states this repo uses PAW, workflow artifacts live under `.paw/work/<work-id>/`, stage transitions should use PAW transition rules, and active context lives in `WorkflowContext.md` (`.github/copilot-instructions.md:53-62`).
- Existing work directories observed under `.paw/work` include `chat-ux-vault-tools`, `copilot-sdk-spike`, `mcp-client`, `model-picker`, `multi-conversation-persistence`, and `packaging-release`.
- Prior workflows contain combinations of `WorkflowContext.md`, `Spec.md`, `CodeResearch.md`, `ImplementationPlan.md`, and sometimes `Docs.md`; for example `mcp-client` includes `WorkflowContext.md`, `Spec.md`, `ImplementationPlan.md`, and `Docs.md` from filesystem inspection.
- The `mcp-client` workflow context follows the same context fields: work title/id, base/target branch, execution mode, workflow mode, review/planning strategies, prompt, constraints, out-of-scope list, issue URL, remote, and artifact lifecycle (`.paw/work/mcp-client/WorkflowContext.md:1-75`).
- The `mcp-client` `Docs.md` serves as a technical reference with architecture, stores, manager/runtime, transport/security, protocol compatibility, user-facing behavior, resilience, and security posture (`.paw/work/mcp-client/Docs.md:1-160`).
- README links to `.paw\work\mcp-client\Docs.md` as the full technical reference for MCP (`README.md:52`).

### Release Tooling, GitHub Actions, and Release Agent Absence

- No `scripts/version-bump.mjs` exists at this commit; the only file under `scripts/` is `scripts/deploy.mjs`, from filesystem inspection.
- `package.json` contains no `release`, `version`, or `version-bump` script entries (`package.json:8-15`).
- No top-level `versions.json` exists at this commit, from repo-root filesystem inspection.
- No `.github/workflows/` directory exists at this commit; `.github` contains `copilot-instructions.md`, from filesystem inspection.
- No in-repo release agent or release skill directory exists at this commit; workflow artifacts for this work currently consist of `Spec.md`, `WorkflowContext.md`, and this `CodeResearch.md`, from filesystem inspection and `.paw/work/packaging-release/WorkflowContext.md:1-76`.
- `CHANGELOG.md` exists and is currently in an unreleased v0.5 state (`CHANGELOG.md:1-40`).
- `manifest.json` and `package.json` versions both read `0.1.0` at this commit (`manifest.json:4`, `package.json:2-4`).
- `versions.json` version-to-min-app-version map is not present in root inspection, while `manifest.json` has `minAppVersion: 1.5.0` (`manifest.json:5`).

## Code References

- `src/main.ts:102-119` - Plugin startup resolves CLI binary and aborts with Notice on failure.
- `src/main.ts:188-205` - MCP manager construction with Notice notification and runtime cancellation hooks.
- `src/main.ts:305-342` - Shared SDK client dynamic import and CopilotClient construction with stdio CLI path.
- `src/main.ts:442-530` - Per-conversation runtime factory constructs `CopilotAgentSession` with `cliPath`, `baseDirectory`, tools, MCP tools, safety, and preamble.
- `src/main.ts:621-640` - Token sink broadcasts token changes, rebuilds shared client, and refreshes model catalog.
- `src/main.ts:746-789` - Settings tab construction and chat view registration.
- `src/main.ts:811-842` - Plugin unload flush/dispose sequence.
- `src/sdk/resolveCliBinaryPath.ts:17-46` - CLI binary path resolution and missing-binary error text.
- `src/sdk/resolveCliBinaryPath.ts:49-60` - Absolute plugin directory resolution from FileSystemAdapter and manifest dir.
- `src/sdk/nodeRequire.ts:5-17` - CommonJS `require` access from Obsidian renderer.
- `src/sdk/AgentSession.ts:1248-1345` - Per-session SDK client startup and createSession.
- `src/sdk/AgentSession.ts:1171-1221` - SDK runtime stop and force-stop behavior.
- `src/sdk/ModelCatalog.ts:130-190` - Model catalog refresh state machine.
- `src/settings/SettingsTab.ts:194-200` - Static Copilot CLI binary settings row.
- `src/settings/McpServersSection.ts:109-148` - Last-error/stderr display and row action buttons including Reconnect.
- `src/settings/McpServersSection.ts:304-311` - Settings-section notify/error Notice helper.
- `src/ui/ChatView.ts:359-380` - Inline error banner and Retry button pattern.
- `src/ui/ChatView.ts:531-568` - Send-gate banner visibility and Retry display logic.
- `src/ui/modelPickerLogic.ts:204-306` - Pure send-block reason taxonomy and copy.
- `scripts/deploy.mjs:34-94` - Deployment target resolution and artifact copy loop.
- `esbuild.config.mjs:6-30` - Production build/watch configuration and externals.
- `package.json:8-15` - Current npm scripts.
- `manifest.json:1-9` - Current Obsidian manifest fields.
- `package-lock.json:687-849` - `@github/copilot` optional platform packages and binary entries.

## Architecture Documentation

- Startup architecture is ordered around binary resolution first, then persisted stores, MCP lifecycle, runtime factory, conversation manager, auth, settings, chat UI, and quit/unload handlers (`src/main.ts:102-842`).
- Binary path architecture assumes the binary is already present in the plugin install directory; the resolver does not inspect `node_modules` at runtime except to mention package paths in the thrown error text (`src/sdk/resolveCliBinaryPath.ts:34-46`).
- SDK architecture passes a concrete stdio binary path into every CopilotClient; no SDK client is constructed without `cliPath` (`src/main.ts:336-342`, `src/sdk/AgentSession.ts:1260-1267`).
- Settings architecture uses Obsidian `Setting` rows for standard settings, custom DOM construction for MCP server forms, and injected callbacks for testability (`src/settings/SettingsTab.ts:51-226`, `src/settings/McpServersSection.ts:16-94`).
- User-facing transient errors are commonly surfaced through `Notice` with explicit timeout values, while persistent row-level MCP errors render in settings as redacted text in `<pre>` blocks (`src/main.ts:112-117`, `src/settings/McpServersSection.ts:109-123`).
- Retry affordance pattern exists in chat model-catalog recovery: a visible inline banner with button calls a refresh method and logs refresh failure (`src/ui/ChatView.ts:359-380`, `src/ui/ChatView.ts:531-560`).
- Deploy tooling pattern is ES module Node script, explicit repo-root resolution, local target configuration via env or gitignored file, process exit code 2 for configuration failures, and basename-copy of root release artifacts (`scripts/deploy.mjs:28-94`).
- Test architecture keeps UI decision logic in pure sibling modules for node tests; fake DOM/Obsidian mocks are used only where component orchestration itself is under test (`src/ui/modelPickerLogic.ts:1-12`, `src/settings/McpServersSection.test.ts:8-94`, `vitest.config.ts:12-18`).
- PAW artifact architecture stores workflow materials under `.paw/work/<work-id>/`; previous workflows show `Docs.md` as the repository-local technical reference artifact after implementation (`.github/copilot-instructions.md:53-62`, `.paw/work/mcp-client/Docs.md:1-160`).

## Open Questions

- None requiring user input for code research. The researched repo state neutrally records current absences: no `versions.json`, no `.github/workflows/`, no `scripts/version-bump.mjs`, and no in-repo release-agent/skill infrastructure at this commit.

## Additional Detailed File Map

### Startup File Map

- `src/main.ts` imports `Notice`, `MarkdownView`, and `Plugin` from Obsidian at the top of the plugin entry file (`src/main.ts:1`).
- `src/main.ts` imports SDK-facing types and `CopilotAgentSession` from `./sdk/AgentSession` (`src/main.ts:2-8`).
- `src/main.ts` imports `ModelCatalog` from `./sdk/ModelCatalog` (`src/main.ts:9`).
- `src/main.ts` imports both `resolveCliBinaryPath` and `getAbsolutePluginDir` from `./sdk/resolveCliBinaryPath` (`src/main.ts:10-13`).
- `src/main.ts` imports `registerChatView` from `./ui/ChatViewRegistration` (`src/main.ts:15`).
- `src/main.ts` imports `CopilotAgentSettingTab` from `./settings/SettingsTab` (`src/main.ts:16`).
- `src/main.ts` imports auth, persistence, vault tool factories, safety, MCP store/manager/registry/bridge, preamble, date formatting, tool gating, conversation manager, lifecycle helpers, and runtime helpers before class definition (`src/main.ts:17-46`).
- The small exported MCP lifecycle helpers call `enableAllConfigured`, `reconcileConfiguredServers`, and `unload` on manager-like inputs (`src/main.ts:48-64`).
- `disableMcpServerLifecycle` delegates to `manager.disable(serverId)` (`src/main.ts:66-71`).
- `removeMcpServerLifecycle` calls `manager.remove(serverId)` then revokes grants for the server (`src/main.ts:73-80`).
- Startup's `liveRuntimes` set tracks instantiated runtime sessions and conversation ids (`src/main.ts:184-187`).
- MCP manager `settleTrackedCalls` iterates live runtimes and cancels pending MCP approvals and calls for the affected server (`src/main.ts:194-199`).
- The runtime factory constructs a per-runtime undo journal using `makeRuntimeJournal` (`src/main.ts:379-390`).
- The runtime factory constructs read, write, read-note, search, and write-note tools inside the factory (`src/main.ts:392-423`).
- The runtime factory filters raw filesystem tools using the startup snapshot of `exposeRawFsToolsAtStartup` (`src/main.ts:424-433`).
- The runtime factory builds an MCP snapshot from manager inventory/status, built-in tool names, and a Notice-based collision notify callback (`src/main.ts:434-440`).
- Each `CopilotAgentSession` receives `decider: denyAll`, `logLevel: "info"`, `catalog: modelCatalog`, vault tools, MCP tools, safety config, and preamble callback (`src/main.ts:442-530`).
- Runtime disposal removes the live runtime entry, then calls `session.dispose()` and logs failures (`src/main.ts:559-566`).
- `ConversationManager` receives `resolveCreationModelId` and `onUnavailableDefault` callbacks from startup (`src/main.ts:573-613`).
- Hydration loads token store, loads conversations, handles recovery Notice, prunes stale conversation data, hydrates the manager, warms active runtime, hydrates auth controller, then refreshes model catalog if a token is present (`src/main.ts:679-734`).
- Hydration catch logs `[copilot-agent] hydrate failed` and shows `[Copilot Agent] Auth hydrate failed: ...` Notice (`src/main.ts:735-742`).
- Chat registration passes the conversation manager, auth controller, settings opener, raw-FS startup snapshot getter, and model catalog (`src/main.ts:759-789`).

### Lifecycle Helper File Map

- `src/lifecycle.ts` documents why lifecycle helpers were extracted from `main.ts`: unit-testing flush-before-dispose ordering and workspace quit flushing without constructing the full plugin (`src/lifecycle.ts:1-9`).
- `flushThenDispose()` accepts nullable flush and dispose sinks (`src/lifecycle.ts:30-33`).
- `flushThenDispose()` calls `store.flushNow()` first and logs `[copilot-agent] conversationsStore.flushNow threw` on failure (`src/lifecycle.ts:34-40`).
- `flushThenDispose()` then calls `manager.disposeAll()` and logs `[copilot-agent] manager.disposeAll threw` on failure (`src/lifecycle.ts:41-48`).
- `makeQuitFlushHandler()` builds an async callback that reads the store lazily via `getStore()` and calls `flushNow()` (`src/lifecycle.ts:57-67`).
- `makeQuitFlushHandler()` logs `[copilot-agent] quit-flush threw` on errors instead of rethrowing (`src/lifecycle.ts:61-66`).

### SDK Adapter File Map

- `AgentSession.ts` defines normalized assistant message and tool-call shapes consumed by UI (`src/sdk/AgentSession.ts:21-59`).
- `AssistantToolCall.source` distinguishes custom, MCP, and built-in tool sources (`src/sdk/AgentSession.ts:34-40`).
- `StreamEvent` includes delta, tool-call start, tool-call complete, approval prompt, approval resolved, and complete variants (`src/sdk/AgentSession.ts:166-202`).
- `SDK_IDLE_TIMEOUT_MS` is 180 seconds, `SDK_HARD_CEILING_MS` is 30 minutes, and `STOP_TIMEOUT_MS` is 5 seconds (`src/sdk/AgentSession.ts:321-326`).
- `resolveHeuristicModelId()` prefers enabled `gpt-4.1`, then enabled `gpt-4o`, then first enabled id starting with `gpt-`, then first enabled record (`src/sdk/AgentSession.ts:328-370`).
- `sendMessage()` awaits `init()`, blocks deferred sessions with a model-catalog message, checks `session`, resets per-turn tool state, and installs an idle timer (`src/sdk/AgentSession.ts:592-620`).
- `sendMessageStreaming()` uses queue/drain/finally behavior to yield events, handle failures, and abort early-closed streams (`src/sdk/AgentSession.ts:880-959`).
- `cancelCurrent()` cancels pending approvals and calls SDK `session.abort()` when available (`src/sdk/AgentSession.ts:961-970`).
- `swapModel()` handles disposed checks, empty id checks, identity no-op, deferred recovery, no-session override, SDK `setModel`, pending approval cancellation, and current-turn cancellation (`src/sdk/AgentSession.ts:990-1049`).
- `wrapWithPreamble()` prepends the preamble only on first send of an SDK session and records probe text for tests (`src/sdk/AgentSession.ts:1051-1087`).
- `toolsForSession()` combines static tool list and MCP tool snapshot, catching MCP snapshot callback errors (`src/sdk/AgentSession.ts:1089-1100`).
- Minimal SDK structural interfaces are declared locally for `SdkModule`, `SdkModelInfo`, `SdkClient`, and `SdkSessionOptions` (`src/sdk/AgentSession.ts:2190-2221`).

### Settings and Form Logic File Map

- `McpServersSection.ts` imports `redactSensitive` before rendering server diagnostics (`src/settings/McpServersSection.ts:1-14`).
- The MCP section stores `lastGrantNoticeEpochByServer`, `formOpen`, and `renderQueuedWhileFormOpen` to coordinate notices and render timing (`src/settings/McpServersSection.ts:34-42`).
- `openForm()` builds an inline dialog with fields for id, name, transport, command, arguments, URL, Authorization, working directory, environment, timeout, private-network confirmation, message, save, and cancel (`src/settings/McpServersSection.ts:152-220`).
- Authorization input is `type = "password"` and uses a dataset flag to track redaction state (`src/settings/McpServersSection.ts:191-204`).
- Save builds `McpServerFormInput`, runs `validateMcpServerForm`, writes errors/warnings into the message element, and calls `saveForm()` on success (`src/settings/McpServersSection.ts:221-252`).
- `handleTrustEpochChange()` revokes grants when trust epoch changes and deduplicates per-server trust-epoch notices (`src/settings/McpServersSection.ts:293-302`).
- Helper `statusDisplay()` maps connected, connecting, reconnecting, crashloop, error, disabled, and default disconnected statuses to icon/label pairs (`src/settings/McpServersSection.ts:332-341`).
- Helpers `input`, `textarea`, `select`, and `checkbox` create labeled controls with `aria-label` attributes (`src/settings/McpServersSection.ts:362-405`).
- `confirmRemove()` uses `window.confirm` when available and otherwise returns true (`src/settings/McpServersSection.ts:421-425`).
- `shouldShowAuthorizationNotice()` returns true when an HTTP config gains an authorization value for the first time (`src/settings/McpServersSection.ts:466-473`).
- `SettingsTab.ts` imports `fs` from `node:fs` and injects `pathExists: (path) => fs.existsSync(path)` into `McpServersSection` (`src/settings/SettingsTab.ts:1-2`, `src/settings/SettingsTab.ts:207-218`).
- `renderDefaultModelSection()` rebuilds the model dropdown subtree on catalog changes instead of rerunning the entire settings display (`src/settings/SettingsTab.ts:366-454`).
- The default-model dropdown includes an `Auto (heuristic)` sentinel represented as empty string, translated to/from `null` at the boundary (`src/settings/SettingsTab.ts:393-397`, `src/settings/SettingsTab.ts:441-443`).
- If a persisted default model is absent from ready catalog chat models, settings adds a `<id> (unavailable)` option and shows a one-shot Notice (`src/settings/SettingsTab.ts:407-423`).
- `describeCatalogStatus()` returns copy for loading, ready, empty, and error catalog states (`src/settings/SettingsTab.ts:575-592`).

### UI and CSS File Map

- `ChatViewRegistration` registers the view, adds a ribbon icon, and adds command `copilot-agent-open-chat` (`src/ui/ChatViewRegistration.ts:30-50`).
- `activate(plugin)` reveals an existing chat leaf when present, otherwise gets a right leaf and sets its view state to the chat view type (`src/ui/ChatViewRegistration.ts:52-63`).
- `ChatView` declares `CHAT_VIEW_TYPE` as `copilot-agent-chat` (`src/ui/ChatView.ts:33`).
- `ChatView` receives `manager`, `auth`, `openSettings`, raw-FS exposure getter, and `modelCatalog` dependencies (`src/ui/ChatView.ts:45-78`).
- `bindActiveRuntime()` reads the active runtime from the manager and caches state/session/journal references (`src/ui/ChatView.ts:193-207`).
- `onOpen()` creates header, conversation picker, title row, status element, settings button, messages list, renderer, composer, textarea, model picker, send button, and connect button (`src/ui/ChatView.ts:221-449`).
- The renderer receives handlers for approval, approve-for-session, reject, undo, raw-FS undo suppression, and search-result open-link behavior (`src/ui/ChatView.ts:308-357`).
- `onClose()` unsubscribes state/auth/manager/model-catalog subscriptions, destroys pickers, and disposes the renderer (`src/ui/ChatView.ts:661-672`).
- `renderAuth()` updates connection status text/classes, connect button visibility, input disabled state, and send gate (`src/ui/ChatView.ts:674-714`).
- `submitMessage()` is a pure submit path, while `handleSendOrStop()` routes button clicks to Stop when streaming (`src/ui/ChatView.ts:718-736`).
- `handleSend()` captures active runtime state/session at send time so stream updates remain attached to the originating conversation (`src/ui/ChatView.ts:800-821`).
- `styles.css` styles the chat status and status-error color near the header styles (`styles.css:167-192`).
- `styles.css` styles pending approval tool-call status with warning colors (`styles.css:553-556`).
- `styles.css` styles MCP form inputs with Obsidian theme variables and form-field borders (`styles.css:621-632`).

### MCP Manager and Types File Map

- `McpTypes.ts` defines branded `McpServerId` and `McpTrustEpoch` string types (`src/mcp/McpTypes.ts:1-2`).
- `McpTypes.ts` defines `McpTransport` as `stdio` or `http` (`src/mcp/McpTypes.ts:4`).
- `McpTypes.ts` defines runtime statuses `disabled`, `disconnected`, `connecting`, `reconnecting`, `connected`, `error`, and `crashloop` (`src/mcp/McpTypes.ts:6-13`).
- `McpServerConfigBase` contains id, name, enabled, trustEpoch, optional callTimeoutMs, and future-key passthrough (`src/mcp/McpTypes.ts:15-22`).
- Stdio configs contain command, args, optional env, and optional cwd (`src/mcp/McpTypes.ts:24-30`).
- HTTP configs contain url and optional authorization (`src/mcp/McpTypes.ts:32-36`).
- Runtime snapshots contain id, status, optional lastError, toolCount, instructions, protocolVersion, and stderrTail (`src/mcp/McpTypes.ts:40-48`).
- MCP tool inventory entries contain server id/name, tool name, synthetic id, optional description, and optional input schema (`src/mcp/McpTypes.ts:59-66`).
- `McpManagerOptions` extends runtime options and adds servers provider, status persistence, notify, runtime factory, tracked-call settling, and built-in tool names (`src/mcp/McpManager.ts:17-24`).
- `McpManager` owns maps for runtimes, inventories, listeners, connect promises, generations, runtime identity keys, reconnect policies, and notification queue (`src/mcp/McpManager.ts:26-35`).
- `enable()` ignores disabled configs and crashloop runtimes, single-flights active connection promises, and delegates to `enableInternal()` (`src/mcp/McpManager.ts:39-48`).
- `enableInternal()` rebinds changed runtime identity, connects runtime, validates tools, rejects collisions, stores inventory, records success, persists snapshot, or records failure/notifies on error (`src/mcp/McpManager.ts:50-68`).
- `unload(serverId)` removes one runtime, clears inventory/policy/identity, settles calls, unloads runtime, and emits (`src/mcp/McpManager.ts:145-157`).
- Full `unload()` marks unloading, bumps generations, cancels queues/policies, clears maps, unloads runtimes in parallel under a 20-second cap, clears policies, and emits (`src/mcp/McpManager.ts:159-176`).
- `enableAllConfigured()` filters enabled servers and awaits `Promise.allSettled` over `enable()` calls (`src/mcp/McpManager.ts:178-181`).
- `reconcileConfiguredServers()` unloads removed runtimes and disables configured disabled servers (`src/mcp/McpManager.ts:183-194`).
- `callTool()` checks config, lazily enables HTTP servers without inventory, verifies runtime availability, tracks generation, wraps runtime tool call in timeout, detects cancellation by generation/enabled state, records failures, clears HTTP volatile session, settles calls, and redacts thrown error text (`src/mcp/McpManager.ts:218-260`).
- `rejectBuiltinCollisions()` filters MCP tools whose synthetic id collides with built-in tool names, marks inventory rejected, and notifies with redacted message (`src/mcp/McpManager.ts:361-370`).
- `runtimeIdentityKey()` serializes name/transport/command/args for stdio and name/transport/url for HTTP (`src/mcp/McpManager.ts:440-455`).

### Package, Lockfile, and Installed Dependency Map

- `package.json` root package name is `obsidian-copilot-agent` (`package.json:1-3`).
- `package.json` description is `Obsidian desktop plugin embedding a GitHub Copilot SDK-powered AI agent.` (`package.json:3-4`).
- `package.json` dependency `@github/copilot-sdk` is exact `1.0.0` (`package.json:19-21`).
- `package.json` dependency `@modelcontextprotocol/sdk` is exact `1.29.0` (`package.json:20-22`).
- Dev dependencies include `@types/node`, `esbuild`, `obsidian`, `typescript`, and `vitest` (`package.json:23-29`).
- `package-lock.json` top package entry repeats dependency on `@github/copilot-sdk` (`package-lock.json:11`).
- `package-lock.json` records `@github/copilot` license as `SEE LICENSE IN LICENSE.md` (`package-lock.json:687-691`).
- `package-lock.json` records `@github/copilot-sdk` license as MIT (`package-lock.json:805-809`).
- Installed `node_modules/@github/copilot/package.json` reports `name: @github/copilot`, `version: 1.0.59`, bin `copilot: npm-loader.js`, and optional dependency entries for all platform packages, from package metadata inspection.
- Installed `node_modules/@github/copilot-win32-x64/package.json` reports `name: @github/copilot-win32-x64`, `version: 1.0.59`, `os: win32`, `cpu: x64`, and bin `copilot-win32-x64: copilot.exe`, from package metadata inspection.

### Release-Adjacent Absence Detail

- Root inspection found `.github` but no `.github\workflows` directory.
- Root inspection found `scripts\deploy.mjs` and no additional scripts under `scripts`.
- Root inspection found `CHANGELOG.md`, `README.md`, `manifest.json`, `package.json`, `package-lock.json`, `styles.css`, `main.js`, and no `versions.json`.
- Root inspection found `.deploy-target`; `.gitignore` marks it as a local deploy target and excludes it from commits (`.gitignore:35-36`).
- The workflow-specific directory `.paw\work\packaging-release` contained `Spec.md` and `WorkflowContext.md` before this research artifact was written, from filesystem inspection.
- No in-repo file naming a release agent was found in root, `scripts`, `.github`, or `.paw\work\packaging-release` inspection.

### Test Suite File Organization Snapshot

- Auth tests include `AuthController.test.ts`, `DeviceFlow.test.ts`, `isAuthError.test.ts`, and `TokenStore.test.ts`, from filesystem inspection.
- Domain tests include chat state, conversation manager/runtime, preamble, safety policy, tool gating-adjacent undo journal tests, and date formatting, from filesystem inspection.
- MCP tests include manager, runtime, transport, reconnect policy, notification queue, result normalization, redaction, identity, registry, bridge, HTTP policy, and stdio env, from filesystem inspection.
- Persistence tests include `ConversationsStore.test.ts` and `migrate.test.ts`, from filesystem inspection.
- Settings tests include MCP form logic, MCP servers section, MCP settings store, and safety settings store, from filesystem inspection.
- Tools tests include daily-note path, task finding/formatting/updating, Obsidian API, read/write note tools, read/search/write tools, and vault path, from filesystem inspection.
- UI tests include chat keydown, chat model pick, conversation picker logic, model picker logic, search result renderer, tool-call block, and undo flow, from filesystem inspection.
- `npm test -- --reporter=dot` output reported individual suite counts such as `AgentSession.test.ts` 66 tests, `ConversationManager.test.ts` 62 tests, `ObsidianApi.test.ts` 53 tests, and `TaskFormat.test.ts` 53 tests.

### Prior Documentation and Release Text Context

- README v0.5 status line currently names MCP, model-picker recovery flows, Windows desktop, and not packaged status (`README.md:5`).
- README local setup uses a numbered list and nested bullets for binary paths and deploy tip (`README.md:105-123`).
- README safety model describes mutating tool calls flowing through one deny-by-default permission gate (`README.md:128-142`).
- README token persistence section documents plaintext token storage in vault plugin data (`README.md:148-150`).
- README OAuth section says v0.1 reused the GitHub CLI public client id and before non-private distribution a dedicated OAuth app is tracked as deferred (`README.md:152-159`).
- README reference section names `logancyang/obsidian-copilot` as a structural reference and states no code is copied (`README.md:175-177`).
- CHANGELOG v0.4 recovery entry explicitly describes inline `Retry` for model list failures and no plugin reload requirement (`CHANGELOG.md:48-50`).
- CHANGELOG v0.5 dependency entry notes `@modelcontextprotocol/sdk@1.29.0` is exact-pinned and future bumps require transport-security re-review (`CHANGELOG.md:29-31`).
- Proposal `0002` references Obsidian sample plugin, BRAT, and Community Plugins submission process as release-planning references (`proposals/0002-packaging-release.md:80-87`).

### Observed Current Branch and Commit

- Git commit recorded for this research is `4b5e07ebd87b96cc7fa10bf2f47c3a42c7beb55b`, obtained via `git rev-parse HEAD`.
- Current branch recorded for this research is `feature/packaging-release`, obtained via `git branch --show-current`.
- Remote URL recorded during research is `https://github.com/ChrisKrawczyk/obsidian-copilot-agent.git`, obtained via `git remote get-url origin`.

## Supplemental Evidence Grid

### Startup and Binary Evidence Grid

- Evidence S01: binary lookup happens before token store construction (`src/main.ts:105-123`).
- Evidence S02: binary lookup happens before safety store construction (`src/main.ts:105-129`).
- Evidence S03: binary lookup happens before MCP settings store construction (`src/main.ts:105-135`).
- Evidence S04: binary lookup happens before conversations store construction (`src/main.ts:105-159`).
- Evidence S05: binary lookup happens before MCP manager construction (`src/main.ts:105-205`).
- Evidence S06: binary lookup happens before auth controller construction (`src/main.ts:105-670`).
- Evidence S07: binary lookup happens before settings tab construction (`src/main.ts:105-757`).
- Evidence S08: binary lookup happens before chat view registration (`src/main.ts:105-789`).
- Evidence S09: missing binary Notice is the only user-facing Obsidian UI created in the catch block (`src/main.ts:110-119`).
- Evidence S10: missing binary catch returns rather than rethrowing (`src/main.ts:110-119`).
- Evidence S11: plugin directory resolution depends on `plugin.manifest.dir` being present (`src/sdk/resolveCliBinaryPath.ts:49-60`).
- Evidence S12: non-filesystem adapters return null plugin dir because of the `FileSystemAdapter` instance check (`src/sdk/resolveCliBinaryPath.ts:50-52`).
- Evidence S13: the missing-binary error message names `Phase 2 install steps` (`src/sdk/resolveCliBinaryPath.ts:39-46`).
- Evidence S14: README binary install path names Windows x64 package path directly (`README.md:112-115`).
- Evidence S15: deploy script Windows binary copy path matches README Windows x64 path (`scripts/deploy.mjs:63-66`, `README.md:112-115`).

### Release and Packaging Evidence Grid

- Evidence R01: root `main.js` is treated as build output by `.gitignore` (`.gitignore:4-8`).
- Evidence R02: `main.js` is nevertheless the `package.json` main entry field (`package.json:5-7`).
- Evidence R03: `main.js` is also the esbuild outfile (`esbuild.config.mjs:7-10`).
- Evidence R04: deploy copies `main.js`, `manifest.json`, and `styles.css` by basename to target (`scripts/deploy.mjs:62-88`).
- Evidence R05: deploy skips missing sources instead of exiting nonzero for each missing file (`scripts/deploy.mjs:77-83`).
- Evidence R06: deploy exits code 2 for missing target config (`scripts/deploy.mjs:45-53`).
- Evidence R07: deploy exits code 2 for invalid target directory (`scripts/deploy.mjs:55-58`).
- Evidence R08: deploy logs copied file sizes using `toLocaleString()` (`scripts/deploy.mjs:84-89`).
- Evidence R09: package scripts do not include `npm ci`; CI usage is not represented in package scripts (`package.json:8-15`).
- Evidence R10: package scripts do not include a changelog-generation command (`package.json:8-15`).
- Evidence R11: package scripts do not include a tag-creation command (`package.json:8-15`).
- Evidence R12: proposal Phase A mentions tags and changelog generation, while current package scripts do not contain release commands (`proposals/0002-packaging-release.md:25-39`, `package.json:8-15`).
- Evidence R13: workflow Phase A differs from proposal by excluding bundled `copilot.exe` release assets in this iteration (`.paw/work/packaging-release/WorkflowContext.md:40-44`, `proposals/0002-packaging-release.md:34-36`).
- Evidence R14: manifest `isDesktopOnly: true` aligns with README's separate CLI binary rationale (`manifest.json:8`, `README.md:161-163`).
- Evidence R15: `package-lock.json` records platform optional packages, while repo runtime lookup expects copied binary in plugin dir (`package-lock.json:698-707`, `src/sdk/resolveCliBinaryPath.ts:14-16`).

### Settings and Notice Evidence Grid

- Evidence U01: settings connection state uses inline paragraph text rather than Notice for normal auth state (`src/settings/SettingsTab.ts:58-67`, `src/settings/SettingsTab.ts:456-520`).
- Evidence U02: settings auth error state changes the connection button text from Connect to Reconnect (`src/settings/SettingsTab.ts:466-474`).
- Evidence U03: settings connection button description changes per auth state through `buttonDesc()` (`src/settings/SettingsTab.ts:523-534`).
- Evidence U04: model catalog stale default uses Notice once per settings-tab lifetime via `unavailableNoticeShown` (`src/settings/SettingsTab.ts:33-33`, `src/settings/SettingsTab.ts:416-422`).
- Evidence U05: MCP operation failures are Notice-based but go through the MCP section notify abstraction (`src/settings/McpServersSection.ts:304-311`).
- Evidence U06: MCP persistent row errors are inline settings content, not Notice-only content (`src/settings/McpServersSection.ts:109-123`).
- Evidence U07: MCP form validation uses an inline `role="alert"` message element (`src/settings/McpServersSection.ts:217-247`).
- Evidence U08: chat catalog recovery uses inline banner plus Retry button, not a Notice-only recovery path (`src/ui/ChatView.ts:359-380`, `src/ui/ChatView.ts:531-560`).
- Evidence U09: chat send attempts blocked by send gate still surface a Notice (`src/ui/ChatView.ts:767-784`).
- Evidence U10: status text uses CSS class `copilot-agent-status-error` for auth errors (`src/ui/ChatView.ts:688-711`, `styles.css:190-192`).
- Evidence U11: MCP last-error and stderr CSS is designed for selectable, wrapped, scrollable diagnostics (`styles.css:654-675`).
- Evidence U12: MCP settings row redacts last-error before setting text content (`src/settings/McpServersSection.ts:109-116`).
- Evidence U13: MCP settings row redacts stderr tail before setting text content (`src/settings/McpServersSection.ts:117-123`).
- Evidence U14: MCP tests assert error blocks do not populate `innerHTML` (`src/settings/McpServersSection.test.ts:154-178`).
- Evidence U15: redaction covers bearer token strings and Authorization key/value syntax (`src/mcp/redactSensitive.ts:12-20`).

### Test and Build Evidence Grid

- Evidence T01: Vitest test environment is explicitly node (`vitest.config.ts:12-14`).
- Evidence T02: Vitest includes only `src/**/*.test.ts` (`vitest.config.ts:12-15`).
- Evidence T03: Vitest aliases Obsidian to a local mock file (`vitest.config.ts:4-10`).
- Evidence T04: the Obsidian mock has a minimal `Notice` constructor storing message/timeout (`src/test/obsidianMock.ts:84-89`).
- Evidence T05: TypeScript includes DOM lib even though Vitest runs node (`tsconfig.json:2-7`, `vitest.config.ts:12-14`).
- Evidence T06: TypeScript excludes `src/**/*.test.ts` from `tsc --noEmit` (`tsconfig.json:20-22`).
- Evidence T07: esbuild marks `obsidian` external (`esbuild.config.mjs:17-18`).
- Evidence T08: esbuild marks `electron` external (`esbuild.config.mjs:17-19`).
- Evidence T09: esbuild marks Node builtins and `node:` builtin specifiers external (`esbuild.config.mjs:17-22`).
- Evidence T10: production build disables sourcemaps and enables minification (`esbuild.config.mjs:13-15`).
- Evidence T11: dev build enters watch mode (`esbuild.config.mjs:25-30`).
- Evidence T12: `npm test -- --reporter=dot` verified 968 passing tests during this research run.
- Evidence T13: `README.md` still documents 944 v0.5 tests, while verified test output is 968 (`README.md:173`).
- Evidence T14: `CHANGELOG.md` still documents final v0.5 test count 944 (`CHANGELOG.md:37-40`).
- Evidence T15: `.github/copilot-instructions.md` documents run order `npm test`, build/deploy, and Obsidian reload for plugin-code changes (`.github/copilot-instructions.md:47-51`).

### PAW and Documentation Evidence Grid

- Evidence P01: `.github/copilot-instructions.md` names `.paw/work/<work-id>/` as workflow artifact location (`.github/copilot-instructions.md:53-57`).
- Evidence P02: `.github/copilot-instructions.md` names `WorkflowContext.md` as active workflow context (`.github/copilot-instructions.md:59-62`).
- Evidence P03: `mcp-client` context uses `Workflow Mode: full` like `packaging-release` (`.paw/work/mcp-client/WorkflowContext.md:10`, `.paw/work/packaging-release/WorkflowContext.md:10`).
- Evidence P04: `mcp-client` context includes planning/review model configuration fields also present in `packaging-release` (`.paw/work/mcp-client/WorkflowContext.md:15-35`, `.paw/work/packaging-release/WorkflowContext.md:15-35`).
- Evidence P05: `mcp-client` context includes an explicit out-of-scope section (`.paw/work/mcp-client/WorkflowContext.md:59-68`).
- Evidence P06: `packaging-release` context includes an explicit out-of-scope section (`.paw/work/packaging-release/WorkflowContext.md:63-69`).
- Evidence P07: `mcp-client` docs include an `Overview` heading and project-version title (`.paw/work/mcp-client/Docs.md:1-5`).
- Evidence P08: `mcp-client` docs include code fences for exact protocol/key examples (`.paw/work/mcp-client/Docs.md:57-61`, `.paw/work/mcp-client/Docs.md:72-76`).
- Evidence P09: README links to PAW docs with a relative path (`README.md:52`).
- Evidence P10: proposal file status is Draft (`proposals/0002-packaging-release.md:1-4`).
- Evidence P11: proposal references BRAT add-beta-plugin flow (`proposals/0002-packaging-release.md:40-45`).
- Evidence P12: proposal references Community Plugins submission as optional/later (`proposals/0002-packaging-release.md:47-54`).
- Evidence P13: proposal risks mention binary size and community plugin gatekeeping (`proposals/0002-packaging-release.md:56-64`).
- Evidence P14: proposal risks mention token re-auth on update and vault-state migrations (`proposals/0002-packaging-release.md:64-68`).
- Evidence P15: proposal references README status and separate CLI binary rationale (`proposals/0002-packaging-release.md:21-22`, `proposals/0002-packaging-release.md:80-83`).
