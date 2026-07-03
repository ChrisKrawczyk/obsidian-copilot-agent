import { describe, expect, test, vi } from "vitest";
import {
  handleMcpNoticeForToolToast,
  handleMcpTransitionForToolRefresh,
} from "./main";
import type { McpServerId } from "./mcp/McpTypes";

const serverA = "server-a" as McpServerId;
const serverB = "server-b" as McpServerId;

function fakeSession(overrides: {
  applyToolListChange?: () => Promise<void>;
  hasLiveToolUpdate?: () => boolean;
} = {}) {
  return {
    applyToolListChange: overrides.applyToolListChange ?? (async () => {}),
    hasLiveToolUpdate: overrides.hasLiveToolUpdate ?? (() => false),
  };
}

describe("main.ts — handleMcpTransitionForToolRefresh (Phase 3 wiring)", () => {
  test("fans out applyToolListChange to every live runtime", () => {
    const calls: string[] = [];
    const s1 = fakeSession({
      applyToolListChange: async () => {
        calls.push("s1");
      },
    });
    const s2 = fakeSession({
      applyToolListChange: async () => {
        calls.push("s2");
      },
    });
    handleMcpTransitionForToolRefresh(
      [{ session: s1 }, { session: s2 }],
      { serverId: serverA },
    );
    // Fire-and-forget: promises fanned out synchronously.
    return Promise.resolve().then(() => {
      expect(calls.sort()).toEqual(["s1", "s2"]);
    });
  });

  test("no-ops silently when there are no live runtimes", () => {
    expect(() =>
      handleMcpTransitionForToolRefresh([], { serverId: serverA }),
    ).not.toThrow();
  });

  test("swallows applyToolListChange rejections without crashing", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const s1 = fakeSession({
        applyToolListChange: async () => {
          throw new Error("boom");
        },
      });
      handleMcpTransitionForToolRefresh([{ session: s1 }], {
        serverId: serverA,
      });
      // Let the microtask queue drain so the catch handler fires.
      await new Promise((r) => setTimeout(r, 0));
      expect(warnSpy).toHaveBeenCalled();
      const args = warnSpy.mock.calls[0];
      expect(String(args[0])).toContain("applyToolListChange failed");
      expect(args[1]).toBe(serverA);
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe("main.ts — handleMcpNoticeForToolToast (Phase 3 wiring)", () => {
  test("emits Notice with resolved server name when at least one runtime can update", () => {
    const notify = vi.fn();
    const canUpdate = fakeSession({ hasLiveToolUpdate: () => true });
    handleMcpNoticeForToolToast(
      [{ session: canUpdate }],
      [{ id: serverA, name: "WorkIQ" }],
      notify,
      { serverId: serverA, kind: "connected" },
    );
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(
      "Tools from WorkIQ are now available.",
      4000,
    );
  });

  test("silent on disconnect events (background, not user-actionable)", () => {
    const notify = vi.fn();
    handleMcpNoticeForToolToast(
      [{ session: fakeSession({ hasLiveToolUpdate: () => true }) }],
      [{ id: serverA, name: "WorkIQ" }],
      notify,
      { serverId: serverA, kind: "disconnected" },
    );
    expect(notify).not.toHaveBeenCalled();
  });

  test("gated: no toast when NO live runtime has updateTools primitive (SDK 1.0.0 / FR-011)", () => {
    const notify = vi.fn();
    handleMcpNoticeForToolToast(
      [
        { session: fakeSession({ hasLiveToolUpdate: () => false }) },
        { session: fakeSession({ hasLiveToolUpdate: () => false }) },
      ],
      [{ id: serverA, name: "WorkIQ" }],
      notify,
      { serverId: serverA, kind: "connected" },
    );
    expect(notify).not.toHaveBeenCalled();
  });

  test("gated: no toast when there are zero live runtimes (all conversations metadata-only)", () => {
    // Planning-docs C2: metadata-only conversations pick up tools on
    // next createSession. Toast would be misleading here.
    const notify = vi.fn();
    handleMcpNoticeForToolToast(
      [],
      [{ id: serverA, name: "WorkIQ" }],
      notify,
      { serverId: serverA, kind: "connected" },
    );
    expect(notify).not.toHaveBeenCalled();
  });

  test("emits toast if ANY live runtime has the primitive (mixed fleet)", () => {
    const notify = vi.fn();
    handleMcpNoticeForToolToast(
      [
        { session: fakeSession({ hasLiveToolUpdate: () => false }) },
        { session: fakeSession({ hasLiveToolUpdate: () => true }) },
      ],
      [{ id: serverA, name: "WorkIQ" }],
      notify,
      { serverId: serverA, kind: "connected" },
    );
    expect(notify).toHaveBeenCalledTimes(1);
  });

  test("falls back to serverId when server not found in settings snapshot", () => {
    const notify = vi.fn();
    handleMcpNoticeForToolToast(
      [{ session: fakeSession({ hasLiveToolUpdate: () => true }) }],
      [{ id: serverB, name: "Other" }],
      notify,
      { serverId: serverA, kind: "connected" },
    );
    expect(notify).toHaveBeenCalledWith(
      `Tools from ${serverA} are now available.`,
      4000,
    );
  });
});
