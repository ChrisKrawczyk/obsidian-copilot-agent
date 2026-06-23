# 0006 — Tool picker & scope-aware credential resolution

**Status:** Draft
**Created:** 2026-06-23
**Owner:** unassigned
**Depends on:** authenticated-mcps (0.7) — preset registry + credential
resolver

## Problem

Two related gaps surface as soon as an authenticated MCP server like the
M365 Graph MCP is connected:

1. **No per-session tool selection.** Today every chat session loads the
   union of every enabled server's tools, locked at session creation
   (`McpServersSection.ts:501`). With Graph alone that's ~30+ tools
   spanning mail, calendar, files, Teams, search, etc. — all of them
   weigh on the context window and on the agent's tool-routing accuracy
   even when the user only wants help with one slice (e.g. "summarize my
   inbox" doesn't need Teams/Files tools loaded).

   VS Code Copilot solved this with a tools panel: pick which
   tools/groups participate in this run. We need the Obsidian
   equivalent.

2. **Token scope is fixed at "everything the resource will give you by
   default".** The current credential model resolves a single token per
   server via the configured command (e.g. `az account get-access-token
   --resource https://graph.microsoft.com/.default`). For Microsoft
   Graph this returns a token bound to whatever delegated permissions
   the calling client app has been granted — typically only
   `User.Read`. Confirmed manually 2026-06-23: a Graph profile call
   succeeds, but `/me/calendar/events` returns **403 Forbidden** because
   `Calendars.Read` was never requested.

   Forcing users to discover the right `--scope` flags, edit the
   command, and re-save the server breaks the "select preset → it just
   works" promise of FR-008 / SC-001. We told the user the preset is
   one-click; the moment they ask for their calendar it isn't.

The fix for (1) and (2) is the same shape of feature, which is why
they're folded into a single proposal: **selecting tools should drive
which scopes the credential resolver requests.**

## Sketch

### Data model additions

- **Tool group manifest (per preset).** Extend `McpServerPreset` with an
  optional `toolGroups` field:

  ```ts
  interface ToolGroup {
    id: string;              // "mail", "calendar", "files", "teams"
    displayName: string;     // shown in picker
    description: string;     // one-line user help
    toolPatterns: string[];  // glob / prefix match against tool name from tools/list
    requiredScopes: string[]; // e.g. ["Calendars.Read"]
    enabledByDefault: boolean;
  }
  ```

  For the M365 preset the registry would carry a fixed mapping (mail →
  `Mail.Read`, calendar → `Calendars.Read`, etc.), so the user never
  types a scope.

- **Session tool selection.** A new per-conversation record
  `selectedToolGroups: Record<serverId, string[]>` persisted alongside
  conversation state (or kept in-memory only — open question, see
  below). Empty means "preset default set".

### Scope-aware credential resolution

Today `CredentialResolver` calls `runner.run(command, args, env, ...)`.
Extend to:

```ts
interface CredentialRequest {
  scopes?: string[];  // union of required scopes from selected tool groups
}
runner.run(command, args, env, request)
```

For command-based credentials, the preset declares **how to apply
scopes**:

```ts
interface CommandCredentialScopeBinding {
  // Either: argsTemplate uses ${scopes} as a substitution token
  argsTemplate?: string[];      // e.g. ["account", "get-access-token", "--scope", "${scopes}"]
  // Or: env var: scopes are joined and exported
  envVar?: { name: string; join: string };
}
```

For the M365 preset this becomes:
```
args: ["account", "get-access-token", "--scope", "{scopes}", "--query", "{...}"]
scopes: union(selectedGroups.requiredScopes) || ["https://graph.microsoft.com/.default"]
```

Resolver caches by `(serverId, scopeSet)` so two sessions with different
selections don't trample each other's tokens.

### UI

1. **Per-server tool group toggles in chat composer.** A small
   "Tools…" affordance opens a sheet listing groups per connected
   server, with toggle state seeded from `enabledByDefault`. Selecting/
   deselecting recomputes the scope set for the next user turn.

2. **Settings preview.** The MCP server row in settings shows the
   current default group selection (and lets the user change the
   default for new chats).

3. **Per-tool inspector** (lower priority): expanding a group reveals
   the underlying MCP tool names + the scopes that would be requested.
   Useful for audit / debugging.

### Session lifecycle interaction

The current SDK locks the tool list at `Client` connection time. To
honor mid-session toggles we have two options:

- **A — Restart the runtime on toggle.** Tear down the `Client`, build
  a new one with the new scope-bound token, filter the tool list to
  selected groups. Simple, but a visible reconnect.
- **B — Connect once with the maximum-scope token, filter tools
  locally per turn.** Token is always over-scoped to the union of all
  groups the user has *ever* selected this session. Faster UX, but
  weaker least-privilege story.

Lean A for v1 (matches "select preset and forget" model and aligns
with least-privilege). Revisit B if reconnect latency is felt.

## Why not bigger / smaller

- **Smaller (just a UI hide-toggle):** Doesn't solve the 403 problem.
  Users would still have to edit the `az` command by hand to get
  Calendars.Read, defeating the whole preset story.
- **Bigger (full per-call tool gating like VS Code):** Requires SDK
  changes upstream (mid-session tool re-list) and a richer chat-input
  control. Out of scope for v1; this proposal stays at per-session.

## Open questions

- **Persistence of tool group selection** — per-conversation only, or
  remembered globally? Per-conversation matches "this chat is about my
  calendar" framing; global matches "I generally don't use Teams".
  Probably both, with conversation override.
- **Tools that match no declared group** — show ungrouped under a
  catch-all "Other (server name)" group with no extra scopes?
- **Non-preset servers without `toolGroups`** — fall back to today's
  behavior (all tools loaded, no scope augmentation).
- **`az` `--scope` flag support across versions** — verify which `az`
  CLI versions expose `--scope` on `get-access-token`. Pre-2.50 only
  accepts `--resource`. May need a `scopeSyntax: "scope-flag" |
  "resource-only"` knob on the preset binding.
- **Token vault size** — N tool group combinations could mean N cached
  tokens per server. Cap at, say, 8 most-recent scope sets per server
  and prune.

## Out of scope (defer)

- Full agent-runtime allowlist (which tools a *single turn* can use).
- OAuth-PKCE end-to-end (still tracked separately via FR-012 reserved
  schema).
- Cross-server tool dependencies (e.g. "calendar group needs Graph
  AND outlook-specific server").

## Acceptance criteria (sketch)

- A user can open a fresh chat, see a "Tools" affordance, deselect
  every Graph group except Calendar, ask "what's on my calendar
  today?", and get tenant-grounded data — without editing any token,
  command, or scope string by hand.
- A second chat opened in parallel with different tool groups gets a
  separately-scoped token (verified by inspecting cached `(serverId,
  scopeSet)` entries; no manual reproduction step required).
- Existing users with no group selection see the same behavior as
  today (preset default groups; no breakage).
