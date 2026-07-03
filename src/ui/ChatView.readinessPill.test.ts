/**
 * Phase 2 (MCP Readiness UX) — ChatView readiness pill state machine.
 *
 * Scope: verify the pill state machine (bus subscription, filter by
 * conversationId, sync-seed on bind, exit on resolved) at the JS
 * behavior level. The DOM show/hide path exercised here only when
 * `onOpen` has run to build the pill element; these tests stay at
 * the state-only layer (no DOM), matching the pattern in
 * `ChatView.modelPick.test.ts`.
 */

import { beforeEach, describe, expect, test, vi } from "vitest";
import { ChatState } from "../domain/ChatState";
import type { ConversationRuntime } from "../domain/ConversationRuntime";
import type { ConversationManager } from "../domain/ConversationManager";
import type { ModelCatalog } from "../sdk/ModelCatalog";
import { ReadinessGateBus } from "./ReadinessGateBus";

vi.mock(
  "obsidian",
  () => ({
    ItemView: class {
      app: unknown;
      containerEl = { children: [{}, {}] };
      constructor(leaf: { app?: unknown }) {
        this.app = leaf.app ?? {};
      }
    },
    Notice: vi.fn(function Notice() {}),
    setIcon: vi.fn(),
    Menu: class {
      addItem(): void {}
      showAtPosition(): void {}
    },
  }),
  { virtual: true },
);

vi.mock("./ConversationPicker", () => ({
  ConversationPicker: class {},
  confirmDestructive: vi.fn(),
  promptForText: vi.fn(),
}));

import { ChatView } from "./ChatView";

interface FakeSession {
  isReadinessGateWaiting?: () => boolean;
  hasPendingApprovals: () => boolean;
}

function makeRuntime(
  id: string,
  session: FakeSession,
): ConversationRuntime {
  return {
    conversationId: id,
    state: new ChatState(),
    setModelId: vi.fn(async () => {}),
    session: session as unknown as ConversationRuntime["session"],
    journal: {} as ConversationRuntime["journal"],
    dispose: vi.fn(async () => {}),
  };
}

function makeView(args: {
  activeId: string;
  runtimes: Map<string, ConversationRuntime>;
  bus?: ReadinessGateBus;
  snapshotPendingMcp?: () => Array<{ id: string; state: string }>;
  mcpServerName?: (id: string) => string | undefined;
}): ChatView {
  const manager = {
    getActiveId: () => args.activeId,
    get: (id: string) => ({
      id,
      name: id,
      createdAt: 1,
      lastActiveAt: 1,
      modelId: null,
    }),
    getActiveRuntime: () => args.runtimes.get(args.activeId)!,
  } as unknown as ConversationManager;
  const auth = { subscribe: vi.fn(() => () => {}) };
  const modelCatalog = {
    getState: () => ({ kind: "ready", models: [], chatModels: [] }),
    subscribe: vi.fn(() => () => {}),
  } as unknown as ModelCatalog;
  return new ChatView({ app: {} } as never, {
    manager,
    auth: auth as never,
    openSettings: vi.fn(),
    getExposeRawFsTools: () => false,
    modelCatalog,
    readinessGateBus: args.bus,
    snapshotPendingMcp:
      args.snapshotPendingMcp ??
      (() => [] as Array<{ id: string; state: "connecting" | "reconnecting" | "disconnected" | "no-runtime-yet" }>),
    mcpServerName: args.mcpServerName ?? (() => undefined),
  });
}

describe("ChatView readiness pill state machine", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("seeds pending state on bind when session.isReadinessGateWaiting returns true (planning-docs S2)", () => {
    // Regression: a ChatView that opens AFTER the transient `start`
    // bus event was published (e.g., late plugin load or workspace
    // restore) must still show pending. The sync getter closes that
    // gap by letting bindActiveRuntime seed state without depending
    // on the bus at all.
    const runtimes = new Map<string, ConversationRuntime>();
    runtimes.set(
      "c1",
      makeRuntime("c1", {
        isReadinessGateWaiting: () => true,
        hasPendingApprovals: () => false,
      }),
    );
    const view = makeView({ activeId: "c1", runtimes });
    expect((view as unknown as { readinessGateState: string }).readinessGateState).toBe("pending");
  });

  test("seeds idle state on bind when session reports no waiting gate", () => {
    const runtimes = new Map<string, ConversationRuntime>();
    runtimes.set(
      "c1",
      makeRuntime("c1", {
        isReadinessGateWaiting: () => false,
        hasPendingApprovals: () => false,
      }),
    );
    const view = makeView({ activeId: "c1", runtimes });
    expect((view as unknown as { readinessGateState: string }).readinessGateState).toBe("idle");
  });

  test("tolerates older AgentSession without isReadinessGateWaiting (fall through, no throw)", () => {
    // Defensive: the getter is optional in the interface (older
    // clients / test doubles may omit it). bindActiveRuntime must
    // treat that as "not waiting" and not crash construction.
    const runtimes = new Map<string, ConversationRuntime>();
    runtimes.set(
      "c1",
      makeRuntime("c1", {
        hasPendingApprovals: () => false,
      }),
    );
    expect(() => makeView({ activeId: "c1", runtimes })).not.toThrow();
  });

  test("bus start event for bound conversation flips state to pending", () => {
    // We only assert state; DOM show is exercised via onOpen which
    // requires a full DOM stub. The pill is idempotent — calling
    // enter->render is safe post-onOpen too.
    const runtimes = new Map<string, ConversationRuntime>();
    runtimes.set(
      "c1",
      makeRuntime("c1", {
        isReadinessGateWaiting: () => false,
        hasPendingApprovals: () => false,
      }),
    );
    const bus = new ReadinessGateBus();
    const view = makeView({ activeId: "c1", runtimes, bus });
    // Simulate the wiring onOpen would set up. We do this manually
    // because onOpen requires the full Obsidian containerEl mock.
    (view as unknown as { unsubReadinessGate: () => void }).unsubReadinessGate = bus.subscribe(
      (evt) => {
        const state = view as unknown as {
          boundConversationId: string | null;
          enterReadinessPending: () => void;
          exitReadinessPending: () => void;
        };
        if (evt.conversationId !== state.boundConversationId) return;
        if (evt.kind === "start") state.enterReadinessPending();
        else state.exitReadinessPending();
      },
    );
    bus.publish({ conversationId: "c1", kind: "start" });
    expect((view as unknown as { readinessGateState: string }).readinessGateState).toBe("pending");
    bus.publish({ conversationId: "c1", kind: "resolved" });
    expect((view as unknown as { readinessGateState: string }).readinessGateState).toBe("idle");
  });

  test("bus events for a different conversationId are ignored", () => {
    // Multi-view invariant: two open ChatViews (one bound to c1, one
    // to c2) must not cross-signal. The bus payload carries
    // conversationId and the subscription filters on
    // boundConversationId.
    const runtimes = new Map<string, ConversationRuntime>();
    runtimes.set(
      "c1",
      makeRuntime("c1", {
        isReadinessGateWaiting: () => false,
        hasPendingApprovals: () => false,
      }),
    );
    const bus = new ReadinessGateBus();
    const view = makeView({ activeId: "c1", runtimes, bus });
    (view as unknown as { unsubReadinessGate: () => void }).unsubReadinessGate = bus.subscribe(
      (evt) => {
        const state = view as unknown as {
          boundConversationId: string | null;
          enterReadinessPending: () => void;
          exitReadinessPending: () => void;
        };
        if (evt.conversationId !== state.boundConversationId) return;
        if (evt.kind === "start") state.enterReadinessPending();
        else state.exitReadinessPending();
      },
    );
    bus.publish({ conversationId: "c2", kind: "start" });
    expect((view as unknown as { readinessGateState: string }).readinessGateState).toBe("idle");
  });

  test("fast-path guard defers pill visibility inside 100 ms render window (SC-008)", async () => {
    // Spec SC-008: on the fast path (all servers pre-connected, gate
    // resolves in under 100 ms), the pill must NEVER become visible
    // — no flash. The guard `setTimeout` measures remaining budget
    // from `renderTimestamp` and only shows the pill when the timer
    // fires. If `exitReadinessPending` fires first, the pill stays
    // hidden.
    vi.useFakeTimers();
    try {
      const runtimes = new Map<string, ConversationRuntime>();
      runtimes.set(
        "c1",
        makeRuntime("c1", {
          isReadinessGateWaiting: () => false,
          hasPendingApprovals: () => false,
        }),
      );
      const view = makeView({ activeId: "c1", runtimes });
      // Simulate onOpen having built the pill DOM. Use a shape that
      // mirrors HTMLElement enough for the pill state machine
      // (`style.display`, `setText`).
      const pillEl = { style: { display: "none" } } as unknown as HTMLElement;
      const labelEl = { setText: vi.fn() } as unknown as HTMLElement;
      const internal = view as unknown as {
        readinessPillEl: HTMLElement;
        readinessPillLabelEl: HTMLElement;
        renderTimestamp: number;
        enterReadinessPending: () => void;
        exitReadinessPending: () => void;
      };
      internal.readinessPillEl = pillEl;
      internal.readinessPillLabelEl = labelEl;
      // Anchor renderTimestamp to "just now" so we're deep inside
      // the 100 ms budget.
      internal.renderTimestamp = performance.now();
      internal.enterReadinessPending();
      // Timer armed but not fired yet — pill must still be hidden.
      expect(pillEl.style.display).toBe("none");
      // Gate resolves within the fast-path window.
      vi.advanceTimersByTime(50);
      internal.exitReadinessPending();
      // Advance past the guard's would-be fire time — pill must
      // still be hidden because exit cancelled the timer.
      vi.advanceTimersByTime(200);
      expect(pillEl.style.display).toBe("none");
    } finally {
      vi.useRealTimers();
    }
  });

  test("guard past window shows pill immediately on enter (slow path)", () => {
    // Slow path: renderTimestamp is older than FAST_PATH_MS so the
    // guard has no remaining budget. enterReadinessPending must
    // show the pill synchronously — no setTimeout hop.
    vi.useFakeTimers();
    try {
      const runtimes = new Map<string, ConversationRuntime>();
      runtimes.set(
        "c1",
        makeRuntime("c1", {
          isReadinessGateWaiting: () => false,
          hasPendingApprovals: () => false,
        }),
      );
      const view = makeView({ activeId: "c1", runtimes });
      const pillEl = { style: { display: "none" } } as unknown as HTMLElement;
      const labelEl = { setText: vi.fn() } as unknown as HTMLElement;
      const internal = view as unknown as {
        readinessPillEl: HTMLElement;
        readinessPillLabelEl: HTMLElement;
        renderTimestamp: number;
        enterReadinessPending: () => void;
      };
      internal.readinessPillEl = pillEl;
      internal.readinessPillLabelEl = labelEl;
      // Simulate onOpen fired 500 ms ago — well past the 100 ms
      // guard window.
      internal.renderTimestamp = performance.now() - 500;
      internal.enterReadinessPending();
      expect(pillEl.style.display).toBe("");
    } finally {
      vi.useRealTimers();
    }
  });

  test("label names pending servers using injected resolver", () => {
    // FR-002 / spec P1 AC1: pill copy names the pending servers.
    // Verifies snapshotPendingMcp() + mcpServerName() are chained.
    const runtimes = new Map<string, ConversationRuntime>();
    runtimes.set(
      "c1",
      makeRuntime("c1", {
        isReadinessGateWaiting: () => false,
        hasPendingApprovals: () => false,
      }),
    );
    const view = makeView({
      activeId: "c1",
      runtimes,
      snapshotPendingMcp: () => [
        { id: "svc-a", state: "connecting" },
        { id: "svc-b", state: "reconnecting" },
      ],
      mcpServerName: (id) =>
        id === "svc-a" ? "Alpha" : id === "svc-b" ? "Beta" : undefined,
    });
    const setText = vi.fn();
    const pillEl = { style: { display: "none" } } as unknown as HTMLElement;
    const labelEl = { setText } as unknown as HTMLElement;
    const internal = view as unknown as {
      readinessPillEl: HTMLElement;
      readinessPillLabelEl: HTMLElement;
      renderTimestamp: number;
      updateReadinessPillLabel: () => void;
    };
    internal.readinessPillEl = pillEl;
    internal.readinessPillLabelEl = labelEl;
    internal.renderTimestamp = performance.now() - 500;
    internal.updateReadinessPillLabel();
    expect(setText).toHaveBeenLastCalledWith("Preparing MCP tools: Alpha, Beta…");
  });

  test("label falls back to server id if resolver returns undefined", () => {
    // Race: a server can be removed from settings between snapshot
    // and label render. The resolver returns undefined; the label
    // must fall back to the raw id rather than emit "undefined".
    const runtimes = new Map<string, ConversationRuntime>();
    runtimes.set(
      "c1",
      makeRuntime("c1", {
        isReadinessGateWaiting: () => false,
        hasPendingApprovals: () => false,
      }),
    );
    const view = makeView({
      activeId: "c1",
      runtimes,
      snapshotPendingMcp: () => [{ id: "svc-x", state: "connecting" }],
      mcpServerName: () => undefined,
    });
    const setText = vi.fn();
    const internal = view as unknown as {
      readinessPillLabelEl: HTMLElement;
      updateReadinessPillLabel: () => void;
    };
    internal.readinessPillLabelEl = { setText } as unknown as HTMLElement;
    internal.updateReadinessPillLabel();
    expect(setText).toHaveBeenLastCalledWith("Preparing MCP tools: svc-x…");
  });

  test("buildReadinessPill sets tooltip and role attributes (Spec P1 AC2)", () => {
    // Spec P1 AC2 / planning-docs S5: the pill must have hover text
    // explaining why it is visible, and an aria/role attribute so
    // screen readers announce it as a status. We invoke the DOM
    // builder directly with a minimal container stub rather than
    // driving full onOpen — the pill construction is decoupled from
    // the rest of the composer wiring on purpose so this assertion
    // stays cheap.
    const runtimes = new Map<string, ConversationRuntime>();
    runtimes.set(
      "c1",
      makeRuntime("c1", {
        isReadinessGateWaiting: () => false,
        hasPendingApprovals: () => false,
      }),
    );
    const view = makeView({ activeId: "c1", runtimes });
    // Minimal container stub matching just what buildReadinessPill
    // calls on it: createDiv, createSpan, setAttribute, style.display.
    const setAttrCalls: Array<[string, string]> = [];
    const spanCreated: Array<{ cls: string; text: string }> = [];
    const pillMock = {
      style: { display: "" },
      setAttribute: (name: string, value: string) => {
        setAttrCalls.push([name, value]);
      },
      createSpan: (opts: { cls: string; text: string }) => {
        spanCreated.push(opts);
        return { setText: vi.fn() } as unknown as HTMLElement;
      },
    };
    const composerMock = {
      createDiv: (_opts: { cls: string }) => pillMock as unknown as HTMLElement,
    };
    (view as unknown as {
      buildReadinessPill: (c: HTMLElement) => void;
    }).buildReadinessPill(composerMock as unknown as HTMLElement);
    // Tooltip: exact match against the static constant so drift is
    // caught on either side.
    expect(setAttrCalls).toContainEqual([
      "title",
      ChatView.READINESS_PILL_TOOLTIP,
    ]);
    // Role for accessibility (announced as status, not alert — the
    // pill is passive).
    expect(setAttrCalls).toContainEqual(["role", "status"]);
    // Label element created with the placeholder text.
    expect(spanCreated).toEqual([
      {
        cls: "copilot-agent-mcp-readiness-pill-label",
        text: "Preparing MCP tools…",
      },
    ]);
    // Pill starts hidden.
    expect(pillMock.style.display).toBe("none");
  });
});
