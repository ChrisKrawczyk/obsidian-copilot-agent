# 0005 — Track upstream MCP filesystem `slice(7)` fix

**Status:** Draft
**Created:** 2026-06-18
**Owner:** unassigned

## Problem

`@modelcontextprotocol/server-filesystem` (version 2026.1.14, latest as
of June 2026) ships a bug in `roots-utils.ts`:

```js
const rawPath = rootUri.startsWith('file://') ? rootUri.slice(7) : rootUri;
```

Should be `fileURLToPath(rootUri)`. The current code keeps the leading
slash before the Windows drive letter and never percent-decodes spaces,
so `path.resolve` builds garbage like `C:\C:\Users\...\OneDrive%20-%20...`
and `fs.realpath` rejects with `ENOENT`. Any Windows path containing a
space breaks (OneDrive folders, `Program Files`, vaults in
`C:\Users\<name>\Documents and Settings\...`, etc.).

We worked around this in `McpServerRuntime.advertisedRoots()` by emitting
a single URI form that round-trips through BOTH the spec-compliant
`fileURLToPath` and the buggy `slice(7)`: `file://C:/Vaults/My Vault`
(two slashes, literal spaces, no encoding). This is fragile.

## Sketch

When the upstream fix ships (PR #3353 has the change), unwind the
workaround:

1. Watch [modelcontextprotocol/servers PR #3353][pr-3353] and Issue
   [#3174][issue-3174] for merge + release.
2. Once a fixed version of `@modelcontextprotocol/server-filesystem` is
   published, bump the version pin in any docs/templates we ship.
3. Replace `advertisedRoots()` with the simple `pathToFileURL(cwd).href`
   form. Remove the `pathToCompatibleFileUri` helper and its comment.
4. Update the related tests in `src/mcp/McpServerRuntime.test.ts`.
5. Note in CHANGELOG that users running older `server-filesystem`
   versions on Windows will need to update.

## Risks

- Users who pin an old version (or run from a fork) will regress. Keep
  the workaround if it costs nothing — but the dual-form URI is
  non-obvious code that future readers will rightfully question.
- Upstream may merge a different fix (e.g., a strict-mode flag) that
  changes the shape of what's accepted. Re-check before unwinding.

## Open questions

- Should we add a runtime probe — on connect, detect which parser the
  server uses (try the spec-compliant URI first, fall back to the
  Windows-compat form on failure) — instead of hardcoding the compat
  form? Cleaner long-term, more complex short-term.
- Are there OTHER MCP servers with similar Windows path bugs we should
  proactively check (the Git, GitHub, Slack, etc. reference servers all
  share helpers)?

## References

- Upstream issue: https://github.com/modelcontextprotocol/servers/issues/3174
- Upstream fix PR: https://github.com/modelcontextprotocol/servers/pull/3353
- Our workaround: `pathToCompatibleFileUri` and `advertisedRoots()` in
  `src/mcp/McpServerRuntime.ts`
- Original investigation: session checkpoint 038
  (`onedrive-mcp-fix-ux-polish`).

[pr-3353]: https://github.com/modelcontextprotocol/servers/pull/3353
[issue-3174]: https://github.com/modelcontextprotocol/servers/issues/3174
