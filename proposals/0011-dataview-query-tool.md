# 0011 — Dataview inter-plugin query tool

**Status:** Draft
**Created:** 2026-07-06
**Owner:** unassigned
**Depends on:** [0010 — Agent-native vault navigation tools](./0010-agent-native-vault-tools.md)

## Problem

Once 0010 ships, the agent has powerful navigation primitives: fuzzy /
ranked text search, compound metadata + text queries via `search_vault`,
link-graph traversal, and structural note inspection. What it still
lacks is a **structured relational query surface** — the kind of thing
a user would run in Obsidian's own search bar with operators like
`tag:#project AND path:Work/ AND -tag:archived`, or aggregate as a
sortable table.

Obsidian's built-in search query language is closed to plugins (verified
in 0010's research). However, the [Dataview](https://blacksmithgu.github.io/obsidian-dataview/)
community plugin (~1M+ installs) exposes exactly this: a proper query
API called DQL that supports boolean logic over tags, folders, links,
frontmatter, and file metadata, plus rendered TABLE / LIST / TASK
output.

For users who already have Dataview installed, wrapping its API as an
agent tool gives us "structured queries over the vault" essentially for
free.

## Sketch

### Tool

Register **`dataview_query`** as an SDK tool, **only when Dataview is
enabled** in the user's vault. Registration guard:

```typescript
import { getAPI as getDataviewAPI } from "obsidian-dataview";
const dv = getDataviewAPI(app);
if (dv) {
  tools.push(dataviewTool(dv, ...));
}
```

The `getAPI(app)` call returns `undefined` when the plugin isn't
installed or is disabled; our tool factory simply skips registration in
that case. The preamble inventory must also conditionally omit the tool
so the model isn't taught about a capability that doesn't exist.

### Tool contract

```
input:  { source: string, format?: "markdown" | "json" }
output: { ok: true, format, content } | { ok: false, reason }
```

- `source` is a raw DQL query (e.g., `TABLE file.mtime FROM #project`).
- `format: "markdown"` (default) returns the rendered Markdown table
  via `dv.queryMarkdown(source)`. Cheapest for the model to consume.
- `format: "json"` returns the structured result via `dv.query(source)`
  for cases where the agent wants to iterate on rows.

### Preamble hint

Only surface when the tool is registered:

> `dataview_query` — Structured DQL query over the vault
> (TABLE / LIST / TASK). Use when you need relational operators (path +
> tag + frontmatter + boolean) beyond what `search_vault` composes.

### Settings

Add a single boolean setting: **"Enable Dataview integration
(experimental, requires Dataview plugin)"**. Off by default so users who
have Dataview installed but don't want the agent to run arbitrary DQL
don't get the tool automatically.

### Dependency shape

Add `obsidian-dataview` as a **`devDependency`** (types only) plus a
runtime `getAPI(app)` call — no runtime bundle inclusion. The plugin
manifests as an *optional peer* the user separately installs.

## Why this deserves its own proposal (not part of 0010)

- **User-base overlap is partial.** Roughly a third of "power" Obsidian
  users run Dataview; the remainder gain nothing from this tool.
  Bundling it into 0010 would make 0010 wider than needed and delay the
  base tools for everyone.
- **Registration surface is genuinely different.** All 0010 tools are
  unconditionally registered. This one is conditional on runtime plugin
  detection, which needs new preamble/inventory plumbing.
- **DQL is expensive and cost-model complexity.** Some DQL queries scan
  the whole vault. Adds a per-call cost consideration the base tools
  don't have. Deferring lets us think about it separately (timeouts,
  result caps, disable-on-slow-vault UX).
- **Safety review.** DQL can also invoke JavaScript (`dv.func()`
  extensions in the query surface). We'd want to double-check the
  exposed API is data-only before enabling by default.

## Open questions

1. **Should we ship "read-only DQL" only?** DQL itself is read-only, but
   Dataview also has DataviewJS which is arbitrary JS. `queryMarkdown`
   is the safest surface. Confirm we can restrict to that.
2. **Result size caps?** DQL over a 10k-note vault with a broad `FROM`
   clause can return thousands of rows. Truncate + report `truncated:
   true`?
3. **Registration timing.** Dataview may load *after* our plugin. Do we
   register at Obsidian layout-ready, or subscribe to
   `workspace.on('plugins-loaded')` (private) and add the tool
   mid-session using the same swap mechanism that shipped in v0.9 for
   MCP tool refresh?

## Not doing

- Rendering Dataview *widgets* (calendar, gallery) inside chat messages
  — DQL text/markdown output only.
- Exposing DataviewJS (`await dv.pages(...)` in embedded JS).
- Multi-vault or cross-plugin query fusion.
