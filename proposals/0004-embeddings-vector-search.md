# 0004 — Vault embeddings and semantic search

**Status:** Draft
**Created:** 2026-06-18
**Owner:** unassigned

## Problem

Today the agent can find notes only via filename/path (`find_files`) or
substring search (`search_content`). For a knowledge vault, this misses
the obvious use case: "find notes that talk about X" where X never
appears verbatim. Other Copilot-for-Obsidian plugins lean heavily on
embeddings + vector search for exactly this; we don't yet.

## Sketch

### Storage and indexing

- Index chunked Markdown (~500 token chunks with ~50 token overlap),
  keyed by `(file path, chunk id, content hash)`.
- Persist the vector index inside the plugin folder (`embeddings.db` or
  similar). SQLite + `sqlite-vss` extension is the standard low-friction
  choice; `hnswlib-node` is faster but introduces a native dep that
  fights our existing single-binary packaging story.
- Incremental reindex on vault change events
  (`vault.on('modify' | 'create' | 'delete' | 'rename')`).
- First-run "index your vault" UX with progress + cancel.

### Embedding provider

Three plausible providers to start:

1. **GitHub Models embeddings** (preferred — same auth surface as the
   chat models, free for GitHub Copilot subscribers). Verify which
   embeddings models are exposed via the same endpoint we're already
   talking to and what the rate-limit story is.
2. **Azure OpenAI / OpenAI** — well-trodden but introduces another API
   key and another bill. Useful as a fallback for users without GitHub
   model access.
3. **Local (e.g., `nomic-embed-text` via Ollama or `all-MiniLM-L6-v2`
   via a bundled ONNX runtime)** — slow first-run but zero per-token
   cost. Useful for sensitive vaults where users do not want any content
   leaving the device.

Make this a strategy interface (`EmbeddingProvider`) so users can pick
in settings. Same pattern we use for the chat model picker.

### Retrieval surface

- New built-in tool `semantic_search(query, k)` returning ranked
  `(path, snippet, score)` results.
- Optionally: a hybrid mode that merges semantic and substring matches
  with a learned reranker. Out of scope for v1.
- Tool result feeds the model the same way `search_content` does; the
  preamble should explain when to prefer semantic over substring.

## Risks

- **Cost.** Indexing a 5k-note vault is thousands of API calls. Cache
  aggressively; show running cost estimate during initial index.
- **Privacy.** Vault contents leave the device when using cloud
  providers. Add a prominent setting + first-run modal explaining this
  and offering the local provider.
- **Storage.** A 5k-note index with 1536-dim vectors is ~30 MB. Fine
  inside the plugin folder but worth surfacing in settings.
- **Provider rate limits.** Initial index can run into per-minute limits;
  add token-bucket throttling.

## Open questions

- Does GitHub Models expose embeddings the same way it exposes chat
  models? If not, what is the recommended embeddings endpoint for our
  current auth flow?
- Is there appetite to bundle a local embedding model (~100 MB ONNX) in
  the plugin distribution, or do we require Ollama as an external dep?
- Should the index live per-vault or be globally shared? Per-vault keeps
  privacy boundaries clean; global avoids re-indexing when the same
  notes are in multiple vaults.
- How does this interact with future MCP servers that expose their own
  search (Microsoft Graph, Confluence MCP, etc.)? Are we building a
  parallel system, or should semantic search itself be an MCP server we
  ship in-process?

## References

- This was the user's opening question in v0.5 development; the answer
  at the time was "embeddings are out of scope for v0.5 / v0.6."
- README v0.5 What's NOT in scope (implicitly covers embeddings).
- Comparable plugins: `copilot` by logancyang (uses Pinecone / local
  embeddings), `smart-connections` (local + cloud embeddings).
