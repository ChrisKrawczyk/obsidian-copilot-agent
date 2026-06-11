/**
 * v0.3 Phase 4: per-plugin manager that owns the catalog of
 * `Conversation` metadata, lazily-instantiated `ConversationRuntime`s,
 * and the active-id pointer. Mutating methods write through to
 * `ConversationsStore` (debounced) so the persisted state stays in
 * sync with in-memory.
 *
 * Policy responsibilities:
 *  - FR-002 soft cap at 20: when a 21st conversation is created, the
 *    least-recently-active non-archived one is auto-archived.
 *  - FR-005 auto-naming + suffix-disambiguation: new conversations
 *    default to "Untitled"; collisions get a numeric suffix.
 *  - FR-009 active-on-load resolution: hydrate uses persisted
 *    `activeConversationId` if it still exists, else falls back to
 *    most-recently-active non-archived, else creates a default.
 *
 * The manager does NOT own the chat UI; it exposes a `subscribe()`
 * change-feed that `ChatView` listens to so it can re-bind to the
 * active runtime when it changes.
 */

import type {
  Conversation,
} from "./Conversation";
import {
  conversationToPersistedMetadata,
} from "./Conversation";
import type {
  ConversationRuntime,
  ConversationRuntimeFactory,
  ConversationRuntimePersistAdapter,
} from "./ConversationRuntime";
import type { UndoJournalPersistOp, UndoEntry } from "./UndoJournal";
import type { ConversationsStore } from "../persistence/ConversationsStore";
import type {
  PersistedConversation,
  PersistedMessage,
  PersistedUndoEntry,
} from "../persistence/PersistedShape";

/** Spec FR-002 soft cap. */
export const CONVERSATION_SOFT_CAP = 20;
/** Bare default seed used when generating a timestamped placeholder
 *  name (FR-005). Kept as a constant so the auto-name detection
 *  regex and the formatter agree on the prefix. */
const DEFAULT_NAME_PREFIX = "Untitled";
/** Legacy bare default — retained for the `isDefaultConversationName`
 *  matcher so conversations created before the timestamped variant
 *  shipped still auto-rename on first send. */
const DEFAULT_NAME = DEFAULT_NAME_PREFIX;

/**
 * FR-005 formatter: "Untitled YYYY-MM-DD HH:MM" in local time. Used as
 * the seed for `createInternal` when no explicit name is provided so
 * each new conversation starts with a unique, sortable placeholder
 * label (the picker still applies " N" suffix-dedup if two are
 * created in the same minute).
 */
export function formatUntitledName(now: number): string {
  const d = new Date(now);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${DEFAULT_NAME_PREFIX} ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * FR-005 auto-name detector. Returns true iff `name` looks like one
 * of the manager-generated placeholder names — i.e., the user has
 * NOT manually renamed yet. Used by ChatView to decide whether the
 * first user message should drive auto-naming.
 *
 * Patterns matched:
 *   - "Untitled"
 *   - "Untitled N"               (legacy bare-default + suffix-dedup)
 *   - "Untitled YYYY-MM-DD HH:MM"
 *   - "Untitled YYYY-MM-DD HH:MM N"
 */
export function isDefaultConversationName(name: string): boolean {
  return /^Untitled(\s+\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2})?(\s+\d+)?$/.test(name);
}

/**
 * FR-005 derivation: take the first non-empty line of the user's
 * message, trim, and truncate to ~40 chars with ellipsis. Returns ""
 * for empty / whitespace-only input so the caller can skip the
 * rename. Surrogate-pair safe via Array.from.
 */
export function deriveConversationNameFromMessage(
  text: string,
  maxChars = 40,
): string {
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const chars = Array.from(trimmed);
    if (chars.length <= maxChars) return trimmed;
    return chars.slice(0, maxChars - 1).join("") + "…";
  }
  return "";
}

export interface ConversationManagerOptions {
  /** Factory that builds a runtime for a given conversation. */
  runtimeFactory: ConversationRuntimeFactory;
  /** Persistence sink. Optional so unit tests can omit. */
  store?: ConversationsStore;
  /** Now() shim for tests. */
  now?: () => number;
}

export type ConversationChangeEvent =
  | { kind: "list-changed" }
  | { kind: "active-changed"; previousId: string | null; nextId: string | null }
  | { kind: "metadata-changed"; id: string };

export type ConversationListener = (event: ConversationChangeEvent) => void;

export class ConversationManager {
  private readonly runtimeFactory: ConversationRuntimeFactory;
  private readonly store?: ConversationsStore;
  private readonly now: () => number;
  private readonly conversations = new Map<string, Conversation>();
  private readonly runtimes = new Map<string, ConversationRuntime>();
  private readonly listeners = new Set<ConversationListener>();
  private activeId: string | null = null;
  private idCounter = 0;

  constructor(opts: ConversationManagerOptions) {
    this.runtimeFactory = opts.runtimeFactory;
    this.store = opts.store;
    this.now = opts.now ?? (() => Date.now());
  }

  // ---------------- Hydration ----------------

  /**
   * Seed the manager from `ConversationsStore.snapshot()` data.
   * Establishes the catalog and resolves the active id per FR-009.
   * Does NOT instantiate runtimes (lazy).
   *
   * Returns the resolved active id (may be a fresh default if no
   * conversations were persisted).
   */
  hydrate(input: {
    conversations: PersistedConversation[];
    activeConversationId: string | null;
  }): string {
    this.conversations.clear();
    this.runtimes.clear();
    for (const c of input.conversations) {
      const meta: Conversation = {
        id: c.id,
        name: c.name,
        createdAt: c.createdAt,
        lastActiveAt: c.lastActiveAt,
        archived: c.archived === true ? true : undefined,
      };
      this.conversations.set(c.id, meta);
      // Defensive: ensure the store has a row for every catalog entry
      // (so `setActiveId(meta.id)` further down can't throw). In the
      // normal flow the store already has these — this is idempotent
      // when they match. Failures are logged, not thrown, so a bad
      // store row can't block plugin onload.
      if (this.store) {
        try {
          this.store.upsertConversation({
            id: c.id,
            name: c.name,
            createdAt: c.createdAt,
            lastActiveAt: c.lastActiveAt,
            archived: c.archived === true ? true : undefined,
            messages: c.messages,
            undoEntries: c.undoEntries,
          });
        } catch (err) {
          console.error("[ConversationManager] hydrate upsert failed", err);
        }
      }
      // Track the highest numeric id-suffix we've issued so future
      // local ids don't collide.
      const m = /^conv-(\d+)$/.exec(c.id);
      if (m) {
        const n = Number(m[1]);
        if (Number.isFinite(n) && n > this.idCounter) this.idCounter = n;
      }
    }

    const desired = input.activeConversationId;
    let resolved: string | null = null;
    if (desired && this.conversations.has(desired)) {
      const meta = this.conversations.get(desired)!;
      if (!meta.archived) resolved = desired;
    }
    if (!resolved) resolved = this.pickFallbackActive();
    if (!resolved) {
      // Empty catalog → create a default.
      resolved = this.createInternal().id;
    }

    this.activeId = resolved;
    if (this.store) {
      this.store.setActiveId(resolved);
    }
    this.emit({ kind: "list-changed" });
    return resolved;
  }

  // ---------------- Catalog reads ----------------

  list(): Conversation[] {
    return Array.from(this.conversations.values()).map(cloneMeta);
  }

  listActive(): Conversation[] {
    return this.list().filter((c) => !c.archived);
  }

  get(id: string): Conversation | undefined {
    const c = this.conversations.get(id);
    return c ? cloneMeta(c) : undefined;
  }

  getActiveId(): string | null {
    return this.activeId;
  }

  /** Returns the runtime for the active conversation, instantiating
   *  it on first access. */
  getActiveRuntime(): ConversationRuntime {
    if (!this.activeId) {
      throw new Error(
        "ConversationManager.getActiveRuntime: no active conversation (call hydrate() first)",
      );
    }
    return this.getOrCreateRuntime(this.activeId);
  }

  hasRuntime(id: string): boolean {
    return this.runtimes.has(id);
  }

  // ---------------- Mutations ----------------

  setActive(id: string): void {
    if (!this.conversations.has(id)) {
      throw new Error(`setActive: no conversation with id "${id}"`);
    }
    if (this.activeId === id) return;
    const previous = this.activeId;
    this.activeId = id;
    if (this.store) this.store.setActiveId(id);
    this.emit({ kind: "active-changed", previousId: previous, nextId: id });
  }

  /**
   * Create a new conversation. If `name` is omitted (or empty), uses
   * "Untitled" with FR-005 numeric-suffix disambiguation.
   * Enforces the FR-002 soft cap by archiving the least-recently-
   * active non-archived conversation when the active count would
   * exceed `CONVERSATION_SOFT_CAP`.
   */
  create(name?: string): Conversation {
    const conv = this.createInternal(name);
    // createInternal already persisted; enforceSoftCap may archive
    // the LRU non-active conv (which writes its own metadata update).
    this.enforceSoftCap();
    this.emit({ kind: "list-changed" });
    return cloneMeta(conv);
  }

  rename(id: string, name: string): void {
    const conv = this.conversations.get(id);
    if (!conv) throw new Error(`rename: no conversation with id "${id}"`);
    const trimmed = name.trim().length > 0 ? name.trim() : DEFAULT_NAME;
    const finalName = this.uniqueName(trimmed, id);
    if (conv.name === finalName) return;
    conv.name = finalName;
    this.persistMetadataOnly(conv);
    this.emit({ kind: "metadata-changed", id });
  }

  /**
   * Spec FR-005: if a conversation still bears one of the manager-
   * generated placeholder names, derive a name from the first user
   * message and rename. No-op when the name has already been
   * user-customised (or auto-set on a prior turn). Idempotent —
   * ChatView calls this on every send; only the first call where the
   * predicate matches actually mutates.
   *
   * Returns `true` if a rename happened, `false` otherwise (caller
   * can use this to log/audit but isn't expected to react).
   */
  maybeAutoNameFromFirstMessage(convId: string, firstMessage: string): boolean {
    const conv = this.conversations.get(convId);
    if (!conv) return false;
    if (!isDefaultConversationName(conv.name)) return false;
    const derived = deriveConversationNameFromMessage(firstMessage);
    if (derived.length === 0) return false;
    this.rename(convId, derived);
    return true;
  }

  archive(id: string): void {
    const conv = this.conversations.get(id);
    if (!conv) return;
    if (conv.archived) return;
    conv.archived = true;
    this.persistMetadataOnly(conv);
    if (this.activeId === id) {
      const fallback = this.pickFallbackActive();
      const next = fallback ?? this.createInternal().id;
      const previous = this.activeId;
      this.activeId = next;
      if (this.store) this.store.setActiveId(next);
      this.emit({ kind: "active-changed", previousId: previous, nextId: next });
    }
    this.emit({ kind: "metadata-changed", id });
  }

  /**
   * Permanently remove a conversation (and its runtime if instantiated).
   * Resolves to a new active per FR-009 if the removed one was active.
   */
  async removeConversation(id: string): Promise<void> {
    const conv = this.conversations.get(id);
    if (!conv) return;
    const runtime = this.runtimes.get(id);
    if (runtime) {
      this.runtimes.delete(id);
      try {
        await runtime.dispose();
      } catch (err) {
        console.error("[ConversationManager] runtime.dispose threw", err);
      }
    }
    this.conversations.delete(id);
    if (this.store) this.store.removeConversation(id);
    if (this.activeId === id) {
      const previous = this.activeId;
      const fallback = this.pickFallbackActive();
      const next = fallback ?? this.createInternal().id;
      this.activeId = next;
      if (this.store) this.store.setActiveId(next);
      this.emit({ kind: "active-changed", previousId: previous, nextId: next });
    }
    this.emit({ kind: "list-changed" });
  }

  /** Bump the active conversation's `lastActiveAt`. Called from chat
   *  send paths. Persistence is a separate write-through via the
   *  store's appendMessage, but UI still benefits from a fresh sort
   *  key as soon as a turn starts. */
  touchActive(): void {
    if (!this.activeId) return;
    const conv = this.conversations.get(this.activeId);
    if (!conv) return;
    conv.lastActiveAt = this.now();
    this.emit({ kind: "metadata-changed", id: conv.id });
  }

  /**
   * v0.3 Phase 4 (FR-007): mirror a newly-appended ChatState message
   * into the persisted store. ChatView calls this from its send path
   * with `convId` captured at send time, so a mid-stream active
   * switch can't redirect persistence to the wrong conversation.
   * Best-effort: failures are logged, never thrown.
   */
  persistMessageAppend(convId: string, msg: PersistedMessage): void {
    if (!this.store) return;
    if (!this.conversations.has(convId)) return;
    try {
      this.store.appendMessage(convId, msg);
    } catch (err) {
      console.error("[ConversationManager] persistMessageAppend failed", err);
    }
  }

  /**
   * Mirror a ChatState message-replace into the store. Used to land
   * the final assistant content + status at the end of a streaming
   * turn (so we don't write on every delta; the debounce inside
   * `ConversationsStore` coalesces this with the prior append).
   */
  persistMessageReplace(
    convId: string,
    msgId: string,
    partial: Partial<PersistedMessage>,
  ): void {
    if (!this.store) return;
    if (!this.conversations.has(convId)) return;
    try {
      this.store.replaceMessage(convId, msgId, partial);
    } catch (err) {
      console.error("[ConversationManager] persistMessageReplace failed", err);
    }
  }

  // ---------------- Subscriptions ----------------

  subscribe(listener: ConversationListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Cancel all in-flight streams and detach SDK listeners on every
   * instantiated runtime. Called by the plugin's `onunload`.
   * Idempotent; safe to call when no runtimes were ever instantiated.
   */
  async disposeAll(): Promise<void> {
    const targets = Array.from(this.runtimes.values());
    this.runtimes.clear();
    await Promise.allSettled(targets.map((r) => r.dispose()));
  }

  // ---------------- Internals ----------------

  private getOrCreateRuntime(id: string): ConversationRuntime {
    const existing = this.runtimes.get(id);
    if (existing) return existing;
    const conv = this.conversations.get(id);
    if (!conv) {
      throw new Error(`No conversation with id "${id}" — cannot build runtime`);
    }
    const persistAdapter = this.makePersistAdapter(id);
    const hydration = this.snapshotHydration(id);
    const runtime = this.runtimeFactory(
      cloneMeta(conv),
      hydration,
      persistAdapter,
    );
    this.runtimes.set(id, runtime);
    return runtime;
  }

  private snapshotHydration(id: string): {
    messages?: PersistedMessage[];
    undoEntries?: PersistedUndoEntry[];
  } | undefined {
    if (!this.store) return undefined;
    try {
      const persisted = this.store
        .listConversations()
        .find((c) => c.id === id);
      if (!persisted) return undefined;
      return {
        messages: persisted.messages,
        undoEntries: persisted.undoEntries,
      };
    } catch (err) {
      console.error(
        "[ConversationManager] snapshotHydration failed",
        err,
      );
      return undefined;
    }
  }

  private persistMetadataOnly(c: Conversation): void {
    if (!this.store) return;
    try {
      const existing = this.store.listConversations().find((p) => p.id === c.id);
      const messages = existing?.messages ?? [];
      const undoEntries = existing?.undoEntries ?? [];
      this.store.upsertConversation({
        ...conversationToPersistedMetadata(c),
        messages,
        undoEntries,
      });
    } catch (err) {
      console.error("[ConversationManager] persistMetadataOnly failed", err);
    }
  }

  private makePersistAdapter(id: string): ConversationRuntimePersistAdapter | undefined {
    if (!this.store) return undefined;
    const store = this.store;
    return {
      onJournalOp: (op: UndoJournalPersistOp, entry: UndoEntry) => {
        try {
          if (op === "add") {
            store.recordUndo(id, {
              id: entry.id,
              kind: entry.kind,
              scope: entry.scope,
              path: entry.path,
              before: entry.before,
              after: entry.after,
              recordedAt: entry.recordedAt,
              undone: entry.undone,
            });
          } else if (op === "mark-undone") {
            store.markUndone(id, entry.id);
          } else if (op === "evict") {
            // v0.3 Phase 6: the journal evicted an entry on its own
            // (TTL backstop at hydrate, or future trim paths). Mirror
            // the removal in the store so `data.json` doesn't keep
            // ghost entries the in-memory journal has forgotten. The
            // SF-2 cap path runs through `recordUndo` (which evicts
            // store-side independently) so it does NOT come through
            // here — only the standalone eviction surfaces does.
            store.removeUndoEntry(id, entry.id);
          }
        } catch (err) {
          console.error(
            "[ConversationManager] journal-op persist failed",
            err,
          );
        }
      },
    };
  }

  private createInternal(name?: string): Conversation {
    const trimmed = name?.trim();
    // Spec FR-005: when no explicit name is provided, seed with a
    // timestamped placeholder so the user can distinguish freshly-
    // created conversations in the picker before the first message
    // arrives and auto-naming kicks in (ChatView.handleSend wires
    // that via `maybeAutoNameFromFirstMessage`).
    const seed =
      trimmed && trimmed.length > 0 ? trimmed : formatUntitledName(this.now());
    const finalName = this.uniqueName(seed, null);
    this.idCounter += 1;
    const id = `conv-${this.idCounter}`;
    const ts = this.now();
    const meta: Conversation = {
      id,
      name: finalName,
      createdAt: ts,
      lastActiveAt: ts,
    };
    this.conversations.set(id, meta);
    // Invariant: every Conversation tracked by the manager exists in
    // the store too. Without this upsert, calling
    // `store.setActiveId(meta.id)` would throw because the store has
    // no row for the freshly-minted default. This matters for the
    // hydrate(empty) and "archive/remove the last active conversation"
    // paths where we synthesize a default and immediately set it
    // active (see hydrate / archive / removeConversation).
    if (this.store) {
      try {
        this.store.upsertConversation({
          ...conversationToPersistedMetadata(meta),
          messages: [],
          undoEntries: [],
        });
      } catch (err) {
        console.error(
          "[ConversationManager] createInternal upsert failed",
          err,
        );
      }
    }
    return meta;
  }

  /** Apply numeric-suffix disambiguation. `excludeId` is the id whose
   *  current name should NOT count as a collision (used by rename). */
  private uniqueName(seed: string, excludeId: string | null): string {
    const existingNames = new Set<string>();
    for (const c of this.conversations.values()) {
      if (c.id !== excludeId) existingNames.add(c.name);
    }
    if (!existingNames.has(seed)) return seed;
    let n = 2;
    while (existingNames.has(`${seed} ${n}`)) n++;
    return `${seed} ${n}`;
  }

  private enforceSoftCap(): void {
    const active = Array.from(this.conversations.values()).filter(
      (c) => !c.archived,
    );
    if (active.length <= CONVERSATION_SOFT_CAP) return;
    // Drop the LEAST-recently-active. Tiebreak: lower createdAt first.
    active.sort((a, b) => {
      if (a.lastActiveAt !== b.lastActiveAt) {
        return a.lastActiveAt - b.lastActiveAt;
      }
      return a.createdAt - b.createdAt;
    });
    // Don't archive the just-created one (it's lastActiveAt = now,
    // so naturally last in the sort, but double-check).
    const target = active[0];
    if (!target) return;
    if (target.id === this.activeId) {
      // Don't archive the active conversation; pick the next.
      const next = active[1];
      if (!next) return;
      this.archive(next.id);
      return;
    }
    this.archive(target.id);
  }

  private pickFallbackActive(): string | null {
    const candidates = Array.from(this.conversations.values()).filter(
      (c) => !c.archived,
    );
    if (candidates.length === 0) return null;
    candidates.sort((a, b) => b.lastActiveAt - a.lastActiveAt);
    return candidates[0].id;
  }

  private emit(event: ConversationChangeEvent): void {
    for (const fn of this.listeners) {
      try {
        fn(event);
      } catch (err) {
        console.error("[ConversationManager] listener threw", err);
      }
    }
  }
}

function cloneMeta(c: Conversation): Conversation {
  return {
    id: c.id,
    name: c.name,
    createdAt: c.createdAt,
    lastActiveAt: c.lastActiveAt,
    archived: c.archived === true ? true : undefined,
  };
}
