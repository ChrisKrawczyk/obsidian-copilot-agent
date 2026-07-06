# Feature Specification: Agent-native vault navigation tools

**Branch**: `feature/agent-native-vault-tools`  |  **Created**: 2026-07-06  |  **Status**: Draft
**Input Brief**: Give the agent stronger vault-navigation tools grounded in Obsidian's public plugin API, in preference to adding a precomputed embedding index.

## Overview

The Obsidian Copilot agent already helps users find notes by tag, by
name, by backlink, by recent modification, and by task status, and can
inspect any note's metadata. What it does *not* yet do well is answer
the most common vault question — "where did I write about X?" — when
the answer isn't a literal phrase the user remembers. The agent's
current text search returns up to fifty unranked line hits in
whatever order the vault iteration happens to yield; it cannot
tolerate typos or rearranged wording; it has no direct way to follow
a wikilink from one note to another in a single step; and it cannot
compose the "text × tag × folder × recently modified" filter that a
human answers with a five-second query in the Obsidian search bar.

The strategic bet is that stronger navigation for the agent, using
the same signals a human uses when reading their own notes, is a
better investment than an opaque similarity index. The user's
observable result: shorter, more accurate answers to vault questions,
with fewer wrong-note detours; a natural experience following
`[[wiki-links]]`; and the ability to phrase questions the way a
person would ("things I wrote about sunset last week under Work/")
without having to translate them into a sequence of separate searches.

## Objectives

- The agent can find notes about a topic even when the query wording
  and note wording don't match verbatim.
- The agent can tolerate small typos and word-order differences in
  the user's query.
- The agent can answer questions that combine topical, structural,
  and time filters in a single step, rather than a multi-turn
  intersection.
- The agent can move from a wiki-link mention to the linked note in
  a single action, mirroring the user's own click.
- The agent can decide whether a note is likely to contain the
  answer *before* reading its full body, by inspecting the note's
  outline.
- The agent can offer "notes near this one" for a source note
  without any first-run indexing or model-provider round-trip.
- Adding these capabilities does not add a first-run indexing step,
  a required user setting, or a new external service the plugin
  depends on.

## User Scenarios & Testing

### User Story P1 – "Where did I write about X?" answered from a fuzzy query

Narrative: A user with a several-thousand-note vault asks the agent
"find my notes about weakly typed languages" — the notes actually use
"weakly-typed" (hyphenated). The agent runs a single ranked text search
whose top result is the intended note, cites its path in the
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
my vault relates to this?" Without any embeddings, the agent produces
a bounded, ranked list of notes that share the most tags, incoming
links,
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

- **Very large vaults**: search modes that are documented as
  computationally expensive must not freeze the UI thread and must
  respect the same result-size caps that already exist for the
  plugin's other read-only search tools.
- **Vault metadata not fully loaded yet**: any tool that depends on
  Obsidian's resolved metadata (link graph, tag index, note outline)
  must return a well-formed "not ready" response — not throw and not
  return silently wrong data — until Obsidian has finished its
  initial resolution pass.
- **Legacy behavior of existing text search**: existing callers of
  the current text-search tool may pass a regex today; the upgraded
  tool must preserve that behavior identically for those callers.
- **A wikilink Obsidian itself resolves ambiguously** (for example,
  two notes sharing the same basename in different folders): the
  resolution tool returns whatever Obsidian's own resolver picks,
  without inventing a different tiebreaker.
- **Compound query with an impossible combination** (for example, a
  tag filter and a folder filter with no intersection): the tool
  short-circuits without reading any note bodies and returns an
  empty result.
- **Very large notes**: structural inspection returns outline
  information only, and returns none of the note's body prose, at
  any note size.
- **Windows path separators**: all path-shaped inputs and outputs
  remain vault-relative in the same normalized form the plugin
  already produces for its existing read tools.

## Requirements

### Functional Requirements

- **FR-001**: A ranked text-search mode is available where results
  are returned in a documented, stable ordering by relevance rather
  than filesystem/enumeration order. (Stories: P1)
- **FR-002**: A fuzzy text-search mode is available that returns
  matches for queries that differ from the target by typos or by
  rearranged word order. (Stories: P1)
- **FR-003**: The existing text-search regex behavior is preserved
  so that existing callers do not observe a change in output for the
  same input. (Stories: P1)
- **FR-004**: A compound-query capability is available that accepts,
  at minimum, tag membership, folder-prefix, modified-since, and
  free-text filters combined with AND semantics. (Stories: P2)
- **FR-005**: A compound query whose structural filters (tag, folder,
  or modified-since) exclude the entire vault does not perform any
  note-body read. (Stories: P2)
- **FR-006**: The agent can resolve a wiki-link expression (plus the
  source note in which it appears) to the target note's
  vault-relative path in one step, using the same resolution rule
  Obsidian itself applies when the user clicks the link. (Stories: P3)
- **FR-007**: The agent can retrieve the outgoing links of a given
  note in one step, and the response distinguishes wikilinks from
  Markdown links. (Stories: P3)
- **FR-008**: The agent can retrieve a note's outline — the sequence
  of headings with their nesting level, section boundaries, and any
  block identifiers — without receiving the note's body prose in the
  same response. (Stories: P4)
- **FR-009**: The agent can retrieve a bounded, ranked list of notes
  related to a source note, ranked by at least the following
  signals: shared tags, shared outgoing links, and shared incoming
  links. (Stories: P5)
- **FR-010**: All new capabilities added under this feature are
  purely read-only against the vault and are invoked without a
  per-invocation user prompt, matching the auto-approval behavior of
  the plugin's existing read-only vault search capabilities.
  (Stories: P1, P2, P3, P4, P5)
- **FR-011**: The instructions the agent receives at session start
  teach it which capability is the cheapest fit for each shape of
  question introduced by this feature. (Stories: P1, P2, P3, P4, P5)
- **FR-012**: Every new capability has a documented maximum result
  size and, when that cap is hit, its response indicates that the
  result was truncated. (Stories: P1, P2, P5)
- **FR-013**: This feature does not introduce a persistent index of
  vault content, a new runtime network dependency, or a new required
  user setting. (Cross-cutting; supports all stories P1–P5 by
  keeping the feature usable on any vault out of the box.)
- **FR-014**: When Obsidian's initial vault-metadata resolution has
  not completed, capabilities that depend on that metadata return a
  well-formed "not-ready" response and do not throw. (Stories: P3,
  P4, P5)

### Key Entities

- **Ranked match**: a search result carrying at least a target note's
  vault-relative path, a numeric relevance score with documented
  ordering semantics, and — where applicable — line-level snippets
  with the character offsets of the matched text.
- **Compound query filter set**: a set of AND-combined filters over
  tag membership, folder-prefix, modification-since timestamp, and
  free-text.
- **Note outline**: the sequence of a note's headings (with nesting
  level), section boundaries, and block identifiers — *without* the
  note's body prose.
- **Related-notes signal set**: the collection of signals — shared
  tags, shared outgoing links, and shared incoming links — used to
  rank vault neighbours of a source note.

### Cross-Cutting / Non-Functional

- All new read capabilities are invoked without a per-call user
  approval prompt, matching the auto-approval behavior the plugin
  already applies to its existing read-only vault searches.
- Path handling for any new capability normalises paths using the
  same rules the plugin already applies to its existing read-only
  vault tools, so that vault-escape resistance and Windows/POSIX
  normalization behavior are inherited rather than reintroduced.
- Existing read capabilities that this feature does not upgrade
  remain available and unchanged in name and output shape; the
  upgrade to text search extends the current tool's output rather
  than replacing it with a differently-named capability.

## Success Criteria

- **SC-001**: On a seed vault constructed for this test, a ranked
  text search for a two-word query returns a note that contains the
  words in a rearranged form ranked strictly above a note that
  contains only one of the two words. (FR-001)
- **SC-002**: On the same seed vault, a fuzzy text search for a
  query with one transposed character in a five-character word
  returns the intended target note in the top three results.
  (FR-002)
- **SC-003**: For every existing text-search call shape recorded in
  the plugin's regression suite prior to this feature, the tool
  returns the same set of match records — same paths, same line
  numbers, same snippet substrings — after this feature ships.
  (FR-003)
- **SC-004**: On a seed vault, a compound query composed of a tag
  filter, a folder-prefix filter, a modified-since filter, and a
  free-text filter returns exactly the set of notes that satisfy all
  four filters (verified by the test enumerating that set
  explicitly). (FR-004)
- **SC-005**: On a seed vault instrumented to count note-body reads,
  a compound query whose structural filters exclude every note
  performs zero note-body reads and returns an empty result.
  (FR-005)
- **SC-006**: For a wikilink whose target note exists and is
  unambiguous in the seed vault, the resolution capability returns
  that target's vault-relative path. For an unresolvable wikilink,
  it returns a documented "unresolved" response and does not throw.
  (FR-006)
- **SC-007**: For a seed-vault note that contains one wikilink and
  one Markdown link to distinct targets, the outlink capability
  returns two entries whose link-kind fields identify each target as
  a wikilink or Markdown link respectively. (FR-007)
- **SC-008**: For a seed-vault note whose body prose contains a
  unique sentinel string, the outline capability's returned payload
  for that note does not contain the sentinel string. (FR-008)
- **SC-009**: For a source note that shares three tags with note A
  and one tag with note B (with all other similarity signals equal
  in the seed vault), the related-notes capability ranks A strictly
  above B. (FR-009)
- **SC-010**: For every capability introduced by this feature, the
  agent invokes it in a session end-to-end test without the plugin
  emitting a user-approval prompt. (FR-010)
- **SC-011**: In a session-startup end-to-end test, the instructions
  the agent receives include one distinguishable usage-hint line per
  new capability introduced by this feature. (FR-011)
- **SC-012**: Every new capability has a documented maximum result
  count. On a seed vault engineered to exceed each cap, the response
  contains that cap's number of results and a truncation indicator
  distinguishable from a non-truncated response. (FR-012)
- **SC-013**: The plugin's manifest and lockfile lists show no net
  new runtime dependency, and the plugin's setting surface exposes
  no new required setting, when this feature is shipped. (FR-013)
- **SC-014**: In a test that simulates Obsidian not having completed
  its initial metadata resolution, every capability that depends on
  that metadata returns a documented "not-ready" response and does
  not throw. (FR-014)

## Assumptions

- **The existing text-search capability is extended in place rather
  than renamed.** Its current inputs and outputs continue to work
  unchanged for existing callers; new inputs and new output fields
  are added on top. Rationale: renaming would churn every downstream
  test and message-renderer path for no material user benefit, and
  additive extension is the least disruptive way to add ranked and
  fuzzy modes.
- **The existing name-search capability and the new wikilink-resolution
  capability coexist.** Wikilink resolution serves the exact-target
  case; name search serves the fuzzy-basename case; both remain
  available to the agent.
- **"Related notes" is ranked by a documented, deterministic signal
  set — shared tags, shared outgoing links, and shared incoming
  links, weighted by simple counts.** Rationale: keeps the behavior
  auditable and gives a clear regression target; the weights can be
  tuned later if the model or the user finds the ranking
  unsatisfying, without changing the observable contract.
- **New capabilities operate against Obsidian's already-resolved
  vault metadata; a text-search capability additionally reads note
  bodies, and it does so serially so as not to overwhelm the UI
  thread on large vaults.**
- **Each capability's maximum result count is defined in a single
  location per capability**, matching the pattern already used for
  the plugin's existing read-only search caps, so that future tuning
  is a single-file edit.
- **The plugin's current regression test suite is the baseline no
  test in that suite is deleted or weakened as a result of this
  feature; new tests are additive.

## Scope

In Scope:
- Extending the existing vault text search with a mode selector so
  callers can opt into ranked-simple or fuzzy behavior in addition to
  the current substring and regex behavior, plus a numeric relevance
  score and per-match character spans on results.
- A new compound-query capability supporting AND-combined tag,
  folder-prefix, modified-since, and free-text filters (FR-004).
- New capabilities for wikilink resolution (FR-006), outgoing-link
  discovery (FR-007), outline inspection (FR-008), and related-notes
  ranking (FR-009).
- Updates to the agent's session-start instructions so that each new
  capability has a usage hint (FR-011).
- Tests: unit-level coverage for each new capability plus at least
  one seed-vault integration scenario per user story.
- Documentation updates in the plugin README and CHANGELOG.

Out of Scope:
- Any form of precomputed embedding or vector index. (See
  `proposals/0004-embeddings-vector-search.md`, rejected 2026-07-06.)
- Integration with the Dataview community plugin. (Captured
  separately as `proposals/0011-dataview-query-tool.md`, PR #13.)
- New or changed write capabilities.
- Programmatic invocation of Obsidian's built-in Search pane. It
  does not yield results to callers and does not fit the
  return-results-to-the-model contract this feature is built around.
- Full-text indexing. Only worth revisiting if the base capabilities
  prove too slow in practice.
- Cross-vault features.
- New UI surfaces beyond what the plugin's message renderer already
  renders for tool results.

## Dependencies

- Obsidian's public plugin API surface for search helpers, metadata
  cache, resolved-link graph, and file stat information, as
  inventoried in `proposals/0010-agent-native-vault-tools.md`
  against the current `obsidian.d.ts`.
- No new npm runtime dependency (FR-013).

## Risks & Mitigations

- **Risk**: Fuzzy search runs slowly on very large vaults.
  Impact: chat feels laggy while a fuzzy query scans thousands of
  notes.
  Mitigation: apply the same result-size cap the plugin's existing
  read-only searches already use; short-circuit once the cap is
  reached; yield to the UI thread between note reads.
- **Risk**: Extending the existing text search additively drifts
  callers' understanding of the output over time.
  Mitigation: existing output fields keep their names, positions,
  and types; new fields are additive; regression tests assert both
  legacy and new fields on every call. (SC-003.)
- **Risk**: Related-notes ranking produces low-value output on
  sparsely-linked vaults, and the agent invokes it anyway.
  Mitigation: the session-start usage hint scopes the capability to
  the "notes near this one" question; the ranking signals are
  documented and deterministic so unexpected orderings are
  reproducible; the capability returns an empty result rather than
  falling back to an arbitrary set. (FR-009, SC-009.)
- **Risk**: Vault metadata may not have finished its initial
  resolution when the agent invokes a metadata-dependent capability.
  Mitigation: FR-014 requires a well-formed not-ready response and
  SC-014 asserts it.
- **Risk**: The upgraded text search subtly changes ranking of an
  existing scripted caller's use case.
  Mitigation: the default mode of the text-search capability
  preserves current behavior; ranked and fuzzy modes are opt-in via
  the new mode input. (SC-003.)

## References

- Proposal: `proposals/0010-agent-native-vault-tools.md` (PR #12)
- Companion proposal (deferred): `proposals/0011-dataview-query-tool.md`
  (PR #13)
- Rejected precursor: `proposals/0004-embeddings-vector-search.md`
- WorkflowContext: `.paw/work/agent-native-vault-tools/WorkflowContext.md`
