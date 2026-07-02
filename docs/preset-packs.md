# Preset packs — user guide

A **preset pack** is a JSON file that bundles one or more MCP server
**presets** (pre-filled Add-Server configurations). Importing a pack
adds its presets to the **Settings → MCP Servers → Add server →
Preset** dropdown so you can configure a server in two clicks. Packs
are inert: importing one never spawns a process, never opens a
network connection, and never auto-enables a server.

This document is the v1 reference for the pack format and the import /
re-import / remove / export flows. The built-in **Microsoft 365 Graph
(via Azure CLI)** preset is covered separately in
[`docs/m365-graph-mcp.md`](m365-graph-mcp.md); packs let you ship your
own.

## What is a preset pack

A pack is a strict-JSON document with a small schema:

```jsonc
{
  "schemaVersion": 1,
  "id": "example-corp-graph",
  "label": "Example Corp Graph",
  "version": "1.0.0",
  "description": "Internal Graph MCP fronts for Example Corp.",
  "presets": [
    { /* preset 1 — see below */ },
    { /* preset 2 — see below */ }
  ]
}
```

> The snippet above uses JSONC `/* … */` comments only for display.
> The on-disk file MUST be strict JSON (no comments) — see "JSONC
> rejection" below.

- `schemaVersion` is always `1` for v1 packs. Future incompatible
  formats will bump this.
- `id` is the **pack id**. Used internally and shown in the imported
  packs list. Lowercase, dashes / underscores / digits.
- `label` is the human-readable pack name shown in the Add Server
  dropdown's group header and the imported packs list.
- `version` is a free-form version string set by the pack author.
- `description` is optional.
- `presets` is a non-empty list of preset entries (see below).

Packs are JSON only — JSONC (`//` and `/* */` comments) is rejected at
parse time.

### Editor integration

Pack authors can point VS Code or another JSON-Schema-aware editor at
the bundled schema for autocomplete and diagnostics:

```json
{
  "$schema": "./schemas/preset-pack-v1.json",
  "schemaVersion": 1,
  "id": "example-corp-graph",
  "label": "Example Corp Graph",
  "version": "1.0.0",
  "presets": [
    {
      "id": "internal-mcp-cli",
      "label": "Internal MCP CLI",
      "server": {
        "name": "Internal MCP CLI",
        "transport": "stdio",
        "command": "internal-mcp-cli",
        "args": ["--endpoint", "https://example.org/mcp"]
      },
      "credentials": { "kind": "none" }
    }
  ]
}
```

Use a relative path that makes sense from your pack file, such as
`../docs/schemas/preset-pack-v1.json` when authoring next to this repo.
The plugin does not execute JSON Schema validation at runtime; import
and export continue to use the hand-written validator, including parser
limits, duplicate-id checks, URL host classification, and secret
placeholder handling.

## Pack file format

### HTTP preset example

```json
{
  "schemaVersion": 1,
  "id": "example-org-internal",
  "label": "Example Org Internal",
  "version": "1.0.0",
  "presets": [
    {
      "id": "internal-graph",
      "label": "Internal Graph MCP",
      "description": "Static-bearer-authenticated HTTP MCP.",
      "server": {
        "name": "Internal Graph",
        "transport": "http",
        "url": "https://mcp.example.org/graph"
      },
      "credentials": {
        "kind": "static-bearer",
        "token": "__NEEDS_VALUE__"
      }
    }
  ]
}
```

When this pack is imported and the preset is applied via Add server,
the form pre-fills name, transport, URL, and credential kind. The
`__NEEDS_VALUE__` placeholder is recognized as a templatized secret:
the **Authorization** field is rendered empty with `aria-required` and
a hint reading *"Pack-templatized: please supply a value before
saving (authorization)."* Save is hard-blocked until the user supplies
a real token.

### Stdio preset example

```json
{
  "schemaVersion": 1,
  "id": "example-org-tools",
  "label": "Example Org Tools",
  "version": "1.0.0",
  "presets": [
    {
      "id": "internal-mcp-cli",
      "label": "Internal MCP CLI",
      "server": {
        "name": "Internal MCP",
        "transport": "stdio",
        "command": "internal-mcp-cli",
        "args": ["--mode", "graph"],
        "env": {
          "MCP_LOG_LEVEL": "info",
          "INTERNAL_TOKEN": "__NEEDS_VALUE__"
        }
      },
      "credentials": { "kind": "none" }
    }
  ]
}
```

For stdio presets, `command`, `args`, and `cwd` are structural and
flow into the form as-is. Each `env` value is checked: a literal
`__NEEDS_VALUE__` renders that key empty and adds `env.<KEY>` to the
required-fields list. Save is blocked until every templatized env
value is filled in.

### Command-based credentials

```json
"credentials": {
  "kind": "command-based",
  "command": "internal-token-helper",
  "args": ["--profile", "internal"],
  "tokenPath": "accessToken",
  "expiryPath": "expiresOn",
  "refreshBufferSeconds": 300
}
```

Command-based credentials describe a CLI that emits JSON containing a
token. `command`, `args`, `tokenPath`, `expiryPath`, and
`refreshBufferSeconds` are **structural** — never templatized, never
required-on-import. The plugin already separates CLI invocation
(public, like `az`) from token resolution (handled inside the CLI's
process), so packs can ship command-based credentials end-to-end with
no user input required, matching the built-in M365 preset's pattern.

### Reserved-but-inert credential variants

The `oauth-pkce` credential variant is accepted by the schema and
round-trips losslessly through import / export. **No runtime resolver
is wired for it in v1** — the first tool call against a server using
`oauth-pkce` will throw a `not-implemented` error. Pack authors
should NOT use `oauth-pkce` in shippable v1 presets.

## Import a pack

1. Open **Settings → Copilot Agent → MCP Servers**.
2. Scroll to the **Imported preset packs** section.
3. Click **Import pack from file…** and pick a `.json` file.
4. Review the **confirm dialog** — it lists the pack id, label,
   version, and preset count.
5. Click **Confirm** to persist the pack and refresh the Add Server
   dropdown.

Packs between 100 KB and 1 MB import successfully but show a
"large pack" notice in the confirm dialog so you know what you're
about to persist. Packs over 1 MB are rejected before parse with a
"pack too large" error. Schema or parse errors surface a single
user-visible message naming the offending field path or parse
location; nothing is persisted.

The imported packs list shows one row per pack with its label, id,
version, on-disk source path, and import timestamp.

## Re-import / update

Re-importing a pack you already have works the same as the first
import — the confirm dialog adapts:

- **No changes** (canonical content byte-equal to the persisted
  pack): the dialog shows "no changes" and updates only the import
  timestamp. Existing servers configured from the pack are
  unaffected.
- **Changed**: the dialog shows a structural diff of added,
  removed, and changed preset ids. Changed presets include a short,
  capped field-level summary such as `label changed` or
  `server.command changed`; secret-bearing fields show only placeholder
  state, never raw secret values. Top-level metadata changes (`label`,
  `version`) surface as an additional presentation aid.

The diff is **structural** over canonical JSON (keys normalized,
whitespace collapsed, import metadata excluded) with semantic field
annotations for changed presets.

## Remove a pack

Click **Remove** on a pack row, confirm the prompt, and the pack's
presets disappear from the Add Server dropdown immediately.

**Removing a pack never touches `mcpServers`.** Servers previously
configured from that pack's presets continue to start, accept
requests, and respond identically to before the removal. This is
guaranteed by FR-008 and verified by the test suite.

## Export servers as a pack

To bundle one or more configured servers into a pack JSON for
sharing:

1. **Settings → MCP Servers → Export servers as pack…**
2. Optionally edit the pack id, label, and version (defaults
   `exported-pack` / `Exported servers` / today's date).
3. Tick the servers to include.
4. Click **Export**. The plugin writes the pack to
   `<your-vault>/exported-packs/<slug>.pack.json` and surfaces a
   Notice with the absolute path.

To export a single configured server, click **Export this server as
pack…** on that server's row. The dialog is the same export pipeline
without the checkbox list, defaults the pack id and label from the
server name, and writes a one-preset pack.

### Secret-templating contract

Export does NOT include any real credentials. Every secret-bearing
field is replaced with the literal placeholder `__NEEDS_VALUE__`. On
import, the placeholder is recognized and surfaced as a required form
field per the templates above. The rules per credential kind are:

| Credential kind | Templatized on export | Structural (kept verbatim) |
| --- | --- | --- |
| `none` | nothing | (no credential fields) |
| `static-bearer` | `token` | (n/a) |
| `command-based` | (nothing) | `command`, `args`, `tokenPath`, `expiryPath`, `refreshBufferSeconds` |
| `oauth-pkce` (reserved) | `refreshTokenRef`, `tenantId`, and any unknown field (defensive default) | `clientId`, `authorizationEndpoint`, `tokenEndpoint`, `scopes`, `redirectUri`, `pkceMethod` |

For stdio servers, `env` values are templatized when the env key is
in the form-level denylist (the same list the live form validator
uses); non-denylisted values are preserved verbatim. `command`,
`args`, and `cwd` are always structural.

Authors who place literal secret material inside `command-based.args`
(e.g. `--api-key <literal>`) are responsible for redacting before
export — the system does not content-scan args.

### Round-trip guarantee

A pack with 1, 5, and 20 presets is verified by the test suite to
round-trip through export → import without loss for every
non-secret field. Secret fields exported as `__NEEDS_VALUE__`
re-surface as required form inputs on import.

## Conflict namespacing (FR-013)

When an imported preset's `id` collides with another preset, the
plugin applies these rules deterministically:

1. **Imported pack collides with a built-in preset id**: the imported
   preset is namespaced as `<packId>.<presetId>` and its display
   label is suffixed with ` (from <packLabel>)`. The built-in keeps
   its bare id.
2. **Two imported packs share an id**: **both** imported presets are
   namespaced as `<packId>.<presetId>` with the same display-label
   suffix.
3. **Duplicate ids within a single pack**: rejected by the validator
   at import time.

Worked example: built-in pack ships `graph`; you import a pack `acme`
that also defines `graph`. The dropdown shows two entries: **Microsoft
365 Graph (via Azure CLI)** (built-in, id `graph`) and **Graph (from
Acme)** (id `acme.graph`).

## Safety model

- **Packs are inert.** Import never spawns a process, opens a
  network connection, or writes to disk outside the plugin's own
  settings.
- **First spawn still hits the safety prompt.** The first time you
  enable a server configured from a pack preset, the existing
  MCP-server safety prompt (host class, private-network confirmation,
  etc.) applies in full. Packs do not unlock or pre-grant anything.
- **Importing never auto-enables a server.** The user must
  explicitly add a server through the form (which goes through the
  full validator).
- **No new runtime trust surface.** Pack data flows are limited to
  schema validation and settings persistence. No fetch, exec, or
  eval is added by the pack feature.

## Troubleshooting

| Symptom | Likely cause | Resolution |
| --- | --- | --- |
| "pack too large" error before the confirm dialog appears | File is > 1 MB | Split the pack; v1 caps at 1 MB |
| "large pack" notice in the confirm dialog | File is between 100 KB and 1 MB | Informational; Confirm still proceeds |
| Single validation error mentioning a field path or `/presets/N/...` pointer | Schema violation | Fix the listed field; nothing was persisted |
| Parse error citing a line/column | JSON is malformed (or contains JSONC comments) | Strip comments; validate JSON; re-import |
| Imported pack's presets are missing from the dropdown | Pack id collision (FR-013) | Look for namespaced entries `<packId>.<presetId>` |
| Save blocked on a templatized field | Pack preset's secret was templatized on export | Fill the **Authorization** / env / etc. field with a real value |
| Pack file written to `exported-packs/` not visible in the OS file picker | Obsidian's vault adapter writes inside the vault — open `<vault>/exported-packs/` in your file manager | (No remediation; this is expected) |
| Removing a pack also removed my configured server | This will never happen — see FR-008 | (If it does, file an issue with the data.json before and after) |
