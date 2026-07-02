# Releasing obsidian-copilot-agent

Comprehensive maintainer runbook for cutting a release of this plugin. Distribution is via [BRAT](https://github.com/TfTHacker/obsidian42-brat) — see `README.md` for the user-facing install procedure.

## Quick start (agent-driven)

Start a Copilot CLI session in this repo and ask the release agent:

> release v\<version\>

The agent at [`.copilot/agents/release/`](.copilot/agents/release/) runs preflight → version-bump → CHANGELOG draft → tag-and-push → CI monitor → verify in order. It is re-entrant — Ctrl+C between steps and re-invoke with the same version; each skill detects already-applied state and skips.

For a dry run on a feature branch (does not push, does not tag):

> dry-run release v\<version\>

Or invoke the agent with `--dry-run`. Dry-run relaxes the clean-tree and `on-main` preflight checks; everything else (typecheck, tests, monotonic version) still runs.

## Manual CLI fallback

For when the release agent is unavailable or you want to script the flow:

```sh
# 1. Mutate the four files atomically (package.json, manifest.json, versions.json, CHANGELOG.md):
npm run release:prepare <version>

# 2. Edit CHANGELOG.md to replace the stubbed section with real release notes:
$EDITOR CHANGELOG.md

# 3. Commit:
git add package.json manifest.json versions.json CHANGELOG.md
git commit -m "chore(release): v<version>"

# 4. Annotated tag with the extracted release notes as the message:
npm run --silent changelog:extract -- <version> > .release-notes.tmp
git tag --annotate v<version> --file .release-notes.tmp
rm .release-notes.tmp

# 5. Push branch and tag:
git push origin main
git push origin v<version>          # triggers .github/workflows/release.yml
```

Watch the workflow run with `gh run watch` and verify with `gh release view v<version>` once it completes.

## Prerequisites

Every release run, agent or manual, assumes:

- **Clean working tree** on `main` (`git status --porcelain` empty).
- **In sync with `origin/main`** (neither ahead nor behind).
- **Node 20+** installed (matches CI's `actions/setup-node`).
- **`gh` CLI authenticated** against an account with `Contents: write` permission on this repo. Run `gh auth status` to confirm the active account is correct — multiple accounts in the keyring are common (e.g. work + personal). Switch with `gh auth switch --user <name>` if needed.
- **`npm test` passing** and `npm run typecheck` clean. The preflight skill rejects the release otherwise.

## Step-by-step (agent walkthrough)

Mirror of the "cut v0.6.0" sequence, with the actions surfaced by each skill called out so a fresh reader can follow along:

1. **preflight** — `git status --porcelain`, `git rev-parse --abbrev-ref HEAD` (must be `main`), `git fetch origin main` + commit-count comparison (must be exactly in sync — local-behind AND local-ahead are both hard blocks), `npm run typecheck`, `npm test`, `npm run version-bump -- --check <version>`. The version-bump check exits 0 for strictly-greater versions AND for equal-to-current (re-entrancy contract: re-running the agent after a partial bump is a no-op).
2. **version-bump** — `npm run release:prepare <version>` mutates `package.json` `version`, `manifest.json` `version`, adds a `<version>` entry to `versions.json` mapping to `manifest.json`'s `minAppVersion`, and prepends a stubbed `## [<version>] - YYYY-MM-DD` section to `CHANGELOG.md`. Skips when all four files already match the target.
3. **changelog-draft** — Walks the maintainer through replacing the stub with a real entry, populated from `git log <prev-tag>..HEAD --pretty="%s%n%b"`. The skill detects an already-filled (non-stub) section and skips. Hand-edit at this point if the auto-draft needs tweaks.
4. **tag-and-push** — Commits the four mutated files (`chore(release): v<version>`), creates the annotated tag `v<version>` with the extracted CHANGELOG section as the tag message, pushes `main`, pushes the tag. Detects existing release commit and existing tag, skips both if present.
5. **ci-monitor** — Polls the workflow run triggered by the tag push (`gh run list --workflow=release.yml`). On failure, surfaces a numbered three-option menu: (a) view the run logs, (b) delete the remote tag and start over, (c) leave state as-is and inspect manually. Re-attaches to an existing run if re-entered mid-flight.
6. **verify** — `gh release view v<version> --json assets,body,isDraft,isPrerelease`. Asserts the three required assets (`main.js`, `manifest.json`, `styles.css`), that `body` matches the CHANGELOG section verbatim, that `isDraft` is `false`, and that `isPrerelease` matches the SemVer (prerelease iff the version contains a `-`).

After verify reports OK, the Release is live.

## CHANGELOG format

The repo follows a loose Keep-a-Changelog convention:

```
## [0.6.0] - 2026-06-19

### Added
- New feature description.

### Changed
- Existing behavior modification.

### Fixed
- Bug fix description.

### Security
- Security-relevant change.

### Migration
- User-facing migration steps if any.

### Dependencies
- Direct or transitive dependency updates worth surfacing.

### Bundle Size
- Build-output size delta when meaningful.

### Tests
- Test-count delta and significant suite additions.
```

Sub-sections are optional — omit any that don't apply. The order above is the convention. Date format is `YYYY-MM-DD`. The `## [<version>]` line is the section header the extract script matches against; do not reformat it.

## Recovery procedures

### Dirty working tree at preflight

Preflight halts and prints the offending files. Either commit them (often a leftover `release-assets/` dir or an unstaged `package.json` from a partial bump) or stash. If the dirty file is `release-assets/`, it is safe to delete — `assemble-assets.mjs` regenerates it on the next run.

### Local branch is ahead of `origin/main` (unpushed commits)

Preflight halts with "local is ahead of origin". This is a hard block: the release would otherwise quietly publish unreviewed commits along with the bump. Push (`git push`) or reset (`git reset --hard origin/main` — destructive) before retrying.

### Failed CI workflow run

The `ci-monitor` skill offers three options:

1. **View logs** — opens the run page; fix the issue locally, push to `main` (without a new tag), and re-trigger by manually re-running the workflow via `gh run rerun <run-id>` or by deleting + re-pushing the tag.
2. **Delete the remote tag** — `git push --delete origin v<version>` + `git tag -d v<version>`. The Release object created by the failed run will be left as a draft on the Releases page; delete it via the GitHub UI or `gh release delete v<version>`. Start the agent over from preflight.
3. **Leave as-is** — for cases where the workflow partially succeeded (e.g. uploaded one asset and failed on the second). Inspect manually with `gh release view v<version>`, fix what's wrong via `gh release upload`/`gh release edit`, and run `verify` independently.

### Accidentally tagged from a non-`main` branch

Preflight should have caught this. If the tag landed anyway (e.g. via the manual fallback):

1. Delete the bad tag locally and remotely: `git push --delete origin v<version>` + `git tag -d v<version>`.
2. Delete the GitHub Release if one was created: `gh release delete v<version>`.
3. Switch to `main`, pull, and re-run the agent. The version-bump check will recognize the in-progress state as a no-op and the agent will re-create the tag from the correct branch.

### Partial state mid-bump

If the agent is interrupted between version-bump and tag-and-push, the four files (`package.json`, `manifest.json`, `versions.json`, `CHANGELOG.md`) are mutated locally but the commit and tag don't exist yet. Run `npm run release:status -- --version <version>` to see the per-file/per-tag state. Re-invoking the agent with the same version is safe — each skill detects already-applied state and skips. If you want to abandon the bump entirely, `git restore` the four files and start over.

### Stale workflow run prevents re-tagging

`gh workflow disable release.yml` + `gh workflow enable release.yml` flushes any stuck queue. The workflow has no concurrency group set, so re-runs on the same tag are accepted.

## Trust chain

The plugin embeds platform-specific Copilot CLI binaries via a runtime fetcher (`src/sdk/BinaryFetcher.ts`) rather than vendoring them in the repo or the Release artifacts. The trust chain:

1. **Build-time pin.** `scripts/generate-pinned-binary-version.mjs` (run on every `postinstall`, `prebuild`, `pretest`, `pretypecheck`) writes the installed `@github/copilot` version into `src/sdk/pinnedBinaryVersion.ts`. The fetcher uses this constant — there is no `latest` tag resolution at runtime.
2. **Source of truth.** `@github/copilot` is a transitive dependency of `@github/copilot-sdk@1.0.0` (exact-pinned in `package.json`). Upgrading the binary version requires bumping `@github/copilot-sdk` (or its transitive `@github/copilot` pin), running `npm install`, verifying the regenerated `src/sdk/pinnedBinaryVersion.ts`, and re-releasing.
3. **Fetch.** First-launch fetch hits `https://registry.npmjs.org/@github/copilot/-/copilot-<version>.tgz`. HTTPS-only; the URL is constructed without user input.
4. **Integrity.** The fetcher requests the package manifest from the registry, extracts the published sha512 from `dist.integrity` (or `dist.shasum` fallback), and verifies the downloaded tarball matches before extracting.
5. **Extraction.** Only the platform-specific binary file is extracted (e.g. `copilot-win32-x64.exe`); no JavaScript from the npm package is executed. The binary is renamed atomically to `copilot.exe`/`copilot` inside the plugin folder.
6. **Marker.** A `.copilot-binary-version` file in the plugin folder records the installed version. On subsequent launches the fetcher short-circuits if the marker matches `PINNED_BINARY_VERSION`.

Consequences of breaking the chain:

- If `@github/copilot-sdk` is upgraded but the generated pinned-version file isn't regenerated, runtime and build pin will diverge. `npm install`'s `postinstall` hook prevents this in normal flows.
- If `registry.npmjs.org` is blocked by a corporate proxy, the fetcher fails with an actionable error. There is no sideload UI in v0.6.0 (deferred as a Phase Candidate).
- If the upstream `@github/copilot` package were ever compromised, the sha512 check would still pass (it's the registry's own integrity hash) — this gate protects against in-transit corruption, not supply-chain compromise.

## Smoke-test procedure (mandatory before tagging the stable release)

`v0.6.0` and later versions ship through BRAT, which can only install from a published GitHub Release. The "smoke test before tagging" requirement is honored literally: tag a release-candidate first (`v<version>-rc.1`), smoke-test the published `-rc.N` artifact, and only then tag the stable `v<version>`. RC tags can be deleted from the Releases page after the stable release is cut (cosmetic cleanup).

Per relaxed SC-003, **manual smoke is Windows-only**. macOS and Linux ship as "alpha — please report issues" and are covered by unit tests on `BinaryFetcher.detectPlatformTuple` (all eight platform tuples plus the unsupported-platform error path).

### Eight-step procedure (Windows)

1. **Clean vault.** Create a fresh Obsidian vault — no prior install of this plugin in any form, no leftover plugin folder.
2. **Install BRAT.** In **Settings → Community plugins**, install and enable **BRAT** from the catalog.
3. **Add the beta plugin.** Command palette → **BRAT: Add a beta plugin for testing** → paste `ChrisKrawczyk/obsidian-copilot-agent` → confirm. BRAT picks up the latest pre-release when an RC tag is present.
4. **Verify assets.** Confirm `<vault>\.obsidian\plugins\obsidian-copilot-agent\` contains exactly `main.js`, `manifest.json`, `styles.css` — and no extra files.
5. **Enable and watch the download.** **Community plugins → Copilot Agent → enable**. Observe the "Downloading Copilot CLI binary…" Notice with byte/percent progress. Wait for the success message to clear (~2.5 s display window).
6. **OAuth device flow.** **Settings → Copilot Agent → Connect**. Complete the GitHub device-flow sign-in.
7. **Chat exchange.** Open the chat pane (bot ribbon icon, left sidebar). Send "What time is it?" and verify a streamed response.
8. **Reload check.** Command palette → **Reload app without saving** (or toggle the plugin off + on). Confirm the binary is **not** re-downloaded — the `.copilot-binary-version` marker and cached binary persist across reloads.

Record the pass/fail in `## Smoke-test history` below before cutting the stable release.

## Smoke-test history

| Version | Platform | Date (UTC) | Result | Notes |
|---------|----------|------------|--------|-------|
| _populated as releases ship_ | | | | |

## Two-`gh`-account note

`gh` allows multiple authenticated accounts in its keyring at once. The active account is the one used for every `gh ...` call, including those invoked by the release agent. Common pitfalls:

- Repo write permission lives on one account (typically your personal account), but `gh auth status` shows another as active. The release agent's `tag-and-push` step will fail at `gh release create` with HTTP 403 or 422.
- After `gh auth switch --user <name>`, every shell on the machine sees the switch — the keyring is global. There is no per-shell or per-directory binding.

Always run `gh auth status` immediately before invoking the release agent. The agent does not switch accounts on your behalf.

## Dry-run mode

Dry-run is for exercising the agent on a feature branch without touching `origin`:

- Preflight relaxes the clean-tree and `on-main` checks (everything else still runs).
- Version-bump writes the four mutated files locally but does not commit.
- Tag-and-push replaces every `git commit`, `git tag`, `git push` with a printed plan describing what would happen. Nothing is mutated on disk or pushed.
- CI-monitor and verify are skipped with a "skipped — dry run" notice (they have nothing to watch).
- The "version not already released" check is suppressed so an RC tag can be replayed iteratively.

Trigger via any of: `--dry-run`, "dry run", "dry-run release v…", "what would happen if I released v…". When starting fresh on a feature branch, always confirm with the maintainer whether dry-run is wanted before the agent's first action.

## v0.5.0 reproducibility note

`v0.5.0` is published for historical completeness so the tag resolves to a GitHub Release. It predates the in-plugin binary fetcher and BRAT install path shipped in v0.6.0. First-time BRAT users should pin v0.6.0 or later.

The `v0.5.0` Release is **not bit-reproducible** from the v0.5.0 source manifest alone. The published `manifest.json` carries `"version": "0.5.0"` (synthesized from the historical `manifest.json` at commit `22f660d`, which still read `"version": "0.1.0"` because version-bump tooling did not exist yet) plus the historical `main.js` built from `22f660d`. The synthesis is performed by [`scripts/release/bootstrap-v0.5.0.mjs`](scripts/release/bootstrap-v0.5.0.mjs), which:

1. Adds a `git worktree` at `22f660d`.
2. Runs `npm ci && npm run build` in the worktree.
3. Reads the worktree's `manifest.json`, synthesizes `{...manifest, version: "0.5.0"}`, copies `main.js` + `styles.css` from the worktree, and writes the trio into `<worktree>/release-assets/`.
4. Extracts the `[0.5.0]` CHANGELOG section from `main`'s current `CHANGELOG.md` (the worktree's predates the format).
5. Appends a historical-completeness notice, creates an annotated `v0.5.0` tag pointing at `22f660d`, pushes the tag, and `gh release create --target <full-sha>`.

The script is idempotent on partial state. It is **not** the model for future releases — `v0.6.0` onward use the normal `.github/workflows/release.yml` pipeline.

### Gotchas captured during the v0.5.0 bootstrap run

- `gh release create --target <sha>` requires the **full 40-char SHA**; short SHAs are rejected with HTTP 422 "Release.target_commitish is invalid". The bootstrap script resolves the full sha via `git rev-parse` up front.
- On Windows, `child_process.execFileSync` cannot spawn `.cmd` files (`npx.cmd`, `npm.cmd`) without `shell: true`. Node throws `spawnSync EINVAL` otherwise. The bootstrap script and any other release-side helpers that shell out to npm/npx pass `shell: process.platform === "win32"`.
- `scripts/release/assemble-assets.mjs` resolves its `repoRoot` from `__dirname`, so invoking it from a worktree's `cwd` still writes to the source repo. The bootstrap script does asset assembly inline (via `validateReleaseAssets`) rather than chaining `assemble-assets`. The `release.yml` workflow never hits this issue because it runs in the source repo.

## See also

- [`README.md`](README.md) — user-facing install via BRAT, supported platforms, known limitations.
- [`.paw/work/packaging-release/Docs.md`](.paw/work/packaging-release/Docs.md) — technical reference for the binary fetcher, release pipeline, and agent architecture.
- [`.copilot/agents/release/`](.copilot/agents/release/) — the release agent and skills.
- [`scripts/release/`](scripts/release/) — `version-bump.mjs`, `assemble-assets.mjs`, `extract-release-notes.mjs`, `status.mjs`, `bootstrap-v0.5.0.mjs`.
- [`.github/workflows/release.yml`](.github/workflows/release.yml) — the tag-triggered GitHub Actions workflow.
