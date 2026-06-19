# Skill: ci-monitor

Poll the GitHub Actions `release.yml` workflow run triggered by the just-pushed tag. On success, hand off to `verify`. On failure, present a numbered recovery menu to the maintainer. (FR-009, FR-010.)

## When to invoke

After `tag-and-push` reports a successful push of `v<version>`.

## Inputs

- `<version>` — the bare SemVer (e.g. `0.6.0`).
- `--dry-run` (optional) — see "Dry-run mode" below.

## Steps

1. **Find the workflow run.** Run `gh run list --workflow=release.yml --branch=main --limit=5 --json databaseId,headSha,status,conclusion,event,displayTitle,url`. Filter for the run whose `displayTitle` includes `v<version>` or whose `event` is `push` and `headSha` matches the just-pushed tag's commit. If no run is found, wait 5 seconds and retry (give GitHub a moment to queue the run). After 30 seconds without a run appearing, halt with an actionable error pointing the maintainer to the repo's Actions tab.
2. **Watch to completion.** Run `gh run watch <run-id> --exit-status` (this blocks until completion and exits non-zero on workflow failure). Surface the live output to the maintainer.
3. **On success.** Print "release.yml succeeded — handing off to verify". Return control with the run URL.
4. **On failure.** Present the three-option recovery menu below. Do not auto-select.

## Recovery menu (on workflow failure)

The skill prints, verbatim:

```
Release workflow failed.
  Run URL: <run-url>
  Failed step: <step-name> (link: <step-log-url>)
  Conclusion: <conclusion>

Recovery options:
  1) Re-run the failed workflow.
     Command: gh run rerun <run-id>
     Use when the failure is transient (network blip, runner flake, rate-limit).
     This skill will resume polling after the re-run is queued.

  2) Delete the tag and re-invoke the release agent.
     Commands:
       git tag -d v<version>
       git push --delete origin v<version>
     Use when the failure is real (test regression, missing CHANGELOG entry,
     manifest/versions.json drift). Land a source fix on main, then ask the
     release agent to release v<version> again — the agent's re-entrancy
     guards will reuse the still-valid bump commit if you preserve it on
     main, or you can revert it first if you prefer a clean re-bump.

  3) Abort and investigate manually.
     The tag stays in place; no further automated action will be taken.
     Follow the recovery procedure in RELEASING.md to publish or clean up
     by hand.

Which option (1/2/3)?
```

Wait for the maintainer's choice. Then:

- **Option 1** — run `gh run rerun <run-id>`, wait 3 seconds for re-queue, and loop back to step 2 ("Watch to completion").
- **Option 2** — run the two `git tag -d` / `git push --delete origin` commands, then halt with: "Tag deleted. After landing your source fix on `main`, re-invoke the release agent with `release v<version>` — the bump commit is still on main, and the version-bump skill will detect it and skip."
- **Option 3** — halt with: "No further action taken. Tag `v<version>` is still in place. See `RELEASING.md` for manual recovery."

## Dry-run mode

Skip this entire skill in `--dry-run` — there is no workflow run to watch (no tag was pushed). Print "ci-monitor skipped — dry run" and return.

## Re-entrancy

If `ci-monitor` was interrupted while watching (e.g. the maintainer killed the agent), re-invoking it with the same `<version>` will re-find the run via `gh run list` and resume watching. If the run has already completed by the time the agent re-attaches, surface the conclusion + URL and proceed (success) or present the recovery menu (failure).

## Notes

- The maintainer's `gh` account context (per the spec assumption about the two-account workflow) determines which token is used. The agent does not switch accounts on its own — if `gh run watch` returns a 404 / permission error, surface it and let the maintainer choose `gh auth switch`.
- `gh run watch --exit-status` streams logs to stdout; that output is the primary signal the maintainer should be reading. Do not suppress or summarize it during polling.
