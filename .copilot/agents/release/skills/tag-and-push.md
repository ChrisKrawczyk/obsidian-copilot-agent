# Skill: tag-and-push

Commit the four files mutated by the bump + changelog skills, create the annotated tag, and push branch and tag to `origin`. This is the step that hands control to GitHub Actions.

## When to invoke

After `changelog-draft` completes and the maintainer has confirmed the populated CHANGELOG entry.

## Inputs

- `<version>` — the bare SemVer (e.g. `0.6.0`). The git tag is always `v<version>`.
- `--dry-run` (optional) — print the plan instead of executing (see "Dry-run mode" below).

## Steps

1. **Verify the four files are staged-worthy.** Run `git status --porcelain` and assert that exactly `package.json`, `manifest.json`, `versions.json`, and `CHANGELOG.md` show modifications. If any other file is dirty, halt and ask the maintainer (the bump + changelog skills should only touch these four).
2. **Check for an existing release commit.** Run `git log -1 --pretty=%s` against `HEAD`. If the subject is already `chore(release): v<version>`, skip the commit step (re-entrancy).
3. **Commit.** Otherwise run `git add package.json manifest.json versions.json CHANGELOG.md` followed by `git commit -m "chore(release): v<version>"`. Trailers (Co-authored-by, Signed-off-by) are added automatically per the repo's commit conventions if `git config commit.template` is set; otherwise let the maintainer's `~/.gitconfig` defaults apply.
4. **Check for an existing tag.** Run `git tag --list v<version>`. If non-empty, skip the tag step.
5. **Create the annotated tag.** Extract the CHANGELOG body for `<version>` via `npm run changelog:extract -- <version>` and pipe to `git tag --annotate v<version> --file -`. The annotated tag's message carries the release notes verbatim — this is the source of truth that the `release.yml` workflow re-extracts later for the GitHub Release body.
6. **Push the branch.** Run `git push origin main`. If the upstream is not set, prompt the maintainer rather than auto-setting it.
7. **Push the tag.** Run `git push origin v<version>`. This is what triggers `.github/workflows/release.yml`.

## Outputs

- A new commit on `main` (or skipped if already present).
- A new annotated tag `v<version>` (or skipped if already present).
- Branch and tag pushed to `origin`.

## Dry-run mode

Replace steps 3, 5, 6, and 7 with **printed-plan output**. Specifically:

- Step 3: print "Would run: `git add ... && git commit -m \"chore(release): v<version>\"`".
- Step 5: print "Would run: `npm run changelog:extract -- <version> | git tag --annotate v<version> --file -`".
- Steps 6 and 7: print "Would run: `git push origin main && git push origin v<version>`".

Then print a final reminder: "Dry-run finished — to revert the local file mutations, run: `git checkout -- package.json manifest.json versions.json CHANGELOG.md`". Do not run that revert automatically; the maintainer may want to inspect the mutations first.

Skip steps 1, 2, and 4 in dry-run as well — they assume the maintainer's tree is in the standard release state, which dry-run does not require (dry-run permits running on a feature branch with extra unrelated changes).

## Re-entrancy

The skill detects three resumption states:

1. Commit + tag both already exist → skip both, proceed to push (steps 6 + 7).
2. Commit exists, tag does not → skip step 3, run steps 4–7.
3. Neither exists → run all steps.

`git push` is itself idempotent for refs already in sync, so re-running steps 6 + 7 after a previous successful push is safe (it just prints "Everything up-to-date").

## Notes

- The annotated tag's message must not contain trailing whitespace differences from the CHANGELOG section, or `verify` will flag a body mismatch later. The Phase 3 `extractSection` helper preserves the section verbatim (including trailing whitespace) precisely so this round-trip is lossless.
- On a multi-account `gh` setup, this skill uses `git` (not `gh`) for the push, so the credential helper / SSH key in use is governed by the maintainer's standard git auth, not the active `gh auth switch` account.
