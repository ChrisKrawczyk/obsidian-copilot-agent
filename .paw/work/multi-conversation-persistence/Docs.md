# Multi-Conversation & Persistence (v0.3)

## Overview

v0.3 turns the Copilot agent plugin into a long-lived workspace that survives plugin reload, Obsidian restart, and OS reboot. Three pillars:

1. **Multi-conversation model.** A conversation picker at the top of the chat pane lets you create, switch, rename, and delete conversations. Up to 20 active conversations live in the picker; the 21st automatically archives the oldest non-active one. Each conversation has its own message history, undo journal, and runtime — switching is instantaneous and the chat scroll position is preserved.
2. **Cross-restart persistence.** The conversation list, per-conversation messages, and per-conversation undo journals are written to the plugin's `data.json` via debounced writes (≤1 per 500 ms). After a restart, the plugin re-hydrates the previously active conversation, the model name reappears in the header, and any unredo'd Undo buttons remain clickable.
3. **Vault-first by default.** A new safety toggle "Expose v0.1 raw-filesystem tools" (default **ON**) keeps the v0.1 raw-FS tools available as a defensive fallback while the preamble's tool inventory marks them as `(fallback)` so the model reaches for the vault-aware tools first. Users who want a strictly vault-only surface can toggle the setting OFF; the change applies on the next plugin reload. Three new auto-approved read-only search tools — `search_by_tag`, `search_by_name`, `list_all_tags` — round out vault discovery.

The v0.2 contracts are preserved verbatim: every mutating tool still flows through `decideSafety`, the keyboard chat surface is unchanged, the vault-aware preamble continues to fire on the first send of each session, and the v0.2 thirteen vault-aware capabilities are unchanged.

## Architecture and Design

### High-Level Architecture

```
 Obsidian UI
   │
   ├── ChatView (src/ui/ChatView.ts)
   │     ├── ConversationPicker (src/ui/ConversationPicker.ts)  — header dropdown
   │     ├── installChatKeydown(textarea, handlers)              — v0.2 keyboard
   │     └── Undo button → runUndoFlow → UndoJournal.undo(id, opts?)
   │                                          (divergence-aware retry)
   │
   ▼
 ConversationManager (src/domain/ConversationManager.ts)
   ├── Map<convId, ConversationRuntime>      — lazy materialisation
   ├── persistMetadataOnly / persistMessageAppend / persistMessageReplace
   ├── makePersistAdapter(id) → onJournalOp("add" | "mark-undone" | "evict")
   └── emits: list-changed, active-changed, metadata-changed
   │
   ▼
 ConversationRuntime (src/domain/ConversationRuntime.ts)
   ├── ChatState                — per-conversation messages
   ├── AgentSession             — per-conversation Copilot SDK session
   └── UndoJournal              — per-conversation undo journal
                                  (loadOptions.ttlMs defensive backstop)
   │
   ▼
 ConversationsStore (src/persistence/ConversationsStore.ts)
   ├── load() / pruneOnLoad()                — 7-day undo TTL
   ├── upsertConversation / removeConversation / setActiveId
   ├── appendMessage / replaceMessage
   ├── recordUndo / markUndone / removeUndoEntry
   └── flushImmediate            — debounced writeback (500 ms),
                                   immediate on quit / markUndone,
                                   one-shot 5 MB Notice (SC-011)
   │
   ▼
 Obsidian Plugin.saveData() / Plugin.loadData()
   data.json: { schemaVersion, conversations[], activeConversationId,
                auth, safety, settings }    ← sibling keys preserved
```

### Design Decisions

- **Per-conversation runtime, lazy-materialised.** Each conversation owns a `ConversationRuntime` with its own `ChatState`, `AgentSession`, and `UndoJournal`. Runtimes are constructed on first access (`getActiveRuntime()` / hydration / explicit visit) so a vault with twenty conversations doesn't pay for twenty SDK sessions on plugin onload. The active runtime is materialised on `onload` BEFORE auth hydrates so the broadcasting `tokenSink.reconnect()` finds a live model id and the header status pill displays the current model immediately.
- **Single-writer persistence with sibling-key preservation.** `ConversationsStore.flushImmediate()` is the only writer for the `conversations` / `activeConversationId` / `schemaVersion` keys. It re-reads `data.json` before each write and merges into a fresh top-level shape so concurrent stores (`TokenStore` for `auth`, `SafetySettingsStore` for `safety` / `settings`) do not lose their keys. All writes serialise through `this.tail` so a debounced flush followed by a `flushNow()` cannot interleave.
- **Debounce + immediate-on-quit + immediate-on-undo.** Routine writes batch on a 500 ms debounce (NFR for chat responsiveness). Two paths bypass the debounce: (1) the `quit` workspace event awaits a final `flushNow()` so OS-level shutdown still persists everything (FR-008); (2) `markUndone()` calls `flushNow()` synchronously after marking dirty so a fast restart cannot resurrect a dismissed Undo (FR-013).
- **Corruption recovery path.** When `loadData()` returns a payload that fails schema validation, `ConversationsStore` writes the malformed blob verbatim to `<pluginDataDir>/conversations_recovery.bak.json` and proceeds with default state. Sibling keys (`auth`, `safety`, `settings`) survive because the recovery path only resets the conversation subtree (FR-010, SC-001).
- **Cross-restart Undo: TTL + cap + content-based divergence.** Undo entries persist alongside their conversation. `ConversationsStore.pruneOnLoad()` is the authoritative pruner — it drops entries older than 7 days across every conversation (including never-opened ones) at plugin startup. The new `UndoJournal.loadOptions.ttlMs` is a defensive backstop that fires only when a runtime hydrates; matching evictions propagate to the store via `removeUndoEntry`. The 50-entry per-conversation cap (SF-2) is enforced at `record()` time in lockstep across journal and store. Divergence is detected by **byte-for-byte content comparison** (current file content vs `e.after` snapshot) — no mtime/size fields are stored. When divergence is detected, the journal returns `{ ok: false, divergence: "modified" | "missing" | "existed", reason }` and the chat view shows a confirmation prompt; the user can override with the same call carrying `{ force: true }`. Once `markUndone` flips an entry to `undone: true`, the entry remains in the journal for replay-context but the Undo button is replaced by a "reverted" pill.
- **Raw-FS gating: next-session-start semantics.** The `exposeRawFsTools` setting defaults **ON** so the v0.1 raw-FS tools (`view`, `read_file`, `search_content`, `create_file`, `edit_file`, `delete_file`) remain registered as a defensive fallback. The default preamble inventory marks every raw-FS bullet with a `(fallback)` tag and instructs the model to reach for the vault-aware tools first — vault first, raw-FS fallback. Users who want a strictly vault-only surface can flip the toggle OFF; its value is captured ONCE at plugin onload (`exposeRawFsToolsAtStartup`) and used to gate the registrations: when OFF, the six raw-FS tools are not registered with the SDK and their bullets are absent from the preamble's inventory. Toggling the setting from the UI persists immediately but does NOT affect the running session — the model continues to see the same tool surface until the next plugin reload (FR-015). The Undo affordance on **historical** raw-FS tool calls is suppressed while the setting is OFF so users can't replay tools they have hidden from the model (FR-016); the call name + result still render so chat scrollback stays readable.
- **One-shot 5 MB notice.** `flushImmediate()` measures the persisted blob via `JSON.stringify(merged).length` and, if it crosses 5 × 1024 × 1024 bytes, fires a single Notice ("Copilot Agent: conversation data exceeds 5 MB. Consider archiving or deleting old conversations."). The flag is in-memory and resets on plugin reload, so users are reminded once per session rather than nagged on every flush (SC-011).
- **Auto-naming first message.** New conversations are seeded with a timestamped placeholder name (`Untitled YYYY-MM-DD HH:MM` in local time). On the first user message, `maybeAutoNameFromFirstMessage` derives a name from the message's first non-empty line (≤ 40 chars, surrogate-pair safe), but only if the current name still matches the default-name predicate so a manual rename always wins (FR-005).
- **21st conversation soft-archive.** Creating the 21st conversation archives the lowest-`lastActiveAt` non-active conversation. Archived conversations are kept on disk (no destructive delete) so a future "Show archived" UI is non-lossy. A one-time Notice surfaces the auto-archive so it doesn't surprise the user (FR-002).

### Integration Points

- **v0.2 vault-aware tools** continue to register on every session. The new search tools (`search_by_tag`, `search_by_name`, `list_all_tags`) join the read-only auto-approved set. Their auto-approval flows through the existing FR-017 gate.
- **v0.2 `CopilotAgentSession` first-send preamble** is unchanged. The preamble's tool inventory bullets are filtered by `exposeRawFsToolsAtStartup` so raw-FS tools disappear when the setting is OFF (matches the actual registered surface).
- **v0.2 `decideSafety`** is unchanged. Cross-restart Undo does not introduce a new permission code path — it only re-hydrates entries that the v0.2 path already gated.
- **v0.2 `UndoJournal`** is extended (not replaced). New surface: `UndoOutcome.divergence`, `UndoOptions.force`, `UndoJournalOptions.{persist, initialEntries, maxEntries, loadOptions, now}`. The legacy `new UndoJournal(vault)` constructor still works for tests that don't need persistence wiring.
- **v0.2 SettingsTab** gains an "Expose v0.1 raw-filesystem tools" toggle. The default-task-target setting is unchanged.

### Persistence Layout (`data.json`)

```jsonc
{
  "schemaVersion": 1,
  "conversations": [
    {
      "id": "conv-…",
      "name": "…",
      "createdAt": 0,
      "lastActiveAt": 0,
      "archived": false,
      "messages": [{ "id": "m-…", "role": "user|assistant|tool|system", "content": "…", "createdAt": 0, "interrupted": false, "toolCalls": [...] }],
      "undoEntries": [{ "id": "u-…", "kind": "create|modify|delete", "scope": "vault", "path": "…", "before": "…", "after": "…", "recordedAt": 0, "undone": false }]
    }
  ],
  "activeConversationId": "conv-…",
  "auth":     { /* TokenStore — preserved across writes */ },
  "safety":   { /* SafetySettingsStore — preserved */ },
  "settings": { /* SafetySettingsStore — preserved */ }
}
```

Invariants:
- The `conversations` subtree is byte-identical between an idle restart and the immediately-prior on-disk state (SC-001) — quiescent loads do not write.
- Sibling keys (`auth`, `safety`, `settings`) survive every `ConversationsStore` write because `flushImmediate` re-reads + merges before saving (FR-008).
- Recovery path: when the persisted blob fails schema validation, the malformed blob is preserved verbatim at `<pluginDataDir>/conversations_recovery.bak.json` and the plugin proceeds with default conversation state. Auth/safety/settings keys survive recovery (FR-010).

### Migration Policy

The store carries a `schemaVersion` integer. v0.3 ships at `schemaVersion: 1`. On load:

- Missing `schemaVersion` → treated as legacy / pre-v0.3 layout → parsed as defaults.
- `schemaVersion === CURRENT_SCHEMA_VERSION` → loaded as-is.
- `schemaVersion > CURRENT_SCHEMA_VERSION` (forward incompatibility from a downgrade) → corruption-recovery path runs, preserving the future blob in the recovery sidecar, and v0.3 starts from defaults rather than truncating the user's data.

Future schema bumps must add a migration function in `src/persistence/migrate.ts` that maps the prior layout to the current one, gated on `schemaVersion`.

## User Guide

### Prerequisites

- v0.2 plugin installed and signed in.
- Obsidian's data directory writable (`<vault>/.obsidian/plugins/obsidian-copilot-agent/data.json`).

### Basic Usage

1. **Open the chat pane.** Click the bot ribbon icon. Above the message list you'll see the conversation picker (current name + caret) and beneath it the model status pill.
2. **Create a new conversation.** Click the picker → "New conversation". A new `Untitled YYYY-MM-DD HH:MM` conversation becomes active. Send a message — the conversation auto-names from the first non-empty line of your message (≤ 40 chars).
3. **Switch conversations.** Click the picker → choose a name. The chat scroll position is preserved per conversation. The previous stream (if any) keeps running in the background and its result lands on the originating conversation, not the newly active one.
4. **Rename or delete.** Click the picker → caret next to a conversation name → Rename / Delete. Delete prompts a confirmation overlay (irreversible).
5. **Restart Obsidian.** Reopen — the previously active conversation reappears with full message history. The model name reappears in the header. Any unredo'd Undo buttons remain clickable; the file is checked against the snapshot before reverting.
6. **Cross-restart Undo with divergence.** If a file was modified outside the agent (or deleted, or recreated) since the recorded snapshot, clicking Undo opens a confirmation overlay describing the divergence. **Revert anyway** runs the undo with `{ force: true }`; **Cancel** leaves the file untouched.

### Advanced Usage

- **Auto-archive at 21.** When you create the 21st conversation, the oldest non-active one auto-archives. A one-time Notice tells you which one. Archived conversations stay on disk; v0.3 doesn't surface them in the picker (a future release may add "Show archived").
- **Raw-FS toggle.** Settings → Copilot Agent → Safety → "Expose v0.1 raw-filesystem tools". **ON by default** — the raw-FS tools remain registered as a fallback and the preamble nudges the model toward vault-aware tools first. Toggle OFF for a strictly vault-only surface; the change applies on the next plugin reload (next session start). Reload the plugin (`Disable` then `Enable` in Community plugins, or restart Obsidian) to pick it up. While OFF, historical raw-FS tool-call blocks render their name + result but the Undo button is suppressed — you're hiding the tool from the model AND its replay path.
- **Search tools.** "Find notes tagged #project" → `search_by_tag`. "What notes match the title 'meeting'" → `search_by_name`. "What tags am I using" → `list_all_tags`. All three are auto-approved (read-only, scoped to the active vault) and use Obsidian's `MetadataCache` so they're cheap. They do not create or rename tags.
- **Size warning.** When `data.json` crosses 5 MB the plugin fires a one-time Notice. Address it by deleting unused conversations from the picker — this purges their messages and undo entries from disk on the next flush.
- **Recovery sidecar.** If you see a Notice naming `conversations_recovery.bak.json`, the plugin failed to parse `data.json` and started from defaults. The malformed blob is preserved at that path so you (or a future migration tool) can recover from it. Auth and safety settings survive recovery so you don't have to reconnect.

## API Reference

### New read-only search tools (auto-approved — `skipPermission: true`)

| Tool | Signature | Notes |
|---|---|---|
| `search_by_tag` | `{ tag } → { ok: true, tag, matches: Array<{ path, displayName }>, truncated? }` | Tag matching is exact and case-sensitive on the post-`#` string. Leading `#` accepted/optional in input. Bounded result cap; `truncated: true` if hit. |
| `search_by_name` | `{ query } → { ok: true, query, matches: Array<{ path, displayName }>, truncated? }` | Case-insensitive bucket ranking: exact > prefix > substring; alphabetical within bucket. |
| `list_all_tags` | `{} → { ok: true, tags: Array<{ tag, count }> }` | Tag keys retain the leading `#`. Sorted by count desc, ties alphabetical. |

All three are read-only, return structured `{ ok: false, reason }` payloads on `metadata-cache-not-ready` (no thrown exceptions), and are registered with `skipPermission: true` per the FR-017 read-only auto-approval contract.

### Extended `UndoJournal` API (Phase 6)

```ts
interface UndoOutcome {
  ok: boolean;
  reason?: string;
  divergence?: "ok" | "modified" | "missing" | "existed";
}
interface UndoOptions { force?: boolean }
interface UndoJournalOptions {
  vault: UndoJournalVault;
  persist?: (op: "add" | "mark-undone" | "evict", entry: UndoEntry) => void;
  initialEntries?: PersistedUndoEntry[];
  maxEntries?: number;          // default 50 (SF-2)
  loadOptions?: { ttlMs: number };  // defensive TTL backstop at hydrate
  now?: () => number;           // wall-clock shim for tests
}
class UndoJournal {
  constructor(arg: UndoJournalVault | UndoJournalOptions);
  record(input: Omit<UndoEntry, "id" | "recordedAt" | "undone">): UndoEntry;
  get(id: string): UndoEntry | undefined;
  undo(id: string, options?: UndoOptions): Promise<UndoOutcome>;
}
```

Divergence semantics by entry kind:

| Kind | Detection | `force: true` action |
|---|---|---|
| `create` | file missing → `"missing"`; file content ≠ `after` → `"modified"` | If missing: no-op success. If modified: delete the file. |
| `modify` | file missing → `"missing"`; file content ≠ `after` → `"modified"` | If missing: recreate from `before`. If modified: write `before` over current. |
| `delete` | path occupied → `"existed"` | Overwrite occupant with `before`. |

### Conversation API

`ConversationManager` owns the multi-conversation surface. ChatView reads it via `manager.getActiveRuntime()` / subscribes to `active-changed`. The picker UI dispatches user actions back through `manager.create()` / `setActive()` / `rename()` / `archive()` / `remove()`.

Auto-naming helpers (FR-005) are exported for direct use:
- `formatUntitledName(now: number): string` — `Untitled YYYY-MM-DD HH:MM` in local time.
- `isDefaultConversationName(name: string): boolean` — true for bare/timestamped/suffix-disambiguated defaults.
- `deriveConversationNameFromMessage(text: string, max?=40): string` — first non-empty line, surrogate-pair safe.

### Configuration Options

Settings → Copilot Agent → **Safety**:
- **Default safety mode** (unchanged).
- **Path allowlist** (unchanged).
- **Per-built-in auto-approve toggles** (unchanged).
- **Expose v0.1 raw-filesystem tools** *(new)*: default **ON**. Keeps the six raw-FS tools registered as a defensive fallback while the preamble inventory marks them as `(fallback)` to nudge the model toward vault-aware tools first. Toggle OFF for a strictly vault-only surface. Toggling persists immediately; the change takes effect at the next plugin reload (FR-015).

Settings → Copilot Agent → **Vault Awareness** (unchanged from v0.2).

## What is NOT in v0.3 (SC-012)

The following items are deliberately Out of Scope per Spec § Scope:

- MCP integration.
- Extra-vault filesystem roots.
- Model picker UI / per-conversation model selection.
- Mid-session settings reload (settings continue to apply on the next session start).
- Tag-rename / tag-create capability surface.
- SDK changes (transport preamble continues via first-message prepending in `CopilotAgentSession`).
- Per-vault Daily Notes target override.
- Showing or restoring archived conversations from the picker.
- Sharing conversations across vaults or syncing them through Obsidian Sync (vault-local data only).
- Conversation export / import.
- Search-by-content fuzzy matching (current substring `search_content` continues unchanged).
- Cross-conversation tool-call inspection (each conversation's undo journal is private to that conversation).

## Testing

### How to Test

Repository tests (run before any change):

```
npm run typecheck    # tsc --noEmit
npm test             # vitest run (≥ 609 tests as of Phase 6)
npm run build        # esbuild production
npm run deploy       # build + copy to .deploy-target plugin folder
```

### Manual Verification (SC-001, SC-010 highlights)

- **SC-001 quiescent persistence**: take a snapshot of `data.json`, restart Obsidian without any new chat activity, take a second snapshot — the `conversations` subtree is byte-identical between snapshots.
- **Cross-restart Undo divergence**: in conversation A, ask the agent to create `note.md`. Edit `note.md` outside the agent. Restart Obsidian. Click Undo on the create — the divergence overlay appears; **Cancel** leaves your edits, **Revert anyway** deletes the file.
- **21st-conversation auto-archive**: create 20 conversations, then create a 21st. The picker still shows 20; a Notice surfaces which one was archived.
- **Recovery sidecar**: corrupt `data.json` (e.g. truncate to `{`) outside Obsidian, then load the plugin. The plugin reports recovery via Notice naming the sidecar; auth/safety settings still work; conversations start fresh.
- **Raw-FS toggle**: with the toggle ON (default), the raw-FS tools are registered alongside the vault tools and the preamble marks them as `(fallback)`; the model should prefer vault tools but can fall back to raw-FS (e.g. for non-`.md` files). Toggle OFF, reload the plugin — the raw-FS tools disappear from the preamble inventory and from the SDK manifest entirely.

## References

- Spec: `.paw/work/multi-conversation-persistence/Spec.md`
- Implementation Plan: `.paw/work/multi-conversation-persistence/ImplementationPlan.md`
- Code Research: `.paw/work/multi-conversation-persistence/CodeResearch.md`
- v0.2 prior art: `.paw/work/chat-ux-vault-tools/Docs.md`
