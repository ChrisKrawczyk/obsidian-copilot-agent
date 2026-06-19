# WorkflowContext

Work Title: Packaging and Release
Work ID: packaging-release
Base Branch: main
Target Branch: feature/packaging-release
Execution Mode: current-checkout
Repository Identity: none
Execution Binding: none
Workflow Mode: full
Review Strategy: local
Review Policy: milestones
Session Policy: continuous
Final Agent Review: enabled
Final Review Mode: multi-model
Final Review Interactive: smart
Final Review Models: gpt-5.4, gemini-3.1-pro-preview, claude-opus-4.7
Final Review Specialists: all
Final Review Interaction Mode: parallel
Final Review Specialist Models: none
Final Review Perspectives: auto
Final Review Perspective Cap: 2
Implementation Model: none
Plan Generation Mode: multi-model
Plan Generation Models: gpt-5.4, gemini-3.1-pro-preview, claude-opus-4.7
Planning Docs Review: enabled
Planning Review Mode: multi-model
Planning Review Interactive: smart
Planning Review Models: gpt-5.4, gemini-3.1-pro-preview, claude-opus-4.7
Planning Review Specialists: all
Planning Review Interaction Mode: parallel
Planning Review Specialist Models: none
Planning Review Perspectives: auto
Planning Review Perspective Cap: 2
Custom Workflow Instructions: none
Initial Prompt: Implement Phase A + Phase B of proposal `proposals/0002-packaging-release.md`. Phase C (Community Plugins catalog submission) is explicitly **out of scope** for this workflow.

**Phase A — Reproducible release tooling and CI**

1. **Version-bump script.** Add `scripts/version-bump.mjs` (referenced as `npm version` hook or `npm run release`) that keeps `package.json`, `manifest.json`, and a new top-level `versions.json` (Obsidian min-app-version map) in lockstep. Mirrors the pattern used by `obsidian-sample-plugin`.
2. **GitHub Actions release workflow.** Triggered on tag push (`v*`). Steps: checkout, setup Node, `npm ci`, `npm run build` (production esbuild → `main.js`), assemble release artifacts, create a GitHub Release whose assets include `main.js`, `manifest.json`, and `styles.css` at the **release root** (BRAT requirement — they cannot live inside a zip or subfolder).
3. **`copilot.exe` handling.** The bundled `@github/copilot-sdk` native binary (~150 MB, currently Windows-only) is NOT bundled into the GitHub Release assets in this iteration. The release ships the plugin code; users obtain the binary via `npm install` at dev time, or via a documented post-install step. Document this clearly in the release notes template and README. (A future workflow will tackle multi-platform binary distribution.)
4. **CI baseline.** The release workflow runs `npm run typecheck` and `npm test` before building to ensure the tag commit is green.

**Phase B — BRAT compatibility and user-facing install path**

5. **Manifest hygiene.** Audit `manifest.json` for BRAT/Obsidian compliance: valid `id`, `name`, `version`, `minAppVersion`, `description`, `author`, `authorUrl`, `isDesktopOnly: true` (we are desktop-only because of the native CLI), `fundingUrl` optional.
6. **`versions.json`.** Top-level file mapping plugin version → minimum Obsidian app version. Updated by the version-bump script.
7. **README install section.** Add a "Install via BRAT" section with step-by-step instructions:
   - Install BRAT from Community Plugins
   - Add beta plugin → enter `ChrisKrawczyk/obsidian-copilot-agent`
   - Note Windows-only limitation and how to obtain `copilot.exe`
   - Note that this is pre-release / beta software
8. **Smoke test against BRAT.** Verify the released artifacts can actually be installed via BRAT into a clean test vault (manual test step documented in the spec acceptance criteria).

**Constraints carried from v0.5:**

- 968/968 baseline test coverage must hold; new scripts get unit tests where practical (version-bump pure-function helpers).
- No regression to `npm run deploy`, `npm run build`, `npm run dev`, or any existing developer workflow.
- `copilot-instructions.md` deploy guidance remains accurate.
- README status line ("Not yet packaged for distribution.") is updated to reflect the new BRAT install path once shipped.

**Out of scope (deferred):**

- Submission to the official Obsidian Community Plugins catalog (Phase C).
- Multi-platform `copilot.exe` distribution (macOS / Linux native binaries).
- Auto-update mechanics beyond what BRAT provides.
- Code signing of the native binary.
- Telemetry / install analytics.

Issue URL: none
Remote: origin
Artifact Lifecycle: commit-and-persist
Artifact Paths: auto-derived
Additional Inputs: none
