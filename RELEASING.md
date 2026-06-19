# Releasing obsidian-copilot-agent

> **Status:** v0.6.0 minimum runbook. The comprehensive maintainer
> doc (recovery procedures, CHANGELOG conventions, trust-chain
> details, agent walkthrough, dry-run usage) is finalized in
> Phase 6 of the `packaging-release` work.

## Quick start

Ask the Copilot CLI release agent:

> release v\<version\>

The agent (defined under [`.copilot/agents/release/`](.copilot/agents/release/)) walks the full sequence: preflight → version-bump → CHANGELOG draft → tag-and-push → CI monitor → verify.

### CLI fallback (no agent)

```sh
npm run release:prepare <version>          # mutates package.json, manifest.json, versions.json, CHANGELOG.md
# inspect git diff, edit CHANGELOG.md to fill in the new section
git add package.json manifest.json versions.json CHANGELOG.md
git commit -m "chore(release): v<version>"
npm run changelog:extract -- <version> | git tag --annotate v<version> --file -
git push origin main
git push origin v<version>                 # triggers .github/workflows/release.yml
```

## BRAT smoke-test procedure (mandatory before tagging the stable release)

`v0.6.0` ships through BRAT, which can only install from a published GitHub Release. To honor the "smoke test before tagging" requirement literally, the release flow tags a release-candidate first, smoke-tests the published `v<version>-rc.N` artifact, and only then tags the stable `v<version>`.

Per [`Spec.md` SC-003 (relaxed)](.paw/work/packaging-release/Spec.md), manual smoke testing for v0.6.0 is **Windows-only**. macOS and Linux ship as "alpha — please report issues" and are covered by unit tests on `BinaryFetcher.detectPlatformTuple` (all eight platform tuples plus the unsupported-platform error path).

### Eight-step procedure (Windows)

1. **Clean vault.** Spin up a fresh Obsidian vault — no prior install of this plugin in any form, no leftover plugin folder.
2. **Install BRAT.** In **Settings → Community plugins**, install and enable **BRAT** from the catalog.
3. **Add the beta plugin.** Command palette → **BRAT: Add a beta plugin for testing** → paste `ChrisKrawczyk/obsidian-copilot-agent` → confirm. If smoke-testing an RC, paste the same repo and BRAT will pick up the latest pre-release.
4. **Verify assets.** Wait for BRAT to fetch assets. Confirm the vault plugin folder (`<vault>/.obsidian/plugins/obsidian-copilot-agent/`) contains exactly `main.js`, `manifest.json`, `styles.css` — and no extra files. Anything else means the release-assets pipeline regressed.
5. **Enable and watch the download.** **Settings → Community plugins → Copilot Agent → enable**. Observe the "Downloading Copilot CLI binary…" Notice. Wait for the progress to reach 100% and the success message to clear (~2.5 s display window).
6. **OAuth device flow.** **Settings → Copilot Agent → Connect**. Complete the GitHub device-flow sign-in.
7. **Chat exchange.** Open the chat pane (bot ribbon icon, left sidebar). Send a short message such as "What time is it?" and verify a streamed response.
8. **Reload check.** Command palette → **Reload app without saving** (or toggle the plugin off + on in **Community plugins**). Observe that the binary is **not** re-downloaded — the marker file (`.copilot-binary-version`) and cached binary persist across reloads.

### Recording smoke-test results

After each smoke-test pass, append a short entry to this file under `## Smoke test history` (added in Phase 6) noting: version tested, platform, date (UTC), pass/fail, brief notes. RC tags are deleted from the GitHub Releases page after the stable release is cut (cosmetic cleanup, not required).

## See also (Phase 6)

The Phase 6 expansion of this document covers, in addition to the above:

- **Recovery procedures** — dirty tree, failed CI workflow run, accidentally-tagged from a non-`main` branch, partial state mid-bump.
- **CHANGELOG format** — the loose Keep-a-Changelog convention (`### Added/Changed/Fixed/Security/Migration/Dependencies/Bundle Size/Tests` sub-sections).
- **Trust-chain documentation** — how `PINNED_BINARY_VERSION` is baked at build time, sha512 verification, binary-only extraction, the consequences of upgrading `@github/copilot-sdk`.
- **Two-`gh`-account note** — the release agent uses whichever `gh` account is currently selected via `gh auth switch`.
- **Dry-run mode** — how to invoke the release agent with `--dry-run` to exercise the full flow on a feature branch without mutating the remote.
- **v0.5.0 reproducibility note** — v0.5.0 was published retroactively via `scripts/release/bootstrap-v0.5.0.mjs` from a tip-of-main manifest hygiene synthesis; this is not reproducible from the v0.5.0 source manifest alone.
