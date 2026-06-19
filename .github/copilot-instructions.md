# Copilot instructions for obsidian-copilot-agent

These instructions apply to any AI coding assistant (Copilot CLI, Claude,
Cursor, etc.) operating in this repository. Keep them short, opinionated,
and accurate — they exist to prevent recurring mistakes.

## Deploying to the test vault (CRITICAL)

Obsidian loads the plugin from the vault folder, NOT from this repo. The
build output (`main.js`) at the repo root is just an intermediate
artifact. If you edit any source file and ask the user to test in
Obsidian, you MUST deploy the new build first:

```
npm run deploy
```

This script:
1. Runs `npm run build` (production esbuild → `main.js`)
2. Copies `main.js`, `manifest.json`, `styles.css` into the vault plugin
   folder resolved from `OBSIDIAN_PLUGIN_DIR` env var or the gitignored
   `.deploy-target` file at repo root.

After deploy, remind the user to reload the plugin in Obsidian:
- Command palette → **Reload app without saving**, OR
- Settings → Community plugins → toggle **Copilot Agent** off + on.

**Do not** skip this step and assume the user will rebuild — past sessions
have lost time debugging "manual test failed" reports that turned out to
be the stale vault `main.js`.

If `.deploy-target` is missing, ask the user once to create it (one line:
absolute path to `<vault>/.obsidian/plugins/obsidian-copilot-agent`) or
set `OBSIDIAN_PLUGIN_DIR`. Then continue.

The `--with-binary` flag re-copies the platform `copilot.exe` (~150 MB);
only use it after `@github/copilot-sdk` is upgraded.

## Test environment

`vitest.config.ts` runs in **node** environment (no DOM). UI code that
needs unit tests should be refactored into pure functions in a sibling
module (e.g. `src/ui/chatKeydown.ts` next to `ChatView.ts`) and tested
there. Do not add jsdom/happy-dom for one-off UI tests — keep the
DOM-free invariant.

Run order for any change touching plugin code:
1. `npm test` — all suites must stay green.
2. `npm run build` (or rely on `npm run deploy` which builds first).
3. `npm run deploy` — push to vault.
4. Ask the user to reload Obsidian and verify.

## Phased Agent Workflow (PAW)

This repo uses [PAW](https://github.com/lossyrob/phased-agent-workflow).
Workflow artifacts live under `.paw/work/<work-id>/`. Follow the
mandatory transitions in the PAW agent instructions — particularly:

- After every `paw-implement` phase, run `paw-impl-review` (NEVER skip).
- After every stage boundary, delegate to `paw-transition` before
  yielding to the user.
- Active workflow context lives in `.paw/work/<work-id>/WorkflowContext.md`.

## Releasing

This repo has in-repo release tooling. Do NOT manually edit `package.json`/
`manifest.json`/`versions.json` versions when cutting a release. Instead:

- The Copilot CLI release agent at `.copilot/agents/release/` orchestrates
  the end-to-end flow (preflight, version-bump, CHANGELOG, tag, push,
  CI monitor, verify). Trigger with "release v\<version\>" in a Copilot
  CLI session. Re-entrant.
- Or fall back to `npm run release:prepare <version>` (mutates the four
  files atomically) followed by manual commit + annotated tag + push.
- `.github/workflows/release.yml` is tag-triggered and publishes the
  GitHub Release with `main.js`, `manifest.json`, `styles.css`.
- See `RELEASING.md` for the full runbook (recovery procedures, trust
  chain, smoke-test procedure, dry-run mode).

`npm run deploy` is the **dev-time** path and is unchanged by v0.6 — it
still copies the locally-built artifacts into the vault plugin folder
resolved from `.deploy-target` or `OBSIDIAN_PLUGIN_DIR`. End users
install via BRAT (also documented in `README.md`); they do not use
`npm run deploy`.

## Project conventions

- TypeScript strict mode. `tsc --noEmit` must stay clean.
- No comments on obvious code; comment only where intent or non-obvious
  invariants need explanation.
- New tools that mutate vault state route through `SafetyPolicy`; new
  read-only tools may set `skipPermission: true` only if they satisfy
  the read-only checklist documented at the top of `src/tools/ReadTools.ts`.
- See `README.md` for the v0.1 safety model, OAuth notes, and CLI binary
  rationale.
