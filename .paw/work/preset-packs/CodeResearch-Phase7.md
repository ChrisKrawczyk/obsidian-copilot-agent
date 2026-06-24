---
date: 2026-06-24T15:10:51.988-07:00
git_commit: c4498774263cd9150a6ecec938e45bd920b2b898
branch: feature/preset-packs
repository: obsidian-copilot-agent
topic: "Preset packs Phase 7 candidates"
tags: [research, codebase, preset-packs, json-schema, settings-ui, semantic-diff]
status: complete
last_updated: 2026-06-24
---

# Research: Preset Packs Phase 7

## Research Question

Research one combined Phase 7 for three promoted preset-pack candidates: compiled JSON Schema export, per-row single-server export, and rich semantic re-import diff.

## Summary

- **Candidate A (JSON Schema):** The pack runtime validator is hand-written and is the enforcement source today (`src\settings\presets\packValidator.ts:53-121`). The current spec/proposal/plan explicitly rule out adding a JSON-schema library for import-time validation (`proposals\0007-importable-preset-packs.md:107-112`, `.paw\work\preset-packs\Spec.md:218-221`, `.paw\work\preset-packs\ImplementationPlan.md:213-214`). A committed `docs\schemas\preset-pack-v1.json` should therefore mirror the hand-written validator and be drift-gated by tests/scripts, not replace runtime validation.
- **Candidate B (per-row export):** The existing settings row uses manual `child(row, "button", ...)` buttons for Edit, Enable/Disable, Reconnect, Remove, and HTTP-only Test connection (`src\settings\McpServersSection.ts:234-253`). The existing export pipeline already accepts one selected row and returns a one-preset pack (`src\settings\packExportFlow.ts:57-69`, `src\settings\presets\packExporter.ts:53-90`).
- **Candidate C (semantic diff):** Current re-import diff is preset-level only (`src\settings\presets\packDiff.ts:9-13`, `src\settings\presets\packDiff.ts:27-59`) and its confirm text lists changed preset ids without field details (`src\settings\packSettingsLogic.ts:99-102`). Canonicalization already normalizes key order and whitespace (`src\settings\presets\packCanonical.ts:4-18`, `src\settings\presets\packCanonical.ts:25-49`), so semantic diff can operate on parsed `PackPreset` objects and report field paths without using raw JSON text.

## Documentation System

- **Framework:** Plain Markdown. There is a `docs\` folder and no `mkdocs.yml` or Docusaurus config found by glob search.
- **Docs Directory:** `docs\`; preset-pack user guide is `docs\preset-packs.md` (`docs\preset-packs.md:1-14`).
- **Navigation Config:** N/A; README links directly to docs (`README.md:7-13`).
- **Style Conventions:** User-facing guide uses short headings, JSON examples, bullets, and tables (`docs\preset-packs.md:16-49`, `docs\preset-packs.md:218-228`).
- **Build Command:** No docs build script exists; package scripts are build/test/typecheck/release/deploy scripts only (`package.json:8-27`).
- **Standard Files:** `README.md`, `CHANGELOG.md`, `RELEASING.md`; README local development/test commands are documented at `README.md:168-186` and `README.md:230-236`.

## Verification Commands

- **Test Command:** `npm test` (`package.json:11-12`, `README.md:230-236`).
- **Lint Command:** No lint/prettier script is present in `package.json`; scripts list build/dev/typecheck/test/deploy/release helpers only (`package.json:8-27`).
- **Build Command:** `npm run build` (`package.json:8-10`); esbuild bundles `src/main.ts` to `main.js` as CJS for Node/Obsidian (`esbuild.config.mjs:6-23`).
- **Type Check:** `npm run typecheck` runs `tsc --noEmit` (`package.json:10-12`); strict TypeScript options are enabled (`tsconfig.json:2-18`).
- **CI:** The only workflow found is tag-triggered release CI (`.github\workflows\release.yml:11-14`), which runs `npm run typecheck`, `npm test`, and `npm run build` before assembling assets (`.github\workflows\release.yml:53-65`).

## Candidate A — Compiled JSON Schema Export

### Existing pack shape and constraints

- `Pack` is `schemaVersion: 1`, `id`, `label`, `version`, optional `description`, and `presets: PackPreset[]` (`src\settings\presets\packTypes.ts:22-29`). Each `PackPreset` has `id`, `label`, optional `description`, `server`, `credentials`, and optional `preflight` (`src\settings\presets\packTypes.ts:13-20`).
- `PartialServerInput` is a union of HTTP `{ url, transport: "http", name }` and stdio `{ name, transport: "stdio", command, args?, env?, cwd? }` (`src\settings\presets\McpServerPresets.ts:15-32`).
- `ServerCredentials` is a four-kind discriminated union: `none`, `static-bearer`, `command-based`, and reserved `oauth-pkce` (`src\mcp\credentials\CredentialTypes.ts:5-49`). `oauth-pkce` includes an index signature for future keys (`src\mcp\credentials\CredentialTypes.ts:32-43`).
- Top-level allowed fields are fixed, but unknown top-level fields are warned and accepted (`src\settings\presets\packValidator.ts:20-27`, `src\settings\presets\packValidator.ts:87-93`). Unknown preset-level fields are rejected (`src\settings\presets\packValidator.ts:29-36`, `src\settings\presets\packValidator.ts:136-145`).
- Runtime validator requires `schemaVersion === 1`, non-empty `id`, non-reserved pack id, non-empty `label`, non-empty `version`, optional string `description`, non-empty `presets[]`, and unique preset ids (`src\settings\presets\packValidator.ts:59-85`, `src\settings\presets\packValidator.ts:95-121`). Pack id `builtin` is reserved (`src\settings\presets\packValidator.ts:13-18`, `src\settings\presets\packValidator.ts:65-70`).
- Preset ids must be non-empty and match `^[a-z0-9][a-z0-9._-]*$` case-insensitively (`src\settings\presets\packValidator.ts:148-156`). Preset label is non-empty and description, when present, is a string (`src\settings\presets\packValidator.ts:157-165`).
- Server validation requires non-empty `server.name` with no control characters (`src\settings\presets\packValidator.ts:211-224`). HTTP server `url` must be a string accepted by `validateMcpHttpUrl(..., { allowPrivateNetwork: true })` (`src\settings\presets\packValidator.ts:225-245`); URL policy permits `http` only for loopback, rejects metadata hosts, and requires HTTPS for non-loopback HTTP URLs (`src\mcp\httpPolicy.ts:26-45`, `src\mcp\httpPolicy.ts:84-104`).
- Stdio server `command` must be a non-empty string without control characters; `args`, when present, must be an array of strings without control characters; `env`, when present, must be an object of string values; `cwd`, when present, must be a string (`src\settings\presets\packValidator.ts:247-310`).
- `preflight`, when present, must be an object with `type: "findOnPath"`, non-empty `command`, and optional string `installHint` (`src\settings\presets\packValidator.ts:324-367`).
- Credentials are delegated to `parseServerCredentials` (`src\settings\presets\packValidator.ts:172-184`). That parser enforces static bearer `token` as non-empty string, command-based `command` as non-empty string plus optional string-array `args`, optional string paths, and non-negative finite `refreshBufferSeconds`; oauth-pkce requires string authorization/token endpoints, clientId, string-array scopes, and optional string tenantId/redirectUri/refreshTokenRef/pkceMethod while preserving unknown fields (`src\settings\parseServerCredentials.ts:42-90`, `src\settings\parseServerCredentials.ts:92-135`).
- Parser-level constraints are strict JSON, BOM stripping, JSONC rejection, 1 MB hard cap, and 100 KB warning (`src\settings\presets\packParser.ts:3-11`, `src\settings\presets\packParser.ts:20-88`).

### Derivation options observed

- **TS-type generation gap:** `packTypes.ts` contains structural interfaces only (`src\settings\presets\packTypes.ts:13-29`); runtime-only constraints such as reserved id, duplicate preset ids, URL policy, control-character rejection, and unknown-field policy live in validator/parser code (`src\settings\presets\packValidator.ts:59-121`, `src\settings\presets\packValidator.ts:136-145`, `src\settings\presets\packValidator.ts:219-224`, `src\settings\presets\packParser.ts:20-88`). A schema generated only from TS types would not include those rules.
- **Validator-derived generation gap:** Validator rules are ordinary TypeScript functions and delegated helpers (`src\settings\presets\packValidator.ts:1-6`, `src\settings\parseServerCredentials.ts:28-137`); there is no existing schema AST or generation script in `scripts\` (`package.json:15-27`).
- **Hand-written schema fit:** Existing docs already present the pack as a strict JSON schema surface (`docs\preset-packs.md:16-49`) and list credential/secret semantics in prose/table form (`docs\preset-packs.md:211-239`).

### Dependency and CI findings

- Runtime dependencies are only `@github/copilot-sdk` and `@modelcontextprotocol/sdk`; devDependencies are TypeScript/esbuild/vitest/tsx/types/obsidian (`package.json:32-43`).
- The proposal says import-time validation should use a hand-rolled validator and explicitly says not to add a JSON-schema library dependency (`proposals\0007-importable-preset-packs.md:107-112`). The Spec repeats "No new schema-library dependency" (`.paw\work\preset-packs\Spec.md:218-221`), and the plan lists "A new schema-library dependency" under not-doing (`.paw\work\preset-packs\ImplementationPlan.md:213-214`).
- Release CI already gates `npm test` and `npm run build` on tags (`.github\workflows\release.yml:53-65`). There is no PR/push CI workflow beyond release (`.github\workflows\release.yml:11-14`).

### Architectural recommendation

- Create and commit `docs\schemas\preset-pack-v1.json` as a hand-written JSON Schema that mirrors `packValidator.ts`, `parseServerCredentials.ts`, `McpServerPresets.ts`, and `packParser.ts` constraints where JSON Schema can express them. Keep `validatePack` as the import/export enforcement path (`src\settings\presets\packValidator.ts:53-121`, `src\settings\presets\packExporter.ts:84-90`).
- Represent non-empty strings with `minLength: 1`, preset id with the validator regex, `schemaVersion` with `const: 1`, credential kinds with `oneOf`, HTTP/stdio server branches with `oneOf`, preset-level `additionalProperties: false`, and top-level tolerant unknown fields with `additionalProperties: true` to match the warn-and-accept behavior (`src\settings\presets\packValidator.ts:87-93`, `src\settings\presets\packValidator.ts:136-145`).
- Document schema limitations for rules JSON Schema cannot fully enforce without custom keywords: duplicate preset ids, reserved pack id `builtin`, URL host classification, control-character checks, and parser size/JSONC/BOM behavior (`src\settings\presets\packValidator.ts:65-70`, `src\settings\presets\packValidator.ts:95-109`, `src\mcp\httpPolicy.ts:26-45`, `src\settings\presets\packParser.ts:20-88`).
- Gate drift by adding a no-new-dependency test/script that parses the schema JSON, checks key invariants against known validator fixtures, and validates example pack objects through `validatePack`; this uses the existing Vitest test path (`vitest.config.ts:12-18`, `package.json:11-12`) and release CI (`.github\workflows\release.yml:53-65`). If PR-time gating is required, add a non-release workflow because the current workflow runs only for tags (`.github\workflows\release.yml:11-14`).

## Candidate B — Per-row "Export this server" Shortcut

### Existing UI and export path

- `McpServersSection` is a manual DOM settings surface, not Obsidian `Setting.addExtraButton`: the section uses the local `child(...)` helper to create elements (`src\settings\McpServersSection.ts:977-987`) and creates row buttons directly (`src\settings\McpServersSection.ts:234-253`). `Setting` is used in `SettingsTab.ts`, not for MCP server rows (`src\settings\SettingsTab.ts:139-145`, `src\settings\SettingsTab.ts:281-296`).
- The configured-server list renders a `role="list"` at `src\settings\McpServersSection.ts:160-167`; each server row renders name, status, optional errors/logs/warnings/credential status, then row-scoped action buttons (`src\settings\McpServersSection.ts:170-253`).
- Header export is only rendered when `packFileWriter` is wired (`src\settings\McpServersSection.ts:152-158`). Production wiring always supplies a writer from `SettingsTab` (`src\settings\SettingsTab.ts:281-296`), while tests assert the button is absent without a writer (`src\settings\McpServersSection.packExport.test.ts:137-152`).
- `buildExportFlowModel` currently creates one row per server with `selected: false` and default metadata `exported-pack` / `Exported servers` / ISO date (`src\settings\packExportFlow.ts:26-44`).
- `runExport` selects rows by id, preserves store order, calls `exportServersAsPack`, and returns serialized 2-space JSON (`src\settings\packExportFlow.ts:57-69`). It returns `no-selection` when no selected rows exist (`src\settings\packExportFlow.ts:63-65`).
- `exportServersAsPack` accepts any `McpServerConfig[]`, maps each server to one preset, validates the resulting pack, and returns it (`src\settings\presets\packExporter.ts:53-90`). Tests already cover 1, 5, and 20 selected servers (`src\settings\packExportFlow.test.ts:112-133`, `src\settings\presets\packExporter.test.ts:178-187`).
- The export dialog currently shows pack id/label/version fields, a checkbox list of servers, status message, Cancel, and Export (`src\settings\McpServersSection.ts:724-802`).

### Architectural recommendation

- Add a row-scoped button inside `renderRow` next to existing Edit/Enable/Reconnect/Remove/Test buttons, gated by `this.options.packFileWriter` just like the header export button (`src\settings\McpServersSection.ts:152-158`, `src\settings\McpServersSection.ts:234-253`).
- Reuse the same writer, `runExport`, `suggestedFilename`, and `exportServersAsPack` path; pass a model containing only the target server selected so the result is naturally a one-preset pack (`src\settings\packExportFlow.ts:57-69`, `src\settings\presets\packExporter.ts:58-90`).
- Keep the pack id/label/version confirmation fields because the existing exporter requires metadata and its default metadata is generic (`src\settings\packExportFlow.ts:38-42`, `src\settings\presets\packExporter.ts:75-82`). For the row shortcut, the UI can omit the multi-select checkbox list and show static text naming the single server; this still uses the current dialog/status/write behavior (`src\settings\McpServersSection.ts:738-802`).
- Add a pure helper or optional parameter to `buildExportFlowModel` to preselect/restrict rows for the single-server path, rather than duplicating export selection logic in DOM code (`src\settings\packExportFlow.ts:26-50`).

## Candidate C — Rich Semantic Diff on Re-import

### Existing diff pipeline and surface

- `diffPacks` returns `added`, `removed`, `changed`, and `metadataChanged`; `changed` currently carries only `{ id, from, to }` (`src\settings\presets\packDiff.ts:9-13`).
- Presets are matched by case-sensitive id, removed/added are computed by maps, and changed is decided by comparing canonical preset strings (`src\settings\presets\packDiff.ts:27-49`). Metadata change is only top-level label/version (`src\settings\presets\packDiff.ts:51-57`).
- Canonical form sorts object keys, removes insignificant whitespace, preserves arrays, and drops `undefined` object properties (`src\settings\presets\packCanonical.ts:4-18`, `src\settings\presets\packCanonical.ts:25-49`). Tests pin reorder-only as no delta and metadata-only behavior (`src\settings\presets\packDiff.test.ts:69-107`).
- Import orchestration calls `diffPacks` when an existing record is found and packages the diff into a `confirmReimport` outcome (`src\settings\presets\packImporter.ts:72-81`).
- UI confirm text is a plain string built by `formatReimportDiffText`; changed presets currently render as `~ id — label` only (`src\settings\packSettingsLogic.ts:65-107`). `McpServersSection` passes that string to `askConfirm`, which uses an injected confirm function in tests or `window.confirm` with title/body text in production (`src\settings\McpServersSection.ts:909-918`, `src\settings\McpServersSection.ts:938-945`).
- Tests assert exact text behavior for added/changed sections and metadata change output (`src\settings\packSettingsLogic.test.ts:89-151`) and end-to-end re-import confirms in FakeElement tests (`src\settings\McpServersSection.packs.test.ts:250-269`).

### Secret-bearing field context

- Export secret policy defines `SECRET_PLACEHOLDER` as the public placeholder contract (`src\settings\presets\packSecretPolicy.ts:3-9`). Static bearer `token` is secret-bearing; oauth-pkce `refreshTokenRef` and `tenantId` are secret-bearing; unknown future oauth-pkce keys are treated as secret-bearing by the exporter (`src\settings\presets\packSecretPolicy.ts:14-20`, `src\settings\presets\packSecretPolicy.ts:45-69`).
- Structural credential fields are explicitly enumerated per kind (`src\settings\presets\packSecretPolicy.ts:22-43`). Exporter replaces secret-bearing credentials and denylisted stdio env values with placeholders, while preserving structural fields (`src\settings\presets\packExporter.ts:125-137`, `src\settings\presets\packExporter.ts:158-192`).
- Import form required-secret handling recognizes `authorization`, `env.<KEY>`, and `refreshTokenRef`; unknown required field names are ignored (`src\settings\mcpServerFormLogic.ts:51-61`, `src\settings\mcpServerFormLogic.ts:244-272`).

### Architectural recommendation

- Extend `PackDiff.changed` to include a field-level change list while preserving `id`, `from`, and `to` for existing callers/tests (`src\settings\presets\packDiff.ts:9-13`, `src\settings\packSettingsLogic.ts:99-102`). Compute field paths from parsed canonical preset objects, not raw JSON, because canonicalization already removes key-order/whitespace noise (`src\settings\presets\packCanonical.ts:25-49`).
- Render semantic annotations in the existing plain-text confirmation body instead of introducing a new UI/modal framework, because the current re-import surface is string-based `askConfirm` (`src\settings\McpServersSection.ts:909-918`, `src\settings\McpServersSection.ts:938-945`) and the Spec requires existing UI primitives/no new UI framework (`.paw\work\preset-packs\Spec.md:218-221`).
- Report field paths/names and coarse states, not raw secret values. For known secret-bearing paths, display status such as `credentials.token changed (secret-bearing; placeholder -> value)` or `server.env.OPENAI_API_KEY changed (secret-bearing env placeholder status changed)` rather than echoing values, matching the export contract that real credentials must not be surfaced (`docs\preset-packs.md:211-232`, `src\settings\presets\packSecretPolicy.ts:3-9`).
- Keep top-level metadata formatting as-is for label/version while adding preset field annotations below each changed preset (`src\settings\packSettingsLogic.ts:74-102`).

## Cross-cutting Findings

- **Settings performance:** The Spec caps added settings open/save latency at 200 ms for pack JSON within the 1 MB envelope (`.paw\work\preset-packs\Spec.md:218-220`). Per-row export adds one extra button per server in the existing O(N) row render loop (`src\settings\McpServersSection.ts:160-167`, `src\settings\McpServersSection.ts:234-253`). Semantic diff runs only during re-import after file selection (`src\settings\presets\packImporter.ts:72-81`), not during normal settings open. Schema file generation/checks are build/test-time concerns and do not run during settings open (`package.json:8-27`).
- **Pure-node tests:** Vitest runs in `node` and includes `src/**/*.test.ts` (`vitest.config.ts:12-18`). Existing UI orchestration tests use FakeElement classes rather than jsdom (`src\settings\McpServersSection.packExport.test.ts:9-64`, `src\settings\McpServersSection.packs.test.ts:8-62`).
- **No new runtime trust:** Pack flows are documented as inert and restricted to validation/settings persistence (`docs\preset-packs.md:261-275`, `.paw\work\preset-packs\Spec.md:218-221`).
- **Docs update pattern:** Phase 6 updated `docs\preset-packs.md`, README, CHANGELOG, PAW docs, and smoke checklist (`.paw\work\preset-packs\ImplementationPlan.md:239-246`). README links the preset-pack guide from the v0.8 section (`README.md:7-13`).

## Risks / Tradeoffs

- **Schema fidelity risk:** JSON Schema can mirror structural constraints, but current validator-only rules include reserved id, duplicate ids, URL host classification, control-character checks, size caps, BOM handling, and JSONC rejection (`src\settings\presets\packValidator.ts:65-70`, `src\settings\presets\packValidator.ts:95-109`, `src\mcp\httpPolicy.ts:26-45`, `src\settings\presets\packParser.ts:20-88`). The schema must document those validator-only constraints.
- **Dependency tradeoff:** Adding a schema library would conflict with the documented no-schema-library constraint for this feature (`proposals\0007-importable-preset-packs.md:107-112`, `.paw\work\preset-packs\Spec.md:218-221`, `.paw\work\preset-packs\ImplementationPlan.md:213-214`). Staying no-dependency means drift tests can parse/inspect schema and validate examples through `validatePack`, but not run full JSON Schema validation unless a validator is added.
- **CI scope tradeoff:** Adding tests under `npm test` gates release tags because release CI runs tests (`.github\workflows\release.yml:53-65`). It does not gate every PR/push unless a new non-release workflow is added; current workflow trigger is tags only (`.github\workflows\release.yml:11-14`).
- **UI density tradeoff:** Per-row export follows the existing row action pattern (`src\settings\McpServersSection.ts:234-253`) but adds another button per row. The row already conditionally adds Test connection for HTTP only (`src\settings\McpServersSection.ts:247-253`); export would be available for both stdio and HTTP because exporter supports both (`src\settings\presets\packExporter.ts:104-123`).
- **Secret display tradeoff:** Rich diff can be more useful if it shows values, but existing secret policy and docs treat credential values as sensitive surfaces (`docs\preset-packs.md:211-232`, `src\settings\presets\packSecretPolicy.ts:3-9`). Semantic diff should not echo secret values.

## Test Surfaces Required

### Candidate A

- Add `src\settings\presets\packSchema.test.ts` or equivalent Vitest coverage that reads `docs\schemas\preset-pack-v1.json`, asserts valid JSON and key schema invariants, and verifies representative examples still pass/fail `validatePack` for the same behaviors already covered in validator tests (`src\settings\presets\packValidator.test.ts:26-243`).
- Add tests/fixtures for top-level unknown allowed vs preset-level unknown rejected to align schema `additionalProperties` with validator behavior (`src\settings\presets\packValidator.test.ts:56-83`).
- Include schema references/examples in docs tests only if a docs test pattern is introduced; no docs build exists today (`package.json:8-27`).

### Candidate B

- Extend `src\settings\packExportFlow.test.ts` for a single-server preselected/restricted model and default metadata behavior (`src\settings\packExportFlow.test.ts:34-52`, `src\settings\packExportFlow.test.ts:67-143`).
- Extend `src\settings\McpServersSection.packExport.test.ts` to assert a row-scoped export button appears when `packFileWriter` is wired, writes one preset, omits unselected servers, uses placeholders, and reuses writer/no-writer gating (`src\settings\McpServersSection.packExport.test.ts:137-202`).
- Preserve existing multi-select header tests (`src\settings\McpServersSection.packExport.test.ts:161-190`).

### Candidate C

- Extend `src\settings\presets\packDiff.test.ts` for field-level changes: label-only, server command/args/env changes, credential kind/token changes, preflight changes, reorder-only no diff, and metadata-only unchanged semantics (`src\settings\presets\packDiff.test.ts:33-107`).
- Extend `src\settings\packSettingsLogic.test.ts` to assert field annotations appear in the re-import confirm text and secret-bearing values are not printed (`src\settings\packSettingsLogic.test.ts:89-151`).
- Extend `src\settings\McpServersSection.packs.test.ts` for re-import prompt body containing field annotations while still confirming/canceling through the existing FakeElement harness (`src\settings\McpServersSection.packs.test.ts:250-269`).

## Concrete Edit List

### Create

- `docs\schemas\preset-pack-v1.json` — shipped JSON Schema for IDE/editor autocomplete.
- `src\settings\presets\packSchema.test.ts` — no-new-dependency schema drift/invariant tests.
- Optional if PR-time gating is required: `.github\workflows\ci.yml` — push/PR workflow running `npm ci`, `npm run typecheck`, `npm test`, `npm run build`; current CI is tag-only release (`.github\workflows\release.yml:11-14`).

### Modify

- `package.json` — optionally add a `schema:check` script if schema drift checks are implemented as a script; existing script style uses `node`/`tsx` scripts (`package.json:8-27`).
- `.github\workflows\release.yml` — add `npm run schema:check` only if using a standalone script; otherwise `npm test` already covers a Vitest schema test (`.github\workflows\release.yml:53-65`).
- `docs\preset-packs.md` — link `docs\schemas\preset-pack-v1.json`, document `$schema`, and update re-import section from structural-only v1 wording (`docs\preset-packs.md:171-186`).
- `README.md` — update v0.8/vPhase text if schema and row export are user-visible (`README.md:7-13`).
- `CHANGELOG.md` — add Phase 7 user-visible entries following existing release documentation pattern (`README.md:240-242`).
- `src\settings\packExportFlow.ts` — add single-server/preselected model support (`src\settings\packExportFlow.ts:26-50`).
- `src\settings\packExportFlow.test.ts` — add tests for the new single-server model/export path (`src\settings\packExportFlow.test.ts:34-52`, `src\settings\packExportFlow.test.ts:67-143`).
- `src\settings\McpServersSection.ts` — add row export button and single-server export dialog path while reusing existing writer and confirm/status handling (`src\settings\McpServersSection.ts:234-253`, `src\settings\McpServersSection.ts:724-802`).
- `src\settings\McpServersSection.packExport.test.ts` — add FakeElement coverage for row-scoped export (`src\settings\McpServersSection.packExport.test.ts:9-64`, `src\settings\McpServersSection.packExport.test.ts:137-202`).
- `src\settings\presets\packDiff.ts` — extend changed entries with field-level annotations while retaining existing changed entry fields (`src\settings\presets\packDiff.ts:9-13`, `src\settings\presets\packDiff.ts:46-49`).
- `src\settings\presets\packDiff.test.ts` — add field-level semantic diff cases (`src\settings\presets\packDiff.test.ts:33-107`).
- `src\settings\packSettingsLogic.ts` — render field annotations in existing plain-text re-import confirm body (`src\settings\packSettingsLogic.ts:65-107`).
- `src\settings\packSettingsLogic.test.ts` — assert annotation text and no secret-value leakage (`src\settings\packSettingsLogic.test.ts:89-151`).
- `src\settings\McpServersSection.packs.test.ts` — update/reinforce re-import prompt tests (`src\settings\McpServersSection.packs.test.ts:250-269`).

## Open Questions for Planning

1. Should Phase 7 add a PR/push CI workflow, or is tag-release gating plus local validation sufficient? Current workflow is tag-only (`.github\workflows\release.yml:11-14`).
2. Should the JSON Schema use draft 2020-12, draft-07, or another draft for best VS Code compatibility? The repo currently has no schema files or schema tooling.
3. Should the schema be strict about top-level unknown fields? Runtime validation warns and accepts unknown top-level fields (`src\settings\presets\packValidator.ts:87-93`), while preset-level unknown fields are rejected (`src\settings\presets\packValidator.ts:136-145`).
4. For row export metadata defaults, should the default pack id/label remain `exported-pack` / `Exported servers` (`src\settings\packExportFlow.ts:38-42`) or be derived from the selected server name? The current exporter derives preset id/label from server names (`src\settings\presets\packExporter.ts:57-68`).
5. How verbose should semantic diff be in a `window.confirm` text body before a custom modal becomes necessary? Current confirm surface is plain text (`src\settings\McpServersSection.ts:938-945`) and existing UI constraints avoid a new framework (`.paw\work\preset-packs\Spec.md:218-221`).
6. For secret-bearing semantic diff, should only placeholder status be reported, or should non-secret old/new values be shown for fields like `label`, `server.command`, and `preflight.command`? Existing metadata text shows old/new label/version values (`src\settings\packSettingsLogic.ts:74-80`), but credential docs avoid exposing secret values (`docs\preset-packs.md:211-232`).

## Code References

- `src\settings\presets\packTypes.ts:13-29` — pack and preset interfaces.
- `src\settings\presets\packValidator.ts:53-121` — top-level pack validation and normalization.
- `src\settings\presets\packValidator.ts:130-203` — preset, server, credential, preflight handoff validation.
- `src\settings\presets\packValidator.ts:211-367` — server and preflight validators.
- `src\settings\parseServerCredentials.ts:28-137` — credentials discriminated-union parser.
- `src\settings\presets\packSecretPolicy.ts:3-87` — placeholder and per-kind secret/structural policy.
- `src\settings\presets\packExporter.ts:53-90` — pack export and self-validation.
- `src\settings\packExportFlow.ts:26-87` — export model, selection, runExport, filename suggestion.
- `src\settings\McpServersSection.ts:140-167` — MCP settings header and export button.
- `src\settings\McpServersSection.ts:170-253` — configured server row and row-scoped buttons.
- `src\settings\McpServersSection.ts:724-802` — current export dialog.
- `src\settings\McpServersSection.ts:865-945` — import/re-import switch and confirm surface.
- `src\settings\presets\packDiff.ts:9-59` — current preset-level diff.
- `src\settings\packSettingsLogic.ts:65-107` — re-import confirm text formatter.
- `src\settings\presets\packCanonical.ts:4-49` — canonical JSON behavior.
- `package.json:8-43` — scripts and dependency categories.
- `.github\workflows\release.yml:11-65` — release-only CI trigger and validation steps.