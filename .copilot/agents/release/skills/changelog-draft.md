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
3. **Try PR-body extraction first.** Run `npm run changelog:from-pr -- <previous-tag>`. This scans `<previous-tag>..HEAD` for squash-merge commits (subjects ending `(#N)`), fetches each PR's body via `gh pr view`, and prints a Markdown skeleton.
   - If output starts with `# (no squash-merged PRs in range)`, the range has no merged PRs — fall through to step 4 (raw `git log`).
   - Otherwise the PR body(ies) become the **primary draft source**. The squash-merge convention used by this repo means the PR body is the canonical release-narrative; `git log` returns one terse subject and is much weaker. The PR body typically already organizes content into "Added / Changed / Fixed"-style sections.
4. **Fallback: collect raw commits.** Only if step 3 produced no PRs. Run `git log <previous-tag>..HEAD --no-merges --pretty=format:'%H%x09%s%x09%b%x1e'` (use `git log main` if `<previous-tag>` is empty). Parse the records.
5. **Group by conventional prefix.** Bucket each commit subject by its Conventional Commits type (used to refine PR-body output OR organize raw commits from step 4):
   - `feat:` / `feat(`...`):` → **Added**
   - `fix:` / `fix(`...`):` → **Fixed**
   - `refactor:`, `perf:`, `chore:` → **Changed** (only if user-visible; ask the maintainer for ambiguous ones)
   - `docs:`, `test:`, `style:`, `ci:`, `build:`, `revert:` → omit by default; surface a separate list of these for the maintainer to override case-by-case.
   - Subjects without a recognized prefix → present as "uncategorized — needs human grouping".
6. **Draft the section.** Build a Markdown block of the form:

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

   Use the date of the current local day (`new Date().toISOString().slice(0,10)`). Omit empty sections (do not emit a `### Fixed` heading with no bullets). When the source is a PR body, prefer carrying its existing structure over forcing the strict `Added/Changed/Fixed` partition — readability of the final user-facing CHANGELOG entry wins.

7. **Present and iterate.** Show the draft to the maintainer with the uncategorized + omitted-by-default lists. Accept edits in plain prose ("merge the first two bullets", "move X to Fixed", "drop the third one"). Re-render after each edit until the maintainer says "ship it" or "looks good".

   **Content rules (apply before write):**

   a. **No agentic-framework references.** The CHANGELOG is user-facing and shipped verbatim in the GitHub Release body. Do NOT include references to PAW, phased-agent-workflow, `.paw/` artifacts, phase numbers, spec/plan/impl-review activities, or other agentic scaffolding — unless the change itself modifies that framework (e.g. adding PAW support, changing agent files). Rewrite bullets that mention them to describe the user-visible outcome instead. Examples of what to remove: "PAW technical reference at `.paw/work/…/Docs.md`", "Phase 4 introduces…", "spec-review passed…". If a scaffolding file has a real user-facing counterpart (e.g. a `docs/` guide), link that instead.

   b. **Repo-relative link integrity.** Every repo-relative link (`[text](path)` where path does NOT start with `http://`, `https://`, `#`, or `mailto:`) must resolve on the target commit. Enumerate every such link in the draft and run `git ls-files --error-unmatch <path>` (or `git cat-file -e HEAD:<path>`) against each. Any that fails is a dead link that will 404 on the published Release page. Common causes:
   - Links to `.paw/`, `.copilot/`, or other scratch/framework paths that were stop-tracked.
   - Links to files that only exist on a feature branch, never merged to `main`.
   - Typos in paths.

   Surface every dead link to the maintainer with the offending path and the containing bullet. Do not write the section until they are either removed, replaced with a live link, or converted to plain prose. This check runs on the finalized text right before step 8.
8. **Write.** Replace the stub section in `CHANGELOG.md` with the agreed text. Preserve the file's existing line endings (CRLF vs LF).

## Outputs

- A populated `CHANGELOG.md` section for `<version>`, uncommitted.
- On failure (no commits found, `CHANGELOG.md` unreadable), halt and surface the error.

## Dry-run mode

Steps 1–7 run normally. Step 8 still writes to `CHANGELOG.md` on disk — the tag-and-push skill's dry-run plan will note that this edit (along with the bump) will be reverted at the end of the dry-run sequence. Do not skip step 8 in dry-run; the maintainer should see exactly what the changelog block looks like in context.

## Re-entrancy

The idempotency check in step 2 covers re-invocation. To intentionally re-draft (e.g. the maintainer wants to add a commit landed since the first draft), the maintainer must manually revert the section back to its stub form (`### Added`/`### Changed`/`### Fixed` placeholders only) before re-invoking the agent.

## Notes

- The `git log` range is exclusive of `<previous-tag>` and inclusive of `HEAD`; this excludes commits already shipped in the prior release and includes the version-bump commit itself (which is fine — the bump's commit message is `chore(release): v<version>` and falls into the "omit-by-default" bucket).
- Conventional Commits is a convention, not a hard requirement of this repo. Subjects without a prefix are common in older history and require the maintainer's eye.
- The PR-body extraction path (step 3) was added after v0.6.0 shipped — squash-merge-to-`main` is this repo's convention, which made the raw `git log <prev>..HEAD --no-merges` always return one commit per release. The PR body has the real narrative. For RC → stable graduations where no new PRs were merged in the range, step 3 returns the "no PRs" sentinel and you fall back to step 4.
