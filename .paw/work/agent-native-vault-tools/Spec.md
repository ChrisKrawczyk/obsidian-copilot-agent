# Feature Specification: Agent-native vault navigation tools

**Branch**: `feature/agent-native-vault-tools`  |  **Created**: 2026-07-06  |  **Status**: Draft
**Input Brief**: Give the agent stronger vault-navigation tools grounded in Obsidian's public plugin API, in preference to adding a precomputed embedding index.

## Overview

The Obsidian Copilot agent already ships a rich vault toolset (search by
tag / name, backlink discovery, per-note metadata inspection, recent
notes, task queries, plus raw `search_content` and `read_file`). What
it does *not* yet have is the ability to (a) rank text-search hits by
relevance instead of returning up to 50 unsorted line matches,
(b) express "fuzzy" queries the way Obsidian's own quick-switcher
does, (c) resolve a wiki-link to its target note in one call, or
(d) compose several cheap filters — tag, folder, modification time —
against a text query in a single tool. In practice this means an agent
answering a natural user question ("what did I write about weakly typed
languages last month?") has to grep the whole vault with a naive
substring match, sift through dozens of unranked hits, and stitch the
answer together across multiple tool calls that a human user would just
do in the Obsidian search bar.

The strategic bet behind this feature is that stronger navigation
primitives — the kind a competent human uses when reading their own
notes — are a better investment than precomputed embeddings. See
`proposals/0010-agent-native-vault-tools.md` for the rationale and the
verified inventory of Obsidian's public plugin API surface. Notably,
Obsidian exposes `prepareSimpleSearch` and `prepareFuzzySearch` as
public helpers with match-span scoring, and its `MetadataCache` gives
us structural note information (headings, tags, sections, block IDs,
resolved outgoing links) synchronously — everything we need to build
better tools without an index of our own.

The result the user perceives is: the agent answers vault questions
faster, with fewer irrelevant read-file round-trips, and can follow a
wikilink or a heading anchor as directly as a human clicking through
the Obsidian UI. The result the agent perceives is: a smaller number
of tool calls per question, better-ranked results per call, and
clearer signals about note structure that reduce whole-file reads.

## Objectives

- Ranked text search that ranks by relevance rather than filesystem
  order. (Rationale: today's `search_content` returns 50 unranked
  matches; a large vault produces noise faster than signal.)
- Fuzzy search for typos, near-matches, and paraphrased queries.
  (Rationale: the model asks natural-language-shaped queries; users do
  too.)
- Compound queries in one tool call: text × tag × folder × modification
  time. (Rationale: shrinks multi-step reasoning that the model
  currently has to stitch together across three or four separate tools.)
- Direct wikilink resolution and outgoing-link discovery.
  (Rationale: today the agent has backlinks but no first-class outlink
  or link-target lookup — a graph blind spot.)
- Structural note inspection without reading full body text.
  (Rationale: an outline is usually enough to answer "does this note
  cover topic X?" and reading the full body wastes context.)
- Link-graph-based "related notes" as a lightweight, index-free
  alternative to embedding-based similarity. (Rationale: many "notes
  near this one" questions are answered by shared tags + shared links,
  no embeddings required.)
- Preamble hints that steer the model toward the cheapest tool that
  answers the current question. (Rationale: adding tools without
  updating hints often *worsens* behavior because the model picks the
  wrong one.)
- No new external dependencies, no new persistent index, no runtime
  network calls in the base set. (Rationale: keeps the plugin's
  single-binary packaging story intact and avoids adding
  first-run-friction UX for embeddings/indexing.)

## User Scenarios & Testing

### User Story P1 – "Where did I write about X?" answered from a fuzzy query

Narrative: A user with a several-thousand-note vault asks the agent
"find my notes about weakly typed languages" — the notes actually use
"weakly-typed" (hyphenated). The agent runs a single ranked text search
that surfaces the correct notes at the top, cites their paths in the
chat, and offers to summarise.

Independent Test: On a seed vault where the phrase appears as
"weakly-typed languages" in note A and only distantly in note B, the
agent's search returns note A above note B on a single tool call.

Acceptance Scenarios:
1. Given a vault where a query's exact literal string appears in note
   A but a rearranged / hyphenated form appears in note B, When the
   agent issues a ranked text search for the plain query, Then note B
   is returned with a higher score than note A even though its exact
   substring doesn't match.
2. Given a query that would return zero substring matches, When the
   agent issues a fuzzy variant, Then the tool returns the closest
   candidates ranked by score with match-span information the agent
   can cite.
3. Given a query that matches nothing at all, When the tool returns an
   empty result, Then the response is well-formed (empty match list,
   no error, `truncated: false`).

### User Story P2 – Compound query composed in one tool call

Narrative: A user asks "what did I write about sunset under Work/
tagged #project in the last two weeks?" The agent runs a single
compound query rather than intersecting three separate searches in its
head.

Independent Test: Given a seed vault with several notes tagged
`#project`, of which two live under `Work/`, and of those two one was
modified in the last two weeks and mentions "sunset", the agent's
compound query returns exactly that note.

Acceptance Scenarios:
1. Given a compound query specifying tag + path prefix + modified-since
   + text, When the agent issues it, Then only notes matching all four
   constraints are returned.
2. Given a compound query with only tag + text (path and time
   omitted), When the agent issues it, Then it behaves as a
   tag-filtered text search over the whole vault.
3. Given a compound query where the tag filter matches zero files,
   When the agent issues it, Then the text search is not performed
   (short-circuit) and the result is empty in constant time relative
   to vault size.

### User Story P3 – Wikilink resolution and outlink discovery

Narrative: The user's note mentions `[[Alice's Onboarding]]`. The user
asks "what does that note say?" The agent resolves the link to a real
vault path in one call, reads it, and answers.

Independent Test: For a note that contains a wikilink to a known
target, a single tool call returns the target's vault path and basic
metadata; a follow-up read yields the target's content.

Acceptance Scenarios:
1. Given a `[[wikilink]]` string and the source note's path, When the
   agent resolves the link, Then the result is the target file's
   vault-relative path when Obsidian's link resolver would resolve it,
   or a clear "unresolved" result when it wouldn't.
2. Given a note path, When the agent asks for its outgoing links,
   Then the result lists each outgoing link's target and
   distinguishes wikilinks from markdown links (mirror of the existing
   `find_backlinks` shape).

### User Story P4 – Structural inspection without a full read

Narrative: The user asks "does the RFC note have a rollback plan
section?" The agent inspects the note's structure, sees a
`## Rollback` heading, and answers without reading the whole body.

Independent Test: Given a note with a heading tree that includes a
target heading, a structural-inspection tool call returns that
heading (and its position) without returning the body text.

Acceptance Scenarios:
1. Given a note with headings, sections, and block IDs, When the
   agent inspects its structure, Then the result contains those
   elements with their positions and *no* body text.
2. Given a note that does not exist or has no cached metadata yet,
   When the agent inspects its structure, Then the result is a
   well-formed "not found" / "not ready" response — not an exception.

### User Story P5 – Link-graph "related notes"

Narrative: The user is reading a note and asks the agent "what else in
my vault relates to this?" Without any embeddings, the agent produces a
short ranked list of notes that share the most tags, incoming links,
or outgoing links with the current note.

Independent Test: Given a seed vault where note X shares 3 tags with
note A and 1 tag with note B, the related-notes tool ranks A above B
for source note X.

Acceptance Scenarios:
1. Given a source note and a small vault, When the agent asks for
   related notes, Then the response is bounded in size and ranked by
   a documented similarity signal (shared tags, shared links,
   backlinks), not by filesystem order.
2. Given a source note with no tags or links, When the agent asks for
   related notes, Then the tool returns an empty result rather than
   an arbitrary fallback set.

### Edge Cases

- **`prepareFuzzySearch` on a very large vault**: the public JSDoc
  warns fuzzy match is expensive above a few thousand calls. Fuzzy
  mode must stop scanning once the match cap is reached and must not
  freeze the UI thread.
- **Metadata cache still warming on plugin startup**: any tool that
  reads `metadataCache.resolvedLinks` before the initial "resolved"
  event must return a soft "not ready" result rather than empty data.
- **Regex mode preserved verbatim**: existing callers of
  `search_content` may pass `regex: true`; the upgraded tool must
  preserve that behavior identically.
- **A wikilink that Obsidian resolves ambiguously** (two notes with
  the same basename in different folders): the resolution tool
  returns whatever Obsidian's own resolver picks, without inventing
  its own tiebreaking.
- **Compound query with an impossible combination** (e.g., `tag:foo`
  and `path_prefix:bar/` where no note has both): the tool short-circuits
  cheaply and returns an empty result.
- **Very large notes**: structural inspection returns metadata only,
  never body text — even for a 1MB note.
- **Windows path separators**: all path-shaped inputs and outputs
  remain vault-relative POSIX-style, per the existing `VaultPath`
  contract in `src/tools/VaultPath.ts`.

## Requirements

### Functional Requirements

- **FR-001**: A ranked text-search mode is available where results are
  returned in a documented, stable ordering by relevance rather than
  filesystem/enumeration order. (Stories: P1)
- **FR-002**: A fuzzy text-search mode is available that tolerates
  typos, transpositions, and rearranged word order. (Stories: P1)
- **FR-003**: The existing regex-mode behavior of `search_content` is
  preserved so that existing callers do not regress. (Stories: P1)
- **FR-004**: A compound-query capability is available that accepts,
  at minimum, tag / path-prefix / modification-since / free-text
  filters combined with AND semantics. (Stories: P2)
- **FR-005**: A compound query with a filter that pre-excludes the
  entire vault does not read any note bodies. (Stories: P2)
- **FR-006**: A tool exists that resolves a wikilink expression
  (plus its source note) to the concrete target note's vault-relative
  path, using Obsidian's own link resolver. (Stories: P3)
- **FR-007**: A tool exists that returns the outgoing links of a
  given note, distinguishing wikilinks from markdown links.
  (Stories: P3)
- **FR-008**: A tool exists that returns a note's structural outline
  (headings, sections, block IDs, and their positions) *without*
  returning the note's body text. (Stories: P4)
- **FR-009**: A tool exists that returns a bounded, ranked list of
  notes related to a source note using at least the following signals:
  shared tags, shared outgoing links, shared incoming links.
  (Stories: P5)
- **FR-010**: All new tools are strictly read-only and register with
  the same auto-approval contract as the existing v0.2 read-only tools
  (no user prompt per invocation). (Stories: P1, P2, P3, P4, P5)
- **FR-011**: Preamble usage hints teach the model which tool is the
  cheapest fit for each shape of question, using the existing
  `vaultToolManifest.ts` inventory pattern. (Stories: P1, P2, P3, P4,
  P5)
- **FR-012**: Every new tool has a bounded, documented maximum result
  size and reports truncation via a `truncated: true` field when the
  cap is hit. (Stories: P1, P2, P5)
- **FR-013**: No new persistent index is created; no new runtime
  network calls are introduced; no new required user configuration is
  introduced. (Cross-cutting)
- **FR-014**: When Obsidian's `MetadataCache` has not yet resolved on
  plugin load, tools that depend on it return a well-formed
  "not-ready" response rather than throwing or returning silently
  wrong data. (Stories: P3, P4, P5)

### Key Entities

- **Ranked match**: a search result carrying at least a note path, a
  relevance score with documented ordering semantics, and — where
  applicable — line-level snippets with match spans.
- **Compound query filter set**: a JSON object of AND-combined
  filters over tag membership, path prefix, modification-since
  timestamp, and free-text.
- **Note structure**: the outline (headings with levels + positions,
  section boundaries, block IDs) of a note, *without* the note's body
  text.
- **Related-notes signal set**: the collection of features
  (shared tags, shared outgoing links, shared incoming links) used to
  rank vault neighbours of a source note.

### Cross-Cutting / Non-Functional

- All new tools use the same read-only auto-approval contract that
  today's `search_by_tag`, `search_by_name`, and related v0.2 tools
  use, so that they can be called freely by the agent without user
  interstitials.
- Path handling flows through the existing `VaultPath` module so that
  vault-escape resistance and Windows/POSIX normalization behavior are
  inherited rather than re-invented.
- Existing tools listed in `vaultToolManifest.ts` remain registered
  and unchanged in name; upgrades to `search_content` are additive on
  its output schema, not renaming.

## Success Criteria

- **SC-001**: On a seed vault, a ranked text search for a query whose
  exact literal appears only in a lower-value note but a rearranged
  form appears in the higher-value note returns the higher-value note
  first. (FR-001)
- **SC-002**: On a seed vault, a fuzzy text search for a
  slightly-misspelled query returns the intended target within the top
  results. (FR-002)
- **SC-003**: All existing `search_content` regex-mode tests continue
  to pass unchanged. (FR-003)
- **SC-004**: A compound query composed of tag + path-prefix +
  modified-since + text returns exactly the intersection when tested
  against a seed vault. (FR-004)
- **SC-005**: A compound query whose tag filter matches zero notes
  returns an empty result without any body-content reads observed in
  the test harness. (FR-005)
- **SC-006**: For a wikilink whose target is unambiguous, the
  resolution tool returns that target's vault-relative path. For an
  unresolvable wikilink, the tool returns an "unresolved" result
  without throwing. (FR-006)
- **SC-007**: For a note with N outgoing links, the outlink tool
  returns N entries with wikilink-vs-markdown distinction populated.
  (FR-007)
- **SC-008**: The structural-inspection tool's returned payload for a
  representative note contains headings, sections, and block IDs, and
  contains *no* substring drawn from the note's body prose (verified
  by a substring absence check in tests). (FR-008)
- **SC-009**: For a source note that shares 3 tags with note A and 1
  tag with note B (all else equal), related-notes ranks A above B.
  (FR-009)
- **SC-010**: Every new tool registered under this feature has
  `skipPermission: true` per its factory registration, verifiable via
  a manifest-level assertion. (FR-010)
- **SC-011**: The preamble assembled at plugin startup lists each
  new tool with a one-line usage hint sourced from
  `vaultToolManifest.ts`. (FR-011)
- **SC-012**: Every new tool has a documented maximum result count
  and a `truncated` boolean in its output shape; caps are asserted in
  tests. (FR-012)
- **SC-013**: No new npm runtime dependency is introduced; no new
  network call is introduced; no new required user setting is added.
  (FR-013)
- **SC-014**: A test simulating "metadata cache not yet resolved"
  produces a well-formed not-ready result rather than throwing.
  (FR-014)

## Assumptions

- **Existing `search_content` is extended additively rather than
  renamed.** The tool keeps its name and its today-shaped output; new
  fields (a numeric `score` and per-match spans) are added, and a new
  `mode` argument opts into fuzzy or ranked-simple behavior. Regex
  mode remains identical. Rationale: renaming would churn the
  preamble, the renderer, and every downstream test for no material
  gain, and additive extension is what the SDK's tool schema supports
  cleanly.
- **`search_by_name` and `resolve_link` coexist.** `resolve_link` is
  for the exact-wikilink-target case; `search_by_name` is for the
  ranked-by-basename fuzzy case. Both remain registered.
- **`related_notes` uses a documented, deterministic signal set —
  shared tags, shared incoming links, shared outgoing links —
  weighted by simple counts.** Rationale: keeps the tool auditable
  and gives us a clear regression target; can be refined later if the
  model or the user finds it insufficient.
- **All new tools operate against `metadataCache` and
  `resolvedLinks`; a text-search tool additionally reads note bodies
  via `cachedRead` iterated serially to avoid the
  `Promise.all(files.map(cachedRead))` UI-freeze failure mode
  documented in the API research.**
- **Result caps live in one place per tool** (matching the existing
  `SEARCH_BY_TAG_CAP` / `SEARCH_BY_NAME_CAP` convention in
  `SearchTools.ts`), so future tuning is a single-file edit.
- **The v0.9 test suite remains the regression baseline.** No test
  in the existing 1560-test suite may be deleted or weakened as a
  result of this feature; new tests are additive.

## Scope

In Scope:
- Upgrading `search_content` with a `mode` argument (`substring` |
  `simple` | `fuzzy` | `regex`), a `score` field, and per-match
  spans. Legacy call shape (`{query, regex?}`) preserved.
- Six new read-only tools per FR-004 – FR-009 (`search_vault`,
  `resolve_link`, `get_outlinks`, `get_note_structure`,
  `related_notes`, and — implicit in `search_content` v2 — a
  fuzzy-mode capability).
- Preamble updates in `vaultToolManifest.ts` describing each new
  tool's shape and cheapest use case, and updated tests in
  `PreambleAssembler.test.ts`.
- Tests: unit tests per tool plus at least one seed-vault integration
  scenario per user story.
- Documentation updates in the plugin README and CHANGELOG.

Out of Scope:
- Any form of precomputed embedding / vector index. (See
  `proposals/0004-embeddings-vector-search.md`, rejected
  2026-07-06.)
- The Dataview inter-plugin tool. (Captured separately as
  `proposals/0011-dataview-query-tool.md`, PR #13.)
- New write tools; changes to any existing write tool.
- Programmatic invocation of Obsidian's built-in Search pane
  (`openGlobalSearch`) as a returnable tool. It doesn't yield results
  to callers and is out of the current tool-contract shape.
- Full-text indexing (e.g., MiniSearch à la Omnisearch). Only worth
  revisiting if `prepareSimpleSearch` proves too slow in practice.
- Cross-vault features (only one vault is loaded at a time by
  Obsidian).
- UI surfaces beyond what `MessageRenderer` already renders for tool
  results.

## Dependencies

- Obsidian public API surface: `prepareSimpleSearch`,
  `prepareFuzzySearch`, `renderMatches` / `renderResults` /
  `sortSearchResults`, `MetadataCache.getFileCache`,
  `MetadataCache.getFirstLinkpathDest`, `MetadataCache.resolvedLinks`,
  `getAllTags`, `TFile.stat`. (Verified in
  `proposals/0010-agent-native-vault-tools.md` research section
  against `obsidian.d.ts`.)
- Existing modules: `src/tools/VaultPath.ts` (path resolution),
  `src/tools/ObsidianApi.ts` (metadata-cache helpers),
  `src/domain/vaultToolManifest.ts` (inventory + hints),
  `src/domain/PreambleAssembler.ts` (preamble build + coverage test).
- No new npm dependency.

## Risks & Mitigations

- **Risk**: `prepareFuzzySearch` slows the UI on very large vaults.
  Impact: chat feels laggy while a fuzzy query scans thousands of
  notes.
  Mitigation: hard match cap identical to today's `SEARCH_BY_TAG_CAP`
  bounds the worst case; short-circuit early on high-score matches;
  yield to the event loop between file reads.
- **Risk**: Extending `search_content` additively drifts callers'
  understanding of the tool output over time.
  Mitigation: fields are additive; existing fields keep their names
  and types; tests assert both legacy and new fields on every call.
- **Risk**: `related_notes` produces low-value output on
  sparsely-linked vaults, causing the agent to spam it needlessly.
  Mitigation: preamble hint scopes the tool to "notes near this one"
  usage; documented signal set is deterministic and inspectable so
  regressions are obvious; return an empty result rather than falling
  back to an arbitrary set (SC per FR-009).
- **Risk**: The `metadataCache` staleness window at plugin load
  produces silently-wrong data if not handled.
  Mitigation: FR-014 requires an explicit "not-ready" response and
  SC-014 asserts it in tests; hook `metadataCache.on('resolved', ...)`
  during plugin bootstrap.
- **Risk**: `search_content` v2 subtly changes ranking of an existing
  scripted caller's use case.
  Mitigation: the default `mode` for `search_content` remains
  `substring` (unchanged behavior); ranked/fuzzy modes are opt-in via
  the new `mode` argument.

## References

- Proposal: `proposals/0010-agent-native-vault-tools.md` (PR #12)
- Companion proposal (deferred): `proposals/0011-dataview-query-tool.md`
  (PR #13)
- Rejected precursor: `proposals/0004-embeddings-vector-search.md`
- WorkflowContext: `.paw/work/agent-native-vault-tools/WorkflowContext.md`
