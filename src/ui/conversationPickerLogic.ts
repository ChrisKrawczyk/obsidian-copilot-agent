// v0.3 Phase 5: pure (DOM-free) helpers for ConversationPicker.
//
// Extracted into its own module so we can unit-test sort/truncation/
// archive-trigger logic in node (per vitest.config.ts), without
// dragging Obsidian's DOM into the test environment. Mirrors the
// pattern used for src/ui/chatKeydown.ts.
//
// Anything that produces or mutates HTML lives in ConversationPicker.ts;
// anything that decides what items to show, in what order, with what
// label, lives here.

import type { Conversation } from "../domain/Conversation";

export const PICKER_NAME_MAX_CHARS = 48;

/** Compact item type the picker renders. Conversation has more fields
 *  (createdAt, lastActiveAt, archived) but the rendered row only needs
 *  these — keeps the DOM module simple to test. */
export interface PickerItem {
  id: string;
  /** The truncated display label (≤ PICKER_NAME_MAX_CHARS, with `…`). */
  label: string;
  /** The full name without truncation. Used for the `title` tooltip. */
  fullName: string;
  /** True iff this item is the current active conversation; the
   *  picker styles it differently. */
  isActive: boolean;
}

/**
 * Project `Conversation[]` → `PickerItem[]` for rendering. FR-003
 * order: by `lastActiveAt` descending (most recently active first).
 * Archived conversations are excluded — they remain in the catalog
 * for "View archived" affordances we'll add later, but the day-to-day
 * picker only shows live ones (FR-020).
 *
 * Stable secondary sort on `createdAt` descending breaks ties when
 * two conversations share an exact `lastActiveAt` (e.g., two freshly
 * created from the same `now()` tick in tests).
 */
export function buildPickerItems(
  conversations: readonly Conversation[],
  activeId: string | null,
): PickerItem[] {
  const live = conversations.filter((c) => !c.archived);
  const sorted = [...live].sort((a, b) => {
    if (b.lastActiveAt !== a.lastActiveAt) {
      return b.lastActiveAt - a.lastActiveAt;
    }
    return b.createdAt - a.createdAt;
  });
  return sorted.map((c) => ({
    id: c.id,
    label: truncateLabel(c.name),
    fullName: c.name,
    isActive: c.id === activeId,
  }));
}

/**
 * Truncate a conversation name for display. CSS handles the visual
 * ellipsis at narrow widths, but we also enforce a hard character cap
 * so a 5KB label can't blow up the picker layout in pathological cases.
 *
 * Uses Array.from to split by code points rather than UTF-16 code
 * units — a 4-byte emoji counts as one "char", not two.
 */
export function truncateLabel(
  name: string,
  max: number = PICKER_NAME_MAX_CHARS,
): string {
  const chars = Array.from(name);
  if (chars.length <= max) return name;
  return chars.slice(0, max - 1).join("") + "…";
}

/**
 * Suffix-disambiguation lookup mirroring `ConversationManager.uniqueName`.
 * Exposed here so the picker's rename-inline UI can compute the final
 * label preview before committing the rename through the manager.
 *
 * `excludeId` is the id whose current name should NOT count as a
 * collision (rename-to-self leaves the name unchanged).
 */
export function suffixDisambiguatedName(
  seed: string,
  existing: readonly Conversation[],
  excludeId: string | null,
): string {
  const trimmed = seed.trim().length > 0 ? seed.trim() : "Untitled";
  const taken = new Set<string>();
  for (const c of existing) {
    if (c.id !== excludeId) taken.add(c.name);
  }
  if (!taken.has(trimmed)) return trimmed;
  let n = 2;
  while (taken.has(`${trimmed} ${n}`)) n++;
  return `${trimmed} ${n}`;
}

/**
 * Predicate: returns true if creating a new conversation right now
 * would push the *active* (non-archived) count past `softCap`,
 * triggering the soft-cap auto-archive of the LRU conversation.
 *
 * The picker uses this to surface a non-blocking notice ("This will
 * archive the oldest conversation") before the user commits, so the
 * archive isn't surprising.
 */
export function wouldTriggerArchiveOnCreate(
  conversations: readonly Conversation[],
  softCap: number,
): boolean {
  const activeCount = conversations.filter((c) => !c.archived).length;
  return activeCount + 1 > softCap;
}
