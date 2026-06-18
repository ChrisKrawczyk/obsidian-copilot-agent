# 0001 — Microsoft 365 Graph MCP integration

**Status:** Draft
**Created:** 2026-06-18
**Owner:** unassigned

## Problem

Users (especially within Microsoft) want the agent to reach Outlook mail,
calendar, Teams chats/channels/meetings, OneDrive, and SharePoint without
leaving Obsidian. Today the only way to bring those in is to copy/paste.

Microsoft now ships an official Graph MCP Server that exposes Graph as a
small set of LLM-friendly tools (`microsoft_graph_suggest_queries`,
`microsoft_graph_get`, `microsoft_graph_list_properties`). Wiring it into
this plugin is mostly an auth + configuration story — we already have
stdio and Streamable HTTP MCP transports.

## Sketch

Two paths, not mutually exclusive:

1. **HTTP transport + bearer token (lowest lift).**
   - User obtains a Graph access token via existing tenant tooling
     (PowerShell `Get-MgUserAuthenticationMethod`, Azure CLI device code,
     or the published Graph MCP onboarding flow).
   - User adds an MCP server entry: `transport: http`, `url:
     https://graph.microsoft.com/mcp` (or wherever the official endpoint
     lands), `authorization: Bearer <token>`.
   - Plugin already supports authorization headers and the encrypted
     storage notice. Tokens expire — user re-pastes on expiry. Crude but
     unblocks all read scenarios immediately.

2. **stdio launcher with MSAL helper (better UX).**
   - Ship (or document) a thin Node launcher that does MSAL device-code
     auth on first run, caches refresh tokens in the OS credential vault
     (`keytar`), and spawns the official Graph MCP server with a fresh
     access token in env.
   - User configures `command: npx`, `args: ["@chris/obsidian-graph-mcp"]`.
   - Refresh handled out of band; no token in plugin settings.

## Risks

- **Tenant policy.** Many tenants require approval for new app
  registrations or block device-code flow. The proposal must document the
  required Graph permissions (`Mail.Read`, `Calendars.Read`,
  `ChannelMessage.Read.All`, etc.) and how an admin would consent.
- **Write scopes.** Read-only is a safe v1. Anything that sends mail or
  posts to Teams must route through the plugin's existing per-tool
  approval prompt and ideally a dry-run/preview affordance.
- **Token leakage.** Bearer tokens in `data.json` (even encrypted at rest
  by Obsidian's safe storage) are still recoverable on the host. The
  AUTHORIZATION notice we already show covers this, but we should add a
  louder warning for Graph specifically because the blast radius (whole
  mailbox + Teams history) is larger than typical local-tool servers.

## Open questions

- Does the official Microsoft Graph MCP Server expose Streamable HTTP, or
  is it stdio-only on launch?
- Is there a published tenant-onboarding checklist we can link to from our
  README instead of duplicating it?
- Should we ship a curated "server templates" list in settings so users
  can one-click add a pre-configured Graph entry?

## References

- [Overview of Microsoft MCP Server for Enterprise](https://learn.microsoft.com/en-us/graph/mcp-server/overview)
- [Get started with the Microsoft MCP Server for Enterprise](https://learn.microsoft.com/en-us/graph/mcp-server/get-started)
- [microsoft/mcp catalog](https://github.com/microsoft/mcp)
- This plugin's HTTP transport policy: `src/mcp/httpPolicy.ts`
- This plugin's authorization storage notice:
  `AUTHORIZATION_STORAGE_NOTICE` in `src/settings/McpServersSection.ts`
