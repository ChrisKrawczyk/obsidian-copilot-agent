# obsidian-copilot-agent

An [Obsidian](https://obsidian.md) plugin that brings an in-vault AI agent powered by the [GitHub Copilot SDK](https://github.com/github/copilot-sdk).

> **Status:** v0.9 — Adds an inline readiness indicator on the chat composer and automatic tool refresh when slow-authenticating MCP servers connect after the composer is already open. Builds on v0.8's importable preset packs, v0.7's authenticated MCP servers, v0.6's BRAT install + in-plugin Copilot CLI binary fetcher, v0.5's MCP client support, v0.4's per-conversation model picker, v0.3's multi-conversation persistence, and v0.2's vault-aware tools. Working end-to-end on Windows desktop; macOS/Linux ship as **alpha — please report issues**.

## What's new in v0.9

- **Readiness indicator on the chat composer.** When a new chat is
  waiting on MCP servers to come online (device-flow login, cloud CLI
  refresh, cold-start startup, etc.), the composer now shows an inline
  pill naming what it is waiting for. Fast-path guarded — if servers
  reach a terminal state within 200 ms the pill never appears.
  Announced via `aria-live` so screen readers pick up the state.
- **Automatic tool refresh after slow-auth connects.** Servers that
  authenticate after the composer has already opened — including cases
  where an access token expires mid-session and the server reconnects —
  now inject their tools into the live chat session automatically. A
  single "MCP tools refreshed" Notice confirms the pickup. **No more
  reloading Obsidian to recover from token expiry.**
- **Preserves conversation state.** The refresh uses the Copilot SDK's
  `client.resumeSession(sessionId, …)` primitive to swap the session in
  place, keeping server-side conversation history intact. Permission
  routing to the plugin's decider is preserved across the swap.
- **Forward-looking work.** A cleaner refresh path is proposed upstream
  at [github/copilot-sdk#1896](https://github.com/github/copilot-sdk/issues/1896)
  (re-triage of the previously-closed #735). When it lands, the plugin
  will bump the SDK and drop the session-swap fallback. The user-visible
  behavior is unchanged either way.

## What's new in v0.8

- **Importable preset packs.** Settings → MCP Servers → **Imported preset packs** → **Import pack from file…** picks a `.json` pack file and adds its presets to the Add Server dropdown under a per-pack group. Built-in presets always sort first. Import is inert: no process is spawned, no network call is made.
- **Re-import diff and remove.** Re-importing the same pack file shows a structural diff before applying. Removing a pack never touches MCP servers you already configured from it.
- **Export servers as pack.** A new **Export servers as pack…** button in the MCP Servers header writes a JSON pack into `<vault>/exported-packs/` with every secret replaced by the literal placeholder `__NEEDS_VALUE__`. Re-importing the file surfaces the required fields in the Add Server form before Save is allowed.
- **Grouped Add Server dropdown.** The preset dropdown is now grouped (built-in first, then one optgroup per imported pack). Collisions between pack ids are resolved with `<packId>.<presetId>` namespacing per FR-013.
- **Authoring and review aids.** v0.8 also includes JSON Schema editor assistance, per-row **Export this server as pack…**, and field-level re-import diff annotations; see [`docs/preset-packs.md`](docs/preset-packs.md). Technical notes: [`.paw/work/preset-packs/Docs.md`](.paw/work/preset-packs/Docs.md). Smoke checklist: [`.paw/work/preset-packs/SmokeChecklist.md`](.paw/work/preset-packs/SmokeChecklist.md).

## What's new in v0.7

- **Authenticated MCP servers.** HTTP MCP servers can now carry credentials that the plugin resolves and refreshes per request. Three credential variants are supported: `none`, `static-bearer` (token stored in plaintext, like v0.5/v0.6), and `command-based` (token resolved by spawning a command, never persisted). A fourth `oauth-pkce` shape is reserved in the schema and round-trips losslessly for forward compatibility.
- **Microsoft 365 Graph preset (via Azure CLI).** Settings → MCP Servers → Add → preset dropdown ships **Microsoft 365 Graph (via Azure CLI)**. Selecting it pre-fills the entire form; with `az login` complete, **Test connection** succeeds and identity-level Graph tools become available in chat. Full walkthrough in [`docs/m365-graph-mcp.md`](docs/m365-graph-mcp.md).
- **One-shot 401 retry with cache invalidation.** A 401 from a credential-bearing request invalidates the in-memory token cache for that server and retries the call exactly once. No chat-visible reconnect for normal expiry boundaries.
- **Inline preflight install hint.** Selecting a preset whose command is not on PATH surfaces an inline install hint in the form, before Save. Hints are non-blocking — Save always proceeds.
- **No new persistence risk for command-based credentials.** Resolved tokens live in memory only; never written to `data.json`, never logged, never appear in Notices or error messages.

### Scope reality for the M365 Graph preset

The shipped M365 Graph preset uses the Azure CLI token path. The MCP service performs OBO to Microsoft Graph using its own app registration's delegated permissions — which in practice unlocks identity / profile queries reliably but typically returns **403 Forbidden** for calendar, mail, files, and Teams. See [`docs/m365-graph-mcp.md`](docs/m365-graph-mcp.md) § "Permission scopes and 403 errors" for the architectural explanation. The forward path is tracked in [`proposals/0006`](proposals/0006-tool-picker-and-scope-aware-credentials.md) (scope-aware tool picker via `oauth-pkce`) and [`proposals/0007`](proposals/0007-importable-preset-packs.md) (importable preset packs so per-product Graph MCPs can be added via packs distributed outside this repo).

For the technical reference, see [`.paw/work/authenticated-mcps/Docs.md`](.paw/work/authenticated-mcps/Docs.md). For the smoke checklist, see [`.paw/work/authenticated-mcps/SmokeChecklist.md`](.paw/work/authenticated-mcps/SmokeChecklist.md).

## What's new in v0.5

- **MCP client support.** Configure external Model Context Protocol (MCP) servers in Settings → Copilot Agent → MCP Servers. The plugin acts as an MCP client and can connect to stdio or Streamable HTTP servers.
- **MCP tools in chat.** Connected MCP tools appear alongside built-in tools with `(MCP / <server name>)` attribution and always pass through the approval gate unless you explicitly approve that exact server/tool identity for the current trust epoch.
- **Transport safety.** stdio servers launch without shell interpolation and filtered env; Streamable HTTP requires TLS for non-loopback hosts, rejects cloud metadata targets, drops `Authorization` on cross-origin redirects, and does not fall back to legacy HTTP+SSE-only servers.
- **No Undo for MCP calls.** MCP calls may affect external systems, so they intentionally do not get an Undo button. Vault Undo for built-in vault write tools is unchanged.

## MCP server setup (v0.5)

MCP is a protocol for exposing external tools to AI clients; obsidian-copilot-agent is an MCP **client**.

### stdio server setup

Add a stdio server in Settings → Copilot Agent → MCP Servers. Absolute command paths always work. On macOS the plugin prepends `/usr/local/bin` and `/opt/homebrew/bin` to `PATH` for common Homebrew/npm shims. On Windows, prefer the explicit `cmd /c npx ...` form because `npx` resolution differs from Unix shells.

Example using the official filesystem server:

```json
{
  "id": "local-filesystem",
  "name": "Local filesystem",
  "transport": "stdio",
  "command": "cmd",
  "args": ["/c", "npx", "-y", "@modelcontextprotocol/server-filesystem", "C:\\Users\\you\\Documents"]
}
```

### Streamable HTTP server setup

Streamable HTTP servers must use an HTTPS URL unless they are loopback-local. You may provide a static `Authorization` header; it is stored in plaintext in Obsidian plugin data, so avoid synced vaults for sensitive credentials.

```json
{
  "id": "team-tools",
  "name": "Team tools",
  "transport": "http",
  "url": "https://mcp.example.org/mcp",
  "authorization": "Bearer <token>"
}
```

Legacy HTTP+SSE-only servers are not supported and there is no fallback path. Private-network URLs such as `192.168.*`, `10.*`, and `172.16.*`-`172.31.*` require a confirmation modal before saving. Cloud metadata IPs are rejected outright.

Security posture: MCP server `instructions` and tool descriptions are **untrusted prompt-injection surfaces**. Review the requested tool name and arguments before approving any MCP tool call.

For the full technical reference, see [`.paw\work\mcp-client\Docs.md`](.paw/work/mcp-client/Docs.md).

## What's new in v0.6

- **First BRAT-installable release.** No more manual `npm run deploy` for end users. Install via BRAT (`README.md → Install via BRAT`); the plugin fetches its platform-specific Copilot CLI binary from `registry.npmjs.org` on first launch with sha512 verification.
- **In-plugin binary fetcher** with a progress Notice, atomic-rename on completion, version marker for cache-hit short-circuit on subsequent launches, and a Settings → CLI binary section with **Retry** for failure recovery without a plugin reload. Supports 8 platform tuples (Windows x64/arm64, macOS x64/arm64, Linux glibc/musl x64/arm64); Windows is supported, macOS/Linux ship as alpha.
- **In-repo release tooling.** `scripts/version-bump.mjs` mutates `package.json`, `manifest.json`, `versions.json`, and stubs a `CHANGELOG.md` section atomically. `.github/workflows/release.yml` (SHA-pinned actions, tag-triggered) builds and publishes the three release assets. The Copilot CLI release agent at `.copilot/agents/release/` orchestrates the end-to-end flow — see [`RELEASING.md`](RELEASING.md).
- **No runtime behavior changes.** Chat, model picker, MCP, safety, Undo, tools all behave exactly as v0.5. The fetcher's `isInstalled` short-circuit means existing developers with `copilot.exe` already deployed (`npm run deploy --with-binary`) see no Notice and no download.

For the technical reference, see [`.paw/work/packaging-release/Docs.md`](.paw/work/packaging-release/Docs.md).

## What's new in v0.4

- **Per-conversation model picker** in the chat header. Pick from any chat-capable Copilot model your account can reach; each conversation remembers its own selection. Switching conversations updates the picker label automatically. The picker uses Obsidian's standard menu so it inherits keyboard accessibility.
- **Settings → Default model** for newly created conversations. The list mirrors the chat-header picker. If your configured default isn't in the catalog at create time, the plugin falls back to a heuristic and surfaces a one-shot Notice.
- **Mid-conversation model swap with history preserved.** Picking a different model swaps it on the underlying SDK session in-place. Conversations with at least one completed assistant turn show a confirmation dialog ("history is preserved; pending tool approvals will be cancelled. Continue?"). Identity and brand-new-conversation swaps skip the dialog.
- **Recovery without plugin reload.** If the model list can't be fetched on startup you see an inline banner with a **Retry** button — no plugin reload required. Empty-account ("No chat models available") and stale-id ("`<id>` (unavailable)") states are visually distinct. The AgentSession defers `createSession()` until the catalog reaches `ready`, so Retry or token rotation drives in-place recovery.
- **Lazy resolution for v0.3 conversations.** On first activation in v0.4, a v0.3 conversation resolves a model (configured default → heuristic) and persists the binding.
- **Single-source send gate.** Send button, Enter key, and the inline banner all consume one `canSend()` result so the same reason text appears in the same precedence order across surfaces.

## What is intentionally NOT in v0.4

Embedding/vector models, model-side capability filtering beyond `policy.state === "disabled"`, per-conversation safety overrides, mid-conversation token-budget tracking, archived-conversation restore UI, and anything from the v0.3 "intentionally NOT" list that is not called out above as v0.4 work.

## What's new in v0.3

- **Multi-conversation chat.** A conversation picker at the top of the chat pane (current name + caret). Create, switch, rename, and delete conversations from the dropdown. Up to 20 active conversations; the 21st auto-archives the oldest non-active one (a one-time Notice tells you which). New conversations get a `Untitled YYYY-MM-DD HH:MM` placeholder name and auto-rename from the first non-empty line of your first message (≤ 40 chars). A manual rename always wins over the auto-name.
- **Cross-restart persistence.** The conversation list, per-conversation message history, and per-conversation undo journals survive plugin reload, Obsidian restart, and OS reboot. Writes are debounced (≤1 per 500 ms) plus an immediate flush on Obsidian's `quit` event so OS-level shutdown still persists everything. The previously active conversation re-hydrates on plugin load and the model name reappears in the header status pill.
- **Cross-restart Undo with divergence prompt.** Undo entries persist alongside their conversation (50 most recent per conversation, 7-day TTL). After a restart, the Undo button on a tool-call block still works. If the file has been modified, deleted, or recreated outside the agent since the recorded snapshot, an overlay describes the divergence and you can choose **Cancel** or **Revert anyway** (force the revert). Once dismissed, the Undo flips to a "reverted" pill that survives a fast restart (immediate flush on `markUndone`).
- **Vault-first nudge with raw-FS fallback.** A new safety toggle "Expose v0.1 raw-filesystem tools" defaults **ON**. The six v0.1 raw-FS tools (`view`, `read_file`, `search_content`, `create_file`, `edit_file`, `delete_file`) remain registered as a defensive fallback while the preamble's tool inventory marks them as `(fallback)` and instructs the model to reach for the vault-aware tools first. Users who want a strictly vault-only surface can toggle the setting OFF; the change takes effect on the next plugin reload (next session start). While OFF, the raw-FS tools are not registered with the SDK and are absent from the preamble's tool inventory; historical raw-FS tool-call blocks still render their name + result, but the Undo button is suppressed.
- **Three new auto-approved search tools** — `search_by_tag`, `search_by_name`, `list_all_tags`. All read-only, vault-scoped, and backed by Obsidian's `MetadataCache`.
- **Corruption recovery.** If `data.json` becomes unreadable, the plugin preserves the malformed blob at `<plugin-dir>/conversations_recovery.bak.json`, surfaces a Notice naming the sidecar, and starts from defaults. Auth and safety settings survive recovery so you don't have to reconnect.
- **5 MB size warning.** A one-time Notice fires when `data.json` crosses 5 MB. Address it by deleting unused conversations.

## What is intentionally NOT in v0.3

MCP integration, extra-vault filesystem roots, mid-session settings reload, tag rename/create, per-vault Daily Notes target override, showing or restoring archived conversations from the picker, conversation export/import, sharing conversations across vaults or syncing through Obsidian Sync, search-by-content fuzzy matching, and cross-conversation tool-call inspection. See `.paw/work/multi-conversation-persistence/Docs.md` § "What is NOT in v0.3" for the full enumeration and `.paw/work/multi-conversation-persistence/ImplementationPlan.md` for deferred candidates.

## What's new in v0.2

- **Keyboard-first chat input** — Enter sends, Shift+Enter inserts a newline, IME composition is respected, empty input is rejected. While a response is streaming Enter is inert (Stop is the only cancel path).
- **Vault-aware preamble** — a deterministic system block prepended to the first send of each session: vault root path, timezone, today, and an inventory of the vault-aware tools (so the model picks them instead of `shell` for discovery). Includes an authoring-conventions block covering wikilinks, hash-prefixed tags, and Tasks-plugin checkbox syntax. Configurable via Settings → Copilot Agent → Vault Awareness (Default / Custom / None).
3. **Thirteen Obsidian-API-backed capabilities** registered alongside the v0.1 tools:
  - Read-only (auto-approved): `get_active_note`, `list_recent_notes`, `find_backlinks`, `vault_tree`, `vault_metadata`, `find_tasks`, plus `open_note` (navigation only).
  - Mutating (one approval each, undoable): `create_note`, `edit_note`, `insert_into_active_note`, `create_daily_note`, `create_task`, `update_task`.
- **Task editing** — `find_tasks` enumerates checkbox tasks across the vault with filters (status, tag, due range, regex, single-file); `update_task` applies a structured patch (status, dates, priority, tags, description) to a single line with two-tier re-anchor (byte-exact `expectedRawLine` then `descriptionMatch`), idempotent status auto-stamping (✅/❌ today), and recurrence preservation.
- **Daily Notes + Tasks integration** — `create_daily_note` honors the Daily Notes core plugin's folder/format/template (falls back to `<vault-root>/YYYY-MM-DD.md` when disabled). `create_task` auto-detects Tasks-plugin presence and emits the matching flavor (📅/✅ vs `(due: …)`/`(completed: …)`).
- **Privacy default**: the preamble sends only vault root path + timezone + today + tool inventory + authoring conventions. NO folder or file enumeration, NO note contents, NO recent-activity metadata, NO per-file timestamps. Folder/file structure is fetched on demand via the read-only `vault_tree` / `vault_metadata` tools, which are auto-approved but explicit. Switch Vault Awareness to **None** in Settings to suppress the preamble entirely for the most sensitive vaults.

## What works in v0.1

- **OAuth Device Flow sign-in** via the GitHub CLI client ID (private-developer convenience; see [OAuth client ID](#oauth-client-id)). Token optionally persisted to plugin data.
- **Streaming chat** with the Copilot SDK, including Stop-to-cancel mid-stream.
- **Vault read tools** — the agent can `view`, `read_file`, `search_content` over the active vault without prompting (scope-locked, side-effect-free; see [Read-tool exemption](#read-tool-exemption)).
- **Vault write tools** — `create_file`, `edit_file`, `delete_file`, plus the SDK's built-in `shell` / `write` / `view` etc., all routed through a single per-call **approval gate** (deny-by-default for everything that mutates state).
- **Undo** for any applied vault write within the active session.
- **Safety policy** with three modes (require-approval / auto-apply-with-undo / allowlist) plus persistent trust scopes (path allowlist, per-built-in toggles).

## What is intentionally NOT in v0.2

Workflow B (tracked as deferred candidates in `.paw/work/copilot-sdk-spike/ImplementationPlan.md`): extra-vault filesystem roots, MCP integration, model selection / cross-restart resume, secure-storage upgrade for tokens (Electron `safeStorage`), multi-conversation support, cross-restart Undo, no-tools chat-only mode, MCP credential UI, user-authored custom tools, headless integration tests, Periodic Notes plugin integration, recurring-task auto-rolling on completion.

## Install via BRAT

This plugin is in beta and distributed via [BRAT (Beta Reviewers Auto-update Tool)](https://github.com/TfTHacker/obsidian42-brat) — not (yet) the official Community Plugins catalog. `v0.6.0` is the first BRAT-installable release.

1. In Obsidian → **Settings → Community plugins**, install and enable **BRAT** from the catalog.
2. Open the command palette and run **BRAT: Add a beta plugin for testing**.
3. Paste `ChrisKrawczyk/obsidian-copilot-agent` and confirm.
4. Once BRAT finishes, go to **Settings → Community plugins** and enable **Copilot Agent**.

### First launch

On the first enable, the plugin fetches the platform-specific Copilot CLI binary from the npm registry (~150 MB, one time). You will see a "Downloading Copilot CLI binary…" Notice with a byte/percent progress indicator. After the download completes, click **Connect** in **Settings → Copilot Agent** to run the GitHub OAuth device-flow sign-in. Subsequent launches reuse the cached binary and do not re-download.

If the download fails (offline, blocked corporate proxy, etc.) you can retry from **Settings → Copilot Agent → CLI binary → Retry** without reloading the plugin.

### Supported platforms

| Platform           | Architectures | Status |
| ------------------ | ------------- | ------ |
| Windows            | x64, arm64    | supported (manual smoke tested) |
| macOS              | x64, arm64    | alpha — please report issues |
| Linux (glibc)      | x64, arm64    | alpha — please report issues |
| Linux (musl)       | x64, arm64    | alpha — please report issues |

Platform detection logic is unit-tested for every tuple, but manual end-to-end smoke testing for v0.6.0 is Windows-only. Issues from other platforms are tracked in [GitHub Issues](https://github.com/ChrisKrawczyk/obsidian-copilot-agent/issues).

### Known limitations

- **Desktop only.** The Copilot CLI binary is a native single-executable application and cannot run inside the Obsidian mobile sandbox.
- **Requires `registry.npmjs.org` reachable** on first launch. Corporate proxies that block the npm registry will surface an actionable error in the Settings → CLI binary section; the binary cannot be sideloaded through this UI in v0.6.0.
- **OS may flag the downloaded binary on first run.** Windows SmartScreen, macOS Gatekeeper, or Linux equivalents may prompt because the upstream `@github/copilot` SEA is not yet code-signed by GitHub. This is upstream behavior; the binary is verified by sha512 against the npm registry's published metadata before it is moved into the plugin folder.

## Local development setup

1. **Install dependencies**: `npm install`
2. **Build**: `npm run build` produces `main.js`.
3. **Install into a vault**:
   - Create `<vault>/.obsidian/plugins/obsidian-copilot-agent/`.
   - Copy `main.js`, `manifest.json`, and `styles.css` into that folder.
   - Copy the platform Copilot CLI binary into the same folder:
     - Windows: `node_modules/@github/copilot-win32-x64/copilot.exe`
     - macOS: `node_modules/@github/copilot-darwin-{arm64,x64}/copilot`
     - Linux: `node_modules/@github/copilot-linux-{arm64,x64}/copilot`
   - In Obsidian → Settings → Community plugins, enable "Copilot Agent".
   - **Tip:** after first install, create a `.deploy-target` file at the
     repo root with the absolute path to that plugin folder (one line,
     gitignored) and use `npm run deploy` to redeploy `main.js`,
     `manifest.json`, and `styles.css` after each build. Use
     `npm run deploy -- --with-binary` to also re-copy the CLI binary
     when `@github/copilot-sdk` is upgraded.
4. **Sign in**: open Settings → Copilot Agent → click **Connect**. A modal shows the GitHub URL + a one-time code. Authorise the request and the chat view becomes usable.
5. **Use it**: click the bot ribbon icon (left sidebar) to open the chat panel.
   - Ask the agent to read or search the vault (no prompt — read tools are exempt; see below).
   - Ask the agent to create / edit / delete a note. The **default safety mode is "require approval"**: an inline Approve / Approve-for-Session / Reject prompt appears in the chat for every write (and every built-in `shell` / `web_fetch` / etc.) before the call runs. Switch the default in Settings → Copilot Agent → Safety if you prefer auto-apply-with-undo.

## Safety model

The plugin enforces a single deny-by-default permission gate that every mutating tool call flows through:

- **Custom write tools** (`create_file`, `edit_file`, `delete_file`) → SafetyPolicy.
- **SDK built-ins** (`shell`, `write`, `view`, `web_fetch`, `memory`, etc.) → SafetyPolicy.
- **MCP tool calls** → SafetyPolicy.

SafetyPolicy decides among `auto-apply` (no prompt), `require-approval` (chat-inline Approve/Reject), or `reject`, based on:

1. The configured default mode (v0.1 default: `require-approval`).
2. Per-call session grants ("Approve for session" on a prompt).
3. Persistent settings — path allowlist (vault-relative directories that skip the prompt) and per-built-in auto-approve toggles.

After any approved built-in vault write, an **Undo** affordance appears on the tool-call block and reverses the change. MCP calls intentionally have no Undo because they may affect external systems outside the vault.

### Read-tool exemption

`view`, `read_file`, and `search_content` register with `skipPermission: true` and bypass the prompt. They are strictly read-only, vault-scoped, and use [`VaultPath`](src/tools/VaultPath.ts) to reject absolute paths, `..`, and symlink-escape. The "deny-by-default" invariant continues to apply to every mutating call. See the JSDoc at the top of `src/tools/ReadTools.ts` for the checklist future tool authors must satisfy before reusing this exemption.

## Token persistence (security note)

By default the OAuth token is saved to this vault's plugin-data file so you don't have to reconnect each Obsidian restart. The token is stored **as plaintext** — vault folders are often synced (iCloud, OneDrive, Obsidian Sync, etc.) and anyone with file access can read it. If that posture isn't acceptable, toggle **Save token between sessions** OFF in settings; you'll re-authenticate every restart, and the on-disk token is wiped immediately when you turn the toggle off.

## OAuth client ID

For the v0.1 spike we reuse the `gh` CLI's public client ID (`178c6fc778ccc68e1d6a`). Consequences:

- The GitHub consent screen reads "GitHub CLI" rather than this plugin's name.
- Revoking the OAuth grant from your GitHub account settings also revokes `gh`'s grant on the same machine.

Before any non-private distribution we register a dedicated OAuth App (tracked as a deferred Phase Candidate).

## Why a separate CLI binary?

The Copilot SDK delegates model and tool execution to the `@github/copilot` CLI runtime. Obsidian.exe ships with the `ELECTRON_RUN_AS_NODE` Electron fuse disabled for security, so we can't reuse it as the Node interpreter. Instead we ship the platform-specific single-executable application (SEA) the npm package provides.

As of v0.6, the binary is **not vendored in the GitHub Release** — the plugin fetches it on first launch from `registry.npmjs.org`, verifies the sha512 against the registry's published metadata, and extracts only the platform-specific binary file (no JavaScript from the package is executed). Subsequent launches reuse the cached binary via a `.copilot-binary-version` marker file. The pinned version is baked at build time from `@github/copilot-sdk`'s transitive `@github/copilot` dependency. See [`.paw/work/packaging-release/Docs.md`](.paw/work/packaging-release/Docs.md) for the full trust chain.

## Tests

```
npm test          # Vitest (domain + adapter)
npm run typecheck # tsc --noEmit
npm run build     # production esbuild
```

166 v0.1 tests retained and unchanged; v0.2 added 235 (total 401); v0.3 brought the total to 609; v0.4 brought it to 728; v0.5 brought it to 944; v0.6 brings it to **1107** with binary-fetcher platform detection, version-bump tooling, release-assets validators, bootstrap helpers, and CLI script harnesses.

## Releasing

Cutting a release is documented in [`RELEASING.md`](RELEASING.md). Quick start: ask the Copilot CLI release agent (at [`.copilot/agents/release/`](.copilot/agents/release/)) "release v\<version\>" — the agent walks preflight → version-bump → CHANGELOG draft → tag-and-push → CI monitor → verify. Manual CLI fallback documented alongside.

## Reference

The community plugin [`logancyang/obsidian-copilot`](https://github.com/logancyang/obsidian-copilot) (AGPL-3.0) is used as a structural reference for Obsidian plugin chat UIs. No code is copied.

## License

TBD.
