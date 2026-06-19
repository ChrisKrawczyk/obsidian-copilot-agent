# Implementation Plan: Packaging and Release (v0.6.0)

**Branch**: `feature/packaging-release`
**Spec**: `.paw/work/packaging-release/Spec.md`
**Research**: `.paw/work/packaging-release/CodeResearch.md`
**Proposal**: `proposals/0002-packaging-release.md`

---

## Synthesis Notes

This plan synthesizes three model drafts (`planning/PLAN-claude-opus-4.7.md`, `planning/PLAN-gpt-5.4.md`, `planning/PLAN-gemini-3.1-pro-preview.md`).

All three converged on a 6-phase decomposition matching the five surfaces in the spec plus a closing documentation phase. They split on phase ordering: GPT-5.4 placed the runtime fetcher first; Opus and Gemini placed tooling first. This synthesis adopts **tooling-first ordering** (Opus's argument): version-bump and CHANGELOG plumbing are prerequisites for tagging anything, and the fetcher's value is realized only at the BRAT bootstrap phase, so its placement before vs after the GitHub Actions workflow is cosmetic. Tooling-first keeps phase boundaries dependency-respecting.

This synthesis adopts the following from GPT-5.4 over Opus's original:

- **Pure release logic lives under `src/release/`** (TypeScript modules), not `scripts/lib/*.mjs`. Rationale: vitest already covers `src/**`, the existing test infrastructure types pure modules naturally, and orchestration scripts in `scripts/` shell out to the typed logic. (Opus had `scripts/lib/versionBumpLib.mjs` + `.test.mjs`; GPT had `src/release/versioning.ts` + `.test.ts`. GPT's structure wins for testability.)
- **Explicit `scripts/release/status.mjs` resume-state primitive** for FR-010 re-entrancy, with corresponding `src/release/releaseStatus.ts` pure helpers. Opus distributed re-entrancy across skills; GPT factored it. Factoring makes recovery procedures concrete.
- **`scripts/release/bootstrap-v0.5.0.mjs` as a scripted helper**, not a one-time manual procedure. Reasons: reproducible, auditable, and integrates with the same asset-assembly + release-notes-extraction helpers that Phase 3's CI workflow uses (single source of truth for the "what makes a release" contract).
- **Asset assembly factored into `scripts/release/assemble-assets.mjs`** so the CI workflow and the v0.5.0 bootstrap helper share one definition of "exactly these three files at the release root". Same factoring principle.

The agent + skill layout uses `.copilot/agents/release/` (Opus's path) — closer to the existing `.copilot/installed-plugins/` convention this maintainer's environment already uses than GPT's flatter `.copilot/`. Skill files are markdown, agent definition is markdown.

Phase 2's `src/main.ts` integration uses Opus's narrower approach (`ensureCliBinaryReady()` async insertion ahead of existing resolver) rather than GPT's deeper "split into plugin shell + runtime-ready layers" refactor. Rationale: bigger refactor has larger blast radius; the narrower change preserves the existing `onload()` strict ordering documented in `CodeResearch.md:66-79` and still satisfies SC-002/SC-003 (BRAT install works on first launch). The "Settings reachable while binary is absent" UX improvement is captured as a phase candidate, not a blocker.

---

## Overview

This plan delivers the end-to-end packaging and release pipeline for `obsidian-copilot-agent` v0.6.0 along the path described in `Spec.md`: a developer types "release v0.6.0" into a Copilot CLI release agent, and a non-developer Obsidian user on Windows, macOS, or Linux can subsequently install the plugin via BRAT and reach a working chat without any terminal commands.

The work spans five distinct surfaces — version-bump tooling, a runtime binary fetcher, a tag-triggered GitHub Actions workflow, a Copilot CLI release agent with skills, and BRAT compatibility / retroactive v0.5.0 bootstrap — plus a closing documentation phase. Phase ordering is driven by two hard prerequisites: **tooling must exist before any tag is cut** (so version-bump and CHANGELOG plumbing come first), and **the runtime binary fetcher must ship in the plugin code before a fresh BRAT install can succeed** (so the fetcher precedes the first real release). CI workflow follows next so tags publish automatically. The release agent orchestrates the stable underlying steps and therefore lands after them. The BRAT bootstrap phase then exercises the whole pipeline end-to-end (retroactively publish v0.5.0, then cut v0.6.0). Documentation closes the loop.

Throughout, the existing developer workflow (`npm run dev`, `npm run deploy`, `npm test`, `npm run build`) must remain unchanged, the 968-test baseline must hold, and `src/main.ts:onload()` startup ordering is preserved — the fetcher inserts a new awaitable step ahead of CLI binary resolution but does not reshape downstream wiring.

## Current State Analysis

Per `CodeResearch.md`, at base commit `4b5e07ebd87b96cc7fa10bf2f47c3a42c7beb55b`:

- **Version metadata is misaligned and unmaintained**: `package.json:3` and `manifest.json:4` both read `0.1.0`, while `CHANGELOG.md` carries an unreleased v0.5.0 entry from the MCP work merged into `main`. No `versions.json` exists at the repo root. `manifest.json` is missing `authorUrl` (and optional `fundingUrl`) and its `name` still reads `"Copilot Agent (Spike)"`.
- **No release plumbing**: `package.json:8-15` defines `build`, `dev`, `typecheck`, `test`, `deploy`, `deploy:no-build` only — no `release`, `version`, or `version-bump` script. `scripts/` contains only `deploy.mjs`.
- **No CI**: `.github/workflows/` does not exist; `.github/` holds `copilot-instructions.md` only.
- **CLI binary resolution is synchronous and fail-fast**: `src/sdk/resolveCliBinaryPath.ts:17-46` joins `<plugin-dir>/copilot{.exe}`, checks `fs.existsSync`, and throws a copy-from-`node_modules` instruction when missing. `src/main.ts:102-119` catches the throw, shows a 12-second `Notice`, and `return`s from `onload()`, blocking construction of stores, MCP, auth, settings, and chat view.
- **No in-plugin binary acquisition path**: there is no fetcher, no platform/libc detection at runtime, and no Settings UI affordance to retry binary download. The static `Copilot CLI binary` row in `src/settings/SettingsTab.ts:194-200` only documents manual placement.
- **No release agent or skills**: nothing exists in-repo that mirrors the PAW agent/skill pattern for release orchestration.
- **`@github/copilot@1.0.59` ships per-platform binaries via `optionalDependencies`** (`package-lock.json:687-849`) — eight platform tuples (`{darwin,linux,linuxmusl,win32}-{x64,arm64}`), each with a `copilot` (or `copilot.exe`) bin. This is the upstream distribution shape the runtime fetcher consumes.
- **Existing UI patterns to reuse**: `McpServersSection` (`src/settings/McpServersSection.ts:96-148`) for per-row error display + Reconnect button; `ChatView` inline error banner (`src/ui/ChatView.ts:359-380`) for retry affordance; `redactSensitive` (`src/mcp/redactSensitive.ts`) for surfacing error text safely; `Notice` with explicit timeouts (8000–12000 ms) for transient errors; pure-function logic modules tested in node (`src/ui/modelPickerLogic.ts:1-12`).
- **Tests**: 60 files, 968 passing, Vitest node env with Obsidian alias to `src/test/obsidianMock.ts` (`vitest.config.ts:4-18`).

## Desired End State

When this work merges:

- Running `npm run release -- 0.6.0` (or, equivalently, asking the release agent for "release v0.6.0") updates `package.json`, `manifest.json`, `versions.json`, and `CHANGELOG.md` atomically, commits, tags, and pushes; the GitHub Actions release workflow then runs typecheck + tests + production build and publishes a GitHub Release with exactly `main.js`, `manifest.json`, `styles.css` at the release root, body taken from the CHANGELOG entry.
- A first-time Obsidian user on Windows/macOS/Linux can `BRAT → Add Beta Plugin → ChrisKrawczyk/obsidian-copilot-agent`, enable the plugin, watch a Notice as the platform-correct `@github/copilot-<plat>-<arch>` tarball downloads from the npm registry into the plugin folder, verify integrity via sha512, extract the binary, and proceed to OAuth + chat — without a terminal.
- A re-run of the release agent on the same target version detects already-completed steps and is safe; preflight refuses dirty trees, failing tests, non-`main` branches, and non-monotonic version bumps.
- `RELEASING.md` documents the process; `README.md` has a clearly marked "Install via BRAT" section; `.paw/work/packaging-release/Docs.md` is the technical reference.
- GitHub Releases page lists both v0.5.0 (retroactively bootstrapped from the v0.5.0 merge commit) and v0.6.0.
- `npm run dev`, `npm run deploy`, `npm test`, `npm run build`, `npm run typecheck` continue to work exactly as before; the dev-time deploy path that copies a pre-existing `copilot.exe` is unaffected (fetcher no-ops when the pinned binary already exists).

## What We're NOT Doing

The following items are explicitly **out of scope** for this work (verbatim from `Spec.md` Scope and `WorkflowContext.md`):

- Submission to the official Obsidian Community Plugins catalog (Phase C, future workflow).
- Mobile Obsidian support (plugin stays `isDesktopOnly: true`).
- Code signing of the plugin bundle or the downloaded native binary.
- Auto-update mechanics beyond what BRAT provides.
- Telemetry, install analytics, or release usage tracking.
- Runtime override of the pinned binary version (users cannot point at a different `@github/copilot` build).
- `data.json` migration infrastructure (no shape change in this release).
- Backfilling CHANGELOG entries for pre-v0.5 history.
- A web-hosted release notes page outside GitHub Releases.
- Proxy support or bundled-binary fallback for npm-registry-blocked corporate networks (documented as a known limitation in README).
- Multi-binary management UI (the fetcher may stage binaries internally, but no version-management UI is exposed).
- CI-driven cross-platform smoke tests (tracked as a follow-up; this release relies on manual smoke tests).
- Replacing or overhauling the existing `scripts/deploy.mjs` developer workflow.

## Phase Status

- [ ] Phase 1: Version-bump tooling, CHANGELOG/versions.json plumbing, and manifest hygiene
- [ ] Phase 2: First-launch in-plugin binary fetcher + Settings UI integration
- [ ] Phase 3: GitHub Actions release workflow
- [ ] Phase 4: Copilot CLI release agent and skills
- [ ] Phase 5: BRAT bootstrap — retroactive v0.5.0 release, README install docs, smoke test, cut v0.6.0
- [ ] Phase 6: Documentation — RELEASING.md, Docs.md, README finalization

### Phase Ordering Rationale

The five surfaces called out in the workflow context map to Phases 1–5; Phase 6 is the mandatory documentation closing phase.

1. **Phase 1 (tooling) before everything else**: version-bump, `versions.json`, CHANGELOG plumbing, and manifest hygiene are prerequisites for tagging anything at all. Manifest hygiene is grouped here (not with BRAT docs) because the version-bump script must write into the hygiene-compliant manifest from the start.
2. **Phase 2 (fetcher) before Phase 5 (real BRAT install)**: a fresh BRAT install with no fetcher would fail on every non-developer machine, so the runtime code change must ship before any release is published as "BRAT-ready". Phase 2 is sequenced ahead of Phase 3 because Phase 3 doesn't depend on it, but Phase 5 does — keeping fetcher work close to its primary consumer reduces the chance of merging a release-publishing workflow before the runtime supports it.
3. **Phase 3 (CI) after Phase 1**: needs the version-bump tooling and `versions.json` shape to test against. Could be parallelized with Phase 2 in practice but is sequenced after to keep phase boundaries clean.
4. **Phase 4 (release agent) after Phases 1–3**: the agent is a thin orchestration layer over stable underlying steps. Building the agent first risks rewrites as the lower layers evolve.
5. **Phase 5 (BRAT bootstrap + cut releases) after Phases 1–4**: this is the integration phase that exercises every prior phase by retroactively publishing v0.5.0 (assets only, no fetcher) and then cutting v0.6.0 (the first BRAT-real release).
6. **Phase 6 (docs)**: written last so docs reflect what actually shipped.

## Phase Candidates

<!-- Use checkbox format for each candidate so transition checks can detect unresolved items. -->

- [ ] **Settings UI reachable when binary missing**: refactor `src/main.ts:onload()` to construct stores, settings tab, and chat view even when the CLI binary is absent (deeper than the Phase 2 narrow async-insert), so users can reach Settings → CliBinarySection → Retry without needing to wait through the binary-error Notice. Currently Phase 2 surfaces the error via Notice with a prompt to open Settings; the Settings tab IS reachable today (Obsidian core) but the binary-failure path returns early and prevents the section from being rendered. Promoting this would split startup into a "plugin shell" layer (always init: stores, safety, settings, chat) and a "runtime-ready" layer (init when binary ready: model catalog, MCP runtime, runtime factory). Bigger blast radius; deferred.
- [ ] **CI-driven cross-platform smoke matrix**: GitHub Actions matrix job that, on a release tag, runs the binary fetcher's platform detection unit tests on `windows-latest`, `macos-latest`, `macos-14` (arm64), `ubuntu-latest` to give us cross-platform CI signal beyond Linux. Deferred — explicit out-of-scope per Spec.md.
- [ ] **Auto-detect CHANGELOG body from PR description**: the changelog-draft skill could ingest the merged PR description (via `gh pr view`) for richer context than `git log --no-merges`. Deferred — current `git log` content is sufficient.
- [ ] **Workflow status badge in README**: a GitHub Actions status badge for the release workflow on the README. Trivial follow-up.

---

## Phase 1: Version-bump tooling, CHANGELOG/versions.json plumbing, and manifest hygiene

### Changes Required

**New module: `src/release/versioning.ts`** (pure logic, TypeScript)

Pure helpers consumed by both the version-bump script and the release-status primitive:

- `parseSemver(v: string): SemverParts` — rejects empty, non-numeric, leading-`v`, malformed pre-release.
- `compareSemver(a, b): -1 | 0 | 1` — strict semver comparison including pre-release ordering.
- `assertMonotonic(currentVersion, targetVersion): void` — throws on equal or lesser.
- `mergeVersionsMap(existing, version, minAppVersion): VersionsMap` — adds entry, preserves existing, locks key order (newest last; decision encoded once).

**New module: `src/release/changelog.ts`** (pure logic, TypeScript)

- `findSection(content: string, version: string): { startLine, endLine } | null` — locates a `## [X.Y.Z]` heading and its body extent up to the next `## [` or EOF.
- `extractSection(content: string, version: string): string | null` — returns body verbatim, preserving formatting.
- `insertStubSection(content: string, version: string, date: string): string` — inserts a stub `## [X.Y.Z] - YYYY-MM-DD\n\n### Added\n\n` block above the previous most-recent entry. Idempotent: if a non-stub section already exists for that version, returns content unchanged with a flag.
- `normalizeUnreleasedHeading(content: string, version: string, date: string): string` — converts `## [Unreleased]` (or the existing v0.5.0 unreleased heading) into a dated entry.

**New module: `src/release/versionsJson.ts`** (pure logic, TypeScript)

Read/write helpers for the `versions.json` map shape (`{ "X.Y.Z": "minAppVersion" }`) preserving 2-space indentation.

**New: top-level `versions.json`**

Created in this phase with the existing v0.5.0 entry pinned to the current `minAppVersion` (`1.5.0`):

```json
{
  "0.5.0": "1.5.0",
  "0.6.0": "1.5.0"
}
```

The v0.6.0 entry is added by the version-bump script when invoked for v0.6.0; the v0.5.0 entry is hand-written in this phase because no prior `versions.json` exists.

**New: `scripts/version-bump.mjs`**

A Node ES module orchestration script following the conventions in `scripts/deploy.mjs:28-43` (ESM, `import.meta.url`-derived `repoRoot`, exit code 2 for configuration failures, clear console output). Imports the pure helpers from `src/release/` via the build output or via direct `tsx`/`node --import` of TypeScript at runtime — decision: orchestration scripts use the source `.ts` modules through a small loader pattern shared with the existing test infrastructure, OR transpile via the build before invocation. Concrete decision encoded in this phase's first commit: use `tsx` as a dev-only loader (`npx tsx scripts/version-bump.mjs`) — already implicitly present via vitest's TypeScript pipeline, no new top-level dep. Wrap the CLI as a `.mjs` thin shell that calls into the typed module.

The script:

- Accepts a single semver argument (`0.6.0`, no `v` prefix).
- Optional `--check <version>` mode: validation only, no mutation, exits 0/non-zero.
- Validates input via `parseSemver` and `assertMonotonic` against current `package.json` version.
- Reads current `manifest.json`'s `minAppVersion` for the new versions.json entry.
- Writes the new version into `package.json`, `manifest.json`, and `versions.json`.
- Inserts a stub CHANGELOG section if missing (via `insertStubSection`); preserves existing entries verbatim.
- All file writes are buffered in memory and committed only after every validation passes (atomic-or-nothing semantics per FR-001).

**New: `scripts/release/status.mjs`** + **`src/release/releaseStatus.ts`** (resume-state primitive, FR-010)

Reports the release pipeline's progress for a given target version, used by the release agent's preflight and resume logic:

- `step: "not-started" | "files-prepared" | "commit-created" | "tag-created" | "tag-pushed" | "workflow-running" | "workflow-complete" | "release-published"`.
- Inspects: working tree cleanliness, current branch, presence of bump commit (`chore(release): vX.Y.Z`), local tag, remote tag, workflow run status (`gh run list`), release existence (`gh release view`).
- Emits a single JSON line for agent consumption: `{ "version": "0.6.0", "step": "tag-pushed", "next_action": "wait-for-workflow", "blockers": [] }`.

Pure step-derivation logic lives in `src/release/releaseStatus.ts` (no `gh`/`git` calls — those are passed in as injected probes). The orchestration `scripts/release/status.mjs` runs the probes and feeds the pure logic.

**Edit: `manifest.json`** (per FR-015)

- `name`: `"Copilot Agent (Spike)"` → `"Copilot Agent"`.
- `description`: replace spike-language with a user-facing description (e.g. "GitHub Copilot agent for Obsidian, with vault tools, MCP, and OAuth.").
- Add `authorUrl`: `"https://github.com/ChrisKrawczyk"`.
- `id` stays `obsidian-copilot-agent`; `isDesktopOnly` stays `true`; `minAppVersion` stays `1.5.0`.
- `fundingUrl` is intentionally omitted (FR-015 marks it optional and no funding is being solicited).
- `version` is **not** changed in this phase (kept at `0.1.0`); Phase 5 uses the version-bump script to move it to `0.6.0` for the real release.

**Edit: `CHANGELOG.md`**

- Update the existing v0.5.0 entry: change `## [0.5.0] – Unreleased` to `## [0.5.0] - <date of PR #5 merge into main>`. Pull the actual merge date from `git log` for commit `22f660d`.

**Edit: `package.json`** (scripts section only)

Add scripts:

- `"version-bump": "tsx scripts/version-bump.mjs"` — direct invocation for the agent / manual fallback.
- `"release:prepare": "tsx scripts/version-bump.mjs"` — alias matching FR-004's "manual command-line entry point" (named `release:prepare` to disambiguate from the workflow tag-and-push step).
- `"release:status": "tsx scripts/release/status.mjs"` — agent / manual status probe.

`tsx` is added as a `devDependency` if not already transitively present (verify; vitest's pipeline may resolve it through another dep). `version`, runtime `dependencies`, `engines` are not touched.

**New tests:**

- `src/release/versioning.test.ts` — semver parse/validate/compare/monotonicity (covers FR-007).
- `src/release/changelog.test.ts` — section find/extract/insert/normalize, idempotency.
- `src/release/versionsJson.test.ts` — map merge, key order, formatting preservation.
- `src/release/releaseStatus.test.ts` — step derivation from probe inputs (file-system and gh probes mocked at the boundary).

### Success Criteria

**Automated:**

- `npm test` reports baseline + new tests passing; no existing test regresses.
- `npm run typecheck` passes (no type errors introduced).
- `npm run release:prepare 0.6.0` on a clean tree mutates the four files coherently; re-running it is detected and short-circuits with a clear message.
- `npm run release:prepare 0.0.1` exits non-zero with a "not strictly greater" error.
- `npm run release:prepare not-a-version` exits non-zero with a parse error.
- `npm run version-bump -- --check 0.6.0` exits 0; `--check 0.0.1` exits non-zero.
- `npm run release:status -- --version 0.6.0 --json` returns `{ "step": "not-started" }` on a clean tree without prior release artifacts.

**Manual:**

- Read `manifest.json`: `name` no longer contains "Spike", `authorUrl` present.
- Read `CHANGELOG.md`: v0.5.0 entry has a real date matching the PR #5 merge commit.
- `npm run dev` and `npm run deploy` still work end-to-end (the manifest/changelog edits do not affect runtime; deploy copies the new `manifest.json` into the vault and Obsidian reloads cleanly).

---

## Phase 2: First-launch in-plugin binary fetcher + Settings UI integration

### Changes Required

This phase introduces the runtime ability to acquire the Copilot CLI binary on demand from the npm registry, integrates it into `src/main.ts:onload()` startup, and exposes a Retry affordance in Settings. The fetcher is the single largest code-change phase in this work.

**New module: `src/sdk/BinaryFetcher.ts`**

A pure-ish class encapsulating fetch lifecycle. Public surface (small, testable):

- `getRequiredBinaryPath(plugin): string` — synchronous, same path scheme as `resolveCliBinaryPath` (`<plugin-dir>/copilot{.exe}`); shared with the existing resolver.
- `isInstalled(plugin, pinnedVersion): boolean` — checks for the binary plus a sibling marker file `<plugin-dir>/.copilot-binary-version` whose contents equal `pinnedVersion`.
- `ensureInstalled(plugin, pinnedVersion, onProgress): Promise<string>` — main entry point. Returns the binary path. If `isInstalled` is true, resolves immediately. Otherwise: detect platform tuple → resolve npm tarball URL + sha512 from registry metadata → stream-download to a temp file under `<plugin-dir>/.copilot-binary-download-<rand>` → verify sha512 → extract the single `copilot{.exe}` entry from the tar.gz → atomically rename into final path → write version marker → chmod 0755 on POSIX.
- `detectPlatformTuple(): PlatformTuple` — exported pure helper covering all eight tuples (`{darwin,linux,linuxmusl,win32}-{x64,arm64}`) per FR-021. Linux libc detection uses `process.report.getReport().header.glibcVersionRuntime` (present on glibc, absent on musl) with `ldd --version` fallback (graceful: if neither works, assume glibc).
- `FetcherError` — typed error class with `kind: "unsupported-platform" | "network" | "integrity" | "extract" | "filesystem" | "registry"` so the UI can route messages without parsing strings.

The class is implemented using Node builtins only (`node:https`, `node:fs`, `node:path`, `node:os`, `node:zlib`, `node:stream`) reached via `nodeRequire()` from `src/sdk/nodeRequire.ts`, mirroring the existing pattern in `resolveCliBinaryPath.ts:17-21`. No new third-party dependency. Tar extraction uses a minimal in-place extractor restricted to a single named entry — we are not bundling `tar` or `node-tar`.

**New module: `src/sdk/pinnedBinaryVersion.ts`**

Exports `PINNED_BINARY_VERSION: string`. Generated at build time by reading `node_modules/@github/copilot/package.json`'s `version` field. Implemented as either a TypeScript module written by an esbuild plugin or a simple pre-build node script that overwrites a constant in this file before esbuild runs. The chosen mechanism is encoded in `esbuild.config.mjs`. The constant is the version the fetcher asks the npm registry for (FR-020).

**Edit: `esbuild.config.mjs`**

Add a pre-build step (executed before `ctx.rebuild()` / `ctx.watch()`) that reads `node_modules/@github/copilot/package.json` and writes the version into `src/sdk/pinnedBinaryVersion.ts`. The generated file is gitignored (`.gitignore` updated). For dev mode (`watch()`), the version is recomputed at build start; runtime upstream upgrades require a manual rebuild, which is acceptable.

**Edit: `src/sdk/resolveCliBinaryPath.ts`**

Keep the synchronous resolver as a fast-path/dev-path. Behavior is unchanged when the binary already exists. The throw-with-instructions branch is preserved as a last-resort fallback for environments where `nodeRequire` is unavailable. The fetcher invokes `getRequiredBinaryPath` via a shared helper or directly duplicates the trivial `<plugin-dir>/copilot{.exe}` join.

**Edit: `src/main.ts:onload()`** (lines 102–119)

Replace the current "resolve or Notice-and-return" pattern with:

```ts
const cliPath = await this.ensureCliBinaryReady();
if (!cliPath) return; // user-facing error already surfaced
this.cliBinaryPath = cliPath;
```

`ensureCliBinaryReady()` is a new private method on `CopilotAgentPlugin` that:

1. Computes the expected path via the shared resolver helper.
2. If `BinaryFetcher.isInstalled(this, PINNED_BINARY_VERSION)` returns true, returns the path immediately (preserving the dev-deploy fast path per FR-026).
3. Otherwise, shows a persistent `Notice` ("Downloading Copilot CLI… 0%"), constructs a `BinaryFetcher`, and awaits `ensureInstalled(..., onProgress)`; `onProgress(bytes, total)` updates the Notice text.
4. On success, dismisses the Notice and returns the path.
5. On `FetcherError`, stores the error on the plugin instance as `this.binaryFetchError`, displays a 12-second `Notice` with the error kind-specific copy + "Open Settings to retry", and returns `null`. Startup short-circuits identically to the current missing-binary path. The plugin instance retains enough state for the Settings tab to render a Retry button.

The async insertion keeps the existing strict ordering: stores, MCP, runtime factory, auth, settings, and chat view are all constructed only after binary readiness, exactly as today. The `quit` handler registration stays at the end of `onload()`.

**Edit: `src/settings/SettingsTab.ts:194-200`**

Replace the static "Copilot CLI binary" row with a new `CliBinarySection` mounted in the same location.

**New module: `src/settings/CliBinarySection.ts`**

Modeled on `src/settings/McpServersSection.ts:16-94`:

- Accepts injected `plugin`, `notify` (defaults to `Notice`), and `fetcherFactory` (defaults to `BinaryFetcher`) for testability.
- `mount(containerEl)` renders a section: heading, status line (one of: "Binary installed (version X.Y.Z)", "Binary missing — Retry", "Last download failed: <redacted reason> — Retry"), and a Retry button.
- Retry button calls `plugin.ensureCliBinaryReady()` (idempotent), updates the status line on resolution, and notifies success/failure via the redaction helper.
- On unsupported platform (FR-024), the status text names the detected tuple and the Retry button is disabled with helper text.
- Uses the same `<pre role="status">` + `redactSensitive` rendering style as `McpServersSection.ts:109-123` for error text.

**Edit: `src/main.ts`** — Settings tab construction site (lines 746–757)

Pass the new `CliBinarySection` into the settings tab construction so it can be mounted alongside MCP and safety sections.

**New tests:**

- `src/sdk/BinaryFetcher.test.ts` — unit tests for `detectPlatformTuple` covering all eight tuples plus unsupported (use `vi.stubGlobal`/`vi.spyOn` against `process.platform`, `process.arch`, and libc detection). Unit tests for path computation, version-marker check, and atomic rename behavior (using `node:fs` against a tmp directory inside the repo). Network and registry calls are exercised against an in-process HTTP fixture (no real network).
- `src/sdk/BinaryFetcher.integrity.test.ts` — verifies a deliberately-mutated tarball fails sha512 verification and leaves no binary at the final path (FR-025).
- `src/settings/CliBinarySection.test.ts` — mirrors `src/settings/McpServersSection.test.ts:8-94` patterns: fake DOM, injected `notify` array, injected `fetcherFactory` returning canned outcomes. Covers: installed state, missing → Retry → success, missing → Retry → failure with redacted error, unsupported-platform disabled Retry.
- `src/main.startup.binary.test.ts` — exercises `ensureCliBinaryReady` happy path and failure path against a fake `BinaryFetcher` injected through a plugin seam; verifies `onload` early-return on failure does not construct downstream stores.

**Pure helpers extracted (per the repo's node-test invariant from `.github/copilot-instructions.md:39-45`):**

- Platform detection logic, sha512 verification, tar entry extraction, and Settings status-line copy live in pure modules and are tested without DOM/Obsidian. The `CliBinarySection` orchestration class is tested with the existing fake-DOM pattern.

### Success Criteria

**Automated:**

- `npm test` passes including all new tests; baseline 968 + new tests all green.
- `npm run typecheck` clean.
- `npm run build` produces a `main.js` containing the fetcher code; bundle does **not** import `tar`, `node-tar`, or any new third-party module (verify by inspecting `main.js` size delta — expected delta is small, single-digit KB).
- `npm run deploy` still works; `.deploy-target` flow unchanged.

**Manual:**

- With `copilot.exe` present in the vault plugin folder at the pinned version, the plugin loads exactly as before (no Notice, no download) — verified by checking the dev console.
- With `copilot.exe` deleted from the vault plugin folder, reloading the plugin shows a "Downloading…" Notice that updates as bytes stream in; after ~30–90s the binary appears at the final path with `0755` permissions on POSIX or just present on Windows; chat works.
- Settings → Copilot Agent shows the CLI binary section reporting the installed version; deleting the marker file and clicking Retry re-downloads cleanly.
- Disabling the network mid-download leaves no partial file at the final path; the Settings status updates to a "network" error message; clicking Retry while the network is still down does not loop or crash; restoring the network and clicking Retry succeeds.

---

## Phase 3: GitHub Actions release workflow

### Changes Required

**New: `scripts/release/assemble-assets.mjs`** + **`src/release/releaseAssets.ts`**

Single source of truth for "what makes a release":

- Asserts the build output `main.js` exists at the repo root after `npm run build`.
- Asserts `manifest.json` and `styles.css` exist.
- Copies all three to a `release-assets/` directory (created fresh).
- Asserts manifest version matches the supplied target version; fails with a clear message on mismatch (FR-012 + spec validation).
- Asserts `versions.json` contains an entry for the target version.

Pure validation logic (file-list shape, version match, exactly-three-files invariant) lives in `src/release/releaseAssets.ts`. The orchestration script invokes the validators with concrete file system probes.

**New: `scripts/release/extract-release-notes.mjs`** (uses `src/release/changelog.ts` from Phase 1)

Reads `CHANGELOG.md` from `repoRoot`, extracts the section matching the supplied version, writes it to stdout (or a path passed as the second argument). Fails non-zero if the section is missing (per FR-013). Pure logic was already added in Phase 1 (`extractSection`); this script is the orchestration shim.

**Edit: `package.json`** (scripts)

Add aliases used by both CI and the release agent's manual fallback:

- `"changelog:extract": "tsx scripts/release/extract-release-notes.mjs"`
- `"release:assemble": "tsx scripts/release/assemble-assets.mjs"`

**New: `.github/workflows/release.yml`**

A single workflow file that triggers on `push` of tags matching `v*` (per FR-011). The workflow contains one job, `release`, running on `ubuntu-latest` (the build is platform-independent — esbuild produces `main.js` on any host per `esbuild.config.mjs:6-16`). Steps:

1. `actions/checkout@v4` at the pushed tag commit.
2. `actions/setup-node@v4` with `node-version: '20'` and `cache: 'npm'`.
3. `npm ci` (reproducible install from `package-lock.json`).
4. `npm run typecheck` (per FR-014).
5. `npm test` (per FR-014).
6. `npm run build` (production esbuild → `main.js`).
7. `npm run release:assemble -- <tag-version>` — produces `release-assets/` and validates manifest/versions.json alignment.
8. `npm run changelog:extract -- <tag-version> > release-notes.md` — extracts the body for the release.
9. `softprops/action-gh-release@v2` (pinned to a specific SHA in the file for supply-chain hygiene): `files: release-assets/main.js release-assets/manifest.json release-assets/styles.css`, `body_path: release-notes.md`, `name: v<version>`, `tag_name: <pushed tag>`, `draft: false`, `prerelease: <true when tag contains a hyphen, else false>`.

The workflow has `permissions: contents: write` at the job level so it can create releases. No other secrets are needed.

**New tests:**

- `src/release/releaseAssets.test.ts` — exactly-three-files invariant; manifest/version mismatch detection; missing-asset detection.
- `src/release/changelog.test.ts` — already covers extraction in Phase 1; this phase adds tests for end-to-end "extract for missing version exits non-zero", "extract preserves trailing whitespace correctly".

This phase makes no `src/` (runtime) changes. The workflow is not exercised end-to-end until Phase 5 cuts the first real tag; this phase's verification is unit tests + static workflow YAML parse.

### Success Criteria

**Automated:**

- `npm test` passes including new tests.
- `npm run typecheck` clean.
- `node -e "require('js-yaml').load(require('fs').readFileSync('.github/workflows/release.yml','utf8'))"` parses cleanly. (`js-yaml` is already transitively available; if not, fall back to `yaml` via vitest's deps. Decision: skip a dedicated YAML linter; rely on built-in parse + GitHub's UI lint when pushed.)
- `npm run changelog:extract -- 0.5.0` against the current CHANGELOG prints the v0.5.0 body verbatim.
- `npm run release:assemble -- 0.6.0 --dry-run` reports asset list and version-match result without copying files (use `--dry-run` for unit-test purposes).

**Manual:**

- Workflow file passes GitHub's web-UI lint when pushed to the branch (GitHub flags syntax errors inline on the Actions tab).
- Workflow appears in the repo's Actions tab as inactive (no tag pushed yet).

---

## Phase 4: Copilot CLI release agent and skills

### Changes Required

This phase introduces a Copilot CLI agent definition and a set of skill files that together orchestrate a release. The agent + skills follow the patterns visible in `.github/copilot-instructions.md:53-62` and the PAW artifact layout under `.paw/`. Discovery: PAW agents live in user-level/plugin-level skill directories, not in-repo, but per `Spec.md` FR-005 the release agent should live "at a conventional location for this repo's tooling" and be discoverable from the docs. Decision: place agent + skills in a new top-level `.copilot/agents/release/` directory, with the agent definition at `.copilot/agents/release/agent.md` and one skill per file in `.copilot/agents/release/skills/`. Referenced from `RELEASING.md` (Phase 6). This keeps the release tooling versioned with the repo and reproducible across maintainers.

**New: `.copilot/agents/release/agent.md`**

Defines the release agent's identity, goal, the skill files it consults, and the high-level happy-path narrative. Roughly: "You are the release agent for obsidian-copilot-agent. When the user asks 'release vX.Y.Z', execute the skills in order: preflight → version-bump → changelog-review → tag-and-push → ci-monitor → verify. Stop on any failure and report a recovery path. You are re-entrant: re-running detects completed steps."

**New skill files** (one per discrete capability, per FR-006):

- `.copilot/agents/release/skills/preflight.md` — verifies (a) clean working tree (`git status --porcelain` empty), (b) on `main`, (c) `main` up to date with `origin/main` (`git fetch && git rev-list --count main..origin/main` = 0), (d) `npm run typecheck` succeeds, (e) `npm test` succeeds, (f) target version is strictly greater than current `package.json` version (delegates to `node scripts/version-bump.mjs --check <version>` — a new `--check` mode added to the version-bump script in this phase). Any failure halts the release with a clear actionable message. (FR-007)

- `.copilot/agents/release/skills/version-bump.md` — runs `npm run version-bump -- <version>`. On success, reports the four mutated files and asks the maintainer to inspect before continuing.

- `.copilot/agents/release/skills/changelog-draft.md` — drafts the new version's CHANGELOG entry by inspecting `git log <previous-tag>..HEAD --no-merges` (or `git log main` if no prior tag), grouping commits by conventional prefix where present, presents the draft to the maintainer for review/edit, then writes the agreed text into the placeholder block left by the version-bump script. (FR-008) Idempotent: if the entry already has non-stub content, skip.

- `.copilot/agents/release/skills/tag-and-push.md` — commits the four mutated files with message `chore(release): v<version>`, creates annotated tag `v<version>` with the CHANGELOG body, and pushes both branch and tag. Re-entrancy: detects existing commit/tag and skips.

- `.copilot/agents/release/skills/ci-monitor.md` — polls `gh run list --workflow=release.yml --branch=main --limit=1` (or watches by tag-derived workflow run) until completion. Reports success with the release URL or failure with the failed step's log link. (FR-009) Notes that the maintainer's `gh` account context is whatever is currently selected (per `Spec.md` assumption about two-account workflow).

- `.copilot/agents/release/skills/verify.md` — fetches the published release via `gh release view v<version>` and asserts: (a) three assets named exactly `main.js`, `manifest.json`, `styles.css`; (b) release body matches the CHANGELOG section; (c) release is not a draft. Reports the public URL.

**Edit: `scripts/version-bump.mjs`** — add `--check <version>` mode

When invoked with `--check <version>`, the script performs only the validation steps (parses, compares to current, asserts strictly greater) and exits 0 / non-zero without mutating any file. Used by the preflight skill.

**No source changes** to `src/` in this phase. No tests beyond what already covers `version-bump.mjs --check` (extend `src/release/versioning.test.ts` with a check-mode entry-point test). The skill markdown files themselves are not unit-tested — per `Spec.md` FR-030, "orchestration prose in skills exempted".

### Success Criteria

**Automated:**

- `npm test` passes including new check-mode test on the version-bump lib.
- `node scripts/version-bump.mjs --check 0.6.0` exits 0; `node scripts/version-bump.mjs --check 0.0.1` exits non-zero.
- A linter or doc-check pass confirms every skill file referenced by `agent.md` exists at the named path (a tiny script `scripts/validate-agent-skills.mjs` added as a defensive measure, optional — decision: skip; rely on Phase 5 end-to-end exercise).

**Manual:**

- Maintainer can invoke the release agent in the Copilot CLI by name, ask "release v0.6.0-rc.1", and the agent walks the full sequence (preflight → bump → CHANGELOG draft for review → tag/push → CI watch → verify) without unexpected halts. (This dry-run uses an `rc.1` tag against a throwaway commit on a feature branch; the produced release can be deleted afterward without polluting v0.5.0/v0.6.0 history. The dry-run also exercises Phase 3's workflow end-to-end.)
- Interrupting the agent between bump and tag, then re-invoking with the same version, is detected (preflight notices the dirty tree from the bump commit being unpushed, or the tag exists) and reports a clear recovery path. (FR-010)

---

## Phase 5: BRAT bootstrap — retroactive v0.5.0 release, README install docs, smoke test, cut v0.6.0

### Changes Required

This is the integration phase. It exercises every prior phase against real GitHub Releases.

**New: README "Install via BRAT" section** (per FR-016, FR-017)

A new top-level `## Install via BRAT` section in `README.md`, placed above the existing "Local development setup" section. Content covers:

- Brief intro: this plugin is in beta and distributed via BRAT, not (yet) the official Community Plugins catalog.
- Step-by-step: install BRAT from Community Plugins → command palette → "BRAT: Add a beta plugin for testing" → paste `ChrisKrawczyk/obsidian-copilot-agent` → confirm → enable in Community Plugins.
- First-launch behavior: a Notice will appear while the Copilot CLI binary downloads (~150 MB, one time); the plugin then prompts for OAuth.
- Supported platforms: Windows x64/arm64, macOS x64/arm64, Linux glibc x64/arm64, Linux musl x64/arm64. Mark macOS/Linux as "alpha — please report issues" per `Spec.md` R7.
- Known limitations: requires reachable `registry.npmjs.org` (corporate proxy blocking npm registry will fail at first launch with an actionable error); plugin is desktop-only.
- OS-warning note: SmartScreen / Gatekeeper may flag the downloaded binary on first run; this is upstream `@github/copilot` behavior (per `Spec.md` Assumptions on code signing).

The existing status line "Not yet packaged for distribution." (`README.md:5`) is replaced with current-state language naming BRAT as the install vector and noting `v0.6.0` as the first BRAT-installable release.

**Smoke test procedure documentation** (per FR-018)

Documented inline in `RELEASING.md` (Phase 6) but the **execution** belongs to this phase. The procedure:

1. Spin up a clean Obsidian vault (Windows; macOS and Linux are best-effort given maintainer hardware).
2. Install BRAT from Community Plugins.
3. `Add Beta Plugin → ChrisKrawczyk/obsidian-copilot-agent`.
4. Wait for BRAT to fetch assets; verify the vault plugin folder contains exactly `main.js`, `manifest.json`, `styles.css` (no extra files).
5. Enable the plugin; observe the "Downloading…" Notice; wait for completion.
6. Run through OAuth device flow.
7. Send a short chat message; verify a streamed response.
8. Reload the plugin (toggle off + on); verify the binary is not re-downloaded.

**Retroactive v0.5.0 release** (per FR-031, SC-005)

A scripted, reproducible bootstrap (not a one-time manual procedure) that uses the same asset and release-notes helpers as Phase 3's CI workflow. This keeps the v0.5.0 release auditable and re-runnable, and keeps the "what makes a release" contract single-sourced.

**New: `scripts/release/bootstrap-v0.5.0.mjs`**

A one-time-use orchestration script (kept in-repo for reproducibility) that:

1. Validates the working tree is clean and `gh` is authenticated against the correct account.
2. Creates a temporary worktree at the v0.5.0 merge commit (`22f660d` or whatever git identifies as the PR #5 merge): `git worktree add ../v0.5.0-build <sha>`.
3. In the worktree: `npm ci && npm run build`.
4. Invokes `scripts/release/assemble-assets.mjs` with target version `0.5.0`, building from the worktree's outputs but writing the manifest/version assertion against the tip-of-`main` `versions.json` (since the v0.5.0 commit predates `versions.json`). The assertion is loosened in `--bootstrap` mode: it asserts `manifest.json:version === "0.5.0"` (which means the v0.5.0 worktree must have its manifest at 0.5.0; if it's still at 0.1.0, the script writes a new `manifest.json` into `release-assets/` with version `0.5.0` from the current tree's manifest hygiene work, since the published manifest must match the released version — Obsidian/BRAT requirement).
5. Invokes `scripts/release/extract-release-notes.mjs 0.5.0` against the current `CHANGELOG.md`.
6. Creates the tag `v0.5.0` pointing at the v0.5.0 merge commit (annotated, body = release notes), pushes the tag.
7. Calls `gh release create v0.5.0 --notes-file release-notes.md release-assets/main.js release-assets/manifest.json release-assets/styles.css` against the v0.5.0 merge commit.
8. Cleans up the temporary worktree.
9. Supports `--dry-run` to print the planned operations without mutating anything.

Edge note in the release body: "v0.5.0 is published for historical completeness and pinning. v0.5.0 has no in-plugin binary fetcher, so a fresh BRAT install of v0.5.0 will fail at first launch unless the user already has the Copilot CLI binary in the plugin folder. First-time BRAT users should pin v0.6.0 or later." This is captured in `RELEASING.md` (Phase 6) and produced by the bootstrap script as the release body suffix.

**Edit: `package.json`** (scripts) — add `"release:bootstrap-v0.5.0": "tsx scripts/release/bootstrap-v0.5.0.mjs"`.

**New tests: `src/release/bootstrapRelease.test.ts`**

Unit tests for the pure helpers used by the bootstrap script: historical-ref selection, asset list enforcement (calls back into `releaseAssets.ts`), and dry-run plan generation. The orchestration script itself (worktree + gh) is exercised manually by running it once.

**Cut v0.6.0** (the real release)

1. Ensure `main` contains all merged Phase 1–4 work (this implementation plan's PR is merged).
2. Invoke the release agent: "release v0.6.0".
3. Agent walks preflight → bump → CHANGELOG draft (maintainer reviews/edits) → tag/push → CI monitor → verify.
4. Execute the smoke test against the published v0.6.0.

**No additional code changes** in this phase beyond the README edits. This phase's "deliverables" are operational: two GitHub Releases (v0.5.0 + v0.6.0) and a passing smoke test signed off in `RELEASING.md`.

### Success Criteria

**Automated:**

- `npm test` continues to pass (no regressions from README edits — there are none expected).
- GitHub Actions release workflow run for `v0.6.0` completes green.

**Manual:**

- Browsing the repo's GitHub Releases page shows two entries: `v0.5.0` and `v0.6.0`. Each has exactly three assets at the release root: `main.js`, `manifest.json`, `styles.css`. v0.6.0's body matches the CHANGELOG v0.6.0 section.
- Smoke test passes end-to-end on Windows: clean vault → BRAT install → fetcher downloads binary → OAuth → chat exchange completes.
- Smoke test executed best-effort on macOS arm64 and/or Linux x64 (per SC-003); results recorded in `RELEASING.md`. Failures on those platforms are filed as follow-up issues, not blockers for v0.6.0 per R7.

---

## Phase 6: Documentation — RELEASING.md, Docs.md, README finalization

### Changes Required

**New: `RELEASING.md`** (per FR-003, FR-028)

A standalone top-level doc covering, in order:

- **Quick start**: "Run `node scripts/version-bump.mjs <version>` then ask the release agent: 'release v<version>'."
- **Prerequisites**: clean tree on `main`, `gh` CLI authenticated against the GitHub account with release-write permission on the repo, Node 20+.
- **Step-by-step**: full agent invocation walkthrough mirroring Phase 5's "cut v0.6.0" sequence.
- **CHANGELOG format**: documents the Keep-a-Changelog-loose convention currently in use (`## [version] - date` headings, `### Added/Changed/Fixed/Security/Migration/Dependencies/Bundle Size/Tests` sub-sections). (FR-028)
- **Manual fallback**: the same release without the agent, command by command. (FR-004)
- **Recovery procedures**: dirty tree, failed CI, accidentally tagged from non-`main`, partial state mid-bump. Each maps to a documented manual cleanup. (FR-010, R8)
- **Trust chain note**: the fetcher pins to `PINNED_BINARY_VERSION` (baked at build time from `@github/copilot`'s installed version), verifies sha512 from npm registry metadata, and writes only inside the plugin folder. Upgrading the binary version requires bumping `@github/copilot-sdk` (or its transitive `@github/copilot` pin) and re-releasing. (R1)
- **Smoke test procedure**: the eight-step BRAT install verification from Phase 5, plus the cross-platform best-effort matrix.
- **Two-`gh`-account note**: the maintainer's release agent uses whichever `gh` account is currently selected; verify with `gh auth status` before invoking. (Spec assumption.)

**New: `.paw/work/packaging-release/Docs.md`** (per existing PAW pattern, see `.paw/work/mcp-client/Docs.md:1-9`)

Technical reference for the architecture introduced by this work. Sections (matching the PAW Docs.md convention):

- **Overview**: scope and entry points.
- **Architecture and Design**:
  - Release pipeline: `version-bump.mjs` → tag/push → `release.yml` → GitHub Release.
  - Runtime fetcher: `BinaryFetcher` lifecycle, integration into `src/main.ts:onload()`, the pinned-version mechanism, platform tuple detection.
  - Release agent: agent + skills layout under `.copilot/agents/release/`, re-entrancy model.
- **User-Facing Behavior**: Notice + Settings UI surfaces during first-launch fetch, BRAT install path, error → Retry flow.
- **Resilience and Lifecycle**: atomic-rename guarantees, integrity verification, partial-download cleanup, idempotent agent re-runs.
- **Security Posture**: HTTPS-only fetch from `registry.npmjs.org`, sha512 integrity check, no execution of registry-supplied JS (binary-extraction-only), pinned version (no `latest`), trust chain documented.

Cross-linked from `README.md` (a single line near the existing MCP `Docs.md` link at `README.md:52`).

**Edit: `README.md`** — finalization

- Confirm the BRAT install section from Phase 5 is in place and reads cleanly.
- Replace the "Status" line and "What's new" section per the new v0.6.0 reality.
- Add a single-line link to `RELEASING.md` in a maintainer-facing section (or in the existing "Reference" section, `README.md:165-181`).
- Add a single-line link to `.paw/work/packaging-release/Docs.md` next to the MCP `Docs.md` link.
- Update the "Why a separate CLI binary?" section (`README.md:161-163`) to mention that the binary is now acquired by the in-plugin fetcher on first launch (with a one-line summary; full details in `Docs.md`).

**Edit: `.github/copilot-instructions.md`**

- Add a brief paragraph noting the new release tooling exists at `scripts/version-bump.mjs` and the release agent at `.copilot/agents/release/`, and clarifying that `npm run deploy` is still the dev-time deploy path (unchanged). (FR-029)
- No other changes; existing deploy guidance remains accurate.

### Success Criteria

**Automated:**

- `npm test` continues to pass (doc-only edits do not regress tests).
- Markdown links in `README.md`, `RELEASING.md`, and `Docs.md` resolve (no broken intra-repo references — verified by spot-check; no automated link-checker is added).

**Manual:**

- A reader who has never seen the release tooling can ship a release using only `RELEASING.md` (per SC-006). Validation: a second pass by a fresh reader (or future-me with no memory of this session) confirms the doc is sufficient.
- `Docs.md` reads cleanly as the technical reference for this work and follows the PAW Docs.md structural convention.
- `README.md` "Install via BRAT" section accurately describes the v0.6.0 install experience.

---

## Cross-Phase Notes

**Test baseline**: 968 passing tests at base. Each phase additively introduces tests; no phase removes or modifies existing tests beyond direct file edits. Final count is 968 + new tests (estimated 30–50 across Phases 1–2).

**Build size**: Phase 2 adds the fetcher to `main.js`. The expected delta is small (single-digit KB) because the implementation uses node builtins only. Verify the delta during Phase 2 review.

**Re-runnability of the release agent (FR-010)**: enforced at every step boundary. The preflight skill always re-validates current state; the version-bump script is idempotent (refuses to re-bump to the same version); the changelog-draft skill detects existing non-stub content and skips; the tag-and-push skill detects existing commit and tag and skips. Maintainer can Ctrl+C at any point and re-invoke safely.

**Dev workflow preservation (FR-029, SC-007)**: at no phase does `npm run dev`, `npm run deploy`, `npm run build`, `npm run typecheck`, or `npm test` change behavior for an existing developer with `copilot.exe` already in the vault plugin folder. The fetcher's `isInstalled` short-circuit (Phase 2) guarantees this for the runtime path; the manifest hygiene edit (Phase 1) is data-only.
