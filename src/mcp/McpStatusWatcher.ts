/**
 * McpStatusWatcher — pure module that observes MCP server status
 * transitions from {@link McpManager} and exposes two independent
 * emission surfaces to plugin consumers.
 *
 * Two-surface design (per plan-review):
 *  - `onTransition(listener)` — leading-edge, no debounce. Fires on
 *    every observed transition into or out of the "connected" state.
 *    Consumed by the plugin's live tool-list refresh path, which has
 *    a 2 s latency bound (FR-004/005/007). Bypasses the coarser 5 s
 *    coalescing window so refresh dispatch is never throttled by
 *    the notice throttle.
 *  - `onNotice(listener)` — trailing-edge, 5 s per-server window.
 *    Fires at most once per serverId per 5 s window with the
 *    terminal state at window close. Consumed by user-visible
 *    "Tools from X are now available" Notices (FR-012 / SC-007).
 *
 * `snapshotPending()` returns pending servers for the composer
 * indicator, including enabled servers whose runtime has not yet
 * been instantiated ("no-runtime-yet"). This satisfies FR-002 by
 * naming servers the gate is waiting on even during the pre-init
 * window before `getOrCreate` fires.
 *
 * The watcher does not import any UI or Notice APIs; it stays pure
 * so it is trivially testable with fake timers.
 */

import type { McpManager } from "./McpManager";
import type {
  McpRuntimeStatus,
  McpServerConfig,
  McpServerId,
} from "./McpTypes";

export type McpStatusTransition = {
  serverId: McpServerId;
  kind: "connected" | "disconnected";
};

export type McpStatusNotice = {
  serverId: McpServerId;
  kind: "connected" | "disconnected";
};

export type McpPendingServer = {
  id: McpServerId;
  state: "connecting" | "reconnecting" | "disconnected" | "no-runtime-yet";
};

export interface McpStatusWatcherOptions {
  manager: McpManager;
  serversProvider: () => readonly McpServerConfig[];
  /**
   * Coalescing window for the `onNotice` surface, per-server, in ms.
   * Defaults to 5000 (SC-007). Injectable for tests.
   */
  noticeWindowMs?: number;
  /** Injectable timer/clock for tests. */
  setTimeoutFn?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimeoutFn?: (id: ReturnType<typeof setTimeout>) => void;
  /** Optional error sink; defaults to a no-op. */
  onError?: (err: unknown) => void;
}

type TransitionListener = (evt: McpStatusTransition) => void;
type NoticeListener = (evt: McpStatusNotice) => void;

const NOTICE_WINDOW_DEFAULT_MS = 5_000;

const isConnected = (status: McpRuntimeStatus | undefined): boolean =>
  status === "connected";

export class McpStatusWatcher {
  private readonly manager: McpManager;
  private readonly serversProvider: () => readonly McpServerConfig[];
  private readonly noticeWindowMs: number;
  private readonly setTimeoutFn: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  private readonly clearTimeoutFn: (id: ReturnType<typeof setTimeout>) => void;
  private readonly onError: (err: unknown) => void;

  private readonly transitionListeners = new Set<TransitionListener>();
  private readonly noticeListeners = new Set<NoticeListener>();

  /** Last observed connected/not-connected classification per server. */
  private lastConnected = new Map<McpServerId, boolean>();

  /** Pending notice-window timers per server. Absent = no open window. */
  private noticeTimers = new Map<McpServerId, ReturnType<typeof setTimeout>>();
  /** Latest kind observed inside an open notice window (wins on close). */
  private noticePending = new Map<McpServerId, "connected" | "disconnected">();

  private unsubscribe: (() => void) | null = null;
  private disposed = false;

  constructor(opts: McpStatusWatcherOptions) {
    this.manager = opts.manager;
    this.serversProvider = opts.serversProvider;
    this.noticeWindowMs = opts.noticeWindowMs ?? NOTICE_WINDOW_DEFAULT_MS;
    this.setTimeoutFn = opts.setTimeoutFn ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimeoutFn = opts.clearTimeoutFn ?? ((id) => clearTimeout(id));
    this.onError = opts.onError ?? (() => undefined);

    this.seedInitialState();
    this.unsubscribe = this.manager.subscribe(() => this.handleManagerEmit());
  }

  onTransition(listener: TransitionListener): () => void {
    this.transitionListeners.add(listener);
    return () => this.transitionListeners.delete(listener);
  }

  onNotice(listener: NoticeListener): () => void {
    this.noticeListeners.add(listener);
    return () => this.noticeListeners.delete(listener);
  }

  /**
   * Returns the set of enabled servers that are not currently in the
   * `connected` terminal state, including enabled servers whose
   * runtime snapshot is absent entirely ("no-runtime-yet"). Used by
   * the ChatView readiness pill to name pending servers (FR-002).
   */
  snapshotPending(): readonly McpPendingServer[] {
    const enabled = this.serversProvider().filter((c) => c.enabled);
    const statusById = new Map(this.manager.statusSnapshot().map((s) => [s.id, s.status] as const));
    const pending: McpPendingServer[] = [];
    for (const cfg of enabled) {
      const status = statusById.get(cfg.id);
      if (status === undefined) {
        pending.push({ id: cfg.id, state: "no-runtime-yet" });
        continue;
      }
      if (status === "connecting") {
        pending.push({ id: cfg.id, state: "connecting" });
        continue;
      }
      if (status === "reconnecting") {
        pending.push({ id: cfg.id, state: "reconnecting" });
        continue;
      }
      if (status === "disconnected") {
        pending.push({ id: cfg.id, state: "disconnected" });
        continue;
      }
      // "connected", "error", "crashloop", "disabled" → not pending.
    }
    return pending;
  }

  disposeAll(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const id of this.noticeTimers.values()) {
      this.clearTimeoutFn(id);
    }
    this.noticeTimers.clear();
    this.noticePending.clear();
    this.transitionListeners.clear();
    this.noticeListeners.clear();
    if (this.unsubscribe) {
      try {
        this.unsubscribe();
      } catch (err) {
        this.onError(err);
      }
      this.unsubscribe = null;
    }
  }

  // --- internals -----------------------------------------------------

  private seedInitialState(): void {
    for (const snap of this.manager.statusSnapshot()) {
      this.lastConnected.set(snap.id, isConnected(snap.status));
    }
  }

  private handleManagerEmit(): void {
    if (this.disposed) return;
    const seen = new Set<McpServerId>();
    for (const snap of this.manager.statusSnapshot()) {
      seen.add(snap.id);
      const wasConnected = this.lastConnected.get(snap.id) ?? false;
      const nowConnected = isConnected(snap.status);
      if (wasConnected === nowConnected && this.lastConnected.has(snap.id)) continue;
      this.lastConnected.set(snap.id, nowConnected);
      const kind = nowConnected ? "connected" : "disconnected";
      this.emitTransition({ serverId: snap.id, kind });
      this.scheduleNotice(snap.id, kind);
    }
    // Drop tracking for removed servers so a re-add gets a fresh window.
    for (const id of Array.from(this.lastConnected.keys())) {
      if (!seen.has(id)) {
        this.lastConnected.delete(id);
        const pending = this.noticeTimers.get(id);
        if (pending) {
          this.clearTimeoutFn(pending);
          this.noticeTimers.delete(id);
        }
        this.noticePending.delete(id);
      }
    }
  }

  private emitTransition(evt: McpStatusTransition): void {
    for (const listener of this.transitionListeners) {
      try {
        listener(evt);
      } catch (err) {
        this.onError(err);
      }
    }
  }

  private scheduleNotice(serverId: McpServerId, kind: "connected" | "disconnected"): void {
    // Always update pending kind — the terminal state at window close wins.
    this.noticePending.set(serverId, kind);
    if (this.noticeTimers.has(serverId)) return;
    const timer = this.setTimeoutFn(() => {
      const finalKind = this.noticePending.get(serverId);
      this.noticePending.delete(serverId);
      this.noticeTimers.delete(serverId);
      if (!finalKind) return;
      for (const listener of this.noticeListeners) {
        try {
          listener({ serverId, kind: finalKind });
        } catch (err) {
          this.onError(err);
        }
      }
    }, this.noticeWindowMs);
    this.noticeTimers.set(serverId, timer);
  }
}
