---
date: 2026-06-10T10:50:51.523-07:00
git_commit: ea0450ef649bfa4688896f7f0ed4243cdf54fe17
branch: feature/chat-ux-vault-tools
repository: obsidian-copilot-agent
topic: "Phase 6 update_task + find_tasks"
tags: [research, codebase, tasks, vault-tools]
status: complete
last_updated: 2026-06-10
---

# Research: chat-ux-vault-tools

## Phase 6 Research: update_task + find_tasks

### Documentation System

- **Framework**: Plain Markdown; no docs framework/config found in root file globs (`README.md:1-96`, `package.json:8-14`).
- **Docs Directory**: N/A; standard root docs only (`README.md:1-96`, `.github\copilot-instructions.md`).
- **Navigation Config**: N/A.
- **Build Command**: N/A for docs; code build is `npm run build` (`package.json:8-14`, `README.md:80-86`).
- **Standard Files**: `README.md`; no root `CHANGELOG.md` / `CONTRIBUTING.md` found by root markdown glob.

### Verification Commands

- **Test Command**: `npm test` (`package.json:8-14`, `README.md:80-86`).
- **Lint Command**: N/A; no lint script in `package.json` (`package.json:8-14`).
- **Build Command**: `npm run build` (`package.json:8-14`, `README.md:80-86`).
- **Type Check**: `npm run typecheck` (`package.json:8-14`, `README.md:80-86`).

### 1. Tasks plugin status syntax

- Tasks core statuses are conventional Markdown `- [ ]` and `- [x]`; docs call these the core statuses Tasks knows without custom status setup (Tasks docs: `Getting Started/Statuses.md`, "Core Statuses").
- Tasks custom statuses are keyed by the single character between `[` and `]`; status types include `TODO`, `IN_PROGRESS`, `DONE`, `CANCELLED`, `NON_TASK` (Tasks docs: `Getting Started/Statuses.md`, "What's IN a Status?").
- `- [/]` is a recognized in-progress marker in Tasks' one-click status collections:
  - Minimal Theme maps `/` to name `incomplete`, type `IN_PROGRESS` (Tasks docs: `Reference/Status Collections/Minimal Theme.md`, supported statuses/table).
  - SlRvb's Alternate Checkboxes maps `/` to `Half Done`, type `IN_PROGRESS`; it also maps `d` to `Doing`, type `IN_PROGRESS` (Tasks docs: `Reference/Status Collections/SlRvb's Alternate Checkboxes.md`, supported statuses/table).
- `- [I]` is not the in-progress marker in the checked docs: Minimal maps `I` to `idea` / `TODO`; SlRvb maps `I` to `Information` / `TODO` (same two Tasks docs pages above).
- `- [-]` is the cancellation marker in those collections: Minimal maps `-` to `canceled` / `CANCELLED`; SlRvb maps `-` to `Dropped` / `CANCELLED` (same two Tasks docs pages above).
- Obsidian's own metadata cache stores only the raw task status character; it does not expose Tasks-plugin status-type semantics (`node_modules\obsidian\obsidian.d.ts:3705-3718`).

### 2. Completion/cancellation date stamps

- Tasks uses due `📅 YYYY-MM-DD`, scheduled `⏳ YYYY-MM-DD`, start `🛫 YYYY-MM-DD`, created `➕ YYYY-MM-DD`, done `✅ YYYY-MM-DD`, and cancelled `❌ YYYY-MM-DD` (Tasks docs: `Getting Started/Dates.md`, sections "Due date", "Scheduled date", "Start date", "Created date", "Done date", "Cancelled date").
- Done examples use `- [x] ... ✅ 2021-04-09`; cancelled examples use `- [-] ... ❌ 2021-04-09` (Tasks docs: `Getting Started/Dates.md`, "Done date" and "Cancelled date").
- Recurrence uses `🔁` followed by a recurrence rule, and recurring examples retain the recurrence marker when tasks complete (Tasks docs: `Getting Started/Recurring Tasks.md`, "Usage" / examples).
- Current local task formatting already emits Tasks emoji for priority/due/scheduled/created/tags and GFM inline metadata for priority/due/scheduled/created/tags (`src\tools\TaskFormat.ts:39-49`, `src\tools\TaskFormat.ts:64-86`; tests in `src\tools\TaskFormat.test.ts:4-137`).

### 3. metadataCache for task discovery

- Obsidian `CachedMetadata` includes `listItems?: ListItemCache[]` (`node_modules\obsidian\obsidian.d.ts:1402-1442`).
- `ListItemCache.task?: string` is documented as the single checkbox status character; space means incomplete, any other character is interpreted as completed by Obsidian, and `undefined` means the list item is not a task (`node_modules\obsidian\obsidian.d.ts:3705-3718`).
- Cache positions use `Loc.line`, documented as 0-based (`node_modules\obsidian\obsidian.d.ts:3840-3848`).
- `MetadataCache.getFileCache(file)` returns `CachedMetadata | null` (`node_modules\obsidian\obsidian.d.ts:4371-4375`).
- Existing `ObsidianApi.FileCacheLike` currently exposes tags/headings/frontmatter/links only, not `listItems` (`src\tools\ObsidianApi.ts:43-53`), and `AppLike.metadataCache.getFileCache` returns that narrowed shape (`src\tools\ObsidianApi.ts:96-99`).
- Existing read-note code uses `api.getFileCache(file)` for backlinks/metadata (`src\tools\ReadNoteTools.ts:271-277`) and `ObsidianApi.getFileCache()` wraps native `metadataCache.getFileCache` with `index-unavailable` / `not-found` / `native-failed` outcomes (`src\tools\ObsidianApi.ts:210-230`).
- Existing full-text search enumerates `vault.getMarkdownFiles()`, validates each path, reads content, splits by lines, and returns 1-based line numbers (`src\tools\ReadTools.ts:275-359`).

### 4. Existing line-targeted editing patterns

- No existing helper was found for "edit one line in place"; current write handlers compose whole-file content and call `vault.modify`.
- `editFileImpl` validates the vault path, looks up the file, reads full prior content, checks open-editor dirty state, writes full replacement content with `deps.vault.modify`, and records one `modify` undo entry with full before/after content (`src\tools\WriteTools.ts:130-196`).
- `editNoteImpl` similarly reads full content, composes append/prepend/replace into full `after`, checks dirty editor state, then uses `api.modifyNote` or falls back to `editFileImpl` (`src\tools\WriteNoteTools.ts:128-221`).
- `createTaskImpl` creates or reads the target, reads full current content, checks dirty editor state, appends one formatted line, calls `editFileImpl` with full next content, and returns the modify/create undo id (`src\tools\WriteNoteTools.ts:493-645`).
- `UndoJournal.record()` records successful actions only, and `modify` undo restores `before` after checking current content still equals recorded `after` (`src\domain\UndoJournal.ts:65-81`, `src\domain\UndoJournal.ts:133-157`).

### 5. Approval-prompt rendering

- Tool-call blocks render arguments/results/errors as plain text inside `<pre>` via `makeLabeledPre`; `textContent` is used, so content is not interpreted as Markdown/HTML (`src\ui\ToolCallBlock.ts:105-120`, `src\ui\ToolCallBlock.ts:208-219`).
- Pending approval renders `approval.summary` as plain text and `approval.detail` as a `<pre>` with `textContent`, truncated to 4000 chars (`src\ui\ToolCallBlock.ts:135-153`, `src\ui\ToolCallBlock.ts:222-224`).
- Therefore a multi-line approval detail such as `before:\n<line>\nafter:\n<line>` is renderable as a plain-text block (`src\ui\ToolCallBlock.ts:148-153`).
- Message bodies render through Obsidian `MarkdownRenderer`, while tool-call blocks are separate DOM nodes rendered above the message body (`src\ui\MessageRenderer.ts:139-183`, `src\ui\MessageRenderer.ts:220-226`).
- No diff-formatting helper was found; available helper is generic labeled `<pre>` (`src\ui\ToolCallBlock.ts:208-219`).
- Tool-call re-render signature includes approval summary length but not approval detail length (`src\ui\MessageRenderer.ts:267-286`).

### 6. SafetyPolicy classification

- Safety source buckets and defaults are documented in `SafetyPolicy`: vault/extra-vault are configurable, MCP/builtin require approval by default (`src\domain\SafetyPolicy.ts:9-18`, `src\domain\SafetyPolicy.ts:19-50`).
- `decideSafety()` handles `source: "vault"` by checking session grant, vault allowlist, default auto-apply mode, otherwise require approval (`src\domain\SafetyPolicy.ts:146-180`).
- `VAULT_WRITE_TOOL_NAMES` is the classification list for vault-mutating tools and currently includes `create_task` plus `create_file`, `edit_file`, `delete_file`, `create_note`, `edit_note`, `insert_into_active_note`, and `create_daily_note`; `open_note` is intentionally excluded as read-equivalent navigation (`src\tools\WriteTools.ts:362-381`).
- `AgentSession.buildSafetyInput()` classifies `kind === "custom-tool"` with `toolName` in `VAULT_WRITE_TOOL_NAMES` as `source: "vault"` and passes the extracted vault path into SafetyPolicy (`src\sdk\AgentSession.ts:1241-1266`).
- `main.ts` registers read tools, write tools, read-note tools, and write-note tools in one `tools` array; safety `extractVaultPath` uses `args.path` except special cases for `create_daily_note` and `insert_into_active_note` (`src\main.ts:173-183`, `src\main.ts:190-210`).
- Read-only note tools such as `find_backlinks` and `vault_tree` set `skipPermission: true` directly (`src\tools\ReadNoteTools.ts:97-154`). The read-tool exemption checklist is documented in `ReadTools.ts` (`src\tools\ReadTools.ts:39-78`).
- Vault tool inventory is centralized in `vaultToolManifest`; `create_task` is currently listed as write/non-read-only, while `find_backlinks` and `vault_tree` are listed read-only (`src\domain\vaultToolManifest.ts:71-97`, `src\domain\vaultToolManifest.ts:103-147`).

### 7. `parseTaskLine` design hints

- Current exported task types are `TaskPriority`, `TaskInput`, `TaskFormatSource`, and `STRICT_DATE_REGEX`; `TaskInput` has description/due/scheduled/created/priority/tags only (`src\tools\TaskFormat.ts:18-37`, `src\tools\TaskFormat.ts:51-52`).
- `formatTaskLine()` always emits `- [ ]` today, so parse/update will need to model status in addition to existing `TaskInput` fields (`src\tools\TaskFormat.ts:64-86`).
- Public signature shape to plan against:
  - `parseTaskLine(line: string): { ok: true; parsed: TaskInput & { status: "todo" | "in-progress" | "done" | "cancelled"; completedDate?: string; cancelledDate?: string; leadingIndent: string; source: TaskFormatSource; rawStatusSymbol: string } } | { ok: false }`
- Unparseable/non-task lines can return `{ ok: false }`; this matches existing result-union style in `ObsidianApi` (`src\tools\ObsidianApi.ts:26-41`) and write tool errors (`src\tools\WriteNoteTools.ts:62-67`).
- Date validation can reuse `STRICT_DATE_REGEX` for strict `YYYY-MM-DD` fields (`src\tools\TaskFormat.ts:51-52`; test coverage in `src\tools\TaskFormat.test.ts:139-159`).

### 8. Risks / blockers

- Obsidian cache task line numbers are 0-based (`node_modules\obsidian\obsidian.d.ts:3840-3848`), while existing search results return 1-based line numbers (`src\tools\ReadTools.ts:344-347`); Phase 6 inputs specify `lineNumber` and should document/align the convention.
- `metadataCache.getFileCache(file)` may return `null` (`node_modules\obsidian\obsidian.d.ts:4371-4375`); existing wrapper surfaces `not-found` / `index-unavailable` (`src\tools\ObsidianApi.ts:215-230`).
- `ListItemCache.task` exposes only the raw status character and Obsidian's own incomplete/completed interpretation, not Tasks custom status types (`node_modules\obsidian\obsidian.d.ts:3711-3718`); status type mapping is external to metadataCache.
- `listItems` locates tasks but does not expose the full raw line or parsed description in the type excerpt; existing tools read file content when snippets/raw lines are needed (`src\tools\ReadTools.ts:320-348`).
- Existing write path refuses to overwrite dirty open-editor buffers via `hasUnsavedEditorChanges` (`src\tools\WriteTools.ts:103-128`, `src\tools\WriteTools.ts:166-176`).
- `update_task` will be a new mutating custom tool name; current vault-write classification list does not include it yet (`src\tools\WriteTools.ts:371-378`).
- `find_tasks` will be a new read-only custom tool name; current read-note manifest/tool factory does not include it yet (`src\domain\vaultToolManifest.ts:71-97`, `src\tools\ReadNoteTools.ts:51-183`).

### Code References

- `src\tools\TaskFormat.ts:18-37` - Current task input/source types.
- `src\tools\TaskFormat.ts:64-86` - Current task formatter and field ordering.
- `src\tools\WriteNoteTools.ts:493-645` - Current `createTaskImpl` target resolution, format-source detection, append write, and undo result.
- `src\tools\ReadNoteTools.ts:97-154` - Existing skip-permission read-only note tools to mirror for `find_tasks`.
- `src\tools\WriteTools.ts:371-381` - Vault-write tool-name classification list for SafetyPolicy.
- `node_modules\obsidian\obsidian.d.ts:1402-1442` - `CachedMetadata.listItems`.
- `node_modules\obsidian\obsidian.d.ts:3705-3718` - `ListItemCache.task`.
- `src\ui\ToolCallBlock.ts:135-153` - Approval prompt body rendering as plain-text `<pre>`.
