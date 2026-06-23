# Microsoft 365 Graph MCP — user guide

The plugin ships with a built-in preset that connects to the Microsoft
365 Graph MCP server using a token from the [Azure
CLI](https://learn.microsoft.com/cli/azure/install-azure-cli).
This document walks you through it end to end.

## What this is

The **Microsoft 365 Graph MCP** is a remote MCP server published by
Microsoft at `https://mcp.svc.cloud.microsoft/enterprise`. When you
connect, your chat gets a small set of Graph-backed tools that the
agent can call to answer questions about your identity and (subject to
the limits described in [Permission scopes and 403
errors](#permission-scopes-and-403-errors)) other Microsoft 365 data.

The plugin authenticates to the server with a bearer token minted by
`az` and refreshes the token automatically before it expires. No
secret is pasted into the plugin and no token is written to disk.

## Quick start

1. **Install the Azure CLI** if you don't already have it
   ([install docs](https://learn.microsoft.com/cli/azure/install-azure-cli)).
   On Windows: `winget install Microsoft.AzureCLI`.
2. **Sign in:** `az login --tenant <your-tenant>`. Verify with
   `az account show` that the tenant matches the one your Microsoft
   365 mailbox lives in.
3. In Obsidian, open **Settings → Copilot Agent → MCP Servers → Add
   server**.
4. Pick **Microsoft 365 Graph (via Azure CLI)** from the Preset
   dropdown. Every field is pre-filled.
5. Click **Save**, then **Test connection** on the new row. You should
   see a green check and a credential expiry approximately one hour
   in the future. (If the install hint warns that `az` is missing,
   install it and click Save again — saving is never blocked by a
   failing preflight.)
6. Open a **new** chat (existing chats have their tool list locked at
   creation), and ask something only Graph can answer, e.g. "Use
   Microsoft Graph to tell me my display name and email."

If the agent calls a Graph tool and the answer is grounded in your
tenant data, you're done.

## How the credentials work

The preset configures a **command-based credential**:

| Field | Value |
| --- | --- |
| Kind | `command-based` |
| Command | `az account get-access-token --scope api://e8c77dc2-69b3-43f4-bc51-3213c9d915b4/.default --output json` |
| Token path | `accessToken` |
| Expiry path | `expiresOn` |
| Refresh buffer | 300 seconds |

Every time the plugin needs to make an MCP request it asks the
in-memory credential resolver for a token. The resolver:

- Returns the cached token if its expiry is more than `refreshBuffer`
  seconds in the future.
- Otherwise runs the configured command, parses the JSON output, and
  caches the new `accessToken` until `expiresOn - refreshBuffer`.

Resolved tokens **live only in memory.** They are never written to
`data.json`, never written to any log, and never appear in error
messages — all error paths run through a redactor that strips
`Bearer ...` substrings.

You can configure any command whose stdout is a JSON object containing
a token and an expiry timestamp. The default JSON paths (`accessToken`
+ `expiresOn`) match Azure CLI's output; if you wrap another CLI in a
helper script that emits a different shape, set the **Token path** and
**Expiry path** fields accordingly.

## Permission scopes and 403 errors

The M365 Graph MCP server publishes its OAuth scope set under
`/.well-known/oauth-protected-resource/enterprise`. The only scope it
accepts is `api://e8c77dc2-69b3-43f4-bc51-3213c9d915b4/.default` —
which is precisely what the preset asks for. **The plugin is not
configurable to request additional scopes against this server**, and
attempting to add them on the `az` command would either fail at the
token endpoint or be rejected by the server (wrong audience).

Server-side, the MCP host then performs **on-behalf-of (OBO)**
exchange to Microsoft Graph using its own app registration's
delegated Graph permissions. Whether a given Graph call succeeds
depends on:

1. **Which delegated Graph permissions the MCP service's app
   registration is consented for** in your tenant.
2. **Whether the calling client (Azure CLI) has been pre-consented**
   for the scopes you need against the MCP service.

In practice, the `az`-CLI path reliably unlocks **identity / profile
queries** (`User.Read`-class data). Calendar, mail, files, Teams, and
other Graph areas frequently return **HTTP 403 Forbidden** because the
required delegated permission has not been granted to the
Azure-CLI/MCP-service pair.

This is a fundamental property of the OBO architecture, not a plugin
bug. The forward path is tracked in:

- [`proposals/0006-tool-picker-and-scope-aware-credentials.md`](../proposals/0006-tool-picker-and-scope-aware-credentials.md)
  — per-tool-group scope selection driven by an `oauth-pkce`
  credential variant against a client app registration the user owns.
- [`proposals/0007-importable-preset-packs.md`](../proposals/0007-importable-preset-packs.md)
  — importable preset packs so per-product Graph MCPs (mail,
  calendar, teams, etc.) can be added as separate stdio servers via
  curated packs distributed outside this repo.

If your organization ships an internal CLI that proxies per-product
Graph endpoints as stdio MCP servers (mail, calendar, etc.), you can
configure each as a stdio MCP server manually today; the importable
preset packs proposal above tracks a less-manual path.

## Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| Settings row shows `az not found on PATH` hint after Save | Azure CLI not installed, or not on the PATH Obsidian sees | Install `az`; on Windows reopen Obsidian after install so `PATH` is refreshed |
| **Test connection** fails with `Credential command exited with code 1` | `az` is installed but not signed in to the right tenant | Run `az login --tenant <tenant>`; re-test |
| Test connection succeeds but a chat tool call returns **401** | Token was invalidated mid-call (rare). Plugin retries once after re-resolving | If it recurs, click **Reconnect** on the row |
| Chat tool call returns **403 Forbidden** | Scope limitation, see [Permission scopes and 403 errors](#permission-scopes-and-403-errors) | Not fixable from the plugin |
| `Credential command timed out` | Slow `az` invocation (interactive prompt, locked credential file) | Run `az account get-access-token --scope api://...` manually to surface the underlying error |
| `Credential command output missing field 'accessToken'` | Custom command emits a different JSON shape | Adjust the **Token path** field on the credential row |
| Connection works once, then a later call fails with a redirect error | Server is redirecting cross-origin | Expected — `Authorization` is intentionally dropped on cross-origin redirects; the request fails closed. Configure the canonical URL the server expects |

For an authoritative redirect/policy reference, see the architectural
notes in [`.paw/work/authenticated-mcps/Docs.md`](../.paw/work/authenticated-mcps/Docs.md).

## Custom commands

The credential resolver works with any command-based source. To wrap a
different CLI:

1. Write a small script that runs the CLI and emits a JSON object on
   stdout with at least an access token and an ISO-8601 expiry
   timestamp:

   ```json
   { "accessToken": "<token>", "expiresOn": "2026-06-23T17:11:00Z" }
   ```

2. Use the script as the **Command** value on a custom MCP server
   row. Leave **Token path** and **Expiry path** at their defaults
   (`accessToken` / `expiresOn`) if your JSON matches the shape
   above; otherwise enter your own field names.

3. Make sure the script exits 0 on success and writes any diagnostic
   chatter to stderr (stdout must be the JSON only).

## Security posture

- **Resolved tokens live in memory only.** They never touch
  `data.json`, log files, Notices, or error messages. Internal
  redaction is enforced on every error surface.
- **Command strings DO persist in `data.json` in plaintext.** Avoid
  embedding secrets directly in the command — invoke a CLI that
  manages its own credentials (like `az`) instead.
- **Static-bearer credentials persist their token in `data.json` in
  plaintext.** This is supported for parity with v0.5 but
  command-based is strongly preferred for long-lived secrets. Avoid
  static-bearer in vaults that sync.
- **All existing v0.5 HTTP guardrails apply unchanged** to credential-
  bearing requests: TLS-required for non-loopback, private-network
  confirmation, cloud-metadata block, cross-origin `Authorization`
  strip, redirect cap.

## Forward compatibility

The credential schema includes a reserved `oauth-pkce` variant
(see [`proposals/0006`](../proposals/0006-tool-picker-and-scope-aware-credentials.md))
whose fields round-trip losslessly through save/load even though the
variant is not yet active. A future plugin release can light up the
implementation without a settings migration.

The preset registry is currently code-only and ships exactly one entry
(M365 Graph). Importable preset packs are tracked in
[`proposals/0007`](../proposals/0007-importable-preset-packs.md).

### Future direction: single-scope Entra-protected MCP gateways

The `oauth-pkce` credential variant reserved by the schema is designed
to work with future Entra-protected MCP gateways that consolidate the
broader M365 surface (file search, mail, calendar, etc.) behind one
or two unified scopes against a multi-tenant authority. When such a
gateway publishes an MCP endpoint, this plugin's credential schema
will reach it without an architectural change — a single broad-scope
token covers what an `az`-fronted Graph token cannot today.
