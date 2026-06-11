// UndoJournal: per-conversation log of filesystem write actions
// performed by our vault write tools, with one-step revert per entry.
//
// In-memory primarily; optionally persisted via the `persist` callback
// in v0.3+ so undo entries survive plugin reloads (FR-008/FR-010).
// Cleared on plugin reload only when persistence is disabled, on
// "Clear conversation", or on Obsidian restart — NOT on chat-view
// close (spec FR-013).
//
// MCP and built-in tool calls are NOT recorded. Their effects are
// out of scope for one-step revert.
//
// Per the Phase 6 design critique: each `undo` is guarded by a
// current-content check so a stale entry (the same path has been
// modified again since the recorded action) refuses to undo
// destructively. The journal reports the refusal via a returned
// `UndoOutcome` rather than throwing.
//
// v0.3 Phase 4: capped at `maxEntries` (default 50, mirroring SF-2 in
// `ConversationsStore.recordUndo`). When `record()` is called on a
// journal already at cap, the oldest in-memory entry is dropped
// before the new one is appended — keeping the in-memory journal in
// lockstep with the persisted store so the UI never shows Undo
// buttons for entries the store has already evicted.

import type { TFile, Vault } from "obsidian";
import type { PersistedUndoEntry } from "../persistence/PersistedShape";

export type UndoKind = "create" | "modify" | "delete";

export type UndoScope = "vault" | "extra-vault";

export interface UndoEntry {
  id: string;
  kind: UndoKind;
  scope: UndoScope;
  /** Vault-relative path for vault scope; absolute for extra-vault. */
  path: string;
  /** Content present before the action (for `modify` and `delete`). */
  before?: string;
  /** Content present after the action (for `create` and `modify`). Used for guard. */
  after?: string;
  /** Wall-clock timestamp of the action. */
  recordedAt: number;
  /** True once `undo` has run successfully — entry is then inert. */
  undone?: boolean;
}

export interface UndoOutcome {
  ok: boolean;
  /** If `ok === false`, a human-readable reason. */
  reason?: string;
  /**
   * v0.3 Phase 6 (FR-012): divergence classification when the guard
   * check fails. Lets the caller (chat view) decide between a one-shot
   * confirmation prompt and a hard refusal.
   *
   *  - `"ok"`        — no divergence; this field is set on success too
   *                    so callers can branch uniformly.
   *  - `"modified"`  — file exists but its content differs from the
   *                    recorded snapshot (`after` for create/modify,
   *                    something-vs-absence for delete).
   *  - `"missing"`   — the targeted file no longer exists (relevant
   *                    when undoing a `create` or `modify` whose
   *                    target was deleted externally).
   *  - `"existed"`   — undoing a `delete` but the path is already
   *                    occupied by a different file.
   */
  divergence?: "ok" | "modified" | "missing" | "existed";
}

/** Options accepted by `undo()`. */
export interface UndoOptions {
  /**
   * v0.3 Phase 6 (FR-012): bypass the content-divergence guard and
   * perform the revert anyway. The caller MUST have surfaced a
   * confirmation UI to the user before passing `true` — the journal
   * does not gate the force itself.
   */
  force?: boolean;
}

/**
 * Minimal vault surface UndoJournal needs. We accept a structurally
 * compatible shape so tests can pass a fake vault.
 */
export interface UndoJournalVault {
  getFileByPath?: (path: string) => unknown;
  getAbstractFileByPath?: (path: string) => unknown;
  read?: (file: unknown) => Promise<string>;
  cachedRead?: (file: unknown) => Promise<string>;
  create?: (path: string, content: string) => Promise<unknown>;
  modify?: (file: unknown, content: string) => Promise<unknown>;
  delete?: (file: unknown, system?: boolean) => Promise<void>;
  trash?: (file: unknown, system?: boolean) => Promise<void>;
}

/**
 * v0.3 Phase 4 persistence wiring. Optional so existing call sites
 * (and pre-v0.3 tests) that pass only the vault keep working.
 *
 * - `persist("add", entry)` is called AFTER the in-memory append, with
 *   the canonical entry (id + recordedAt populated).
 * - `persist("evict", entry)` is called BEFORE appending the new
 *   entry when the cap forced an eviction. The store mirrors this by
 *   dropping its own oldest record.
 * - `persist("mark-undone", entry)` is called after a successful
 *   `undo()` resolves (i.e., `e.undone = true`).
 *
 * Subscriber errors must NOT corrupt the journal — the persistence
 * callback is wrapped in try/catch by callers (the manager).
 */
export type UndoJournalPersistOp = "add" | "evict" | "mark-undone";

export interface UndoJournalOptions {
  vault: UndoJournalVault;
  /** Optional persistence sink (Phase 4). */
  persist?: (op: UndoJournalPersistOp, entry: UndoEntry) => void;
  /** Hydration entries (e.g. from `ConversationsStore`). */
  initialEntries?: PersistedUndoEntry[];
  /** SF-2 cap. Defaults to 50. */
  maxEntries?: number;
  /**
   * v0.3 Phase 6: defensive TTL backstop applied at hydrate time.
   * Authoritative TTL pruning happens in
   * `ConversationsStore.pruneOnLoad()` at plugin startup (it sees
   * every conversation including never-opened ones); this guard just
   * ensures that if a stale entry slipped through, the in-memory
   * journal won't surface it. Entries older than `ttlMs` (relative
   * to `now()`) are dropped during hydration and `persist("evict",
   * ...)` is fired so the store stays in lockstep.
   */
  loadOptions?: { ttlMs: number };
  /** Wall-clock shim for tests. */
  now?: () => number;
}

const DEFAULT_MAX_ENTRIES = 50;

export class UndoJournal {
  private readonly entries = new Map<string, UndoEntry>();
  /** Insertion order tracker so we can evict the oldest deterministically. */
  private readonly insertionOrder: string[] = [];
  private idCounter = 0;
  private readonly vault: UndoJournalVault;
  private readonly persist?: (op: UndoJournalPersistOp, entry: UndoEntry) => void;
  private readonly maxEntries: number;
  private readonly loadTtlMs?: number;
  private readonly now: () => number;

  /**
   * Backward-compatible constructor: legacy callers passed a vault
   * directly. v0.3 Phase 4 callers pass an options object with
   * persistence + hydration. We support both.
   */
  constructor(arg: UndoJournalVault | UndoJournalOptions) {
    if (isOptions(arg)) {
      this.vault = arg.vault;
      this.persist = arg.persist;
      this.maxEntries = arg.maxEntries ?? DEFAULT_MAX_ENTRIES;
      this.loadTtlMs = arg.loadOptions?.ttlMs;
      this.now = arg.now ?? (() => Date.now());
      // Hydrate. We don't fire `persist("add", ...)` for hydrated
      // entries — they're already in the store. We DO fire
      // `persist("evict", ...)` for TTL-expired entries so the store
      // mirrors the drop (Phase 6 backstop).
      if (arg.initialEntries) {
        const cutoff =
          this.loadTtlMs !== undefined ? this.now() - this.loadTtlMs : null;
        for (const e of arg.initialEntries) {
          if (cutoff !== null && e.recordedAt < cutoff) {
            const ghost: UndoEntry = {
              id: e.id,
              kind: e.kind,
              scope: e.scope,
              path: e.path,
              before: e.before,
              after: e.after,
              recordedAt: e.recordedAt,
              undone: e.undone,
            };
            this.safePersist("evict", ghost);
            continue;
          }
          this.hydrate(e);
        }
      }
    } else {
      this.vault = arg;
      this.maxEntries = DEFAULT_MAX_ENTRIES;
      this.now = () => Date.now();
    }
  }

  /**
   * Record a write action. Returns the canonical entry stored in the
   * journal (with assigned id and timestamp).
   *
   * Callers MUST call `record` only after the write has succeeded, so
   * a failed write doesn't poison the Undo button.
   *
   * If the journal is at `maxEntries`, the oldest entry is evicted
   * BEFORE the new one is appended (SF-2 lockstep with the persisted
   * store).
   */
  record(entry: Omit<UndoEntry, "id" | "recordedAt"> & { id?: string }): UndoEntry {
    if (this.entries.size >= this.maxEntries) {
      const oldestId = this.insertionOrder.shift();
      if (oldestId !== undefined) {
        const evicted = this.entries.get(oldestId);
        this.entries.delete(oldestId);
        if (evicted) this.safePersist("evict", evicted);
      }
    }
    const id = entry.id ?? `undo-${++this.idCounter}`;
    const stored: UndoEntry = {
      ...entry,
      id,
      recordedAt: this.now(),
    };
    this.entries.set(id, stored);
    this.insertionOrder.push(id);
    this.safePersist("add", stored);
    return stored;
  }

  get(id: string): UndoEntry | undefined {
    return this.entries.get(id);
  }

  /**
   * Attempt to revert the action with `id`. Returns `{ ok: true,
   * divergence: "ok" }` on success.
   *
   * v0.3 Phase 6 (FR-012): when the file has been modified outside
   * the agent since this entry was recorded, the result is
   * `{ ok: false, divergence: "modified" | "missing" | "existed",
   * reason }`. The caller (chat view) can then prompt the user and
   * re-call with `{ force: true }` to perform the revert anyway.
   *
   * Divergence is detected by **content comparison** (read current
   * file, compare to `after` for create/modify, or check existence
   * for delete). No filesystem metadata (mtime, size) is stored on
   * entries — see SI-1.
   */
  async undo(id: string, options: UndoOptions = {}): Promise<UndoOutcome> {
    const e = this.entries.get(id);
    if (!e) return { ok: false, reason: "Undo entry not found." };
    if (e.undone) {
      return { ok: false, reason: "This action has already been undone." };
    }
    if (e.scope !== "vault") {
      return {
        ok: false,
        reason: "Undo for extra-vault writes is not supported in this phase.",
      };
    }

    try {
      switch (e.kind) {
        case "create": {
          const file = this.lookup(e.path);
          if (!file) {
            if (!options.force) {
              return {
                ok: false,
                divergence: "missing",
                reason: `"${e.path}" no longer exists. Nothing to delete.`,
              };
            }
            // Force-undoing a create whose target is already gone is
            // a no-op success — the desired end state is reached.
            e.undone = true;
            this.safePersist("mark-undone", e);
            return { ok: true, divergence: "ok" };
          }
          const current = await this.readVault(file);
          if (
            !options.force &&
            e.after !== undefined &&
            current !== e.after
          ) {
            return {
              ok: false,
              divergence: "modified",
              reason: `"${e.path}" has changed since it was created.`,
            };
          }
          await this.deleteVault(file);
          e.undone = true;
          this.safePersist("mark-undone", e);
          return { ok: true, divergence: "ok" };
        }
        case "modify": {
          const file = this.lookup(e.path);
          if (!file) {
            if (!options.force) {
              return {
                ok: false,
                divergence: "missing",
                reason: `"${e.path}" no longer exists. Recreate from snapshot?`,
              };
            }
            // Force-undoing a modify whose target was deleted →
            // recreate from the `before` snapshot.
            if (e.before === undefined) {
              return {
                ok: false,
                reason: "Cannot undo: no recorded prior content.",
              };
            }
            await this.createVault(e.path, e.before);
            e.undone = true;
            this.safePersist("mark-undone", e);
            return { ok: true, divergence: "ok" };
          }
          const current = await this.readVault(file);
          if (
            !options.force &&
            e.after !== undefined &&
            current !== e.after
          ) {
            return {
              ok: false,
              divergence: "modified",
              reason: `"${e.path}" has changed since this edit.`,
            };
          }
          if (e.before === undefined) {
            return {
              ok: false,
              reason: "Cannot undo: no recorded prior content.",
            };
          }
          await this.modifyVault(file, e.before);
          e.undone = true;
          this.safePersist("mark-undone", e);
          return { ok: true, divergence: "ok" };
        }
        case "delete": {
          const existing = this.lookup(e.path);
          if (existing) {
            if (!options.force) {
              return {
                ok: false,
                divergence: "existed",
                reason: `"${e.path}" already exists. Overwrite with snapshot?`,
              };
            }
            // Force-undoing a delete whose path is now occupied →
            // overwrite the current content with our snapshot.
            if (e.before === undefined) {
              return {
                ok: false,
                reason: "Cannot undo: no recorded prior content.",
              };
            }
            await this.modifyVault(existing, e.before);
            e.undone = true;
            this.safePersist("mark-undone", e);
            return { ok: true, divergence: "ok" };
          }
          if (e.before === undefined) {
            return {
              ok: false,
              reason: "Cannot undo: no recorded prior content.",
            };
          }
          await this.createVault(e.path, e.before);
          e.undone = true;
          this.safePersist("mark-undone", e);
          return { ok: true, divergence: "ok" };
        }
        default: {
          const exhaustive: never = e.kind;
          void exhaustive;
          return { ok: false, reason: "Unknown undo kind." };
        }
      }
    } catch (err) {
      return {
        ok: false,
        reason: `Undo failed: ${(err as Error).message || String(err)}`,
      };
    }
  }

  /** Wipe the journal (plugin reload / clear conversation). */
  clear(): void {
    this.entries.clear();
    this.insertionOrder.length = 0;
  }

  // ---- internal ----

  private hydrate(p: PersistedUndoEntry): void {
    if (this.entries.has(p.id)) return;
    if (this.entries.size >= this.maxEntries) {
      const oldestId = this.insertionOrder.shift();
      if (oldestId !== undefined) this.entries.delete(oldestId);
    }
    const entry: UndoEntry = {
      id: p.id,
      kind: p.kind,
      scope: p.scope,
      path: p.path,
      before: p.before,
      after: p.after,
      recordedAt: p.recordedAt,
      undone: p.undone,
    };
    this.entries.set(p.id, entry);
    this.insertionOrder.push(p.id);
    // Advance the counter past any persisted id that follows our
    // `undo-<n>` convention, so the first record() after a hydrate
    // doesn't reuse an already-taken id and overwrite history.
    const m = /^undo-(\d+)$/.exec(p.id);
    if (m) {
      const n = Number(m[1]);
      if (Number.isFinite(n) && n > this.idCounter) this.idCounter = n;
    }
  }

  private safePersist(op: UndoJournalPersistOp, entry: UndoEntry): void {
    if (!this.persist) return;
    try {
      this.persist(op, entry);
    } catch (err) {
      console.error("[UndoJournal] persist callback threw", err);
    }
  }

  // ---- Vault adapter helpers (work with both real Obsidian Vault and our fake) ----

  private lookup(vaultPath: string): unknown | null {
    const get =
      this.vault.getFileByPath ?? this.vault.getAbstractFileByPath;
    if (!get) return null;
    return get.call(this.vault, vaultPath) ?? null;
  }

  private async readVault(file: unknown): Promise<string> {
    if (this.vault.cachedRead) return this.vault.cachedRead(file);
    if (this.vault.read) return this.vault.read(file);
    throw new Error("Vault has no read method");
  }

  private async createVault(path: string, content: string): Promise<unknown> {
    if (!this.vault.create) throw new Error("Vault has no create method");
    return this.vault.create(path, content);
  }

  private async modifyVault(file: unknown, content: string): Promise<unknown> {
    if (!this.vault.modify) throw new Error("Vault has no modify method");
    return this.vault.modify(file, content);
  }

  private async deleteVault(file: unknown): Promise<void> {
    if (this.vault.trash) return this.vault.trash(file, true);
    if (this.vault.delete) return this.vault.delete(file, true);
    throw new Error("Vault has no delete method");
  }
}

function isOptions(
  arg: UndoJournalVault | UndoJournalOptions,
): arg is UndoJournalOptions {
  return (
    typeof arg === "object" &&
    arg !== null &&
    "vault" in arg &&
    typeof (arg as UndoJournalOptions).vault === "object"
  );
}

/** Re-export helper to satisfy unused-import lints when TFile shows up only in JSDoc. */
export type _UndoTFile = TFile;
export type _UndoVault = Vault;

