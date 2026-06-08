# obsidian-copilot-agent

An [Obsidian](https://obsidian.md) plugin that brings an in-vault AI agent powered by the [GitHub Copilot SDK](https://github.com/github/copilot-sdk).

> **Status:** Phase 2 (chat shell + permission gate). Working but rough.

## Goals

- Use a GitHub Copilot subscription (personal or enterprise) as the model backend — no separate API keys.
- Read **and write** notes in your vault directly from the chat interface (the existing community Copilot plugin is read-only on the free tier).
- Skip embeddings on day one; rely on the agent's tool-using ability to grep/read the vault.
- Desktop-only (Obsidian mobile lacks the Node runtime the SDK requires).

## Local development setup (Phase 2)

1. **Install dependencies**: `npm install`
2. **Set the dev token** in `src/dev-token.local.ts`:
   - Run `gh auth token` and paste the value into the placeholder.
   - Run `git update-index --skip-worktree src/dev-token.local.ts` so your token is never committed.
   - Phase 3 will replace this file with Device Flow OAuth.
3. **Build**: `npm run build` produces `main.js`.
4. **Install into a vault**:
   - Create `<vault>/.obsidian/plugins/obsidian-copilot-agent/`.
   - Copy `main.js`, `manifest.json`, and `styles.css` into that folder.
   - Copy the platform Copilot CLI binary into the same folder:
     - Windows: `node_modules/@github/copilot-win32-x64/copilot.exe`
     - macOS: `node_modules/@github/copilot-darwin-{arm64,x64}/copilot`
     - Linux: `node_modules/@github/copilot-linux-{arm64,x64}/copilot`
   - In Obsidian → Settings → Community plugins, enable "Copilot Agent (Spike)".
5. **Use it**: click the bot ribbon icon (left sidebar) to open the chat panel. Phase 2 denies every tool call at the universal-approval-gate; only freeform model responses succeed.

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
