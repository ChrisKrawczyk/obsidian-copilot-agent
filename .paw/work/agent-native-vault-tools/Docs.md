# Agent-native vault tools — Technical Reference

Technical reference for the six new / upgraded read-only vault-navigation
capabilities shipped in v0.10.0. User-facing quick reference:
[`docs/agent-vault-tools.md`](../../../docs/agent-vault-tools.md).

## Problem statement

Prior to v0.10 the agent had only:

- `search_content` — literal substring text search
- `search_by_tag`, `search_by_name`, `list_all_tags` — v0.3 single-facet lookups
- `vault_tree`, `read_file`, `open_note` — raw file surface

That meant common navigation intents ("what does this link point to?",
"what notes are structurally related to this one?", "notes tagged X
modified last week under folder Y?") forced the agent into inefficient
patterns: raw `read_file` scans, redundant round-trips, or asking the
human to point. Proposal `#0004` explored local embeddings as a
solution; that path was rejected because modern models with a
task-tuned tool surface deliver similar recall at much lower
implementation and maintenance cost. Proposal `#0010` (this work)
lands the tool surface instead.

## Shipped surface

Six capabilities (five new tools + one in-place extension). All are
**read-only** and auto-approved under the FR-017 gate
(`skipPermission: true`), so they never generate a user-approval
prompt. All appear in the session-start preamble inventory so the
agent discovers them on the first turn (FR-011 / SC-011).

### 1. `search_content` — modes (Phase 1, extension)

File: `src/tools/ReadTools.ts`.

Added a `searchInFiles(...)` helper with two paths:

- **Ranked path:** substring/regex — walks candidate files, runs the
  matcher line-by-line, and returns `SearchMatch[]` with
  `{path, line, columnStart, columnEnd, snippet}`. Substring matching
  is byte-for-byte identical to the v0.9 codepath (SC-003 regression
  test coverage).
- **Fuzzy path:** delegates to `prepareFuzzySearch` from the Obsidian
  mock/native surface (`src/test/obsidianMock.ts` exports
  `prepareSimpleSearch` / `prepareFuzzySearch` for tests).

`search_content` handler accepts `{query, mode?, limit?}`. Omitted
`mode` maps to `substring` for backwards compatibility. Invalid regex
returns `{ok: false, reason: "invalid-regex"}` (not thrown).

### 2. Structural navigation (Phase 2)

File: `src/tools/NavigateTools.ts` (new module).

Three tools registered via `createNavigateTools(api, vault)`:

- `resolve_link({link, sourcePath})` — thin wrapper over
  `ObsidianApi.resolveLinkPath` (added in Phase 2 — internally calls
  `metadataCache.getFirstLinkpathDest`). Strips wrapper syntax
  (`[[…]]`, `[text](…)`), aliases (`|display`), and heading fragments
  (`#Section`) before resolving.
- `get_outlinks({path})` — reads `cache.links + cache.embeds` from the
  metadata cache, resolves each to a target path when possible, and
  distinguishes wikilink (`[[…]]`, `![[…]]`) from markdown-link kinds.
  Capped at `MAX_OUTLINKS = 200`.
- `get_note_structure({path})` — reads `cache.headings + cache.sections
  + cache.blocks` from the metadata cache; returns line numbers only,
  never body prose. Trims proportionally (headings first, then sections,
  then blocks) to fit `MAX_STRUCTURE_ITEMS = 500`.

To support these, `ObsidianApi` (`src/tools/ObsidianApi.ts`) added:

- `FileCacheLike` extended with typed `embeds`, `sections`, `blocks`,
  and `position` fields.
- `AppLike.metadataCache` extended with `getFirstLinkpathDest`.
- `resolveLinkPath(link, sourcePath): ApiResult<{path, file}>` method.

### 3. Compound query (Phase 3)

File: `src/tools/SearchTools.ts` — added `search_vault` alongside the
v0.3 read tools.

`search_vault({tag?, folder?, modifiedSince?, text?, mode?, limit?})`:

1. **Candidate enumeration:** `vault.getMarkdownFiles()`.
2. **Folder-prefix filter:** case-insensitive prefix match on `path`.
3. **`modifiedSince` filter:** `file.stat.mtime >= modifiedSince`.
   `TFileLike` was extended with an optional `stat?: {size?, mtime?}`
   to type this cleanly.
4. **Tag filter:** delegates to `getFileCache().tags` +
   `collectFileTagsForFallback` for frontmatter fallback.
5. **Short-circuit:** if the structural filter set is empty, return
   `{ok: true, matches: [], truncated: false}` immediately — **no body
   reads.**
6. **Text delegation:** when `text` is present, calls into Phase 1's
   `searchInFiles` on the surviving candidate set with the requested
   `mode` (or metadata-only fallback when text is absent).

Capped at `SEARCH_VAULT_CAP = 100` results.

Manifest split: `COMPOUND_TOOL_ENTRIES` is a separate array from
`V03_READ_TOOL_ENTRIES` in `src/domain/vaultToolManifest.ts` so
existing V03 assertion tests keep passing.

### 4. `related_notes` (Phase 4)

File: `src/tools/NavigateTools.ts` — added alongside Phase 2 tools.

`related_notes({path, limit?})`:

- **Source signals:**
  - Tags via `collectFileTagsForFallback(sourceCache)`.
  - Outlinks: walk `sourceCache.links + .embeds`, `resolveLinkPath`
    each, collect resolved target paths.
  - Backlinks: invert `metadataCache.resolvedLinks` — collect source
    paths whose entry contains the source note's path (mirrors
    `find_backlinks` in `src/tools/ReadNoteTools.ts:285-348`).
- **Per-candidate scoring** across `vault.getMarkdownFiles()`
  (excluding source):
  - `tagOverlap` = |candTags ∩ sourceTags|
  - `outlinkOverlap` = |candOutlinks ∩ sourceOutlinks|
  - `backlinkOverlap` = |candBacklinkers ∩ sourceBacklinkers|
  - `score = tagOverlap * W_TAG + outlinkOverlap * W_LINK +
    backlinkOverlap * W_BACK` (weights: `3 / 2 / 1`).
- **Result shape:** drop score-0 entries; sort by score desc, then
  path asc; cap at `RELATED_NOTES_CAP = 20`. Return
  `{ok: true, source, related: [{path, score, signals: {tag, outlink,
  backlink}}], truncated}`.

Weights are constants at the top of `NavigateTools.ts` and are
exported (`W_TAG`, `W_LINK`, `W_BACK`) so future tuning stays in one
place.

### 5. Metadata cache warmup (FR-014, all tools)

Every tool that reads from the metadata cache distinguishes:

- `not-found`: the file/link genuinely doesn't exist in the vault.
- `metadata-cache-not-ready`: the file exists in the vault (from
  `getMarkdownFiles()` or `getFirstLinkpathDest`) but its cache entry
  hasn't populated yet.

The warmup check pattern:

```ts
const cacheR = api.getFileCache(file);
if (!cacheR.ok) {
  if (cacheR.reason === "index-unavailable" ||
      cacheR.reason === "not-found") {
    return { ok: false, reason: "metadata-cache-not-ready" };
  }
  return { ok: false, reason: "not-found" };
}
```

For `resolve_link` there's also an `isSourceCacheWarming(sourcePath,
api)` helper that probes the source file's cache entry to distinguish
"link is genuinely broken" from "source cache still warming".

## Preamble inventory (FR-011 / SC-011)

`src/domain/vaultToolManifest.ts` was extended with:

- `COMPOUND_TOOL_ENTRIES` — one entry (`search_vault`).
- `NAVIGATE_TOOL_ENTRIES` — four entries (`resolve_link`,
  `get_outlinks`, `get_note_structure`, `related_notes`).
- Updated `search_content` hint to name the modes surface.

`ALL_VAULT_TOOL_ENTRIES` spreads all of them, so the preamble picks
them up automatically. `PreambleAssembler.test.ts` has a dedicated
SC-011 test asserting one distinguishable hint line per new capability
plus the updated `search_content` hint.

## Wiring

`src/main.ts` wires `createNavigateTools(api, vault)` alongside the
existing tool factories. No further wiring was needed — the new tools
flow through the same tool-registration path as v0.3.

## Test coverage

- `src/tools/ReadTools.test.ts` — 8 new tests for `searchInFiles`
  (substring/regex/fuzzy paths, span accuracy, invalid regex).
- `src/tools/NavigateTools.test.ts` — 20 tests covering all four
  tools + factory + warmup + edge cases.
- `src/tools/SearchTools.test.ts` — 7 new tests for `search_vault`
  including AND-combination, short-circuit, tag+text positive
  coverage.
- `src/domain/PreambleAssembler.test.ts` — SC-011 test.

Full-suite state at ship: **1597+ tests pass**; typecheck + build
clean; `npm run schema:check` clean.

## What was rejected / deferred

- **Local embeddings** — proposal `#0004`, closed as rejected. Rationale:
  modern models with the tool surface above deliver similar recall at
  much lower implementation and maintenance cost.
- **Dataview integration** — deferred as proposal `#0011`. Would add a
  DQL-facing tool. Separate release.
