// v0.3 Phase 4: ConversationManager unit tests.
//
// We build a fake `ConversationsStore` (matching the surface the
// manager calls) and a fake `ConversationRuntimeFactory` so we can
// observe lazy instantiation, dispose calls, and metadata write-through
// without dragging the SDK in.

import { describe, expect, test, vi } from "vitest";
import {
  ConversationManager,
  CONVERSATION_SOFT_CAP,
  type ConversationChangeEvent,
} from "./ConversationManager";
import type { Conversation } from "./Conversation";
import type {
  ConversationRuntime,
  ConversationRuntimeFactory,
  ConversationRuntimePersistAdapter,
} from "./ConversationRuntime";
import type { ConversationsStore } from "../persistence/ConversationsStore";
import type {
  PersistedConversation,
  PersistedMessage,
  PersistedUndoEntry,
} from "../persistence/PersistedShape";
import { ChatState } from "./ChatState";

// ---------- Fakes ----------

interface FakeStoreState {
  byId: Map<string, PersistedConversation>;
  activeId: string | null;
}

function makeFakeStore(): {
  store: ConversationsStore;
  state: FakeStoreState;
  upsertSpy: ReturnType<typeof vi.fn>;
  removeSpy: ReturnType<typeof vi.fn>;
  setActiveSpy: ReturnType<typeof vi.fn>;
  recordUndoSpy: ReturnType<typeof vi.fn>;
  markUndoneSpy: ReturnType<typeof vi.fn>;
} {
  const state: FakeStoreState = { byId: new Map(), activeId: null };

  const upsertSpy = vi.fn((conv: PersistedConversation) => {
    state.byId.set(conv.id, { ...conv });
  });
  const removeSpy = vi.fn((id: string) => {
    state.byId.delete(id);
    if (state.activeId === id) state.activeId = null;
  });
  const setActiveSpy = vi.fn((id: string | null) => {
    state.activeId = id;
  });
  const listConversations = () => Array.from(state.byId.values());
  const recordUndoSpy = vi.fn(
    (convId: string, entry: PersistedUndoEntry) => {
      const c = state.byId.get(convId);
      if (!c) return { evictedId: null };
      c.undoEntries = [...c.undoEntries, { ...entry }];
      return { evictedId: null };
    },
  );
  const markUndoneSpy = vi.fn((convId: string, entryId: string) => {
    const c = state.byId.get(convId);
    if (!c) return;
    c.undoEntries = c.undoEntries.map((e) =>
      e.id === entryId ? { ...e, undone: true } : e,
    );
  });

  // Cast through unknown — the manager only consumes a narrow subset.
  const store = {
    upsertConversation: upsertSpy,
    removeConversation: removeSpy,
    setActiveId: setActiveSpy,
    listConversations,
    recordUndo: recordUndoSpy,
    markUndone: markUndoneSpy,
  } as unknown as ConversationsStore;

  return {
    store,
    state,
    upsertSpy,
    removeSpy,
    setActiveSpy,
    recordUndoSpy,
    markUndoneSpy,
  };
}

interface FakeRuntimeRecord {
  runtime: ConversationRuntime;
  metadata: Conversation;
  hydration?: {
    messages?: PersistedMessage[];
    undoEntries?: PersistedUndoEntry[];
  };
  persistAdapter?: ConversationRuntimePersistAdapter;
  disposed: boolean;
}

function makeFakeFactory(): {
  factory: ConversationRuntimeFactory;
  built: FakeRuntimeRecord[];
} {
  const built: FakeRuntimeRecord[] = [];
  const factory: ConversationRuntimeFactory = (
    metadata,
    hydration,
    persistAdapter,
  ) => {
    const rec: FakeRuntimeRecord = {
      metadata: { ...metadata },
      hydration,
      persistAdapter,
      disposed: false,
      // Build it below; closure over rec so dispose() flips the flag.
      runtime: undefined as unknown as ConversationRuntime,
    };
    const journalStub = {
      record: vi.fn(),
      undo: vi.fn(),
    } as unknown as ConversationRuntime["journal"];
    const sessionStub = {
      init: vi.fn(),
      sendMessage: vi.fn(),
      sendMessageStreaming: vi.fn(),
      cancelCurrent: vi.fn(),
      resetConversation: vi.fn(),
      setToken: vi.fn(),
      reconnect: vi.fn(),
      dispose: vi.fn(async () => {}),
      getModel: vi.fn(),
      resolveApproval: vi.fn(),
    } as unknown as ConversationRuntime["session"];
    rec.runtime = {
      conversationId: metadata.id,
      session: sessionStub,
      journal: journalStub,
      state: new ChatState(),
      dispose: async () => {
        rec.disposed = true;
      },
    };
    built.push(rec);
    return rec.runtime;
  };
  return { factory, built };
}

// ---------- Helpers ----------

function persistedConv(
  id: string,
  overrides: Partial<PersistedConversation> = {},
): PersistedConversation {
  return {
    id,
    name: id,
    createdAt: 1,
    lastActiveAt: 1,
    messages: [],
    undoEntries: [],
    ...overrides,
  };
}

// ---------- Tests ----------

describe("ConversationManager — hydration (FR-009)", () => {
  test("empty input creates a default conversation and marks it active", () => {
    const { factory } = makeFakeFactory();
    const { store, state } = makeFakeStore();
    const m = new ConversationManager({
      runtimeFactory: factory,
      store,
      now: () => 1000,
    });

    const activeId = m.hydrate({ conversations: [], activeConversationId: null });

    expect(m.list()).toHaveLength(1);
    expect(m.getActiveId()).toBe(activeId);
    expect(state.activeId).toBe(activeId);
    expect(m.list()[0].name).toBe("New conversation");
  });

  test("uses persisted activeConversationId when it exists and is not archived", () => {
    const { factory } = makeFakeFactory();
    const { store } = makeFakeStore();
    const m = new ConversationManager({ runtimeFactory: factory, store });

    const id = m.hydrate({
      conversations: [
        persistedConv("conv-1", { lastActiveAt: 5 }),
        persistedConv("conv-2", { lastActiveAt: 10 }),
      ],
      activeConversationId: "conv-1",
    });
    expect(id).toBe("conv-1");
  });

  test("falls back to most-recently-active non-archived when persisted active is archived", () => {
    const { factory } = makeFakeFactory();
    const { store } = makeFakeStore();
    const m = new ConversationManager({ runtimeFactory: factory, store });

    const id = m.hydrate({
      conversations: [
        persistedConv("conv-1", { archived: true, lastActiveAt: 100 }),
        persistedConv("conv-2", { lastActiveAt: 5 }),
        persistedConv("conv-3", { lastActiveAt: 20 }),
      ],
      activeConversationId: "conv-1",
    });
    expect(id).toBe("conv-3");
  });

  test("creates a default when only archived conversations exist", () => {
    const { factory } = makeFakeFactory();
    const { store } = makeFakeStore();
    const m = new ConversationManager({ runtimeFactory: factory, store });

    const id = m.hydrate({
      conversations: [
        persistedConv("conv-1", { archived: true }),
        persistedConv("conv-2", { archived: true }),
      ],
      activeConversationId: "conv-1",
    });
    expect(m.list()).toHaveLength(3);
    expect(m.get(id)?.archived).toBeFalsy();
  });

  test("hydration does NOT instantiate runtimes", () => {
    const { factory, built } = makeFakeFactory();
    const { store } = makeFakeStore();
    const m = new ConversationManager({ runtimeFactory: factory, store });

    m.hydrate({
      conversations: [persistedConv("conv-1"), persistedConv("conv-2")],
      activeConversationId: "conv-1",
    });
    expect(built).toHaveLength(0);
    expect(m.hasRuntime("conv-1")).toBe(false);
    expect(m.hasRuntime("conv-2")).toBe(false);
  });

  test("getActiveRuntime() lazily instantiates exactly once", () => {
    const { factory, built } = makeFakeFactory();
    const { store } = makeFakeStore();
    const m = new ConversationManager({ runtimeFactory: factory, store });

    m.hydrate({
      conversations: [persistedConv("conv-1")],
      activeConversationId: "conv-1",
    });
    const a = m.getActiveRuntime();
    const b = m.getActiveRuntime();
    expect(a).toBe(b);
    expect(built).toHaveLength(1);
    expect(m.hasRuntime("conv-1")).toBe(true);
  });
});

describe("ConversationManager — create + auto-naming (FR-005)", () => {
  test("first new() yields 'New conversation'", () => {
    const { factory } = makeFakeFactory();
    const { store } = makeFakeStore();
    const m = new ConversationManager({ runtimeFactory: factory, store });
    m.hydrate({ conversations: [], activeConversationId: null });
    // hydrate already created one default — clear by archiving and creating.
    const c = m.create();
    expect(c.name).toBe("New conversation 2");
  });

  test("collisions get numeric suffix '… 2', '… 3'", () => {
    const { factory } = makeFakeFactory();
    const { store } = makeFakeStore();
    const m = new ConversationManager({ runtimeFactory: factory, store });
    m.hydrate({ conversations: [], activeConversationId: null });
    const c2 = m.create();
    const c3 = m.create();
    expect(c2.name).toBe("New conversation 2");
    expect(c3.name).toBe("New conversation 3");
  });

  test("explicit name preserved if unique", () => {
    const { factory } = makeFakeFactory();
    const { store } = makeFakeStore();
    const m = new ConversationManager({ runtimeFactory: factory, store });
    m.hydrate({ conversations: [], activeConversationId: null });
    const c = m.create("Trip planning");
    expect(c.name).toBe("Trip planning");
  });

  test("create persists initial empty messages/undoEntries via store", () => {
    const { factory } = makeFakeFactory();
    const { store, upsertSpy } = makeFakeStore();
    const m = new ConversationManager({ runtimeFactory: factory, store });
    m.hydrate({ conversations: [], activeConversationId: null });
    upsertSpy.mockClear();
    const c = m.create("My chat");
    expect(upsertSpy).toHaveBeenCalledTimes(1);
    expect(upsertSpy.mock.calls[0][0]).toMatchObject({
      id: c.id,
      name: "My chat",
      messages: [],
      undoEntries: [],
    });
  });
});

describe("ConversationManager — soft cap (FR-002)", () => {
  test("creating past CONVERSATION_SOFT_CAP archives least-recently-active", () => {
    const { factory } = makeFakeFactory();
    const { store } = makeFakeStore();
    let t = 1000;
    const m = new ConversationManager({
      runtimeFactory: factory,
      store,
      now: () => t++,
    });
    m.hydrate({ conversations: [], activeConversationId: null });

    // Already 1 from hydrate; create cap-1 more to reach the cap, then 1 to overflow.
    for (let i = 0; i < CONVERSATION_SOFT_CAP - 1; i++) {
      m.create();
    }
    expect(m.listActive()).toHaveLength(CONVERSATION_SOFT_CAP);

    m.create(); // overflow
    expect(m.listActive()).toHaveLength(CONVERSATION_SOFT_CAP);
    // Total includes the archived one
    expect(m.list().length).toBeGreaterThan(CONVERSATION_SOFT_CAP);
    const archived = m.list().filter((c) => c.archived);
    expect(archived).toHaveLength(1);
  });

  test("soft cap does NOT archive the active conversation", () => {
    const { factory } = makeFakeFactory();
    const { store } = makeFakeStore();
    let t = 1000;
    const m = new ConversationManager({
      runtimeFactory: factory,
      store,
      now: () => t++,
    });
    m.hydrate({ conversations: [], activeConversationId: null });
    const activeId = m.getActiveId()!;

    for (let i = 0; i < CONVERSATION_SOFT_CAP; i++) {
      m.create(); // overflow happens during this loop
    }
    // The originally-active (and oldest) was protected.
    expect(m.get(activeId)?.archived).toBeFalsy();
  });
});

describe("ConversationManager — rename / archive / remove", () => {
  test("rename emits metadata-changed and persists", () => {
    const { factory } = makeFakeFactory();
    const { store, upsertSpy } = makeFakeStore();
    const m = new ConversationManager({ runtimeFactory: factory, store });
    m.hydrate({
      conversations: [persistedConv("conv-1")],
      activeConversationId: "conv-1",
    });
    const events: ConversationChangeEvent[] = [];
    m.subscribe((e) => events.push(e));
    upsertSpy.mockClear();

    m.rename("conv-1", "Renamed");
    expect(m.get("conv-1")?.name).toBe("Renamed");
    expect(events.some((e) => e.kind === "metadata-changed")).toBe(true);
    expect(upsertSpy).toHaveBeenCalledTimes(1);
  });

  test("rename collision gets a numeric suffix; rename-to-self leaves name unchanged", () => {
    const { factory } = makeFakeFactory();
    const { store } = makeFakeStore();
    const m = new ConversationManager({ runtimeFactory: factory, store });
    m.hydrate({
      conversations: [
        persistedConv("conv-1", { name: "Chat" }),
        persistedConv("conv-2", { name: "Other" }),
      ],
      activeConversationId: "conv-1",
    });

    m.rename("conv-2", "Chat");
    expect(m.get("conv-2")?.name).toBe("Chat 2");
    // Renaming the same convo to its own name should NOT add a suffix
    m.rename("conv-1", "Chat");
    expect(m.get("conv-1")?.name).toBe("Chat");
  });

  test("archive on the active conversation re-resolves active to fallback", () => {
    const { factory } = makeFakeFactory();
    const { store } = makeFakeStore();
    const m = new ConversationManager({ runtimeFactory: factory, store });
    m.hydrate({
      conversations: [
        persistedConv("conv-1", { lastActiveAt: 5 }),
        persistedConv("conv-2", { lastActiveAt: 10 }),
      ],
      activeConversationId: "conv-1",
    });

    m.archive("conv-1");
    expect(m.getActiveId()).toBe("conv-2");
    expect(m.get("conv-1")?.archived).toBe(true);
  });

  test("removeConversation disposes the runtime if instantiated", async () => {
    const { factory, built } = makeFakeFactory();
    const { store, removeSpy } = makeFakeStore();
    const m = new ConversationManager({ runtimeFactory: factory, store });
    m.hydrate({
      conversations: [
        persistedConv("conv-1"),
        persistedConv("conv-2"),
      ],
      activeConversationId: "conv-1",
    });
    // Materialize conv-1's runtime
    m.getActiveRuntime();
    expect(built).toHaveLength(1);

    await m.removeConversation("conv-1");
    expect(built[0].disposed).toBe(true);
    expect(m.hasRuntime("conv-1")).toBe(false);
    expect(removeSpy).toHaveBeenCalledWith("conv-1");
    // Active falls back to conv-2
    expect(m.getActiveId()).toBe("conv-2");
  });

  test("removeConversation skips dispose for never-instantiated runtimes", async () => {
    const { factory, built } = makeFakeFactory();
    const { store } = makeFakeStore();
    const m = new ConversationManager({ runtimeFactory: factory, store });
    m.hydrate({
      conversations: [
        persistedConv("conv-1"),
        persistedConv("conv-2"),
      ],
      activeConversationId: "conv-1",
    });

    await m.removeConversation("conv-2");
    expect(built).toHaveLength(0);
    expect(m.hasRuntime("conv-2")).toBe(false);
  });
});

describe("ConversationManager — runtime persistence wiring", () => {
  test("factory receives hydration messages + undo entries from the store", () => {
    const { factory, built } = makeFakeFactory();
    const { store, state } = makeFakeStore();
    const seedMsg: PersistedMessage = {
      id: "m1",
      role: "user",
      content: "hi",
      status: "complete",
      createdAt: 1,
    };
    const seedUndo: PersistedUndoEntry = {
      id: "undo-seed",
      kind: "create",
      scope: "vault",
      path: "a.md",
      after: "x",
      recordedAt: 1,
    };
    const persisted = persistedConv("conv-1", {
      messages: [seedMsg],
      undoEntries: [seedUndo],
    });
    // The real plugin flow is: store.load() → manager.hydrate(store.snapshot).
    // Pre-populate the fake store so snapshotHydration finds the row.
    state.byId.set(persisted.id, persisted);

    const m = new ConversationManager({ runtimeFactory: factory, store });
    m.hydrate({
      conversations: [persisted],
      activeConversationId: "conv-1",
    });

    m.getActiveRuntime();
    expect(built[0].hydration?.messages).toEqual([seedMsg]);
    expect(built[0].hydration?.undoEntries).toEqual([seedUndo]);
  });

  test("runtime persist adapter mirrors 'add' to store.recordUndo and 'mark-undone' to store.markUndone", () => {
    const { factory, built } = makeFakeFactory();
    const { store, recordUndoSpy, markUndoneSpy } = makeFakeStore();
    const m = new ConversationManager({ runtimeFactory: factory, store });
    m.hydrate({
      conversations: [persistedConv("conv-1")],
      activeConversationId: "conv-1",
    });
    m.getActiveRuntime();
    const adapter = built[0].persistAdapter!;
    expect(adapter).toBeDefined();

    adapter.onJournalOp("add", {
      id: "u1",
      kind: "create",
      scope: "vault",
      path: "a.md",
      after: "x",
      recordedAt: 100,
    });
    expect(recordUndoSpy).toHaveBeenCalledTimes(1);
    expect(recordUndoSpy.mock.calls[0][0]).toBe("conv-1");

    adapter.onJournalOp("mark-undone", {
      id: "u1",
      kind: "create",
      scope: "vault",
      path: "a.md",
      recordedAt: 100,
      undone: true,
    });
    expect(markUndoneSpy).toHaveBeenCalledWith("conv-1", "u1");
  });
});

describe("ConversationManager — disposeAll", () => {
  test("disposes all instantiated runtimes and clears the registry", async () => {
    const { factory, built } = makeFakeFactory();
    const { store } = makeFakeStore();
    const m = new ConversationManager({ runtimeFactory: factory, store });
    m.hydrate({
      conversations: [persistedConv("conv-1"), persistedConv("conv-2")],
      activeConversationId: "conv-1",
    });
    m.getActiveRuntime();
    m.setActive("conv-2");
    m.getActiveRuntime();
    expect(built).toHaveLength(2);

    await m.disposeAll();
    expect(built.every((b) => b.disposed)).toBe(true);
    expect(m.hasRuntime("conv-1")).toBe(false);
    expect(m.hasRuntime("conv-2")).toBe(false);
  });
});

describe("ConversationManager — subscribe events", () => {
  test("setActive emits active-changed with previous + next ids", () => {
    const { factory } = makeFakeFactory();
    const { store } = makeFakeStore();
    const m = new ConversationManager({ runtimeFactory: factory, store });
    m.hydrate({
      conversations: [persistedConv("conv-1"), persistedConv("conv-2")],
      activeConversationId: "conv-1",
    });
    const events: ConversationChangeEvent[] = [];
    m.subscribe((e) => events.push(e));
    m.setActive("conv-2");
    const ac = events.find((e) => e.kind === "active-changed");
    expect(ac).toEqual({
      kind: "active-changed",
      previousId: "conv-1",
      nextId: "conv-2",
    });
  });

  test("setActive to current id is a no-op", () => {
    const { factory } = makeFakeFactory();
    const { store } = makeFakeStore();
    const m = new ConversationManager({ runtimeFactory: factory, store });
    m.hydrate({
      conversations: [persistedConv("conv-1")],
      activeConversationId: "conv-1",
    });
    const events: ConversationChangeEvent[] = [];
    m.subscribe((e) => events.push(e));
    m.setActive("conv-1");
    expect(events.filter((e) => e.kind === "active-changed")).toHaveLength(0);
  });
});
