/**
 * v0.3 Phase 3: persisted shape for multi-conversation chat.
 *
 * Lives under the top-level `conversations` and `activeConversationId`
 * keys of the shared `data.json` blob. Other top-level keys (`auth`,
 * `safety`, `settings`) are owned by their respective stores and MUST
 * be preserved on every write — `ConversationsStore` does this via the
 * same merge-and-write pattern as `TokenStore`/`SafetySettingsStore`.
 *
 * Kept SDK- and Obsidian-free so tests (and migrations) can consume
 * these types without pulling in those layers.
 */

import type { UndoKind, UndoScope } from "../domain/UndoJournal";

/**
 * Subset of `Message` from `src/domain/types.ts` that survives a JSON
 * round-trip. We deliberately do NOT persist volatile lifecycle states
 * (`pending`, `streaming`) — those collapse to `interrupted` on save;
 * the runtime decides whether to retry on hydrate.
 */
export interface PersistedMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  status: "complete" | "interrupted" | "error";
  createdAt: number;
  toolCalls?: Array<{
    id: string;
    kind: string;
    name?: string;
    source?: "custom" | "mcp" | "builtin";
    outcome: "denied" | "approved" | "completed" | "errored";
    detail?: string;
    argsPreview?: string;
    resultContent?: string;
    /** Cross-restart Undo: id of the matching `PersistedUndoEntry`. */
    undoId?: string;
    undone?: boolean;
  }>;
}

/**
 * Persisted UndoJournal entry. Mirrors `UndoEntry` from
 * `src/domain/UndoJournal.ts:22-36` minus runtime-only state.
 *
 * `before`/`after` are STRINGS — for very large files this can bloat
 * the persisted blob. v0.3 accepts the trade-off: typical notes are
 * small, the SF-2 50-cap bounds worst-case retention, and the
 * alternative (content hashes only) would break the guard check.
 */
export interface PersistedUndoEntry {
  id: string;
  kind: UndoKind;
  scope: UndoScope;
  path: string;
  before?: string;
  after?: string;
  recordedAt: number;
  undone?: boolean;
}

export interface PersistedConversation {
  id: string;
  name: string;
  createdAt: number;
  lastActiveAt: number;
  archived?: boolean;
  /**
   * v0.4: per-conversation bound model id.
   * `undefined` (missing key) and `null` both mean "not yet resolved" —
   * the runtime will lazily resolve this on first activation per FR-013.
   * A non-null string is the resolved SDK model id (e.g. "gpt-4.1").
   *
   * Migration policy: v1 conversations are upcast to v2 by leaving this
   * field as `null`; lazy resolution writes through on first activation.
   *
   * IMPORTANT: this field is per-conversation METADATA, not transcript
   * state. It is NOT included in `PersistedUndoEntry` snapshots; an
   * undo that restores transcript state preserves the currently-bound
   * `modelId`. (Spec.md Edge Cases — Undo journal interaction.)
   */
  modelId?: string | null;
  messages: PersistedMessage[];
  /** SF-2: capped at 50 entries on record (oldest evicted first). */
  undoEntries: PersistedUndoEntry[];
}

/** Top-level subtree owned by ConversationsStore. */
export interface PersistedConversationsState {
  schemaVersion: number;
  conversations: PersistedConversation[];
  activeConversationId: string | null;
}

export const CURRENT_SCHEMA_VERSION = 2;

export const DEFAULT_CONVERSATIONS_STATE: PersistedConversationsState = {
  schemaVersion: CURRENT_SCHEMA_VERSION,
  conversations: [],
  activeConversationId: null,
};
