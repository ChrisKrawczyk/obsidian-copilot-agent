# 0008 — Persistent MCP server stderr log files

**Status:** Draft
**Created:** 2026-07-01
**Owner:** unassigned

## Problem

Phase 8 of the preset-packs workflow surfaces MCP server stderr in two
ways:

1. In-memory 64 KiB ring buffer per stdio transport
   (`StdioTransport.getStderrTail()`).
2. Included in the "MCP server failed" `Notice` on connection failure.

That covers first-run interactive-auth diagnostics and most transient
failures, but it has real limits:

- The tail buffer is cleared when the server is disabled or the plugin
  reloads. Users cannot inspect logs from a server that connected
  successfully hours ago but is now misbehaving.
- Users who want to file a bug report against an MCP server have no
  standing artifact to attach.
- The 64 KiB ring truncates long-running servers that print heartbeats
  or verbose progress on stderr.

Claude Desktop solves this by writing per-server rotating log files
under `~/Library/Logs/Claude/mcp-server-<name>.log`. VS Code MCP support
sends everything to an `OutputChannel` that persists for the session.
Obsidian has no `OutputChannel` primitive but does have the vault
adapter for file I/O.

## Sketch

Add per-server stderr log files in a stable, discoverable location:

1. **Path:** `<plugin-dir>/mcp-logs/<serverId>.log` (using the same
   directory the plugin already uses for its own state). Files created
   lazily on first stderr write.
2. **Rotation:** Cap each log at 1 MiB. When exceeded, rename to
   `<serverId>.log.1` and truncate the primary. Keep at most one
   rotated file per server (so max ≈2 MiB per server).
3. **Structured lines:** Each stderr write is one JSON-per-line record:
   `{ts, serverId, level, text}`. Level defaults to `"stderr"` but a
   future improvement could parse common prefixes (`ERROR`, `WARN`).
4. **Settings UI:** Add "Open MCP logs folder" button in the MCP
   servers section footer. On click, open the `mcp-logs` directory in
   the OS file manager via `require("electron").shell.openPath` (with
   graceful fallback to a `Notice` showing the vault-relative path).
5. **Redaction:** Reuse `redactSensitive` before writing, matching the
   in-memory stderr tail behavior. **Never** log stdout (which may
   contain tool responses).
6. **Opt-out toggle:** Settings toggle "Persist MCP server stderr to
   log files" default ON, but users on read-only vaults or with strict
   privacy needs can disable it.

## Testing

- Unit test for rotation: fill log past 1 MiB, verify rename + truncation.
- Unit test for redaction on write.
- Unit test for opt-out disabling writes.
- Manual: enable a chatty stdio MCP server; verify log grows, rotates,
  redacts secrets; disable server; confirm file remains until user
  clears it.

## Non-goals

- **stdout logging.** Tool responses contain sensitive user data and
  are already visible in chat.
- **Multi-file rotation.** One rotated file per server is enough for
  practical debugging; more elaborate policies add code without adding
  value for this plugin's use case.
- **Log ingestion / search UI in-app.** Users can open the folder and
  grep or tail with their own tools.

## References

- Claude Desktop MCP logging behavior (from ekamoira.com and
  bartwullems.blogspot.com articles reviewed during Phase 8 research).
- Phase 8 stderr surface work in
  `.paw\work\preset-packs\ImplementationPlan.md` and
  `src\mcp\transport\StdioTransport.ts` (`getStderrTail`).
