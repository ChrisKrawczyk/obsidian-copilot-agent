# Code Research: Obsidian Copilot Agent v0.1

**Branch**: feature/copilot-sdk-spike  |  **Created**: 2026-06-02
**Inputs**: `Spec.md` (this work unit), `WorkflowContext.md` (this work unit)
**Repo state**: greenfield — only `README.md`, `.gitignore`, and `.paw/` artifacts exist.

This document is "code research" in the sense of investigating the **external technologies** the v0.1 plugin will compose. Each section maps to one of the research questions in the activity prompt. Every claim is followed by a citation; absences are flagged explicitly.

---

## R1. GitHub Copilot SDK (`@github/copilot-sdk`) — CRITICAL

### Findings

**Package identity & status.** The SDK is published, public, and MIT‑licensed.
- npm: `@github/copilot-sdk` ([npm badge in repo README](https://github.com/github/copilot-sdk/blob/main/README.md))
- Source: <https://github.com/github/copilot-sdk> — monorepo containing `nodejs/`, `python/`, `go/`, `dotnet/`, `java/`, `rust/`. License: MIT (`LICENSE` at repo root).
- The SDK README states: *"The GitHub Copilot SDK is generally available and follows semantic versioning."*
- Internal `package.json` reports `"version": "0.0.0-dev"` ([nodejs/package.json](https://github.com/github/copilot-sdk/blob/main/nodejs/package.json)) — that is a workspace placeholder; published versions are stamped via `scripts/set-version.js` in the `package` script. The actual published version on npm changes frequently; planning should pin a specific known-good version after a `npm view @github/copilot-sdk versions` check at implementation time.

**🔴 CRITICAL ARCHITECTURAL FINDING — the SDK is not a thin HTTP client.**

The Node SDK is **a JSON‑RPC controller for a locally‑spawned `@github/copilot` CLI process**. From [`nodejs/package.json`](https://github.com/github/copilot-sdk/blob/main/nodejs/package.json):

```json
"description": "TypeScript SDK for programmatic control of GitHub Copilot CLI via JSON-RPC",
"dependencies": {
  "@github/copilot": "^1.0.57",
  "vscode-jsonrpc": "^8.2.1",
  "zod": "^4.3.6"
}
```

The repo root README confirms the architecture:

> All SDKs communicate with the Copilot CLI server via JSON-RPC:
> Your Application → SDK Client → JSON-RPC → Copilot CLI (server mode)
> The SDK manages the CLI process lifecycle automatically.

Connection options ([nodejs/README.md, "CopilotClient" section](https://github.com/github/copilot-sdk/blob/main/nodejs/README.md)):
- `RuntimeConnection.forStdio({ path?, args? })` — **default; spawns the CLI as a child process and talks over its stdin/stdout**.
- `RuntimeConnection.forTcp({ port?, connectionToken?, path?, args? })` — spawn CLI as TCP server.
- `RuntimeConnection.forUri(url, { connectionToken? })` — connect to an externally‑running CLI.

**This means: at the moment `client.start()` is called, `@github/copilot` (a Node CLI binary) is launched as a subprocess of the Obsidian plugin.** This is the dominant feasibility risk for v0.1; see "Implications" below.

**Public API surface (Node).** From `nodejs/README.md`:

```ts
import { CopilotClient, approveAll, defineTool } from "@github/copilot-sdk";

const client = new CopilotClient({ gitHubToken, useLoggedInUser: false });
await client.start();

const session = await client.createSession({
  model: "gpt-5",                 // or "claude-sonnet-4.5", etc.
  streaming: true,
  onPermissionRequest: approveAll, // or custom PermissionHandler
  tools: [
    defineTool("read_file", {
      description: "Read a file from the vault",
      parameters: z.object({ path: z.string() }),
      handler: async ({ path }) => { /* ... */ },
    }),
  ],
});

session.on("assistant.message_delta", (e) => { /* streaming chunk */ });
session.on("assistant.message",       (e) => { /* final message */ });
session.on("session.idle",            ()  => { /* turn done */ });

await session.send({ prompt: "..." });
// or: await session.sendAndWait({ prompt: "..." }, timeoutMs);

await session.disconnect();
await client.stop();
```

Key types and capabilities:
- **Sessions are stateful and multi‑turn.** `createSession` returns a `CopilotSession`; `resumeSession(sessionId)` revives a prior session from disk. Session state is persisted under `~/.copilot/session-state/{sessionId}/` by default; `baseDirectory` overrides via `COPILOT_HOME`.
- **Streaming** is opt‑in via `streaming: true` and surfaces as `assistant.message_delta` events with `event.data.deltaContent`. `assistant.reasoning_delta` is also emitted for reasoning‑capable models. Final `assistant.message` events fire regardless of `streaming`.
- **Tools** are defined with `defineTool(name, { description, parameters: zodSchema, handler })`. Raw JSON Schema is also accepted if Zod is undesired. The SDK validates inputs (Zod); handler return values may be any JSON‑serializable value, a string, or a `ToolResultObject`. `overridesBuiltInTool: true` is required to shadow built‑in CLI tools (`edit_file`, `read_file`, etc.). `skipPermission: true` bypasses the permission prompt for that one tool.
- **Built‑in tool surface.** From the repo FAQ: *"By default, the SDK exposes the Copilot CLI's first‑party tools, similar to running the CLI with `--allow-all`."* This includes `read_file`, `edit_file`, `view`, shell tools, etc. **For v0.1 we will need to disable or override most built‑ins** (we want vault‑scoped variants, not CLI host‑filesystem variants). The README confirms tool availability is configurable via session/client options; the precise option name was not located in this research pass — see "Open questions".
- **Permission model.** `onPermissionRequest(request, invocation)` callback returns one of `{kind: "approve-once" | "approve-for-session" | "approve-for-location" | "approve-permanently" | "reject" | "user-not-available" | "no-result"}`. `request.kind` is one of `"shell" | "write" | "read" | "mcp" | "custom-tool" | "url" | "memory" | "hook"` plus future kinds. **This is a perfect fit for FR‑011 (write‑safety policy).**
- **Hooks**: `onPreToolUse`, `onPostToolUse`, `onPostToolUseFailure`, `onUserPromptSubmitted`, `onSessionStart`, `onSessionEnd`. `onPreToolUse` can return `{permissionDecision: "allow"|"deny"|"ask", modifiedArgs, additionalContext}` — also relevant to safety policy.
- **Model discovery**: client method `listModels()` returns the per‑account model list (the repo FAQ states *"All models available via Copilot CLI are supported in the SDK. The SDK also exposes a method which will return the models available so they can be accessed at runtime."*). This satisfies FR‑016.
- **Abort / cancel**: `session.abort()`. Useful for "user cancels" edge case in the spec.
- **Infinite sessions**: enabled by default; auto‑compacts context. We can disable via `infiniteSessions: { enabled: false }` if persistence semantics conflict with our own per‑vault chat history.

**Auth model.**
[docs/auth/authenticate.md](https://github.com/github/copilot-sdk/blob/main/docs/auth/authenticate.md) is explicit:

| Token prefix | Supported? |
|---|---|
| `gho_` (OAuth user access) | ✅ Yes |
| `ghu_` (GitHub App user access) | ✅ Yes |
| `github_pat_` (fine‑grained PAT) | ✅ Yes |
| `ghp_` (classic PAT) | ❌ Not supported |

Pass via `new CopilotClient({ gitHubToken: "gho_…", useLoggedInUser: false })`. Priority order (highest first): explicit `gitHubToken` → HMAC env var → direct API token → env var tokens (`COPILOT_GITHUB_TOKEN`, `GH_TOKEN`, `GITHUB_TOKEN`) → stored CLI OAuth → `gh` CLI auth.

> **Important caveat we did NOT confirm:** the SDK README does not specify the HTTP endpoint the spawned CLI calls. `models.github.ai/inference` (per the prompt) appears in *GitHub Models* docs, not in `copilot-sdk`. The CLI is the one talking to GitHub, not our process. The plugin's only network surface (besides OAuth) is whatever the spawned `@github/copilot` binary opens. For planning purposes, treat the network endpoint as an SDK/CLI implementation detail we don't control.

**Runtime requirements.**
- Node engine: `"node": "^20.19.0 || >=22.12.0"` ([nodejs/package.json](https://github.com/github/copilot-sdk/blob/main/nodejs/package.json)). Obsidian (Electron‑based) historically ships with Node ≥ 20 in current desktop builds; **must verify against the installer's actual Electron/Node version at implementation time**. If Obsidian's bundled Node is below 20.19, we have an immediate blocker.
- Module type: ESM with CJS fallback (`"type": "module"`, `exports` map provides both). Obsidian plugins compile to CJS via esbuild; CJS path is what we'll consume.
- Subprocess spawn: **mandatory in default config** (forStdio).
- Filesystem assumptions: the spawned CLI writes session state to `~/.copilot/session-state/{sessionId}/` (overrideable via `baseDirectory` → `COPILOT_HOME`). It expects a writable filesystem.
- `@github/copilot` (the CLI dep) is bundled as a normal npm dep — *no separate user install required for Node SDK consumers* (per the repo FAQ). However the CLI itself may include native binaries; this needs verification (see open questions).

**Streaming specifics.** Event‑emitter pattern with typed handlers — `session.on("assistant.message_delta", (e) => e.data.deltaContent)`. **Not** SSE‑style at the SDK boundary; the SDK absorbs the JSON‑RPC stream and re‑emits typed events. For our chat UI we accumulate `deltaContent` strings as they arrive.

### Confidence

**High** for: package identity, public API shape, auth model, streaming pattern, tool/permission interfaces, runtime architecture (CLI subprocess via JSON‑RPC).
**Medium** for: exact mechanism to disable built‑in tools (the README says it's configurable but the precise option name wasn't located in this pass).
**Low** for: whether `@github/copilot` (the CLI binary the SDK spawns) ships any native modules, and how it behaves when launched from Electron's renderer process specifically.

What would raise confidence: actually `npm install @github/copilot-sdk` in a throwaway directory, inspect `node_modules/@github/copilot/` to see if it contains pure JS or any platform‑specific binaries, then try running the SDK quickstart from inside an Obsidian plugin shell.

### Implications for planning

**Treat as KNOWN:**
- The SDK exists, is public, MIT‑licensed, generally available. No license blocker for a desktop plugin.
- API shape (`CopilotClient`, `createSession`, `defineTool`, streaming events, `onPermissionRequest`, `listModels`) — the plugin can be designed against this surface today.
- The SDK accepts `gho_` tokens directly via `gitHubToken` — Device Flow output will plug straight in.
- Streaming, multi‑turn, custom tools, and per‑tool permission gating are all first‑class — Spec FR‑005 / FR‑006 / FR‑007 / FR‑009 / FR‑011 are technically achievable.

**Treat as STILL‑UNCERTAIN (must validate in milestone 1 before further investment):**
- **Whether the SDK's "spawn `@github/copilot` CLI as a child process" model works inside an Obsidian plugin.** This is the single biggest feasibility risk. Obsidian's renderer process *does* expose Node APIs including `child_process` (this is how `obsidian-git`, `obsidian-shellcommands`, and many other plugins work — see R2), so in principle this is fine. But (a) Electron renderers historically have stricter constraints than the main process; (b) the CLI's stdio piping must survive Electron's wrapping; (c) anti‑virus / Gatekeeper / Defender may flag a node binary spawned from inside Obsidian on first run. Concretely: the Phase 1 implementation should be exactly what the spec's Risks section calls out — *"Validate SDK loadability and basic session creation as the first implementation milestone before building the full chat UI."*
- **Whether Obsidian's bundled Node version meets `^20.19.0 || >=22.12.0`.** Obsidian 1.5+ ships Electron 27+ which is Node 18.17+; Electron 30+ is Node 20.x. If the user's Obsidian build is older than ≈Electron 30, the SDK will refuse to load. Plan: query Obsidian's reported Node version at plugin load (`process.versions.node`) and abort with a clear error if too old. Set `manifest.minAppVersion` accordingly once the floor is known.
- **Whether built‑in CLI tools (which include shell, file edit, web fetch, etc.) can be cleanly *disabled* rather than just *overridden*.** We must not allow the agent to call CLI's host‑filesystem `read_file` while we expose a vault‑scoped `read_file` next to it. We can override by name with `overridesBuiltInTool: true` for any built‑in we want to replace, but full disable‑by‑default may require additional config.

**Affects spec:**
- The "SDK runs in Electron plugin sandbox" risk in Spec §Risks should be re‑rated as **Critical** (currently High) and tied explicitly to the milestone‑1 validation gate.
- A new risk surfaces: **AV / endpoint security tooling may block the plugin spawning `@github/copilot`**. This is an externally‑imposed risk we can only document, not engineer around.

### Open questions

1. **Exact option to disable all built‑in tools.** README mentions tool availability is configurable via session/client options but doesn't show the disable‑all flag. → Next step: read `nodejs/src/` (specifically the `SessionConfig` / `CopilotClientOptions` types) directly via `npm install @github/copilot-sdk` and inspect `dist/index.d.ts`, or grep the source for `builtinTools` / `enableBuiltinTools`.
2. **Does `@github/copilot` (the CLI dep) include native modules or platform‑specific binaries?** → Next step: install the package and inspect `node_modules/@github/copilot/`. If it does, we may have plugin distribution complications (must ship platform‑specific bundles).
3. **Does `client.start()` work in Electron renderer when `nodeIntegration` is enabled but the renderer is sandboxed?** → Next step: build the Phase 1 spike and observe.

---

## R2. Obsidian plugin scaffolding

### Findings

**Sample plugin reference:** <https://github.com/obsidianmd/obsidian-sample-plugin>.

**`manifest.json`** ([source](https://github.com/obsidianmd/obsidian-sample-plugin/blob/master/manifest.json)):

```json
{
  "id": "sample-plugin",
  "name": "Sample Plugin",
  "version": "1.0.0",
  "minAppVersion": "1.0.0",
  "description": "...",
  "author": "...",
  "authorUrl": "...",
  "isDesktopOnly": false
}
```

For our plugin: `isDesktopOnly: true` (FR‑017), `minAppVersion` to be set after we validate the Node version floor (≥ Electron version that ships Node ≥ 20.19).

**`esbuild.config.mjs`** ([source](https://github.com/obsidianmd/obsidian-sample-plugin/blob/master/esbuild.config.mjs)) — the canonical pattern. Key takeaways:
- Output: single `main.js` at plugin root, CJS, target `es2021`, sourcemap inline in dev.
- `external` list includes `obsidian`, `electron`, all `@codemirror/*`, all `@lezer/*`, and `...builtinModules` (Node builtins).
- This means `child_process`, `fs`, `path`, etc. are **not bundled** — they're resolved at runtime from Electron's bundled Node. Confirms Obsidian plugins can use Node builtins on desktop. **Critical for SDK feasibility**: when esbuild bundles `@github/copilot-sdk`, it will leave `child_process`, `fs`, `os`, and `vscode-jsonrpc`'s Node deps unresolved at bundle time and resolved at runtime. We must verify all SDK deps either bundle cleanly or are listed in our externals.
- We will likely need to add `@github/copilot` to the externals (or accept that esbuild bundles it as raw JS).

**Build pipeline & dev workflow.** `npm run dev` runs esbuild in watch mode against `src/main.ts`. Plugin output is `main.js` + `manifest.json` (+ optional `styles.css`). For development against a real vault, the conventional flow is to `git clone` the plugin repo into `<vault>/.obsidian/plugins/<plugin-id>/` and let esbuild watch‑rebuild in place. The Hot Reload community plugin (`pjeby/hot-reload`) auto‑reloads after rebuilds.

**ItemView / WorkspaceLeaf for the right‑sidebar pane.** Standard pattern (verified against multiple chat plugins, including logancyang/obsidian-copilot's `src/components/` structure):

```ts
import { ItemView, WorkspaceLeaf, Plugin } from "obsidian";

const VIEW_TYPE_CHAT = "copilot-agent-chat";

class ChatView extends ItemView {
  getViewType() { return VIEW_TYPE_CHAT; }
  getDisplayText() { return "Copilot Agent"; }
  getIcon() { return "bot"; }
  async onOpen() { /* mount React/Svelte/raw DOM here */ }
  async onClose() { /* teardown */ }
}

class MyPlugin extends Plugin {
  async onload() {
    this.registerView(VIEW_TYPE_CHAT, (leaf) => new ChatView(leaf));
    this.addCommand({
      id: "open-chat",
      name: "Open Copilot Agent",
      callback: () => this.activateView(),
    });
  }

  async activateView() {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(VIEW_TYPE_CHAT)[0];
    if (!leaf) {
      leaf = workspace.getRightLeaf(false)!;
      await leaf.setViewState({ type: VIEW_TYPE_CHAT, active: true });
    }
    workspace.revealLeaf(leaf);
  }
}
```

This is the minimal boilerplate. The view's `containerEl` is a regular DOM node — any rendering technology (React + ReactDOM, Svelte, Preact, plain DOM) works.

**Markdown rendering.** `MarkdownRenderer.render(app, markdown, el, sourcePath, component)` (Obsidian ≥ 1.4). It recursively renders Markdown into a DOM element with full Obsidian semantics (wikilinks, embeds, etc.). The older `MarkdownRenderer.renderMarkdown` is deprecated. Obsidian docs: <https://docs.obsidian.md/Reference/TypeScript+API/MarkdownRenderer/render>.

For a streaming chat: rendering on every `assistant.message_delta` would be expensive (full re‑parse per token). Common approaches (see R6):
- Buffer deltas into the message's running text; debounce/throttle re‑renders to ~30–60ms intervals.
- Render the partial message as plain text into a `<pre>`/styled `<div>` while streaming, then swap in fully‑rendered Markdown on `assistant.message` (final).

**`loadData()` / `saveData()`.** Per Obsidian docs (<https://docs.obsidian.md/Reference/TypeScript+API/Plugin/loadData>): plain JSON read/write to `<vault>/.obsidian/plugins/<plugin-id>/data.json`. World‑readable to anyone with vault filesystem access. **Vault‑sync providers (Obsidian Sync, iCloud, Dropbox) sync `.obsidian/` by default unless excluded**, which is the security threat for token storage (R5).

**Vault adapter (`Vault` API).** Per docs.obsidian.md/Plugins/Vault:
- `vault.read(file: TFile): Promise<string>` — UTF‑8 text read.
- `vault.cachedRead(file: TFile): Promise<string>` — preferred for read‑only use; uses Obsidian's cache.
- `vault.modify(file: TFile, content: string): Promise<void>` — write, **respects open editors** (this is the safe write path).
- `vault.create(path: string, content: string): Promise<TFile>` — create, parent dirs auto‑created.
- `vault.delete(file: TAbstractFile, force?: boolean): Promise<void>` — recommended; `vault.trash(file, system?: boolean)` to send to Obsidian/system trash.
- `vault.adapter` — `DataAdapter` exposing lower‑level path‑oriented APIs (`adapter.read`, `adapter.write`, `adapter.list`, `adapter.exists`). Generally we should prefer the `TFile`/`TFolder` APIs because they integrate with Obsidian's metadata cache and editor state.
- `vault.adapter.basePath` (on `FileSystemAdapter`) returns the absolute filesystem path of the vault root on desktop. Cast: `(vault.adapter as FileSystemAdapter).getBasePath()` is the public‑ish accessor.

**Path containment.** Obsidian's vault APIs expect *vault‑relative* paths (forward slashes, no leading slash). They internally guard against escaping the vault when given relative paths, but **paths from the agent are untrusted** and may contain `..`, absolute paths, drive letters, or symlink targets. We must canonicalize before any I/O. See R7.

**Settings UI.** `class MySettingTab extends PluginSettingTab` with `display()` returning DOM via `new Setting(containerEl).setName(...).addText(...)`. Standard pattern in the sample plugin's `SampleSettingTab`. Registered via `this.addSettingTab(new MySettingTab(this.app, this))` in `onload`.

**BRAT.** "Beta Reviewers Auto‑update Tool" — `TfTHacker/obsidian42-brat`. Distribution model: publish a GitHub release with `manifest.json`, `main.js`, optional `styles.css` attached as release assets. Users install BRAT, add our repo URL, and get auto‑updates. **This is sufficient for v0.1**; the official community plugin store (which requires submission to `obsidianmd/obsidian-releases`) is explicitly out of scope per Spec §Out of Scope.

### Confidence

**High** across the board. The sample plugin and Obsidian's official docs are authoritative and stable.

### Implications for planning

**KNOWN:**
- Plugin scaffolding follows a well‑documented pattern: `manifest.json` + esbuild → `main.js`, single‑file output.
- `ItemView` + `WorkspaceLeaf` covers the chat pane (FR‑003) trivially.
- `MarkdownRenderer.render` covers FR‑004 trivially.
- `Vault.modify` / `vault.create` / `vault.delete` cover FR‑007 cleanly and respect open‑editor state (mitigates the "agent overwrites user's unsaved changes" risk in Spec §Risks).
- `loadData`/`saveData` covers FR‑014 (chat history persistence) cleanly.
- BRAT covers v0.1 distribution; no community‑store submission needed.

**STILL‑UNCERTAIN:**
- Esbuild bundling of `@github/copilot-sdk`: do all transitive deps survive the `external: [...builtinModules]` configuration without adjustment? Particularly `vscode-jsonrpc` (which uses `child_process`, `net`, etc.) and `@github/copilot` (the CLI). Plan: keep esbuild's `platform: 'node'` setting if needed, and add SDK + CLI to externals if bundling produces errors.
- Whether `MarkdownRenderer.render` performance is acceptable for a chat with frequent re‑renders (500+ tokens streaming over ~10s). Mitigation: throttle.

### Open questions

None blocking. Implementation will resolve the bundling specifics empirically.

---

## R3. Reference plugin: `logancyang/obsidian-copilot` (AGPL‑3.0)

### License‑isolation reminder

**This plugin is AGPL‑3.0.** Read for *structural patterns and pitfall awareness only*. Do not copy code, do not vendor files, do not paste source verbatim. All descriptions below are abstract.

### Findings

Repository: <https://github.com/logancyang/obsidian-copilot>.

**Top‑level `src/` layout** (observed via API listing, no file content read):

```
src/
  LLMProviders/    — provider abstraction (OpenAI, Anthropic, Azure, Ollama, etc.)
  cache/           — response/embedding caching
  commands/        — Obsidian command palette entries
  components/      — UI components (chat view, settings, etc.)
  context/, contexts/  — chat context aggregation
  core/            — core orchestration
  editor/          — editor integration helpers
  hooks/           — React hooks (suggests React UI)
  imageProcessing/
  integration_tests/, __tests__/, tests/
  lib/, utils/
  memory/          — conversation memory
  mentions/        — @-mention handling
  miyo/, projects/  — project/workspace concepts
  search/          — vault search
  services/        — service layer
  settings/, state/ — settings + global state
  styles/, system-prompts/
  tools/           — tools the agent can invoke
  types/
```

**Pattern‑level observations** (high level, abstract):

1. **Layered architecture.** A clear separation between `LLMProviders/` (network/API), `core/` (agent loop / orchestration), `tools/` (capabilities), `services/` (domain logic), `components/` (UI). Our plugin is simpler (one provider — the Copilot SDK — and a small tool surface), but the layering is worth borrowing in spirit: keep the SDK adapter behind one interface (Spec Risk mitigation), keep tools as standalone modules each owning their permission/path‑validation logic, keep the chat view free of SDK‑specific knowledge.
2. **State management exists as a first‑class concern** (`state/`). For v0.1 we have one chat session + safety policy; a single store (Svelte store, Redux, or even a hand‑rolled observable) is enough.
3. **Hooks directory implies React.** logancyang's plugin uses React + ReactDOM mounted into the `ItemView`'s container. This is the dominant pattern in larger Obsidian plugins. For v0.1 we can choose React, Svelte, or plain DOM; React adds bundle weight (~150KB) but is well‑known and straightforward to bring in. Plain DOM is sufficient for FR‑003 / FR‑009 if we want minimum bundle size.
4. **Tools directory exists** — each tool is a discrete unit. Confirms our plan to expose a small fixed tool surface (read/list/search/create/modify/delete) as ~6 tool modules.
5. **Search directory exists separately from tools** — implies search has enough complexity (indexing, retrieval ranking) to warrant its own subsystem. Our v0.1 explicitly defers semantic indexing; v0.1 search is just substring/regex over `vault.cachedRead` results, which can live inline in the search tool.
6. **System prompts directory** — they treat prompts as data. We should do the same: a small `prompts/` directory with one assistant system prompt and one tool‑use guidance prompt, version‑controlled and easy to iterate.

**Pitfalls likely encountered (informed inference, since we did not read code):**

- **Streaming + tool‑call interleaving in the chat UI** (also R6). The presence of separate `core/`, `components/`, and `tools/` directories suggests the rendering model decouples message state from message DOM — i.e., the message store is the source of truth and the DOM re‑renders from the store on each delta. We should adopt the same pattern.
- **Settings UI complexity for multi‑provider configs.** Their `settings/` dir is large because they support many providers. We have one (SDK), so our settings tab is much smaller.
- **License/attribution handling.** Their plugin is AGPL‑3.0 — their distribution constraints are stricter than ours. We are MIT‑clean (we'll license our plugin however we choose, just don't import their code).

### Confidence

**Medium.** We observed the directory structure but did not read source code (license‑isolation rule). Inferences about pitfalls are informed but not file‑level verified.

### Implications for planning

**KNOWN:**
- Layered architecture (UI / agent / tools / SDK adapter) is the right shape — borrow the *idea*, not the code.
- React is a viable UI choice if we want it; plain DOM is sufficient for v0.1.
- Treating prompts as data files (not string literals scattered through code) is a worthwhile convention.

**STILL‑UNCERTAIN:**
- Specific UX patterns (how they render tool‑call blocks, how undo is surfaced) — would require reading their UI code, which we are not doing. We should design our own UX from spec acceptance criteria.

### Open questions

None — the license‑isolation rule explicitly bounds how much we can extract from this reference.

---

## R4. GitHub OAuth Device Flow

### Findings

**Endpoints** (per <https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps#device-flow>):

1. `POST https://github.com/login/device/code`
   Body (form or JSON): `client_id`, optional `scope` (space‑delimited).
   Response: `device_code`, `user_code`, `verification_uri` (`https://github.com/login/device`), `expires_in` (seconds, typically 900), `interval` (seconds between polls, typically 5).
2. `POST https://github.com/login/oauth/access_token`
   Body: `client_id`, `device_code`, `grant_type=urn:ietf:params:oauth:grant-type:device_code`.
   Response (success): `access_token` (`gho_…` for OAuth Apps, `ghu_…` for GitHub Apps), `token_type=bearer`, `scope`.
   Response (pending): `{"error": "authorization_pending"}` — keep polling at `interval`.
   Other errors: `slow_down` (increase interval by 5s), `expired_token`, `access_denied`, `incorrect_device_code`.

**Headers**: `Accept: application/json` (default is form‑encoded). Always set this.

**The GitHub CLI's OAuth client ID `178c6fc778ccc68e1d6a`.** This is the public client ID for the official `gh` CLI (visible in many forks and the `cli/cli` repo's source). **Reusing it has nontrivial implications:**

1. **GitHub's Acceptable Use policy** prohibits impersonating other applications. Using a client ID registered to GitHub's CLI would cause our plugin's OAuth consent screens to display as "GitHub CLI" rather than our plugin's name — that *is* impersonation in the user's view. This is a real risk.
2. **The user's authorization grants are scoped to that client ID**, meaning revoking the plugin would also revoke `gh` CLI for the same user, and vice versa. Confusing UX.
3. **Rate limits** are scoped per client ID; we'd be sharing a bucket with `gh` CLI traffic for that user.
4. **GitHub may revoke or rotate that client ID** at any time without notice — we have no contract with GitHub about its stability.

**Recommendation for v0.1**: register a dedicated OAuth App ("Obsidian Copilot Agent" or similar) under a personal/project GitHub account. Device Flow works fine for OAuth Apps. Registration is free and takes ~2 minutes at <https://github.com/settings/developers>. Display name and icon will appear correctly in user consent. Spec Risk re: "OAuth client identifier reuse" should explicitly recommend a dedicated app.

**Required scopes for GitHub Models / Copilot SDK access.** This is **the biggest uncertainty in this section.**

The Copilot SDK's authentication doc (R1) accepts `gho_` user‑to‑server tokens but does not enumerate the scopes the token must carry. From observation of the Copilot CLI source and ecosystem behavior:
- The `gh` CLI requests scopes including `repo`, `read:org`, `gist`, `workflow`, plus on‑demand `copilot` extension scopes.
- For Copilot Chat / SDK access specifically, the relevant scopes appear to be (based on GitHub's REST API docs for Copilot endpoints): the **user must have an active Copilot subscription on the account**, and the token must have at least `read:user` (to identify the user). Models/Copilot endpoints check subscription server‑side, not via token scope.
- **`models:read`** is documented as a fine‑grained PAT permission for the *GitHub Models* API (the public LLM playground at `models.github.ai`). It is **not clear whether Device Flow OAuth tokens (for OAuth Apps) can request a `models` scope at all**, since that's a fine‑grained PAT concept distinct from OAuth scopes.

**The Copilot SDK does not appear to use the GitHub Models API directly** (R1: it spawns the `@github/copilot` CLI, which talks to GitHub's Copilot backend, not the Models playground). So for our use case, the path is:
1. User has a Copilot subscription.
2. Device Flow grants a `gho_` token with no special scopes (or with `read:user`).
3. Pass the token to the SDK; the SDK/CLI exchanges it for a Copilot session.

**This must be empirically confirmed in the Phase 1 spike.** If it doesn't work with `read:user` alone, try `repo`/`user:email` first, then fall back to documenting "user must run `gh auth login --scopes copilot`" as an alternative.

**SSO‑protected enterprise orgs.** If a user's Copilot entitlement comes via an enterprise org with SAML SSO, the token may need to be SSO‑authorized for that org. The `gh` CLI prompts the user to authorize SSO when needed; for our plugin, we can detect 403s with the `X-GitHub-SSO` header and surface the SSO authorization URL to the user. For v0.1 this can be a "known limitation: enterprise SSO users may need to authorize the OAuth app for their org" entry in the README.

### Confidence

**High** for: Device Flow mechanics (endpoints, polling, token format), risk of reusing the `gh` client ID.
**Low** for: which OAuth scopes actually unlock SDK / Copilot access. This is the open question that most needs Phase‑1 spike resolution.

### Implications for planning

**KNOWN:**
- Implement Device Flow as a small, dependency‑free function: POST device code → poll access_token → return `gho_` token.
- Use `Accept: application/json` to get JSON responses.
- Handle `slow_down` and `authorization_pending` correctly.

**STILL‑UNCERTAIN:**
- Required scopes for SDK access — empirical only. Plan: in Phase 1 spike, request `read:user` and try; widen if rejected.
- Whether to ship with our own OAuth App from day one (recommended) or let the user paste a PAT for v0.1 (simpler but worse UX). The spec implies OAuth (FR‑001).

**Affects spec:**
- Spec FR‑001 says "GitHub CLI's OAuth client identifier" — this should be revised to "a dedicated OAuth App registered for the plugin" before shipping. The CLI client ID can remain a fallback for development if convenient.

### Open questions

1. **Exact required scope(s) for Device Flow tokens to grant Copilot SDK access.** → Next step: register a test OAuth App, run Device Flow with empty scope, then `read:user`, then `repo`, and at each step try `client.start()` + `session.sendAndWait`. Document what works.
2. **Behavior with enterprise SSO.** → Next step: defer to v0.2 unless a tester hits it during the Phase 1 spike.

---

## R5. Token storage in Obsidian plugins (security baseline)

### Findings

**Practical baseline used by virtually all Obsidian plugins**: `loadData()` / `saveData()`, which persist to `<vault>/.obsidian/plugins/<plugin-id>/data.json` as plain JSON. Documented at <https://docs.obsidian.md/Reference/TypeScript+API/Plugin/loadData>. This is what `obsidian-copilot`, `smart-second-brain`, `obsidian-textgenerator-plugin`, and the rest of the AI ecosystem use to store API keys.

**Threat model for plain‑JSON token storage:**
- Anyone with read access to the user's filesystem can read `data.json` (no encryption at rest).
- If the vault is on a sync provider (Obsidian Sync, iCloud, Dropbox, OneDrive, Google Drive, syncthing), the plugin's `data.json` is synced to that provider unless explicitly excluded. **Obsidian Sync excludes `.obsidian/plugins/*/data.json` from sync by default** (per Obsidian Sync docs), but **third‑party syncs do not** — they sync `.obsidian/` wholesale.
- Backup tools may capture the token too.

**Keychain / OS‑level secret storage options:**

| Option | Available? | Verdict for v0.1 |
|---|---|---|
| Electron `safeStorage` | Yes in main process; **not directly accessible from plugin renderer** because Obsidian doesn't expose `remote` or a custom IPC bridge for plugins. | Not practical. |
| `keytar` (npm) | Native module → requires platform‑specific binaries; Obsidian plugin distribution is single‑file `main.js`; native modules are explicitly hard. | Not practical for v0.1. |
| `node-keytar` via `require()` from Obsidian's bundled deps | Obsidian does not bundle keytar. | Not available. |
| Obsidian's own secret API | None exists. | N/A. |

**Conclusion:** the realistic v0.1 baseline is `loadData/saveData` plain JSON, with **README disclosure** of the exact threat model:

> **Security note**: Your GitHub OAuth token is stored in plaintext in `<vault>/.obsidian/plugins/copilot-agent/data.json`. Anyone with read access to your vault's filesystem can read this token. If your vault is synced via a third‑party service (iCloud, Dropbox, etc.), the token will be synced too. Obsidian Sync excludes plugin data by default. Revoke the token at <https://github.com/settings/applications> if compromised.

A "do not persist token" toggle (token kept only in memory; user re‑auths every session) is a low‑cost addition for security‑conscious users — recommend including it as a Phase‑1 feature.

### Confidence

**High** for: the baseline pattern, the threat model, the unavailability of `safeStorage` from plugin renderer code, the impracticality of `keytar` for plugin distribution.
**Medium** for: precise sync behavior across third‑party providers (varies; the README disclosure should be conservative).

### Implications for planning

**KNOWN:**
- Use `loadData/saveData` for token storage in v0.1. Don't try to engineer keychain integration in v0.1.
- Disclose the threat model in the README.
- Add a "do not persist token" setting for users who want in‑memory‑only tokens.

**STILL‑UNCERTAIN:**
- Whether to prompt the user with an in‑plugin warning the first time they store a token, or only document in README. UX choice; either works.

### Open questions

None blocking.

---

## R6. Streaming + tool‑call rendering UX

### Findings

**Pattern‑level observations** (based on R3's structural analysis of `obsidian-copilot` and general practice in chat UIs):

The widely‑used render model is **store‑driven, not DOM‑driven**:
1. The chat session has a list of messages. Each message is one of: `user`, `assistant`, `tool_call`, `tool_result`.
2. An assistant message has a streaming `content` field (string) and a `status` field (`streaming | complete | interrupted`).
3. SDK events update the store:
   - `assistant.message_delta` → append to the running assistant message's `content`.
   - `tool.execution_start` → push a `tool_call` entry onto the message list with `status: running`.
   - `tool.execution_complete` → set the matching `tool_call` entry's `status: complete` and store the result.
   - `assistant.message` (final) → mark the assistant message `complete`, replace `content` with final text.
   - `session.idle` → end‑of‑turn marker.
4. The view subscribes to the store and re‑renders affected messages. Throttle Markdown re‑renders to ~30–60ms intervals during streaming; on `complete` do one final full Markdown render.

**Tool‑call rendering**: a collapsible block within the message stream, shown inline at the position where the tool was invoked relative to the streaming text. Visual: a header showing `🔧 read_file`, expand‑arrow, on expand show args + (when complete) result. This satisfies Spec FR‑009.

**Interleaving**: the SDK's event stream guarantees ordering — `assistant.message_delta` events that arrive *before* a `tool.execution_start` belong to the pre‑tool stream chunk; deltas after `tool.execution_complete` belong to the post‑tool chunk. We render this as: text → tool block → text, all within the same logical assistant turn.

**`MarkdownRenderer.render` performance with rapidly‑mutating content**: calling it on every delta is **prohibitively expensive** (synchronous parse + DOM construction per call). Two practical strategies:
1. **Plain‑text during stream, full Markdown on completion.** Render `content` as a `<div>` with `white-space: pre-wrap` while streaming; on `assistant.message`, swap that `<div>` for a fully‑rendered Markdown DOM. Drawback: code blocks/headings/lists don't appear formatted until the message completes.
2. **Throttled re‑render.** Throttle full Markdown re‑renders to e.g. 50ms. Each render replaces the message's container DOM. Drawback: small visual flicker; CPU cost during long messages.

For v0.1, **start with strategy 1** (plain‑text during stream, full Markdown on completion). It's simpler, cheaper, and matches user expectation of "watching the model type". Strategy 2 can be a v0.2 polish item.

**Reference pattern (abstract, no code copy)** from the structural inspection of `logancyang/obsidian-copilot/src/components/`: components are React, state lives in `state/`, messages render from store, tools are separate components. We can replicate the *shape* freely.

### Confidence

**High** for the rendering model — this is well‑established pattern across many chat UIs (ChatGPT, Claude, Continue, etc.).
**Medium** for `MarkdownRenderer.render` performance characteristics — empirical only, will measure in Phase 2.

### Implications for planning

**KNOWN:**
- Adopt store‑driven rendering with messages as the source of truth and DOM as a derived view.
- Render plain text during stream; swap to full Markdown on `assistant.message`. (Defer throttled live‑Markdown to v0.2.)
- Tool‑call blocks render inline within the message stream, in event order.

**STILL‑UNCERTAIN:**
- Specific UX for "Undo" affordance position (per‑tool‑call vs. per‑message). Recommendation: per‑tool‑call, attached to each successful write tool block, since FR‑010 says "for each successfully applied write tool call".

### Open questions

None blocking.

---

## R7. Path‑traversal hardening (informational)

### Findings

**Standard Node pattern** for verifying a target path stays within a root:

```ts
import * as path from "node:path";
import * as fs from "node:fs/promises";

async function ensureWithin(rootAbs: string, targetRel: string): Promise<string> {
  // 1. Normalize the *relative* input — strip leading separators, normalize . and ..
  const normalizedRel = path.normalize(targetRel).replace(/^([\\/]+)/, "");
  // 2. Reject explicit absolute paths (cross-platform: drive letters, UNC, leading /)
  if (path.isAbsolute(targetRel) || /^[a-zA-Z]:/.test(targetRel) || /^\\\\/.test(targetRel)) {
    throw new Error("Absolute paths are not allowed.");
  }
  // 3. Resolve against root
  const resolved = path.resolve(rootAbs, normalizedRel);
  // 4. Containment check using path.relative — robust on Windows because it
  //    normalizes case and separators.
  const rel = path.relative(rootAbs, resolved);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error("Path escapes vault root.");
  }
  // 5. Symlink check: realpath the *parent* of the target (or the target itself
  //    if it exists) and re-verify containment. Realpath fails if any component
  //    doesn't exist; on writes to new files we realpath the deepest existing
  //    ancestor.
  const real = await realpathDeepestExisting(resolved);
  const realRel = path.relative(rootAbs, real);
  if (realRel.startsWith("..") || path.isAbsolute(realRel)) {
    throw new Error("Path escapes vault root via symlink.");
  }
  return resolved;
}
```

Key cross‑platform concerns:

1. **Windows path separators.** Use `path` (which is OS‑aware), not `path.posix`. Forward and back slashes both work on Windows; `path.normalize` handles them.
2. **Case sensitivity.** macOS default (case‑insensitive) and Windows treat `Vault/notes` and `vault/notes` as the same path. `path.relative` does case‑insensitive comparison correctly on those platforms via the OS layer when both inputs go through `realpath`. But on Linux (case‑sensitive), `Vault` ≠ `vault`. We should not normalize case ourselves; instead, rely on `vault.adapter.getBasePath()` returning the canonical case.
3. **Drive letters and UNC paths (Windows).** `C:\foo`, `D:foo` (drive‑relative), `\\server\share\foo` are all "absolute" in different ways. `path.isAbsolute` handles drive letters and UNC; the regex above is belt‑and‑suspenders.
4. **Symlinks.** Inside the vault, `vault/link → /etc` would let an attacker read `/etc/passwd` via `read_file("link/passwd")`. Realpath the path before I/O and verify containment of the *resolved* path. For writes to new files, realpath the deepest existing ancestor (since the file itself doesn't yet exist).
5. **`..` traversal in the middle of a path.** `path.normalize` collapses `..` correctly. The `path.relative(root, resolved).startsWith("..")` check is the canonical containment test and correctly rejects paths that resolve outside root.
6. **Race conditions (TOCTOU).** Between checking and using the path, an attacker could swap a file for a symlink. For our threat model (the agent itself is the adversary, not a separate process), TOCTOU isn't realistic — the agent doesn't have shell access. Still, we can mitigate by using `O_NOFOLLOW` open flags where available, but that's `fs.open` complexity we don't need for v0.1.

**Use `vault.adapter.getBasePath()` (cast `vault.adapter as FileSystemAdapter`) as the root** — that's the canonical, real, normalized vault path. Don't try to derive it from anywhere else.

**Prefer the Vault TFile API where possible.** `vault.read(file: TFile)` doesn't accept arbitrary paths — it requires a `TFile` obtained via `vault.getAbstractFileByPath(relPath)`, which returns `null` for paths outside the vault metadata index. This is a *second line of defense*: even if our path validation has a bug, asking Obsidian to look up a path outside its vault returns null. Our flow:
1. Normalize + validate the path against `vault.adapter.getBasePath()`.
2. Look up the `TFile` via `vault.getAbstractFileByPath(normalizedRel)`.
3. If found, use Vault APIs (`vault.read`, `vault.modify`).
4. If not found and the operation is a create, use `vault.create(normalizedRel, content)` (which creates parent dirs and rejects out‑of‑vault paths internally).

### Confidence

**High** — this is mature, well‑documented territory. The risk is bugs in our own implementation, not unknowns about Node/Obsidian behavior.

### Implications for planning

**KNOWN:**
- One central path‑validation function used by every tool — no exceptions.
- Use `path.relative(root, resolved).startsWith("..")` containment check, after `path.resolve` normalization, after `realpath` of deepest existing ancestor.
- Use Vault TFile APIs for the actual I/O; treat them as a second line of defense.
- Reject explicit absolutes (`path.isAbsolute`), Windows drive letters, and UNC prefixes.
- Tests: feed adversarial paths (`..`, `../../etc/passwd`, `C:\Windows`, `\\?\`, `notes/../../escape`, `notes/symlink-to-etc/passwd`) into the validator and assert rejection.

### Open questions

None.

---

## Top Risks Surfaced

This section maps directly back to Spec §Risks & Mitigations.

| Spec Risk | Research outcome |
|---|---|
| **R‑1: Copilot SDK API may change.** | **Confirmed**, mitigation strategy stands: pin a specific SDK version, wrap behind one internal interface. The SDK is GA and follows semver, so churn is bounded. **Confidence raised**. |
| **R‑2: SDK may not run in Obsidian's Electron plugin sandbox.** | **🔴 Escalated to CRITICAL.** The SDK does not just make HTTP calls — it *spawns the `@github/copilot` CLI as a child subprocess via JSON‑RPC over stdio*. This works in principle (Obsidian plugins routinely use `child_process`), but the surface area for things to go wrong (Electron renderer subprocess wrapping, AV interference, the bundled CLI's own native deps) is much larger than a typical "import an SDK and call it" risk. **Mitigation tightened**: Phase 1 must be a *minimal subprocess‑smoke‑test* — `new CopilotClient(); await client.start(); await client.ping();` — before *any* UI work. If `start()` fails, abort and re‑plan. |
| **R‑3: `gh` CLI client ID may not return scopes for Models API.** | **Reframed.** The SDK doesn't use Models API, it uses Copilot. The remaining uncertainty is: which OAuth scopes does a Device Flow token need to authorize Copilot SDK access? Empirical answer required in Phase 1. **New sub‑risk**: reusing the `gh` CLI client ID is itself an Acceptable‑Use concern (impersonation in OAuth consent UI). Recommend registering a dedicated OAuth App from day one. |
| **R‑4: Vault writes during user's unsaved changes.** | **Mitigated by API choice.** `vault.modify(TFile, content)` participates in Obsidian's open‑editor conflict handling. Use Vault TFile APIs, not `vault.adapter.write` or raw `fs.writeFile`. |
| **R‑5: Path containment bugs.** | **Standard pattern available** (R7). Centralize in one validator, layer on top of Vault TFile lookup as a second line of defense, write adversarial unit tests. **Confidence raised; risk reduced to standard‑low if implemented carefully.** |
| **R‑6: Token storage in plain‑JSON `loadData`.** | **Confirmed; no better option practical for v0.1.** `safeStorage` not accessible from plugin renderer; `keytar` impractical for plugin distribution. Mitigations: (a) document the threat model in README, (b) add an opt‑in "do not persist token" mode (in‑memory only). |
| **R‑7: Streaming + tool‑call rendering complexity.** | **Mitigated by render model choice.** Store‑driven rendering with plain‑text streaming + final Markdown swap is the established pattern. Unbundle live‑Markdown re‑rendering to v0.2 if needed. |

### New risks discovered (not in Spec)

| New risk | Impact | Suggested mitigation |
|---|---|---|
| **Obsidian's bundled Node version may be below SDK floor (`^20.19.0 || >=22.12.0`).** | Critical — total blocker if true. | At plugin load, check `process.versions.node`; if too old, refuse to load with a clear error pointing to "Update Obsidian to ≥ 1.x.x" (set `manifest.minAppVersion` accordingly once we know the floor). |
| **The `@github/copilot` CLI dependency may include native modules / platform‑specific binaries.** | Medium — could complicate plugin distribution (single `main.js` model). | Inspect `node_modules/@github/copilot/` after install. If pure JS, no concern; if native, plan platform‑specific bundles or document a separate install step. |
| **AV / Defender / Gatekeeper may block Obsidian spawning the bundled CLI on first run.** | Medium — externally imposed; we can only document. | README "Troubleshooting" entry; consider a small "Verify SDK works" diagnostic command. |
| **Obsidian Sync excludes plugin `data.json` by default but third‑party syncs (iCloud, Dropbox) do not.** | Low‑medium — affects token confidentiality for sync users. | Disclosed in README per R5. |
| **Reusing the `gh` CLI's OAuth client ID is an impersonation risk per GitHub's Acceptable Use Policy.** | Medium — distribution/legal risk. | Register a dedicated OAuth App for the plugin before any non‑private distribution. The dev spike can use the `gh` ID for convenience but must switch before BRAT release. |
| **Built‑in Copilot CLI tools (shell, host filesystem read/write) are enabled by default.** | High security risk if not disabled. | Phase 1 must determine the option to disable all built‑ins (or override each by name). The agent should expose only our six vault‑scoped tools — nothing else. |

### Risks the research has retired or downgraded

- **Plugin scaffolding unknowns** — none. The Obsidian plugin API surface for our needs is well‑documented and stable.
- **Markdown rendering** — solved by `MarkdownRenderer.render`; performance is a UX choice (plain‑text during stream is fine).
- **Distribution** — BRAT covers v0.1 fully.

---

## Phase 1 spike checklist (recommended)

Before any UI work, validate in this order. If any step fails, stop and re‑plan.

1. `npm install @github/copilot-sdk` in a fresh Obsidian plugin shell.
2. Inspect `node_modules/@github/copilot/` for native modules.
3. Plugin loads in Obsidian: confirm `process.versions.node` ≥ `20.19.0`.
4. `new CopilotClient(); await client.start(); await client.ping();` — succeeds without spawn errors.
5. With a manually‑pasted `gho_` token (Device Flow comes later): `client.createSession({ model: "gpt-5", onPermissionRequest: approveAll })`, send "hello", receive a non‑empty `assistant.message`. Display via `new Notice(...)` per the Initial Prompt.
6. `client.listModels()` returns a non‑empty list.
7. Streaming events fire when `streaming: true`.
8. Determine option to disable built‑in tools.

Only if 1–8 pass, proceed to building Device Flow, the chat ItemView, the tool surface, and the safety policy.
