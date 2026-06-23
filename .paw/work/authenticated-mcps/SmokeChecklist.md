# authenticated-mcps — Manual Smoke Checklist

Run from a fresh vault with the v0.7 plugin freshly deployed. Each
item names the success criterion it verifies. Tick boxes as you go;
record failures inline.

## Prerequisites

- [ ] Azure CLI installed and on PATH (`az --version`).
- [ ] Signed in to the target tenant: `az login --tenant <tenant>`;
      `az account show` matches the tenant your M365 mailbox lives in.
- [ ] Plugin deployed via `npm run deploy` and reloaded in Obsidian
      (command palette → "Reload app without saving").

## SC-001 — Preset apply produces a working server

- [ ] Settings → Copilot Agent → MCP Servers → **Add server**.
- [ ] Preset dropdown lists **Microsoft 365 Graph (via Azure CLI)**.
- [ ] Selecting the preset pre-fills name, transport (http), URL
      (`https://mcp.svc.cloud.microsoft/enterprise`), credential kind
      (command-based), command, token path, expiry path, refresh
      buffer (300s) — no manual edits required.
- [ ] **Save** succeeds without further input.

## SC-002 — Connected server returns tenant-grounded data

- [ ] After Save, the row shows a credential expiry roughly one hour
      out within ~5 seconds.
- [ ] **Test connection** on the row reports success.
- [ ] Open a **new** chat (existing chats lock their tool list at
      creation).
- [ ] Ask: "Use Microsoft Graph to tell me my display name and email."
- [ ] The agent invokes an `mcp__<server-id>__*` Graph tool. After
      approval, the response contains **your actual display name and
      email** (not generic text).

> **Scope limit.** Calendar / mail / Teams / files Graph areas
> typically return HTTP 403 server-side via OBO when reached through
> the `az`-CLI credential path. This is expected and documented in
> [`docs/m365-graph-mcp.md`](../../../docs/m365-graph-mcp.md) §
> "Permission scopes and 403 errors". The forward path is tracked in
> [`proposals/0006`](../../../proposals/0006-tool-picker-and-scope-aware-credentials.md)
> and [`proposals/0007`](../../../proposals/0007-importable-preset-packs.md).
> Profile-level data is the bound for SC-002 via this preset.

## SC-003 — Token survives expiry boundary

- [ ] Note the credential expiry shown on the row.
- [ ] Leave the chat session open until the expiry is in the past
      (or wait until the in-memory cache TTL elapses).
- [ ] Issue a follow-up identity question in the same chat.
- [ ] The tool call **succeeds**. No re-auth prompt, no visible
      reconnect. (The resolver runs `az account get-access-token`
      again silently.)

## SC-004 — Failure surfaces in both settings row AND chat

- [ ] In Settings, edit the M365 server's credential to a
      deliberately broken command (e.g. set Command to `az account
      get-access-token-broken` to force a non-zero exit).
- [ ] In a new chat, ask the same identity question.
- [ ] The settings row shows a credential error pill (e.g.
      "credentials rejected" or "command failed").
- [ ] The chat tool call returns an error message that **includes a
      copyable remediation hint** (e.g. "run `az login`…" if `az` is
      present, or the install hint if not).
- [ ] **Only one** error appears per call — not a flood. Revert the
      command after this test.

## SC-005 — Custom command works without code changes

- [ ] Write a small shell helper (or Python / Node script) that
      emits, e.g., `{ "accessToken": "<some-token>",
      "expiresOn": "<ISO-timestamp>" }` on stdout.
- [ ] Add a custom HTTP MCP server pointing to a server that
      accepts that token. Set Command to the helper, leave Token
      path / Expiry path at defaults.
- [ ] Save → Test connection succeeds with no plugin code change.
- [ ] Optional alternate-shape variant: modify the helper to emit a
      nested JSON (e.g. `{ "result": { "token": "...", "exp_iso":
      "..." } }`), update Token path to `result.token` and Expiry
      path to `result.exp_iso`, verify connection still works.

## SC-006 — No token in logs / Notices / errors

- [ ] Open Obsidian's developer console (Ctrl+Shift+I).
- [ ] Trigger several Graph tool calls (success and failure).
- [ ] Search the console for any substring of the real token value
      (copy from `az account get-access-token --output json` to know
      what to search for). **No matches expected.**
- [ ] Confirm no Notice text in the bottom-right of the Obsidian
      window contains a token substring.
- [ ] Inspect `data.json` under the plugin folder; confirm
      `accessToken` literal does not appear. (Static-bearer
      credentials WILL show their literal in `data.json` by design;
      this check is for command-based.)

## SC-007 — Existing servers and tests unaffected

- [ ] If you had any pre-v0.7 MCP server configured (stdio Foam,
      OneDrive, etc.), it connects unchanged on plugin reload.
- [ ] A v0.6-shape HTTP server with top-level `authorization` loads,
      shows in the new UI as `static-bearer`, and continues to work.
- [ ] Automated: `npx vitest run` reports 1289 tests passing (as of
      v0.7 release).

## SC-008 — `oauth-pkce` schema round-trips

- [ ] Automated only: `src/settings/McpSettingsStore.test.ts`
      includes a byte-equivalence round-trip for every enumerated
      `oauth-pkce` field. Verify the test runs and passes.

## SC-009 — HTTP guardrails apply to credential-bearing requests

- [ ] Edit a server URL to a cross-origin redirect target (e.g.
      route through a small local proxy that returns a 302 to a
      different hostname).
- [ ] Trigger any tool call.
- [ ] The post-redirect request **does not carry the Authorization
      header**. The credential resolver is not re-invoked for the
      redirected origin. (Verify in dev console Network panel if
      visible; otherwise verify via server-side request log.)
- [ ] Configure a server with a private-network URL (e.g.
      `https://192.168.1.10:9999/mcp`). Save requires private-
      network confirmation. After confirmation, the credential-
      bearing request goes through.

## SC-010 — Preflight install hint is proactive

- [ ] Rename `az.cmd` on PATH (or temporarily remove `az` from PATH
      for one shell session and relaunch Obsidian from that shell).
- [ ] Open Settings → MCP servers → Add → select M365 preset.
- [ ] The install hint appears **inline in the form before saving**
      — the user does not have to save and then attempt a chat call
      to discover `az` is missing.
- [ ] Saving is still allowed (FR-018: non-blocking).
- [ ] Restore `az` and confirm the hint disappears on re-select.

---

## Recording results

For each item, mark one of:

- `pass` — exact behavior matches.
- `pass-bounded` — behavior matches within a documented scope (e.g.
  SC-002 for identity but not calendar).
- `fail` — behavior is wrong; file an issue with the row and
  diagnostic output.
- `n/a` — environment doesn't allow this check (e.g. SC-007
  legacy-shape if you've never had a pre-v0.7 server).
