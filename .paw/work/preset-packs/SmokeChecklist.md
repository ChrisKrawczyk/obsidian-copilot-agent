# preset-packs — Manual Smoke Checklist

Run from a fresh vault with the v0.8 plugin freshly deployed. Each
item names the success criterion (SC-###) from
[`Spec.md`](./Spec.md) it verifies. Tick boxes as you go; record
failures inline.

This checklist covers PUBLIC-repo behaviour only.

## Prerequisites

- [ ] Plugin built and deployed (`npm run deploy`) and reloaded in
      Obsidian (command palette → "Reload app without saving").
- [ ] Fresh vault recommended. If reusing a vault, note the
      pre-existing `mcpServers` / `mcpPresetPacks` keys in
      `.obsidian/plugins/obsidian-copilot-agent/data.json` so you can
      diff after.
- [ ] You have a generic fixture pack at hand. Create
      `fixture-pack.json` in a scratch folder containing:
      ```json
      {
        "schemaVersion": 1,
        "id": "smoke-fixture",
        "label": "Smoke Fixture",
        "version": "1.0.0",
        "presets": [
          {
            "id": "echo-http",
            "label": "Echo HTTP",
            "server": {
              "transport": "http",
              "name": "Echo HTTP",
              "url": "https://example.org/echo"
            },
            "credentials": { "kind": "static-bearer", "token": "__NEEDS_VALUE__" }
          },
          {
            "id": "echo-stdio",
            "label": "Echo Stdio",
            "server": {
              "transport": "stdio",
              "name": "Echo Stdio",
              "command": "internal-mcp-cli",
              "args": ["--echo"]
            },
            "credentials": { "kind": "none" }
          }
        ]
      }
      ```

## SC-001 — Import a pack file

- [ ] Settings → Copilot Agent → **MCP Servers** → **Imported preset
      packs** subsection visible (empty list).
- [ ] Click **Import pack…**, choose `fixture-pack.json`.
- [ ] Confirmation surface shows pack label, version, preset count,
      and the absolute source path.
- [ ] Confirm. Pack appears in the imported-packs list with its
      label, version, preset count, source path, and "imported at"
      timestamp.
- [ ] **Add server** → preset dropdown shows the built-in M365 group
      first, then a **Smoke Fixture** optgroup containing both
      `Echo HTTP` and `Echo Stdio`. No process spawned, no network
      activity observed.

## SC-002 — Re-import surfaces a structural diff

- [ ] Without changing the file, **Import pack…** again with the
      same file. Confirmation surface reports "no changes detected"
      (or equivalent empty-diff text); no list-row metadata churn.
- [ ] Edit `fixture-pack.json`: change `Echo HTTP` label to
      `Echo HTTP (renamed)` and bump `version` to `1.0.1`.
- [ ] Re-import. Confirmation surface shows a diff containing the
      changed preset id and a version bump. Confirm.
- [ ] Imported-packs list row shows the new version. Dropdown shows
      the renamed label.

## SC-003 — Remove pack does NOT touch configured servers (FR-008)

- [ ] From the dropdown, select **Echo Stdio** under the Smoke
      Fixture group. Form pre-fills name `Echo Stdio`, transport
      stdio, command `internal-mcp-cli`, args `--echo`.
- [ ] Save. New server row appears in **MCP Servers**.
- [ ] In the imported-packs list, click **Remove** for Smoke Fixture.
      Confirm.
- [ ] Pack disappears from the list. The configured `Echo Stdio`
      server row **remains** and is unchanged (name, transport,
      command, args identical).
- [ ] **Add server** dropdown no longer offers the Smoke Fixture
      group. Built-in presets still listed first.

## SC-004 — Export configured servers as a pack (round-trip)

- [ ] Configure at least one server (e.g. the Echo Stdio row from
      SC-003, plus a server with a static-bearer token).
- [ ] In the **MCP Servers** section header, click **Export servers
      as pack…**.
- [ ] Dialog lists every configured server with a checkbox; provide
      `packId` (`smoke-export`), `label` (`Smoke Export`),
      `version` (`1.0.0`); select all; **Export**.
- [ ] A success notice names the written file under
      `<vault>/exported-packs/`. Open the file: every secret-bearing
      field is the literal string `__NEEDS_VALUE__`. Command-based
      `command`, `args`, `tokenPath`, `expiryPath`, and
      `refreshBufferSeconds` are preserved verbatim (FR-020).
- [ ] **Import pack…** the exported file in the same vault.
      Dropdown gains a **Smoke Export** group.
- [ ] Selecting an exported preset that contained a static-bearer
      pre-fills the form and surfaces the hint
      **"Pack-templatized: please supply a value before saving
      (token)"**, and the token input has `aria-required="true"`.
      Save is rejected until the field is populated.

## SC-007 — Pack-size thresholds (FR-023)

- [ ] Create a `large-pack.json` ≈ 200 KB (e.g. by duplicating
      presets with distinct ids). Import → confirmation surface
      shows a "large pack" notice but accepts.
- [ ] Create an oversize pack > 1 MB. Import → rejected before
      parse with a clear size-limit message. No partial state
      written to `data.json`.

## SC-006 — Built-in preset path unchanged

- [ ] In a vault with no imported packs, **Add server** → select
      the built-in **Microsoft 365 Graph (via Azure CLI)** preset.
      Form pre-fills exactly as in v0.7; the preflight hint about
      `az` availability appears as before.
- [ ] No `executableExists` (or equivalent fs probe) is invoked
      when selecting a **pack** preset (verified in tests; manual
      check: pack preset selection is instantaneous and produces no
      filesystem activity in Process Monitor / equivalent).

## Settings-performance NFR measurement (Spec.md NFR §"Settings tab latency")

Record the environment once:

- OS / version: __________________________________________________
- CPU: ___________________________________________________________
- RAM: ___________________________________________________________

Baseline (no imported packs):

- [ ] Open the Settings tab and navigate to **Copilot Agent →
      MCP Servers**. Record perceived open time (rough wallclock,
      e.g. stopwatch): **___ ms**.
- [ ] Open an existing MCP server row for edit; click **Save** with
      no changes. Record perceived save time: **___ ms**.

Loaded (five 100 KB packs + one 1 MB pack imported):

- [ ] Re-open Settings → MCP Servers. Record open time: **___ ms**.
- [ ] Edit + Save an existing server (no changes). Record save
      time: **___ ms**.

Pass criteria — both deltas (loaded − baseline) ≤ **200 ms**:

- [ ] Open-time delta: ___ ms ≤ 200 ms — **PASS / FAIL**
- [ ] Save-time delta: ___ ms ≤ 200 ms — **PASS / FAIL**

Record these numbers in the Final PR description.

## SC-005 — Private-pack end-to-end smoke

Recorded out-of-band.

## Sign-off

- [ ] All public SCs above pass.
- [ ] Settings-performance NFR measured and within budget.
- [ ] Private-pack smoke (SC-005) recorded out-of-band.

Tester: __________________  Date: __________  Plugin SHA: ____________
