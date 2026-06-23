# 0007 — Importable / exportable MCP server preset packs

**Status:** Draft
**Created:** 2026-06-23
**Owner:** unassigned
**Depends on:** authenticated-mcps (0.7) — preset registry (`McpServerPreset`),
credential schema (`ServerCredentials` discriminated union)
**Related:** 0006 (tool picker & scope-aware credentials)

## Problem

Today's preset registry (`src/settings/presets/McpServerPresets.ts`)
hardcodes a single built-in preset (M365 Graph via `az` CLI). Adding
more presets means:

1. Code change to the plugin
2. PR + review + ship + user update
3. **Anything that requires referencing an organization-specific or
   environment-specific tool gets stuck.** Many organizations have
   internal CLIs that proxy each of their hosted services as its own
   stdio MCP server (mail, calendar, files, etc.) with their auth model
   already handled. Those would be perfect sets of presets — but they
   cannot be shipped in a community plugin because the tool is
   internal, the install instructions are internal, and the support
   contacts are internal. We don't want any of that leaking into a
   public codebase.

The asymmetry: the *value* of presets scales with how many of them
exist, but the *cost of distribution* fights against tenant-specific,
internal-only, partner-curated, or user-personal entries.

The same problem will recur for any organization with internal MCP
infrastructure (GitHub Enterprise users with private MCPs, partner
ecosystems, etc.). The answer isn't "ship more built-ins"; it's
"let presets be data, not code."

## Sketch

### Preset pack format

A **preset pack** is a JSON document describing one or more
`McpServerPreset` entries:

```jsonc
{
  "$schema": "https://obsidian-copilot-agent.dev/schemas/preset-pack-v1.json",
  "id": "example-internal-mcp-pack",
  "label": "Example Internal MCP Bridges",
  "version": "2026.6.1",
  "presets": [
    {
      "id": "example-mail",
      "label": "Mail (via internal CLI)",
      "description": "Mail MCP server via the org's internal MCP bridge CLI.",
      "server": {
        "name": "Mail",
        "transport": "stdio",
        "command": "internal-mcp-cli",
        "args": ["mcp", "mail"]
      },
      "credentials": { "kind": "none" },
      "preflight": {
        "type": "findOnPath",
        "command": "internal-mcp-cli",
        "installHint": "Install the internal MCP bridge CLI per your org's documentation."
      }
    }
    // ...calendar, files, etc.
  ]
}
```

Schema is intentionally a **direct serialization of `McpServerPreset`'s
build output**, not a new abstraction. A pack is "JSON instead of
code, otherwise identical."

### UI

1. **Settings → MCP servers → Presets section** (new):
   - **Built-in presets** (today's static list, unchanged)
   - **Imported preset packs** (new): list, with origin / version /
     preset count, "remove pack" button per row.
   - **Import pack from file…** button: native file picker → reads JSON
     → validates against schema → adds to user's vault config.
   - **Import pack from URL…** button: paste URL → fetch via
     `requestUrl` (CORS-bypass, see authenticated-mcps Phase 5) →
     validate → confirm preview ("This pack adds 8 presets…") → import.

2. **Export pack from configured servers**: select one or more existing
   MCP server rows → "Export as preset pack" → downloads a JSON file
   with the chosen configurations templatized (server name preserved,
   any per-row runtime state stripped). Useful for sharing a curated
   set across vaults or with a team.

3. **Add server flow**: the preset dropdown today shows built-ins only.
   With this proposal it groups by source ("Built-in", "From <pack
   label>", "From <other pack>"), and otherwise behaves identically.

### Storage

Packs persisted in plugin settings (the existing settings store), under
a new key `mcp.presetPacks`. Each pack contains its own JSON, an
import-time timestamp, and the original source URL/path for re-fetch.
Vault-relative (not cross-vault) — matches how everything else in this
plugin scopes user state.

### Validation

- **Schema validation** at import time using a hand-rolled validator
  (we already validate `ServerCredentials` shapes in
  `mcpServerFormLogic.ts`; reuse the same primitives — do not add a
  JSON-schema library dependency).
- **Preflight checks declared in the pack are non-fatal** (matches
  FR-018: install hints never block).
- **Conflicts**: if an imported preset's `id` collides with another
  pack's or with a built-in id, suffix with the pack id (`agency-mail`
  + pack `internal-microsoft` → effective id
  `internal-microsoft.agency-mail`). Display label disambiguates with
  "(from <pack label>)".
- **No code execution from packs.** Packs are pure data. Commands they
  declare are still subject to all existing safety prompts on first
  invocation, exactly like a manually-typed server config. Importing a
  pack DOES NOT auto-enable any of its servers.

### Internal-only pack (separate distribution)

Once this lands, an "internal Microsoft agency pack" can be published
as a single JSON file on an internal share / internal repo, with
install instructions in internal docs. The public plugin remains free
of any internal tool references. Anyone outside Microsoft can author
the analogous pack for their own ecosystem (e.g. partner MCP catalogs)
without touching plugin source.

## Why not bigger / smaller

- **Smaller (just ship more built-ins):** Doesn't solve the
  internal-vs-public distribution problem; doesn't unlock community
  authoring; keeps plugin tied to a single curator.
- **Bigger (full MCP marketplace, signing, version negotiation,
  central registry):** That's a different product. We deliberately
  scope this to "data file with versioning fields you could later
  expand to support discovery." Start with file/URL import.

## Open questions

- **URL import trust model.** Should URL imports require a checksum
  field that the user pastes alongside the URL (the way `winget`
  manifests work)? Probably yes — minimal safety against a typo
  fetching a different file. Defer details.
- **Signed packs.** If a pack ships executables (it doesn't —
  commands resolve from the user's PATH at runtime), signing would
  matter more. Today the trust surface is "PATH lookup + safety
  prompt on first call", which already exists. Signing optional v2+.
- **Sharing between users.** Pack JSON files travel by any channel
  (email, share drive, repo). No need to invent transport.
- **Updates / pack versions.** Re-import overwrites with a confirmation
  diff ("3 presets changed, 1 added, 0 removed"). Versions are
  display-only for v1.
- **Per-pack toggles.** Could a user disable individual presets within
  an imported pack rather than removing the pack? Not v1; keep
  packs atomic.
- **Cross-platform commands.** A pack from one OS may declare commands
  not present on another. Preflight catches this at use-time; no
  special platform-targeting in v1 (could add later via per-preset
  `platforms: ["win32", "linux", "darwin"]` field).
- **Tool picker (proposal 0006) interaction.** When 0006 lands,
  `toolGroups` would be additional optional fields on each preset.
  Backwards compatible: older plugin versions ignore unknown fields.

## Out of scope (defer)

- Central preset marketplace / discovery service.
- Cryptographic signing of packs.
- Auto-update of imported packs from their source URL.
- Per-server tool subset selection (covered by 0006).
- New credential variants (e.g. real `oauth-pkce`) — orthogonal; this
  proposal is about distribution shape, not new credential kinds.

### Related: future single-scope MCP gateways

As Entra-protected MCP gateways consolidate broad product surfaces
(file search, mail, calendar, etc.) behind one or two unified scopes,
a single preset distributed via this proposal could replace what would
otherwise be many per-product stdio bridges. Such a pack would use the
(future) `oauth-pkce` credential variant — no internal-CLI dependency.
Until that lights up, the internal-pack pattern is the per-product
stdio bridges described in the example above.


## Acceptance criteria (sketch)

- A user can download a JSON pack file, click "Import pack from
  file…", and see the new presets in the Add Server dropdown — no
  plugin update.
- An exported pack from one vault, imported into a second vault on a
  different machine, produces equivalent server configurations.
- Removing a pack also removes its presets from the dropdown (but
  does NOT touch any already-configured servers the user created from
  those presets — those are independent instances).
- Schema validation rejects malformed packs with a single user-visible
  error citing the offending field path.
- An "internal MCP pack" (curated separately, distributed outside
  this repo) can be installed and yields working presets for
  organization-specific MCP servers (e.g. per-product stdio bridges
  fronted by an internal CLI) — verifiable manually, not in the public
  test suite.
