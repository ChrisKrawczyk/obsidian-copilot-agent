/**
 * v0.3 Phase 3: ConversationsStore.
 *
 * Owns the `conversations`, `activeConversationId`, and `schemaVersion`
 * top-level keys of the shared `data.json` blob. Lives alongside
 * `TokenStore` (auth) and `SafetySettingsStore` (safety/settings),
 * mirroring their tail-serialised, merge-and-write contract so
 * concurrent stores don't clobber each other's subtrees.
 *
 * Three correctness concerns drive the implementation:
 *
 *  1. `saveData()` writes the WHOLE plugin data blob. Three stores can
 *     concurrently `loadData → mutate → saveData`. We always re-read
 *     the latest blob inside `flush()` and merge our cached delta on
 *     top so unrelated keys (`auth`, `safety`, `settings`) survive.
 *
 *  2. We can write very frequently (every chat append, every undo
 *     record). Spec NFR mandates ≤ 1 write / 500 ms — `scheduleFlush()`
 *     coalesces calls into a single tail write.
 *
 *  3. A fast Obsidian close after a switch / message-append must NOT
 *     lose the last update. `flushNow()` cancels the debounce timer
 *     and resolves only after the synchronous write completes.
 *     `CopilotAgentPlugin.onunload()` (Phase 5) calls it.
 *
 * Recovery: when load encounters a malformed payload (unknown
 * `schemaVersion` OR structural mismatch), we:
 *   (a) write the malformed `conversations` subtree (and the keys we
 *       control) to a sibling backup at
 *       `<plugin-data-dir>/conversations_recovery.bak.json`,
 *   (b) overwrite ONLY our top-level keys with defaults (auth/safety
 *       remain intact),
 *   (c) return defaults plus `recovered: true` so the plugin can show
 *       a Notice naming the backup path.
 *
 * The shared `data.json` is NEVER renamed.
 */

import type { PluginDataIO } from "../auth/TokenStore";
import { migrate } from "./migrate";
import {
  CURRENT_SCHEMA_VERSION,
  type PersistedConversation,
  type PersistedConversationsState,
  type PersistedMessage,
  type PersistedUndoEntry,
} from "./PersistedShape";

/** Minimal `vault.adapter` surface needed to write the recovery sidecar. */
export interface ConversationsAdapter {
  /** Write a UTF-8 file at a vault-relative path. */
  write(path: string, data: string): Promise<void>;
  /** True if the plugin data dir is known. Used to compose the
   *  sidecar path. */
  exists?(path: string): Promise<boolean>;
}

export interface ConversationsStoreOptions {
  io: PluginDataIO;
  adapter: ConversationsAdapter;
  /**
   * Vault-relative path of the plugin's data directory (containing
   * `data.json`). The recovery sidecar is written next to it.
   * Typically `<vault>/.obsidian/plugins/<plugin-id>` — `main.ts`
   * resolves it from `app.vault.configDir + "/plugins/" + manifest.id`.
   */
  pluginDataDir: string;
  /**
   * Debounce window in ms. Defaults to 500 (spec NFR). Tests can pass
   * 0 to make `scheduleFlush` behave like `flushNow`.
   */
  debounceMs?: number;
  /**
   * Now() shim for deterministic testing of TTL pruning. Defaults to
   * `Date.now`.
   */
  now?: () => number;
  /**
   * v0.3 Phase 6 (SC-011): hook fired the first time a write produces
   * a JSON payload ≥ 5 MB. Used by `main.ts` to show a one-shot
   * Notice prompting the user to prune old conversations. Optional so
   * tests don't have to mock it.
   */
  notify?: (message: string) => void;
}

export interface LoadResult {
  state: PersistedConversationsState;
  /** True when load triggered the recovery path. The plugin should
   *  show a Notice naming the sidecar file. */
  recovered: boolean;
  /** Sidecar path written when `recovered === true`. */
  recoveryPath?: string;
}

/** TTL applied by `pruneOnLoad()`: 7 days in ms. */
export const UNDO_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** SF-2 cap. */
export const UNDO_MAX_ENTRIES = 50;

/** Default debounce window per spec NFR. */
export const DEFAULT_DEBOUNCE_MS = 500;

/** v0.3 Phase 6 (SC-011): one-shot warning threshold for persisted
 *  data size. Surfaced via `notify` callback exactly once per session. */
export const SIZE_WARN_BYTES = 5 * 1024 * 1024;

const RECOVERY_SIDECAR_NAME = "conversations_recovery.bak.json";

/**
 * Top-level shape we read/write. Other stores own the elided keys
 * (`auth`, `safety`, `settings`) and we MUST preserve them.
 */
interface PersistedTopShape {
  schemaVersion?: number;
  conversations?: unknown;
  activeConversationId?: unknown;
  // Other keys (auth, safety, settings) flow through unchanged.
  [key: string]: unknown;
}

export class ConversationsStore {
  private tail: Promise<void> = Promise.resolve();
  private cached: PersistedConversationsState = cloneDefaultState();
  private loaded = false;
  private dirty = false;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly debounceMs: number;
  private readonly now: () => number;
  /** v0.3 Phase 6: fires the SC-011 size warning exactly once. */
  private sizeWarned = false;

  constructor(private readonly opts: ConversationsStoreOptions) {
    this.debounceMs = opts.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.now = opts.now ?? (() => Date.now());
  }

  // ---------------- Load ----------------

  async load(): Promise<LoadResult> {
    const raw = (await this.opts.io.loadData()) as
      | PersistedTopShape
      | null
      | undefined;

    // Extract just our subtree for migration.
    const ourSubtree =
      raw && typeof raw === "object"
        ? {
            schemaVersion: raw.schemaVersion,
            conversations: raw.conversations,
            activeConversationId: raw.activeConversationId,
          }
        : null;

    // Treat "no prior state" (whole blob missing or our keys absent)
    // as a clean default — NOT recovery. We only recover when there
    // is something there and it's malformed.
    const isPriorState =
      ourSubtree != null &&
      (ourSubtree.schemaVersion !== undefined ||
        ourSubtree.conversations !== undefined ||
        ourSubtree.activeConversationId !== undefined);

    if (!isPriorState) {
      this.cached = cloneDefaultState();
      this.loaded = true;
      return { state: snapshotState(this.cached), recovered: false };
    }

    const result = migrate(ourSubtree);
    this.loaded = true;

    if (result.recovered) {
      const recoveryPath = await this.writeRecoverySidecar(result.malformed);
      this.cached = result.state;
      // Overwrite ONLY our keys with defaults; preserve auth/safety.
      // Mark dirty so flushImmediate doesn't short-circuit.
      this.dirty = true;
      await this.flushImmediate();
      return {
        state: snapshotState(this.cached),
        recovered: true,
        recoveryPath,
      };
    }

    this.cached = result.state;
    return { state: snapshotState(this.cached), recovered: false };
  }

  // ---------------- Public API ----------------

  getActiveId(): string | null {
    this.assertLoaded();
    return this.cached.activeConversationId;
  }

  setActiveId(id: string | null): void {
    this.assertLoaded();
    if (id !== null && !this.cached.conversations.some((c) => c.id === id)) {
      throw new Error(
        `setActiveId: no conversation with id "${id}" in store`,
      );
    }
    if (this.cached.activeConversationId === id) return;
    this.cached = {
      ...this.cached,
      activeConversationId: id,
    };
    this.markDirty();
  }

  listConversations(): PersistedConversation[] {
    this.assertLoaded();
    return this.cached.conversations.map(cloneConversation);
  }

  upsertConversation(conv: PersistedConversation): void {
    this.assertLoaded();
    const cleaned = cloneConversation(conv);
    const idx = this.cached.conversations.findIndex((c) => c.id === cleaned.id);
    // CONS-2 / SC-001: guard against quiescent re-writes. When
    // ConversationManager.hydrate mirrors persisted rows back into the
    // store on plugin load, normalising both sides through
    // cloneConversation gives us a deterministic JSON-stringify shape
    // we can short-circuit on. Without this guard a clean restart
    // marks the store dirty and re-flushes data.json even though no
    // user action occurred.
    if (idx >= 0) {
      const existingNorm = cloneConversation(this.cached.conversations[idx]);
      if (JSON.stringify(existingNorm) === JSON.stringify(cleaned)) {
        return;
      }
    }
    const next = [...this.cached.conversations];
    if (idx >= 0) {
      next[idx] = cleaned;
    } else {
      next.push(cleaned);
    }
    this.cached = { ...this.cached, conversations: next };
    this.markDirty();
  }

  removeConversation(id: string): void {
    this.assertLoaded();
    const before = this.cached.conversations.length;
    const next = this.cached.conversations.filter((c) => c.id !== id);
    if (next.length === before) return;
    const newActive =
      this.cached.activeConversationId === id
        ? null
        : this.cached.activeConversationId;
    this.cached = {
      ...this.cached,
      conversations: next,
      activeConversationId: newActive,
    };
    this.markDirty();
  }

  appendMessage(convId: string, msg: PersistedMessage): void {
    this.assertLoaded();
    const idx = this.requireConvIndex(convId);
    const conv = this.cached.conversations[idx];
    const updated: PersistedConversation = {
      ...conv,
      messages: [...conv.messages, { ...msg }],
      lastActiveAt: this.now(),
    };
    this.replaceConvAt(idx, updated);
    this.markDirty();
  }

  replaceMessage(
    convId: string,
    msgId: string,
    partial: Partial<PersistedMessage>,
  ): void {
    this.assertLoaded();
    const idx = this.requireConvIndex(convId);
    const conv = this.cached.conversations[idx];
    const mIdx = conv.messages.findIndex((m) => m.id === msgId);
    if (mIdx < 0) return;
    const next = [...conv.messages];
    next[mIdx] = { ...next[mIdx], ...partial, id: next[mIdx].id };
    this.replaceConvAt(idx, { ...conv, messages: next });
    this.markDirty();
  }

  /**
   * SF-2: enforce the 50-entry cap synchronously. If the conversation
   * already has `UNDO_MAX_ENTRIES` entries, the OLDEST is dropped
   * before the new one is appended. The eviction is reported via the
   * return value so the in-memory journal can drop its mirror entry
   * (Phase 4).
   */
  recordUndo(
    convId: string,
    entry: PersistedUndoEntry,
  ): { evictedId: string | null } {
    this.assertLoaded();
    const idx = this.requireConvIndex(convId);
    const conv = this.cached.conversations[idx];
    let evictedId: string | null = null;
    let nextEntries = [...conv.undoEntries];
    if (nextEntries.length >= UNDO_MAX_ENTRIES) {
      // Drop oldest by recordedAt; if already capped to 50, that's the
      // first entry (entries are appended chronologically). Be defensive
      // in case a hand-edited blob has out-of-order entries.
      const oldestIdx = findOldestIdx(nextEntries);
      evictedId = nextEntries[oldestIdx].id;
      nextEntries.splice(oldestIdx, 1);
    }
    nextEntries.push({ ...entry });
    this.replaceConvAt(idx, { ...conv, undoEntries: nextEntries });
    this.markDirty();
    return { evictedId };
  }

  markUndone(convId: string, entryId: string): void {
    this.assertLoaded();
    const idx = this.requireConvIndex(convId);
    const conv = this.cached.conversations[idx];
    const eIdx = conv.undoEntries.findIndex((e) => e.id === entryId);
    if (eIdx < 0) return;
    if (conv.undoEntries[eIdx].undone) return;
    const next = [...conv.undoEntries];
    next[eIdx] = { ...next[eIdx], undone: true };
    this.replaceConvAt(idx, { ...conv, undoEntries: next });
    this.markDirty();
    // v0.3 Phase 6 (FR-013): undo success must survive a fast restart,
    // so bypass the 500ms debounce and write through immediately.
    // We fire-and-forget here — the write is queued onto `this.tail`
    // so concurrent callers still see a consistent serial ordering.
    void this.flushNow().catch((err) => {
      console.warn(
        "[ConversationsStore] markUndone immediate flush failed",
        err,
      );
    });
  }

  /**
   * v0.3 Phase 6: drop a single undo entry from a conversation. Used
   * to mirror an in-memory `UndoJournal` eviction (TTL backstop or
   * max-cap trim) so the persisted store doesn't accumulate ghost
   * entries that the journal has already forgotten about. No-op if
   * the conversation or entry is missing — callers (the manager's
   * persist adapter) may run before the store has caught up.
   */
  removeUndoEntry(convId: string, entryId: string): void {
    this.assertLoaded();
    const idx = this.findConvIndex(convId);
    if (idx < 0) return;
    const conv = this.cached.conversations[idx];
    const eIdx = conv.undoEntries.findIndex((e) => e.id === entryId);
    if (eIdx < 0) return;
    const next = conv.undoEntries.filter((_, i) => i !== eIdx);
    this.replaceConvAt(idx, { ...conv, undoEntries: next });
    this.markDirty();
  }

  /**
   * Drop undo entries older than the 7-day TTL across ALL persisted
   * conversations. Called from `main.ts` BEFORE any
   * `ConversationRuntime` is instantiated (per Phase 4 architecture)
   * so journal-level pruning doesn't miss never-opened conversations.
   *
   * Idempotent: prunes against `now()` each call; entries inside the
   * TTL window are untouched.
   */
  pruneOnLoad(): { droppedCount: number } {
    this.assertLoaded();
    const cutoff = this.now() - UNDO_TTL_MS;
    let dropped = 0;
    const conversations = this.cached.conversations.map((conv) => {
      const kept = conv.undoEntries.filter((e) => {
        if (e.recordedAt >= cutoff) return true;
        dropped++;
        return false;
      });
      if (kept.length === conv.undoEntries.length) return conv;
      return { ...conv, undoEntries: kept };
    });
    if (dropped === 0) return { droppedCount: 0 };
    this.cached = { ...this.cached, conversations };
    this.markDirty();
    return { droppedCount: dropped };
  }

  /** Force-flush any pending debounce; resolves after the write
   *  completes. Safe to call when nothing is dirty (no-op). */
  async flushNow(): Promise<void> {
    this.assertLoaded();
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    await this.flushImmediate();
  }

  /** Returns a snapshot of the in-memory state. Useful for tests and
   *  for the manager's hydration step. */
  snapshot(): PersistedConversationsState {
    this.assertLoaded();
    return snapshotState(this.cached);
  }

  // ---------------- Internals ----------------

  private assertLoaded(): void {
    if (!this.loaded) {
      throw new Error("ConversationsStore.load() must be called before use");
    }
  }

  private requireConvIndex(convId: string): number {
    const idx = this.findConvIndex(convId);
    if (idx < 0) {
      throw new Error(`No conversation with id "${convId}" in store`);
    }
    return idx;
  }

  private findConvIndex(convId: string): number {
    return this.cached.conversations.findIndex((c) => c.id === convId);
  }

  private replaceConvAt(idx: number, conv: PersistedConversation): void {
    const next = [...this.cached.conversations];
    next[idx] = conv;
    this.cached = { ...this.cached, conversations: next };
  }

  private markDirty(): void {
    this.dirty = true;
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (this.debounceMs === 0) {
      // Tests can bypass the timer entirely.
      void this.flushImmediate();
      return;
    }
    if (this.debounceTimer) return;
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      void this.flushImmediate();
    }, this.debounceMs);
  }

  private flushImmediate(): Promise<void> {
    return this.enqueue(async () => {
      if (!this.dirty) return;
      this.dirty = false;
      const fresh = (await this.opts.io.loadData()) as
        | PersistedTopShape
        | null
        | undefined;
      const base: PersistedTopShape =
        fresh && typeof fresh === "object" ? { ...fresh } : {};
      const merged: PersistedTopShape = {
        ...base,
        schemaVersion: CURRENT_SCHEMA_VERSION,
        conversations: this.cached.conversations,
        activeConversationId: this.cached.activeConversationId,
      };
      await this.opts.io.saveData(merged);
      // SC-011: one-shot warning when persisted size crosses 5 MB.
      // Approximated via JSON.stringify on the merged payload; cheap
      // enough at flush cadence and avoids needing adapter byte
      // counters. The flag prevents Notice spam — user can keep
      // working without being nagged on every subsequent flush.
      if (!this.sizeWarned && this.opts.notify) {
        try {
          const bytes = JSON.stringify(merged).length;
          if (bytes >= SIZE_WARN_BYTES) {
            this.sizeWarned = true;
            this.opts.notify(
              "Copilot Agent: conversation data exceeds 5 MB. " +
                "Consider archiving or deleting old conversations.",
            );
          }
        } catch {
          // Serialization failure shouldn't break the flush.
        }
      }
    });
  }

  private enqueue(fn: () => Promise<void>): Promise<void> {
    const next = this.tail.then(fn, fn);
    this.tail = next.then(
      () => {},
      () => {},
    );
    return next;
  }

  private async writeRecoverySidecar(malformed: unknown): Promise<string> {
    const path = joinPath(this.opts.pluginDataDir, RECOVERY_SIDECAR_NAME);
    const payload = {
      recoveredAt: new Date(this.now()).toISOString(),
      schemaVersionExpected: CURRENT_SCHEMA_VERSION,
      malformed,
    };
    try {
      await this.opts.adapter.write(path, JSON.stringify(payload, null, 2));
    } catch (err) {
      // Recovery is best-effort: if the sidecar write fails the user
      // still gets defaults and a recovered:true flag. Log so the
      // failure is visible in the dev console.
      console.error(
        "[ConversationsStore] failed to write recovery sidecar",
        err,
      );
    }
    return path;
  }
}

// ---------------- Helpers ----------------

function cloneDefaultState(): PersistedConversationsState {
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    conversations: [],
    activeConversationId: null,
  };
}

function snapshotState(s: PersistedConversationsState): PersistedConversationsState {
  return {
    schemaVersion: s.schemaVersion,
    activeConversationId: s.activeConversationId,
    conversations: s.conversations.map(cloneConversation),
  };
}

function cloneConversation(c: PersistedConversation): PersistedConversation {
  return {
    id: c.id,
    name: c.name,
    createdAt: c.createdAt,
    lastActiveAt: c.lastActiveAt,
    archived: c.archived === true ? true : undefined,
    messages: c.messages.map((m) => ({
      ...m,
      toolCalls: m.toolCalls?.map((tc) => ({ ...tc })),
    })),
    undoEntries: c.undoEntries.map((e) => ({ ...e })),
  };
}

function findOldestIdx(entries: PersistedUndoEntry[]): number {
  let oldestIdx = 0;
  let oldestAt = entries[0].recordedAt;
  for (let i = 1; i < entries.length; i++) {
    if (entries[i].recordedAt < oldestAt) {
      oldestAt = entries[i].recordedAt;
      oldestIdx = i;
    }
  }
  return oldestIdx;
}

function joinPath(dir: string, name: string): string {
  if (dir.endsWith("/") || dir.endsWith("\\")) return dir + name;
  return `${dir}/${name}`;
}
