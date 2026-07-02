import { describe, expect, test, vi } from "vitest";
import { McpStatusWatcher } from "./McpStatusWatcher";
import type {
  McpRuntimeStatus,
  McpServerConfig,
  McpServerId,
  McpServerRuntimeSnapshot,
} from "./McpTypes";
import type { McpManager } from "./McpManager";

/**
 * Minimal in-memory manager double that matches the subset of the
 * McpManager surface consumed by McpStatusWatcher: `subscribe(fn)`
 * and `statusSnapshot()`. Constructing a real McpManager for these
 * tests would exercise transports and reconnect policy, which is
 * out of scope for the watcher.
 */
class FakeManager {
  private listeners = new Set<() => void>();
  private snap: McpServerRuntimeSnapshot[] = [];

  statusSnapshot(): readonly McpServerRuntimeSnapshot[] {
    return this.snap;
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  setStatus(id: string, status: McpRuntimeStatus): void {
    const idx = this.snap.findIndex((s) => s.id === (id as McpServerId));
    const entry: McpServerRuntimeSnapshot = { id: id as McpServerId, status };
    if (idx >= 0) this.snap[idx] = entry;
    else this.snap = [...this.snap, entry];
    this.emit();
  }

  removeSnapshot(id: string): void {
    this.snap = this.snap.filter((s) => s.id !== (id as McpServerId));
    this.emit();
  }

  private emit(): void {
    for (const l of this.listeners) l();
  }
}

const cfg = (id: string, enabled = true): McpServerConfig =>
  ({
    id: id as McpServerId,
    name: id,
    enabled,
    trustEpoch: "epoch-1" as McpServerConfig["trustEpoch"],
    transport: "stdio",
    command: "node",
    args: [],
  }) as McpServerConfig;

const asManager = (m: FakeManager): McpManager => m as unknown as McpManager;

describe("McpStatusWatcher", () => {
  test("onTransition fires on connect and disconnect with correct payload", () => {
    const mgr = new FakeManager();
    mgr.setStatus("s1", "connecting");
    const configs: McpServerConfig[] = [cfg("s1")];
    const watcher = new McpStatusWatcher({
      manager: asManager(mgr),
      serversProvider: () => configs,
    });
    const events: Array<{ serverId: string; kind: string }> = [];
    watcher.onTransition((e) => events.push({ serverId: String(e.serverId), kind: e.kind }));

    mgr.setStatus("s1", "connected");
    mgr.setStatus("s1", "disconnected");

    expect(events).toEqual([
      { serverId: "s1", kind: "connected" },
      { serverId: "s1", kind: "disconnected" },
    ]);
    watcher.disposeAll();
  });

  test("onTransition fires within a tight microtask/sync latency budget", () => {
    // The watcher forwards synchronously on the manager's `emit()` callback,
    // so listener invocation completes in the same tick — no timer at all.
    const mgr = new FakeManager();
    mgr.setStatus("s1", "connecting");
    const watcher = new McpStatusWatcher({
      manager: asManager(mgr),
      serversProvider: () => [cfg("s1")],
    });
    let observedAt: number | null = null;
    const start = performance.now();
    watcher.onTransition(() => {
      observedAt = performance.now();
    });
    mgr.setStatus("s1", "connected");
    expect(observedAt).not.toBeNull();
    // Comfortably below the 200 ms plan budget — this is a pure JS callback,
    // so we assert a much tighter bound to guard against regressions.
    expect((observedAt as unknown as number) - start).toBeLessThan(50);
    watcher.disposeAll();
  });

  test("onNotice coalesces within 5 s window per server; onTransition is independent", () => {
    vi.useFakeTimers();
    try {
      const mgr = new FakeManager();
      mgr.setStatus("s1", "connecting");
      const watcher = new McpStatusWatcher({
        manager: asManager(mgr),
        serversProvider: () => [cfg("s1")],
      });
      const transitions: Array<{ kind: string }> = [];
      const notices: Array<{ kind: string }> = [];
      watcher.onTransition((e) => transitions.push({ kind: e.kind }));
      watcher.onNotice((e) => notices.push({ kind: e.kind }));

      // 30 flips over 30 seconds (1 flip / sec). SC-007: ≤ 6 notices.
      for (let i = 0; i < 30; i++) {
        mgr.setStatus("s1", i % 2 === 0 ? "connected" : "disconnected");
        vi.advanceTimersByTime(1_000);
      }
      // Drain any remaining pending notice window.
      vi.advanceTimersByTime(6_000);

      expect(transitions.length).toBe(30);
      expect(notices.length).toBeLessThanOrEqual(6);
      // Also assert monotonic behavior: at least 1 notice fired.
      expect(notices.length).toBeGreaterThanOrEqual(1);
      watcher.disposeAll();
    } finally {
      vi.useRealTimers();
    }
  });

  test("onNotice window-close uses the latest observed kind (last-write-wins)", () => {
    vi.useFakeTimers();
    try {
      const mgr = new FakeManager();
      mgr.setStatus("s1", "connecting");
      const watcher = new McpStatusWatcher({
        manager: asManager(mgr),
        serversProvider: () => [cfg("s1")],
      });
      const notices: Array<{ kind: string }> = [];
      watcher.onNotice((e) => notices.push({ kind: e.kind }));

      mgr.setStatus("s1", "connected"); // opens 5s window
      vi.advanceTimersByTime(2_000);
      mgr.setStatus("s1", "disconnected"); // updates pending kind
      vi.advanceTimersByTime(4_000);

      expect(notices).toEqual([{ kind: "disconnected" }]);
      watcher.disposeAll();
    } finally {
      vi.useRealTimers();
    }
  });

  test("snapshotPending reports enabled-but-runtime-less servers as no-runtime-yet (FR-002)", () => {
    const mgr = new FakeManager();
    // s1 has a runtime and is connecting; s2 is enabled but has no snapshot yet.
    mgr.setStatus("s1", "connecting");
    const watcher = new McpStatusWatcher({
      manager: asManager(mgr),
      serversProvider: () => [cfg("s1"), cfg("s2")],
    });
    const pending = watcher.snapshotPending();
    expect(pending).toContainEqual({ id: "s1", state: "connecting" });
    expect(pending).toContainEqual({ id: "s2", state: "no-runtime-yet" });
    watcher.disposeAll();
  });

  test("snapshotPending excludes disabled servers and terminal-connected servers", () => {
    const mgr = new FakeManager();
    mgr.setStatus("s1", "connected");
    mgr.setStatus("s2", "connecting");
    const watcher = new McpStatusWatcher({
      manager: asManager(mgr),
      serversProvider: () => [cfg("s1"), cfg("s2"), cfg("s3", false)],
    });
    const pending = watcher.snapshotPending();
    expect(pending.map((p) => p.id as unknown as string)).toEqual(["s2"]);
    watcher.disposeAll();
  });

  test("snapshotPending reports 'disconnected' and 'reconnecting' states", () => {
    const mgr = new FakeManager();
    mgr.setStatus("s1", "disconnected");
    mgr.setStatus("s2", "reconnecting");
    const watcher = new McpStatusWatcher({
      manager: asManager(mgr),
      serversProvider: () => [cfg("s1"), cfg("s2")],
    });
    const pending = watcher.snapshotPending();
    expect(pending).toContainEqual({ id: "s1", state: "disconnected" });
    expect(pending).toContainEqual({ id: "s2", state: "reconnecting" });
    watcher.disposeAll();
  });

  test("removing a server drops its pending notice window and lastConnected state", () => {
    vi.useFakeTimers();
    try {
      const mgr = new FakeManager();
      mgr.setStatus("s1", "connecting");
      const watcher = new McpStatusWatcher({
        manager: asManager(mgr),
        serversProvider: () => [cfg("s1")],
      });
      const notices: Array<{ serverId: string }> = [];
      watcher.onNotice((e) => notices.push({ serverId: String(e.serverId) }));

      mgr.setStatus("s1", "connected"); // opens 5s window
      vi.advanceTimersByTime(2_000);
      mgr.removeSnapshot("s1"); // server removed mid-window
      vi.advanceTimersByTime(10_000);

      // No notice fires for s1 because the window was cleared.
      expect(notices).toEqual([]);
      watcher.disposeAll();
    } finally {
      vi.useRealTimers();
    }
  });

  test("transitions on unrelated servers do not fire spurious events on other servers", () => {
    const mgr = new FakeManager();
    mgr.setStatus("s1", "connecting");
    mgr.setStatus("s2", "connecting");
    const watcher = new McpStatusWatcher({
      manager: asManager(mgr),
      serversProvider: () => [cfg("s1"), cfg("s2")],
    });
    const events: string[] = [];
    watcher.onTransition((e) => events.push(String(e.serverId)));

    mgr.setStatus("s1", "connected");
    expect(events).toEqual(["s1"]);
    watcher.disposeAll();
  });

  test("disposeAll clears timers, unsubscribes, and prevents further emissions", () => {
    vi.useFakeTimers();
    try {
      const mgr = new FakeManager();
      mgr.setStatus("s1", "connecting");
      const watcher = new McpStatusWatcher({
        manager: asManager(mgr),
        serversProvider: () => [cfg("s1")],
      });
      const transitions: string[] = [];
      const notices: string[] = [];
      watcher.onTransition(() => transitions.push("t"));
      watcher.onNotice(() => notices.push("n"));

      mgr.setStatus("s1", "connected");
      watcher.disposeAll();
      vi.advanceTimersByTime(10_000);

      // Only the pre-dispose transition; no notice ever fires.
      expect(transitions).toEqual(["t"]);
      expect(notices).toEqual([]);

      // Post-dispose manager emissions do nothing.
      mgr.setStatus("s1", "disconnected");
      expect(transitions).toEqual(["t"]);
      watcher.disposeAll(); // idempotent
    } finally {
      vi.useRealTimers();
    }
  });
});
