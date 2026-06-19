# Phase 5 Implementation Review

- **Phase:** 5 — BRAT bootstrap, README install docs, retroactive v0.5.0 publish script, minimum RELEASING.md
- **Commit reviewed:** `fbcc8b0` (against prior `03fc4c3`)
- **Branch:** `feature/packaging-release`
- **Reviewer skill:** `paw-impl-review`
- **Date:** 2026-06-19

## Review Result: PASS

### Summary

All in-scope Phase 5 deliverables are present, well-formed, and align with the plan spec at `ImplementationPlan.md:538-640`. Tests and typecheck are clean. Operational items (live release publishes, smoke test) are correctly deferred per session scope and were not flagged.

### Plan Completeness Check

Built from `ImplementationPlan.md` lines 538–640. In-scope deliverables for Phase 5 (commit-side, not operational):

| Plan item | Required content | Status |
| --- | --- | --- |
| README "Install via BRAT" section | intro naming BRAT + v0.6.0 first release; 4-step install; first-launch Notice + OAuth; platform matrix with macOS/Linux marked "alpha"; npm-registry/desktop-only limitations; SmartScreen/Gatekeeper note | ✅ `README.md:105-135` covers every required bullet, including the platform matrix as a table and an explicit "alpha — please report issues" label for macOS + both Linux variants. |
| README status sentence replaced | replace "Not yet packaged for distribution." with BRAT/current-state language | ✅ `README.md:5` now reads "v0.6 — First release distributed via BRAT…" with macOS/Linux alpha caveat. |
| `RELEASING.md` minimum runbook | quick start ("ask the release agent"), CLI fallback recipe, eight-step BRAT smoke test, pointer to Phase 6 expansion | ✅ `RELEASING.md` lines 8–43 cover quick start + CLI fallback + the eight numbered smoke-test steps verbatim with the Windows-only caveat. Phase 6 pointer at line 49+. |
| `scripts/release/bootstrap-v0.5.0.mjs` | preflight (clean tree, gh auth), worktree at v0.5.0 sha, npm ci+build, `assemble-assets.mjs --bootstrap`, extract-release-notes, annotated tag + push, `gh release create --target <sha>`, cleanup, `--dry-run`, `--sha`, `--worktree` flags | ✅ All nine plan steps implemented in order at lines 101–195. `--dry-run`, `--sha`, `--worktree`, `--help` parsed at lines 61–82. Cleanup uses `allowFailure: true` for the worktree remove (sensible). |
| `src/release/bootstrapRelease.ts` pure helpers | helpers extracted for unit testing | ✅ Exports `DEFAULT_HISTORICAL_SHA`, `REQUIRED_RELEASE_ASSETS`, `buildBootstrapReleaseBody`, `resolveHistoricalSha`, `buildAssetPaths`. All free of I/O. |
| `src/release/bootstrapRelease.test.ts` | unit tests for the helpers | ✅ 10 cases covering asset invariant, path joining, body assembly + trimming + type guards + determinism, sha defaulting + normalization + validation + type guard. |
| `package.json` script alias | `release:bootstrap-v0.5.0` → `tsx scripts/release/bootstrap-v0.5.0.mjs` | ✅ `package.json:21`. |
| ImplementationPlan checkbox | Phase 5 marked `[x]` | ✅ |

No gaps. The script also correctly relies on Phase 3's `assemble-assets.mjs --bootstrap` mode (verified present at `scripts/release/assemble-assets.mjs:48`) and the existing `extract-release-notes.mjs` CLI (verified present), and there is a `## [0.5.0] - 2026-06-18` section in the current `CHANGELOG.md` that the script will pick up.

### Out-of-Scope (Per Session Brief — Not Flagged)

Deliberately deferred operational items, called out in the implementation brief and `RELEASING.md`:

- Actually executing `bootstrap-v0.5.0.mjs` to publish the v0.5.0 GitHub Release.
- Cutting `v0.6.0-rc.1` and running the eight-step Windows BRAT smoke test.
- Cutting the final `v0.6.0` after the smoke test.

These are maintainer-only because they mutate the live GitHub Releases page and require an Obsidian vault. Per the brief, they are intentionally outside this PR.

### Tests

- **Status:** PASS
- `npm test` → 72 files, 1107/1107 passing (includes the 10 new `bootstrapRelease.test.ts` cases).
- `npm run typecheck` → clean (`tsc --noEmit`).
- Bootstrap script `--help` parses cleanly (confirmed previously).

### Project Instruction Adherence

Checked `.github/copilot-instructions.md` (custom instructions surfaced in session). Relevant rules:

- **Deploy-after-source-edit invariant:** Phase 5 changes are docs + a one-shot orchestration script + pure helpers. No `src/` files that affect plugin runtime were modified. The vault `main.js` deploy step is not required for this phase.
- **No comments on obvious code:** Helpers in `src/release/bootstrapRelease.ts` carry a single doc block; inline code is uncommented. Compliant.
- **TypeScript strict / `tsc --noEmit` clean:** Verified.

No instruction violations.

### Code Quality Observations (Non-Blocking)

1. `bootstrap-v0.5.0.mjs:198-200` — the "is this script being run directly" guard uses two heuristics OR'd together. On Windows the `file://` form normalization can be tricky; the `endsWith("bootstrap-v0.5.0.mjs")` fallback makes this robust in practice. Not a blocker — script is invoked via `npm run release:bootstrap-v0.5.0` (tsx) and the entrypoint check fires correctly.
2. `bootstrap-v0.5.0.mjs:142-145` — `existsSync(worktree)` check is bypassed in `--dry-run`. That is acceptable because dry-run is intentionally non-mutating and merely echoes commands.
3. `buildAssetPaths` (`bootstrapRelease.ts:42-46`) infers the path separator from the input string. The unit test covers a POSIX-style input; the runtime caller passes `join(worktree, "release-assets")` which yields native separators on Windows. Behavior is correct on both, but a future cleanup could just always use `path.join`. Non-blocking.
4. `bootstrap-v0.5.0.mjs` performs `gh auth status` in preflight but does not assert which account is selected. The Phase 6 expansion of `RELEASING.md` (per its "Two-`gh`-account note") will document this; not in scope for Phase 5.
5. `RELEASING.md` references `Spec.md SC-003 (relaxed)` via a `.paw/work/...` relative link. That path is committed in this repo, so the link resolves on GitHub.

None of the above warrant a rework. Worth a glance during the human PR review if anyone cares about polish.

### Commits Made During Review

None. No defects warranted edits.

### Notes for Human PR Reviewer

- The bootstrap script is one-shot: after v0.5.0 is published it will refuse to re-run because the worktree path will exist (line 143) and `gh release create` will fail with a duplicate tag. That is desirable.
- Per the plan, the `--bootstrap` flag on `assemble-assets.mjs` is what synthesizes a `manifest.json` with `version: 0.5.0` from the source manifest. The bootstrap script invokes it correctly with `cwd: worktree` so the staged `release-assets/` lands in the worktree, not the repo root.
- The "historical completeness" notice is centralized in `bootstrapRelease.ts:16-21` and appended in `buildBootstrapReleaseBody`, matching plan line 600 verbatim in intent.

## Verdict

**PASS** — Phase 5 in-scope work is complete, tests + typecheck are green, and project conventions are honored. Operational follow-ups remain for the maintainer as documented.
