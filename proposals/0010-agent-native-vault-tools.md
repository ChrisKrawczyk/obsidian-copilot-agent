# 0010 — Agent-native vault navigation tools

**Status:** Draft
**Created:** 2026-07-06
**Owner:** unassigned
**Supersedes:** [0004 — Vault embeddings and semantic search](./0004-embeddings-vector-search.md)

## Problem

The agent's ability to navigate a user's vault is the plugin's core value
proposition, but the current toolbelt has three shape gaps that hurt
real-world use:

1. **`search_content` is naive substring/regex.** It cannot rank matches by
   relevance, cannot do multi-word AND queries with graceful ordering, and
   returns 50 unranked lines of context. On any vault larger than a few
   hundred notes it produces noise faster than signal.
2. **No fuzzy variant.** Users type `weakly typed langs` and mean
   `weakly-typed languages` — Obsidian's own quick-switcher handles this,
   the agent cannot.
3. **Wikilink resolution is manual.** The agent has `find_backlinks` (great)
   but no first-class way to say "given `[[Alice's Onboarding]]`, find and
   read that note." It has to fall back to `search_by_name` +
   `read_file`.
4. **No compound queries.** "Notes tagged `#project` under `Work/` modified
   this week that mention `sunset`" requires three tool calls and manual
   intersection in the model's head. Obsidian's own search bar does this
   trivially with `path:Work/ tag:#project content:sunset`, but that query
   syntax **is not exposed to plugins** (see Research below).

At the same time, this proposal explicitly rejects **precomputed
embeddings** (see 0004 rejection note). The bet: strong models + strong
navigation tools beat one-shot vector retrieval on the workflows an
Obsidian user actually cares about.

## Research summary

Verified against `obsidian.d.ts` (the `obsidian` npm package's types) and
several reference community plugins (`obsidian-local-rest-api`,
`obsidian-mcp-plugin`, Omnisearch, Excalidraw, Dataview).

### What is public and stable

| Capability                                           | API                                                                     |
| ---------------------------------------------------- | ----------------------------------------------------------------------- |
| Multi-word ranked text search                        | `prepareSimpleSearch(query)` (splits on whitespace, AND semantics)      |
| Fuzzy match with scoring                             | `prepareFuzzySearch(query)`                                             |
| Rendering match highlights                           | `renderMatches`, `renderResults`, `sortSearchResults`                   |
| Structural metadata (headings, tags, sections, …)    | `metadataCache.getFileCache(file)` → `CachedMetadata` (synchronous, O(1)) |
| Full tag list per file (frontmatter + inline)        | `getAllTags(cache)`                                                     |
| Wikilink → `TFile`                                   | `metadataCache.getFirstLinkpathDest(linkpath, sourcePath)`              |
| Frontmatter offsets in raw content                   | `getFrontMatterInfo(content)`                                           |
| Heading / block subpath → position                   | `resolveSubpath(cache, "#Heading" \| "#^block")`                        |
| Outgoing link graph                                  | `metadataCache.resolvedLinks` (source → { dest: count })                |
| Backlink graph                                       | Invert `resolvedLinks` (already used by `find_backlinks`)               |
| File mtime / ctime / size                            | `TFile.stat.mtime / .ctime / .size` (synchronous)                       |
| Dataview API (if installed)                          | `getAPI(app)` from `obsidian-dataview` npm package                      |

### What is **not** available

- **Obsidian's full search query syntax** (`path:`, `file:`, `content:`,
  `tag:`, `section:`, `line:`, `block:`, `task:`, boolean, `/regex/`,
  `"exact phrase"`, `-negation`) is entirely closed. No `parseQuery`,
  `SearchQuery`, or equivalent is exported. To use it we'd have to
  either open the Search pane (see next bullet) or reimplement it.
- **`openGlobalSearch(query)`** (via `app.internalPlugins.getPluginById('global-search').instance`)
  can populate the Search pane with a query string, but it **does not
  return results** — it is UI-only. Widely used since ~2021 and stable in
  practice, but private/undocumented.
- **`metadataCache.getBacklinksForFile`** exists at runtime but is private,
  has changed shape across versions, and is not in `.d.ts`. Prefer
  `resolvedLinks` inversion.

### Performance notes on 10k+ note vaults

- `vault.getMarkdownFiles()` and `metadataCache.getFileCache()` are both
  synchronous and O(1) / near-O(1); safe in hot loops.
- `vault.cachedRead(f)` is async and file-size-bounded. `Promise.all(files.map(cachedRead))`
  on 10k files freezes the UI. Iterate serially (or batch with `await` in a
  loop) and yield to the event loop.
- Prefer `metadataCache.getFileCache(f)` over `cachedRead(f)` whenever the
  query only touches metadata (headings, tags, frontmatter, link
  structure).
- `TFile.stat` is populated synchronously and is enough for "recent
  notes" and modification-date filters without any I/O.

## Sketch

### Tool set

Split by whether they're structural (`metadataCache`-only, fast) or
content-touching (`cachedRead`-based, slower).

**Structural (fast, no `cachedRead`):**

- **`resolve_link`** — Given `[[wiki-link]]` or a bare basename, return
  the resolved vault path + basic metadata. Wraps
  `metadataCache.getFirstLinkpathDest`. Replaces the current
  `search_by_name`-then-`read_file` two-step for the common case.
- **`get_outlinks`** — Given a note path, list the notes it links to
  (from `resolvedLinks`), symmetric to `find_backlinks`. Distinguishes
  wikilinks from markdown links via `CachedMetadata.links`.
- **`get_note_structure`** — Given a note, return its heading tree +
  section positions + block IDs from `getFileCache`. Enables the agent
  to say "the answer is under the `## Retrospective` section" without
  reading the whole file.
- **`related_notes`** — Given a note, return the top N notes that share
  the most tags, links, or backlinks. Pure link-graph analysis; no
  content read. Cheap "notes near this one" without embeddings.

**Content-touching (upgrades to existing tools):**

- **`search_content` → v2**: swap the substring/regex path to
  `prepareSimpleSearch`. Accept a `mode` argument (`substring | fuzzy |
  regex`) so we retain the current behaviour for callers that pass
  `regex: true` today. Return `{path, score, matches: [{line, snippet,
  spans: [start, end]}]}` — the SDK-facing shape stays additive
  (existing fields preserved, new fields on top).
- **`search_vault`** — a new *compound* tool that composes filters at
  the tool boundary: `{ text?, tag?, path_prefix?, modified_since?, mode? }`.
  Runs the cheap filters (path prefix, tag, mtime range) against
  `metadataCache` first, then applies text search only to survivors.
  This is the closest we can get to Obsidian's built-in query syntax
  without exposing raw strings. Return shape mirrors `search_content` v2.

**Optional (only if enabled):**

- **`dataview_query`** — thin wrapper around `dv.queryMarkdown(source)`.
  Only registered when the Dataview community plugin is installed and
  enabled (guarded by `getAPI(app) != null` at tool-registration time).
  Gives power users the full DQL surface without us re-implementing it.
  Off-by-default setting, since it can be very expensive on large
  vaults.

### Preamble / prompt engineering

Update the vault-tool inventory (see `src/domain/vaultToolManifest.ts`) so
the model has short usage hints:

- "Use `resolve_link` before falling back to `search_by_name` + `read_file`."
- "Prefer `get_note_structure` if you only need to know a note's
  outline."
- "Use `search_vault` for filtered searches; use `search_content`
  when you want raw text hits."

The point is not adding tools — it's giving the model *shape* so it
picks the cheapest tool that answers the question, mirroring how a
human agent would open the graph view or the outline sidebar before
Ctrl-F.

### Out of scope

- Embeddings, chunking, vector databases. See 0004 rejection note.
- Any change to write tools. Purely read/navigation surface.
- Query DSL for third parties. Compound filters are exposed only as JSON
  parameters on `search_vault`; we do not parse Obsidian query syntax.
- Global-search-pane invocation as a *tool* the agent can call. It's UI
  side-effect, not a "return results to the model" primitive, so it
  doesn't fit the current tool contract. Could be a follow-up as a slash
  command / composer action.

## Risks & mitigations

- **`prepareFuzzySearch` is slow** — the `.d.ts` JSDoc explicitly warns
  against running it "more than a few thousand times." Guard with the
  same match cap `search_content` already has and short-circuit early
  on high-score matches.
- **`resolvedLinks` staleness on first plugin load** — hook
  `metadataCache.on('resolved', …)` before enabling the outlink/related
  tools (or return a soft `not-ready` result for the first ~seconds).
- **Dataview optional dep** — if we `import` it directly, the plugin bundle
  needs the type-only import path. Use `import type { DataviewApi }` +
  the runtime `getAPI(app)` pattern to avoid a hard dependency.
- **Backwards compatibility** — `search_content` currently returns
  `{path, line, snippet}` tuples. Adding `score` and `spans` fields is
  additive; the current consumers (renderer, tests) index by name so we
  can extend safely. Existing regex behaviour must be preserved verbatim.

## Open questions

1. **Should we deprecate `search_by_name` in favour of `resolve_link`
   for exact resolution, keeping only the fuzzy-search use case?** Or do
   they cover distinct enough workflows that both should stay?
2. **Is `related_notes` worth the complexity?** It's the most
   "embedding-adjacent" feature; needs a small user study to see if it
   answers real questions.
3. **Where does the Dataview tool live in the preamble?** If we teach
   the model about it unconditionally, it'll try to call it on vaults
   without Dataview installed. Register only when available *and* omit
   from the inventory when disabled.
4. **`search_content` v2 backwards compat**: keep the exact same tool
   name and additively extend the schema, or ship as `search_content_v2`
   and mark v1 deprecated? Additive is simpler; the risk is the current
   regex code path needs a careful audit before rolling in relevance
   scoring around it.

## Not doing (yet)

- Full-text index (à la Omnisearch's MiniSearch). Only worth revisiting
  if `prepareSimpleSearch` proves too slow on 10k+ vaults in practice.
- Any UI beyond what `MessageRenderer` already does for tool results.
- Cross-vault search (only one vault is loaded at a time by Obsidian).
