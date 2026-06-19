## Review Result: BLOCKED

### Summary
Phase 3 is broadly implemented and automated checks pass, but review found security/correctness gaps that need Implementer rework before the phase can pass.

### Tests
- Status: PASS
- `npm test` passed: 69 files, 1085 tests.
- `npm run typecheck` passed.
- `npm run build` passed.
- Release script spot checks passed/failed as expected:
  - `npx tsx scripts\release\assemble-assets.mjs 0.6.0 --dry-run` exited 1 with manifest-version and missing-versions.json-entry errors.
  - `npx tsx scripts\release\assemble-assets.mjs 0.5.0 --bootstrap --dry-run` exited 0.
  - `npm run changelog:extract -- 0.5.0` exited 0 and printed the v0.5.0 section.
  - `npm run changelog:extract -- 99.9.9` exited 1 with the expected "No section found" error.
- YAML parser availability check: neither `js-yaml` nor `yaml` is available locally, so the Phase 3 escape clause applies.

### Commits Made
- None. Per the review request, no source code was modified.

### Issues Found
1. **Unsafe GitHub Actions expression interpolation in shell commands.** `.github/workflows/release.yml:62-66` interpolates `${{ steps.tagver.outputs.version }}` directly into `run:` shell lines. The value is derived from the pushed tag name, and tag/ref names should not be treated as trusted shell syntax; shell metacharacters in a matching `v*` tag could alter the command. This violates the Phase 3 review constraint to ensure no unsafe shell interpolation in the workflow. Required fix: pass the expression through an environment variable and quote the shell variable, e.g. `env: RELEASE_VERSION: ${{ steps.tagver.outputs.version }}` plus `run: npm run release:assemble -- "$RELEASE_VERSION"` and similarly for `changelog:extract`.

2. **Bootstrap mode can mask an invalid source manifest shape.** `scripts/release/assemble-assets.mjs:136-143` synthesizes a staged manifest whenever `bootstrap && manifest && manifest.version !== version`, then validates `stagedManifest` at `scripts/release/assemble-assets.mjs:147-153`. If the source `manifest.json` is an object with no string `version` field, or even a truthy non-object JSON value, the script can synthesize a valid-looking manifest and pass validation. That conflicts with the Phase 3/C7 requirement that bootstrap relaxes version mismatch and versions.json entry checks but preserves the manifest-shape check. Required fix: validate the original parsed manifest shape before synthesis, and only synthesize for an otherwise valid manifest whose `version` string differs from the target. Add regression coverage for missing/non-string source manifest version under `--bootstrap`.

3. **Planned missing-version CLI test is not present.** `ImplementationPlan.md:465-468` says Phase 3 adds tests for end-to-end `extract for missing version exits non-zero` and trailing-whitespace preservation. The trailing-whitespace test exists in `src/release/changelog.test.ts:72-77`, and the script behavior works in manual verification, but no committed test covers `scripts/release/extract-release-notes.mjs` exiting non-zero for a missing version. Required fix: add the promised script-level regression test, or update the plan if this requirement was intentionally moved out of automated tests.

### Notes for Reviewer
- Deliverable completeness is otherwise strong: release validators, assembly/extraction scripts, npm aliases, `.gitignore`, SHA-pinned release workflow, job-level `contents: write`, and release-assets tests are present.
- No runtime plugin behavior changes were introduced by Phase 3; the only `src/` addition is release validation tooling/tests.

## Re-review (post-fix commit 83f9f63)

### Verdict: PASS with notes

### Summary
The three prior blockers are resolved and Phase 3 is ready to proceed.

### Fix Verification
1. **GitHub Actions shell interpolation:** resolved. `.github/workflows/release.yml` now passes `${{ steps.tagver.outputs.version }}` through `env.RELEASE_VERSION`, and both shell commands quote `"$RELEASE_VERSION"`. The remaining expression uses are YAML/action inputs, not shell interpolation.
2. **`--bootstrap` manifest-shape masking:** resolved. `scripts/release/assemble-assets.mjs` now gates bootstrap synthesis with `isWellFormedSourceManifest(manifest)` before overwriting the staged manifest, and exits non-zero with the documented error for malformed source manifests.
3. **Missing-version CLI regression test:** resolved. `src/release/extractReleaseNotes.cli.test.ts` covers success for `0.5.0`, non-zero missing-version behavior for `99.99.99`, and no-args usage failure.

### Tests / Sanity Checks
- `npm test`: PASS — 70 files, 1093 tests.
- `npm run typecheck`: PASS.
- `npm run build`: PASS.
- Spot check: `npx tsx scripts\release\extract-release-notes.mjs 99.99.99` exits 1 with the expected "No section found" message.
- Spot check: temporary malformed `manifest.json` under `release:assemble -- 0.5.0 --bootstrap` exits 1 with the documented bootstrap manifest-shape error; `manifest.json` was restored and no source changes remain.

### Notes
- YAML parser packages (`js-yaml`, `yaml`) are not installed locally, matching the prior review's parser-availability note; no new blocker.
- No source code was modified during this re-review.
