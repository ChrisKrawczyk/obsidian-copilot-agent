# Skill: version-bump

Run the Phase 1 version-bump tooling to mutate the four files that pin a release: `package.json`, `manifest.json`, `versions.json`, and `CHANGELOG.md`.

## When to invoke

After `preflight` returns OK. Always before any commit/tag step.

## Inputs

- `<version>` — the bare SemVer being released (e.g. `0.6.0`).
- `--dry-run` (optional) — see "Dry-run mode" below.

## Steps

1. **Check for prior bump.** Read `package.json`'s `version` field. If it already equals `<version>`, print "version-bump skipped: package.json already at v<version>" and return — this makes the skill idempotent across agent restarts.
2. **Invoke the bump.** Run `npm run version-bump -- <version>`. (Do _not_ invoke `node scripts/version-bump.mjs` directly — Phase 1 wired the bump through the `tsx` loader so the same script also imports the pure helpers from `src/release/`.)
3. **Report mutations.** After the bump exits 0, print the four mutated paths:
   - `package.json` (version)
   - `manifest.json` (version)
   - `versions.json` (new entry: `<version>` → current `minAppVersion`)
   - `CHANGELOG.md` (new stub section `## [<version>] - YYYY-MM-DD`)
4. **Pause for inspection.** Ask the maintainer to skim `git diff` and confirm before proceeding to the changelog-draft skill. Hand back control until the maintainer says "continue" (or "looks good", "go", "yes", etc.).

## Outputs

- On success, the four files are mutated locally (uncommitted), and the maintainer has explicitly confirmed before the next skill runs.
- On failure, the bump script exits non-zero with an error message — surface it verbatim and halt the agent.

## Dry-run mode

In `--dry-run`, still run `npm run version-bump -- <version>` (it mutates files locally but does not push). Note in the output that the files are mutated on disk and will be reverted at the end of the dry-run sequence by `git checkout -- package.json manifest.json versions.json CHANGELOG.md` (the tag-and-push skill prints this revert command in its dry-run plan instead of executing it).

## Re-entrancy

- If the four target files already match `<version>` (detectable from `package.json`'s `version` field plus a `## [<version>]` heading in `CHANGELOG.md`), skip the bump entirely.
- If the bump succeeded previously but the agent was interrupted before the changelog-draft skill ran, this skill is a no-op and the agent proceeds to `changelog-draft`.

## Notes

- The Phase 1 bump script aborts with a clear error if `<version>` is not strictly greater than the current `package.json` version. Preflight's `--check` mode catches this earlier, but the bump's own assertion is the canonical source of truth.
- Do not edit the four files by hand — the bump script keeps them consistent. Hand edits will fail validation in Phase 3's `release:assemble` step.
