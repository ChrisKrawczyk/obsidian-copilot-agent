# 0012 — Operation-aware undo for contended vault writes

**Status:** Draft
**Created:** 2026-11-17
**Owner:** unassigned
**Origin:** deferred finding S1 from the v0.10.2 `vault-write-atomicity`
multi-model review (PR #16).

## Problem

`UndoJournal` records `modify` entries as whole-file snapshots
(`before` / `after`). v0.10.2 made parallel writes to the same note
safe: `create_task`, `update_task`, and `edit_note` append/prepend
all go through `Vault.process`, so every write now lands. The side
effect is that several undo entries can now target the same file
in one contention window, and all but the last go stale as soon as
the next write lands.

- **Normal undo** is safe. The divergence guard sees current content ≠
  the entry's `after` and declines with `divergence: "modified"`. The
  user just can't undo the earlier writes individually.
- **Force undo** (`{ force: true }`) restores the whole file to that
  entry's `before` snapshot, which **silently discards every later
  write**, including other tasks the agent just added.
- **Missing-target `create_task`:** the caller that created the daily
  note gets a `create` undo entry. Force-undoing it deletes the whole
  note, including tasks appended by the parallel callers.

This isn't a regression from v0.10.2. The property already existed,
but before the fix only one write per contention window survived, so
it never showed.

## Sketch

Replace whole-file inverses with **operation-aware inverses** for the
tools that write under contention:

| Tool / op | Inverse |
| --- | --- |
| `edit_note` append / prepend | Remove the exact block this call inserted (anchored by content + position hint), if still present. |
| `create_task` | Remove the exact task line this call inserted. |
| `update_task` | Revert just the patched line to its prior text, if the line still matches the post-patch text. |
| `create_task` that created the note | Downgrade to "remove my task line"; delete the file only if it would then be empty or identical to the template. |

Apply each inverse through `Vault.process` so undo is atomic with
respect to concurrent writes too. Keep snapshot-based entries for
whole-file tools (`write_note`, `edit_note` replace, etc.), where they
remain correct.

## Alternatives

1. **Disable force-undo for entries superseded by a later entry on the
   same path.** Small change that closes the data-loss hole. The user
   still can't undo earlier contended writes individually. A reasonable
   stop-gap if the full design stalls.
2. **Coalesce contended writes into one undo entry per turn.** Undo
   becomes all-or-nothing for the batch. Simpler, but coarser than users
   expect when one of five tasks was wrong.

## Open questions

- Anchoring: what is the safest way to locate "my block" after other
  writers shifted line numbers? Exact text match plus nearest-to-hint?
  What happens with duplicate identical blocks?
- Should the undo UI show something other than "modified" for stale
  snapshot entries (e.g. "superseded by a later write")?
- Journal schema: inverse descriptors must round-trip through
  `ConversationsStore` persistence. Is a migration needed for
  existing entries?

## References

- `src/domain/UndoJournal.ts` (divergence guard, `force` option)
- `src/tools/WriteTools.ts` (`processFileImpl`, `ProcessAbort`)
- CHANGELOG v0.10.2
