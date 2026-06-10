# obsidian-copilot-agent

An [Obsidian](https://obsidian.md) plugin that brings an in-vault AI agent powered by the [GitHub Copilot SDK](https://github.com/github/copilot-sdk).

> **Status:** v0.2 — Phase 1–7 complete. Working end-to-end on Windows desktop. Adds keyboard-first chat, vault-aware preamble, and Obsidian-API-backed note + task tools on top of the v0.1 spike. Not yet packaged for distribution.

## What's new in v0.2

- **Keyboard-first chat input** — Enter sends, Shift+Enter inserts a newline, IME composition is respected, empty input is rejected. While a response is streaming Enter is inert (Stop is the only cancel path).
- **Vault-aware preamble** — a deterministic system block prepended to the first send of each session: vault root path, timezone, today, and an inventory of the vault-aware tools (so the model picks them instead of `shell` for discovery). Includes an authoring-conventions block covering wikilinks, hash-prefixed tags, and Tasks-plugin checkbox syntax. Configurable via Settings → Copilot Agent → Vault Awareness (Default / Custom / None).
3. **Thirteen Obsidian-API-backed capabilities** registered alongside the v0.1 tools:
  - Read-only (auto-approved): `get_active_note`, `list_recent_notes`, `find_backlinks`, `vault_tree`, `vault_metadata`, `find_tasks`.
  - Mutating (one approval each, undoable): `create_note`, `edit_note`, `open_note`, `insert_into_active_note`, `create_daily_note`, `create_task`, `update_task`.
- **Task editing** — `find_tasks` enumerates checkbox tasks across the vault with filters (status, tag, due range, regex, single-file); `update_task` applies a structured patch (status, dates, priority, tags, description) to a single line with two-tier re-anchor (byte-exact `expectedRawLine` then `descriptionMatch`), idempotent status auto-stamping (✅/❌ today), and recurrence preservation.
- **Daily Notes + Tasks integration** — `create_daily_note` honors the Daily Notes core plugin's folder/format/template (falls back to `<vault-root>/YYYY-MM-DD.md` when disabled). `create_task` auto-detects Tasks-plugin presence and emits the matching flavor (📅/✅ vs `(due: …)`/`(completed: …)`).
- **Privacy default**: the preamble sends only vault root path + timezone + today + tool inventory + authoring conventions. NO folder or file enumeration, NO note contents, NO recent-activity metadata, NO per-file timestamps. Folder/file structure is fetched on demand via the read-only `vault_tree` / `vault_metadata` tools, which are auto-approved but explicit. Switch Vault Awareness to **None** in Settings to suppress the preamble entirely for the most sensitive vaults.

## What works in v0.1

- **OAuth Device Flow sign-in** via the GitHub CLI client ID (private-developer convenience; see [OAuth client ID](#oauth-client-id)). Token optionally persisted to plugin data.
- **Streaming chat** with the Copilot SDK, including Stop-to-cancel mid-stream.
- **Vault read tools** — the agent can `read_file`, `list_files`, `search_content` over the active vault without prompting (scope-locked, side-effect-free; see [Read-tool exemption](#read-tool-exemption)).
- **Vault write tools** — `create_file`, `edit_file`, `delete_file`, plus the SDK's built-in `shell` / `write` / `view` etc., all routed through a single per-call **approval gate** (deny-by-default for everything that mutates state).
- **Undo** for any applied vault write within the active session.
- **Safety policy** with three modes (require-approval / auto-apply-with-undo / allowlist) plus persistent trust scopes (path allowlist, per-built-in toggles).

## What is intentionally NOT in v0.2

Workflow B (tracked as deferred candidates in `.paw/work/copilot-sdk-spike/ImplementationPlan.md`): extra-vault filesystem roots, MCP integration, model selection / cross-restart resume, secure-storage upgrade for tokens (Electron `safeStorage`), multi-conversation support, cross-restart Undo, no-tools chat-only mode, MCP credential UI, user-authored custom tools, headless integration tests, Periodic Notes plugin integration, recurring-task auto-rolling on completion.

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

166 v0.1 tests retained and unchanged; v0.2 brings the total to **401** across domain (SafetyPolicy, UndoJournal, VaultPath, ChatState, PreambleAssembler), tools (ReadTools, WriteTools, ReadNoteTools, WriteNoteTools, ObsidianApi, TaskFormat, FindTasks, UpdateTask, DailyNotePath), UI (chatKeydown), auth, and the SDK adapter (AgentSession).

## Reference

The community plugin [`logancyang/obsidian-copilot`](https://github.com/logancyang/obsidian-copilot) (AGPL-3.0) is used as a structural reference for Obsidian plugin chat UIs. No code is copied.

## License

TBD.
