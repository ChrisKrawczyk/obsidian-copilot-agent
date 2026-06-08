# obsidian-copilot-agent

An [Obsidian](https://obsidian.md) plugin that brings an in-vault AI agent powered by the [GitHub Copilot SDK](https://github.com/github/copilot-sdk).

> **Status:** Phase 3 (Device Flow OAuth + token persistence). Working but rough.

## Goals

- Use a GitHub Copilot subscription (personal or enterprise) as the model backend — no separate API keys.
- Read **and write** notes in your vault directly from the chat interface (the existing community Copilot plugin is read-only on the free tier).
- Skip embeddings on day one; rely on the agent's tool-using ability to grep/read the vault.
- Desktop-only (Obsidian mobile lacks the Node runtime the SDK requires).

## Local development setup (Phase 3)

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
5. **Use it**: click the bot ribbon icon (left sidebar) to open the chat panel. Phase 2/3 denies every tool call at the universal-approval-gate; only freeform model responses succeed.

### Token persistence (security note)

By default the OAuth token is saved to this vault's plugin-data file so you don't have to reconnect each Obsidian restart. The token is stored **as plaintext** — vault folders are often synced (iCloud, OneDrive, Obsidian Sync, etc.) and anyone with file access can read it. If that posture isn't acceptable, toggle **Save token between sessions** OFF in settings; you'll re-authenticate every restart, and the on-disk token is wiped immediately when you turn the toggle off.

### OAuth client ID

For the v0.1 spike we reuse the `gh` CLI's public client ID (`178c6fc778ccc68e1d6a`). Consequences:

- The GitHub consent screen reads "GitHub CLI" rather than this plugin's name.
- Revoking the OAuth grant from your GitHub account settings also revokes `gh`'s grant on the same machine.

Before any wider distribution we register a dedicated OAuth app.

### Why a separate CLI binary?

The Copilot SDK delegates model and tool execution to the `@github/copilot` CLI runtime. Obsidian.exe ships with the `ELECTRON_RUN_AS_NODE` Electron fuse disabled for security, so we can't reuse it as the Node interpreter. Instead we ship the platform-specific single-executable application (SEA) the npm package provides.

## Tests

```
npm test          # Vitest (domain + adapter)
npm run typecheck # tsc --noEmit
npm run build     # production esbuild
```

## Reference

The community plugin [`logancyang/obsidian-copilot`](https://github.com/logancyang/obsidian-copilot) (AGPL-3.0) is used as a structural reference for Obsidian plugin chat UIs. No code is copied.

## License

TBD.
