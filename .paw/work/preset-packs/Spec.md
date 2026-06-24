# Feature Specification: Importable Preset Packs

**Branch**: feature/preset-packs  |  **Created**: 2026-06-23  |  **Status**: Draft
**Input Brief**: Implement proposal 0007 — make MCP server presets data, not code — and author the first internal pack (agency M365) in a sibling private repo.

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
first such consumer: it will host packs for the internal agency MCP
bridges across the full M365 surface, one pack file per product, so
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
file. The exported file is a clean pack — runtime state (last error,
last token expiry, etc.) is stripped, the server configurations are
templatized in the same shape an authored pack would have, and the
file can be re-imported on a different vault or machine to reproduce
the same set of presets.

**Independent Test.** Configure two MCP servers manually in vault A.
Export them as a single pack file. Import the pack into vault B on a
different machine. Verify the two presets appear in vault B and
selecting them pre-fills the form identically to vault A.

**Acceptance Scenarios.**
1. Given one or more configured servers, when the user clicks **Export as preset pack**, then a file save dialog produces a JSON file whose schema validates against the same validator used for import.
2. Given an exported pack, when re-imported on another vault, then the resulting presets, when selected, pre-fill the server form with the original configurations (modulo any per-row runtime state).
3. Given a configured server has runtime-only fields (last refresh time, last error, etc.), when exported, then those fields are absent from the resulting pack JSON.

### User Story P5 – Author and consume the internal agency pack (out-of-band deliverable)

**Narrative.** In the sibling private repo
`obsidian-copilot-presets-internal`, one pack JSON per M365 product
exposed by the internal agency MCP CLI (mail, calendar, files, teams,
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
1. Given the private repo contains one pack JSON per agency-exposed M365 product, when each is imported, then each contributes one (or more) presets to the Add Server dropdown, grouped under that pack's label.
2. Given a configured server from an agency-pack preset, when the user runs a chat tool call against it, then the call succeeds end-to-end (manual verification).
3. Given the public plugin codebase, when audited, then no agency-specific identifiers (internal CLI name, internal URLs, internal contact aliases) appear anywhere in source, tests, docs, or settings.

### Edge Cases

- **Malformed JSON pack** — a single user-visible error names the offending field path; nothing is imported.
- **Schema-invalid pack** (extra unknown fields, missing required fields, wrong types) — same: single error, nothing imported, no partial state.
- **Pack contains a preset whose `id` collides with a built-in preset's id** — the imported preset is namespaced with the pack id (effective id `<packId>.<presetId>`); the display label disambiguates with `(from <pack label>)`.
- **Pack contains a preset whose `id` collides with a preset already imported from a different pack** — same namespacing applies; both presets remain visible, each grouped under its own pack label.
- **Pack file containing zero presets** — accepted, but a warning notes the pack added nothing visible.
- **Pack file containing duplicate preset ids within itself** — rejected as malformed, single error citing the duplicated id.
- **Removing a pack while a configured server from one of its presets is currently running** — the server keeps running; only the dropdown entry disappears.
- **Importing a pack whose declared command does not exist on the current OS** — the import succeeds; the preflight `installHint` is surfaced when the user actually configures and tries to use the server (FR-018 in authenticated-mcps applies).
- **Exporting a server whose preset came from a pack** — the export captures the server's current configuration as a fresh preset; it does NOT carry the original pack ancestry.
- **Pack JSON file > 1 MB** — accepted; warn user (suspiciously large pack is usually a mistake).
- **Pack schema version mismatch** (future field unknown to current plugin) — unknown top-level fields ignored with a console warning; unknown preset-level fields rejected at validation (no silent partial data loss for server configs).

## Requirements

### Functional Requirements

- **FR-001:** The plugin MUST accept a local JSON file as a preset pack via a file picker in Settings → MCP servers. *(Stories: P1, P3)*
- **FR-002:** The plugin MUST validate an imported pack against a versioned pack schema and reject malformed packs with a single user-visible error citing the offending field path; no partial state is persisted. *(Stories: P1, P3)*
- **FR-003:** On successful import, the plugin MUST persist the pack (its full JSON, import timestamp, original source path, and pack id) in vault-local plugin settings. *(Stories: P1, P2, P3)*
- **FR-004:** The Add Server dropdown MUST present built-in and pack-sourced presets in a single list, grouped by source ("Built-in", "From <pack label>", per pack). *(Stories: P1, P5)*
- **FR-005:** Selecting an imported preset MUST pre-fill the server form identically to selecting a built-in preset of equivalent shape. *(Stories: P1, P4, P5)*
- **FR-006:** The plugin MUST list imported packs in Settings, showing each pack's label, version, source path, import time, and preset count. *(Story: P2)*
- **FR-007:** The plugin MUST allow the user to remove an imported pack from Settings, after explicit confirmation. *(Story: P2)*
- **FR-008:** Removing a pack MUST remove its presets from the Add Server dropdown but MUST NOT modify any existing configured servers. *(Story: P2)*
- **FR-009:** Re-importing a pack whose `id` matches an already-imported pack MUST present a diff (added / removed / changed presets) and persist only on user confirmation. *(Story: P3)*
- **FR-010:** Cancelling a re-import MUST leave the previously imported pack unchanged. *(Story: P3)*
- **FR-011:** The plugin MUST provide an "Export as preset pack" action that produces a pack JSON file from one or more user-configured MCP servers, omitting runtime-only state. *(Story: P4)*
- **FR-012:** An exported pack MUST validate against the same schema used to validate imports (round-trip property). *(Story: P4)*
- **FR-013:** The plugin MUST namespace preset ids that collide with built-in ids or with another pack's preset ids by prefixing the pack id, and MUST disambiguate display labels with the source pack label. *(Stories: P1, P2)*
- **FR-014:** Importing a pack MUST NOT auto-enable any of its presets as configured servers; the user must still explicitly add a server from each preset. *(Story: P1)*
- **FR-015:** Pack-declared `preflight` checks MUST behave identically to built-in preflight checks (non-fatal hints, same UI rendering). *(Story: P5)*
- **FR-016:** No code path triggered by pack import or pack rendering may execute, spawn, or evaluate any command declared in the pack; commands only run via the existing server-spawn path with its safety prompt. *(Story: P1)*
- **FR-017:** Pack validation MUST be implemented using the same hand-rolled primitives already used for `ServerCredentials` validation; no new schema-library dependency MAY be introduced. *(Cross-cutting)*
- **FR-018:** All user-visible UI surface (settings rows, dropdown labels, error messages, dialogs) for pack management MUST be implemented in the existing settings code style and reuse existing form/dialog primitives — no new framework or UI library. *(Cross-cutting)*
- **FR-019:** The companion private repo `obsidian-copilot-presets-internal` MUST contain one pack JSON per M365 product surfaced by the internal agency MCP CLI, each validating against the same schema. *(Story: P5)*
- **FR-020:** The public `obsidian-copilot-agent` repo, after this work, MUST contain zero references to internal-specific CLI names, internal hostnames, internal documentation URLs, or internal contact aliases — verified by a grep audit before the final PR. *(Story: P5, cross-cutting)*

### Key Entities

- **Preset Pack** — A JSON document with an `id`, `label`, `version`, optional `$schema` URI, and a non-empty list of `presets`. Stored verbatim in plugin settings under `mcp.presetPacks` alongside its import metadata.
- **Imported Pack Record** — The persisted form of an imported pack: the pack JSON plus import timestamp, source path, and a stable internal record id.
- **Preset (as packed)** — A direct serialization of the existing `McpServerPreset` build output: `id`, `label`, `description`, `server`, `credentials`, optional `preflight`. No new fields beyond what the in-code preset already exposes.

### Cross-Cutting / Non-Functional

- **Privacy / leak prevention**: The public plugin codebase remains free of internal-only identifiers across source, tests, docs, fixtures, and proposal text.
- **Reversibility**: Every state change made by pack management (import, re-import, remove) is reversible by undoing the inverse action without manual settings file editing.
- **No new runtime trust surface**: Pack data flows are restricted to schema validation and settings persistence; no fetch, exec, or eval.
- **Settings size**: Pack JSONs of typical size (≤100 presets, ≤100 KB) MUST not visibly degrade settings open/save latency.

## Success Criteria

- **SC-001:** A user with a valid pack JSON file can import it through the settings UI and see its presets in the Add Server dropdown in fewer than four clicks total (Open Settings → Import pack from file → pick file → Confirm). *(FR-001, FR-003, FR-004)*
- **SC-002:** A pack containing 1, 5, and 20 presets each round-trips through export → import without loss: the resulting server form pre-fills are byte-for-byte identical for every preset. *(FR-005, FR-011, FR-012)*
- **SC-003:** A pack with a deliberately malformed field (missing required, wrong type, unknown preset-level field) yields exactly one user-visible error message naming the offending field path, and nothing is persisted to settings. *(FR-002)*
- **SC-004:** After removing an imported pack, zero of its presets remain in the Add Server dropdown, while 100% of servers previously configured from those presets continue to function unchanged. *(FR-007, FR-008)*
- **SC-005:** Importing the four+ M365 product packs from the internal private repo (mail, calendar, files, teams, …) yields working stdio MCP server configurations for each, confirmed by at least one successful chat tool call against each configured server (manual verification, captured in a checklist on the private repo's README). *(FR-019, P5)*
- **SC-006:** A grep audit of the public repo (executed in CI or pre-merge) finds zero occurrences of the agreed internal-identifier patterns (internal CLI name, internal URLs, internal contact aliases) anywhere outside `.git/` and ignored paths. *(FR-020)*
- **SC-007:** Importing a pack JSON whose declared command does not exist on the current OS still succeeds, and the install hint surfaces only when the user actually tries to use a server configured from one of its presets. *(FR-015)*
- **SC-008:** Re-importing the same pack file with no changes shows an empty diff ("no changes") and persists nothing new beyond an updated import timestamp. *(FR-009)*

## Assumptions

- The existing `McpServerPreset` build output shape is stable enough to serve as the v1 pack schema directly; future schema changes will use the pack's `version` field plus tolerant unknown-field handling.
- The plugin settings store can hold a pack of typical size (≤100 presets, ≤100 KB JSON) without performance impact; existing storage already holds vault-scoped, similarly sized config.
- Users authoring packs are technical enough to hand-edit JSON or use the export feature; we do not need a pack-authoring UI in v1.
- Internal-pack consumption is a smoke-test exercise, not a unit-test exercise — the public test suite stays free of internal MCP commands.
- The grep audit in SC-006 enumerates a fixed pattern list (CLI binary names, internal hostnames, internal contact email domains) agreed during planning; the list is committed as an audit script in the public repo.
- Re-import diff visualization is content-based (compare preset entries by `id`, treat any field difference as "changed"); semantic diff (e.g. "label changed, command unchanged") is not required in v1.

## Scope

**In Scope:**
- File-based pack import via Settings UI
- Pack validation against a versioned schema
- Listing and removing imported packs from Settings
- Re-import with diff confirmation
- Export of one or more configured servers as a pack file
- Namespacing of conflicting preset ids
- Grouping by source in the Add Server dropdown
- Authoring one M365 product pack per agency-MCP-exposed product in `obsidian-copilot-presets-internal`
- Grep audit in the public repo for internal-identifier patterns
- Updating `docs/`, `README.md`, and `CHANGELOG.md` to describe pack import/export

**Out of Scope:**
- URL-based pack import (deferred — proposal open question on checksum trust model)
- Central preset marketplace / discovery service
- Cryptographic signing of packs
- Auto-update of imported packs from their source URL
- Per-preset disable within an imported pack (packs remain atomic)
- Per-platform preset filtering / `platforms: ["win32", …]` field
- New credential variants (e.g. real `oauth-pkce`); the pack format reflects what's already shippable today
- Per-server tool subset selection (covered by proposal 0006)
- A pack-authoring UI in the plugin
- Automated end-to-end tests against the internal agency MCP servers in CI

## Dependencies

- `authenticated-mcps` (v0.7.0) — `McpServerPreset` registry and `ServerCredentials` discriminated union shape; validation primitives in `mcpServerFormLogic.ts`.
- Existing Settings → MCP servers section as the host UI surface.
- Existing safety prompt at first command spawn (no change required, just relied upon).
- A separate private GitHub repo (`obsidian-copilot-presets-internal`, cloned at `C:\Repos\`) for authoring and distributing the internal agency packs — not in the public source tree.

## Risks & Mitigations

- **Risk:** Internal identifiers leak into the public repo (the exact failure that motivated this proposal). **Mitigation:** A committed grep-audit script enumerates the agreed pattern list; runs in CI on every PR; SC-006 makes this success-criterion-level.
- **Risk:** Pack format drift between built-in `McpServerPreset` shape and the persisted pack schema. **Mitigation:** Build presets from the same data path used to load packs; the built-in preset registry is itself implemented via the pack schema as a runtime preload, validated by the same validator.
- **Risk:** Settings UI complexity creep — pack listing, diff dialog, conflict labels, source-grouped dropdown — destabilizes settings rendering. **Mitigation:** Limit each new UI surface to existing primitives; phase the work so the dropdown grouping (UI-visible everywhere) ships before re-import diff (rarely exercised).
- **Risk:** Validator allows silent partial data loss when packs declare unknown preset-level fields (future schema). **Mitigation:** Preset-level unknown fields are a hard reject in v1; only top-level pack fields are tolerantly ignored, with console warning. SC-003 explicitly tests this.
- **Risk:** Diff computation for re-import is wrong (false "changed" for semantically equivalent presets). **Mitigation:** Diff is structural over canonical JSON serialization; equality is normalized JSON byte-equality. Re-import-with-no-changes case is in SC-008.
- **Risk:** Internal pack authoring is blocked because the internal CLI's argument shapes aren't yet known to the pack author. **Mitigation:** Author the packs by inspecting one configured-by-hand instance per product (the export feature, P4, exists partly to bootstrap this); refine as needed in the private repo without churning the public schema.
- **Risk:** Export feature scope expands to "pack-authoring tool" with template editing, metadata fields, etc. **Mitigation:** v1 export is one-shot: pick servers → produce file. No in-app editing of the output.

## References

- Proposal: `proposals/0007-importable-preset-packs.md`
- Predecessor work: `proposals/0005-mcp-slice7-followup.md`; v0.7.0 release (`authenticated-mcps`)
- Tangent: `proposals/0006-tool-picker-and-scope-aware-credentials.md`
- Companion private repo: `obsidian-copilot-presets-internal` (PRIVATE, sibling at `C:\Repos\`)
- WorkflowContext: `.paw/work/preset-packs/WorkflowContext.md`
