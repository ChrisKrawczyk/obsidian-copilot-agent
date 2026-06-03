# obsidian-copilot-agent

An [Obsidian](https://obsidian.md) plugin that brings an in-vault AI agent powered by the [GitHub Copilot SDK](https://github.com/github/copilot-sdk).

> **Status:** Early development. Not yet usable.

## Goals

- Use a GitHub Copilot subscription (personal or enterprise) as the model backend — no separate API keys.
- Read **and write** notes in your vault directly from the chat interface (the existing community Copilot plugin is read-only on the free tier).
- Skip embeddings on day one; rely on the agent's tool-using ability to grep/read the vault.
- Desktop-only (Obsidian mobile lacks the Node runtime the SDK requires).

## Reference

The community plugin [`logancyang/obsidian-copilot`](https://github.com/logancyang/obsidian-copilot) (AGPL-3.0) is used as a structural reference for Obsidian plugin chat UIs. No code is copied.

## License

TBD.
