// Dev-only token export. This file is gitignored.
//
// To populate: copy this file to `src/dev-token.local.ts` and replace the
// placeholder below with a `gho_...` (OAuth) or `github_pat_...` (fine-grained
// PAT) token. A `gh auth token` value works in the dev environment that
// produced this spike.
//
// The token is read at plugin load by the smoke test command. Phase 3 replaces
// this with a Device Flow.
export const DEV_TOKEN = "REPLACE_WITH_gho_OR_github_pat_TOKEN";
