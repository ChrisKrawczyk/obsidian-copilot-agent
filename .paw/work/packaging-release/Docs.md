# v0.6 Packaging & Release Technical Reference

## Overview

v0.6 of `obsidian-copilot-agent` adds the packaging and release infrastructure required to distribute the plugin via [BRAT](https://github.com/TfTHacker/obsidian42-brat). The plugin remains an Obsidian + GitHub Copilot SDK + MCP client; v0.6 does not change runtime chat, tool, model-picker, or vault behavior. The five surfaces introduced by this work are:

1. **Version-bump tooling** — atomic mutation of `package.json`, `manifest.json`, `versions.json`, and `CHANGELOG.md` from a single SemVer input.
2. **In-plugin binary fetcher** — first-launch download of the platform-specific Copilot CLI binary from `registry.npmjs.org` with sha512 verification.
3. **GitHub Actions release workflow** — tag-triggered assembly and publication of the three Release assets.
4. **Copilot CLI release agent** — agent + 6 skills under `.copilot/agents/release/` that orchestrate the end-to-end flow.
5. **BRAT install documentation + v0.5.0 retroactive publish** — README updates, `RELEASING.md`, and the one-shot `bootstrap-v0.5.0.mjs` script.

User-facing `README.md` documents installation. Maintainer-facing [`RELEASING.md`](../../../RELEASING.md) documents the runbook. This document is the technical reference behind both.

## Architecture and Design

### Release pipeline

The happy path for cutting v0.7.0 (or any future version) is:

```
maintainer: "release v0.7.0"
           │
           ▼
.copilot/agents/release/agent.md
           │
           ▼  (skill sequence)
preflight ─► version-bump ─► changelog-draft ─► tag-and-push ─► ci-monitor ─► verify
                                                       │
                                                       ▼ (push v0.7.0 tag)
                                          .github/workflows/release.yml
                                                       │
                                                       ▼
                                   actions/checkout ─► setup-node ─► npm ci ─► npm run build
                                                                                 │
                                                                                 ▼
                                                               scripts/release/assemble-assets.mjs
                                                                                 │
                                                                                 ▼
                                                                            release-assets/
                                                                            ├── main.js
                                                                            ├── manifest.json
                                                                            └── styles.css
                                                                                 │
                                                                                 ▼
                                                              scripts/release/extract-release-notes.mjs
                                                                                 │
                                                                                 ▼
                                                                       softprops/action-gh-release
                                                                                 │
                                                                                 ▼
                                                                 GitHub Release v0.7.0 (3 assets, body)
```

Every actions reference in `release.yml` is **SHA-pinned** (no `@v4`-style tags) — `actions/checkout`, `actions/setup-node`, `softprops/action-gh-release`. Maintainers upgrading actions must re-pin to the new commit SHA.

The workflow trigger is `on: push: tags: ['v*']`. The job runs on `ubuntu-latest`, sets `permissions: contents: write` (no other scopes), and uses `${{ secrets.GITHUB_TOKEN }}` for the Release upload — no PAT required.

### Version-bump tooling

`scripts/version-bump.mjs` is the single mutating entry point. It accepts:

- `<version>` — the bare SemVer to bump to (e.g. `0.7.0`, `0.7.0-rc.1`). The leading `v` is stripped if present.
- `--check` — diagnostic mode. Exit 0 if the supplied version is strictly greater than the current `package.json` version OR exactly equal to it (re-entrancy contract — the agent's preflight treats equal-to-current as "already bumped, proceed"). Exit 2 for downgrade or invalid SemVer.

When run without `--check`, the script:

1. Reads current `package.json`, `manifest.json`, `versions.json`.
2. Validates the requested version is monotonic (strictly greater than current, or equal — equal is a no-op).
3. Mutates all four files in memory.
4. Writes the four files atomically (each write is a temp-file-plus-rename; if any write fails, the previously-written files are restored from in-memory snapshots).
5. Prints a one-line summary.

The `CHANGELOG.md` mutation prepends a **stub** section (`## [<version>] - YYYY-MM-DD\n\n### Added\n- TODO\n`) immediately above the previous top-most section. The release agent's `changelog-draft` skill detects this stub (string-equality match against the stub template) and offers to replace it; if the section is non-stub, the skill skips, supporting hand-edits.

`versions.json` is the Obsidian-side manifest of plugin version → minimum Obsidian app version. New entries are added with the current `manifest.json` `minAppVersion`. Obsidian uses this to gate which plugin version is offered to which app version.

### Runtime binary fetcher

`src/sdk/BinaryFetcher.ts` is the new module that lets the plugin ship without `copilot.exe` vendored in the Release artifacts. The fetcher:

1. Runs from `src/main.ts:onload()`, deferred to `app.workspace.onLayoutReady` — the deferral matters because the binary download is ~150 MB and Obsidian's "Plugin took too long to load" splash fires on synchronous `onload` work. The pattern is **fire-and-forget**: `onload()` returns immediately after registering the settings tab; the fetch and runtime init complete asynchronously via `completeDeferredInit()`.
2. Calls `detectPlatformTuple()` to compute the platform identifier (Windows x64/arm64, macOS x64/arm64, Linux glibc/musl x64/arm64 — eight tuples plus an "unsupported platform" error path).
3. Checks the `.copilot-binary-version` marker file in the plugin folder. If it matches `PINNED_BINARY_VERSION` (baked at build time), the fetcher short-circuits — no download, no Notice.
4. Otherwise, requests `https://registry.npmjs.org/@github/copilot` for the published metadata, reads `dist.integrity` (sha512) and `dist.tarball` for the pinned version, then streams the tarball to a temp file.
5. Verifies the sha512 against the registry's published value. Mismatch → cleanup + actionable error.
6. Extracts only the platform-specific binary file from the tarball using a streaming tar parser (no full extraction; no JavaScript executed).
7. Renames the extracted binary atomically into the plugin folder as `copilot.exe` (Windows) or `copilot` (Unix).
8. Writes the marker file last so partial-failure states are detectable on the next launch (binary present but marker missing → re-extract).

During the fetch, a single Obsidian Notice surfaces per-chunk progress with throttled updates (≥150 ms between `setMessage` calls to avoid Notice flicker). The success Notice displays for a minimum of 2.5 s before clearing so the maintainer sees confirmation even on fast networks.

### Pinned binary version

`src/sdk/pinnedBinaryVersion.ts` exports a single `PINNED_BINARY_VERSION` constant. It is **generated** by `scripts/generate-pinned-binary-version.mjs`, which reads `node_modules/@github/copilot/package.json` `version` and writes the constant. The generator runs on every:

- `npm install` (via `postinstall`)
- `npm run build` (via `prebuild`)
- `npm run test` (via `pretest`)
- `npm run typecheck` (via `pretypecheck`)

This guarantees the constant is in sync with what npm just installed. The generated file is gitignored. CI regenerates it on every workflow run.

Upgrading the binary requires bumping `@github/copilot-sdk` (or its transitive `@github/copilot` pin) and re-releasing. There is no runtime override — the fetcher uses the build-time constant verbatim.

### Release agent

`.copilot/agents/release/agent.md` defines the agent contract. Six skill files under `.copilot/agents/release/skills/` implement individual steps:

| Skill | Purpose | Re-entrancy |
|-------|---------|-------------|
| `preflight.md` | Environment + repo sanity (clean tree, on `main`, in sync with origin, typecheck, tests, monotonic version) | Pure diagnostic; safe to re-run |
| `version-bump.md` | Run `npm run release:prepare <version>` | Detects already-applied state; skips |
| `changelog-draft.md` | Replace the stubbed CHANGELOG section with real notes from `git log <prev-tag>..HEAD` | Detects non-stub content; skips |
| `tag-and-push.md` | Commit the bump, create annotated tag, push branch + tag | Detects existing commit and tag; skips both |
| `ci-monitor.md` | Watch the workflow run; surface a numbered three-option menu on failure | Re-attaches to existing run if one is in flight |
| `verify.md` | Confirm the published Release has the three assets, correct body, not a draft | Pure read; safe to re-run |

The agent's `--dry-run` mode relaxes preflight's clean-tree and `on-main` checks and replaces every mutating step with a printed plan. CI-monitor and verify are skipped in dry-run. Dry-run preserves the "version not already released" suppression so RC tags can be replayed iteratively.

The agent is **session-portable**: any Copilot CLI session in this repo with the agent loaded can drive a release. The skills shell out to scripts in this repo and to `gh`/`git`/`npm` — no agent-internal state survives between sessions.

### Bootstrap script (one-shot)

`scripts/release/bootstrap-v0.5.0.mjs` is **not part of the normal release pipeline**. It is a one-shot helper used in v0.6's session to retroactively publish a GitHub Release for v0.5.0 (which predates the version-bump tooling). The script:

1. Resolves the full 40-char SHA via `git rev-parse 22f660d` (gh API rejects short SHAs for `target_commitish`).
2. Adds a `git worktree` at the historical commit.
3. Runs `npm ci && npm run build` in the worktree.
4. Reads the worktree's `manifest.json`, synthesizes `{...manifest, version: "0.5.0"}`, copies `main.js` + `styles.css` from the worktree into `<worktree>/release-assets/`, and validates via `validateReleaseAssets` (the same helper used by `assemble-assets.mjs`).
5. Extracts the `[0.5.0]` CHANGELOG section from `main`'s current `CHANGELOG.md`.
6. Appends a historical-completeness notice (synthesized by `buildBootstrapReleaseBody` in `src/release/bootstrapRelease.ts`).
7. Creates an annotated `v0.5.0` tag pointing at the full SHA, pushes the tag, runs `gh release create --target <full-sha>`.
8. Removes the worktree.

The script does asset assembly **inline** rather than chaining `scripts/release/assemble-assets.mjs` from the worktree cwd. `assemble-assets.mjs` resolves its `repoRoot` from `__dirname`, so invoking it with `cwd=worktree` still writes to the source repo and pulls in the source repo's (wrong, tip-of-branch) `main.js`. Inline assembly avoids that.

Pure helpers (`buildBootstrapReleaseBody`, `resolveHistoricalSha`, `buildAssetPaths`, `REQUIRED_RELEASE_ASSETS`, `DEFAULT_HISTORICAL_SHA`) live in `src/release/bootstrapRelease.ts` and are unit-tested in `src/release/bootstrapRelease.test.ts`. The orchestration `.mjs` is not unit-tested — it's exercised end-to-end exactly once and then archived.

## User-Facing Behavior

### First launch via BRAT

1. User installs BRAT, runs **Add a beta plugin for testing**, pastes `ChrisKrawczyk/obsidian-copilot-agent`. BRAT downloads `main.js`, `manifest.json`, `styles.css` from the latest GitHub Release into `<vault>/.obsidian/plugins/obsidian-copilot-agent/`.
2. User enables **Copilot Agent** under **Community plugins**. `onload()` registers the settings tab synchronously.
3. The deferred `completeDeferredInit()` runs once `app.workspace.onLayoutReady` resolves. A "Downloading Copilot CLI binary…" Notice appears with byte/percent progress.
4. After verification + extraction + atomic rename, the success Notice clears (≥2.5 s display).
5. User opens **Settings → Copilot Agent → Connect**. GitHub device-flow OAuth completes.
6. Chat is ready.

### Subsequent launches

Marker file matches `PINNED_BINARY_VERSION` → no Notice, no download. The fetcher's `isInstalled` short-circuit is the SC-007 guarantee that existing developer workflows (with `copilot.exe` already in the plugin folder via `npm run deploy --with-binary`) are unaffected.

### Failure surfaces

The Settings tab's **CLI binary** section reflects the fetcher's current state: `Downloading…` / `Ready (v<pinned>)` / `Failed (<reason>) — Retry`. The Retry button re-invokes the fetcher without requiring a plugin reload. Common failure modes:

- **Offline / DNS error**: actionable message naming `registry.npmjs.org`.
- **Corporate proxy blocking the npm registry**: HTTPS connection refused; same message as above. No sideload UI in v0.6.0.
- **Disk full during extraction**: cleanup runs (temp file deleted; marker not written), so the next launch re-tries cleanly.
- **sha512 mismatch**: extremely rare; the fetcher reports the expected vs actual digest.

## Resilience and Lifecycle

### Atomic guarantees

- **Binary rename is atomic.** The fetcher extracts to a temp file in the plugin folder, then `rename()`s into the final filename. Partial extractions never appear as a usable binary.
- **Marker write is last.** The `.copilot-binary-version` file is written *after* the rename succeeds. If the rename succeeds but the marker write fails, the next launch will re-extract — wasted bandwidth but no broken state.
- **Version-bump is all-or-nothing.** All four file writes happen in memory first; disk writes are temp-file-plus-rename; on any failure, already-written files are restored from in-memory snapshots before the script exits non-zero.

### Idempotent agent re-runs

Every skill detects its own already-applied state:

- `preflight` is pure-diagnostic.
- `version-bump` checks all four files against the requested version before mutating.
- `changelog-draft` checks for stub vs non-stub content via string-equality match against the stub template.
- `tag-and-push` checks `git rev-parse HEAD --verify` for the expected bump message and `git tag -l v<version>` for the tag.
- `ci-monitor` polls `gh run list --workflow=release.yml --branch=main` and re-attaches if found.
- `verify` is pure-read.

Ctrl+C at any point and re-invoke the agent with the same version: the agent walks forward from wherever the previous attempt stopped.

### Bounded partial-download cleanup

The fetcher uses a single temp file in the plugin folder (`copilot.partial`). On any failure path — sha512 mismatch, tar parse error, disk error, network error — the temp file is removed before the error surfaces. There is no orphan-file accumulation across retries.

## Security Posture

### Fetcher

- **HTTPS-only.** The fetcher constructs the URL with `https://registry.npmjs.org/...` literal prefix. No protocol downgrade is possible.
- **Pinned version.** The fetcher uses `PINNED_BINARY_VERSION` (build-time constant) — no `latest` tag resolution, no user-supplied version string.
- **Integrity check.** sha512 is read from the registry's published metadata (`dist.integrity` or `dist.shasum` fallback) and verified against the downloaded tarball before extraction.
- **Binary-extraction-only.** The streaming tar parser extracts a single named binary file and discards every other entry. No JavaScript from the npm package is executed.
- **Plugin-folder-only writes.** Every filesystem write — temp file, extracted binary, marker — targets `<vault>/.obsidian/plugins/obsidian-copilot-agent/`. Path construction never accepts user input.
- **No execution during fetch.** The fetcher does not `child_process.spawn` the binary; it just extracts it. Execution happens later, via the SDK's normal session-start path.

### Release pipeline

- **No PAT.** `release.yml` uses `${{ secrets.GITHUB_TOKEN }}` with `contents: write` only. No long-lived secrets.
- **SHA-pinned actions.** Upgrading `actions/checkout@<sha>`, `actions/setup-node@<sha>`, or `softprops/action-gh-release@<sha>` requires changing the workflow file — protected by the same code review as any other change.
- **No `gh` PAT in CI.** The workflow uses `softprops/action-gh-release`, which reads `GITHUB_TOKEN` from the runner environment.
- **CI cannot push to `main`.** The workflow's only mutation is creating the GitHub Release object; no `git push` runs in CI.

### Release agent

- **No automatic merging.** The agent never opens PRs or merges branches. It operates on `main` and rejects every other branch (except in `--dry-run`).
- **No automatic version selection.** The maintainer always supplies the target version explicitly. The agent never infers from `git log`.
- **No automatic re-tagging.** If a tag already exists locally or on origin, the agent surfaces the state and stops; deleting and recreating is a manual decision.

### Trust chain

See [`RELEASING.md → Trust chain`](../../../RELEASING.md#trust-chain) for the full chain from `package.json` dependency pin to runtime binary.

## See also

- [`README.md`](../../../README.md) — user-facing install via BRAT.
- [`RELEASING.md`](../../../RELEASING.md) — maintainer runbook.
- [`Spec.md`](Spec.md) — the v0.6 functional and non-functional requirements.
- [`ImplementationPlan.md`](ImplementationPlan.md) — phase-by-phase implementation breakdown.
