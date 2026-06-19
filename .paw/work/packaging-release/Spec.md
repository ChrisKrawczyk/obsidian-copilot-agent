# Feature Specification: Packaging and Release (v0.6.0)

**Branch**: feature/packaging-release  |  **Created**: 2026-06-19  |  **Status**: Draft
**Input Brief**: Ship the plugin to real users via a reproducible release pipeline and the BRAT install path, with an in-plugin cross-platform binary fetcher so a fresh BRAT install actually works.

## Overview

Today the plugin is install-by-clone: developers run `npm install && npm run deploy` to push build artifacts into a vault folder. Real users cannot try it without a Node toolchain. The repo also lacks any release infrastructure — no tags, no GitHub Releases, no version-bump tooling, no CHANGELOG, and the bundled native CLI binary (`copilot.exe`) is Windows-only and would be an anti-pattern to ship as a release asset (~150 MB, single platform).

This work creates the end-to-end path from a dev typing "ship v0.6.0" to a non-developer Obsidian user installing the plugin via BRAT and having it work on Windows, macOS, or Linux. It establishes (1) a reproducible release pipeline driven by a small toolchain of scripts and a Copilot CLI **release agent** that orchestrates them, (2) a GitHub Actions workflow that publishes the release on tag push, (3) BRAT compatibility (artifact naming and `versions.json`) plus user-facing install docs, and (4) a first-launch binary fetcher inside the plugin that downloads the correct `@github/copilot-<platform>-<arch>` package from the npm registry on demand. The fetcher leverages the upstream platform-split pattern already used by `@github/copilot` (Linux x64/arm64, Linux musl x64/arm64, macOS x64/arm64, Windows x64/arm64) so the plugin stays small in the release bundle and works cross-platform on first install.

The release agent + skills are designed to mirror the project's existing PAW-style workflow tooling: a Copilot CLI agent definition plus a set of skill markdown files defining capabilities (preflight, version bump, changelog, tag, monitor). Running a release becomes a guided conversation — "release v0.6.0" — instead of a memorized sequence of commands. This both reduces release friction and makes the process reproducible by other contributors and by future-me.

Cross-platform binary acquisition and the release agent are scope expansions vs the original proposal sketch (#0002, Phases A + B). They are included here because they are prerequisites for "BRAT actually works for a fresh user," which is the bar for calling this release shippable.

## Objectives

- Establish a reproducible release pipeline: one command (via the release agent) produces a tagged, tested, BRAT-installable GitHub Release.
- Make `package.json`, `manifest.json`, `versions.json`, and `CHANGELOG.md` stay in lockstep with zero manual hand-editing during a release.
- Ship a GitHub Actions workflow that, on tag push, runs typecheck + tests + production build and creates the GitHub Release with the BRAT-required assets at the release root.
- Make the plugin cross-platform on first install by acquiring the platform-correct Copilot CLI binary at runtime from the npm registry — no binary bundled in the release.
- Document the BRAT install path in README so a non-developer Obsidian user can install the plugin and get a working agent without any terminal commands.
- Provide a Copilot CLI release agent + skills so future releases are runnable via a guided conversation rather than memorized commands.
- Keep developer ergonomics intact: `npm run dev`, `npm run deploy`, and all existing developer commands continue to work unchanged.

## User Scenarios & Testing

### User Story P1 – Maintainer ships v0.6.0
**Narrative**: The maintainer (currently Chris) has merged work into `main` and decides it is time to cut v0.6.0. They invoke the release agent in their terminal: "release v0.6.0". The agent walks through a guided sequence — preflight checks (clean tree, on `main`, tests green), version bump across the four files, CHANGELOG entry confirmation (agent drafts; maintainer reviews/edits), tag creation, push. The agent then watches the GitHub Actions release workflow until the GitHub Release page is live with the three required assets, and reports success with a link.

**Independent Test**: From a clean `main`, invoke the release agent for a test version (e.g. `v0.6.0-rc.1`); confirm the GitHub Release appears with `main.js`, `manifest.json`, `styles.css` attached at the release root, and the bump commit + tag are on `main`.

**Acceptance Scenarios**:
1. Given a clean working tree on `main` with passing tests, When the maintainer runs the release agent with version `v0.6.0`, Then `package.json`, `manifest.json`, `versions.json`, and `CHANGELOG.md` are all updated in lockstep in a single commit, an annotated tag is created, and the GitHub Actions release workflow completes successfully with a public Release.
2. Given a dirty working tree, When the release agent runs preflight, Then the agent refuses to proceed and reports the dirty files.
3. Given failing tests, When the release agent runs preflight, Then the agent refuses to bump versions or create a tag.
4. Given a version string that is not strictly greater than the current `package.json` version, When the agent runs preflight, Then the agent refuses to proceed and reports the comparison.

### User Story P2 – New user installs via BRAT (Windows)
**Narrative**: A non-developer Obsidian user on Windows has heard about the plugin. They follow the README's "Install via BRAT" section: install BRAT from Community Plugins, "Add Beta Plugin" → paste `ChrisKrawczyk/obsidian-copilot-agent`. BRAT downloads the latest release assets into their plugin folder. They enable the plugin. On first open, the plugin notices `copilot.exe` is missing, shows a Notice ("Downloading Copilot CLI…"), fetches `@github/copilot-win32-x64@<pinned-version>` from the npm registry, extracts the binary into the plugin folder, and continues startup. The user runs through the existing OAuth login and starts chatting.

**Independent Test**: In a clean Obsidian vault on Windows with no Node toolchain, install via BRAT from a freshly published release; verify the binary downloads on first launch and a chat completes successfully.

**Acceptance Scenarios**:
1. Given BRAT is installed and `ChrisKrawczyk/obsidian-copilot-agent` is added as a beta plugin, When BRAT installs the latest release, Then the user's plugin folder contains `main.js`, `manifest.json`, and `styles.css` (and no other plugin-shipped files).
2. Given a freshly BRAT-installed plugin with no Copilot CLI binary present, When the user enables the plugin for the first time, Then the plugin shows a Notice indicating the binary is downloading, fetches the platform-correct package from the npm registry, extracts the binary into a known location inside the plugin folder, and continues startup without manual intervention.
3. Given the binary already exists from a prior fetch and matches the version pinned by the current plugin version, When the user opens Obsidian, Then no re-download occurs.
4. Given the binary fetcher fails (network down, registry unreachable), When the user enables the plugin, Then the plugin surfaces a clear, actionable error with a "Retry" affordance in Settings and does NOT crash or repeatedly retry in a loop.

### User Story P3 – New user installs via BRAT (macOS / Linux)
**Narrative**: Same as P2 but on macOS (arm64 or x64) or Linux (glibc or musl, arm64 or x64). The fetcher detects platform + architecture (and libc family on Linux) and downloads the matching `@github/copilot-<plat>-<arch>` package. Everything else is identical.

**Independent Test**: Repeat the P2 independent test on macOS arm64 (M-series Mac) and Linux x64 (e.g. Ubuntu in a VM); verify each platform fetches the correct package and a chat completes.

**Acceptance Scenarios**:
1. Given a fresh BRAT install on macOS arm64, When the user enables the plugin, Then `@github/copilot-darwin-arm64` is fetched and extracted, and the binary is marked executable.
2. Given a fresh BRAT install on Linux x64 (glibc), When the user enables the plugin, Then `@github/copilot-linux-x64` is fetched; on Linux musl, `@github/copilot-linuxmusl-x64` is fetched.
3. Given an unsupported platform/arch combination, When the user enables the plugin, Then the plugin surfaces a clear error naming the detected platform and does NOT attempt to fetch.

### User Story P4 – Maintainer updates an existing BRAT install
**Narrative**: The maintainer publishes v0.6.1. Within BRAT's check interval (or on manual "Check for updates"), BRAT downloads the new release assets and replaces them. The plugin restarts; if the pinned binary version changed, the fetcher acquires the new binary; otherwise the existing binary is reused.

**Acceptance Scenarios**:
1. Given a user on v0.6.0 with the v0.6.0-pinned binary cached, When BRAT updates them to v0.6.1 which pins the same binary version, Then no re-download occurs on next launch.
2. Given a user on v0.6.0, When BRAT updates them to v0.7.0 which pins a different binary version, Then the new binary is fetched on next launch and the old binary is replaced (or kept side-by-side with an explicit version path — implementation decides).
3. Given an in-progress chat session when an update is installed, Obsidian's plugin reload flow applies and the existing behavior holds (no new requirements introduced by this work for that scenario).

### User Story P5 – Contributor reads the release docs and ships a hotfix
**Narrative**: A future contributor (or future-me with no memory of this session) needs to ship a hotfix. They open `RELEASING.md` (or equivalent doc), follow the steps — which boil down to "run the release agent and answer its prompts" — and ship without needing to reconstruct the process.

**Independent Test**: A reader who has never seen the release tooling should be able to ship a release using only the doc.

**Acceptance Scenarios**:
1. Given the release doc, When a contributor follows it end-to-end, Then they can produce a published GitHub Release without consulting any other source.
2. Given the doc, the release agent definition is discoverable (named, located in a conventional path, referenced from the doc).

### Edge Cases
- **Network failure mid-download** of the binary tarball: fetcher must not leave a partial binary on disk; retry must be safe.
- **Plugin folder read-only or write-blocked** (corporate vault on synced drive with locks): fetcher must surface a clear error, not silently fail.
- **Old binary present from a manual developer install** (dev workflow): the plugin treats the pinned version as authoritative. If the present binary matches the pinned version, the fetcher does nothing. If it does not match, the fetcher acquires the pinned version, regardless of whether the present binary is newer or older.
- **Maintainer accidentally tags from a non-`main` branch**: GitHub Actions workflow should still build cleanly, but the release agent's preflight should refuse to tag from a non-`main` branch.
- **Maintainer interrupts the release agent mid-flow** (Ctrl+C between version bump and tag): the agent must be re-runnable; partial state must be either rolled back or detected and recovered on next invocation.
- **GitHub Actions release workflow fails after tag push**: the tag exists but no Release; the agent must surface this clearly and provide a recovery path (delete tag + re-tag, or re-run workflow).
- **CHANGELOG entry already exists for the target version** (e.g. agent re-run): agent must detect and skip duplication, not append a second entry.
- **First-launch fetcher races with the plugin's startup** (binary needed before download completes): startup must block (with UI feedback) on the fetcher, not race-and-crash.
- **User installs on an unsupported Obsidian app version** (below `minAppVersion`): standard Obsidian behavior applies; no new requirement.

## Requirements

### Functional Requirements

**Release tooling (Phase A)**
- FR-001: A version-bump script updates `package.json`, `manifest.json`, `versions.json`, and `CHANGELOG.md` atomically (all four or none) for a given version string. (Stories: P1)
- FR-002: `versions.json` is a top-level JSON file mapping each released plugin version to its required Obsidian `minAppVersion`. It is updated by the version-bump script. (Stories: P1, P2)
- FR-003: A `RELEASING.md` doc describes the release process end-to-end and references the release agent. (Stories: P5)
- FR-004: A manual command-line entry point exists as a fallback for the steps that the release agent automates. (Stories: P1, P5)

**Release agent + skills (Phase A.5)**
- FR-005: A Copilot CLI release agent is defined (conventional location for this repo's tooling, mirroring how PAW agents are structured). It is invokable by name from the Copilot CLI. (Stories: P1, P5)
- FR-006: The release agent exposes capabilities via discrete skill files covering: preflight, version bump, CHANGELOG drafting, tag + push, GitHub Actions run monitoring, and release verification. (Stories: P1, P5)
- FR-007: The preflight skill verifies: (a) clean working tree, (b) on the release branch (`main`), (c) the release branch is up to date with its remote, (d) the typecheck and test suites pass, (e) target version is strictly greater than the version recorded in `package.json` (which the version-bump script keeps in lockstep with the latest cut release; see FR-001). Any failure halts the release. (Stories: P1)
- FR-008: The CHANGELOG drafting skill drafts the new version's entry from the commit history since the previous tag (or `main` history if no prior tag), and presents it to the maintainer for review/edit before committing. (Stories: P1)
- FR-009: The release agent watches the GitHub Actions release workflow run triggered by the tag push and reports completion status with a link to the published Release. (Stories: P1)
- FR-010: The release agent is re-entrant: if invoked after a partial failure, it detects already-completed steps and resumes from the right point or reports a clear recovery path. (Stories: P1, edge case "interrupts mid-flow")

**CI / GitHub Actions (Phase A)**
- FR-011: A GitHub Actions workflow triggers on push of release tags. It checks out the tag commit, installs dependencies reproducibly, runs typecheck, runs the test suite, runs the production build, and creates a GitHub Release on the tag. (Stories: P1, P2)
- FR-012: The GitHub Release assets include exactly `main.js`, `manifest.json`, and `styles.css` at the release root (BRAT requirement — no zip, no subfolder). (Stories: P2, P3)
- FR-013: The release body is populated from the matching `CHANGELOG.md` section. (Stories: P1)
- FR-014: The workflow fails the release if typecheck or tests fail (no partial release published). (Stories: P1)

**BRAT compatibility + docs (Phase B)**
- FR-015: `manifest.json` is audited for BRAT/Obsidian compliance: valid `id`, human-readable `name`, current `version`, `minAppVersion`, `description`, `author`, `authorUrl`, `isDesktopOnly: true`, optional `fundingUrl`. The `id` remains `obsidian-copilot-agent`. The `name` is updated to remove the `(Spike)` suffix. (Stories: P2, P3)
- FR-016: `README.md` includes a clearly marked "Install via BRAT" section with step-by-step instructions, an explicit note that this is pre-release/beta software, and the supported platform list. (Stories: P2, P3, P5)
- FR-017: README's current status line ("Not yet packaged for distribution.") is replaced with accurate, current language. (Stories: P2)
- FR-018: A manual BRAT smoke test procedure is documented (clean test vault, install via BRAT, verify first-launch fetcher, verify a chat completes). The maintainer executes this procedure before tagging v0.6.0. (Stories: P2)

**First-launch binary fetcher (cross-platform support)**
- FR-019: On plugin enable/load, the plugin detects whether the required Copilot CLI binary is present at a known location inside its plugin folder. (Stories: P2, P3, P4)
- FR-020: When the binary is absent or does not match the pinned version, the plugin fetches the platform-correct `@github/copilot-<plat>-<arch>` npm package from the public npm registry, extracts the binary, and places it at the expected location. Pinned version is derived from the plugin release (a constant baked in at build time, matching the `@github/copilot` version that `@github/copilot-sdk` was built against). (Stories: P2, P3, P4)
- FR-021: Platform detection covers: `win32-x64`, `win32-arm64`, `darwin-x64`, `darwin-arm64`, `linux-x64`, `linux-arm64`, `linuxmusl-x64`, `linuxmusl-arm64`. On Linux, libc family is detected to choose between `linux-*` and `linuxmusl-*`. (Stories: P3)
- FR-022: The fetcher provides UI feedback during download (Notice or in-chat indicator) and blocks dependent startup paths until the binary is ready. The renderer must not freeze; download runs off the UI thread or via streaming. (Stories: P2, P3)
- FR-023: On fetch failure, the plugin surfaces an actionable error with a "Retry" action available in Settings → Copilot Agent. The plugin does NOT retry automatically in a loop. (Stories: P2, edge case "network failure")
- FR-024: On unsupported platform/arch, the plugin surfaces a clear error naming the detected platform and does NOT attempt to fetch. (Stories: P3 acceptance #3)
- FR-025: Partial downloads (interrupted, corrupt) must not leave a non-functional binary at the final path. Implementations may stage to a temp path and atomically rename, or verify integrity before commit. (Stories: P2, P3)
- FR-026: The existing developer deploy workflow continues to work unchanged: when a binary is already present in the plugin folder at the pinned version (placed there by the dev toolchain), the fetcher does not re-download or interfere. (Stories: P1)

**CHANGELOG**
- FR-027: A `CHANGELOG.md` file exists in the repo root. The existing v0.5.0 entry (currently marked "Unreleased") is updated to its release date corresponding to the merge of PR #5 into `main`. A new v0.6.0 entry covering this work is added above it. Pre-v0.5 versions are not backfilled. (Stories: P1, P5)
- FR-028: The CHANGELOG follows a simple, conventional format (the existing "loosely based on Keep a Changelog" format is preserved). The format is documented in `RELEASING.md`. (Stories: P5)
- FR-031: As part of this work, a GitHub Release for **v0.5.0** is published with BRAT-compliant assets. The release is intended for **historical completeness and version-pinning**, not as a fresh-install vector — v0.5.0 predates the in-plugin binary fetcher, so a fresh BRAT install of v0.5.0 will not work without prior manual binary placement. The build outputs (`main.js`, `styles.css`) are produced from the v0.5.0 merge commit; `manifest.json` is normalized to declare `"version": "0.5.0"` (Obsidian/BRAT requires the published manifest's version to match the release tag, and the tree at the merge commit may still carry the spike-era `0.1.0` value). The release body documents this transparently. This is a one-time bootstrap action; subsequent releases flow through the release agent and CI. (Stories: P1)

### Key Entities

- **Plugin release version**: a semver-like string (e.g. `0.6.0`) that appears in `package.json`, `manifest.json`, the git tag (`v0.6.0`), the `CHANGELOG.md` heading, and the GitHub Release. All four must match for a release to be valid.
- **Pinned binary version**: the version of `@github/copilot` installed in `node_modules` at build time (which is what `@github/copilot-sdk` resolved to transitively — currently `1.0.59`). This is the version the first-launch fetcher acquires.
- **Platform tuple**: `<os>-<arch>` where `os ∈ {win32, darwin, linux, linuxmusl}` and `arch ∈ {x64, arm64}`. Identifies which `@github/copilot-<plat>-<arch>` package to fetch.
- **Release agent**: a Copilot CLI agent definition that orchestrates the release flow. The agent and its skills are discoverable from the release documentation and reside at a conventional location within the repo.
- **Release skill**: a markdown skill file (one per discrete capability) consumed by the release agent.

### Cross-Cutting / Non-Functional

- FR-029: All existing developer commands and workflows behave identically after this work as before; no new step is required to develop or test the plugin locally. (Stories: P1)
- FR-030: The plugin's test suite baseline (currently 968/968 passing) holds after this work; new code is covered by unit tests where practical, with orchestration prose in skills exempted. (Stories: P1)
- **No external services beyond GitHub + npm registry**: The release pipeline and the runtime fetcher rely only on github.com (Actions, Releases, tags) and the public npm registry. No new third-party services are introduced.
- **Security posture**: The fetcher downloads from the public npm registry over HTTPS, verifies tarballs via the integrity checksum (sha512) returned in the npm package metadata, and writes only inside the plugin folder. The fetcher does not execute any code from the downloaded package — it extracts the native binary file only.

## Success Criteria

- SC-001: After this work merges, the maintainer can ship v0.6.0 by invoking the release agent and answering its prompts; no manual editing of `package.json`, `manifest.json`, `versions.json`, or `CHANGELOG.md` is required during the release. (FR-001, FR-005, FR-006, FR-008)
- SC-002: A clean Obsidian vault on Windows, with no Node toolchain installed, can install the plugin via BRAT from the published v0.6.0 release and reach a successful chat exchange without any terminal commands. (FR-011, FR-012, FR-016, FR-019, FR-020, FR-022)
- SC-003: Platform detection logic for all eight tuples named in FR-021 (`win32-x64`, `win32-arm64`, `darwin-x64`, `darwin-arm64`, `linux-x64`, `linux-arm64`, `linuxmusl-x64`, `linuxmusl-arm64`) is covered by unit tests. Manual end-to-end smoke testing on macOS and Linux is **deferred** to a follow-up release; v0.6.0 ships those platforms as "alpha — please report issues" per R7. (FR-019, FR-020, FR-021)
- SC-004: When the release agent's preflight detects a dirty tree, failing tests, or a non-monotonic version bump, it refuses to proceed and reports the failure clearly. (FR-007)
- SC-005: The GitHub Releases page lists releases for both **v0.5.0** (bootstrapped retroactively) and **v0.6.0**. The v0.6.0 release lists exactly three assets at the release root — `main.js`, `manifest.json`, `styles.css` — and its body reflects the v0.6.0 CHANGELOG entry. (FR-012, FR-013, FR-031)
- SC-006: A first-time reader of `RELEASING.md` can ship a release without consulting any other source. (FR-003, FR-005, FR-006)
- SC-007: Existing developer commands and workflows behave identically after this work as before. (FR-029)
- SC-008: The plugin's test suite remains at 100% pass on the baseline plus any new tests added by this work. (FR-030)
- SC-009: The first-launch fetcher's failure modes (network down, unsupported platform, write-blocked folder) surface clear, actionable errors and do not loop, crash, or freeze the UI. (FR-022, FR-023, FR-024, edge cases)

## Assumptions

- **`@github/copilot` ships per-platform binaries via `optionalDependencies`** in the same pattern indefinitely. If upstream changes its distribution model, the fetcher will need a redesign; that is out of scope here.
- **npm registry is reachable from end-user machines.** Some corporate environments block public npm; those users will hit the fetcher error path and are explicitly out of the v0.6.0 happy-path support matrix. README notes this limitation.
- **The pinned binary version is the version of `@github/copilot` declared by the installed `@github/copilot-sdk` at build time.** This version is captured into the build at build time so the fetcher knows what to ask for. Runtime override of the pinned version is not supported in v0.6.0.
- **Maintainer (Chris) operates with two `gh` accounts.** The release agent's GitHub Actions monitoring uses whichever account is currently selected; the agent does not manage `gh auth switch`. Documented as a release-doc note.
- **No code signing of binaries.** The plugin code itself is not signed; the downloaded native binary is whatever upstream `@github/copilot-<plat>-<arch>` ships (which is signed by GitHub at the npm registry level via integrity checksums but not by us). SmartScreen / Gatekeeper / similar OS warnings on first run are accepted; documented in README install section.
- **CHANGELOG already contains a v0.5.0 entry** (`CHANGELOG.md` exists at the start of this work, with a "Unreleased" v0.5.0 entry from the MCP work that merged to `main`). The v0.5.0 entry is marked released as part of this work. v0.6.0 is added on top. Pre-v0.5 versions are not backfilled.
- **BRAT is the primary distribution channel for v0.6.0.** Community Plugins catalog submission is explicitly Phase C and out of scope here.
- **Plugin folder is writable by the Obsidian process.** Read-only or write-blocked plugin folders surface a fetcher error; we do not work around platform-level access controls.
- **The plugin is `isDesktopOnly: true`.** Mobile Obsidian is not supported and is not in scope.

## Scope

**In Scope:**
- Version-bump script that updates `package.json`, `manifest.json`, `versions.json`, and `CHANGELOG.md` atomically.
- `versions.json` file maintained at repo root.
- `CHANGELOG.md` file with v0.6.0 entry authored as part of this work.
- `RELEASING.md` documenting the release process.
- A Copilot CLI release agent + skills covering preflight, version bump, changelog, tag/push, GH Actions monitoring, and release verification.
- A GitHub Actions release workflow triggered on `v*` tag push that builds and publishes the GitHub Release with BRAT-compliant assets.
- Manifest hygiene pass (BRAT/Obsidian compliance fields, name update).
- README "Install via BRAT" section.
- First-launch cross-platform binary fetcher in the plugin (download from npm registry, platform detection, UI feedback, error surfacing, retry).
- Pinned binary version embedded in the build.
- Manual BRAT smoke test executed against the published v0.6.0 release before public announcement.

**Out of Scope:**
- Submission to the official Obsidian Community Plugins catalog (Phase C — separate workflow).
- Mobile Obsidian support.
- Code signing of any artifact (plugin or native binary).
- Auto-update mechanics beyond what BRAT provides.
- Telemetry, install analytics, or release usage tracking.
- Runtime override of the pinned binary version (locking the user to a different CLI build).
- Migrations infrastructure for `data.json` shape changes (called out as a risk in the proposal but deferred; no shape change in this release).
- Backfilling CHANGELOG entries for pre-v0.6 history.
- A web-hosted release notes page outside GitHub Releases.
- Corporate-friendly fallback for npm-registry-blocked environments (proxy support, bundled-binary alternative).
- Multi-binary management (multiple Copilot CLI versions cached side-by-side as a feature; implementation may do this internally but no UI is exposed).

## Dependencies

- **GitHub Actions** with permission to create releases on this repo and upload assets.
- **GitHub Releases** as the artifact host (BRAT reads from there).
- **npm registry (registry.npmjs.org)** as the runtime source of `@github/copilot-<plat>-<arch>` packages.
- **BRAT plugin** as the install vector (no integration on our side — only docs).
- **Existing tooling**: esbuild build, vitest test suite, TypeScript typecheck.
- **`@github/copilot-sdk`** (already a dependency) which transitively pins `@github/copilot`.

## Risks & Mitigations

- **R1 — Fetcher security**: A malicious npm package masquerading as `@github/copilot-<plat>-<arch>` could supply a tampered binary. *Impact*: HIGH (remote code execution on user machine). *Mitigation*: Verify the integrity checksum (sha512) returned by the npm registry metadata before extraction. Pin the package version, not `latest`. Document the trust chain in `RELEASING.md`.
- **R2 — Renderer freeze during fetch**: The download could block the Obsidian UI if executed synchronously on the main thread. *Impact*: MEDIUM (UX regression matching the v0.5 disable-freeze we just fixed). *Mitigation*: Stream the download with chunked writes; use async I/O throughout; gate startup on a promise but keep the UI thread responsive (Notice updates, "Cancel" affordance).
- **R3 — Upstream binary distribution model changes**: GitHub could change how `@github/copilot` ships binaries (e.g. drop optionalDependencies, switch to a different registry, ship a unified binary). *Impact*: HIGH (fetcher breaks for all new installs). *Mitigation*: Pin to a known-good `@github/copilot-sdk` version; vendor a clear "binary acquisition strategy" doc so a swap is a localized change. Monitor `@github/copilot` releases.
- **R4 — Tag pushed from non-`main`**: Maintainer accidentally tags a feature branch; release publishes from wrong commit. *Impact*: MEDIUM (bad release, requires yank). *Mitigation*: Preflight refuses non-`main` (FR-007). GH Actions workflow logs the source ref. Maintainer follows documented "yank a release" procedure if it happens.
- **R5 — CHANGELOG drift**: Maintainer ships a release without updating CHANGELOG, or CHANGELOG entry doesn't match the release. *Impact*: LOW (cosmetic). *Mitigation*: Version-bump script requires a CHANGELOG entry exists for the target version; CI optionally validates. Release agent always drafts an entry as part of the flow.
- **R6 — BRAT compatibility regression**: A future change to release-asset naming or shape breaks BRAT installs silently. *Impact*: MEDIUM (no new users until detected). *Mitigation*: Manual smoke test before every public-facing release (FR-018). Documented in `RELEASING.md`.
- **R7 — Cross-platform untested at release time**: Maintainer only has Windows; macOS/Linux paths could regress unnoticed. *Impact*: MEDIUM (broken installs for those users). *Mitigation*: Platform detection logic is unit-tested. README explicitly labels macOS/Linux as "alpha / report issues." A follow-up proposal tracks setting up CI-driven cross-platform smoke tests.
- **R8 — Re-entrancy bugs in release agent**: Partial-state interruption leaves the repo in a half-bumped state that the next agent invocation can't recover from. *Impact*: MEDIUM (manual cleanup required). *Mitigation*: Agent's preflight always re-validates current state; clear documented manual recovery in `RELEASING.md`.
- **R9 — Network failure mid-fetch on first launch**: User has bad connection; binary half-downloads; plugin gets stuck. *Impact*: MEDIUM (UX issue, user can't use plugin). *Mitigation*: FR-025 (atomic stage-and-rename) plus FR-023 (clear error + manual retry).
- **R10 — Disk space**: Binary is ~150 MB; tarball extraction needs ~2x temporarily. Low-disk users could fail. *Impact*: LOW. *Mitigation*: Surface the OS error directly with a clear "out of disk" hint.

## References

- Proposal: `proposals/0002-packaging-release.md`
- Related proposals: `proposals/0001-m365-graph-mcp-server.md`, `proposals/0003-mid-session-mcp-tool-availability.md`, `proposals/0004-embeddings-vector-search.md`, `proposals/0005-mcp-slice7-upstream-tracking.md`
- README sections: "Status", "Why a separate CLI binary?", "Deploying to the test vault"
- Obsidian sample plugin (versioning pattern): https://github.com/obsidianmd/obsidian-sample-plugin
- BRAT: https://github.com/TfTHacker/obsidian42-brat
- `@github/copilot` package distribution pattern: per-platform `optionalDependencies` (verified locally in `node_modules/@github/copilot/package.json`)
- WorkflowContext: `.paw/work/packaging-release/WorkflowContext.md`
