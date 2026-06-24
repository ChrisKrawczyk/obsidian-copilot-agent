# Feature Specification: Importable Preset Packs

**Branch**: feature/preset-packs  |  **Created**: 2026-06-23  |  **Status**: Draft (rev 2)
**Input Brief**: Implement proposal 0007 — make MCP server presets data, not code — and author the first internal pack (internal-organization M365) in a sibling private repo.

## Overview

Today the Obsidian Copilot Agent ships a single hardcoded built-in MCP
server preset (M365 Graph via `az` CLI). Anything else — partner
catalogs, internal corporate MCP bridges, per-tenant curations, even
the user's own polished set — must either land as code in the public
plugin or be re-typed by every user in every vault. The first option
forces internal tool details into a community plugin; the second
makes the long-tail of presets effectively impossible.

This feature turns presets into **importable data**. A *preset pack*
is a small JSON file containing one or more MCP server presets in the
same shape the plugin already builds internally. Users import packs
through the settings UI (file picker), and the imported presets appear
in the Add Server dropdown alongside the built-ins. Users can also
export currently-configured MCP servers back into a pack for sharing
or backup. Packs are pure data — they cannot execute code, they don't
auto-enable servers, and every command they declare still passes
through the existing safety prompts on first use.

Once this lands, organization-specific or environment-specific presets
(e.g. an internal CLI that proxies M365 products as individual stdio
MCP bridges) ship as a single JSON file on whatever distribution
channel the organization prefers, without touching plugin source. The
companion private repo `obsidian-copilot-presets-internal` is the
first such consumer: it will host packs for the products surfaced by
the user's internal MCP bridge CLI, one pack file per product, so
users import only the products they need.

## Objectives

- Let users add new MCP server presets to their vault without a plugin update or a code change (**Rationale:** unlocks tenant- and org-specific catalogs that can't ship in a community plugin).
- Preserve the single Add-Server experience: built-in and imported presets coexist in one dropdown, distinguishable but uniform in behavior.
- Make pack files round-trip: any pack the user can import, they can also produce by export from a configured set of servers.
- Keep packs strictly data — no executable surface, no auto-enable, no new credential variants in this slice.
- Maintain end-to-end safety: every command an imported preset declares is still subject to the existing first-run safety prompt.

## User Scenarios & Testing

### User Story P1 – Import a preset pack from a file

**Narrative.** A user receives a `.pack.json` file (downloaded from a
share, internal repo, or sent by a teammate). In Settings →
MCP servers, they click **Import pack from file…**, pick the JSON,
see a confirmation preview ("This pack adds 4 presets"), and confirm.
The pack's presets immediately appear in the Add Server dropdown,
grouped under the pack's label.

**Independent Test.** Author a minimal pack JSON with one preset for
a known stdio command. Import it. Open Add Server → confirm the new
preset is listed under the pack label and selecting it pre-fills the
form with the declared command and credentials.

**Acceptance Scenarios.**
1. Given a valid pack file, when the user imports it, then a preview dialog shows the pack label, version, source path, and the number of presets it adds.
2. Given the user confirms the import, when they open the Add Server dropdown, then the pack's presets appear, grouped under the pack's display label and visually distinguished from built-ins.
3. Given the user selects an imported preset, when the server form opens, then it is pre-filled identically to a built-in preset.

### User Story P2 – Manage installed packs

**Narrative.** The user can see which packs they've imported, when
each was imported, and where it came from. They can remove a pack at
any time, which removes its presets from the dropdown but does not
disturb any servers they already configured from those presets.

**Independent Test.** Import a pack, then configure a server from one
of its presets. Remove the pack. Verify the dropdown no longer lists
that preset but the configured server still works.

**Acceptance Scenarios.**
1. Given one or more imported packs, when the user opens Settings, then a list of imported packs is visible with label, version, source path, import time, and preset count for each.
2. Given an imported pack, when the user clicks **Remove pack**, then a confirmation asks them to confirm and notes that already-configured servers are unaffected.
3. Given the user removes a pack, when they reopen Add Server, then none of that pack's presets remain in the dropdown; existing servers configured from those presets continue to function.

### User Story P3 – Re-import a pack (update)

**Narrative.** A pack author publishes a new version of a pack. The
user re-imports it. The plugin detects the same pack `id`, computes a
diff against the existing version (presets added / removed / changed),
shows the diff for confirmation, and overwrites on confirmation.

**Independent Test.** Import a pack. Modify the pack JSON externally
(add one preset, change one preset's label, remove one preset).
Re-import. Verify the diff matches the changes and the dropdown
reflects the new content after confirmation.

**Acceptance Scenarios.**
1. Given a pack already imported with `id` X, when the user imports another pack with `id` X, then a diff confirmation dialog summarizes added/changed/removed presets.
2. Given the user confirms the re-import, when they open Add Server, then the dropdown reflects the new pack content (additions present, removals absent, changes applied).
3. Given the user cancels the re-import, when they open Add Server, then the previous pack content is preserved unchanged.

### User Story P4 – Export configured servers as a pack

**Narrative.** A user who has hand-configured a useful set of MCP
servers can select one or more of them and export them as a pack JSON
file. The exported file is a clean pack: runtime state (last error,
last token expiry, etc.) is stripped, the structural shape of each
server's configuration (transport, command, args, credential KIND) is
preserved, and any **secret-bearing fields** (bearer tokens, raw
credential commands, sensitive header values, environment variables)
are templatized — replaced with explicit "needs value" placeholders
so the recipient is prompted to provide their own values at the
point they configure a server from the imported preset. The exported
pack captures the SHAPE of a server, never its secret VALUES.

**Independent Test.** Configure two MCP servers in vault A — one
with non-secret credentials (e.g. `none` or `azure-cli-token`), one
with a static bearer token. Export both as a single pack file. Open
the JSON: the first preset preserves its credential config verbatim;
the second has its token field replaced by the templatized
placeholder. Import the pack into vault B. Selecting the first
preset pre-fills the form identically to vault A. Selecting the
second preset pre-fills everything EXCEPT the token field, which is
empty and marked as required.

**Acceptance Scenarios.**
1. Given one or more configured servers, when the user clicks **Export as preset pack**, then a file save dialog produces a JSON file whose schema validates against the same validator used for import.
2. Given an exported pack containing only non-secret credential kinds, when re-imported on another vault, then the resulting presets, when selected, pre-fill the server form with the original configurations (modulo any per-row runtime state).
3. Given a configured server has runtime-only fields (last refresh time, last error, etc.), when exported, then those fields are absent from the resulting pack JSON.
4. Given a configured server has secret-bearing credential fields (e.g. a static bearer token, a static header secret, a raw credential-command string, an environment variable holding a secret), when exported, then every such field is replaced with a templatized placeholder in the resulting pack JSON, and the original secret value never appears in the exported file.
5. Given a preset imported from a pack contains templatized credential placeholders, when the user selects it in the Add Server flow, then the server form pre-fills the structural fields and marks each placeholder field as a required input the user must supply before saving.

### User Story P5 – Author and consume the internal internal pack (out-of-band deliverable)

**Narrative.** In the sibling private repo
`obsidian-copilot-presets-internal`, one pack JSON per M365 product
exposed by the internal internal MCP bridge CLI (mail, calendar, files, teams,
…) is authored and committed. A user imports any subset of these
pack files into their vault. The internal-CLI-backed presets appear
in the Add Server dropdown alongside the built-in M365 Graph preset.
Selecting one configures a working stdio MCP server backed by the
internal CLI.

**Independent Test.** From the private repo, copy `mail.pack.json` to
disk. Import via the plugin UI. Open Add Server → select the Mail
preset → save the configured server → confirm a chat tool call hits
the mail MCP successfully (manual smoke test — not part of the public
test suite).

**Acceptance Scenarios.**
1. Given the private repo contains one pack JSON per internal-CLI-exposed M365 product, when each is imported, then each contributes one (or more) presets to the Add Server dropdown, grouped under that pack's label.
2. Given a configured server from an internal-pack preset, when the user runs a chat tool call against it, then the call succeeds end-to-end (manual verification).
3. Given the public plugin codebase, when audited, then no organization-specific identifiers (internal CLI binary names, internal URLs, internal contact aliases) appear anywhere in source, tests, docs, or settings.

### Edge Cases

- **Malformed JSON pack** (e.g. unclosed brace, trailing comma where strict JSON forbids it) — a single user-visible error names the offending field path (or, for parse-stage errors, line/column); nothing is imported.
- **Pack file is JSONC** (contains `//` comments) — rejected as malformed. The pack format is **strict JSON only**; the proposal example using `// ...` is illustrative, not a literal sample.
- **Schema-invalid pack** (extra unknown preset-level fields, missing required fields, wrong types) — same: single error, nothing imported, no partial state.
- **Pack JSON begins with a UTF-8 BOM** — the BOM is tolerated and stripped before parsing; the import proceeds normally.
- **Pack file is mid-write at the moment of import** (the author saves while the user picks it) — JSON parse fails, import errors out, user can retry.
- **Pack file is deleted or renamed between the file picker and the confirm step** — the import is aborted with a "source file no longer available" error; nothing is persisted.
- **Pack file exceeds soft size threshold (100 KB)** — import succeeds, but the confirm dialog shows a "large pack" notice.
- **Pack file exceeds hard size threshold (1 MB)** — rejected before parsing, with a "pack too large" error.
- **Pack contains a preset whose `id` collides with a built-in preset's id** — the imported preset is namespaced (effective id `<packId>.<presetId>`); the built-in preset's id is unchanged. The display label disambiguates with `(from <pack label>)`.
- **Pack contains a preset whose `id` collides with a preset already imported from another pack** — both presets remain visible; both are namespaced (`<thisPackId>.<presetId>` and `<otherPackId>.<presetId>`) so neither pack's presets shift identity when the other is added or removed.
- **Pack contains a preset whose `id` collides with another preset in the SAME pack** — rejected as malformed, single error citing the duplicated id.
- **Pack file containing zero presets** — rejected as malformed. A pack must declare at least one preset.
- **Preset id case-sensitivity across operating systems** — ids are treated as case-sensitive strings everywhere (comparison, namespacing, persistence). Two ids that differ only by case are considered distinct.
- **Removing a pack while a configured server from one of its presets is currently running** — the server keeps running; only the dropdown entry disappears.
- **Importing a pack whose declared command does not exist on the current OS** — the import succeeds; the preflight `installHint` surfaces when the user actually configures and tries to use the server (existing first-run preflight behavior applies).
- **Exporting a server whose preset came from a pack** — the export captures the server's current configuration as a fresh preset; it does NOT carry the original pack ancestry.
- **Pack schema version mismatch** (future field unknown to current plugin) — unknown TOP-LEVEL pack fields are ignored with a console warning; unknown PRESET-level fields are rejected at validation (no silent partial data loss for server configs).

## Requirements

### Functional Requirements

- **FR-001:** The plugin MUST accept a local JSON file as a preset pack via a file picker in the existing MCP servers settings surface. *(Stories: P1, P3)*
- **FR-002:** The plugin MUST validate an imported pack against a versioned pack schema and reject malformed packs with a single user-visible error citing the offending field path (or, for parse errors, line/column); no partial state is persisted. *(Stories: P1, P3)*
- **FR-003:** On successful import, the plugin MUST persist the pack (its full JSON, import timestamp, original source path, and pack id) in vault-local plugin settings. *(Stories: P1, P2, P3)*
- **FR-004:** The Add Server dropdown MUST present built-in and pack-sourced presets in a single list, grouped by source ("Built-in", "From <pack label>", per pack). *(Stories: P1, P5)*
- **FR-005:** Selecting an imported preset MUST pre-fill the server form identically to selecting a built-in preset of equivalent shape, with the exception of any secret-templatized fields which MUST be marked as required user input. *(Stories: P1, P4, P5)*
- **FR-006:** The plugin MUST list imported packs in the settings surface, showing each pack's label, version, source path, import time, and preset count. *(Story: P2)*
- **FR-007:** The plugin MUST allow the user to remove an imported pack from the settings surface, after explicit confirmation. *(Story: P2)*
- **FR-008:** Removing a pack MUST remove its presets from the Add Server dropdown but MUST NOT modify any existing configured servers. *(Story: P2)*
- **FR-009:** Re-importing a pack whose `id` matches an already-imported pack MUST present a diff (added / removed / changed presets) computed by structural comparison of canonical pack content (see FR-021) and persist only on user confirmation. *(Story: P3)*
- **FR-010:** Cancelling a re-import MUST leave the previously imported pack unchanged. *(Story: P3)*
- **FR-011:** The plugin MUST provide an "Export as preset pack" action that produces a pack JSON file from one or more user-configured MCP servers, omitting runtime-only state. *(Story: P4)*
- **FR-012:** An exported pack MUST validate against the same schema used to validate imports (round-trip property). *(Story: P4)*
- **FR-013:** Conflict namespacing rules: *(Stories: P1, P2)*
  - **a.** An imported preset whose `id` collides with a BUILT-IN preset's id is namespaced (effective id `<packId>.<presetId>`); the built-in preset's id is unchanged.
  - **b.** When two imported packs declare presets with the same `id`, BOTH presets are namespaced (`<thisPackId>.<presetId>`) so neither shifts identity when packs are added or removed.
  - **c.** Duplicate ids within a SINGLE pack are rejected at import (see Edge Cases).
  - **d.** Display labels for namespaced presets MUST disambiguate by appending `(from <pack label>)`.
- **FR-014:** Importing a pack MUST NOT auto-enable any of its presets as configured servers; the user must still explicitly add a server from each preset. *(Story: P1)*
- **FR-015:** Pack-declared `preflight` checks MUST behave identically to built-in preflight checks (non-fatal hints, same UI rendering). *(Story: P5)*
- **FR-016:** No code path triggered by pack import or pack rendering may execute, spawn, or evaluate any command declared in the pack; commands only run via the existing server-spawn path with its safety prompt. *(Story: P1)*
- **FR-017:** *(merged into Cross-Cutting Non-Functional — see "Reuse existing validation primitives" below.)*
- **FR-018:** *(merged into Cross-Cutting Non-Functional — see "Reuse existing UI conventions" below.)*
- **FR-019:** The companion private repo `obsidian-copilot-presets-internal` MUST contain one pack JSON per M365 product surfaced by the internal MCP CLI, each validating against the same schema. *(Story: P5)*
- **FR-020:** Server export MUST template-ize every secret-bearing field — i.e. fields that hold or could hold credential VALUES (bearer tokens, header secret values, raw credential-command strings, environment variables marked secret) — by replacing each such field with an explicit "needs value" placeholder. The exported pack JSON MUST never contain the original secret VALUES. The set of secret-bearing fields is determined by the credential KIND, not by content inspection. *(Story: P4)*
- **FR-021:** Pack diff and equality MUST be computed over a canonical form of the pack content: JSON key order normalized (lexicographic), whitespace collapsed, the persisted import metadata (timestamp, source path, internal record id) EXCLUDED from comparison. Two packs whose canonical forms are byte-equal are considered equal; otherwise the differing preset entries (by `id`) are surfaced as added / removed / changed in the diff. *(Stories: P3)*
- **FR-022:** The pack file format is strict JSON. JSON-with-comments (`//`, `/* */`) and other JSONC extensions are rejected at parse time. *(Cross-cutting, P1)*
- **FR-023:** Pack files larger than 1 MB MUST be rejected before parsing with a "pack too large" error; files larger than 100 KB MUST trigger a "large pack" notice in the confirm dialog but proceed. *(Cross-cutting, P1)*

### Key Entities

- **Preset Pack** — A JSON document with an `id`, `label`, `version`, optional `$schema` URI, and a non-empty list of `presets` (≥1). Stored verbatim in plugin settings, alongside its import metadata, under a dedicated settings key.
- **Imported Pack Record** — The persisted form of an imported pack: the pack JSON plus import timestamp, source path, and a stable internal record id.
- **Preset (as packed)** — A direct serialization of the existing in-code preset build output: `id`, `label`, `description`, `server`, `credentials`, optional `preflight`. No new fields beyond what the in-code preset already exposes.

### Cross-Cutting / Non-Functional

- **Privacy / leak prevention**: This work bridges a public repo and a private companion repo. The PUBLIC repo (source, tests, fixtures, snapshot data, sample packs, documentation, screenshots, CHANGELOG entries, CI run output, logs surfaced by tests, in-repo PAW artifacts) MUST remain free of organization-specific identifiers (internal CLI binary names, internal hostnames, internal documentation URLs, internal contact aliases, tenant identifiers, personal filesystem paths). Real pack content for internal organizations lives only in the PRIVATE repo. Sample packs used in public tests/fixtures MUST use generic placeholder values (e.g. `internal-mcp-cli`, `example.org`).
- **Reversibility**: Every state change made by pack management (import, re-import, remove) is reversible by undoing the inverse action without manual settings file editing.
- **No new runtime trust surface**: Pack data flows are restricted to schema validation and settings persistence; no fetch, exec, or eval.
- **Settings performance**: Pack JSONs within the size envelope of FR-023 MUST not increase settings-tab open or save latency by more than 200 ms (measured on the developer's reference workstation; specific hardware noted alongside the measurement).
- **No new schema-library dependency**: The plugin already validates credential and form input without a JSON-schema dependency; pack validation MUST be implementable with the same approach. (Constraint, not a directive on a specific module.)
- **Reuse existing UI conventions**: Pack-management UI surfaces MUST be implementable within the plugin's existing settings UI conventions and primitives. No new UI framework or component library may be introduced for this feature. (Constraint, not a directive on specific components.)

## Success Criteria

- **SC-001:** A user with a valid pack JSON file can import it through the settings UI in fewer than four clicks (open Settings → Import pack from file → pick file → Confirm); imported presets are visible in the Add Server dropdown immediately on confirm. *(FR-001, FR-003, FR-004)*
- **SC-002:** A pack containing 1, 5, and 20 presets each round-trips through export → import without loss for all NON-SECRET fields: the resulting server form pre-fill is byte-for-byte identical for every non-secret field of every preset; secret-bearing fields exported as templatized placeholders are surfaced as required form input on import. *(FR-005, FR-011, FR-012, FR-020)*
- **SC-003:** A pack with a deliberately malformed field (missing required, wrong type, unknown preset-level field, comment in JSON, BOM only — covered separately) yields exactly one user-visible error message naming the offending field path or parse location, and nothing is persisted to settings. *(FR-002, FR-022)*
- **SC-004:** After removing an imported pack, zero of its presets remain in the Add Server dropdown, while 100% of servers previously configured from those presets continue to start, accept requests, and respond identically to before the pack removal. *(FR-007, FR-008)*
- **SC-005:** For each pack JSON authored in the private companion repo (one per internal-CLI-exposed M365 product), importing the pack into a vault, configuring a server from one of its presets, and issuing at least one chat tool call against that server completes successfully (manual smoke verification, recorded as a checklist in the private repo's README). *(FR-019, P5)*
- **SC-006:** Importing a pack JSON whose declared command does not exist on the current OS still succeeds; the install hint surfaces only when the user actually tries to use a server configured from one of its presets. *(FR-015)*
- **SC-007:** Re-importing a pack file whose canonical form (FR-021) is identical to the already-imported pack shows an empty diff and updates only the import timestamp; re-importing a pack file whose canonical form differs surfaces a non-empty diff itemizing added / removed / changed preset ids. *(FR-009, FR-021)*
- **SC-008:** Pack files between 100 KB and 1 MB import successfully (with a "large pack" notice in the confirm dialog); files above 1 MB are rejected before parse with a "pack too large" error. *(FR-023)*
- **SC-009:** An exported pack containing only non-secret credential kinds (`none`, `azure-cli-token`) imports on a different machine and yields servers that function identically without any user-supplied credential input. An exported pack containing secret-bearing credential kinds yields presets whose form pre-fill marks every secret field as a required user input before save. *(FR-005, FR-020)*

## Assumptions

- The existing in-code preset build output shape is stable enough to serve as the v1 pack schema directly; future schema changes use the pack's `version` field plus tolerant unknown-top-level-field handling.
- The plugin settings store can hold a pack within the FR-023 size envelope without performance impact; existing storage already holds vault-scoped, similarly sized config.
- Users authoring packs are technical enough to hand-edit JSON or use the export feature; no pack-authoring UI in v1.
- Internal-pack consumption is a smoke-test exercise, not a unit-test exercise — the public test suite stays free of internal MCP commands and identifiers.
- Re-import diff is structural over canonical JSON; semantic diff (e.g. "label changed, command unchanged" highlighted separately) is not required in v1.
- Leak prevention in the public repo is enforced by code review and developer discipline; there is no automated CI gate for internal-identifier patterns, because the pattern list itself would constitute a leak.

## Scope

**In Scope:**
- File-based pack import via Settings UI
- Pack validation against a versioned schema
- Listing and removing imported packs from Settings
- Re-import with structural-diff confirmation
- Export of one or more configured servers as a pack file, with secret-templatization
- Namespacing of conflicting preset ids per FR-013 rules
- Grouping by source in the Add Server dropdown
- Authoring one M365 product pack per internal-CLI-exposed product in `obsidian-copilot-presets-internal`
- Updating in-repo documentation (`docs/`, `README.md`, `CHANGELOG.md`) to describe pack import/export

**Out of Scope:**
- URL-based pack import (deferred — proposal open question on checksum trust model)
- Automated CI grep audit for internal-identifier leaks (rejected: the pattern list would itself leak; relies on code review instead)
- Central preset marketplace / discovery service
- Cryptographic signing of packs
- Auto-update of imported packs from their source URL
- Per-preset disable within an imported pack (packs remain atomic)
- Per-platform preset filtering / `platforms: ["win32", …]` field
- New credential variants (e.g. real `oauth-pkce`); the pack format reflects what's already shippable today
- Per-server tool subset selection (covered by proposal 0006)
- A pack-authoring UI in the plugin
- Automated end-to-end tests against the internal MCP bridge servers in CI

## Dependencies

- Predecessor work shipped in v0.7.0 (`authenticated-mcps`) — established the in-code preset registry and the credential discriminated-union shape that the pack schema serializes; established the validation primitives the pack validator reuses.
- Existing Settings → MCP servers section as the host UI surface.
- Existing safety prompt at first command spawn (no change required, just relied upon).
- A separate private GitHub repo (`obsidian-copilot-presets-internal`) for authoring and distributing the internal internal packs — not in the public source tree.

## Risks & Mitigations

- **Risk:** Internal identifiers leak into the public repo (the v0.7.0 failure mode). **Mitigation:** Leak prevention is treated as a code-review responsibility. The reviewer (and the author) explicitly scan diffs for internal-identifier patterns (binary names, hostnames, URLs, contact aliases, tenant identifiers) before merge. The cross-cutting privacy NFR enumerates the public surfaces that must remain clean. Decision rationale documented under Out of Scope (automated audit rejected because the pattern list itself would constitute a leak).
- **Risk:** Pack format drift between in-code preset shape and the persisted pack schema. **Mitigation:** Built-in presets are themselves expressed as a pack-shape that the same validator accepts; any drift fails the built-in load path immediately during normal startup.
- **Risk:** Settings UI complexity creep — pack listing, diff dialog, conflict labels, source-grouped dropdown — destabilizes the settings render. **Mitigation:** Limit each new UI surface to existing primitives; phase the work so the dropdown grouping (UI-visible everywhere) ships before re-import diff (rarely exercised).
- **Risk:** Validator allows silent partial data loss when packs declare unknown preset-level fields (future schema). **Mitigation:** Preset-level unknown fields are a hard reject in v1; only top-level pack fields are tolerantly ignored, with console warning (Edge Cases + FR-002 + Pack schema version mismatch case).
- **Risk:** Diff computation for re-import flags semantically equivalent packs as "changed" because key order differs. **Mitigation:** FR-021 mandates canonical-form comparison; SC-007 explicitly tests the no-change case.
- **Risk:** Internal pack authoring is blocked because the internal CLI's argument shapes aren't yet known to the pack author. **Mitigation:** Author the packs by first configuring one server per product by hand, then exporting (User Story P4) to bootstrap the pack JSON; refine in the private repo.
- **Risk:** Export feature scope expands to "pack-authoring tool" with template editing, metadata fields, etc. **Mitigation:** v1 export is one-shot: pick servers → produce file. No in-app editing of the output.
- **Risk:** Exported pack contains secret values despite FR-020 (e.g. a future credential kind ships before its export branch is updated). **Mitigation:** Secret templatization is gated by credential KIND, not by content inspection; new credential kinds default to "treat all fields as secret" until explicitly classified, so the failure mode is "field gets templatized when it didn't need to be," not "secret leaks."

## References

- Proposal: `proposals/0007-importable-preset-packs.md`
- Predecessor work: `proposals/0005-mcp-slice7-followup.md`; v0.7.0 release (`authenticated-mcps`)
- Tangent: `proposals/0006-tool-picker-and-scope-aware-credentials.md`
- Companion private repo: `obsidian-copilot-presets-internal` (PRIVATE)
- WorkflowContext: `.paw/work/preset-packs/WorkflowContext.md`

