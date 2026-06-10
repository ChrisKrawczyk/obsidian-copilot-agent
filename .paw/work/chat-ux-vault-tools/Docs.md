# Chat UX & Vault-Aware Tools (v0.2)

## Overview

v0.2 extends the v0.1 Copilot agent plugin so it feels native to Obsidian. Three pillars:

1. **Keyboard-first chat input** — Enter sends, Shift+Enter inserts a newline, IME composition is respected, empty input is rejected. Streaming-state keys never trigger Stop.
2. **Vault-aware preamble** — a deterministic system block prepended on the first send of every session that names the available vault tools (so the model uses them instead of `shell` for discovery), exposes vault root path + timezone + today, and encodes Obsidian authoring conventions (wikilinks, hash-prefixed tags, Tasks-plugin checkbox syntax).
3. **Thirteen Obsidian-API-backed capabilities** — six writers (`create_note`, `edit_note`, `open_note`, `insert_into_active_note`, `create_daily_note`, `create_task`), five auto-approved readers (`get_active_note`, `list_recent_notes`, `find_backlinks`, `vault_tree`, `vault_metadata`), plus a task-editing pair (`find_tasks` read-only + `update_task` writer) that supersede ad-hoc edits to checkbox lines.

The v0.1 tools (`view`, `read_file`, `search_content`, `create_file`, `edit_file`, `delete_file`) remain registered as defensive fallbacks (FR-020). The universal permission gate (`decideSafety`) is unchanged and remains the only path to vault mutation.

## Architecture and Design

### High-Level Architecture

```
 Obsidian UI
   │
   ├── ChatView (src/ui/ChatView.ts)
   │     ├── installChatKeydown(textarea, handlers)   // Enter sends, Shift+Enter newline, IME-aware
   │     └── Undo button → UndoJournal.undo(id)
   │
   ▼
 CopilotAgentSession (src/sdk/AgentSession.ts)
   ├── First-send preamble prepender ─── PreambleAssembler ─── VaultAwarenessSettingsStore
   │                                          (vault root + tz + today + tool inventory +
   │                                           authoring conventions)
   ├── onPermissionRequest ──── decideSafety (unchanged from v0.1)
   └── tools[]:
        ├── v0.1 tools (createReadTools, createWriteTools)
        ├── createReadNoteTools  → get_active_note, list_recent_notes, find_backlinks,
        │                          vault_tree, vault_metadata, find_tasks
        └── createWriteNoteTools → create_note, edit_note, open_note, insert_into_active_note,
                                    create_daily_note, create_task, update_task

 Each capability calls into ObsidianApi (src/tools/ObsidianApi.ts) for the richer
 surface (editor, workspace, metadataCache, internalPlugins), and falls back to
 v0.1 vault-API handlers when the richer surface is unavailable. Mutating
 capabilities call editFileImpl/createFileImpl from v0.1 so they share the
 single UndoJournal entry per approval.
```

### Design Decisions

- **No SDK system-prompt option.** The SDK's `createSession` accepts no preamble field, so v0.2 prepends the assembled preamble to the user's first message inside `sendAndWait`. Subsequent sends are untouched.
- **Augment, not replace.** v0.1 tools stay registered so any regression in a richer surface still has a working fallback. Each new capability reports `usedFallback: boolean` in its result so the model and tests can see which path ran.
- **Deterministic preamble.** The default body is built from vault root path, the tool inventory derived from `vaultToolManifest.ts`, the timezone, today's date, and a fixed authoring-conventions block. **No folder or file enumeration, no note bodies, no per-file timestamps, no recent-activity metadata** — folder/file structure is fetched on demand via the auto-approved read-only `vault_tree` / `vault_metadata` tools (privacy default, SC-005).
- **Single permission gate.** Every mutating capability is registered without `skipPermission`, so each call traverses `CopilotAgentSession.handlePermission → decideSafety` exactly like v0.1's writes. Read-only capabilities and the navigation-only `open_note` set `skipPermission: true` and carry the read-only-checklist JSDoc.
- **Strict-date contract.** Every date input (`dueDate`, `scheduledDate`, `createdDate`, `setDueDate`, `setScheduledDate`) rejects anything other than `YYYY-MM-DD` with a structured `invalid_date_format` error before any vault mutation happens. The model is expected to resolve natural-language phrases ("tomorrow", "next Friday") to strict dates before calling the tool.
- **Format-source preservation.** When the Tasks plugin is detected, new and edited task lines are emitted in tasks-plugin emoji flavor (`📅 2026-06-12 ✅ 2026-06-09`). When absent, GFM flavor (`(due: 2026-06-12) (completed: 2026-06-09)`). `update_task` re-emits using the line's original detected flavor — editing a GFM task does not convert it to emoji.
- **Two-tier re-anchor in `update_task`.** Because line numbers can shift between a `find_tasks` and a subsequent `update_task`, callers pass `expectedRawLine` (byte-exact) primary and `descriptionMatch` (substring) fallback. Optimistic check at the supplied line first, then a file-wide scan if mismatched. Ambiguous matches return `ambiguous_match` with the candidate list and do NOT mutate.
- **Idempotent status auto-stamp.** `setStatus: 'done'` stamps `✅ <today>` only if `completedDate` is currently unset (so re-completing a done task is a no-op — no file write, no journal entry). `cancelled` symmetric. Transitioning back to `todo`/`in-progress` clears both date stamps.
- **Authoring-conventions block** names the tools the model should pick for tasks: "Edit tasks with `find_tasks` → `update_task` rather than `edit_note` / `edit_file`." This nudges the model away from raw text edits that would silently re-emit metadata in the wrong flavor or drop emoji marker order.

### Integration Points

- **v0.1 SafetyPolicy** — `update_task` is registered in `VAULT_WRITE_TOOL_NAMES` so `SafetyState` classifies it as `source: 'vault'` and the path-allowlist and auto-apply paths work uniformly.
- **v0.1 UndoJournal** — every successful mutating capability records one entry via `editFileImpl` / `createFileImpl`. One approval = one Undo button.
- **Obsidian metadataCache** — `find_backlinks` consults `metadataCache.resolvedLinks` first; falls back to a bounded scan when the cache is cold. `find_tasks` consults `metadataCache.getFileCache(file).listItems` to enumerate only checkbox lines without re-parsing every file.
- **Daily Notes core plugin** — `create_daily_note` reads `internalPlugins.plugins['daily-notes']` config (folder + format + template). Falls back to `<vault-root>/YYYY-MM-DD.md` when the plugin is disabled.
- **Tasks community plugin** — detection is best-effort via `plugins.plugins['obsidian-tasks-plugin']` and per-line markers (`📅`, `✅`, `🔁`, `🛫`, `⏳`, `➕`, `❌`, priority emoji). When detected, output uses tasks-plugin syntax.

## User Guide

### Prerequisites

- v0.1 plugin installed and signed in (OAuth Device Flow via `gh` CLI client ID).
- A vault with at least one markdown file is fine; many features work on an empty vault but task tools need at least one task line.
- Optional: enable the Tasks and Daily Notes plugins to exercise SC-004, SC-009.

### Basic Usage

1. **Send a message with the keyboard.** Focus the chat input, type, press **Enter**. The message sends and the input clears. **Shift+Enter** inserts a newline. While a response is streaming, Enter is inert (the Stop button is the only way to cancel).
2. **Ask for context-aware actions.** Because the preamble names the vault-aware tools, prompts like "what note do I have open?", "list my five most recently edited notes", "what notes link to Welcome.md?" route to single auto-approved tool calls (`get_active_note`, `list_recent_notes`, `find_backlinks`) instead of `shell` discovery.
3. **Create / edit a note.** "Create a note titled Meeting Notes" → one approval → `create_note` writes `Meeting Notes.md` at vault root and the file appears in Obsidian's file explorer immediately. "Append a TODO list to the active note" → one approval → `insert_into_active_note` (or `edit_note` if no editor is active) with the v0.1 dirty-buffer guard preserved.
4. **Create today's daily note.** "Create today's daily note" → `create_daily_note` uses the Daily Notes plugin's configured folder/format/template if enabled; otherwise writes `<vault-root>/YYYY-MM-DD.md`. One approval.
5. **Add a task.** "Add a task to email Bob tomorrow with high priority" → `create_task` writes `- [ ] Email Bob ⏫ 📅 <tomorrow> ➕ <today>` (tasks-plugin flavor) or the GFM equivalent into the configured target (default: today's daily note). The created-date `➕` is auto-stamped to today unless the caller passes an explicit `createdDate` (e.g. backdating).
6. **Find and edit tasks.** "List my overdue work tasks" → `find_tasks` with `status: 'todo'`, `tag: 'work'`, `dueBefore: <today>`. "Mark that one done" / "tag all my communication tasks with #comms" → one `update_task` per result, each a single approval that yields one Undo button. Re-running an already-applied edit is idempotent (no file write).

### Advanced Usage

- **Vault Awareness Settings.** Settings → Copilot Agent → Vault Awareness. Modes: **Default** (vault root path + timezone + today + tool inventory + authoring conventions — no folder/file enumeration), **Custom** (user-supplied body with placeholders `{{VAULT_ROOT}}`, `{{VAULT_TIMEZONE}}`, `{{VAULT_TODAY}}`, `{{VAULT_TOOL_INVENTORY}}`, `{{AUTHORING_CONVENTIONS}}`), **None** (preamble suppressed entirely — for sensitive vaults). Changes apply on next session start.
- **Default task target.** Settings → Copilot Agent → Vault Awareness → Default task target. "Today's daily note" (default — uses Daily Notes config) or "Custom path" (a fixed vault-relative file path, useful for an `Inbox.md`-style workflow).
- **Re-anchoring updates.** `update_task` always re-anchors before writing: it tries the supplied `line`, then byte-exact `expectedRawLine` scan, then `descriptionMatch` substring scan. If neither uniquely identifies a line, it returns `ambiguous_match` with the candidate list and refuses to write. This is the recommended pattern for `find_tasks → update_task` pipelines — pass `expectedRawLine` straight through from the find result.
- **Recurrence preservation.** Editing a task with `🔁 every Sunday` preserves the marker verbatim via the `extras` pass-through. `create_task` does not emit recurrence; add it via `edit_note` or the Tasks-plugin modal first, then `update_task` for subsequent edits.

## API Reference

### Read-only capabilities (auto-approved — `skipPermission: true`)

| Tool | Signature (input → result) | Notes |
|---|---|---|
| `get_active_note` | `{} → { path, content }` | Returns the active editor's note or `not_found` if no editor active. |
| `list_recent_notes` | `{ n?: number=20 } → { notes: Array<{path, mtime}> }` | Sorted by mtime desc. `n` clamped to [1, 100]. |
| `find_backlinks` | `{ targetPath } → { backlinks: Array<{sourcePath, linkForm: 'wikilink'\|'markdown', original}>, usedFallback }` | Uses `metadataCache.resolvedLinks` when available; bounded-scan fallback. |
| `vault_tree` | `{ folder?, depth?=2 } → { tree, truncated }` | `folder` defaults to vault root. `depth` capped at 6. Node count internally bounded; `truncated: true` when cap hit. |
| `vault_metadata` | `{ path } → { headings, tags, frontmatter }` | Body NOT returned (SC-012). |
| `find_tasks` | `{ path?, status?, tag?, dueBefore?, dueAfter?, descriptionRegex? } → { results, truncated, scanned }` | 500-result cap; 5MB per-file cap. Filters AND-composed. 1-based line numbers in output. Structured errors: `invalid_regex`, `invalid_date_format`. |
| `open_note` | `{ path } → { ok, path }` | Navigation only — no read/write. Registered with `skipPermission: true`. |

### Mutating capabilities (approval-gated, undoable)

| Tool | Signature | Notes |
|---|---|---|
| `create_note` | `{ path, content? }` | No overwrite — `path_exists` error on collision. |
| `edit_note` | `{ path, mode: 'append'\|'prepend'\|'replace', content }` | Dirty-buffer guard refuses when the file has unsaved editor changes. |
| `insert_into_active_note` | `{ mode: 'append'\|'prepend'\|'replace', content }` | Uses the live editor surface when one is open (Obsidian Ctrl+Z handles undo); otherwise falls back to a disk write recorded in the Undo journal. |
| `create_daily_note` | `{}` | Resolves folder + format via `internalPlugins.plugins['daily-notes']`. Creates today's note if absent; opens it either way. |
| `create_task` | `{ description, priority?, dueDate?, scheduledDate?, createdDate?, tags? }` | `createdDate` defaults to today. Strict `YYYY-MM-DD`. Auto-detects tasks-plugin vs GFM flavor. Appends to settings-configured target (default: today's daily note). |
| `update_task` | `{ path, line, expectedRawLine?, descriptionMatch?, patch }` | Patch fields: `setStatus`, `addTags`, `removeTags`, `setPriority\|null`, `setDueDate\|null`, `setScheduledDate\|null`, `setDescription`. Returns `{ ok: true, changed, changedFields[], before, after, line, undoId, undoSurface }` on success, structured errors otherwise: `task_not_found`, `ambiguous_match` (with candidates), `not_a_task`, `not_found`, `invalid_date_format`, `invalid_status`. |

### Task line format

```
- [<status>] <description> [<priority>] [📅 due] [⏳ scheduled] [➕ created] [✅ completed] [❌ cancelled] [#tag ...] [extras]
```

Stable field order in both flavors. `extras` carries unmodeled trailing tokens (recurrence `🔁 every Sunday`, block IDs `^abc123`, unknown emoji + payloads) and is preserved verbatim across `update_task` round-trips.

Status checkbox symbols (matches Tasks plugin status-collection convention):

| Status | Symbol |
|---|---|
| `todo` | `- [ ]` |
| `in-progress` | `- [/]` |
| `done` | `- [x]` |
| `cancelled` | `- [-]` |

Auto-stamp behavior on `setStatus`:

| New status | Effect |
|---|---|
| `done` | `completedDate ← today` (only if unset; preserves existing); `cancelledDate ← cleared` |
| `cancelled` | `cancelledDate ← today` (only if unset); `completedDate ← cleared` |
| `todo`, `in-progress` | both date stamps cleared |

### Configuration Options

Settings → Copilot Agent → **Vault Awareness**:

- **Mode**: Default | Custom | None
- **Custom body** (textarea, shown when mode = Custom). Placeholders: `{{VAULT_ROOT}}`, `{{VAULT_TIMEZONE}}`, `{{VAULT_TODAY}}`, `{{VAULT_TOOL_INVENTORY}}`, `{{AUTHORING_CONVENTIONS}}`.
- **Default task target**: Today's daily note | Custom path
- **Custom task target path** (shown when target = Custom path).

Settings → Copilot Agent → **Safety** (unchanged from v0.1):

- Default safety mode: `require-approval` (v0.1 default) / `auto-apply-with-undo` / `allowlist`
- Path allowlist (vault-relative directories that bypass the prompt)
- Per-built-in auto-approve toggles (`shell`, `web_fetch`, `write`, …)

## Testing

### How to Test

Repository tests (run before any change):

```
npm test          # vitest run — 401 tests across domain, tools, sdk, ui
npm run typecheck # tsc --noEmit
npm run build     # production esbuild
npm run deploy    # copy main.js, manifest.json, styles.css to .deploy-target
```

### Edge Cases

- **IME composition.** Enter during composition does not send; only Enter after composition completes does.
- **Empty / whitespace input.** Rejected — input stays focused.
- **Dirty editor buffer.** `edit_note` and `update_task` refuse when the target file has unsaved editor changes; same error shape as v0.1.
- **Line shifts between `find_tasks` and `update_task`.** Two-tier re-anchor handles it transparently. If the task no longer exists or matches multiple lines, the call returns `task_not_found` / `ambiguous_match` and does not mutate.
- **Duplicate task descriptions.** `descriptionMatch` (without `expectedRawLine`) returns `ambiguous_match` with candidates.
- **Re-completing a done task.** Idempotent no-op — preserves the original `completedDate`, writes nothing, adds no journal entry, but still returns `ok: true` with `changed: false` and `changedFields: []`.
- **Recurring tasks.** `🔁 every Sunday` marker preserved across `update_task` calls via the `extras` pass-through.
- **Tasks plugin absent.** Output and parser both transparently use GFM `(due: …)` / `(completed: …)` syntax; flavor is preserved per-line on round-trip.
- **Daily Notes plugin absent.** `create_daily_note` falls back to `<vault-root>/YYYY-MM-DD.md`. (SC-003)

## Verification Matrix

| SC | Statement | Coverage |
|---|---|---|
| SC-001 | Create-note from fresh session — exactly one approval, no preceding discovery. | Manual: "create a note titled Meeting Notes" → one approval → `Meeting Notes.md` appears. Verified 2026-06-10. Automated: `WriteNoteTools.test.ts` (`createNoteImpl` happy path + collision). |
| SC-002 | Enter-to-send / Shift+Enter newline / IME composition respected. | Automated: `src/ui/chatKeydown.test.ts` (11 tests covering Enter, Shift+Enter, IME `isComposing`, `keyCode===229`, whitespace-only). Manual: verified 2026-06-10. |
| SC-003 | Daily-notes-disabled vault: today's daily note created at vault root in one approval. | Manual: verified 2026-06-10 (vault without Daily Notes core plugin). Automated: `DailyNotePath.test.ts` (fallback path). |
| SC-004 | Daily-notes-enabled vault: file lands at configured folder/format. | Manual: enable Daily Notes core, set folder=`Daily/`, format=`YYYY-MM-DD`; ask agent for today's daily note → file appears under `Daily/`. Verified 2026-06-10. |
| SC-005 | Default preamble sends only vault root + tz + today + tool inventory + conventions — no folder enumeration, no body content, no recent-activity metadata, no per-file timestamps. | Automated: `PreambleAssembler.test.ts` (deterministic fixture asserts exact emitted shape). |
| SC-006 | Vault Awareness = None → next session's preamble is empty. | Automated: `PreambleAssembler.test.ts` (`none` mode test). Manual: toggle, restart session, verify no preamble in first message. Verified 2026-06-10. |
| SC-007 | Existing v0.1 tests pass unchanged; ≥40 new tests added. | Automated: `npm test` reports **401/401** (was 166/166 at v0.1; +235 net). |
| SC-008 | v0.2 richer-surface failure → fallback produces same on-disk file as v0.1 + same approval gate. | Automated: `WriteNoteTools.test.ts` (`usedFallback: true` paths for create_note when richer surface unavailable). |
| SC-009 | Tasks plugin installed → one approval yields a Tasks-plugin-compatible line that shows in queries + Calendar. | Manual: enable Tasks plugin, add a task with due date, run `tasks` codeblock query; verify line appears. Verified 2026-06-10 (smoke). |
| SC-010 | Authoring-conventions block prompts wikilink output. | Manual: ask agent for a note referencing another vault note → result uses `[[Note]]` syntax. Verified 2026-06-10. Automated: preamble fixture asserts the conventions sentence is present. |
| SC-011 | "What's in my vault?" → one `vault_tree` auto-approved call, no `shell` discovery. | Manual: verified 2026-06-10. |
| SC-012 | "What tags does <note> have?" → one `vault_metadata` auto-approved call, no body read. | Manual: verified 2026-06-10 (`vault_metadata` reports headings + tags + frontmatter for `Welcome.md`). |

## Limitations and Future Work

- **Approval prompt shows args only.** SDK's permission callback fires before the tool handler runs, so a `update_task` no-op still shows an approval the user could have skipped if a preflight hook existed. Mitigation: the completed-body of an applied tool call shows `before:` / `after:`, so the actual change is visible at review time. Future enhancement when SDK exposes a preflight hook.
- **Approval pane CSS.** The chat pane's Undo / Reject buttons can be clipped when the right sidebar is heavily compressed. Workaround: widen the pane. (Tracked as a Phase Candidate.)
- **No live settings reload.** Vault Awareness changes apply on next session start; in-flight sessions retain the originally assembled preamble.
- **Mobile not supported.** Desktop only, consistent with v0.1.
- **Periodic Notes plugin not integrated.** Only Daily Notes core. Weekly/monthly notes via Periodic Notes are out of scope for v0.2.
- **`update_task` does not understand `🔁` semantics.** Recurrence markers are preserved verbatim but not parsed; completing a recurring task does not auto-spawn the next instance. Use Tasks plugin's own "Toggle done" command for native recurrence rolling.
- **Workflow B (extra-vault roots, MCP, model selection, cross-restart resume) is out of scope** — tracked as deferred candidates in `.paw/work/copilot-sdk-spike/ImplementationPlan.md`.
