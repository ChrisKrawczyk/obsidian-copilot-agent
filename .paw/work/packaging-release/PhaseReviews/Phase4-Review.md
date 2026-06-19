## Review Result: BLOCKED

### Summary
Phase 4 is largely complete and tests pass, but two release-agent command/re-entrancy issues need implementer rework before this phase should pass.

### Tests
- Status: PASS
- `npm test -- --run` passed: 71 files, 1097 tests.
- `npm run typecheck` passed.

### Commits Made
- None.

### Issues Found
1. **Preflight does not fully verify `main` is in sync with `origin/main`.** `.copilot/agents/release/skills/preflight.md:18` runs `git rev-list --count main..origin/main` and only blocks when local `main` is behind. The Phase 4 plan requires `main` to be "in-sync with `origin/main`" (`ImplementationPlan.md:501`). A local `main` that is ahead of `origin/main` would pass preflight and then `tag-and-push` would push unreviewed local commits. Fix by documenting a symmetric check (for example both `main..origin/main` and `origin/main..main` are zero, or an equivalent exact-ref equality check after fetch).

2. **`tag-and-push` re-entrancy contradicts its step order after the release commit already exists.** `.copilot/agents/release/skills/tag-and-push.md:16-18` requires exactly four dirty files before checking whether `HEAD` is already `chore(release): v<version>`. If an invocation is interrupted after the commit but before tag creation/push, the working tree is clean, so step 1 would halt before the documented re-entrancy states at `.copilot/agents/release/skills/tag-and-push.md:44-50` can skip the existing commit and proceed. Fix by checking existing commit/tag state before enforcing the exactly-four-files-dirty contract, or by allowing a clean tree when the release commit already exists.

### Notes for Reviewer
- Plan completeness otherwise looks good: the release agent is under `.copilot/agents/release/`, all six skill files exist, dry-run handling is documented across the sequence, CI failure menu matches the three required recovery options, and Phase 4 added no `src/` changes beyond `src/release/versionBumpCheck.cli.test.ts`.
- The new CLI test covers greater/equal/downgrade/invalid `--check` behavior through the `tsx` loader.
- Minor polish: `.copilot/agents/release/skills/verify.md:20` says compare with `assets.body`; the fetched JSON field is `body`.
