/**
 * v0.3 Phase 4: per-conversation runtime.
 *
 * Each conversation owns its OWN `AgentSession`, `UndoJournal`,
 * `ChatState`, and per-runtime tool-factory instances. Tools are
 * **statically bound at construction time** to *this* runtime's
 * journal, so the "active vs originating" mid-stream conversation-
 * switch class of bugs is eliminated structurally — there is no
 * shared journal, no captured-at-send-time discipline to enforce, and
 * no global session whose approval/streaming maps could leak across
 * conversations.
 *
 * Trade-offs (chosen via planning-docs-review MF-2):
 *  - Slightly higher idle memory for ≤ 20 sessions: acceptable, the
 *    SDK session is small and lazily instantiated per conversation.
 *  - v0.3 supports at most one concurrent stream per plugin instance
 *    (multi-leaf chat is Out of Scope per SI-11), so concurrent-
 *    session resource pressure is bounded by user activity, not
 *    conversation count.
 *  - The discipline-based shared-session alternative was rejected
 *    because hand-maintained capture-at-send-time bugs recur in
 *    stream-handling code; per-runtime eliminates the class.
 */

import type { AgentSession } from "../sdk/AgentSession";
import type { Message } from "./types";
import { ChatState } from "./ChatState";
import { UndoJournal, type UndoJournalPersistOp, type UndoEntry } from "./UndoJournal";
import type {
  PersistedMessage,
  PersistedUndoEntry,
} from "../persistence/PersistedShape";
import type { Conversation } from "./Conversation";

export interface ConversationRuntime {
  /** Reference back to the conversation metadata this runtime serves. */
  readonly conversationId: string;
  readonly session: AgentSession;
  readonly journal: UndoJournal;
  readonly state: ChatState;
  /** Cancel any in-flight stream and detach SDK listeners. Called by
   *  `ConversationManager.removeConversation`. */
  dispose(): Promise<void>;
}

/**
 * The factory the manager calls to materialize a runtime. The
 * closure captures everything that doesn't change per-conversation:
 * cliPath, baseDirectory, ObsidianApi, vault, workspace, auth wiring,
 * SafetyState, safety settings reader, preamble assembler, and the
 * frozen gated-tools snapshot computed at plugin onload.
 *
 * The factory creates a new journal bound to the per-runtime persist
 * callback, builds tools that reference *that* journal, constructs the
 * AgentSession, and hydrates the ChatState from any prior persisted
 * messages.
 */
export type ConversationRuntimeFactory = (
  metadata: Conversation,
  hydration?: {
    messages?: PersistedMessage[];
    undoEntries?: PersistedUndoEntry[];
  },
  persistAdapter?: ConversationRuntimePersistAdapter,
) => ConversationRuntime;

/**
 * Bridge between the runtime's per-conversation journal and the
 * shared `ConversationsStore`. The manager owns the store reference
 * and gives each runtime its own narrow adapter scoped to its id.
 */
export interface ConversationRuntimePersistAdapter {
  /** Mirror an UndoJournal mutation into the persisted store. */
  onJournalOp: (op: UndoJournalPersistOp, entry: UndoEntry) => void;
  /**
   * Optional: when the in-memory journal hits its cap and evicts the
   * oldest entry, the manager also tells the store to drop its own
   * mirror. Default behaviour is via `onJournalOp("evict", entry)`.
   */
}

/**
 * Helper: build a `ChatState` seeded from persisted messages. Volatile
 * statuses (streaming/pending) collapse to `interrupted` per the
 * persisted-shape contract — we don't replay live transitions on load.
 */
export function hydrateChatState(messages?: PersistedMessage[]): ChatState {
  if (!messages || messages.length === 0) return new ChatState();
  const seeded: Message[] = messages.map((m) => ({
    id: m.id,
    role: m.role,
    content: m.content,
    status: m.status,
    createdAt: m.createdAt,
    toolCalls: m.toolCalls?.map((tc) => ({
      id: tc.id,
      kind: tc.kind,
      name: tc.name,
      source: tc.source,
      outcome: tc.outcome,
      detail: tc.detail,
      argsPreview: tc.argsPreview,
      resultContent: tc.resultContent,
      undoId: tc.undoId,
      undone: tc.undone,
    })),
  }));
  return new ChatState(seeded);
}

import type { UndoJournalVault } from "./UndoJournal";
import { UNDO_TTL_MS } from "../persistence/ConversationsStore";

/** Helper: build an `UndoJournal` for a runtime, with persistence
 *  wired to the provided adapter and hydration from prior entries. */
export function makeRuntimeJournal(
  vault: UndoJournalVault,
  hydration?: PersistedUndoEntry[],
  persistAdapter?: ConversationRuntimePersistAdapter,
): UndoJournal {
  return new UndoJournal({
    vault,
    initialEntries: hydration,
    persist: persistAdapter
      ? (op, entry) => persistAdapter.onJournalOp(op, entry)
      : undefined,
    // v0.3 Phase 6: defensive TTL backstop. `ConversationsStore.pruneOnLoad`
    // is the authoritative 7-day pruner at plugin startup; this just
    // ensures that if a stale entry slipped past (e.g. a never-opened
    // conversation hydrating after a long sleep), the in-memory journal
    // still drops it and fires an `evict` so the store stays in lockstep.
    loadOptions: { ttlMs: UNDO_TTL_MS },
  });
}
