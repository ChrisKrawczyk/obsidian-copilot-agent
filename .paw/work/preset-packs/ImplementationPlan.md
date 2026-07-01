# Importable Preset Packs — Implementation Plan

## Overview

Implement vault-local, file-based preset pack import/export for MCP
server presets without expanding the runtime trust surface. A *preset
pack* is a strict-JSON file containing one or more presets in the same
shape the in-code preset registry already builds, extended once to
admit stdio as well as HTTP servers
(`PartialHttpServerInput` is HTTP-only today,
`src\settings\presets\McpServerPresets.ts:15-25`). Users import packs
via Settings → MCP servers, manage installed packs, see imported
presets grouped under their pack label in the Add Server dropdown,
re-import with diff confirmation, and round-trip configured servers
back out as packs with every credential-VALUE field templatized to a
reserved placeholder.

Pack data is **inert**: no fetch, exec, or eval triggered by import,
preview, listing, diff, or render. Commands declared by pack-sourced
presets only execute after the user configures a server from the
preset and the existing first-run safety prompt approves it
(`src\domain\SafetyPolicy.ts:1-18`, `src\sdk\AgentSession.ts:1536-1728`).

Phasing keeps every pure module (schema, parser, validator, canonical
form, diff, exporter, registry, orchestrator, persistence) shippable
and node-testable before any UI changes — mirroring the predecessor
`authenticated-mcps` decomposition
(`.paw\work\authenticated-mcps\ImplementationPlan.md:49-56`) and this
repo's node-only Vitest convention
(`vitest.config.ts:12-18`, `.github\copilot-instructions.md:39-45`).

This work spans **two repositories**. The public plugin repo
(`obsidian-copilot-agent`) carries every code-bearing phase below as
commits on `feature/preset-packs`, landing as a single final PR to
`main` (Review Strategy: `local`). The companion private repo
(`<companion-private-repo>`) hosts the first internal pack
JSONs (one per internal-CLI-exposed M365 product) as an out-of-band
Phase 5 deliverable with no commits on the public repo. The public
repo (source, tests, fixtures, snapshots, sample packs, docs,
screenshots, CHANGELOG, CI logs, PAW artifacts) MUST remain free of
organization-specific identifiers
(`.paw\work\preset-packs\Spec.md:208-213`).

## Current State Analysis

- **Preset registry is HTTP-only code.** `BUILT_IN_PRESETS` is a frozen
  array of one entry; `McpServerPresetBuildResult.server` is typed as
  `PartialHttpServerInput`, so no stdio preset can be expressed today
  (`src\settings\presets\McpServerPresets.ts:9-32`,
  `src\settings\presets\McpServerPresets.ts:47-81`). The pack spec
  example uses stdio (`proposals\0007-importable-preset-packs.md:51-69`).
- **Credential union is fixed at four kinds.**
  `none | static-bearer | command-based | oauth-pkce` are the only
  discriminators in source
  (`src\mcp\credentials\CredentialTypes.ts:5-49`). The export
  secret-templating policy must be defined per-kind.
- **No persisted pack store.** `McpSettingsStore` persists only
  `mcpServers` and `mcpAuthorizationNoticeShown` under top-level keys
  in `data.json`; sibling stores (`safety`, `auth`, `settings`) merge
  under their own top-level keys
  (`src\settings\McpSettingsStore.ts:18-22`,
  `src\settings\McpSettingsStore.ts:209-230`,
  `src\settings\SafetySettingsStore.ts:121-125, 253-276`). The
  proposal's `mcp.presetPacks` wording does not match this top-level
  convention; this plan uses **`mcpPresetPacks`** as a top-level
  sibling key, matching the existing `mcpServers` / `mcpAuthorization*`
  prefix pattern (`proposals\0007-importable-preset-packs.md:99-105`).
- **Add Server preset dropdown is flat and built-in-only.** A single
  flat `<select>` lists `BUILT_IN_PRESETS` ids and rewrites option
  labels at render time; the local `select(...)` helper has no
  optgroup support
  (`src\settings\McpServersSection.ts:373-392, 639-651`). Pre-fill on
  selection copies `name`, `transport`, `url`, and command-based
  credential fields (`src\settings\McpServersSection.ts:397-416`);
  preflight renders a non-blocking install hint
  (`src\settings\McpServersSection.ts:416-427`).
- **Form validation primitives exist and are DOM-free.**
  `mcpServerFormLogic.ts` accumulates string errors/warnings,
  validates URLs, parses stdio args, checks env denylist, validates
  credential kinds; `parseCredentials` in `McpSettingsStore.ts` is the
  persistence-side parser
  (`src\settings\mcpServerFormLogic.ts:17-210, 260-318`,
  `src\settings\McpSettingsStore.ts:428-517`). The pack validator
  reuses these primitives — no new JSON-schema library is permitted.
- **No file picker / save dialog abstraction.** No Electron dialog
  calls anywhere
  (`.paw\work\preset-packs\CodeResearch.md:422-427`); desktop file
  access uses `adapter.getBasePath()` + Node `fs`
  (`src\settings\SettingsTab.ts:276-288`). A new injectable file-IO
  abstraction is required for testability.
- **No BOM-stripping JSON helper.** All `JSON.parse` call sites feed
  strings directly without BOM normalization
  (`.paw\work\preset-packs\CodeResearch.md:429-433`).
- **Safety is attached to configured servers, not presets.** Trust
  epoch covers transport identity (stdio command+args / HTTP url),
  not credential fields (`src\mcp\McpIdentity.ts:27-48`), and
  imported preset commands run only when the user saves a server
  from the preset and an MCP tool call is approved
  (`src\sdk\AgentSession.ts:1536-1728`,
  `src\ui\ToolCallBlock.ts:177-240`). Pack import inherits this
  unchanged.
- **UI testing pattern is pure sibling module + FakeElement.**
  `mcpServerFormLogic.ts` next to `McpServersSection.ts`,
  `chatKeydown.ts` next to `ChatView.ts`
  (`.github\copilot-instructions.md:39-45`,
  `src\ui\chatKeydown.test.ts:1-72`,
  `src\settings\McpServersSection.phase5.test.ts:1-88`).
- **Test baseline:** `npm test`, `npm run typecheck`, and
  `npm run build` are expected to pass on the current `feature/preset-packs`
  HEAD; each implementation phase re-verifies under its automated
  criteria. (Scripts at `package.json:8-27`.)

## Desired End State

- A **versioned pack schema** (`schemaVersion: 1`) is the single
  source of truth. Built-in presets are wrapped in the same shape
  imported packs use and pass through the same validator at startup
  so schema drift fails fast.
- **Preset build output is transport-agnostic.**
  `McpServerPresetBuildResult.server` becomes a union admitting both
  stdio and HTTP shapes, mirroring `McpServerConfig`
  (`src\mcp\McpTypes.ts:26-56`). The existing M365 built-in still
  produces the same HTTP build result; tests pin its output
  byte-for-byte.
- A new top-level settings key **`mcpPresetPacks`** in plugin
  `data.json` holds an array of `ImportedPackRecord` entries:
  `{ recordId, pack, importedAt, sourcePath }`. Other top-level keys
  (`mcpServers`, `safety`, `auth`, etc.) are untouched.
- A pure **`packValidator`** module rejects malformed packs with a
  single error citing the offending JSON pointer
  (`/presets/2/credentials/kind`) or parse `line:column`; reuses
  existing credential/server validation primitives; rejects JSONC;
  BOM-tolerant in parse phase; hard size cap 1 MB, soft notice at
  100 KB.
- A pure **`canonicalizePack` + `diffPacks`** module produces
  byte-stable canonical JSON (lexicographic keys, no insignificant
  whitespace) and computes added/removed/changed presets by `id` for
  re-import diff.
- A pure **`exportServersAsPack`** module produces a pack JSON from
  one or more `McpServerConfig` rows: strips runtime fields the
  settings store already strips
  (`src\settings\McpSettingsStore.ts:32-42`), then applies a
  per-credential-kind secret templating policy (table in Phase 4).
  The reserved placeholder is `__NEEDS_VALUE__`.
- A pure **`effectiveRegistry`** module merges built-ins + imported
  packs into a deterministic ordered list applying FR-013
  namespacing rules a/b/c/d.
- A pure **`runPackImport`** orchestrator composes parse → validate →
  diff (if duplicate id) into a discriminated outcome (`confirmNew`,
  `confirmReimport`, `parseError`, `validationError`, `sizeError`)
  with zero side effects, so DOM wiring is a thin translation layer.
- The **Add Server dropdown** is rendered with `<optgroup>` sections
  (`Built-in`, then `From <pack label>` per imported pack). Imported
  preset ids that collide with a built-in or with another pack's
  preset id are namespaced as `<packId>.<presetId>`; display labels
  suffix `(from <pack label>)`.
- **Settings → MCP servers** shows a new "Imported preset packs"
  subsection with: list (label / version / source / imported-at /
  preset count) + per-row Remove button, an "Import pack from
  file…" button, and an "Export servers as pack…" button (latter
  opens a multi-select dialog).
- **Re-import** of a pack with matching `id` opens a diff
  confirmation; cancel preserves prior state; confirm overwrites.
- **All existing tests pass.** New automated coverage includes pure
  validator, canonicalizer, diff, exporter (incl. secret templating
  matrix), persistence round-trip, FakeElement UI orchestration for
  pack dropdown grouping, import confirm, remove confirm, and
  re-import diff. UI wiring stays a thin DOM layer in
  `McpServersSection.ts`; testable logic lives in sibling pure modules.
- **Docs.** `docs\preset-packs.md` describes the pack file format,
  import/export flow, namespacing rules, and the secret-template
  contract. `README.md` "What's new" links to it. `CHANGELOG.md`
  notes the feature.
- **Companion private repo** contains one pack JSON per internal
  M365 product surfaced by the internal MCP bridge CLI. Manual smoke
  per pack is captured in the private repo's README.

### Verification approach

- After every phase: `npm test`, `npm run typecheck`, and
  `npm run build` succeed.
- Manual smoke per phase: `npm run deploy` → reload Obsidian →
  exercise the phase's user-visible surface (per-phase manual steps
  below).
- End-to-end smoke at Phase 5: copy a private-repo pack file →
  import via the new UI → select a preset → save → issue a chat MCP
  tool call → expect a successful response after first-run safety
  prompt.

## What We're NOT Doing

Union of Spec § Scope → Out of Scope plus deliberate plan-level
deferrals:

- **URL-based pack import.** File-picker only in v1; the proposal's
  checksum/trust-model question is unresolved
  (`proposals\0007-importable-preset-packs.md:144-149`,
  `.paw\work\preset-packs\Spec.md:251-253`).
- **Central preset marketplace / discovery / auto-update.**
- **Cryptographic signing of packs.**
- **Per-preset disable within a pack.** Packs are atomic.
- **Per-platform preset filtering** (`platforms: ["win32", …]`).
- **New credential variants** (e.g. live `oauth-pkce`). Pack format
  serializes the variants present today.
- **Pack-authoring UI in the plugin.** Authoring is JSON editing or
  the export feature.
- **Automated CI grep audit for internal-identifier leaks.** Rejected
  in Spec (pattern list would itself constitute a leak); code review
  is the gate (`.paw\work\preset-packs\Spec.md:253`).
- **Migration of legacy built-in presets to JSON files.** Built-ins
  remain TS-authored but conform to the same shape the validator
  enforces; no on-disk built-in pack file ships.
- **A new schema-library dependency.** Validation reuses existing
  primitives.
- **A new UI framework or component library.** Existing Setting +
  manual DOM helpers + `confirmDestructive` only
  (`src\ui\ConversationPicker.ts:208-260`).
- **Touching `oauth-pkce` runtime behavior.** Resolver still throws
  `not-implemented`; the pack validator accepts the shape and
  preserves unknown future keys conservatively
  (`src\mcp\credentials\CredentialResolver.ts:131-137`,
  `src\settings\McpSettingsStore.ts:492-515`).
- **Per-server tool subset selection** (proposal 0006).
- **Public-repo automated tests against real internal MCP bridge
  servers in CI.** Smoke only, recorded in the private repo README.
- **Export ancestry retention.** Re-exporting a server that came from
  a pack does NOT carry pack ancestry; it becomes a fresh preset.
- **Public-facing JSON Schema file** under `docs/schemas/`. Considered
  for IDE tooling but adds a maintained docs surface; deferred to v2.
- **Changing built-in preflight-hint timing.** Built-in presets today
  surface the non-blocking install hint at the form level the moment
  a `command` is pre-filled. SC-006's "tries to use" wording is
  reconciled with FR-015's "behave identically to built-in" by leaving
  the existing form-level surface unchanged for both built-ins and
  pack-declared presets (see Phase 4 SC-006/FR-015 reconciliation note).
  Deferring the hint strictly to runtime tool-call would require
  changing built-in behavior — out of scope for this feature.

## Phase Status

- [x] **Phase 1: Pure foundation modules** — Schema/types, parser (BOM + JSONC reject + size guard), validator (single-error contract), transport-union refactor, built-in pack wrapper, canonicalize/diff, secret-policy matrix, exporter, effective registry with namespacing. All pure, all node-testable. No UI, no persistence wiring.
- [x] **Phase 2: Persistence** — `PresetPacksStore` with new `mcpPresetPacks` top-level key; sibling-key preservation; plugin onload integration.
- [x] **Phase 3: Import flow + Settings UI** — File-IO abstraction, import orchestrator, "Imported preset packs" subsection in Settings → MCP servers with import / remove / re-import diff modals.
- [x] **Phase 4: Add Server dropdown grouping + Export UI** — Optgroup-grouped dropdown with pack pre-fill and secret-placeholder handling; export multi-select dialog producing a pack file.
- [ ] **Phase 5 (out-of-band, no public-repo commits): Author internal packs in `<companion-private-repo>`** — One pack JSON per internal-CLI-exposed M365 product; manual end-to-end smoke.
- [x] **Phase 6: Documentation** — `docs\preset-packs.md`, README "What's new", CHANGELOG, PAW `Docs.md`, `SmokeChecklist.md`.
- [x] **Phase 7: Promoted candidate features** — JSON Schema editor export, per-row single-server export shortcut, and rich semantic re-import diff. Single local-strategy commit.

## Phase Candidates

- [x] [deferred] **URL-based pack import via `requestUrl`.** Deferred; awaits a checksum/trust-model decision (`proposals\0007-importable-preset-packs.md:144-149`).
- [x] [deferred] **Auto-update / re-fetch of imported packs from `sourcePath`.** Deferred.
- [x] [deferred] **Drag-and-drop pack-file import onto the settings tab.** Convenience; out of scope for v1.
- [x] [deferred] **Pack-authoring UI inside the plugin.** Out of scope per Spec.
- [x] [deferred] **Optional `platforms` per-preset filter.** Out of scope per Spec.
- [x] [promoted] **Compiled JSON Schema export under `docs/schemas/preset-pack-v1.json`.** Considered for tooling/IDE assistance but adds a maintained surface; deferred until v2 when external authoring grows.
- [x] [promoted] **Per-row "Export this server" shortcut on the configured-server list.** Considered for Phase 9 but adds DOM complexity; the multi-select path subsumes it.
- [x] [promoted] **Rich semantic diff** beyond id-level added/removed/changed.

---

## Phase 1: Pure foundation modules

**Covers:** FR-002, FR-009, FR-011, FR-012, FR-013 (a/b/c/d), FR-014, FR-016, FR-020, FR-021, FR-022, FR-023; SC-002, SC-003, SC-006 (import-side: pack with missing-on-PATH command imports without invoking preflight), SC-007, SC-008, SC-009; prerequisite for FR-005/FR-015. **Cross-Cutting NFRs "Reuse existing validation primitives" and "Reuse existing UI conventions" (`Spec.md:214-215` — note FR-017/FR-018 were merged into Cross-Cutting per `Spec.md:194-195`) are honored here by lifting `parseServerCredentials` and `mcpServerFormLogic.shared.ts`; their gate is "all existing test suites stay green," asserted in every phase's Automated Verification.**

This phase establishes every pure module the later phases compose, with full Vitest coverage. No persistence, no DOM, no file IO. Logical sub-sections kept in commit history for reviewability.

### 1A — Schema, parser, validator, transport-union refactor

#### Changes Required:

- **`src\settings\presets\McpServerPresets.ts`**: Broaden `McpServerPresetBuildResult.server` from `PartialHttpServerInput` to a discriminated union admitting stdio:
  - Add `PartialStdioServerInput { name: string; transport: "stdio"; command: string; args?: string[]; env?: Record<string,string>; cwd?: string }`.
  - Export `PartialServerInput = PartialHttpServerInput | PartialStdioServerInput` and use it on `McpServerPresetBuildResult.server`.
  - The existing `M365_GRAPH_PRESET.build()` continues to return the HTTP shape unchanged; the existing byte-equality test
    (`src\settings\presets\McpServerPresets.test.ts:13-67`) is preserved.
- **`src\settings\presets\packTypes.ts`** (new): pure types — `PackPreset`, `Pack` (with `schemaVersion: 1`), `ImportedPackRecord`, `PackValidationError { pointer: string; message: string }`, `PackParseError { kind: "parse" | "size" | "io"; message: string; line?: number; column?: number }`.
- **`src\settings\presets\packParser.ts`** (new): pure `parsePackText(text, opts: { maxBytes }): { ok, raw?, sizeWarning?, error? }`. Strips a leading UTF-8 BOM. Size enforcement is **byte-based** (FR-023): use `Buffer.byteLength(text, "utf8")` (or the caller-provided `byteLength`) — NOT `text.length`, which under-counts multi-byte characters. Rejects byte-length > 1 MB before parse (`kind: "size"`). Sets `sizeWarning: true` when byte-length > 100 KB. Pre-scans for `//` or `/*` outside string literals using a small string-aware tokenizer (NOT a naïve regex; honors `"…"` with `\` escapes); on hit returns `kind: "parse"` with message `"JSON-with-comments is not allowed"` (FR-022). Wraps `JSON.parse` and extracts `line`/`column` from `SyntaxError` where present.
- **`src\settings\presets\packValidator.ts`** (new): pure `validatePack(raw: unknown): { ok, pack?, error? }`. Returns the FIRST validation error (single-error contract per FR-002 / SC-003) with `pointer` as RFC 6901 JSON Pointer (e.g. `/presets/2/credentials/token`). Field segments containing `~` or `/` are escaped per RFC 6901 (`~0`, `~1`). Top-level checks: `schemaVersion === 1`; `id`/`label`/`version` non-empty strings; **pack `id !== "builtin"`** (reserved for the synthetic built-in pack; rejected at validation with a clear single-error message so an imported pack cannot impersonate built-in via the effective-id namespace per FR-013); `presets` is a non-empty array (rejects zero-preset packs per Edge Cases); duplicate preset ids within the pack rejected (FR-013c). Unknown TOP-level fields ignored with `console.warn`. Unknown PRESET-level fields rejected. Per-preset checks call the validators extracted below. **The lifted `parseServerCredentials` retains its existing `oauth-pkce` unknown-future-keys passthrough behavior (`src\settings\McpSettingsStore.ts:492-515`) — the pack validator's "reject unknown preset-level fields" rule applies at the preset level only, NOT inside `credentials.oauth-pkce` where passthrough is required for forward-compatible byte-equivalent round-trip.**
- **`src\settings\mcpServerFormLogic.shared.ts`** (new): Extract shared, DOM-free helpers from `mcpServerFormLogic.ts` for URL validation (`validateMcpHttpUrl`), TLS-bypass rejection, control-character checks, and `parseArgs`-style validation (`src\settings\mcpServerFormLogic.ts:120-178`). Both the form and the pack validator import from here. No behavior change for the form.
- **`src\settings\McpSettingsStore.ts`**: Lift the private `parseCredentials` (`src\settings\McpSettingsStore.ts:428-517`) into a new exported pure helper `parseServerCredentials(raw, pointerBase): { ok, value?, error? }`. Replace the existing call site to use the lifted helper. Pack validator imports it directly.
- **`src\settings\presets\BuiltInPacks.ts`** (new): Wrap `BUILT_IN_PRESETS` as a synthetic in-memory `Pack` with `id: "builtin"`, `label: "Built-in"`, and a **hardcoded `version: "1"`** (NOT `manifest.json` — divorcing built-in pack content from plugin release version avoids spurious `metadataChanged` on every plugin release). Run `validatePack` on it at module load. Failing built-in validation throws at startup so later phases can rely on the invariant "every preset everywhere conforms to `PackPreset`." (Spec Risks & Mitigations bullet 2.)

#### Tests:
- **`src\settings\presets\packParser.test.ts`** (new): BOM strip; happy path; trailing-comma rejected with line/column; `//` and `/* */` rejected; **byte-length** > 1 MB rejected before parse (test includes a multi-byte-character payload to verify byte-vs-char distinction); byte-length > 100 KB sets sizeWarning; empty string rejected.
- **`src\settings\presets\packValidator.test.ts`** (new): minimal valid pack accepted; missing required field → pointer `/id` or `/presets/0/server/command`; unknown preset-level field rejected; unknown top-level field warned-and-accepted; duplicate preset ids rejected with pointer to the second; empty `presets[]` rejected; each credential kind accepted; `static-bearer` with empty token rejected; HTTP URL guardrails enforced; stdio server with control character in command rejected; preflight with unknown `type` rejected.
- **`src\settings\presets\BuiltInPacks.test.ts`** (new): current built-in pack validates; pinned id/label preserved.
- **`src\settings\presets\McpServerPresets.test.ts`**: continues to assert M365 build-result byte-equality after the union refactor.
- **`src\settings\McpSettingsStore.test.ts`**: existing round-trip tests stay green after the `parseServerCredentials` lift.
- **`src\settings\mcpServerFormLogic.test.ts`**: no behavior change after extracting shared helpers.

### 1B — Canonicalization + diff

#### Changes Required:

- **`src\settings\presets\packCanonical.ts`** (new): pure
  - `canonicalizePack(pack: Pack): string` — emits JSON with keys sorted lexicographically at every object depth, no insignificant whitespace; arrays preserve declaration order (preset order is part of the pack). Implemented as a small recursive serializer (NOT relying on `JSON.stringify(_, sortFn)` key-order tricks).
  - `canonicalizePreset(preset: PackPreset): string` — same rules.
  - `packsCanonicalEqual(a: Pack, b: Pack): boolean`.
- **`src\settings\presets\packDiff.ts`** (new): pure
  - `diffPacks(prev: Pack, next: Pack): { added: PackPreset[]; removed: PackPreset[]; changed: { id: string; from: PackPreset; to: PackPreset }[]; metadataChanged: { from: { label: string; version: string }; to: { label: string; version: string } } | null }`.
  - Matches presets by `id` (case-sensitive per Edge Cases).
  - "Changed" determined by `canonicalizePreset(a) !== canonicalizePreset(b)`.
  - Top-level `label` / `version` changes surface in `metadataChanged`, not preset deltas.

#### Tests:
- **`packCanonical.test.ts`** (new): identical packs with shuffled key order produce identical canonical strings; arrays preserved; nested objects sorted at every depth; unicode preserved; numeric values stable.
- **`packDiff.test.ts`** (new): added/removed/changed detection; label change for a preset flagged as `changed` for that preset id; reorder-only yields empty deltas; metadata-only change populates `metadataChanged`; SC-007 (identical canonical → empty diff; changed canonical → non-empty diff); SC-008 explicit.

### 1C — Secret-policy matrix + exporter

#### Changes Required:

- **`src\settings\presets\packSecretPolicy.ts`** (new): pure
  - `export const SECRET_PLACEHOLDER = "__NEEDS_VALUE__";`
  - `secretFieldsForCredentials(kind: ServerCredentials["kind"]): readonly string[]` per the locked matrix:

  | Kind | Secret-bearing fields | Structural fields preserved |
  | --- | --- | --- |
  | `none` | (none) | `kind` |
  | `static-bearer` | `token` | `kind` |
  | `command-based` | (none, when `command` is a bare CLI token — see rationale) | `kind`, `command`, `args`, `tokenPath`, `expiryPath`, `refreshBufferSeconds` |
  | `oauth-pkce` | `refreshTokenRef`, `tenantId`, **all unknown future keys** (defensive default — Spec Risks last bullet) | `kind`, `clientId`, `authorizationEndpoint`, `tokenEndpoint`, `scopes`, `redirectUri`, `pkceMethod` |

  Rationale for `command-based`: per Spec FR-020 (revised), the CLI invocation itself is structural — the M365 built-in's `internal-mcp-cli` command is a public binary name, the secret resolution happens inside the CLI's own process, and SC-009 + P4 Independent Test require round-trip without user re-entry. Authors who place literal secret values inside `args` (e.g. `--api-key <literal>`) are responsible for redacting before export; the system does not content-scan. (Earlier draft templatized `command`/`args` based on FR-020's pre-revision wording; the spec revision authorized this carve-out.)

  Rationale for `oauth-pkce` placement: `clientId` is a public OAuth identifier (not secret); `tenantId` is an organization identifier and the Spec privacy NFR (`.paw\work\preset-packs\Spec.md:208-213`) explicitly lists "tenant identifiers" as forbidden in public artifacts and shareable packs — templating it is required for cross-org pack sharing.

  Additional rules:
  - **stdio `env` values:** templatize *only* values whose KEY matches the existing env denylist (`collectDenylistWarnings` in `src\settings\mcpServerFormLogic.ts:397`). This is the "marked secret" mechanism FR-020 references. Non-denylisted env values are preserved verbatim — required for SC-002 (round-trip fidelity for non-secret fields) and SC-009 (`none`-credential round-trip).
  - **stdio `command` / `args`:** NOT secret. CLI invocations are equivalent in trust shape to a manually-typed server command — structural identity.
  - **Legacy HTTP `authorization`:** omitted from export; canonical credential is `credentials`. Migration on export: any server with `authorization` set is exported with `credentials: { kind: "static-bearer", token: SECRET_PLACEHOLDER }`.
  - **Unknown credential kind:** defensive default — every field is treated as secret-bearing.

- **`src\settings\presets\packExporter.ts`** (new): pure
  - `exportServersAsPack(servers: McpServerConfig[], meta: { id: string; label: string; version: string }): Pack`.
  - Per server: deep clone → strip runtime-only fields (use a shared exported constant `RUNTIME_FIELDS` lifted from `src\settings\McpSettingsStore.ts:32-42`) → drop `trustEpoch` and `enabled` (vault state, not pack state) → map `McpServerConfig` → `PartialServerInput` → build `credentials` (with the legacy-`authorization` migration) → apply `secretFieldsForCredentials(kind)` templating + env-value rule → generate preset `id` from a slug of `name` (`[a-z0-9_-]+`, dedupe via `-2`, `-3` within the pack).
  - The resulting `Pack` MUST validate against `validatePack` (round-trip property, FR-012).
- **`src\settings\McpSettingsStore.ts`**: Factor the runtime-field list into an exported `RUNTIME_FIELDS` constant.

#### Tests:
- **`packSecretPolicy.test.ts`** (new): matrix above; unknown credential kind → all fields secret; `secretFieldsForCredentials` returns frozen array; `tenantId` listed as secret-bearing for `oauth-pkce` (privacy NFR).
- **`packExporter.test.ts`** (new):
  - Runtime fields stripped (FR-011, SC-002).
  - Stdio with denylisted env value (e.g. `MCP_SECRET_TOKEN`) → value templatized to `SECRET_PLACEHOLDER`; non-denylisted env value (e.g. `PATH`, `LOG_LEVEL`) → preserved verbatim (FR-020, SC-002 non-secret round-trip).
  - HTTP `static-bearer` token replaced with `SECRET_PLACEHOLDER`; assert via substring search on `JSON.stringify(pack)` that the original token never appears.
  - HTTP `command-based`: `command` and `args` PRESERVED verbatim (revised per Spec FR-020 carve-out and SC-009); `tokenPath` / `expiryPath` / `refreshBufferSeconds` preserved verbatim. Test asserts the round-trip pre-fill is byte-equal on every field of a representative M365-style `internal-mcp-cli --mcp ...` config.
  - `oauth-pkce` with an unknown future key: future key templatized (defensive default); `tenantId` templatized; `clientId` preserved.
  - Legacy HTTP `authorization` migrates to `{ kind: "static-bearer", token: SECRET_PLACEHOLDER }`.
  - Multiple servers with the same `name` get deduped preset ids.
  - Round-trip: `validatePack(exportServersAsPack([s_1, …, s_N], meta)).ok === true` for N ∈ {1, 5, 20} (SC-002).

### 1D — Effective preset registry + namespacing

#### Changes Required:

- **`src\settings\presets\effectiveRegistry.ts`** (new): pure
  - `interface EffectivePreset { effectiveId: string; sourcePackId: "builtin" | string; sourcePackLabel: string; preset: PackPreset; displayLabel: string; namespaced: boolean }`.
  - `buildEffectiveRegistry(builtins: Pack, packs: ImportedPackRecord[]): EffectivePreset[]`.
  - Namespacing rules per FR-013:
    - **(a)** built-in preset id collision: imported preset namespaced to `<packId>.<presetId>`; built-in keeps its bare id.
    - **(b)** two imported packs share a preset id: BOTH get `<packId>.<presetId>`. Implementation: multiset of ids across all imported pack presets; for each id appearing in ≥2 imported packs, namespace every occurrence.
    - **(c)** duplicate ids within one pack: already rejected at validation (sub-phase 1A).
    - **(d)** when namespaced, `displayLabel = "<preset.label> (from <pack.label>)"`. When not namespaced, `displayLabel = preset.label`.
  - Output ordering: built-ins first (in registration order), then each imported pack's presets in declaration order, with packs ordered by `importedAt` ascending.
  - `getEffectivePresetById(registry, effectiveId): EffectivePreset | undefined`.
- **`src\settings\presets\McpServerPresets.ts`**: Keep `getPresetById` as a built-in-only lookup (still used by current dropdown render; that surface migrates in Phase 4). Mark with `/** @deprecated Use effective registry. */`.

#### Tests:
- **`effectiveRegistry.test.ts`** (new):
  - No imported packs → registry contains exactly the built-ins; none namespaced (also asserts FR-014).
  - One imported pack, no collisions → bare ids retained, labels NOT suffixed.
  - One imported pack with id colliding with the built-in M365 entry → imported preset namespaced; built-in unchanged; imported display label has `(from <packLabel>)` suffix.
  - Two imported packs sharing a preset id → BOTH namespaced (FR-013b).
  - Determinism: same inputs → same output ordering across runs.
  - Case sensitivity: `Mail` and `mail` treated as distinct.

### Success Criteria (Phase 1):

#### Automated Verification:
- [ ] Tests pass: `npm test`
- [ ] Typecheck: `npm run typecheck`
- [ ] Build: `npm run build`
- [ ] Validator's error contract locked: at least one test asserts the FIRST error's `pointer` and `message` and that no second error is produced (SC-003).
- [ ] BOM, JSONC-rejection, and 1 MB / 100 KB threshold tests present.
- [ ] SC-007 and SC-008 assertions present in `packDiff.test.ts`.
- [ ] For every credential kind, every field name in `secretFieldsForCredentials(kind)` is replaced with `SECRET_PLACEHOLDER` in the exported JSON; no original secret VALUE appears as a substring anywhere in the serialized pack (FR-020 explicit assertion).
- [ ] Round-trip test for 1, 5, and 20-preset packs (SC-002).
- [ ] FR-013 a/b/c/d each have a dedicated assertion.

#### Manual Verification:
- [ ] After `npm run deploy` and Obsidian reload, the plugin loads an existing vault with no MCP settings regressions; the built-in M365 preset still appears in the Add Server dropdown and pre-fills as before.

---

## Phase 2: Persistence

**Covers:** FR-003; FR-006 (data model + store-side invariants — UI rendering of the list is Phase 3); FR-008 (store-side invariant: `remove(packId)` does not touch `mcpServers` — UI affordance is Phase 3).

### Changes Required:

- **`src\settings\PresetPacksStore.ts`** (new): sibling to `McpSettingsStore`; same `PluginDataIO` injection pattern (`src\settings\McpSettingsStore.ts:1-6, 51-56`, `src\settings\SafetySettingsStore.ts:121-125`).
  - Persisted top-level key: **`mcpPresetPacks: ImportedPackRecord[]`**.
  - `load(): Promise<void>` reads `raw.mcpPresetPacks`; validates each entry's `record.pack` with `validatePack`; drops malformed records with a one-time Notice (mirrors `McpSettingsStore.load`, `src\settings\McpSettingsStore.ts:58-97`).
  - `snapshot(): ImportedPackRecord[]` returns deep-cloned records (use `JSON.parse(JSON.stringify(x))` pattern at `src\settings\McpSettingsStore.ts:415-417`).
  - `addOrReplace(pack: Pack, sourcePath: string): Promise<ImportedPackRecord>` — keyed by `pack.id`; if existing, replaces in place, generates fresh `recordId`, sets `importedAt = Date.now()`. Persists.
  - `remove(packId: string): Promise<void>` — removes by `pack.id`. Persists. MUST NOT touch `mcpServers` (FR-008).
  - `persist()` mirrors `McpSettingsStore.persist` (`src\settings\McpSettingsStore.ts:209-230`): re-read latest plugin data, spread all top-level keys, then write `mcpPresetPacks` last.
- **`src\main.ts`**: Instantiate `PresetPacksStore` alongside `McpSettingsStore` (around the existing store construction at `src\main.ts:254-266`); call `presetPacksStore.load()` during plugin `onload` at the same point the other stores are loaded; expose via the same dependency container used by `McpServersSection`.
- **`src\settings\McpServersSection.ts`**: Add a constructor option `presetPacksStore: PresetPacksStore` (no UI changes yet — Phase 3 consumes it).

### Tests:
- **`src\settings\PresetPacksStore.test.ts`** (new): empty load; load with one valid record; load drops malformed pack records and raises a Notice; `addOrReplace` creates and updates by `pack.id`; `remove` deletes by `pack.id`; round-trip canonically equal; save preserves sibling top-level keys `mcpServers`, `safety`, `auth`, `conversations` (in-memory IO pattern from `src\settings\McpSettingsStore.test.ts:7-16, 43-81`); `recordId` unique per insert.

### Success Criteria:

#### Automated Verification:
- [ ] Tests pass: `npm test`
- [ ] Typecheck: `npm run typecheck`
- [ ] Build: `npm run build`
- [ ] Test asserts `mcpServers`, `safety`, `auth`, `conversations` keys survive `mcpPresetPacks` save/load cycles unchanged.

#### Manual Verification:
- [ ] `npm run deploy`, reload Obsidian; existing settings load with no regression; `data.json` shows no new keys yet (Phase 3 introduces the import button). Phase 2 ships no user-visible surface; persistence verification is automated only. Manual UI verification deferred to Phase 3.

---

## Phase 3: Import flow + Settings UI

**Covers:** FR-001, FR-002, FR-006 (UI rendering of pack list), FR-007 (UI remove affordance), FR-008 (UI guarantees configured servers untouched on remove), FR-009, FR-010, FR-022, FR-023; SC-001 (import-side: ≤4 clicks + persistence on confirm — dropdown-visibility side is Phase 4), SC-003, SC-004 (state side: store no longer has presets after remove — dropdown disappearance is Phase 4), SC-007, SC-008.

### Changes Required:

- **`src\settings\presets\packFileIO.ts`** (new): pure interface + Obsidian-desktop implementation factory.
  - `interface PackFileReader { pickAndReadPackFile(): Promise<{ ok: true; text: string; sourcePath: string; byteLength: number } | { ok: false; reason: "cancelled" | "io"; message?: string }> }`.
  - `interface PackFileWriter { saveTextToPath(suggestedFilename: string, text: string): Promise<{ ok: true; path: string } | { ok: false; reason: "cancelled" | "io"; message?: string }> }`.
  - **Desktop file-picker implementation (FR-001 mandates a file picker):** use an off-DOM `<input type="file" accept=".json,application/json">` element programmatically clicked from the "Import pack from file…" button handler. This is the standard browser-native file picker, works reliably in Obsidian Desktop's Chromium runtime across all currently-supported Electron versions, and is the same primitive Obsidian itself uses for image / attachment imports. On selection, the runtime returns a browser `File` object. Read via the HTML5 `File` API directly: `file.size` (synchronous, used to enforce the FR-023 byte cap BEFORE reading) and `await file.text()` (async, yields decoded UTF-8 contents). The `sourcePath` (FR-006) comes from the Electron-specific `file.path` extension property exposed on the `File` object in Obsidian Desktop's Electron runtime — this is documented Electron behavior, persisted as the canonical absolute path. **No Node `fs` use on the import (read) path** — the HTML5 `File` API is sufficient and avoids a redundant filesystem round-trip.
  - **Save-as implementation (Spec.md:122 — file save dialog for export):** Electron's `dialog` module is a main-process-only module; in the renderer process it MUST be accessed via the remote bridge. Implementation: `require("@electron/remote").dialog.showSaveDialog(...)` with a fallback to `require("electron").remote.dialog.showSaveDialog(...)` for older Obsidian builds that still ship the legacy `remote` shim. Validate at module load (`packFileIO.ts` initializer) that at least one of these is callable; if neither is, surface a one-time clear error and return `{ ok: false, reason: "io", message: "Save dialog unavailable in this runtime." }` rather than silently degrading. **Suggested filename: `<sanitized-label>.pack.json`** (consistent with the Export UI in 4B). Returned path is what `fs.writeFileSync` writes to.
  - **Writing** goes through Node `fs.writeFileSync` against the absolute path returned by the save dialog (mirroring `src\settings\SettingsTab.ts:276-288` pattern). Node `fs` is used ONLY on the export (write) path; import uses HTML5 `File` API exclusively.
  - **Mobile / non-desktop is explicitly out of scope:** if Node `fs` or the Electron remote `dialog` is unavailable at module load, the writer returns `{ ok: false, reason: "io", message: "Desktop-only feature." }`. The reader (HTML5 `File` API) is cross-platform-compatible, but since the rest of the MCP feature already requires desktop, the reader also returns the desktop-only error when `(window as any).process?.versions?.electron` is absent (consistent with existing MCP desktop gating).
- **`src\settings\presets\packImporter.ts`** (new): pure orchestration
  - `type ImportPackOutcome` discriminated union: `sizeError | parseError | validationError | ioError | cancelled | confirmNew | confirmReimport`. Confirm variants carry the parsed `pack`; `confirmReimport` additionally carries `diff` and `metadataChanged`. All variants carry `sizeWarning` where applicable.
  - `runPackImport(args: { text; sourcePath; byteLength; existingRecord: ImportedPackRecord | null }): ImportPackOutcome` — composes `parsePackText` → `validatePack` → if `existingRecord` then `diffPacks` → outcome. Returns the first error encountered; zero side effects.
  - `applyConfirmedImport(store: PresetPacksStore, pack: Pack, sourcePath: string): Promise<ImportedPackRecord>` — calls `store.addOrReplace`.
- **`src\settings\packSettingsLogic.ts`** (new): pure
  - `renderModelForPackList(records: ImportedPackRecord[]): { rows: { recordId: string; label: string; version: string; sourcePath: string; importedAtIso: string; presetCount: number }[] }`.
  - `formatImportConfirmText(outcome: Extract<ImportPackOutcome, { kind: "confirmNew" }>): string` and `formatReimportDiffText(outcome: Extract<ImportPackOutcome, { kind: "confirmReimport" }>): string` produce the strings the confirm dialog shows (testable without DOM). **`formatImportConfirmText` MUST include all four of: pack `label`, pack `version`, source path (the absolute path the user supplied), and preset count — matching Spec P1 acceptance (`Spec.md:60-61`). Tests assert each of these four fields appears literally in the output, plus the large-pack notice when `sizeWarning` is set.**
- **`src\settings\McpServersSection.ts`** (DOM wiring): Add a new "Imported preset packs" subsection above the configured-server list (`src\settings\McpServersSection.ts:85-109`). Use the same DOM idiom as the existing list. Per-row fields per FR-006: label, version, source path, formatted import time, preset count, `Remove pack` button.
  - `Import pack from file…` button → `packFileReader.pickAndReadPackFile()` → `runPackImport()` → render branch:
    - Error branches: single `new Notice` with parser/validator message and `pointer` (or `line:col`); nothing persists (FR-002, SC-003).
    - `confirmNew` / `confirmReimport`: open `confirmDestructive` (`src\ui\ConversationPicker.ts:208-260`) with body composed by `formatImportConfirmText` / `formatReimportDiffText`; on confirm, call `applyConfirmedImport` and re-render the pack list AND the Add Server preset dropdown via the effective registry (the dropdown wiring lands in Phase 4 — Phase 3 wires a re-render hook the dropdown will subscribe to).
  - `Remove pack` button per row → confirm with explicit phrasing `"Remove pack <label>? Already-configured servers will continue to function unchanged."` (FR-008 / SC-004) → `presetPacksStore.remove(packId)` → re-render. MUST NOT touch `mcpServers`.

### Tests:
- **`packImporter.test.ts`** (new):
  - Happy path new import → `confirmNew` with parsed pack.
  - Size > 1 MB → `sizeError`; no parse attempted.
  - 100 KB < size < 1 MB → `confirmNew` with `sizeWarning: true` (SC-008).
  - Malformed JSON → `parseError` with line/column (SC-003).
  - Schema-invalid → `validationError` with pointer (SC-003).
  - Re-import with identical canonical form → `confirmReimport` with empty deltas (SC-007 no-change).
  - Re-import with one added + one changed → diff matches (SC-007 changed).
  - `applyConfirmedImport` calls `store.addOrReplace`.
  - **SC-006 (import side): `runPackImport` for a stdio pack whose `command` does not exist on PATH still produces `confirmNew` (no preflight/exec callback invoked, no error). Asserted by injecting a spy `commandExists` fake and verifying it is never called during import.**
- **`packFileIO.test.ts`** (new, limited): injection contract; in-memory fake reader; error reasons round-trip.
- **`packSettingsLogic.test.ts`** (new): render model zero/N records; `formatImportConfirmText` grammar (1 preset / N presets) and large-pack notice append; `formatReimportDiffText` empty → `"No changes."`; non-empty sections rendered with preset ids.
- **`McpServersSection.packsList.test.ts`** (new, FakeElement): seeded store renders one row per record with expected text; `Remove pack` invokes destructive-confirm helper; on confirm, store's `remove` is invoked; existing `mcpServers` snapshot unchanged before/after.
- **`McpServersSection.packImport.test.ts`** (new, FakeElement): with injected fake `PackFileReader`:
  - Outcome `validationError` → exactly one Notice rendered (SC-003); store not mutated.
  - Outcome `confirmNew` → on confirm, store gains the record.
  - Outcome `confirmReimport` empty diff → body `"No changes."`; on confirm, only `importedAt` updated.

### Success Criteria:

#### Automated Verification:
- [ ] Tests pass: `npm test`
- [ ] Typecheck: `npm run typecheck`
- [ ] Build: `npm run build`
- [ ] All `ImportPackOutcome` variants covered by tests.
- [ ] SC-001 (import-side ≤4 clicks + persistence on confirm), SC-003, SC-004 (state-side), SC-006 (import side: no preflight invocation), SC-007, SC-008 each have at least one assertion.

#### Manual Verification:
- [ ] `npm run deploy`, reload Obsidian. Author a minimal fixture pack JSON (`fixtures/sample.pack.json` — non-committed, generic placeholders per Spec NFR). Import via the new button → confirm preview → pack appears in the list. (Add Server dropdown grouping lands in Phase 4.)
- [ ] Re-import the same file → diff confirm shows `"No changes."`; modify the pack to add one preset → re-import → diff shows the added id; confirm.
- [ ] Hand-craft a malformed pack (missing `id`) → exactly one Notice; nothing persists.
- [ ] Hand-craft a JSONC pack (with `// comment`) → rejected with single error.
- [ ] 200 KB pack → large-pack notice but succeeds; 2 MB pack → rejected before parse.
- [ ] Remove a pack → list updates; FR-008 invariant: `mcpServers` in `data.json` unchanged.

---

## Phase 4: Add Server dropdown grouping + Export UI

**Covers:** FR-004, FR-005, FR-011, FR-012, FR-013d, FR-014, FR-015, FR-020; SC-001 (dropdown-visibility side: imported presets visible immediately on import confirm via re-render hook), SC-002, SC-004 (dropdown side: removed pack's presets disappear from dropdown), SC-006 (pack code paths — both import and dropdown selection — invoke NO preflight; the existing form-level preflight hint code path is unchanged and continues to fire only when the form has a command value, exactly as today; spec wording "user actually tries to use" is satisfied by leaving the existing runtime preflight + tool-call path entirely unmodified — packs add nothing earlier), SC-009.

### Changes Required:

#### 4A — Dropdown grouping + pre-fill from imported presets

> **Implementation prerequisite (one-day spike before 4B export UI):** Verify that at least one of `require("@electron/remote").dialog.showSaveDialog` or `require("electron").remote.dialog.showSaveDialog` is callable in the developer's pinned Obsidian Desktop version. If neither is available, surface the finding before building the multi-select export UI around the unverified bridge — the alternative (writing into the vault root via `app.vault.adapter.write` and surfacing the path via a Notice) is preserved as a documented fallback in Phase 6. Record spike outcome in WorkflowContext.md before committing 4B code.

- **`src\settings\presetDropdownLogic.ts`** (new): pure
  - `buildPresetDropdownModel(registry: EffectivePreset[]): { groups: { label: string; options: { value: string; text: string }[] }[]; emptyOption: { value: ""; text: string } }`. Groups: `"Built-in"` first, then `"From <pack.label>"` per imported pack in `effectiveRegistry` order.
  - `applyEffectivePresetToForm(effective: EffectivePreset, form: McpServerFormInput, opts: { secretPlaceholder: string }): { form: McpServerFormInput; requiredSecretFields: string[] }`:
    - Mirrors current `preset.build()` copy logic (`src\settings\McpServersSection.ts:397-416`) generalized across stdio + HTTP.
    - Detects `SECRET_PLACEHOLDER` values in source preset's credential / env fields; leaves them empty in the form and records form-field names in `requiredSecretFields`.
- **`src\settings\McpServersSection.ts`** (DOM layer):
  - Construct `EffectivePreset[]` via `buildEffectiveRegistry(BUILT_IN_PACK, presetPacksStore.snapshot())` at form open.
  - Render the optgroup-aware dropdown by directly manipulating the existing `<select>` element children (the local `select(...)` helper is bypassed for this one dropdown; FakeElement compatibility maintained by feature-detecting `Document.createElement` and falling back to flat options in the test harness — same precedent as `src\settings\McpServersSection.ts:380-392`).
  - On change, call `applyEffectivePresetToForm`, then write fields into existing form input elements. For each `requiredSecretFields` entry, mark the corresponding input `aria-required="true"` and render a hint reading `"Pack-templatized: please supply a value before saving."`.
  - Preflight hint rendering reused unchanged (`src\settings\McpServersSection.ts:416-427`). **Phase 4 introduces NO new preflight invocations and NO new code path that triggers `commandExists` / runtime probes. The existing form-level hint continues to fire only when the user has a `command` value in the form — exactly as today.**
  - **SC-006 / FR-015 interpretation (explicit reconciliation):** SC-006 says the hint surfaces "only when the user actually tries to use a server configured from one of its presets"; FR-015 says pack-declared preflight checks behave **identically** to built-in preflight checks. Built-in presets today already surface the non-blocking install hint at the form level the moment a `command` value is pre-filled (`src\settings\McpServersSection.ts:416-427`). Treating "tries to use" as the runtime tool-call would require changing the existing built-in behavior, which is out of scope and would break FR-015 (packs would behave differently from built-ins). **Implementation interpretation: FR-015 governs. Pack-declared preflight surfaces at the form level identically to built-in. "Tries to use" is satisfied by the fact that the user has intentionally selected a preset and is filling out the form to configure a server — packs never invoke preflight earlier than the existing form-level surface (no probe on import, no probe on dropdown selection itself; only the unchanged form-level path applies).** If a future spec revision wants to defer the hint strictly to runtime, it would need to also update the built-in preflight behavior; this is captured as a deliberate non-goal in "What We're NOT Doing".
  - Wire the Phase 3 import re-render hook to also re-render the dropdown.
- **`src\settings\mcpServerFormLogic.ts`**: Extend `McpServerFormValidationResult` with `requiredSecretFields: string[]` (optional; default `[]`); add a validation error `"Required field <name> from imported pack must be filled in before saving."` if any named field is empty at submit.

#### 4B — Export UI: multi-select + save dialog

- **`src\settings\McpServersSection.ts`**: Add an `Export servers as pack…` button to the MCP servers section header.
- **`src\settings\packExportFlow.ts`** (new): pure
  - `buildExportFlowModel(servers: McpServerConfig[]): { rows: { id; name; transport: "stdio" | "http"; selected: boolean }[]; defaultPackMeta: { id; label; version } }`.
  - `toggleSelection(rows, id) → rows`.
  - `runExport(rows, meta, exporter = exportServersAsPack): { ok: true; pack: Pack; serialized: string } | { ok: false; reason: "no-selection" }`. `serialized = JSON.stringify(pack, null, 2)`.
  - Default meta: `id = "exported-pack"`, `label = "Exported servers"`, `version = new Date().toISOString().slice(0, 10)` — user editable.
- **UI**: Small inline DOM dialog (reuse FakeElement-friendly checkbox list pattern; multi-select is not subsumed by `confirmDestructive`). Three meta inputs (`id`, `label`, `version`), server checkbox list, `Cancel` / `Export` buttons. On `Export`: call `runExport`, then `packFileWriter.saveTextToPath(<label>.pack.json, serialized)`.

### Tests:
- **`presetDropdownLogic.test.ts`** (new):
  - Empty registry → only `"Built-in"` group with exactly the M365 entry.
  - Two packs → three groups in correct order; effective ids and display labels per FR-013.
  - `applyEffectivePresetToForm` for a stdio preset writes `transport: "stdio"`, `command`, `args`.
  - Secret placeholder detection: `static-bearer` whose `token === SECRET_PLACEHOLDER` → empty `authorization` and `requiredSecretFields: ["authorization"]`.
  - **`command-based` preset (per revised FR-020) → `command` / `args` round-trip verbatim (NOT marked as required secret field). Test asserts: source preset `{ kind: "command-based", command: "internal-mcp-cli", args: ["--mcp"], tokenPath: "__NEEDS_VALUE__", expiryPath: "__NEEDS_VALUE__" }` → form state has identical command/args, and `requiredSecretFields` is empty.**
- **`mcpServerFormLogic.credentials.test.ts`**: extend — `requiredSecretFields` non-empty AND corresponding field empty → validation fails; field filled → succeeds.
- **`McpServersSection.packDropdown.test.ts`** (new, FakeElement):
  - Zero packs → dropdown contents unchanged from today.
  - One fixture pack present → dropdown lists new preset under its pack group label.
  - Selecting an imported preset whose credential is templatized leaves the token field empty and renders the "required" hint.
  - After Phase 3 import re-render hook fires, dropdown re-renders without form rebuild (SC-001 dropdown side).
  - After Phase 3 remove, dropdown no longer contains the removed presets (SC-004 dropdown side).
  - **SC-006 dropdown-selection inertness: selecting a stdio preset whose `command` does not exist on PATH still completes pre-fill (no thrown error, form state populated) without `packDropdownLogic` invoking any preflight / `commandExists` / fs lookup itself. The existing form-level preflight hint at `src\settings\McpServersSection.ts:416-427` continues to render through its own unchanged code path; the pack dropdown adds no new preflight invocation. Asserted via spy fake `commandExists` provably not called from the dropdown selection path.**
- **`packExportFlow.test.ts`** (new):
  - Empty selection → `no-selection` reason.
  - One selected `static-bearer` → exported pack has placeholder; round-trips through `validatePack`.
  - Multiple selected → preset ids uniqued.
  - Meta editing reflected in serialized output.
  - SC-002: 1, 5, 20 servers → exported pack validates AND `runPackImport` yields effective presets producing form pre-fill identical to originals on every non-secret field (canonical-form equality on non-secret projection).
  - SC-009: `none`-credentials server round-trips with NO `requiredSecretFields`; `static-bearer` server round-trips WITH `requiredSecretFields: ["authorization"]`.
- **`McpServersSection.packExport.test.ts`** (new, FakeElement): selecting servers and clicking Export invokes injected `packFileWriter` with expected text; cancel does not invoke it.

### Success Criteria:

#### Automated Verification:
- [ ] Tests pass: `npm test`
- [ ] Typecheck: `npm run typecheck`
- [ ] Build: `npm run build`
- [ ] SC-001 (dropdown-visibility-on-import-confirm) asserted via FakeElement re-render-hook test.
- [ ] SC-004 (dropdown-side: removed pack's presets disappear) asserted in `McpServersSection.packDropdown.test.ts`.
- [ ] SC-006 (dropdown-selection inertness: pack dropdown adds no new preflight invocation; existing form-level preflight hint code path unchanged) asserted in `McpServersSection.packDropdown.test.ts`.
- [ ] SC-002 (1/5/20 round-trip) and SC-009 (secret vs non-secret) explicitly asserted in `packExportFlow.test.ts`.

#### Manual Verification:
- [ ] `npm run deploy`, reload Obsidian. With a previously imported pack (from Phase 3), open Add Server → new preset appears under `From <label>`; select it; pre-fill correct; templatized fields empty with the "required" hint. M365 built-in still pre-fills as before.
- [ ] Configure a server from an imported preset; remove the pack (Phase 3 UI); preset disappears from dropdown but configured server still works (kick a chat tool call) — SC-004.
- [ ] Configure two MCP servers (one HTTP `none`, one HTTP `static-bearer`). Click Export → select both → save file. Open the resulting JSON: second's token is the placeholder; first preserves verbatim non-secret fields. Import file into a different vault profile, select each preset, confirm pre-fill matches SC-009 expectations.
- [ ] **SC-006 use-side (spec wording "when the user actually tries to use a server configured from one of its presets"):** Import a fixture pack whose stdio preset declares a deliberately bogus `command` (e.g. `nonexistent-cli-xyz`). Select that preset from the dropdown → save the resulting server config. Then issue a chat tool call that would route to that server. Verify the existing non-blocking install hint surfaces at the runtime touch point (not earlier — confirm no hint was shown during import confirm). Record measured behavior in the PR description.

---

## Phase 5 (out-of-band, no public-repo commits): Author internal packs in `<companion-private-repo>`

**Covers:** FR-019; SC-005.

> **This phase produces NO commits, PRs, files, or test fixtures in
> the public `obsidian-copilot-agent` repo.** It is tracked here for
> completeness because the Spec scopes it as part of the work
> (`.paw\work\preset-packs\Spec.md:128-148`,
> `.paw\work\preset-packs\WorkflowContext.md:44-52, 54-58`).

### Changes Required (in the PRIVATE repo only):

- One pack JSON per internal-CLI-exposed M365 product (e.g. mail, calendar, files, teams — whichever surfaces the internal CLI exposes), each validating against the v1 schema established in Phase 1. Authoring path: configure one server per product by hand in a real vault, use the Phase 4 export feature to bootstrap a starter JSON, then hand-refine labels, descriptions, and `preflight.installHint` text.
- A `README.md` in the private repo describing the import → configure → smoke-test workflow AND containing the per-pack smoke-test checklist (one section per pack). Per Spec SC-005, the README is the canonical evidence location — no separate `CHECKLIST.md`.

### Success Criteria:

#### Automated Verification:
- N/A in the public repo. Public CI is unaffected.

#### Manual Verification (recorded in the private repo's `README.md`):
- [ ] Each pack file validates: import via the plugin and observe no validation errors.
- [ ] Each pack imported renders its presets under the expected pack group in the Add Server dropdown.
- [ ] Configuring a server from each pack preset succeeds end-to-end with at least one chat tool call (per FR-019 / SC-005).
- [ ] **Public-repo audit (manual diff scan):** no internal CLI binary names, hostnames, URLs, contact aliases, or tenant identifiers in any public source/test/fixture/doc/PAW artifact (`.paw\work\preset-packs\Spec.md:208-213`).

---

## Phase 6: Documentation

**Covers:** Spec § Scope "Updating in-repo documentation" (`.paw\work\preset-packs\Spec.md:249-250`); Settings-performance NFR (`Spec.md:213`) verified as a manual measurement and recorded in `SmokeChecklist.md`.

### Changes Required:

- **`docs\preset-packs.md`** (new): task-oriented doc mirroring `docs\m365-graph-mcp.md` style (`docs\m365-graph-mcp.md:21-120`).
  - "What is a preset pack" — short paragraph.
  - "Pack file format" — annotated v1 schema with one HTTP example and one stdio example. Generic placeholders ONLY (`internal-mcp-cli`, `example.org`) per the privacy NFR.
  - "Import a pack" — UI walkthrough (file picker → preview → confirm); large-pack notice and rejection thresholds.
  - "Re-import / update" — diff confirmation explanation.
  - "Remove a pack" — and the FR-008 invariant.
  - "Export servers as a pack" — including the secret-templating contract: which fields per credential kind become `__NEEDS_VALUE__` placeholders, why, and what the recipient sees on import.
  - "Conflict namespacing" — FR-013 rules with worked examples.
  - "Safety model" — packs are inert; first command spawn still hits the safety prompt; importing never auto-enables.
  - "Reserved-but-inert credential variants" — `oauth-pkce` is accepted by the schema but the runtime resolver throws `not-implemented` at first tool call. Pack authors should NOT use `oauth-pkce` in shippable v1 presets.
  - "Troubleshooting" — parse errors, validation errors, missing source file, large pack rejected.
- **`README.md`**: "What's new" section adds a one-line bullet under the next version with a link to `docs\preset-packs.md` (existing pattern at `README.md:7-19`).
- **`CHANGELOG.md`**: New unreleased section (e.g. `[0.8.0] - Unreleased`) summarizing the feature in 3-5 bullets, mirroring v0.7.0 style (`CHANGELOG.md:12-21`).
- **`.paw\work\preset-packs\Docs.md`**: Populate via `paw-docs-guidance` template — feature summary, doc locations, what intentionally was NOT documented (e.g. URL import).
- **`.paw\work\preset-packs\SmokeChecklist.md`** (new): Final manual checklist for **public-repo plugin behavior only** — import a generic fixture pack, remove, re-import (no-change and changed), export round-trip, large-pack thresholds, settings-performance measurement. **MUST NOT reference internal CLI binary names, hostnames, URLs, or tenant identifiers** (Spec privacy NFR `Spec.md:208-213`). **Private-pack end-to-end smoke evidence lives ONLY in the private repo's `README.md`** per SC-005 — the public SmokeChecklist may include at most a one-line pointer that private-pack smoke was recorded out-of-band; it does not list private products, packs, or outcomes. The settings-performance measurement step is included here per Spec NFR (`Spec.md:213`).

### Success Criteria:

#### Automated Verification:
- [ ] Tests pass: `npm test`
- [ ] Typecheck: `npm run typecheck`
- [ ] Build: `npm run build`
- [ ] No docs build script in `package.json`; markdown accuracy verified by review (`.paw\work\preset-packs\CodeResearch.md:30-35`).
- [ ] Manual grep of new files under `docs/` finds zero discouraged identifier patterns (reviewer responsibility, no CI gate per Spec).

#### Manual Verification:
- [ ] Render `docs\preset-packs.md` in Obsidian preview; links resolve; example JSONs are valid; secret placeholders use the documented `__NEEDS_VALUE__` literal.
- [ ] Following `docs\preset-packs.md` in a fresh vault is sufficient to import a generic pack, add a server from it, remove the pack, and export a configured server back to JSON.
- [ ] `SmokeChecklist.md` can be executed step-by-step on a deployed vault without consulting source code.
- [ ] README "What's new" link opens the new doc.
- [ ] CHANGELOG entry reads cleanly with no leaked internal identifiers.
- [ ] **Settings performance NFR (`Spec.md:213`)**: On the developer's reference workstation (record CPU / RAM / OS in `SmokeChecklist.md` alongside the measurement), use the browser/Electron devtools Performance panel to time settings-tab open and a save round-trip in two states: (a) no imported packs (baseline), (b) five 100 KB packs imported and one 1 MB pack imported. The delta MUST be ≤ 200 ms for both open and save. Record both numbers in `SmokeChecklist.md` and reference them from the Final PR description. If the delta exceeds 200 ms, treat as a regression and open a follow-up issue before merging.


## Phase 7: Promoted candidate features

**Covers:** Promoted Candidate A (compiled JSON Schema export), Candidate B (per-row "Export this server" shortcut), and Candidate C (rich semantic re-import diff). This is a single-commit phase on the local-strategy `feature/preset-packs` branch: all three promoted candidates land together, with no runtime validation switch to JSON Schema and no new runtime dependencies.

### Cross-cutting decisions

- **No new runtime dependencies.** The JSON Schema is a maintained editor/documentation artifact only; import/export enforcement remains the hand-written `validatePack` path (`src\settings\presets\packValidator.ts:53-121`, `src\settings\presets\packExporter.ts:84-90`). No JSON-schema library is added.
- **Schema dialect:** Use JSON Schema draft-07 for broad VS Code/editor compatibility; restrict the schema to common keywords (`type`, `required`, `properties`, `additionalProperties`, `const`, `enum`, `oneOf`, `not`, `pattern`, `minLength`, `items`).
- **Settings-performance NFR:** Keep normal settings open/save work within the existing O(N) row render path. Schema checks run only under scripts/tests, and rich semantic diff runs only during re-import after file selection, not on settings open (`.paw\work\preset-packs\CodeResearch-Phase7.md:119-124`).
- **Privacy NFR:** Every new fixture, schema example, and docs snippet uses generic placeholders only: `internal-mcp-cli`, `example.org`, `example-corp-graph`, and `__NEEDS_VALUE__`. No internal product, host, tenant, or URL strings are introduced.
- **Test discipline:** All new tests remain pure-node Vitest. UI tests use the existing FakeElement harness; do not add jsdom/happy-dom.

### Sub-phase 7A — Compiled JSON Schema export

#### Changes Required:

- **`docs\schemas\preset-pack-v1.json`** (new): Hand-authored JSON Schema mirroring the runtime validator for editor autocomplete and authoring assistance.
  - Top-level pack object:
    - `$schema` set to draft-07 and `$id` stable for docs references.
    - `required`: `schemaVersion`, `id`, `label`, `version`, `presets`.
    - `schemaVersion` constrained with `const: 1` (or an equivalent single-value enum) to mirror `schemaVersion === 1` (`src\settings\presets\packValidator.ts:59-60`).
    - `id`: non-empty string (`src\settings\presets\packValidator.ts:62-64`) and `not: { const: "builtin" }` for the reserved built-in namespace (`src\settings\presets\packValidator.ts:13-18`, `src\settings\presets\packValidator.ts:65-70`). Do **not** invent a stricter pack-id regex unless the runtime validator is changed in the same commit; the current validator has no pack-id regex beyond non-empty/reserved-id checks. The schema `description` may recommend slug-like ids for pack authors.
    - `label` and `version`: non-empty strings (`src\settings\presets\packValidator.ts:71-75`); `description`: optional string (`src\settings\presets\packValidator.ts:77-79`).
    - `presets`: non-empty array (`src\settings\presets\packValidator.ts:80-85`). Duplicate preset-id rejection is validator-only and must be documented because draft-07 cannot express unique-by-property without custom keywords (`src\settings\presets\packValidator.ts:95-109`).
    - `additionalProperties: true` at the top level to match warn-and-accept behavior (`src\settings\presets\packValidator.ts:20-27`, `src\settings\presets\packValidator.ts:87-93`).
  - Preset object:
    - `required`: `id`, `label`, `server`, `credentials`.
    - `id`: non-empty string matching `^[a-z0-9][a-z0-9._-]*$` with case-insensitive authoring guidance; because JSON Schema draft-07 patterns are case-sensitive, encode `[A-Za-z0-9]` ranges or document the case-insensitive runtime rule (`src\settings\presets\packValidator.ts:148-156`).
    - `label`: non-empty string; `description`: optional string (`src\settings\presets\packValidator.ts:157-165`).
    - `additionalProperties: false` to mirror unknown preset-level rejection (`src\settings\presets\packValidator.ts:29-36`, `src\settings\presets\packValidator.ts:136-145`).
  - `server` union:
    - `oneOf` HTTP and stdio branches keyed by `transport` (`src\settings\presets\packValidator.ts:211-315`).
    - Common `name`: non-empty string and no-control-character pattern matching the runtime guard (`src\settings\presets\packValidator.ts:216-224`).
    - HTTP: `transport: "http"`, required `url` string; document validator-only URL host/scheme classification (`validateMcpHttpUrl(..., { allowPrivateNetwork: true })`) including loopback/private-network behavior (`src\settings\presets\packValidator.ts:225-245`, `src\mcp\httpPolicy.ts:26-45`, `src\mcp\httpPolicy.ts:84-104`).
    - Stdio: `transport: "stdio"`, required non-empty `command` with no-control-character pattern; optional `args` array of strings with the same pattern; optional `env` object with string values; optional string `cwd` (`src\settings\presets\packValidator.ts:247-310`).
  - `credentials` union:
    - `oneOf` branches discriminated by `kind` for `none`, `static-bearer`, `command-based`, and `oauth-pkce` (`src\settings\parseServerCredentials.ts:38-137`).
    - `none`: `kind: "none"` (`src\settings\parseServerCredentials.ts:38-41`).
    - `static-bearer`: required non-empty string `token` (`src\settings\parseServerCredentials.ts:42-50`).
    - `command-based`: required non-empty string `command`; optional string-array `args`; optional string `tokenPath` / `expiryPath`; optional non-negative number `refreshBufferSeconds` (`src\settings\parseServerCredentials.ts:52-90`).
    - `oauth-pkce`: required string `authorizationEndpoint`, `tokenEndpoint`, `clientId`; required string-array `scopes`; optional string `tenantId`, `redirectUri`, `refreshTokenRef`, `pkceMethod`; preserve unknown future keys with `additionalProperties: true` (`src\settings\parseServerCredentials.ts:92-135`).
  - `preflight`: optional object with `type: "findOnPath"`, required non-empty `command`, optional string `installHint` (`src\settings\presets\packValidator.ts:324-367`).
  - Parser/runtime-only limitations documented in schema `description` or `$comment`: strict JSON, BOM stripping, JSONC rejection, 1 MB hard cap, 100 KB warning, duplicate preset ids, full URL host classification, and any control-character nuance not safely represented in draft-07 (`src\settings\presets\packParser.ts:3-11`, `src\settings\presets\packParser.ts:20-88`).
- **`scripts\check-pack-schema.mjs`** (new): No-dependency Node script that parses `docs\schemas\preset-pack-v1.json` and asserts drift-sensitive structural invariants: expected `$schema`, top-level required array, `schemaVersion` const/enum, top-level `additionalProperties: true`, preset `additionalProperties: false`, transport `oneOf` branch names, credential `kind` branch names, required arrays, and limitation comments for validator-only rules.
- **`src\settings\presets\packSchema.test.ts`** (new): Vitest drift gate that imports the schema JSON and the same representative fixture families covered by `packValidator.test.ts` (`src\settings\presets\packValidator.test.ts:26-243`). Exact comparison strategy:
  1. For each accepted fixture, assert `validatePack(fixture).ok === true`, then assert the schema contains a matching structural path for every used construct (top-level fields, transport branch, credential branch, preflight shape).
  2. For each rejected fixture whose rule is expressible structurally (missing required field, wrong `schemaVersion`, reserved `builtin`, bad preset id pattern, unknown preset-level field, bad credential kind), assert `validatePack(fixture).ok === false` and assert the corresponding schema invariant exists.
  3. For each rejected fixture whose rule is validator/parser-only (duplicate preset ids, URL host classification, JSONC/size/BOM behavior, subtle control-character behavior if not encoded), assert `validatePack(fixture).ok === false` and assert the schema documents the limitation in `$comment`/`description` rather than pretending to validate it.
  4. Do **not** execute JSON Schema validation in tests; the schema is inspected structurally so no schema-validation dependency is introduced. For every fixture, the test records the same outcome category as runtime validation: accepted, rejected by a schema-expressible invariant, or rejected by a documented runtime-only limitation.
- **`package.json`**: Add `schema:check` (`node scripts/check-pack-schema.mjs`). Keep `npm test` as the primary Vitest gate; optionally call `schema:check` from local/release verification, not from runtime code.
- **`docs\preset-packs.md`**: Add an "Editor integration" subsection showing how pack authors can add `"$schema": "./schemas/preset-pack-v1.json"` or a relative path to get VS Code autocomplete, and explicitly state that plugin import still uses the runtime validator.
- **`README.md`**: Add a short pointer only if the existing v0.8 "What's new" section needs to advertise schema-assisted pack authoring; otherwise keep the detailed guidance in `docs\preset-packs.md`.

#### Tests:

- **`src\settings\presets\packSchema.test.ts`**: At least 8 assertions: schema parses; required arrays; top-level/preset additionalProperties behavior; schemaVersion constraint; pack-id reserved rule; preset-id pattern; transport branches; credential branches; validator-only limitations documented.
- **`scripts\check-pack-schema.mjs`**: Exercised via `npm run schema:check` in local verification.

### Sub-phase 7B — Per-row "Export this server" shortcut

#### Changes Required:

- **`src\settings\packExportFlow.ts`**: Add a pure single-server model helper (or an options parameter on `buildExportFlowModel`) that returns one selected row for the requested server while preserving `runExport` as the only export execution path. Defaults for the row shortcut:
  - pack id = slug derived from the server name;
  - pack label = server name;
  - version = `"1.0.0"`;
  - if two configured servers slug to the same default id, append a deterministic `-2`, `-3`, ... suffix for the later row so the default metadata is stable and collision-resistant.
- **`src\settings\McpServersSection.ts`**: Add a row-scoped **Export this server as pack…** button next to the existing Edit / Enable-Disable / Reconnect / Remove / Test connection row actions (`src\settings\McpServersSection.ts:170-253`). Gate it behind `this.options.packFileWriter`, matching the header Export button (`src\settings\McpServersSection.ts:152-158`).
  - Handler opens a streamlined dialog, per research recommendation, with pack id / label / version fields, static text naming the single server, and Cancel / Export buttons; no checkbox list.
  - On Export, call `runExport` with the single selected row and the full server list (or a one-server list if the helper owns filtering), then reuse `suggestedFilename`, the injected writer, existing success/error status behavior, and the same serialized pack format as the multi-select flow (`src\settings\packExportFlow.ts:57-87`, `src\settings\McpServersSection.ts:724-802`).
  - Make the button available for both HTTP and stdio servers; do not inherit the HTTP-only Test connection condition (`src\settings\McpServersSection.ts:247-253`).
  - Aria/keyboard behavior: use the same native `<button>` pattern, focus order, title/label style, and click handler conventions as Edit, Remove, and Test connection so keyboard activation and screen-reader naming remain consistent.
- **`src\settings\McpServersSection.packRowExport.test.ts`** (new; FakeElement-based): Dedicated row shortcut coverage rather than overloading the existing multi-select export tests.
- **`src\settings\packExportFlow.test.ts`**: Add pure helper coverage for one-server defaults, slug generation, slug-collision suffixing, and `runExport` receiving exactly one selected server.
- **`src\settings\McpServersSection.packExport.test.ts`**: Keep existing header/multi-select tests green; update shared helpers only if the row-export button changes query counts.

#### Tests:

- Success path: clicking a row export button opens the minimal dialog, accepting writes a one-preset pack via the injected writer, and the serialized JSON omits all other configured servers.
- Cancel path: Cancel closes the dialog and writer is not called.
- Slug-collision suffix: duplicate/similar server names produce stable suffixed default pack ids.
- Stdio case: a stdio server row exposes the shortcut and exports successfully.
- No-writer gate: row shortcut is absent when `packFileWriter` is not wired, matching the header behavior.

### Sub-phase 7C — Rich semantic re-import diff

#### Changes Required:

- **`src\settings\presets\packDiff.ts`**: Extend the changed-preset shape while preserving existing fields for callers:
  - Add `export interface PackPresetFieldDiff { pointer: string; before: unknown; after: unknown; secret?: boolean; placeholderState?: "unchanged-placeholder" | "placeholder-to-value" | "value-to-placeholder" | "value-to-value" }`.
  - Change `changed` entries to `{ id: string; from: PackPreset; to: PackPreset; fields: PackPresetFieldDiff[] }`.
  - Match presets by id as today, then canonicalize both `PackPreset` objects using the existing `packCanonical` ordering before walking fields (`src\settings\presets\packCanonical.ts:4-49`, `src\settings\presets\packDiff.ts:27-49`). Reorder-only canonical equality continues to produce no changed entry.
  - Walk object fields recursively and arrays by index. Emit pointers against the incoming pack's preset index, e.g. `/presets/<idx>/label`, `/presets/<idx>/server/command`, `/presets/<idx>/credentials/token`.
  - Secret-templating awareness: import `SECRET_PLACEHOLDER` from `packSecretPolicy`. If `before` and `after` are both `SECRET_PLACEHOLDER`, suppress that field from `fields` because it is still templatized. If placeholder status changes in either direction, emit a high-signal field diff without requiring the formatter to print raw secret values.
  - Identify secret-bearing paths using the existing export secret policy where possible: `credentials.token`, `credentials.refreshTokenRef`, `credentials.tenantId`, oauth-pkce unknown fields, and denylisted stdio `server.env` values. Prefer conservative `secret: true` for unknown credential-field changes.
- **`src\settings\presets\packDiff.test.ts`**: Extend current coverage for label-only, server command/args/env changes, credential kind/token placeholder changes, preflight changes, reorder-only no diff, metadata-only no preset field diff, and both-placeholders-suppressed behavior.
- **`src\settings\packSettingsLogic.ts`**: Extend `formatReimportDiffText` to render field annotations beneath each `~ id — label` changed preset line.
  - Render concise user-facing labels such as `label changed: "Old" → "New"`, `server.command unchanged/changed`, `credentials.kind changed`, and `credentials.token placeholder status changed`.
  - Do not echo raw secret-bearing values. For secret fields, render placeholder/value state only (for example, `credentials.token changed: placeholder → value` or `value → placeholder`).
  - Cap field-level output at **N = 8** lines across the entire confirm body. Add `and K more changes` when capped so the plain `window.confirm` body remains short.
  - Preserve existing metadata, added, removed, and changed headings so current exact-text expectations can be updated surgically (`src\settings\packSettingsLogic.ts:65-107`).
- **`src\settings\packSettingsLogic.test.ts`**: Extend exact-text tests for rich annotations, cap behavior, metadata formatting, and no secret-value leakage.
- **`src\settings\McpServersSection.ts`**: Minor render/confirm plumbing only: continue passing the formatter's plain string to `askConfirm`; do not introduce a new modal framework (`src\settings\McpServersSection.ts:909-918`, `src\settings\McpServersSection.ts:938-945`).
- **`src\settings\McpServersSection.packs.test.ts`**: Reinforce the FakeElement re-import flow so confirm text includes field-level annotations and cancel/confirm behavior remains unchanged.

#### Tests:

- Field walker emits `/presets/<idx>/...` pointers for label, server, credentials, and preflight changes.
- Canonical key-order differences and preset reorder-only inputs remain no-op diffs.
- `SECRET_PLACEHOLDER` to `SECRET_PLACEHOLDER` is suppressed; placeholder-to-value and value-to-placeholder produce safe annotations without raw secret values.
- Confirm formatter caps at 8 field lines and appends `and K more changes`.
- Existing re-import confirm/cancel behavior remains unchanged apart from richer body text.

### Success Criteria (Phase 7):

#### Cross-cutting Automated Verification:

- [ ] Schema drift gate passes: `npm run schema:check`
- [ ] Tests pass: `npm test`
- [ ] Typecheck: `npm run typecheck`
- [ ] Build: `npm run build`
- [ ] New/extended test count target: at least 20 new assertions across `packSchema.test.ts`, `packExportFlow.test.ts`, `McpServersSection.packRowExport.test.ts`, `packDiff.test.ts`, `packSettingsLogic.test.ts`, and `McpServersSection.packs.test.ts`.
- [ ] No new runtime dependencies in `package.json`; if a dev-only tool is proposed, the implementing commit must justify it against `CodeResearch-Phase7.md` and prefer hand-written checks first.
- [ ] Privacy grep/review of new fixtures/docs/schema examples finds only generic placeholders (`internal-mcp-cli`, `example.org`, `example-corp-graph`) and no internal identifiers.
- [ ] Settings-performance NFR remains credible: no schema code runs in settings render, per-row export adds only one gated row button per server, and semantic field diff runs only in re-import. If manual timing from Phase 6 is repeated, delta remains ≤ 200 ms.
- [ ] Phase Candidates markers are already resolved before implementation (5 deferred + 3 promoted); no additional candidate checkboxes remain open.

#### Manual Verification:

- [ ] In VS Code, open a generic pack JSON with a `$schema` reference to `docs\schemas\preset-pack-v1.json`; verify autocomplete/diagnostics for `schemaVersion`, transport branches, credential kinds, and preset fields.
- [ ] In Obsidian after `npm run deploy` and plugin reload, click **Export this server as pack…** on an HTTP configured-server row, accept defaults or override metadata, and verify a one-preset pack file is written.
- [ ] Repeat row export on a stdio server using generic `internal-mcp-cli` data; verify command/args structure is preserved and secret placeholders are used.
- [ ] Re-import a pack with only a preset label changed; verify the confirmation text names the changed preset and shows the label field-level annotation.
- [ ] Re-import a pack where a secret placeholder changes state; verify the confirmation text describes placeholder status without printing raw secret values.
- [ ] Spot-check settings open/save responsiveness with several configured servers and imported packs; no visible regression and any measured delta remains within the ≤ 200 ms NFR.

#### Candidate-linked Success Criteria:

- [ ] **Candidate A:** `docs\schemas\preset-pack-v1.json` is committed, documented, no-dependency drift-gated, and explicitly mirrors or documents every runtime validator/parser constraint.
- [ ] **Candidate B:** Every configured-server row with a writer available has an accessible single-server export shortcut that reuses `packExportFlow.runExport` and writes exactly one selected server.
- [ ] **Candidate C:** Re-import confirmation includes capped, field-level semantic annotations for changed presets, while preserving existing added/removed/metadata behavior and never leaking secret values.

---

## References

- Spec: `.paw\work\preset-packs\Spec.md`
- Research: `.paw\work\preset-packs\CodeResearch.md` (Phases 1-4/6), `.paw\work\preset-packs\CodeResearch-Phase7.md` (Phase 7)
- Per-model planning drafts: `.paw\work\preset-packs\planning\PLAN-gpt-5.4.md`, `.paw\work\preset-packs\planning\PLAN-claude-opus-4.7.md`
- Workflow context: `.paw\work\preset-packs\WorkflowContext.md`
- Proposal grounding: `proposals\0007-importable-preset-packs.md`
- Predecessor phasing reference: `.paw\work\authenticated-mcps\ImplementationPlan.md`

## Phase 8: MCP tool-call error UX (post-final-review scope addition)

**Origin:** Phase 5 smoke testing revealed two plugin UX defects that block a good user experience for imported preset packs (and for any stdio MCP server generally): tool-call failures showed the SDK's generic `Tool execution failed'' fallback with no diagnostic text, and stdio servers requiring first-run interactive OAuth opened browser tabs behind Obsidian with no user notice. Both are pre-existing issues, but preset-packs makes them visible to more users, so they are in-scope before shipping.

### Changes Required

- **`src\mcp\McpToolBridge.ts`** — Change tool-execution error path from `throw` to `return `Error: <details>`. Matches industry pattern (Model Context Protocol spec 2025-06-18 error handling; bastani/atomic, kimchi, inkeep MCP adapters). Guarantees the error text is rendered in chat (tool return values always render) and lets the LLM read the diagnostic. Hard invocation failures (server disabled, cancelled, timed out) remain thrown. Empty-content isError responses get a descriptive fallback (`no error details returned by the server`).
- **`src\mcp\McpToolBridge.test.ts`** — Existing `isError and JSON-RPC error surface distinctly` test updated to expect `resolves` (returned content) not `rejects`. New test for empty-content isError fallback.
- **`src\settings\McpServersSection.ts`** — On user-triggered enable of an stdio server (server add/save with `enabled: true`, or manual Enable toggle), fire a Notice: `Starting MCP server `X''. If this is a first-time launch, a browser tab may open for authentication — please check for a tab behind Obsidian.'' Tracked via `stdioStartupNoticeShown: Set<string>` field so repeated toggles do not re-notify.
- **`src\settings\McpServersSection.test.ts`** — Two new tests: stdio startup notice fires once (not on re-enable), and does not fire for HTTP servers.
- **`proposals\0008-mcp-server-stderr-log-file.md`** (new) — Follow-up proposal for persistent per-server stderr log files with rotation. Deferred from Phase 8 to keep scope tight; in-memory 64KB stderr tail already surfaces in connection-failure Notices via `McpServerRuntime.setError` (line 481).

### Test Impact

Baseline: 1495 tests. New tests: +3 (McpToolBridge empty-content, stdio startup notice fires-once, stdio startup notice HTTP-negative). New total: 1498, all passing. Build passes, typecheck passes.

### Deferred / Out of Scope

- Persistent stderr log files with rotation → proposal 0008.
- Structured tool-error rendering in chat UI (e.g. red-tinted tool output for isError content) → future UI polish.
- Pattern-matched detection of stderr auth prompts and richer surfacing → too brittle across MCP servers; startup notice + in-memory stderr in error notices covers 90% of value.


## Phase 8b: Composer auto-focus after conversation switch (smoke-test follow-up)

**Origin:** Smoke testing on Phase 8 build. After importing a new pack MCP (agency-calendar), user was prompted to start a new conversation to see the tools; on switching, the composer textarea was un-selectable — a click on the Send button restored focus, at which point typing worked. Symptom of a focus race after the manager subscription re-rendered the conversation state without restoring focus to the input element.

### Changes Required

- **`src\ui\ChatView.ts`** — In the manager subscription handler, when the bound conversation id changes (i.e. we just switched active conversation or created a new one), queue a `queueMicrotask` focus of the composer textarea, guarded on `!this.inputEl.disabled` so we do not steal focus from a legitimately-gated control (auth non-connected, busy setBusy).

### Test Impact

No new tests added (headless environment cannot reliably assert DOM focus timing). Manual validation via smoke test.

### Retro Note

Phase 9 (MCP readiness gate) later revealed that some of the "un-selectable input" reports were actually the SDK session waiting on a tool snapshot it could not yet complete. Phase 8b remains as defense-in-depth against pure DOM focus races after a manager re-render, but the primary UX regression is fixed by Phase 9.


## Phase 8c: MCP error reclassification for tool-call chip status

**Origin:** Phase 8's return-as-content pattern surfaced error text in chat body successfully, but the tool-call chip status pill rendered green "completed" for calls that had actually failed. The SDK sees a successful string return value and marks the call `success: true`; the chip renderer reads that flag verbatim.

### Changes Required

- **`src\sdk\AgentSession.ts`** — In the `tool.execution_complete` event handler, after the initial success/cancelled/errored triage, detect the McpToolBridge sentinel prefixes (`Error: MCP tool reported error:` / `Error: MCP JSON-RPC error:`) on MCP-source calls that came in as "completed". Reclassify: outcome → errored, resultContent → errorMessage, resultContent cleared. Chip pill turns red, body renders the "Error" section.
- **`src\sdk\AgentSession.test.ts`** — Two new tests: reclassification path fires for MCP source, and does NOT fire for custom-source tools that legitimately return text starting with `Error:`.
- **`src\settings\McpServersSection.ts`** — Small follow-up on Phase 8 startup notice: promote to sticky `new Notice(msg, 0)` so users can read the two-sentence diagnostic in production; test-injected notify path unchanged.

### Test Impact

Baseline: 1498. New tests: +2. New total: 1500, all passing.


## Phase 9: MCP readiness gate before SDK session creation

**Origin:** Reload-with-existing-conversation smoke test. After Obsidian reload, existing conversations could not call any MCP tool until the user created a new conversation. Root cause discovered via reader review of `AgentSession.toolsForSession()`: the Copilot SDK freezes `tools[]` at `createSession()` time and provides no `updateTools()` API (verified in `node_modules\@github\copilot-sdk\dist\session.d.ts`). On plugin reload, `init()` fires lazily on first user message; if enabled stdio MCP servers are still spawning their child processes, their tools are missing from the snapshot and stay missing for the life of that session.

### Changes Required

- **`src\mcp\McpManager.ts`** — Add `waitUntilEnabledReady(timeoutMs)` method. Subscribes to the existing status-change stream via `subscribe()`. Treats `connected` / `error` / `crashloop` / `disabled` as terminal; `connecting` / `reconnecting` block resolution. Servers whose runtime does not yet exist (getOrCreate not yet fired) also count as non-terminal so early init does not race the lifecycle enable() call. Never rejects — on timeout, resolves anyway.
- **`src\sdk\AgentSession.ts`** — Add optional `mcpReadinessGate?: () => Promise<void>` option and private `awaitMcpReadinessGate()` helper (swallows throws). Called at all three `createSession()` sites: normal `init()` path, `resetConversation()`, and deferred-catalog recovery.
- **`src\main.ts`** — Wire `mcpReadinessGate: () => mcpManager.waitUntilEnabledReady(15_000)` into the AgentSession construction inside `runtimeFactory`. 15s ceiling generous for stdio auth flows but bounded.
- **`src\mcp\McpManager.test.ts`** — 4 new tests: empty-servers immediate resolve, servers becoming ready mid-wait resolves the gate, hanging servers time out gracefully, HTTP servers in `error` state count as terminal.
- **`src\sdk\AgentSession.test.ts`** — 2 new tests: gate awaited before createSession, gate that throws does not wedge init.

### Test Impact

Baseline: 1500. New tests: +6. New total: 1506, all passing.

### Deferred / Out of Scope

- SDK-level `updateTools()` support to remove the need for the gate entirely — depends on upstream SDK.
- Session-level warning banner when a specific enabled MCP server errored out during startup, telling the user which tools are unavailable in that session — future UI polish.

