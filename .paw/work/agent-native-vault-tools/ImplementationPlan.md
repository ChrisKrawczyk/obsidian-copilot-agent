# Agent-Native Vault Navigation Tools — Implementation Plan

## Overview

Ship six agent-native vault-navigation capabilities that let the
Copilot agent answer "where did I write about X?" style questions
without relying on a precomputed embedding index. Five capabilities
are new tools; one is an additive upgrade to the existing
`search_content`. All capabilities are read-only, auto-approved, and
grounded in Obsidian's public plugin API surface (no network, no
persistent index, no new required setting). Design rationale is
captured in `proposals/0010-agent-native-vault-tools.md`; concrete
behavior in `Spec.md`.

## Current State Analysis

The plugin already has a mature vault-tool surface anchored by
`ALL_VAULT_TOOL_ENTRIES` in `src/domain/vaultToolManifest.ts` and a
narrow `ObsidianApi` wrapper in `src/tools/ObsidianApi.ts`. New
capabilities plug into that surface using existing conventions:

- Tools declare `{name, description, parameters, handler}` via
  `defineTool` (see `src/tools/SearchTools.ts:48-73`); read-only tools
  set `skipPermission: true`.
- The manifest is the single source of truth for preamble inventory
  and hints (`src/domain/PreambleAssembler.ts:158-188`).
- Runtime wiring concatenates raw + read-note + search + write-note
  tools in `src/main.ts:661-702`.
- Path handling uses `resolveVaultPath`/`toVaultRelative`/`lookupTFile`
  for normalization.
- Cap constants live near their implementations (e.g.
  `MAX_SEARCH_MATCHES=50`, `SNIPPET_RADIUS=80`,
  `SEARCH_BY_TAG_CAP=200`, `SEARCH_BY_NAME_CAP=50`,
  `MAX_TREE_NODES=500`).
- `ObsidianApi` already wraps `metadataCache.resolvedLinks`,
  `metadataCache.getFileCache`, `getMarkdownFiles`, and
  active-file/recent-file helpers. It does **not** yet wrap
  `prepareSimpleSearch`, `prepareFuzzySearch`, or
  `metadataCache.getFirstLinkpathDest` — this feature adds those
  passthroughs.
- Tests are colocated Vitest files with narrow in-memory fixtures
  (see `src/tools/SearchTools.test.ts:22-70`); `obsidian` is aliased
  to `src/test/obsidianMock.ts` — this mock will need thin additions
  for `prepareSimpleSearch`, `prepareFuzzySearch`, and
  `getFirstLinkpathDest`.

Key existing state the plan preserves without change:

- `search_content` inputs (`query`, optional `regex`), output shape
  (`{matches:[{path,line,snippet}], totalMatches, truncated}`),
  regex construction (`new RegExp(query)`), 1-based line numbers,
  and its 50-match / 80-char-snippet caps
  (`src/tools/ReadTools.ts:147-178`, `275-358`).

## Desired End State

Six new agent-native capabilities land in the plugin:

1. `search_content` extended additively with new opt-in `mode`
   (`substring` (default, current behavior), `simple`, `fuzzy`,
   `regex`), new optional `score` field, per-match char spans, and
   optional `pathPrefix` / `caseSensitive` filters. Legacy calls that
   don't pass `mode` remain byte-for-byte compatible.
2. `search_vault` — compound tag × folder-prefix × modified-since ×
   text filter with AND semantics and short-circuit when structural
   filters exclude the vault.
3. `resolve_link` — resolves a `[[wikilink]]` (plus source note path)
   to a vault-relative path using Obsidian's own resolver.
4. `get_outlinks` — outgoing links from a note, distinguishing
   wikilink vs Markdown link.
5. `get_note_structure` — headings, sections, block IDs, positions —
   without note body prose.
6. `related_notes` — bounded, ranked list of neighbours by shared
   tags, shared outgoing links, and shared incoming links.

Verification approach:

- Per-tool Vitest coverage under `src/tools/**/*.test.ts` using the
  existing in-memory fixture pattern; regression coverage for legacy
  `search_content` behavior stays green.
- Manifest-preamble integration test asserts each new tool has a
  usage-hint line (FR-011).
- End-to-end auto-approval check via existing session-plumbing tests
  (no new user-approval prompt) (FR-010).
- Verification commands from `CodeResearch.md`: `npm test`,
  `npm run typecheck`, `npm run build`.

## What We're NOT Doing

- No embedding, vector index, or precomputed similarity signal
  (rejected in `proposals/0004-embeddings-vector-search.md`).
- No integration with Dataview (deferred to
  `proposals/0011-dataview-query-tool.md`).
- No programmatic invocation of Obsidian's built-in Search pane
  (`openGlobalSearch` returns nothing to callers).
- No new write tools; no changes to existing write tools.
- No changes to raw-filesystem tool gating.
- No renaming of `search_content`.
- No cross-vault or third-party-plugin behavior beyond Dataview
  (deferred).
- No new required user-facing setting.
- No new external service or npm runtime dependency.

## Phase Status

- [ ] **Phase 1: search_content v2 (additive modes + spans)** —
  Preserve every existing caller; add opt-in `mode`, `pathPrefix`,
  `caseSensitive`, score, and per-match char spans. Highest
  regression risk (FR-003 / SC-003), which is why it lands first.
- [ ] **Phase 2: Structural tools (resolve_link, get_outlinks,
  get_note_structure)** — Three metadata-cache-only tools; no body
  reads; small, low-risk surface for FR-006 / FR-007 / FR-008.
- [ ] **Phase 3: search_vault compound query** — AND-combined tag /
  folder-prefix / modified-since / text filter with short-circuit
  when structural filters exclude the vault; delegates ranked/fuzzy
  text search to the Phase 1 helper (FR-004, FR-005).
- [ ] **Phase 4: related_notes** — Shared-tags + shared-outlinks +
  shared-backlinks ranking; bounded, deterministic (FR-009).
- [ ] **Phase 5: Preamble hints, docs, and version bump** — Add
  manifest entries + hints (FR-011); update README, CHANGELOG, and
  `Docs.md`; bump plugin version to v0.10.0.

## Phase Candidates

<!-- No candidates identified beyond the five committed phases.
     Any deferred work (Dataview, embeddings) is tracked in
     proposals 0011 and 0004 respectively. -->

---

## Phase 1: search_content v2 (additive modes + spans)

### Objective

Extend `search_content` in place so callers can opt into `simple`
(ranked, whitespace-AND) and `fuzzy` (character-sequence) modes,
receive a numeric `score` and per-match `spans`, and optionally
filter by `pathPrefix` and `caseSensitive`, while every existing
caller's output remains byte-for-byte identical. Introduce
`prepareSimpleSearch` / `prepareFuzzySearch` passthroughs on
`ObsidianApi`.

### Changes Required

- **`src/tools/ObsidianApi.ts`**: extend the wrapped `metadataCache`
  and app surfaces to expose `prepareSimpleSearch(query)` and
  `prepareFuzzySearch(query)` passthroughs (both return
  `(text) => {score, matches:[[start,end],...]} | null`). Add matching
  fields to `AppLike` and the wrapper's public accessor. Keep the
  wrapper narrow — no logic, just plumbing.
- **`src/test/obsidianMock.ts`**: add `prepareSimpleSearch` and
  `prepareFuzzySearch` implementations sufficient for unit tests
  (whitespace-AND substring for simple; simple char-subsequence for
  fuzzy). Score does not need to match Obsidian exactly — tests
  assert ordering, not absolute values.
- **`src/tools/ReadTools.ts`**:
  - Extend `search_content` JSON schema (still
    `additionalProperties: false`): add optional `mode:
    "substring"|"simple"|"fuzzy"|"regex"`, optional
    `pathPrefix: string`, optional `caseSensitive: boolean`.
    When `mode` is omitted, behavior matches the current
    "substring" default (unless `regex: true` is set, in which case
    regex mode is chosen for back-compat with the current `regex`
    boolean).
  - Extend `searchContentImpl` result shape additively: each match
    gains optional `score` (only when `mode` in {simple, fuzzy})
    and optional `spans: [[start,end],...]`. Existing fields
    (`path`, `line`, `snippet`, `totalMatches`, `truncated`) keep
    the same names, types, and positions.
  - Add ranked ordering when `mode` in {simple, fuzzy}: results are
    sorted by descending `score` (tiebreak: current stable
    iteration order — path, then line). Substring/regex modes keep
    their existing filesystem enumeration order.
  - Add `pathPrefix` filter: applied as a
    `path.startsWith(normalizedPrefix)` check after
    `resolveVaultPath` normalization; matches existing normalization
    for `find_backlinks` and `vault_tree`.
  - Add `caseSensitive`: applies to substring and simple modes;
    ignored for fuzzy (Obsidian's fuzzy is inherently
    case-insensitive) and for regex (caller controls via inline
    flags).
  - Preserve `MAX_SEARCH_MATCHES=50` and `SNIPPET_RADIUS=80` for
    all modes; keep the existing `total >= MAX_SEARCH_MATCHES * 4`
    early-out for substring/regex, and apply the same "keep-top-50
    ranked, truncate rest" behavior for simple/fuzzy.
  - Serial file iteration is preserved (yields to UI thread on
    large vaults).
- **Tests** (`src/tools/ReadTools.test.ts`): add cases —
  (a) regression: current substring and regex cases still emit the
  exact same match records (same path/line/snippet, no `score`,
  no `spans`) — this is the SC-003 anchor;
  (b) `mode: "simple"` returns descending-score ordering with
  whitespace-AND semantics and `spans` populated;
  (c) `mode: "fuzzy"` returns top-K on a typo query (transposed
  char in a five-char word) that would return zero in substring
  mode;
  (d) `pathPrefix: "Work/"` excludes matches outside the prefix
  in every mode;
  (e) `caseSensitive: true` on substring / simple modes;
  (f) cap + truncation flag behavior identical to existing
  behavior;
  (g) mock passthroughs on `ObsidianApi` return the expected
  interface;
  (h) invalid regex still returns the existing
  `Invalid regex` error shape.

### Success Criteria

#### Automated Verification:
- [ ] Tests pass: `npm test`
- [ ] Typecheck: `npm run typecheck`
- [ ] Build: `npm run build`
- [ ] Regression assertion in `ReadTools.test.ts` proves legacy
  `search_content` output is byte-identical for every previously
  covered call shape (SC-003).

#### Manual Verification:
- [ ] With a test vault, `search_content` called with no `mode`
  behaves exactly as before (visual diff against a v0.9.0 snapshot).
- [ ] `mode: "simple"` on a two-word query returns a note that
  contains the words in rearranged form above a note that contains
  only one of the words (SC-001).
- [ ] `mode: "fuzzy"` on a typo query returns the intended note in
  the top three results (SC-002).

---

## Phase 2: Structural tools (`resolve_link`, `get_outlinks`, `get_note_structure`)

### Objective

Add three read-only tools that operate purely against Obsidian's
resolved metadata cache. Each is small, side-effect-free, and
delivers one specific FR (006, 007, 008). They share the same file
because they share fixtures and helpers, and their combined surface
is roughly the size of one existing tool.

### Changes Required

- **`src/tools/NavigateTools.ts`** (new file, mirrors
  `SearchTools.ts` structure — a small factory `createNavigateTools`
  returning three `defineTool` entries):
  - `resolve_link`: params `{link: string, sourcePath?: string}`;
    delegates to `metadataCache.getFirstLinkpathDest(link,
    sourcePath ?? "")` via a new `ObsidianApi.resolveLinkPath`
    helper. Returns `{ok:true, target:{path}}` on success or
    `{ok:false, reason:"unresolved"|"invalid-link"|
    "metadata-cache-not-ready"}`.
  - `get_outlinks`: params `{path: string}`; reads
    `metadataCache.getFileCache(f).links` (wikilinks) and
    `.embeds` where applicable; distinguishes `link.original`
    starting with `[[` (wikilink) vs `[` (Markdown). Returns
    `{ok:true, path, outlinks:[{target, kind:"wikilink"|"markdown",
    resolvedPath?:string}], truncated:boolean}` with cap
    `MAX_OUTLINKS=200` (defined at module top). Resolves each
    target through `getFirstLinkpathDest` and includes
    `resolvedPath` when resolvable.
  - `get_note_structure`: params `{path: string}`; reads
    `metadataCache.getFileCache(f)` and returns
    `{ok:true, path, headings:[{level,text,line}],
    sections:[{type,line}], blocks:[{id,line}], truncated:boolean}`
    with cap `MAX_STRUCTURE_ITEMS=500` (defined at module top).
    Explicitly returns NO body prose (SC-008 anchor).
  - All three set `skipPermission: true` (FR-010) and return
    `metadata-cache-not-ready` when the cache is not populated
    (FR-014).
- **`src/tools/ObsidianApi.ts`**: add `resolveLinkPath(link,
  sourcePath)` passthrough that delegates to
  `metadataCache.getFirstLinkpathDest`. Add corresponding field to
  `AppLike`'s `metadataCache` shape.
- **`src/test/obsidianMock.ts`**: add
  `getFirstLinkpathDest(linkpath, sourcePath)` sufficient for
  tests — a lookup against the fixture's file table.
- **`src/domain/vaultToolManifest.ts`**: add a new
  `NAVIGATE_TOOL_ENTRIES` array (three entries, all `readOnly:
  true`) and include it in `ALL_VAULT_TOOL_ENTRIES`. Hint text is
  populated in Phase 5; Phase 2 uses placeholder hints noted with a
  `// FR-011 hint refined in Phase 5` comment.
- **`src/main.ts`**: import and wire `createNavigateTools`
  alongside existing factories (`src/main.ts:661-702`).
- **Tests** (`src/tools/NavigateTools.test.ts`, new): fixture
  builder patterned on `SearchTools.test.ts:22-70`; cases for each
  tool including resolved/unresolved wikilink, wikilink vs Markdown
  link discrimination, outline with the SC-008 sentinel-string
  assertion, cap + truncation flags, and metadata-cache-not-ready
  paths.

### Success Criteria

#### Automated Verification:
- [ ] Tests pass: `npm test`
- [ ] Typecheck: `npm run typecheck`
- [ ] `NavigateTools.test.ts` covers all three tools' happy path
  plus the SC-008 sentinel-string assertion.

#### Manual Verification:
- [ ] Test vault: `resolve_link("[[Alice's Onboarding]]",
  "Work/index.md")` returns the correct target path.
- [ ] `get_outlinks` on a note containing one wikilink and one
  Markdown link returns two entries with distinct `kind` values.
- [ ] `get_note_structure` on a large note returns only headings /
  sections / blocks with no body substrings present in the payload.

---

## Phase 3: `search_vault` compound query

### Objective

Add a single-tool compound query supporting AND-combined tag,
folder-prefix, modified-since, and free-text filters with
short-circuit when structural filters exclude every note.

### Changes Required

- **`src/tools/SearchTools.ts`**: add `search_vault` to the
  factory returning a new `defineTool` entry with params:
  ```ts
  { tag?: string, folder?: string, modifiedSinceMs?: number,
    text?: string, textMode?: "substring"|"simple"|"fuzzy",
    limit?: number }
  ```
  Handler flow (short-circuit is the SC-005 anchor):
  1. Enumerate candidate files. If `tag` supplied, use
     `findFilesByTag` (`src/tools/ObsidianApi.ts:326-362`); else
     `getMarkdownFiles()`.
  2. Apply `folder` filter via
     `normalized.startsWith(prefixWithSlash)` on
     `resolveVaultPath`-normalized paths.
  3. Apply `modifiedSinceMs` filter via `file.stat.mtime`.
  4. If the working set is empty after any structural filter, and
     `text` was supplied, return `{ok:true, matches:[], total:0,
     truncated:false, shortCircuited:true}` without any body
     reads. Add an in-test spy on `vault.cachedRead` /
     `vault.read` to prove zero reads (SC-005 anchor).
  5. If `text` is supplied, run the Phase 1 text-search helper
     scoped to the working set, with the requested `textMode`
     (default `"substring"`).
- **`src/tools/ReadTools.ts`**: extract the file-iteration and
  match-collection loop from `searchContentImpl` into a reusable
  `searchInFiles(files, query, options)` helper so Phase 3 can
  reuse it against a filtered file list; existing
  `searchContentImpl` becomes a thin wrapper.
- **Caps**: `SEARCH_VAULT_CAP = 100` defined at the top of
  `SearchTools.ts` (documented per FR-012).
- **`src/domain/vaultToolManifest.ts`**: add `search_vault` to
  `V03_READ_TOOL_ENTRIES` (or a new `COMPOUND_TOOL_ENTRIES` array,
  chosen at implementation time based on how the manifest names
  read at Phase 5). `readOnly: true`.
- **Tests** (`src/tools/SearchTools.test.ts`): add cases —
  compound filter returns exactly the enumerated expected set
  (SC-004); empty-structural short-circuit performs zero
  `cachedRead`/`read` calls (SC-005); tag-only + text behaves
  as tag-filtered text search over the whole vault; modified-since
  filter excludes older files; cap + truncation flag; each
  `textMode` value is exercised.

### Success Criteria

#### Automated Verification:
- [ ] Tests pass: `npm test`
- [ ] Typecheck: `npm run typecheck`
- [ ] Spy-based assertion in `SearchTools.test.ts` proves
  short-circuit performs zero body reads (SC-005).

#### Manual Verification:
- [ ] Test vault: compound query `{tag:"#project",
  folder:"Work/", modifiedSinceMs: <2 weeks ago>, text:"sunset"}`
  returns exactly the intended note (SC-004).
- [ ] Tag-only + text query returns tag-filtered text search over
  the whole vault.

---

## Phase 4: `related_notes`

### Objective

Add a single tool that ranks vault neighbours of a source note by
shared tags, shared outgoing links, and shared incoming links.
Bounded, deterministic, and no first-run indexing.

### Changes Required

- **`src/tools/NavigateTools.ts`** (extend the file from Phase 2):
  add `related_notes` params `{path: string, limit?: number}` and
  handler flow:
  1. Look up source note via `resolveVaultPath` + `lookupTFile`.
  2. Extract source `tags` (via existing helper in
     `src/tools/ObsidianApi.ts:265-324`) and source `outlinks`
     from `getFileCache(f).links`. Extract source `backlinks` from
     `metadataCache.resolvedLinks` inverted (mirrors
     `find_backlinks` in `src/tools/ReadNoteTools.ts:285-348`).
  3. For every other markdown file, compute:
     `score = tagOverlap * W_TAG + outlinkOverlap * W_LINK
              + backlinkOverlap * W_BACK`
     where `W_TAG=3`, `W_LINK=2`, `W_BACK=1` (documented weights
     per Assumption 3 in `Spec.md`; constants at file top so they
     are a single-file edit).
  4. Sort descending by score; drop score-0 entries (so a note
     with no tags/links returns empty — SC-009 corollary).
  5. Cap at `RELATED_NOTES_CAP = 20`; return `{ok:true, source,
     related:[{path, score, signals:{tag, outlink, backlink}}],
     truncated}`.
- **`src/domain/vaultToolManifest.ts`**: append `related_notes`
  to the same manifest array Phase 2 added.
- **Tests** (`src/tools/NavigateTools.test.ts`): add cases —
  ranking assertion where source shares 3 tags with A and 1 tag
  with B ranks A strictly above B (SC-009); empty result when
  source has no tags/links; cap + truncation flag; excludes the
  source itself from results.

### Success Criteria

#### Automated Verification:
- [ ] Tests pass: `npm test`
- [ ] Typecheck: `npm run typecheck`
- [ ] `NavigateTools.test.ts` covers SC-009 ranking assertion.

#### Manual Verification:
- [ ] Test vault: on a source note that shares many tags with
  another note, `related_notes` returns that note near the top.

---

## Phase 5: Preamble hints, docs, and version bump

### Objective

Land the user-facing surface changes: refine the preamble hint
lines for all six new capabilities (FR-011 / SC-011), update
README + CHANGELOG, write `Docs.md`, and bump the plugin version
to v0.10.0.

### Changes Required

- **`src/domain/vaultToolManifest.ts`**: replace the placeholder
  hints Phase 2 / 3 / 4 introduced with the final one-line usage
  descriptions (one per capability). Follow the phrasing pattern
  used by existing entries in `V03_READ_TOOL_ENTRIES` (see
  `src/domain/vaultToolManifest.ts:150-166`).
- **`src/domain/PreambleAssembler.test.ts`** (or the equivalent
  test file if named differently): assert each of the six new
  tool names appears exactly once in the assembled preamble and
  each has a distinguishable hint line (SC-011).
- **`manifest.json`** and **`package.json`**: bump `version` to
  `0.10.0` following the release convention documented in
  `RELEASING.md`.
- **`CHANGELOG.md`**: prepend a `## v0.10.0` section listing the
  six new / upgraded capabilities.
- **`README.md`**: extend the "What's new" section
  (`README.md:7-38`) with a short v0.10.0 entry and link to the
  detailed `Docs.md`.
- **`.paw/work/agent-native-vault-tools/Docs.md`** (new): follow
  `paw-docs-guidance` — technical reference for the six
  capabilities. Loading `paw-docs-guidance` during implementation
  of this phase is required.
- **`docs/agent-vault-tools.md`** (new): user-facing
  quick-reference following the task-oriented style already used
  in `docs/m365-graph-mcp.md` and `docs/preset-packs.md`.

### Success Criteria

#### Automated Verification:
- [ ] Tests pass: `npm test`
- [ ] Typecheck: `npm run typecheck`
- [ ] Preamble test asserts one distinguishable hint line per new
  capability (SC-011).
- [ ] Schema check: `npm run schema:check` (no schema changes
  expected, but the check is part of the release verification
  pattern).

#### Manual Verification:
- [ ] `README.md` "What's new" section lists v0.10.0 additions.
- [ ] `CHANGELOG.md` entry is present and reads consistently with
  prior entries.
- [ ] `docs/agent-vault-tools.md` is written in the task-oriented
  style of other `docs/*.md` files.
- [ ] Session-start preamble in the running plugin visibly names
  all six new capabilities with usage hints (SC-011).

---

## References

- Issue: none (design in proposal)
- Spec: `.paw/work/agent-native-vault-tools/Spec.md`
- Research: `.paw/work/agent-native-vault-tools/CodeResearch.md`
- Proposal: `proposals/0010-agent-native-vault-tools.md` (PR #12)
- Deferred follow-up: `proposals/0011-dataview-query-tool.md`
  (PR #13)
- Rejected precursor: `proposals/0004-embeddings-vector-search.md`
