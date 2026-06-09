# obsidian-copilot-agent

An [Obsidian](https://obsidian.md) plugin that brings an in-vault AI agent powered by the [GitHub Copilot SDK](https://github.com/github/copilot-sdk).

> **Status:** v0.1 private spike — Phases 1–6 complete. Working end-to-end on Windows desktop for a single-user, single-vault workflow. Not yet packaged for distribution.

## What works in v0.1

- **OAuth Device Flow sign-in** via the GitHub CLI client ID (private-developer convenience; see [OAuth client ID](#oauth-client-id)). Token optionally persisted to plugin data.
- **Streaming chat** with the Copilot SDK, including Stop-to-cancel mid-stream.
- **Vault read tools** — the agent can `read_file`, `list_files`, `search_content` over the active vault without prompting (scope-locked, side-effect-free; see [Read-tool exemption](#read-tool-exemption)).
- **Vault write tools** — `create_file`, `edit_file`, `delete_file`, plus the SDK's built-in `shell` / `write` / `view` etc., all routed through a single per-call **approval gate** (deny-by-default for everything that mutates state).
- **Undo** for any applied vault write within the active session.
- **Safety policy** with three modes (require-approval / auto-apply-with-undo / allowlist) plus persistent trust scopes (path allowlist, per-built-in toggles).

## What is intentionally NOT in v0.1

Tracked as `[deferred]` candidates in `.paw/work/copilot-sdk-spike/ImplementationPlan.md`: dedicated OAuth App + Electron `safeStorage` for tokens, embeddings-based retrieval, multi-conversation support, cross-restart Undo, MCP server credential UI, custom user-authored tools, extra-vault roots, cross-restart `resumeSession`, headless integration tests.

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
4. **Sign in**: open Settings → Copilot Agent → click **Connect**. A modal shows the GitHub URL + a one-time code. Authorise the request and the chat view becomes usable.
5. **Use it**: click the bot ribbon icon (left sidebar) to open the chat panel.
   - Ask the agent to read or search the vault (no prompt — read tools are exempt; see below).
   - Ask the agent to create / edit / delete a note. The **default safety mode is "require approval"**: an inline Approve / Approve-for-Session / Reject prompt appears in the chat for every write (and every built-in `shell` / `web_fetch` / etc.) before the call runs. Switch the default in Settings → Copilot Agent → Safety if you prefer auto-apply-with-undo.

## Safety model

The plugin enforces a single deny-by-default permission gate that every mutating tool call flows through:

- **Custom write tools** (`create_file`, `edit_file`, `delete_file`) → SafetyPolicy.
- **SDK built-ins** (`shell`, `write`, `view`, `web_fetch`, `memory`, etc.) → SafetyPolicy.
- **MCP tool calls** (when MCP is wired in a later phase) → SafetyPolicy.

SafetyPolicy decides among `auto-apply` (no prompt), `require-approval` (chat-inline Approve/Reject), or `reject`, based on:

1. The configured default mode (v0.1 default: `require-approval`).
2. Per-call session grants ("Approve for session" on a prompt).
3. Persistent settings — path allowlist (vault-relative directories that skip the prompt) and per-built-in auto-approve toggles.

After any approved write, an **Undo** affordance appears on the tool-call block and reverses the change (in-session only).

### Read-tool exemption

`read_file`, `list_files`, and `search_content` register with `skipPermission: true` and bypass the prompt. They are strictly read-only, vault-scoped, and use [`VaultPath`](src/domain/VaultPath.ts) to reject absolute paths, `..`, and symlink-escape. The "deny-by-default" invariant continues to apply to every mutating call. See the JSDoc at the top of `src/tools/ReadTools.ts` for the checklist future tool authors must satisfy before reusing this exemption.

## Token persistence (security note)

By default the OAuth token is saved to this vault's plugin-data file so you don't have to reconnect each Obsidian restart. The token is stored **as plaintext** — vault folders are often synced (iCloud, OneDrive, Obsidian Sync, etc.) and anyone with file access can read it. If that posture isn't acceptable, toggle **Save token between sessions** OFF in settings; you'll re-authenticate every restart, and the on-disk token is wiped immediately when you turn the toggle off.

## OAuth client ID

For the v0.1 spike we reuse the `gh` CLI's public client ID (`178c6fc778ccc68e1d6a`). Consequences:

- The GitHub consent screen reads "GitHub CLI" rather than this plugin's name.
- Revoking the OAuth grant from your GitHub account settings also revokes `gh`'s grant on the same machine.

Before any non-private distribution we register a dedicated OAuth App (tracked as a deferred Phase Candidate).

## Why a separate CLI binary?

The Copilot SDK delegates model and tool execution to the `@github/copilot` CLI runtime. Obsidian.exe ships with the `ELECTRON_RUN_AS_NODE` Electron fuse disabled for security, so we can't reuse it as the Node interpreter. Instead we ship the platform-specific single-executable application (SEA) the npm package provides.

## Tests

```
npm test          # Vitest (domain + adapter)
npm run typecheck # tsc --noEmit
npm run build     # production esbuild
```

166 tests across domain (SafetyPolicy, UndoJournal, VaultPath, ChatState), tools (ReadTools, WriteTools, ScopeRegistry indirect), and the SDK adapter (AgentSession).

## Reference

The community plugin [`logancyang/obsidian-copilot`](https://github.com/logancyang/obsidian-copilot) (AGPL-3.0) is used as a structural reference for Obsidian plugin chat UIs. No code is copied.

## License

TBD.
