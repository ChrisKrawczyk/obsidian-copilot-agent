# Agent vault tools — quick reference

v0.10 adds six new / upgraded **read-only** vault-navigation tools that
the agent can call without asking for permission. Collectively they let
the agent locate, inspect, and traverse notes on its own — instead of
falling back to raw file reads or asking you to point it at things.

All tools listed here are auto-approved under the FR-017 read-only gate
and appear in the session-start preamble so the model discovers them on
the first turn. None of them mutate the vault.

If you want the full design rationale (why not embeddings? why these six
tools?), see [proposal `#0010`](../proposals/0010-agent-native-vault-tools.md)
and the rejected embeddings precursor [proposal `#0004`](../proposals/0004-embeddings-vector-search.md).

## When to expect the agent to use each tool

| Goal | Tool the agent should reach for |
|------|-------|
| "Find notes containing 'kubernetes' or matching a regex" | `search_content` |
| "Find every note tagged `#reading` modified this month, in `Books/`" | `search_vault` |
| "Where does `[[Some Note]]` on the current page actually point?" | `resolve_link` |
| "What does this note link out to?" | `get_outlinks` |
| "Show me the headings/sections of this note before reading it" | `get_note_structure` |
| "What other notes are related to this one?" | `related_notes` |

You should not normally need to invoke these by name — the agent picks
them from the preamble inventory. This page is here so you can predict
what it will do and understand the outputs.

---

## `search_content`

Full-text search across vault markdown. **New in v0.10:** an explicit
`mode` parameter controls the matcher.

| Parameter | Type | Description |
|-----------|------|-------------|
| `query` | string | The pattern to match. Required. |
| `mode` | `"substring" \| "regex" \| "fuzzy"` | Optional. Defaults to `substring` (the v0.9 behavior — literal, case-insensitive). |
| `limit` | number | Maximum results. Defaults to a reasonable cap. |

- `substring`: byte-for-byte compatible with v0.9. Case-insensitive
  literal match. Use when you know the phrase you're looking for.
- `regex`: JavaScript regular expression. Invalid patterns are reported
  as `invalid-regex`, not thrown.
- `fuzzy`: Obsidian's own `prepareFuzzySearch` scorer, same ranking as
  the built-in Quick Switcher / global search.

Every match includes a **span** (`{lineStart, columnStart, columnEnd}`)
so the agent can `read_file` the exact region without re-guessing.

**Behavior on warmup:** returns `{ok: false, reason:
"metadata-cache-not-ready"}` when the vault index isn't populated yet
(rare — usually only on the very first request after enabling the
plugin).

---

## `resolve_link`

Resolve a link (wikilink `[[…]]` or markdown `[text](target)`) to its
target vault path. Source-aware — matches Obsidian's own click behavior,
including relative resolution.

| Parameter | Type | Description |
|-----------|------|-------------|
| `link` | string | The link text. Accepts raw or wrapped forms. Required. |
| `sourcePath` | string | Vault-relative path of the note that contains the link. Required. |

**Returns:**
- `{ok: true, target: {path}}` when Obsidian can resolve the link.
- `{ok: false, reason: "unresolved"}` when the link genuinely points
  nowhere (broken link).
- `{ok: false, reason: "invalid-link"}` for malformed input.
- `{ok: false, reason: "metadata-cache-not-ready"}` when the source
  note exists in the vault but its cache entry hasn't populated yet.
  This is retryable — the agent can call again after a short wait.

The distinction between `unresolved` and `metadata-cache-not-ready`
matters: the first is a permanent answer ("this link is broken"), the
second is a transient warmup state.

---

## `get_outlinks`

List a note's outgoing links + embeds.

| Parameter | Type | Description |
|-----------|------|-------------|
| `path` | string | Vault-relative path of the source note. Required. |

**Returns:** `{ok: true, path, outlinks: [...], truncated}` where each
outlink is `{target, kind: "wikilink" | "markdown", resolvedPath?}`.

- `kind` distinguishes `[[wiki]]` (including `![[embeds]]`) from
  `[markdown](links)`.
- `resolvedPath` is populated when Obsidian can resolve the target;
  omitted when the link is unresolved.
- Capped at **200 entries** with a `truncated` flag.

---

## `get_note_structure`

Return a note's structural outline — headings, sections, and block IDs
with line numbers, **without any body prose**.

| Parameter | Type | Description |
|-----------|------|-------------|
| `path` | string | Vault-relative path. Required. |

**Returns:** `{ok: true, path, headings, sections, blocks, truncated}`
where each item carries a `line` number (0-based).

Use this before `read_file` to plan a targeted read — e.g., "read only
the section under the *Findings* heading" — instead of dumping the
whole note into context. Capped at **500 combined items**.

---

## `search_vault`

Compound structural + text query. AND-combines any of the following
filters in a single call.

| Parameter | Type | Description |
|-----------|------|-------------|
| `tag` | string | Match notes carrying this tag (`#` optional). |
| `folder` | string | Vault-relative folder prefix. Matches notes at any depth. |
| `modifiedSince` | number | Unix milliseconds. Match notes with mtime ≥ this value. |
| `text` | string | Text pattern. Delegates to `search_content` semantics. |
| `mode` | `"substring" \| "regex" \| "fuzzy"` | Mode for `text`. Same values as `search_content`. |
| `limit` | number | Maximum results. Capped at 100 by the tool. |

**Short-circuit:** when structural filters (`tag`, `folder`,
`modifiedSince`) exclude every note, `search_vault` returns immediately
**without reading any file bodies**. This makes it cheap to ask
questions like "any notes tagged `#draft` in `Projects/` modified this
week?" — if the answer is no, the tool never opens a file.

When `text` is supplied but structural filters allow at least one
candidate, ranked/fuzzy text search runs on that candidate set only.

---

## `related_notes`

Rank vault neighbours of a note by shared signals.

| Parameter | Type | Description |
|-----------|------|-------------|
| `path` | string | Vault-relative path of the source note. Required. |
| `limit` | number | Optional. Capped at 20 by the tool. |

**Scoring:**
```
score = tagOverlap * 3 + outlinkOverlap * 2 + backlinkOverlap * 1
```

- `tagOverlap` — count of tags shared with the source (inline + frontmatter).
- `outlinkOverlap` — count of resolved outlinks the two notes have in common.
- `backlinkOverlap` — count of notes that link to *both* the source and the candidate.

Zero-score neighbours are dropped. Results sort by score descending,
then by path ascending (deterministic). Each entry includes the raw
per-signal counts so the agent can explain **why** a note ranked where
it did:

```jsonc
{
  "ok": true,
  "source": "Projects/Kubernetes.md",
  "related": [
    {
      "path": "Books/GKE Notes.md",
      "score": 8,
      "signals": { "tag": 2, "outlink": 1, "backlink": 0 }
    }
  ],
  "truncated": false
}
```

Weights are tuned for the common case where tags carry the strongest
topical signal and backlinks are noisiest (a link IN says less about
similarity than a link OUT you both chose to make). If your vault
disagrees, please file an issue.

---

## Metadata cache warmup

All six tools share the same warmup contract. When Obsidian's metadata
index hasn't populated an entry for a file that genuinely exists in the
vault, tools return:

```json
{"ok": false, "reason": "metadata-cache-not-ready"}
```

This is distinct from `not-found` (permanent) — the agent can retry
after a short wait. In practice you'll only see this on the very first
request after the plugin loads, or immediately after a large vault
import.

## What this does *not* do

- **No embeddings, no vector index.** `related_notes` uses the vault's
  existing metadata graph — tags, outlinks, backlinks — not vector
  similarity. See [proposal `#0004`](../proposals/0004-embeddings-vector-search.md)
  for the rationale.
- **No Dataview integration.** A DQL-facing tool is a possible future
  addition (proposal `#0011`), separate from this release.
- **No writes.** Every tool listed here is read-only and auto-approved.

For the vault write tools (`create_task`, `update_task`, `edit_note`,
`insert_into_active_note`) and their v0.10.2 concurrency semantics,
see the `CHANGELOG` v0.10.2 entry. In short: append/prepend and the
task tools are now safe under parallel writes to the same note;
`edit_note` in `replace` mode remains last-writer-wins by design.
