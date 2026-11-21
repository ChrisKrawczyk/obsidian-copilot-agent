# 0013 — Vault tool-first writes

**Status:** In Progress
**Created:** 2026-11-20
**Owner:** unassigned
**Origin:** observed agent behaviour. When a vault tool was slow, needed
many approvals, or did not exist, the agent fell back to PowerShell,
bash, or Python to change vault files directly.

## Problem

Shell writes into the vault bypass the safety policy, so no approval is
asked, and they bypass the Undo journal, so Undo can't revert them.
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
  shell may only read the vault or write outside it. Before falling
  back to the shell, the agent must stop and ask the user. Bulk
  operations (more than 5 items) need confirmation first.
- **Batch tools with one approval and one Undo entry:**
  - `update_tasks` applies one patch to many `find_tasks` results.
  - `move_note` does link-aware moves and renames through
    `fileManager.renameFile`.
  - `bulk_edit` does a find/replace across notes. The approval shows a
    per-note preview.

  Each tool validates every target first and makes no writes if any
  target fails. If a write fails partway through, the writes already
  made are rolled back.
- **Batch Undo entries.** The journal gets a `batch` kind whose items
  are modify, create, delete, or move. Undo checks every item for
  divergence before reverting any of them, and it persists across
  reloads like existing entries.
- **Out-of-band change warning.** While a shell or MCP tool runs during
  an agent turn, vault changes that the plugin's own tools didn't make
  are listed as a non-blocking warning on that tool call. Excluded:
  - the config folder;
  - the note in the focused editor;
  - anything written while a vault tool or Undo runs.

## Open questions

- Should the out-of-band warning also be fed back to the model so it
  can self-correct? Out of scope for now: the warning goes to the user
  only.
- Writes from other plugins (Linter, Templater, sync) during a shell
  call are reported too. If that turns out to be noisy, a per-plugin
  allowlist may be needed.
