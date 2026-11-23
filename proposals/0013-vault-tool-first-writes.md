# 0013 — Vault tool-first writes

**Status:** Shipped — [PR #24](https://github.com/ChrisKrawczyk/obsidian-copilot-agent/pull/24)
**Created:** 2026-11-20
**Owner:** unassigned
**Origin:** observed agent behaviour. When a vault tool was slow, needed
many approvals, or did not exist, the agent fell back to PowerShell,
bash, or Python to change vault files directly.

## Problem

Shell writes into the vault bypass the safety policy's vault-write
approvals, and they bypass the Undo journal, so Undo can't revert them.
Moves done through the shell also leave every wikilink pointing at the
old path. Two gaps push the agent toward the shell:

- `update_task` edits one task per call, so "mark these 30 tasks done"
  means 30 approvals and 30 Undo entries.
- No vault tool can move or rename a note.

We don't want a shell guard. The goal is to make the shell path
unnecessary and less tempting.

## Sketch

- **Preamble hard rule.** A short "Vault writes" block in the default
  preamble, also available in custom mode as `{{VAULT_WRITE_RULES}}`.
  It says every vault change goes through the vault tools, and the
  shell may only read the vault or write outside it (or in the agent's
  session-state folder). Before falling
  back to the shell, the agent must stop and ask the user. Bulk
  operations (more than 5 items) need confirmation first.
- **Batch tools with at most one approval prompt and one Undo entry
  per call:**
  - `update_tasks` applies one patch to many `find_tasks` results.
  - `move_note` does link-aware moves and renames through
    `fileManager.renameFile`, so links follow Obsidian's link settings.
  - `bulk_edit` does a find/replace across notes. The approval shows a
    per-note preview.

  Each tool validates every target first and makes no writes if any
  target fails. If a write fails partway through, the writes already
  made are rolled back.
- **Batch Undo entries.** The journal gets a `batch` kind whose items
  are modify, create, delete, or move. Undo checks every item for
  divergence before reverting any of them, and it persists across
  reloads like existing entries.
- **Out-of-band change warning (dropped).** An earlier iteration showed
  a non-blocking warning when vault files changed while a shell or MCP
  tool ran. It was removed before merge on purpose: shell and MCP calls
  may legitimately be expected to change vault files, so flagging those
  writes treats intended behaviour as suspect. The agent should prefer
  the vault tools, but external writes are neither blocked nor flagged.

- **`replace_in_note` and accurate tool hints (added later).** The
  preamble described `edit_file` as replacing one block of text, but it
  overwrites the whole file, and a model wiped a note by passing one
  table row as the new content. `replace_in_note` now makes one literal,
  count-checked edit inside a note with a diff preview and one Undo
  entry. The preamble steers in-note changes to it. Every tool hint was
  corrected against its real description and schema, and a test keeps
  them in sync.
- **Out of scope: a full-overwrite guard (dropped).** Refusing large
  shrinks on `edit_file`/`edit_note` replace, with an override flag and
  forced manual approval, was considered and dropped: it adds friction
  to legitimate large rewrites.

## Open questions

- None open. Detecting or flagging external writes is out of scope; see
  the dropped change warning above.
