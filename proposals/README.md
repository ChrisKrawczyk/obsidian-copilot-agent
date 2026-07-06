# Proposals

Short design docs for future work items. One file per proposal.

## Conventions

- **Naming:** `NNNN-short-slug.md` where `NNNN` is a zero-padded incrementing index.
- **Status:** each proposal carries a `Status:` line at the top (`Draft`,
  `Accepted`, `In Progress`, `Shipped`, `Rejected`, `Superseded by NNNN`).
- **Length:** keep it short. A proposal is "enough context for a future
  implementor (possibly you in three months) to decide whether to pick it up
  and how to start." It is NOT a full PAW spec — that comes when the work is
  actually picked up.
- **Sections:** every proposal should at least cover **Problem**, **Sketch**,
  and **Open questions**. Use additional sections (Risks, Alternatives,
  Dependencies) when they pay rent.

## Lifecycle

1. **Capture.** Drop an idea into a new numbered file. Set status `Draft`.
2. **Triage.** When discussing priorities, accept/reject. Reject = keep the
   file (history matters) and set status `Rejected` with a one-line reason.
3. **Promote.** When a proposal is picked up, kick off a PAW workflow with
   the proposal as background reading. Update status to `In Progress` →
   `Shipped` (link to PR), or `Superseded by NNNN` if the design evolved
   into a different proposal.

## Index

| #    | Title                                              | Status |
| ---- | -------------------------------------------------- | ------ |
| 0001 | Microsoft 365 Graph MCP integration                | Draft  |
| 0002 | Packaging and release for community distribution   | Draft  |
| 0003 | Mid-session MCP tool registry refresh              | Draft  |
| 0004 | Vault embeddings and semantic search               | Draft  |
| 0005 | Track upstream MCP filesystem `slice(7)` fix       | Draft  |
| 0006 | Tool picker & scope-aware credential resolution    | Draft  |
| 0007 | Importable / exportable MCP server preset packs    | Draft  |
| 0011 | Dataview inter-plugin query tool                   | Draft  |
