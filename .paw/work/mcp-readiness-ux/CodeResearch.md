---
date: 2026-07-02T08:40:58-07:00
git_commit: 4581224656f097ee7cda0df65a3d64173e6086da
branch: feature/mcp-readiness-ux
repository: obsidian-copilot-agent
topic: "MCP readiness UX code research"
tags: [research, codebase, mcp, readiness, chat-view, sdk]
status: complete
last_updated: 2026-07-02
---

# Research: MCP readiness UX

## Research Question

Document the current implementation touch points for MCP readiness gating, composer disabled state, live tool-list SDK surface, cross-conversation runtime plumbing, Notice/debounce infrastructure, tests, docs, and related proposals for work `mcp-readiness-ux` (`.paw/work/mcp-readiness-ux/Spec.md:1-218`).

## Summary

The current readiness gate is `McpManager.waitUntilEnabledReady(timeoutMs: number): Promise<void>` and it waits until each enabled server has a runtime status in `connected`, `error`, `crashloop`, or `disabled`, or until its timeout resolves (`src/mcp/McpManager.ts:268-313`). `main.ts` wires the gate into each `CopilotAgentSession` as `mcpReadinessGate: () => mcpManager.waitUntilEnabledReady(15_000)` (`src/main.ts:625-635`). `AgentSession` awaits the gate immediately before all three `client.createSession()` paths (`src/sdk/AgentSession.ts:1196-1204`, `src/sdk/AgentSession.ts:1381-1389`, `src/sdk/AgentSession.ts:1453-1461`). Production initialization is lazy from `sendMessage` / `sendMessageStreaming`, plus auth reconnect warms live runtimes through `AuthController` and `tokenSink` (`src/sdk/AgentSession.ts:583-609`, `src/sdk/AgentSession.ts:611-613`, `src/sdk/AgentSession.ts:690-692`, `src/auth/AuthController.ts:105-115`, `src/main.ts:804-825`).

The installed SDK is external npm package `@github/copilot-sdk` version `1.0.0` (`package.json:33-35`, `node_modules/@github/copilot-sdk/package.json:1-11`). Its public `CopilotSession` type includes `send`, `sendAndWait`, `on`, `getEvents`, `disconnect`, `abort`, `setModel`, and `log`; no public `updateTools`, `setTools`, or `refreshTools` method was found in the installed package (`node_modules/@github/copilot-sdk/dist/session.d.ts:33-290`).

## Documentation System

- **Framework**: Plain markdown. No mkdocs/docusaurus/sphinx navigation config found in repo root listing; user-facing docs are `.md` files under `README.md`, `CHANGELOG.md`, `docs/`, `proposals/`, and PAW artifacts (`README.md:1-13`, `CHANGELOG.md:1-8`, `docs/preset-packs.md:1-14`, `proposals/README.md:1-16`).
- **Docs Directory**: `docs/` contains user guides and schema assets: `docs/m365-graph-mcp.md`, `docs/preset-packs.md`, and `docs/schemas/preset-pack-v1.json` (directory listing from repo inspection; `README.md:13`, `README.md:18`, `README.md:24`).
- **Navigation Config**: N/A; no navigation config found in repo root listing.
- **Style Conventions**: README uses release-oriented sections (`## What's new in v0.8`, `## MCP server setup`, `## Local development setup`, `## Tests`) with bullets, numbered setup steps, and fenced examples (`README.md:7-13`, `README.md:36-74`, `README.md:168-190`, `README.md:230-236`). User guides use H1 title, short intro, `##` sections, numbered quick starts, tables, and fenced JSON examples (`docs/m365-graph-mcp.md:1-20`, `docs/m365-graph-mcp.md:21-40`, `docs/preset-packs.md:16-36`, `docs/preset-packs.md:51-80`).
- **Build Command**: N/A for docs. `npm run schema:check` checks the preset-pack schema (`package.json:12-14`, `README.md:13`).
- **Standard Files**: `README.md` (`README.md:1-3`), `CHANGELOG.md` (`CHANGELOG.md:1-8`), `RELEASING.md` is linked from README (`README.md:240-242`), `proposals/README.md` defines proposal conventions (`proposals/README.md:5-16`).

## Verification Commands

- **Test Command**: `npm test` runs `vitest run` (`package.json:12`, `README.md:230-236`).
- **Lint Command**: N/A; no `lint` script is declared in the app package (`package.json:8-28`).
- **Build Command**: `npm run build` runs `node esbuild.config.mjs production` (`package.json:9`, `README.md:170-172`).
- **Type Check**: `npm run typecheck` runs `tsc --noEmit` (`package.json:11`, `README.md:230-236`).
- **Schema Check**: `npm run schema:check` runs `node scripts/check-pack-schema.mjs` (`package.json:13`, `CHANGELOG.md:20`).

## Detailed Findings

### 1. Readiness gate and composer disabled state

#### `McpManager`

- `McpRuntimeStatus` is a union of `disabled`, `disconnected`, `connecting`, `reconnecting`, `connected`, `error`, and `crashloop` (`src/mcp/McpTypes.ts:17-24`).
- `statusSnapshot(): readonly McpServerRuntimeSnapshot[]` returns frozen snapshots from the current `runtimes` map, overriding runtime status to `reconnecting` or `crashloop` when a reconnect policy reports those statuses (`src/mcp/McpManager.ts:219-230`).
- `inventorySnapshot(): readonly McpToolInventoryEntry[]` flattens frozen inventory tool entries from `this.inventories` (`src/mcp/McpManager.ts:233-238`).
- `waitUntilEnabledReady(timeoutMs: number): Promise<void>` is the current readiness-gate signature (`src/mcp/McpManager.ts:268`).
- Inside `waitUntilEnabledReady`, terminal statuses are classified by local `isTerminal(status: McpRuntimeStatus): boolean`; terminal values are `connected`, `error`, `crashloop`, and `disabled` (`src/mcp/McpManager.ts:269-273`). Non-terminal values in the declared union are `disconnected`, `connecting`, and `reconnecting` by exclusion from this local classifier (`src/mcp/McpTypes.ts:17-24`, `src/mcp/McpManager.ts:269-273`).
- Enabled server ids are read from `options.serversProvider().filter((c) => c.enabled).map((c) => c.id)` (`src/mcp/McpManager.ts:274-280`).
- `allReady()` returns true when there are no enabled ids, false when an enabled id has no runtime snapshot, false when a snapshot status is not terminal, and true when all enabled ids have terminal statuses (`src/mcp/McpManager.ts:281-293`).
- If not immediately ready, the gate subscribes to manager changes and also sets a timeout with `setTimeout(finish, Math.max(0, timeoutMs))`; `finish()` unsubscribes, clears the timer, and resolves (`src/mcp/McpManager.ts:294-312`).
- `subscribe(fn: () => void): () => void` adds a listener to `this.listeners` and returns an unsubscribe function that deletes it (`src/mcp/McpManager.ts:465-468`).
- `emit()` invokes all runtime snapshot listeners and catches listener errors (`src/mcp/McpManager.ts:743-749`). `persist()` emits after optional status persistence (`src/mcp/McpManager.ts:675-680`), and reconnect-policy status transitions persist snapshots (`src/mcp/McpManager.ts:708-724`).
- `getOrCreate(config: McpServerConfig): McpServerRuntime` is private; it returns an existing runtime if present, otherwise creates one through `options.runtimeFactory` or `new McpServerRuntime`, sets `onListChanged`, HTTP `getAuthorization`, records the runtime and identity key, and returns it (`src/mcp/McpManager.ts:470-488`).

#### `AgentSession`

- `AgentSessionOptions.mcpReadinessGate?: () => Promise<void>` is an optional callback awaited before SDK session creation; its docstring states it is awaited inside `init()` before `client.createSession()` and should own its timeout (`src/sdk/AgentSession.ts:131-151`).
- `toolsForSession(): SdkTool[] | undefined` combines `opts.tools` and the current `opts.mcpTools?.()` array snapshot, returning undefined when combined tools are empty (`src/sdk/AgentSession.ts:1129-1140`).
- `awaitMcpReadinessGate(): Promise<void>` is private; it reads `this.opts.mcpReadinessGate`, returns immediately when absent, awaits it when present, and catches/logs thrown errors (`src/sdk/AgentSession.ts:1151-1159`).
- `resetConversation()` disconnects the old SDK session, resolves a model if needed, awaits the readiness gate, and creates a fresh SDK session with `availableTools: ["builtin:*", "custom:*", "mcp:*"]`, `streaming: true`, `tools: this.toolsForSession()`, and `onPermissionRequest` (`src/sdk/AgentSession.ts:1179-1207`).
- `doInit()` constructs `new CopilotClient(...)`, starts/pings it if supported, assigns `this.client`, picks a model, awaits the readiness gate, and calls `client.createSession(...)` with the same tool and permission fields (`src/sdk/AgentSession.ts:1308-1327`, `src/sdk/AgentSession.ts:1343-1353`, `src/sdk/AgentSession.ts:1355-1389`).
- `tryRecoverDeferred()` handles deferred catalog recovery; once a model is available, it awaits the readiness gate and calls `client.createSession(...)` with the same tool and permission fields (`src/sdk/AgentSession.ts:1416-1433`, `src/sdk/AgentSession.ts:1450-1461`).
- `init(): Promise<void>` is idempotent over `this.initPromise`, rejects when disposed or missing token, and calls `this.doInit()` when no init is in flight (`src/sdk/AgentSession.ts:583-609`).
- `sendMessage()` production path calls `await this.init()` before sending (`src/sdk/AgentSession.ts:611-613`). `sendMessageStreaming()` production path calls `await this.init()` before streaming (`src/sdk/AgentSession.ts:690-692`).
- Auth validation invokes `agentTokenSink.reconnect()` from persisted-token hydrate and from device-flow completion (`src/auth/AuthController.ts:105-115`, `src/auth/AuthController.ts:260-269`). In `CopilotAgentPlugin`, `tokenSink.reconnect()` broadcasts `session.reconnect()` to every live runtime session (`src/main.ts:804-825`), and `AgentSession.reconnect()` calls `stopRuntime()` then `init()` (`src/sdk/AgentSession.ts:1295-1303`).
- On plugin startup, after `ConversationManager.hydrate()`, `main.ts` materializes the active runtime before auth hydrate so the token sink has a live session to reconnect (`src/main.ts:865-885`).

#### `ChatView`

- `ChatViewDeps.manager` is documented as the source of the active runtime; the view reads it through `manager.getActiveRuntime()` and re-binds on active changes (`src/ui/ChatView.ts:45-52`).
- `pending` and `streaming` are private fields on the `ChatView` instance (`src/ui/ChatView.ts:104-112`). Current-stream state/session fields capture the originating runtime so stream handling still targets the initiating conversation after a mid-stream active switch (`src/ui/ChatView.ts:126-145`, `src/ui/ChatView.ts:811-833`).
- Constructor calls `bindActiveRuntime()` once (`src/ui/ChatView.ts:183-191`). `bindActiveRuntime()` reads `manager.getActiveId()`, returns if absent or already bound, then reads `manager.getActiveRuntime()` and rebinds `state`, `agent`, `undoJournal`, and `boundConversationId` (`src/ui/ChatView.ts:198-207`).
- In `onOpen()`, the view subscribes to `ChatState`, `AuthController`, `ConversationManager`, and `ModelCatalog` (`src/ui/ChatView.ts:450-512`). The manager subscription handles `active-changed` and `list-changed` by calling `bindActiveRuntime()`, replacing the state subscription when `boundConversationId` changes, syncing the list, and focusing the input if it is not disabled (`src/ui/ChatView.ts:459-480`).
- The manager subscription does not assign `pending` or `streaming`; it rebinds runtime references and subscriptions (`src/ui/ChatView.ts:459-480`). `pending` is assigned in `setBusy()` (`src/ui/ChatView.ts:1082-1084`), and `streaming` is assigned in `setStreaming()` (`src/ui/ChatView.ts:1095-1097`).
- `renderAuth(state: AuthState)` sets `currentAuthKind`, computes `isConnected = state.kind === "connected"`, and, when not pending or streaming, sets `inputEl.disabled = !isConnected` (`src/ui/ChatView.ts:685-692`). It also toggles the connect CTA and updates the status pill text for auth states (`src/ui/ChatView.ts:696-724`).
- `refreshSendGate()` computes `canSend({ isConnected, isStreaming, isPending, catalogState, activeModelId })`, renders inline model/catalog errors, and sets `sendBtnEl.disabled = !result.ok` only when not pending and not streaming (`src/ui/ChatView.ts:542-580`).
- `handleSend()` also computes `canSend()` before touching state and shows `new Notice(gate.reason, 5000)` if blocked (`src/ui/ChatView.ts:778-795`).
- After accepting a non-empty input, `handleSend()` clears `inputEl.value`, resets `userRequestedStop`, calls `setBusy(true)`, captures the active runtime state/session, appends user and assistant placeholder messages, and then calls `setStreaming(true)` before iterating `session.sendMessageStreaming(text)` (`src/ui/ChatView.ts:805-810`, `src/ui/ChatView.ts:811-833`, `src/ui/ChatView.ts:891-898`).
- `setBusy(busy: boolean)` sets `this.pending = busy`; computes `gated = this.currentAuthKind !== "connected"`; sets `inputEl.disabled = busy || gated`; when clearing busy, it calls `refreshSendGate()` and removes the send-button loading class (`src/ui/ChatView.ts:1082-1093`).
- `setStreaming(streaming: boolean)` sets `this.streaming = streaming`; when streaming, it repurposes the send button into Stop; when not streaming, it restores Send visuals and calls `refreshSendGate()` (`src/ui/ChatView.ts:1095-1112`).
- Error paths surface `new Notice(`Copilot Agent error: ${msg}`, 8000)` after updating the assistant placeholder to error (`src/ui/ChatView.ts:1006-1013`).

### 2. SDK surface for live tool-list updates

- The application declares `@github/copilot-sdk` version `1.0.0` in dependencies (`package.json:33-35`). The installed package also reports name `@github/copilot-sdk`, repository `https://github.com/github/copilot-sdk.git`, version `1.0.0`, main `./dist/cjs/index.js`, and types `./dist/index.d.ts` (`node_modules/@github/copilot-sdk/package.json:1-11`).
- The installed SDK is an external npm package under `node_modules/@github/copilot-sdk/`; package metadata links to `https://github.com/github/copilot-sdk.git` (`node_modules/@github/copilot-sdk/package.json:1-7`).
- `CopilotClient.createSession(config: SessionConfig): Promise<CopilotSession>` is the type signature in `dist/client.d.ts` (`node_modules/@github/copilot-sdk/dist/client.d.ts:213`). `resumeSession(sessionId: string, config: ResumeSessionConfig): Promise<CopilotSession>` can be called with new tools according to its comment example (`node_modules/@github/copilot-sdk/dist/client.d.ts:214-238`).
- README documents `createSession(config?: SessionConfig): Promise<CopilotSession>` and lists `tools?: Tool[]` as custom tools exposed to the CLI (`node_modules/@github/copilot-sdk/README.md:112-129`).
- `SessionConfigBase.tools?: Tool<any>[]` exposes session tools, and `availableTools?: string[] | ToolSet` / `excludedTools?: string[] | ToolSet` filter tool availability (`node_modules/@github/copilot-sdk/dist/types.d.ts:1300-1305`, `node_modules/@github/copilot-sdk/dist/types.d.ts:1357-1377`).
- `Tool<TArgs>` includes `name`, optional `description`, optional `parameters`, optional `handler`, optional `overridesBuiltInTool`, and optional `skipPermission` (`node_modules/@github/copilot-sdk/dist/types.d.ts:349-373`).
- `defineTool<T>(name, config): Tool<T>` returns a tool with optional description, parameters, handler, overrides flag, and skip-permission flag (`node_modules/@github/copilot-sdk/dist/types.d.ts:375-384`). README shows `defineTool("lookup_issue", { description, parameters, handler })` passed inside `createSession({ tools: [...] })` (`node_modules/@github/copilot-sdk/README.md:428-453`).
- `ToolInvocation` passed to handlers includes `sessionId`, `toolCallId`, `toolName`, `arguments`, and trace context fields (`node_modules/@github/copilot-sdk/dist/types.d.ts:329-339`).
- Public `CopilotSession` methods in the installed type surface are `send`, `sendAndWait`, overloaded `on`, `getEvents`, `disconnect`, `[Symbol.asyncDispose]`, `abort`, `setModel`, and `log` (`node_modules/@github/copilot-sdk/dist/session.d.ts:33-290`). No public `updateTools`, `setTools`, or `refreshTools` method was found in `dist/session.d.ts` or package-wide search results.
- Generated RPC contains `session.options.update` with fields including `workingDirectory`, `availableTools`, `excludedTools`, and `toolFilterPrecedence` (`node_modules/@github/copilot-sdk/dist/generated/rpc.d.ts:8088-8124`), but no public SDK session wrapper for live custom `tools?: Tool[]` replacement was found in the installed type surface (`node_modules/@github/copilot-sdk/dist/session.d.ts:33-290`).
- The plugin's local `SdkTool` structural type mirrors the SDK tool fields `name`, `description`, `parameters`, `handler`, `overridesBuiltInTool`, and `skipPermission` without importing the SDK type (`src/sdk/AgentSession.ts:164-176`).
- The plugin's SDK client/session structural types include `createSession: (opts: SdkSessionOptions) => Promise<SdkSession>` (`src/sdk/AgentSession.ts:2267` from search result) and current create-session call sites pass `tools: this.toolsForSession()` (`src/sdk/AgentSession.ts:1197-1204`, `src/sdk/AgentSession.ts:1382-1389`, `src/sdk/AgentSession.ts:1454-1461`).

### 3. Cross-conversation refresh plumbing

- `ConversationRuntime` is per conversation and owns its own `AgentSession`, `UndoJournal`, `ChatState`, and per-runtime tool factories (`src/domain/ConversationRuntime.ts:1-11`, `src/domain/ConversationRuntime.ts:35-58`). Its factory type creates a runtime from conversation metadata, optional hydration, and optional persist adapter (`src/domain/ConversationRuntime.ts:60-80`).
- `ConversationManager` stores metadata in `private readonly conversations = new Map<string, Conversation>()` and runtimes in `private readonly runtimes = new Map<string, ConversationRuntime>()`; it also stores listeners and the active id (`src/domain/ConversationManager.ts:156-170`).
- `hydrate()` clears conversations and runtimes, seeds metadata from persisted conversations, resolves/creates an active id, persists the active id, runs lazy model resolution, emits `list-changed`, and does not instantiate runtimes during hydration (`src/domain/ConversationManager.ts:182-267`).
- `create(name?: string): Conversation` calls `createInternal(name)`, enforces the soft cap, emits `list-changed`, and returns cloned metadata (`src/domain/ConversationManager.ts:371-385`). `createInternal()` creates metadata, optionally resolves model id, upserts persistence with empty messages/undo entries, stores the metadata, and returns it; it does not call `runtimeFactory` (`src/domain/ConversationManager.ts:670-748`).
- `ConversationPicker`'s New conversation menu item calls `callbacks.onCreate()` and then `callbacks.onSelect(newId)` (`src/ui/ConversationPicker.ts:98-104`). `ChatView` wires `onCreate` to `this.manager.create()` and `onSelect` to `this.manager.setActive(id)` (`src/ui/ChatView.ts:230-251`).
- `setActive(id)` updates `activeId`, persists it, runs lazy model resolution, touches the conversation, and emits `active-changed`; it does not instantiate the runtime directly (`src/domain/ConversationManager.ts:305-325`).
- `getActiveRuntime()` instantiates the active runtime on first access by calling `getOrCreateRuntime(this.activeId)` (`src/domain/ConversationManager.ts:288-297`). `getOrCreateRuntime(id)` returns an existing runtime or calls `runtimeFactory(...)`, stores it in the runtime map, and returns it (`src/domain/ConversationManager.ts:574-590`).
- `removeConversation(id)` deletes and disposes an instantiated runtime if present, deletes metadata, updates active id if needed, and emits `active-changed` / `list-changed` events (`src/domain/ConversationManager.ts:469-496`).
- `disposeAll()` captures all instantiated runtimes, clears the runtime map, and disposes them with `Promise.allSettled` (`src/domain/ConversationManager.ts:561-570`).
- `subscribe(listener: ConversationListener): () => void` adds a conversation listener and returns an unsubscribe function (`src/domain/ConversationManager.ts:554-559`). Event kinds are `list-changed`, `active-changed`, `metadata-changed`, and `auto-archived` (`src/domain/ConversationManager.ts:141-154`).
- `main.ts` maintains `liveRuntimes = new Set<{ session: AgentSession; conversationId: string }>()` in plugin scope (`src/main.ts:329-332`). The runtime factory adds each materialized runtime's session/id to this set and removes it in the runtime's `dispose()` method (`src/main.ts:695-724`).
- Existing broadcast pattern: `settleTrackedCalls` in the MCP manager options runs `Promise.all(Array.from(liveRuntimes).map(async ({ session }) => { session.cancelPendingMcpApprovalsForServer(...); session.cancelMcpCallsForServer(...); }))` for a server (`src/main.ts:337-348`). Token broadcast uses `for (const entry of liveRuntimes) await entry.session.setToken(token)` (`src/main.ts:784-803`). Reconnect broadcast uses `Array.from(liveRuntimes)` and maps each entry to `e.session.reconnect()` (`src/main.ts:804-825`).
- `ChatView` references the current active runtime through cached fields (`state`, `agent`, `undoJournal`, `boundConversationId`) populated by `bindActiveRuntime()` from `manager.getActiveRuntime()` (`src/ui/ChatView.ts:80-92`, `src/ui/ChatView.ts:198-207`). The manager subscription rebinds those fields on `active-changed` and `list-changed` (`src/ui/ChatView.ts:459-480`).

### 4. Toast / notice infrastructure

- The plugin imports `Notice` from Obsidian in `ChatView.ts` (`src/ui/ChatView.ts:1-6`).
- `main.ts` creates an unsupported-platform Notice with message `[Copilot Agent] Unsupported platform. Open Settings → Copilot Agent for details.` and duration `12000` (`src/main.ts:147-153`).
- `main.ts` creates a persistent progress Notice for binary download with duration `0`, updates it through `setMessage`, and hides it on success/failure (`src/main.ts:157-203`).
- `main.ts` wires MCP notifications to `new Notice(message, 8000)` in the `McpManager` options and also in MCP tool registry snapshot notifications (`src/main.ts:337-341`, `src/main.ts:589-595`).
- `ChatView` shows an auto-archived conversation Notice with duration `4000` (`src/ui/ChatView.ts:483-490`), model-swap cancellation Notice with duration `4000` (`src/ui/ChatView.ts:634-637`), model-swap failure Notice with duration `6000` (`src/ui/ChatView.ts:651-654`), send-gate block Notice with duration `5000` (`src/ui/ChatView.ts:792-794`), and chat error Notice with duration `8000` (`src/ui/ChatView.ts:1006-1013`).
- `McpServersSection.notify()` uses an injected `notify` callback when present, otherwise `new Notice(message, 8000)` (`src/settings/McpServersSection.ts:723-726`). Its stdio startup path uses sticky `new Notice(message, 0)` in production (`src/settings/McpServersSection.ts:742-755`).
- Existing coalescing/debounce utility found in repo: `ConversationsStore` has `DEFAULT_DEBOUNCE_MS = 500`, stores `debounceTimer`, clears it in `flushNow()`, and schedules a single delayed `flushImmediate()` with `setTimeout` when dirty (`src/persistence/ConversationsStore.ts:101-103`, `src/persistence/ConversationsStore.ts:122-135`, `src/persistence/ConversationsStore.ts:393-402`, `src/persistence/ConversationsStore.ts:437-453`).
- `main.ts` throttles binary-download Notice updates by checking `now - lastUpdate < 200` before calling `setMessage` (`src/main.ts:162-184`).
- No lodash `debounce` or Obsidian `debounce` import was found in repo search results; existing debounce/coalescing is custom `setTimeout`-based (`src/persistence/ConversationsStore.ts:442-453`, `src/main.ts:168-184`).

### 5. Test infrastructure

- Test framework is Vitest: `package.json` declares `test: "vitest run"`, dev dependency `vitest`, and `vitest.config.ts` imports `defineConfig` from `vitest/config` (`package.json:12`, `package.json:37-44`, `vitest.config.ts:1-19`).
- Vitest config uses Node environment, includes `src/**/*.test.ts`, and aliases `obsidian` to `src/test/obsidianMock.ts` (`vitest.config.ts:4-18`).
- MCP-related tests are under `src/mcp/` and include `McpManager.test.ts`, `McpManager.resilience.test.ts`, `McpManager.mvr.test.ts`, `McpManager.credentials.test.ts`, `McpServerRuntime*.test.ts`, `McpToolBridge.test.ts`, `McpToolRegistry.test.ts`, and related credential/transport tests (glob result; example `src/mcp/McpManager.test.ts:1-6`).
- `src/mcp/McpManager.test.ts` has a `describe("waitUntilEnabledReady (Phase 9)")` block (`src/mcp/McpManager.test.ts:110-193`). It covers immediate resolution with no servers, resolution after terminal connected status, timeout resolution when a server stays connecting, and `error` as terminal (`src/mcp/McpManager.test.ts:111-118`, `src/mcp/McpManager.test.ts:120-140`, `src/mcp/McpManager.test.ts:142-165`, `src/mcp/McpManager.test.ts:167-192`).
- The waitUntil timeout test uses real `Date.now()` and `setTimeout` elapsed assertions rather than Vitest fake timers (`src/mcp/McpManager.test.ts:158-164`). Other MCP tests use fake timers via `vi.useFakeTimers()` and `vi.advanceTimersByTimeAsync(...)` in reconnection/runtime/bridge tests (search results: `src/mcp/McpReconnectPolicy.test.ts:66-88`, `src/mcp/McpServerRuntime.test.ts:72-208`, `src/mcp/McpToolBridge.test.ts:51-99`).
- `src/sdk/AgentSession.test.ts` defines structural SDK fakes with captured `lastCreateSession`, `permissionHandler`, call counters, fake `session`, and fake `client.createSession` (`src/sdk/AgentSession.test.ts:23-50`, `src/sdk/AgentSession.test.ts:52-127`).
- `AgentSession` tests exercise readiness gate injection: `init awaits mcpReadinessGate before creating SDK session` uses a manually resolved Promise and asserts `createSession` has not fired before gate resolution (`src/sdk/AgentSession.test.ts:1069-1108`); `mcpReadinessGate that throws does NOT wedge init` asserts init resolves when the gate throws (`src/sdk/AgentSession.test.ts:1111-1129`).
- `AgentSession` tests also assert custom tools are forwarded to `createSession` (`src/sdk/AgentSession.test.ts:1177-1206`) and deferred-init recovery paths create sessions later (`src/sdk/AgentSession.test.ts:2158-2287`).
- ChatView tests found: `src/ui/ChatView.modelPick.test.ts`. It mocks Obsidian `Notice` and `setIcon`, mocks `ConversationPicker`, builds fake runtimes/managers/catalogs, and tests model-pick behavior (`src/ui/ChatView.modelPick.test.ts:1-30`, `src/ui/ChatView.modelPick.test.ts:44-93`, `src/ui/ChatView.modelPick.test.ts:95-160`). No ChatView readiness-indicator tests were found in existing test files.

### 6. Documentation system

- README begins with project name, one-sentence description, status callout, and release sections for v0.8, v0.7, v0.5, v0.6, v0.4, v0.3, v0.2, v0.1, install, local development, safety, tests, releasing, reference, and license (`README.md:1-13`, heading listing from repo inspection lines `README.md:7`, `README.md:15`, `README.md:29`, `README.md:36`, `README.md:76`, `README.md:85`, `README.md:98`, `README.md:136`, `README.md:168`, `README.md:191`, `README.md:230`, `README.md:240`, `README.md:244`).
- README documents MCP setup under `## MCP server setup (v0.5)` with stdio and Streamable HTTP sections and links to the MCP client technical reference (`README.md:36-74`). It documents the current M365 Graph scope reality and links to `docs/m365-graph-mcp.md` and proposals (`README.md:23-27`).
- README test commands are in a fenced block under `## Tests` (`README.md:230-236`). Local build/install/deploy steps are under `## Local development setup` (`README.md:168-190`).
- CHANGELOG format begins with `# Changelog`, a Keep-a-Changelog note, version headings `## [x.y.z] - YYYY-MM-DD`, subsections like `### Added`, `### Changed`, `### Notes`, `### Fixed`, and bullet entries with file references (`CHANGELOG.md:1-10`, `CHANGELOG.md:12-46`).
- The current top CHANGELOG section is `[0.8.0] - 2026-07-01`; it includes MCP tool-call UX hardening bullets, including `MCP readiness gate before session creation` and `Sticky stdio startup notice` (`CHANGELOG.md:6-8`, `CHANGELOG.md:37-42`).
- Additional docs folder is `docs/`, with user guides `m365-graph-mcp.md` and `preset-packs.md`; `docs/preset-packs.md` is a v1 reference for pack format/import/export flows (`docs/preset-packs.md:1-14`), and `docs/m365-graph-mcp.md` is an end-to-end user guide for the Microsoft 365 Graph MCP preset (`docs/m365-graph-mcp.md:1-20`).
- Proposals live under `proposals/`. `proposals/README.md` defines naming as `NNNN-short-slug.md`, top `Status:` line, short length, required sections `Problem`, `Sketch`, and `Open questions`, and a lifecycle from Draft to triaged/promoted statuses (`proposals/README.md:1-27`). The index lists proposals 0001 through 0007, including 0003 and 0005 (`proposals/README.md:28-39`).

### 7. Related prior work

- `proposals/0003-mcp-dynamic-tools.md` is titled `0003 — Mid-session MCP tool registry refresh`, status `Draft`, created `2026-06-18` (`proposals/0003-mcp-dynamic-tools.md:1-5`). It documents that the SDK locks its tool list at `client.createSession()` and that toggles/add/remove/list-changed events do not propagate to already-open conversations (`proposals/0003-mcp-dynamic-tools.md:7-13`). It records existing workarounds: Notice on enable/disable to start a new conversation and a tool-bridge error when the model tries an unavailable tool (`proposals/0003-mcp-dynamic-tools.md:14-23`). Its sketch lists three directions: recreate SDK session in place, SDK-level tool delta support, or investigate whether wrapper/session tools are consulted per turn (`proposals/0003-mcp-dynamic-tools.md:25-54`). Its open questions ask what the SDK does with `tools` after `createSession`, whether replay/hydration exists, and whether mid-session MCP changes should be disabled until implemented (`proposals/0003-mcp-dynamic-tools.md:65-74`).
- `proposals/0005-mcp-slice7-followup.md` is titled `0005 — Track upstream MCP filesystem slice(7) fix`, status `Draft`, created `2026-06-18` (`proposals/0005-mcp-slice7-followup.md:1-5`). It documents an upstream `@modelcontextprotocol/server-filesystem` Windows path parsing issue where `rootUri.slice(7)` mishandles drive-letter paths and percent-encoding (`proposals/0005-mcp-slice7-followup.md:7-21`). It documents the current workaround in `McpServerRuntime.advertisedRoots()` using `file://C:/Vaults/My Vault` compatibility form (`proposals/0005-mcp-slice7-followup.md:23-27`). Its sketch tracks watching upstream issue/PR, version bumping docs/templates, replacing `advertisedRoots()` with `pathToFileURL(cwd).href`, updating tests, and noting older filesystem-server versions in CHANGELOG (`proposals/0005-mcp-slice7-followup.md:28-41`). Its open questions ask about a runtime parser probe and other MCP servers sharing similar Windows path helper behavior (`proposals/0005-mcp-slice7-followup.md:51-59`).

## Code References

- `src/mcp/McpTypes.ts:17-24` - Declared MCP runtime statuses.
- `src/mcp/McpManager.ts:219-230` - `statusSnapshot()` implementation.
- `src/mcp/McpManager.ts:268-313` - `waitUntilEnabledReady(timeoutMs: number): Promise<void>` implementation.
- `src/mcp/McpManager.ts:465-468` - `subscribe(fn: () => void): () => void`.
- `src/mcp/McpManager.ts:470-488` - private `getOrCreate(config: McpServerConfig): McpServerRuntime`.
- `src/sdk/AgentSession.ts:131-151` - `mcpReadinessGate?: () => Promise<void>` option.
- `src/sdk/AgentSession.ts:583-609` - `init()` production/lazy initializer.
- `src/sdk/AgentSession.ts:611-613` - non-streaming send calls `init()`.
- `src/sdk/AgentSession.ts:690-692` - streaming send calls `init()`.
- `src/sdk/AgentSession.ts:1129-1140` - per-session tool snapshot builder.
- `src/sdk/AgentSession.ts:1151-1159` - `awaitMcpReadinessGate()`.
- `src/sdk/AgentSession.ts:1196-1204` - reset-conversation createSession gate site.
- `src/sdk/AgentSession.ts:1381-1389` - init createSession gate site.
- `src/sdk/AgentSession.ts:1453-1461` - deferred-recovery createSession gate site.
- `src/ui/ChatView.ts:198-207` - active runtime binding.
- `src/ui/ChatView.ts:459-499` - manager subscription and active rebind.
- `src/ui/ChatView.ts:685-724` - auth render and composer auth gate.
- `src/ui/ChatView.ts:542-580` - send-button gate rendering.
- `src/ui/ChatView.ts:778-810` - send gate check and busy state entry.
- `src/ui/ChatView.ts:1082-1112` - busy/streaming state render logic.
- `src/domain/ConversationManager.ts:141-154` - conversation event types.
- `src/domain/ConversationManager.ts:288-297` - active runtime lazy getter.
- `src/domain/ConversationManager.ts:378-385` - public `create()`.
- `src/domain/ConversationManager.ts:556-559` - manager subscription API.
- `src/domain/ConversationManager.ts:574-590` - runtime map get-or-create.
- `src/main.ts:329-348` - live runtime set and MCP settle broadcast.
- `src/main.ts:589-635` - MCP tool snapshot and readiness gate wiring into `CopilotAgentSession`.
- `src/main.ts:695-724` - runtime add/remove in `liveRuntimes`.
- `src/main.ts:784-825` - token/reconnect broadcasts to live runtimes.
- `node_modules/@github/copilot-sdk/dist/client.d.ts:213` - SDK `createSession(config: SessionConfig): Promise<CopilotSession>`.
- `node_modules/@github/copilot-sdk/dist/session.d.ts:33-290` - SDK public `CopilotSession` methods.
- `node_modules/@github/copilot-sdk/dist/types.d.ts:358-384` - SDK `Tool` and `defineTool` types.

## Architecture Documentation

- Per-conversation runtime ownership is the current architecture: each runtime owns its own `AgentSession`, `UndoJournal`, `ChatState`, and tool factory instances (`src/domain/ConversationRuntime.ts:1-11`, `src/domain/ConversationRuntime.ts:35-58`).
- Runtime instantiation is lazy through `ConversationManager.getActiveRuntime()` / `getOrCreateRuntime()` (`src/domain/ConversationManager.ts:288-297`, `src/domain/ConversationManager.ts:574-590`). Plugin startup has an explicit active-runtime warm-up before auth hydrate (`src/main.ts:865-885`).
- Live instantiated runtimes are also tracked outside `ConversationManager` in `main.ts` as `liveRuntimes` for token, reconnect, and MCP-call settlement broadcasts (`src/main.ts:329-348`, `src/main.ts:784-825`).
- MCP tools are captured by session-bound snapshots: `main.ts` builds `mcpTools: () => createMcpSdkTools(mcpSnapshot(), { manager: mcpManager })` (`src/main.ts:589-627`), and `AgentSession` reads that snapshot only at create-session boundaries via `toolsForSession()` (`src/sdk/AgentSession.ts:1129-1140`, `src/sdk/AgentSession.ts:1197-1204`, `src/sdk/AgentSession.ts:1382-1389`, `src/sdk/AgentSession.ts:1454-1461`).
- Existing docs state that starting a new conversation is required after enabling/disabling an MCP server because the SDK locks the tool list at session creation (`src/settings/McpServersSection.ts:689-701`, `docs/m365-graph-mcp.md:38-40`, `proposals/0003-mcp-dynamic-tools.md:7-23`).

## Open Questions

- Public SDK live custom-tool update method (`updateTools`, `setTools`, or `refreshTools`) not found in installed `@github/copilot-sdk@1.0.0` type surface (`node_modules/@github/copilot-sdk/dist/session.d.ts:33-290`).
- Plugin-side method for updating an existing `AgentSession`'s tool list not found in `src/sdk/AgentSession.ts`; current public adapter includes `swapModel` but no tool-update method (`src/sdk/AgentSession.ts:245-338`).
- ChatView readiness indicator state for MCP gate not found in current `ChatView` fields/render methods; current composer disabled state is auth/busy based and send-button gating is auth/streaming/pending/model/catalog based (`src/ui/ChatView.ts:104-112`, `src/ui/ChatView.ts:542-580`, `src/ui/ChatView.ts:685-724`, `src/ui/ChatView.ts:1082-1112`).
- Existing cross-conversation broadcast patterns operate over instantiated runtimes in `liveRuntimes`; broadcast-to-all-conversations including lazily uninstantiated metadata-only conversations is not found in repo (`src/main.ts:329-348`, `src/main.ts:784-825`, `src/domain/ConversationManager.ts:574-590`).
