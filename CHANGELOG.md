# Changelog

All notable changes to this project are documented in this file.
The format is loosely based on [Keep a Changelog](https://keepachangelog.com/).

## [0.2.0] – 2026-06-10

### Added

- Keyboard-first chat input: Enter sends, Shift+Enter inserts a newline, IME composition is respected, empty/whitespace input is rejected. Enter is inert while a response is streaming (Stop is the only cancel path).
- Vault-aware preamble assembled on the first send of each session: vault root path, timezone, today, inventory of available vault tools, and an authoring-conventions block (wikilinks, hash-prefixed tags, Tasks-plugin checkbox syntax). Configurable via Settings → Copilot Agent → Vault Awareness (Default / Custom / None).
- Vault Awareness settings: mode toggle, custom-body textarea with `{{VAULT_ROOT}}` / `{{VAULT_TIMEZONE}}` / `{{VAULT_TODAY}}` / `{{VAULT_TOOL_INVENTORY}}` / `{{AUTHORING_CONVENTIONS}}` placeholders, default task target (today's daily note or custom path).
- Read-only vault-aware tools (auto-approved, no prompt): `get_active_note`, `list_recent_notes`, `find_backlinks`, `vault_tree`, `vault_metadata`, `find_tasks`, plus `open_note` (navigation only).
- Mutating vault-aware tools (one approval each, journal-undoable): `create_note`, `edit_note`, `insert_into_active_note`, `create_daily_note`, `create_task`, `update_task`.
- Daily Notes core plugin integration: `create_daily_note` honors the configured folder/format/template, falls back to `<vault-root>/YYYY-MM-DD.md` when disabled.
- Tasks community plugin integration: `create_task` auto-detects plugin presence and emits the matching flavor (📅/✅/⏳/➕/❌ emoji syntax when present, GFM `(field: value)` syntax otherwise). `createdDate` (➕) defaults to today.
- `update_task` structured patch tool: change status / priority / tags / due date / scheduled date / description on a single task line, with two-tier re-anchor (byte-exact `expectedRawLine` then `descriptionMatch`), idempotent status auto-stamping (`done` → ✅ today, `cancelled` → ❌ today), recurrence and block-ID preservation via an `extras` pass-through, and format-source preservation (tasks-plugin stays tasks-plugin, GFM stays GFM).

### Changed

- v0.1 tools (`view`, `read_file`, `search_content`, `create_file`, `edit_file`, `delete_file`) remain registered as defensive fallbacks. Each new capability with a fallback path reports `usedFallback: boolean` in its result.
- Test count: 166 → 401 (+235 across new domain, tool, and UI suites).

### Security / Privacy

- The default preamble sends only vault root path + timezone + today + tool inventory + authoring conventions. **No folder or file enumeration, no note contents, no recent-activity metadata, no per-file timestamps.** Folder/file structure is available on demand via the auto-approved `vault_tree` / `vault_metadata` tools. Users with the most sensitive vaults can set Vault Awareness to **None** to suppress the preamble entirely.
- The universal permission gate (`decideSafety`) is unchanged from v0.1. Every mutating capability — including `update_task` — registers without `skipPermission`, so all writes route through the same gate as v0.1's `create_file` / `edit_file` / `delete_file`.

## [0.1.0] – v0.1 private spike

Initial private spike. OAuth Device Flow sign-in via the `gh` CLI client ID, streaming chat with Stop-to-cancel, vault read tools (`view`, `read_file`, `search_content`) exempt from prompts, vault write tools (`create_file`, `edit_file`, `delete_file`) routed through a single deny-by-default approval gate, in-session Undo for any approved write, three-mode safety policy (require-approval / auto-apply-with-undo / allowlist) plus persistent trust scopes (path allowlist, per-built-in toggles). 166 tests across domain, tools, and SDK adapter.
