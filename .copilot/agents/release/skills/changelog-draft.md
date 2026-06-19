# Skill: changelog-draft

Build the new version's `CHANGELOG.md` entry from commit history, present it to the maintainer for review, and write the agreed text into the stub left by the version-bump skill. (FR-008.)

## When to invoke

After `version-bump` reports success and the maintainer has confirmed the bump diff.

## Inputs

- `<version>` — the bare SemVer being released (e.g. `0.6.0`).
- `--dry-run` (optional) — content generation is unchanged in dry-run; only the final write step is conditional (see "Dry-run mode" below).

## Steps

1. **Find the previous tag.** Run `git describe --tags --abbrev=0 --match 'v*' 2>/dev/null`. If a tag is returned, use it as `<previous-tag>`. If no tag exists yet (very first release), use the empty string and treat the entire `main` history as the range.
2. **Check idempotency.** Read `CHANGELOG.md`. If the section under `## [<version>]` already contains non-stub content (more than the empty `### Added/Changed/Fixed` headings the version-bump script writes), print "changelog-draft skipped: section already populated" and return. The agent uses this to safely re-run after an interruption.
3. **Collect commits.** Run `git log <previous-tag>..HEAD --no-merges --pretty=format:'%H%x09%s%x09%b%x1e'` (use `git log main` if `<previous-tag>` is empty). Parse the records.
4. **Group by conventional prefix.** Bucket each commit subject by its Conventional Commits type:
   - `feat:` / `feat(`...`):` → **Added**
   - `fix:` / `fix(`...`):` → **Fixed**
   - `refactor:`, `perf:`, `chore:` → **Changed** (only if user-visible; ask the maintainer for ambiguous ones)
   - `docs:`, `test:`, `style:`, `ci:`, `build:`, `revert:` → omit by default; surface a separate list of these for the maintainer to override case-by-case.
   - Subjects without a recognized prefix → present as "uncategorized — needs human grouping".
5. **Draft the section.** Build a Markdown block of the form:

   ```markdown
   ## [<version>] - YYYY-MM-DD

   ### Added

   - <subject> (<short-sha>)
   - ...

   ### Changed

   - ...

   ### Fixed

   - ...
   ```

   Use the date of the current local day (`new Date().toISOString().slice(0,10)`). Omit empty sections (do not emit a `### Fixed` heading with no bullets).

6. **Present and iterate.** Show the draft to the maintainer with the uncategorized + omitted-by-default lists. Accept edits in plain prose ("merge the first two bullets", "move X to Fixed", "drop the third one"). Re-render after each edit until the maintainer says "ship it" or "looks good".
7. **Write.** Replace the stub section in `CHANGELOG.md` with the agreed text. Preserve the file's existing line endings (CRLF vs LF).

## Outputs

- A populated `CHANGELOG.md` section for `<version>`, uncommitted.
- On failure (no commits found, `CHANGELOG.md` unreadable), halt and surface the error.

## Dry-run mode

Steps 1–6 run normally. Step 7 still writes to `CHANGELOG.md` on disk — the tag-and-push skill's dry-run plan will note that this edit (along with the bump) will be reverted at the end of the dry-run sequence. Do not skip step 7 in dry-run; the maintainer should see exactly what the changelog block looks like in context.

## Re-entrancy

The idempotency check in step 2 covers re-invocation. To intentionally re-draft (e.g. the maintainer wants to add a commit landed since the first draft), the maintainer must manually revert the section back to its stub form (`### Added`/`### Changed`/`### Fixed` placeholders only) before re-invoking the agent.

## Notes

- The `git log` range is exclusive of `<previous-tag>` and inclusive of `HEAD`; this excludes commits already shipped in the prior release and includes the version-bump commit itself (which is fine — the bump's commit message is `chore(release): v<version>` and falls into the "omit-by-default" bucket).
- Conventional Commits is a convention, not a hard requirement of this repo. Subjects without a prefix are common in older history and require the maintainer's eye.
