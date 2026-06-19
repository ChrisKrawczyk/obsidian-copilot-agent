# Skill: verify

Confirm the published GitHub Release for `v<version>` is well-formed: exactly three named assets, body matches `CHANGELOG.md`, not a draft. The last gate before the agent declares success.

## When to invoke

After `ci-monitor` reports the release workflow succeeded.

## Inputs

- `<version>` — the bare SemVer (e.g. `0.6.0`).
- `--dry-run` (optional) — skipped entirely in dry-run (see "Dry-run mode" below).

## Steps

1. **Fetch the release.** Run `gh release view v<version> --json name,tagName,isDraft,isPrerelease,assets,body,url`. If the release is not found, halt with: "verify failed: no release found for tag v<version>. The workflow may have succeeded but the publish step failed silently — check `gh run view <run-id> --log`."
2. **Assert not draft.** If `isDraft` is true, halt with: "verify failed: release v<version> is a draft. Publish manually or re-run the workflow with `gh run rerun <run-id>` after investigating."
3. **Assert prerelease flag is correct.** If `<version>` contains a `-` (e.g. `0.6.0-rc.1`), assert `isPrerelease` is true. Otherwise assert `isPrerelease` is false. On mismatch, halt with the observed-vs-expected values; the maintainer can fix via the GitHub web UI ("Edit release" → toggle prerelease).
4. **Assert exactly three assets, named correctly.** Read `assets[].name`. The set must equal exactly `{"main.js", "manifest.json", "styles.css"}`. Extra or missing assets are a hard failure; halt with the observed names. (This is the same exactly-three-files invariant enforced by the Phase 3 `release:assemble` script — the verify skill repeats it here against the published release as a backstop in case GitHub or the upload action behaved unexpectedly.)
5. **Assert body matches CHANGELOG.** Run `npm run changelog:extract -- <version>` to get the expected body. Compare with `assets.body` byte-for-byte after normalizing line endings to `\n`. On mismatch, surface a unified diff and halt; the maintainer can edit the release body via the GitHub web UI.
6. **Report success.** Print:

   ```
   ✅ Release v<version> verified.
      URL:    <release-url>
      Tag:    v<version>
      Assets: main.js, manifest.json, styles.css
      Body:   matches CHANGELOG.md section for v<version>
   ```

   Return control to the agent (which can then announce overall completion).

## Outputs

- A printed success summary, or a printed failure with a specific remediation pointer.
- This skill never mutates remote state — it is pure read.

## Dry-run mode

Skip this skill in `--dry-run`. Print "verify skipped — dry run" and return. (There is no release to verify because the tag was never pushed.)

## Re-entrancy

Pure read — safe to invoke repeatedly. Re-running after a maintainer-applied fix in the web UI (e.g. toggling draft → published) will pass on the second try.

## Notes

- `gh release view` uses the maintainer's currently-active `gh` account context. If the release lives under a different account than the active one, switch with `gh auth switch --user <name>` before invoking the agent.
- Line-ending normalization in step 5 matters because the GitHub Releases API stores the body with `\n` line endings regardless of what was uploaded; the local CHANGELOG may be CRLF on a Windows checkout.
- The CHANGELOG section returned by `extractSection` preserves trailing whitespace verbatim. Step 5's byte-for-byte comparison is intentional — if a future GitHub API change starts trimming trailing whitespace from release bodies, this skill will catch it.
