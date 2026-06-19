# Skill: preflight

Verify that the local repo and target version are in a releasable state before any mutating step runs. (FR-007.)

## When to invoke

Always run this skill first when the agent starts a release for `<version>`. Re-run it any time the agent is re-entered to confirm the environment hasn't drifted.

## Inputs

- `<version>` — the bare SemVer being released (e.g. `0.6.0`).
- `--dry-run` (optional) — relax the strict-environment checks (see "Dry-run mode" below).

## Checks (in order)

1. **Clean working tree.** Run `git status --porcelain`. If output is non-empty, halt and ask the maintainer to commit or stash. _(Skipped in `--dry-run`.)_
2. **On `main`.** Run `git rev-parse --abbrev-ref HEAD`. If the result is not `main`, halt and ask the maintainer to switch branches. _(Skipped in `--dry-run`.)_
3. **Up to date with `origin/main`.** Run `git fetch origin main --quiet`, then check that local `main` and `origin/main` are at the same commit. Compute both `git rev-list --count main..origin/main` (must be 0 — local is not behind) AND `git rev-list --count origin/main..main` (must be 0 — local is not ahead with unpushed commits). If either count is non-zero, halt and ask the maintainer to pull (behind) or push/reset (ahead). Local-ahead is a hard block: `tag-and-push` would otherwise quietly publish unreviewed commits along with the release.
4. **TypeScript types are clean.** Run `npm run typecheck`. If non-zero, halt and print stderr.
5. **Tests pass.** Run `npm test`. If non-zero, halt and print stderr.
6. **Version is monotonically newer.** Read the current version from `package.json` (`node -p "require('./package.json').version"`) and compare against `<version>` using semver semantics. The requested version MUST be greater than (or equal to — treated as "already bumped") the current. If lower or invalid, halt with the offending values shown.

   > **Note:** `npm run version-bump -- --check <version>` is referenced in older versions of this skill, but the `--check` flag is not implemented in `scripts/version-bump.mjs` and running it will mutate files. Either:
   > - Implement `--check` in `scripts/version-bump.mjs` (read-only, exit 0 if OK, exit 1 if downgrade/invalid) and revert this skill to use it, OR
   > - Continue using the inline Node read-and-compare shown above.

## Outputs

- On success, print a one-line "preflight OK for v<version>" summary and return control to the agent.
- On failure, print the failing check name, the command output, and the suggested fix.

## Dry-run mode

Pass `--dry-run` to relax checks 1 and 2 only. The remaining checks (in-sync with `origin/main`, typecheck, tests, monotonic version) are still required — they validate the codebase, not the maintainer's working state. The dry-run mode also implies that the agent will not push, so a stale-vs-origin check is fine to keep strict.

## Re-entrancy

The preflight skill is purely diagnostic — running it twice in a row is safe and produces the same output (modulo CI clock or remote drift between runs).

## Notes

- `npm run typecheck` and `npm test` may take 30+ seconds on a cold checkout. Surface a "this may take a minute" notice before invoking them so the maintainer doesn't think the agent is stuck.
- The `--check` flag on `version-bump` returns exit 0 when the requested version equals the current `package.json` version. This is intentional — the bump skill treats that case as a no-op so the agent is re-entrant after a partial bump.
