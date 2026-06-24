# v0.8 Importable Preset Packs Technical Reference

## Overview

v0.8 adds **importable preset packs**: JSON files that bundle one or
more MCP server presets and plug into the existing **Add Server →
Preset** dropdown. Packs are inert data; importing a pack never spawns
a process, opens a network connection, or auto-enables a server. The
release also adds a complementary **export** flow that templatizes
secrets and writes a pack file into the vault.

The feature is additive over v0.7: existing built-in presets (the
Microsoft 365 Graph preset) continue to use the same `build()` +
form-level preflight-hint path, unchanged. Imported packs render
alongside built-ins under a per-pack group in the dropdown.

## Architecture and Design

### High-Level Architecture

The pack feature is layered top-down as:

1. **Pure pack types and validation** (`src/settings/presets/`)
   - `packTypes.ts` — `Pack`, `PackPreset`, `ImportedPackRecord`,
     `PackValidationError`, `PackParseError`.
   - `packParser.ts` — strict JSON parse with size guard (1 MB hard
     reject, 100 KB notice), BOM rejection, JSONC rejection.
   - `packValidator.ts` — single-error contract: returns the first
     violation as `{ pointer, message }` (RFC-6901 path).
   - `packCanonical.ts` + `packDiff.ts` — canonical form for
     comparison (lexicographic key order, whitespace collapsed,
     persistence metadata excluded) and structural diff.
   - `packSecretPolicy.ts` — `SECRET_PLACEHOLDER = "__NEEDS_VALUE__"`
     and the per-credential-kind classification table.
   - `packExporter.ts` — `exportServersAsPack(servers, meta) → Pack`
     that templatizes secrets and dedupes preset ids slugged from
     server names.
   - `effectiveRegistry.ts` — combines the built-in pack with
     imported packs into `EffectivePreset[]` applying FR-013
     namespacing rules.
   - `BuiltInPacks.ts` — wraps the in-code built-in presets as a
     synthetic `Pack` with reserved id `builtin`.

2. **Persistence layer** (`src/settings/PresetPacksStore.ts`)
   - New top-level settings key `mcpPresetPacks`. Sibling-key
     preservation: untouched on read/write so other plugin settings
     (chat history, MCP servers, auth state) are not perturbed.
   - `snapshot()`, `addOrReplace(pack, sourcePath)`, `remove(packId)`,
     `subscribe(fn)`.

3. **File I/O layer** (`src/settings/presets/packFileIO.ts`)
   - `PackFileReader` interface; production `createDesktopPackFileReader()`
     uses a transient off-DOM `<input type=file>` and Electron's
     `file.path` for `sourcePath`. Size cap enforced before read.
   - `PackFileWriter` interface; production
     `createDesktopPackFileWriter(app)` writes
     `<vaultRoot>/exported-packs/<filename>` via the vault adapter.

4. **Pure UI orchestration** (`src/settings/`)
   - `packImporter.ts` — `runPackImport(text, sourcePath, ...)` and
     `applyConfirmedImport(...)` separated so the UI can present a
     confirm/diff step.
   - `packSettingsLogic.ts` — pure formatters for the imported-packs
     list, confirm-text, and re-import diff text.
   - `presetDropdownLogic.ts` — `buildPresetDropdownModel(registry)`
     and `applyEffectivePresetToForm(eff, baseForm) →
     { form, requiredSecretFields }`. Pure; no DOM, no preflight, no
     fs probes.
   - `packExportFlow.ts` — `buildExportFlowModel`, `toggleSelection`,
     `runExport`, `suggestedFilename`. Pure orchestration for the
     export dialog.

5. **DOM wiring** (`src/settings/McpServersSection.ts`,
   `src/settings/SettingsTab.ts`)
   - Imported packs subsection with import / remove / re-import
     diff confirmation.
   - Add Server preset dropdown built from the effective registry,
     with the built-in branch invoking `preset.build()` + preflight
     hint unchanged and the pack-preset branch using
     `applyEffectivePresetToForm` and rendering the required-fields
     hint.
   - Export servers as pack dialog.
   - `SettingsTab` wires `createDesktopPackFileReader()` and
     `createDesktopPackFileWriter(this.app)`.

### Design Decisions

- **In-code built-in presets continue to be the source of truth.**
  `BuiltInPacks.ts` wraps the existing built-in `McpServerPresets`
  into a synthetic `Pack` with a reserved id (`builtin`) and a pinned
  version (`"1"`, divorced from `manifest.json`). The dropdown
  Always-First contract for built-ins is enforced both by the
  registry (built-in first then imports ordered by `importedAt` asc)
  and the dropdown model builder.
- **Single-error validator contract.** `packValidator` returns the
  FIRST violation so the user sees one actionable message naming the
  offending JSON pointer. Multi-error accumulation is deferred —
  inconsistent with the existing form-validator UX.
- **Strict JSON only.** JSONC is rejected at parse time. The
  proposal called this out as a hard requirement to keep the parser
  surface minimal and to avoid users inadvertently shipping comments
  containing secrets.
- **Secrets default to templatized; new fields default to secret.**
  Each credential kind has an explicit allow-list of STRUCTURAL
  fields in `packSecretPolicy.ts`; everything else is templatized
  with `SECRET_PLACEHOLDER`. Future credential kinds that lack an
  entry get every field templatized by defensive default — a
  templatized non-secret is annoying but reversible; a leaked secret
  is not.
- **Command-based `command`/`args` are STRUCTURAL.** Revised FR-020:
  command and args mirror the M365 built-in's reality, where the CLI
  binary name (e.g. `az`) is public and the secret resolution happens
  inside the CLI's process. Authors who put literal secrets in args
  are responsible for redaction; the system does not content-scan.
- **Effective registry namespacing (FR-013) is applied at read
  time, not at import time.** Packs are stored verbatim; namespacing
  is computed on every `buildEffectiveRegistry` call. This keeps
  pack content reversible — removing a colliding pack restores the
  bare-id form for the surviving pack automatically. Concrete rules:
  (a) when an imported pack's preset id collides with a built-in
  preset id, the imported preset is namespaced as
  `<packId>.<presetId>` and the built-in keeps the bare id;
  (b) when two imported packs share the same preset id, BOTH are
  namespaced; (c) duplicate preset ids within a single pack are
  rejected by the validator (single-error contract); (d) display
  labels of namespaced presets are suffixed with " (from
  <packLabel>)" so the dropdown disambiguates visually.
- **PackFileWriter abstraction over native save dialog.** The
  Electron `dialog.showSaveDialog` path requires running inside
  Obsidian and is unverifiable from automated tooling. v0.8 ships a
  vault-adapter writer that targets `<vault>/exported-packs/` so the
  feature is testable and works on every supported platform; a
  future iteration can swap in a native dialog without changing the
  `PackFileWriter` interface. See
  [`WorkflowContext.md`](./WorkflowContext.md) "Phase 4B
  Save-Dialog Spike" for the rationale.
- **`requiredSecretFields` is a closure-local per form.** Storing it
  on the section instance would leak across edit sessions; the
  property lives in `openForm`'s closure and is captured by both the
  preset-change handler (writes) and the Save handler (reads).
- **No new dependencies.** Pack validation is hand-written;
  canonicalization is a JSON.stringify with sorted keys. The proposal
  rejected adding a JSON-schema library to keep the trust surface
  minimal.

### Integration Points

- **Settings store**: `PresetPacksStore` shares the `data.json` blob
  with `McpSettingsStore`, `SafetySettingsStore`, and other stores.
  Sibling-key preservation is mandatory (verified by store tests).
- **MCP server form**: `McpServerFormInput.requiredSecretFields`
  (added in Phase 4) is the integration boundary. The pure validator
  in `mcpServerFormLogic.ts` enforces non-emptiness for every field
  listed in `requiredSecretFields`. The DOM layer surfaces the list
  visually via the form hint and `aria-required` attributes.
- **MCP server form (command-based args)**: Phase 4 also added
  `McpServerFormInput.credentialArgs?: string[]` so command-based
  args round-trip cleanly from pack-driven pre-fill through validator
  through final `McpServerConfig.credentials.args`. Existing servers
  with command-based args are seeded from `existingHttpCreds.args` on
  edit-form open to preserve them across saves.
- **Plugin onload**: `PresetPacksStore` is loaded as part of the
  plugin's onload sequence (parallel with `McpSettingsStore`), and
  its subscription is wired into `McpServersSection` so dropdown and
  packs-list re-render on add/remove.

## User Guide

See [`docs/preset-packs.md`](../../../docs/preset-packs.md) for the
end-user walkthrough. v0.8's `README.md` "What's new" section links
to it.

## Reserved and intentionally-not-documented

- **URL-based pack import**. Deferred — the proposal's open question
  on the checksum trust model is unresolved. Out of scope for v0.8.
- **Pack-authoring UI**. v1 assumes authors hand-edit JSON or use
  the export feature. No in-app authoring surface is planned.
- **Central pack marketplace / discovery**. Not in v0.8. Distribution
  is out-of-band (private repos, GitHub releases, internal storage,
  etc.).
- **Internal pack content in this repo**. Per the privacy NFR, real
  pack content for internal organizations lives ONLY in a private
  companion repo. The public
  repo's tests, fixtures, and sample packs use generic placeholders
  (`internal-mcp-cli`, `example.org`).
- **Automated CI grep for internal-identifier leaks**. The proposal
  rejected this: the pattern list itself would constitute a leak.
  Leak prevention is enforced by code review and developer
  discipline.
- **Semantic re-import diff**. v1 ships structural diff (preset-id
  add/remove/change). A semantic diff ("label changed, command
  unchanged" highlighted separately) is deferred to v2.
- **Internal-pack smoke evidence**. Lives ONLY in the private repo's
  README per SC-005. The public `SmokeChecklist.md` may include at
  most a one-line pointer.

## File map

| Layer | Files |
| --- | --- |
| Types & pure validation | `src/settings/presets/packTypes.ts`, `packParser.ts`, `packValidator.ts`, `packCanonical.ts`, `packDiff.ts`, `packSecretPolicy.ts` |
| Built-in pack wrapper | `src/settings/presets/BuiltInPacks.ts` |
| Effective registry | `src/settings/presets/effectiveRegistry.ts` |
| Export | `src/settings/presets/packExporter.ts`, `src/settings/packExportFlow.ts` |
| Import | `src/settings/presets/packImporter.ts` |
| File I/O | `src/settings/presets/packFileIO.ts` |
| Persistence | `src/settings/PresetPacksStore.ts` |
| UI logic (pure) | `src/settings/packSettingsLogic.ts`, `src/settings/presetDropdownLogic.ts`, `src/settings/packExportFlow.ts` |
| DOM wiring | `src/settings/McpServersSection.ts`, `src/settings/SettingsTab.ts` |
| Form validation extension | `src/settings/mcpServerFormLogic.ts` (`requiredSecretFields`, `credentialArgs`) |

## Test coverage

All new modules ship with pure-node Vitest suites; DOM-level coverage
uses the project's `FakeElement` harness (no jsdom). The Phase 4 PR
ends at **1464 tests passing**.

Notable suites added by this work:

- `packParser.test.ts`, `packValidator.test.ts`,
  `packCanonical.test.ts`, `packDiff.test.ts`, `packSecretPolicy.test.ts`,
  `packExporter.test.ts`, `effectiveRegistry.test.ts`,
  `BuiltInPacks.test.ts` — Phase 1.
- `PresetPacksStore.test.ts` — Phase 2 (incl. sibling-key
  preservation invariant).
- `packImporter.test.ts`, `packFileIO.test.ts`,
  `packSettingsLogic.test.ts`, `McpServersSection.packs.test.ts` —
  Phase 3.
- `presetDropdownLogic.test.ts` (incl. command-based args + stdio
  env/cwd flow), `packExportFlow.test.ts` (incl. SC-002 1/5/20
  round-trip + SC-009 secret-vs-none), `mcpServerFormLogic.test.ts`
  extensions (`requiredSecretFields`, `credentialArgs`),
  `McpServersSection.packDropdown.test.ts` (incl. SC-006
  `executableExists` never invoked + requiredSecretFields no-leak
  regression), `McpServersSection.packExport.test.ts` — Phase 4.

Manual verification lives in
[`SmokeChecklist.md`](./SmokeChecklist.md) (public repo) and the
private companion repo's README for SC-005.
