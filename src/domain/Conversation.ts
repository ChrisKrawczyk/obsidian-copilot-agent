/**
 * v0.3 Phase 4: lightweight metadata value type for a single chat
 * conversation. Decoupled from `ConversationRuntime` so the manager
 * can list/sort/serialise conversations without instantiating their
 * sessions.
 *
 * The runtime (session, journal, in-memory chat state) is created
 * lazily by `ConversationManager` on first activation.
 */

import type {
  PersistedConversation,
  PersistedMessage,
  PersistedUndoEntry,
} from "../persistence/PersistedShape";

export interface Conversation {
  id: string;
  /** Display name; FR-005 auto-naming + suffix-disambiguation lives in the manager. */
  name: string;
  /** Unix-ms creation time. Stable for the conversation's lifetime. */
  createdAt: number;
  /** Updated whenever a message is appended (FR-003 sort key). */
  lastActiveAt: number;
  /** True when soft-cap eviction archived this conversation. */
  archived?: boolean;
}

/** Snapshot of the per-conversation persisted shape needed for runtime
 *  hydration. Bundles the metadata with the message + undo arrays. */
export interface ConversationHydration {
  metadata: Conversation;
  messages: PersistedMessage[];
  undoEntries: PersistedUndoEntry[];
}

export function conversationFromPersisted(
  p: PersistedConversation,
): ConversationHydration {
  return {
    metadata: {
      id: p.id,
      name: p.name,
      createdAt: p.createdAt,
      lastActiveAt: p.lastActiveAt,
      archived: p.archived === true ? true : undefined,
    },
    messages: p.messages,
    undoEntries: p.undoEntries,
  };
}

export function conversationToPersistedMetadata(
  c: Conversation,
): Omit<PersistedConversation, "messages" | "undoEntries"> {
  return {
    id: c.id,
    name: c.name,
    createdAt: c.createdAt,
    lastActiveAt: c.lastActiveAt,
    archived: c.archived === true ? true : undefined,
  };
}
