# 0002 — Packaging and release for community distribution

**Status:** Draft
**Created:** 2026-06-18
**Owner:** unassigned

## Problem

The plugin is currently install-by-clone: `npm install && npm run deploy`
copies build artifacts into a vault folder configured via `.deploy-target`
or `OBSIDIAN_PLUGIN_DIR`. Distribution to non-developer users requires:

- A reproducible release artifact (zip or GitHub Release) containing
  exactly `main.js`, `manifest.json`, `styles.css`, and the bundled
  `copilot.exe` (~150 MB) per platform.
- A version-bump workflow that keeps `manifest.json`, `package.json`,
  `CHANGELOG.md`, and the git tag in lockstep.
- Either BRAT compatibility (for beta users) or Community Plugins
  submission (for general availability), or both.

README already flags "Not yet packaged for distribution" as a v0.5 gap.

## Sketch

### Phase A — Reproducible local release

1. `npm run release -- <version>` script that:
   - Bumps `package.json` and `manifest.json` versions in lockstep
     (Obsidian's `version-bump.mjs` pattern from the official sample
     plugin).
   - Updates `versions.json` (Obsidian-required min-app-version map).
   - Runs `npm test && npm run typecheck && npm run build`.
   - Stages the bump commit and creates an annotated git tag.
2. GitHub Actions workflow on tag push: produces a release with
   `main.js`, `manifest.json`, `styles.css`, and per-platform
   `copilot-<plat>.exe` attachments.
3. CHANGELOG entry generated from the squash-merge messages between tags
   (or hand-written; this plugin's commit messages are already detailed).

### Phase B — BRAT distribution

- Add the repo to BRAT (Beta Reviewers Auto-update Tool). BRAT installs
  any tagged release, no community-plugins approval needed.
- Document install: `BRAT → Add Beta Plugin → ChrisKrawczyk/obsidian-copilot-agent`.
- Bumps go live as soon as the GitHub Release publishes.

### Phase C — Community Plugins submission (optional, later)

- Open a PR against `obsidianmd/obsidian-releases` adding the plugin to
  `community-plugins.json`.
- Requires: passing review for security (we bundle a 150 MB native binary
  — likely a blocker for community plugins), accessibility, and code
  conventions. Realistic only if we split the CLI binary out (see
  "Why a separate CLI binary?" in README) or move to a hosted backend.

## Risks

- **Binary size.** GitHub Releases caps individual file size at 2 GB and
  total release at... a lot, so we're fine for hosting. But cloning the
  release per user is heavy. May want per-platform releases (Windows-only
  to start; macOS/Linux when we have a copilot.exe build for them).
- **Community Plugins gatekeeping.** Bundled binaries are explicitly
  discouraged. Plan for BRAT as the primary distribution channel.
- **Token re-auth on update.** Verify the OAuth-stored token survives
  binary swap. If not, document re-login as a release-note step.
- **Vault-state migrations.** Each release must run cleanly against the
  previous release's `data.json` shape. Add a `migrations` smoke test
  per release.

## Open questions

- Do we want signed Windows binaries? Defender SmartScreen will flag an
  unsigned `copilot.exe` on first run.
- macOS support — when? Without it we can't realistically be a Community
  Plugin (cross-platform is implicitly required).
- Should manifest `id` change from `obsidian-copilot-agent` (current dev
  name) to something user-facing before any public release? Changing
  later breaks vault upgrades for early adopters.

## References

- README: "Why a separate CLI binary?" section
- README: "Status: Not yet packaged for distribution."
- Obsidian sample plugin: https://github.com/obsidianmd/obsidian-sample-plugin
- BRAT: https://github.com/TfTHacker/obsidian42-brat
- Community Plugins submission process:
  https://docs.obsidian.md/Plugins/Releasing/Submission+requirements+for+plugins
