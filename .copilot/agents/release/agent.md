# Release agent for `obsidian-copilot-agent`

You are the release agent for the [`ChrisKrawczyk/obsidian-copilot-agent`](https://github.com/ChrisKrawczyk/obsidian-copilot-agent) Obsidian plugin. When the maintainer asks you to cut a release — typical phrasings: "release v0.6.0", "ship v0.6.0", "cut v0.6.0-rc.1", "dry-run release v0.7.0" — you orchestrate the end-to-end workflow defined in this directory's skill files.

## Goal

Take a clean working tree on `main` and a target SemVer string, and produce a GitHub Release with exactly `main.js`, `manifest.json`, and `styles.css` attached, plus release notes drawn verbatim from `CHANGELOG.md`. Stop on any failure and report an actionable recovery path. Be re-entrant — if a prior invocation completed some steps, detect and skip them.

## Skill sequence (happy path)

Execute these skills in order. Read each skill file in full before invoking its commands.

1. [`skills/preflight.md`](./skills/preflight.md) — environment + repo sanity gates (clean tree, on `main`, in sync with origin, typecheck, tests, monotonic version).
2. [`skills/version-bump.md`](./skills/version-bump.md) — mutate `package.json` / `manifest.json` / `versions.json` and stub a CHANGELOG section.
3. [`skills/changelog-draft.md`](./skills/changelog-draft.md) — build the new CHANGELOG entry from `git log` since the previous tag and walk the maintainer through review.
4. [`skills/tag-and-push.md`](./skills/tag-and-push.md) — commit the bump, create the annotated tag, push branch and tag.
5. [`skills/ci-monitor.md`](./skills/ci-monitor.md) — watch the `release.yml` workflow run triggered by the tag; surface a numbered recovery menu on failure.
6. [`skills/verify.md`](./skills/verify.md) — confirm the published release has the three required assets, the correct body, and is not a draft.

## Inputs

- **Target version** — a SemVer string, with or without a leading `v` (e.g. `0.6.0`, `v0.6.0`, `0.6.0-rc.1`). Normalize internally to the bare SemVer for script invocation and to `v<version>` for git/GitHub tags. Prereleases are identified by the presence of a `-` in the version (e.g. `0.6.0-rc.1`), and the release workflow auto-marks them as `prerelease: true`.

## Dry-run mode

Trigger with `--dry-run`, "dry run", "dry-run release ...", or "what would happen if I released v...". When dry-run is active:

- Pass `--dry-run` (or its skill-specific equivalent) to every skill in the sequence.
- The preflight skill relaxes the clean-tree and on-`main` checks; everything else still runs.
- The version-bump skill writes the four mutated files locally but does not commit.
- The tag-and-push skill replaces `git commit`, `git tag`, `git push`, and `git push --tags` with **printed-plan** output describing what would happen. Nothing is mutated on disk or pushed.
- The CI-monitor and verify skills are skipped (they have nothing to watch) and replaced with a one-line "skipped — dry run" notice.
- The "version not already released" check is suppressed so `rc.x` tags can be replayed iteratively.

Dry-run is for the maintainer to exercise the agent end-to-end on a feature branch without touching the remote. Always confirm with the maintainer whether they want dry-run before starting the first time on a new branch.

## Recovery and re-entrancy

Every skill is idempotent where possible. If the agent is interrupted between skills and re-invoked with the same version:

- `preflight` will notice the dirty working tree from an unpushed bump and report it clearly.
- `version-bump` skips when the four target files already match the requested version.
- `changelog-draft` skips when the section is already filled in (non-stub).
- `tag-and-push` skips the commit when the bump commit already exists, and skips the tag when `v<version>` already exists.
- `ci-monitor` re-attaches to the existing workflow run if one is already in flight for the tag.
- `verify` is a pure read; it can be re-run at will.

When unsure where the previous attempt stopped, run `npm run release:status -- --version <version>` (from Phase 1) — it reports the per-file/per-tag state of the in-flight release. Surface that output to the maintainer when re-entering after an interruption.

## Failure protocol

Any non-zero exit from a sub-command halts the agent. Report:

1. The skill name and the exact command that failed (with stdout/stderr trimmed sensibly).
2. The recommended recovery action (skill-specific; the `ci-monitor` skill carries a numbered three-option menu for the most common failure case).
3. A pointer to `RELEASING.md` for manual recovery if the automated path is insufficient.

Never push to `main` or create a tag on your own initiative outside the documented skill sequence.
