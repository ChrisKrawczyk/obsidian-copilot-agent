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
  deriveConversationNameFromMessage,
  formatUntitledName,
  isDefaultConversationName,
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
  removeUndoEntrySpy: ReturnType<typeof vi.fn>;
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
    // Match real ConversationsStore.setActiveId contract — throws if
    // the id is absent. Catches the FR-009 fresh-install bug class.
    if (id !== null && !state.byId.has(id)) {
      throw new Error(`setActiveId: no conversation with id "${id}" in store`);
    }
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
  const removeUndoEntrySpy = vi.fn((convId: string, entryId: string) => {
    const c = state.byId.get(convId);
    if (!c) return;
    c.undoEntries = c.undoEntries.filter((e) => e.id !== entryId);
  });
  const appendMessageSpy = vi.fn(
    (convId: string, msg: PersistedMessage) => {
      const c = state.byId.get(convId);
      if (!c) return;
      c.messages = [...c.messages, { ...msg }];
    },
  );
  const replaceMessageSpy = vi.fn(
    (convId: string, msgId: string, partial: Partial<PersistedMessage>) => {
      const c = state.byId.get(convId);
      if (!c) return;
      c.messages = c.messages.map((m) =>
        m.id === msgId ? { ...m, ...partial, id: m.id } : m,
      );
    },
  );

  // Cast through unknown — the manager only consumes a narrow subset.
  const store = {
    upsertConversation: upsertSpy,
    removeConversation: removeSpy,
    setActiveId: setActiveSpy,
    listConversations,
    recordUndo: recordUndoSpy,
    markUndone: markUndoneSpy,
    removeUndoEntry: removeUndoEntrySpy,
    appendMessage: appendMessageSpy,
    replaceMessage: replaceMessageSpy,
  } as unknown as ConversationsStore;

  return {
    store,
    state,
    upsertSpy,
    removeSpy,
    setActiveSpy,
    recordUndoSpy,
    markUndoneSpy,
    removeUndoEntrySpy,
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
      setModelId: async () => {},
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
    // FR-005: timestamped default. Exact string is TZ-dependent so
    // we assert the format rather than a fixed value.
    expect(isDefaultConversationName(m.list()[0].name)).toBe(true);
    expect(m.list()[0].name.startsWith("Untitled ")).toBe(true);
    // Regression: the freshly-minted default must exist in the store
    // BEFORE setActiveId runs (real ConversationsStore.setActiveId
    // throws if the id is absent).
    expect(state.byId.has(activeId)).toBe(true);
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
  test("first new() yields a timestamped 'Untitled YYYY-MM-DD HH:MM' name", () => {
    const { factory } = makeFakeFactory();
    const { store } = makeFakeStore();
    // Fixed `now` so the suffix-dedup path is exercised (hydrate +
    // create share the same timestamp → second one needs " 2").
    const fixed = Date.UTC(2026, 5, 11, 17, 0, 0); // 2026-06-11 17:00 UTC
    const m = new ConversationManager({
      runtimeFactory: factory,
      store,
      now: () => fixed,
    });
    m.hydrate({ conversations: [], activeConversationId: null });
    const c = m.create();
    expect(isDefaultConversationName(c.name)).toBe(true);
    // Must be the second one (suffix " 2") because hydrate created
    // the first with the same timestamp.
    expect(c.name.endsWith(" 2")).toBe(true);
  });

  test("collisions get numeric suffix '… 2', '… 3' on the timestamped seed", () => {
    const { factory } = makeFakeFactory();
    const { store } = makeFakeStore();
    const fixed = Date.UTC(2026, 5, 11, 17, 0, 0);
    const m = new ConversationManager({
      runtimeFactory: factory,
      store,
      now: () => fixed,
    });
    m.hydrate({ conversations: [], activeConversationId: null });
    const c2 = m.create();
    const c3 = m.create();
    // hydrate took the bare timestamped seed; c2 → " 2"; c3 → " 3".
    expect(c2.name.endsWith(" 2")).toBe(true);
    expect(c3.name.endsWith(" 3")).toBe(true);
    expect(isDefaultConversationName(c2.name)).toBe(true);
    expect(isDefaultConversationName(c3.name)).toBe(true);
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

  test("auto-archive emits an `auto-archived` event naming the archived conversation (CONS-4)", () => {
    const { factory } = makeFakeFactory();
    const { store } = makeFakeStore();
    let t = 1000;
    const m = new ConversationManager({
      runtimeFactory: factory,
      store,
      now: () => t++,
    });
    m.hydrate({ conversations: [], activeConversationId: null });
    // Rename the seed so the archived victim has a deterministic name
    // we can assert against.
    const seedId = m.getActiveId()!;
    m.rename(seedId, "Oldest");
    // Switch active off the seed BEFORE filling — otherwise enforceSoftCap
    // protects the active and archives a different conversation.
    for (let i = 0; i < CONVERSATION_SOFT_CAP - 1; i++) m.create();
    const events: ConversationChangeEvent[] = [];
    m.subscribe((e) => events.push(e));
    // Switch active to a non-seed conv so the seed becomes the archive
    // victim on the next overflow-create.
    const nonSeed = m.list().find((c) => c.id !== seedId)!;
    m.setActive(nonSeed.id);
    m.create(); // overflow
    const archivedEv = events.find((e) => e.kind === "auto-archived");
    expect(archivedEv).toBeDefined();
    expect(archivedEv).toEqual({
      kind: "auto-archived",
      id: seedId,
      name: "Oldest",
    });
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

// v0.4 (model-picker) Phase 1: per-conversation modelId binding lives
// in metadata only — no runtime swap, no UI yet. These tests pin the
// persistence contract and the structural guarantee that the undo
// journal does not capture modelId (it only tracks file actions).
describe("ConversationManager — setConversationModelId (v0.4 FR-006/FR-013)", () => {
  test("persists the bound modelId via metadata-only write", () => {
    const { factory } = makeFakeFactory();
    const { store, upsertSpy, state } = makeFakeStore();
    const m = new ConversationManager({ runtimeFactory: factory, store });
    m.hydrate({
      conversations: [persistedConv("conv-1")],
      activeConversationId: "conv-1",
    });
    upsertSpy.mockClear();

    m.setConversationModelId("conv-1", "gpt-4.1");

    expect(m.get("conv-1")?.modelId).toBe("gpt-4.1");
    expect(upsertSpy).toHaveBeenCalledTimes(1);
    expect(state.byId.get("conv-1")?.modelId).toBe("gpt-4.1");
  });

  test("emits metadata-changed on a real change", () => {
    const { factory } = makeFakeFactory();
    const { store } = makeFakeStore();
    const m = new ConversationManager({ runtimeFactory: factory, store });
    m.hydrate({
      conversations: [persistedConv("conv-1")],
      activeConversationId: "conv-1",
    });
    const events: ConversationChangeEvent[] = [];
    m.subscribe((e) => events.push(e));

    m.setConversationModelId("conv-1", "gpt-4.1");

    expect(
      events.some((e) => e.kind === "metadata-changed" && e.id === "conv-1"),
    ).toBe(true);
  });

  test("no-op when the modelId is unchanged (no write, no event)", () => {
    const { factory } = makeFakeFactory();
    const { store, upsertSpy } = makeFakeStore();
    const m = new ConversationManager({ runtimeFactory: factory, store });
    m.hydrate({
      conversations: [persistedConv("conv-1", { modelId: "gpt-4.1" })],
      activeConversationId: "conv-1",
    });
    upsertSpy.mockClear();
    const events: ConversationChangeEvent[] = [];
    m.subscribe((e) => events.push(e));

    m.setConversationModelId("conv-1", "gpt-4.1");

    expect(upsertSpy).not.toHaveBeenCalled();
    expect(events.some((e) => e.kind === "metadata-changed")).toBe(false);
  });

  test("clears the binding when called with null", () => {
    const { factory } = makeFakeFactory();
    const { store, state } = makeFakeStore();
    const m = new ConversationManager({ runtimeFactory: factory, store });
    m.hydrate({
      conversations: [persistedConv("conv-1", { modelId: "gpt-4.1" })],
      activeConversationId: "conv-1",
    });

    m.setConversationModelId("conv-1", null);

    expect(m.get("conv-1")?.modelId).toBeNull();
    expect(state.byId.get("conv-1")?.modelId).toBeNull();
  });

  test("throws on unknown conversation id", () => {
    const { factory } = makeFakeFactory();
    const { store } = makeFakeStore();
    const m = new ConversationManager({ runtimeFactory: factory, store });
    m.hydrate({ conversations: [], activeConversationId: null });

    expect(() => m.setConversationModelId("nope", "gpt-4.1")).toThrow();
  });

  test("hydrating a v1-migrated conversation (modelId: null) yields modelId=null on the manager", () => {
    const { factory } = makeFakeFactory();
    const { store } = makeFakeStore();
    const m = new ConversationManager({ runtimeFactory: factory, store });
    m.hydrate({
      conversations: [persistedConv("conv-1", { modelId: null })],
      activeConversationId: "conv-1",
    });

    expect(m.get("conv-1")?.modelId).toBeNull();
  });

  test("modelId is preserved across a recordUndo write (structural: undo entries do NOT capture metadata)", () => {
    // Phase 1 guards the property that undo entries are pure file-
    // action snapshots — they do not bundle conversation metadata.
    // We assert this structurally by:
    //   1. binding a modelId via setConversationModelId
    //   2. routing an undo write through the runtime persist adapter
    //   3. confirming the persisted blob still carries that modelId
    const { factory, built } = makeFakeFactory();
    const { store, state } = makeFakeStore();
    const m = new ConversationManager({ runtimeFactory: factory, store });
    m.hydrate({
      conversations: [persistedConv("conv-1")],
      activeConversationId: "conv-1",
    });

    m.setConversationModelId("conv-1", "gpt-4.1");
    expect(state.byId.get("conv-1")?.modelId).toBe("gpt-4.1");

    // Materialize the runtime and route an undo entry through its
    // persist adapter (mirrors what the undo journal does at runtime).
    m.getActiveRuntime();
    const adapter = built[0].persistAdapter;
    expect(adapter).toBeDefined();
    adapter!.onJournalOp("add", {
      id: "u1",
      kind: "modify",
      scope: "vault",
      path: "n.md",
      recordedAt: 999,
    });

    // The modelId must survive the undo write because metadata is
    // read from the live conversation, not reconstructed from the
    // entry payload. If a future refactor accidentally recomputes
    // metadata from undo entries, this test will fail loudly.
    expect(state.byId.get("conv-1")?.modelId).toBe("gpt-4.1");
    expect(state.byId.get("conv-1")?.undoEntries).toHaveLength(1);
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

  test("runtime persist adapter mirrors 'evict' to store.removeUndoEntry (Phase 6 TTL backstop)", () => {
    const { factory, built } = makeFakeFactory();
    const { store, removeUndoEntrySpy } = makeFakeStore();
    const m = new ConversationManager({ runtimeFactory: factory, store });
    m.hydrate({
      conversations: [persistedConv("conv-1")],
      activeConversationId: "conv-1",
    });
    m.getActiveRuntime();
    const adapter = built[0].persistAdapter!;
    adapter.onJournalOp("evict", {
      id: "u-stale",
      kind: "modify",
      scope: "vault",
      path: "a.md",
      recordedAt: 1,
    });
    expect(removeUndoEntrySpy).toHaveBeenCalledWith("conv-1", "u-stale");
  });
});

describe("ConversationManager — message persistence (FR-007)", () => {
  test("persistMessageAppend forwards to store.appendMessage for known conv", () => {
    const { factory } = makeFakeFactory();
    const { store, state } = makeFakeStore();
    state.byId.set("conv-1", persistedConv("conv-1"));
    const m = new ConversationManager({ runtimeFactory: factory, store });
    m.hydrate({
      conversations: [persistedConv("conv-1")],
      activeConversationId: "conv-1",
    });
    m.persistMessageAppend("conv-1", {
      id: "m1",
      role: "user",
      content: "hi",
      status: "complete",
      createdAt: 1,
    });
    expect(state.byId.get("conv-1")!.messages.map((x) => x.id)).toEqual(["m1"]);
  });  test("persistMessageAppend is a no-op for unknown conv ids (race-safe)", () => {
    const { factory } = makeFakeFactory();
    const { store } = makeFakeStore();
    const m = new ConversationManager({ runtimeFactory: factory, store });
    m.hydrate({
      conversations: [persistedConv("conv-1")],
      activeConversationId: "conv-1",
    });
    // Removed mid-flight scenario — call must not throw.
    expect(() =>
      m.persistMessageAppend("conv-ghost", {
        id: "x",
        role: "user",
        content: "y",
        status: "complete",
        createdAt: 1,
      }),
    ).not.toThrow();
  });

  test("persistMessageReplace forwards to store.replaceMessage", () => {
    const { factory } = makeFakeFactory();
    const { store, state } = makeFakeStore();
    const seed = persistedConv("conv-1", {
      messages: [
        {
          id: "m1",
          role: "assistant",
          content: "",
          status: "complete",
          createdAt: 1,
        },
      ],
    });
    state.byId.set("conv-1", seed);
    const m = new ConversationManager({ runtimeFactory: factory, store });
    m.hydrate({ conversations: [seed], activeConversationId: "conv-1" });
    m.persistMessageReplace("conv-1", "m1", {
      content: "final",
      status: "complete",
    });
    expect(state.byId.get("conv-1")!.messages[0].content).toBe("final");
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

// ---------- FR-005 auto-naming helpers + manager hook ----------

describe("formatUntitledName (FR-005)", () => {
  test("produces 'Untitled YYYY-MM-DD HH:MM' in local time", () => {
    // Build a Date locally so the assertion matches whatever TZ the
    // test runs in (CI agents can be UTC, dev machines often aren't).
    const d = new Date(2026, 5, 11, 14, 5, 0); // local 2026-06-11 14:05
    const out = formatUntitledName(d.getTime());
    expect(out).toBe("Untitled 2026-06-11 14:05");
  });

  test("pads single-digit month/day/hour/minute", () => {
    const d = new Date(2026, 0, 3, 4, 7, 0); // local 2026-01-03 04:07
    expect(formatUntitledName(d.getTime())).toBe("Untitled 2026-01-03 04:07");
  });
});

describe("isDefaultConversationName (FR-005)", () => {
  test("matches bare 'Untitled' + numeric-suffix variant", () => {
    expect(isDefaultConversationName("Untitled")).toBe(true);
    expect(isDefaultConversationName("Untitled 2")).toBe(true);
    expect(isDefaultConversationName("Untitled 42")).toBe(true);
  });

  test("matches timestamped variant + its numeric suffix", () => {
    expect(isDefaultConversationName("Untitled 2026-06-11 14:05")).toBe(true);
    expect(isDefaultConversationName("Untitled 2026-06-11 14:05 3")).toBe(true);
  });

  test("rejects user-chosen names", () => {
    expect(isDefaultConversationName("Trip planning")).toBe(false);
    expect(isDefaultConversationName("Untitled stuff")).toBe(false);
    expect(isDefaultConversationName("untitled")).toBe(false); // case-sensitive
    // Note: "Untitled 2026" (a 4-digit-only suffix without a date) is
    // not distinguished from the legitimate " N" disambiguation
    // suffix — small ambiguity, accepted.
  });
});

describe("deriveConversationNameFromMessage (FR-005)", () => {
  test("uses the first non-empty line", () => {
    expect(deriveConversationNameFromMessage("\n\nHello there\nrest")).toBe(
      "Hello there",
    );
  });

  test("trims leading/trailing whitespace", () => {
    expect(deriveConversationNameFromMessage("   hi   ")).toBe("hi");
  });

  test("truncates to ~40 chars with ellipsis", () => {
    const long = "x".repeat(80);
    const out = deriveConversationNameFromMessage(long);
    expect(Array.from(out)).toHaveLength(40);
    expect(out.endsWith("…")).toBe(true);
  });

  test("emoji counted as one char (surrogate-safe)", () => {
    const out = deriveConversationNameFromMessage("🎯".repeat(50), 10);
    expect(Array.from(out)).toHaveLength(10);
    expect(out.endsWith("…")).toBe(true);
  });

  test("returns empty string when input is blank", () => {
    expect(deriveConversationNameFromMessage("   \n\n  ")).toBe("");
  });
});

describe("ConversationManager.maybeAutoNameFromFirstMessage (FR-005)", () => {
  test("renames when name is still a default + first-message non-empty", () => {
    const { factory } = makeFakeFactory();
    const { store } = makeFakeStore();
    const m = new ConversationManager({ runtimeFactory: factory, store });
    const id = m.hydrate({ conversations: [], activeConversationId: null });
    const changed = m.maybeAutoNameFromFirstMessage(id, "Plan a hike");
    expect(changed).toBe(true);
    expect(m.get(id)?.name).toBe("Plan a hike");
  });

  test("no-op when the user has already renamed", () => {
    const { factory } = makeFakeFactory();
    const { store } = makeFakeStore();
    const m = new ConversationManager({ runtimeFactory: factory, store });
    const id = m.hydrate({ conversations: [], activeConversationId: null });
    m.rename(id, "My custom name");
    const changed = m.maybeAutoNameFromFirstMessage(id, "Tell me a joke");
    expect(changed).toBe(false);
    expect(m.get(id)?.name).toBe("My custom name");
  });

  test("no-op when first-message content is blank", () => {
    const { factory } = makeFakeFactory();
    const { store } = makeFakeStore();
    const m = new ConversationManager({ runtimeFactory: factory, store });
    const id = m.hydrate({ conversations: [], activeConversationId: null });
    const before = m.get(id)?.name;
    const changed = m.maybeAutoNameFromFirstMessage(id, "   \n  ");
    expect(changed).toBe(false);
    expect(m.get(id)?.name).toBe(before);
  });

  test("no-op when convId is unknown", () => {
    const { factory } = makeFakeFactory();
    const { store } = makeFakeStore();
    const m = new ConversationManager({ runtimeFactory: factory, store });
    m.hydrate({ conversations: [], activeConversationId: null });
    expect(m.maybeAutoNameFromFirstMessage("nope", "hello")).toBe(false);
  });

  test("idempotent: second call after rename does nothing", () => {
    const { factory } = makeFakeFactory();
    const { store } = makeFakeStore();
    const m = new ConversationManager({ runtimeFactory: factory, store });
    const id = m.hydrate({ conversations: [], activeConversationId: null });
    expect(m.maybeAutoNameFromFirstMessage(id, "First message text")).toBe(true);
    expect(m.maybeAutoNameFromFirstMessage(id, "Different second message")).toBe(false);
    expect(m.get(id)?.name).toBe("First message text");
  });
});

// v0.4 Phase 3 (FR-007): creation-time modelId resolution.
describe("ConversationManager — creation-time modelId resolution (v0.4 FR-007)", () => {
  test("when resolveCreationModelId returns a string id, it is persisted on the new conversation", () => {
    const { factory } = makeFakeFactory();
    const { store, state } = makeFakeStore();
    const m = new ConversationManager({
      runtimeFactory: factory,
      store,
      resolveCreationModelId: () => ({ modelId: "gpt-4o", configuredDefault: "gpt-4o" }),
    });
    m.hydrate({ conversations: [], activeConversationId: null });
    const id = m.create().id;
    expect(m.get(id)?.modelId).toBe("gpt-4o");
    expect(state.byId.get(id)?.modelId).toBe("gpt-4o");
  });

  test("when resolver returns null, conversation is created without modelId (v0.3 behavior)", () => {
    const { factory } = makeFakeFactory();
    const { store, state } = makeFakeStore();
    const m = new ConversationManager({
      runtimeFactory: factory,
      store,
      resolveCreationModelId: () => ({ modelId: null }),
    });
    m.hydrate({ conversations: [], activeConversationId: null });
    const id = m.create().id;
    expect(m.get(id)?.modelId).toBeNull();
    expect(state.byId.get(id)?.modelId).toBeNull();
  });

  test("when no resolver is provided, conversation has undefined modelId (legacy)", () => {
    const { factory } = makeFakeFactory();
    const { store, state } = makeFakeStore();
    const m = new ConversationManager({ runtimeFactory: factory, store });
    m.hydrate({ conversations: [], activeConversationId: null });
    const id = m.create().id;
    expect(m.get(id)?.modelId).toBeUndefined();
    expect(state.byId.get(id)?.modelId).toBeUndefined();
  });

  test("when defaultWasUnavailable is true, onUnavailableDefault fires once with configured id", () => {
    const { factory } = makeFakeFactory();
    const { store } = makeFakeStore();
    const noticeSpy = vi.fn();
    const m = new ConversationManager({
      runtimeFactory: factory,
      store,
      resolveCreationModelId: () => ({
        modelId: "gpt-4o",
        configuredDefault: "missing-model",
        defaultWasUnavailable: true,
      }),
      onUnavailableDefault: noticeSpy,
    });
    m.hydrate({ conversations: [persistedConv("seed")], activeConversationId: "seed" });
    noticeSpy.mockClear();
    const id = m.create().id;
    expect(noticeSpy).toHaveBeenCalledTimes(1);
    expect(noticeSpy).toHaveBeenCalledWith("missing-model");
    expect(m.get(id)?.modelId).toBe("gpt-4o");
  });

  test("when defaultWasUnavailable is true but no configuredDefault, onUnavailableDefault does NOT fire", () => {
    const { factory } = makeFakeFactory();
    const { store } = makeFakeStore();
    const noticeSpy = vi.fn();
    const m = new ConversationManager({
      runtimeFactory: factory,
      store,
      resolveCreationModelId: () => ({
        modelId: "gpt-4o",
        defaultWasUnavailable: true,
      }),
      onUnavailableDefault: noticeSpy,
    });
    m.hydrate({ conversations: [], activeConversationId: null });
    m.create();
    expect(noticeSpy).not.toHaveBeenCalled();
  });

  test("if the resolver throws, conversation is still created with null modelId", () => {
    const { factory } = makeFakeFactory();
    const { store } = makeFakeStore();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const m = new ConversationManager({
      runtimeFactory: factory,
      store,
      resolveCreationModelId: () => {
        throw new Error("resolver boom");
      },
    });
    m.hydrate({ conversations: [], activeConversationId: null });
    const id = m.create().id;
    expect(m.get(id)?.modelId).toBeNull();
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  test("existing conversations are unaffected by resolver changes", () => {
    const { factory } = makeFakeFactory();
    const { store } = makeFakeStore();
    // Hydrate a conversation that already has a modelId.
    const m = new ConversationManager({
      runtimeFactory: factory,
      store,
      resolveCreationModelId: () => ({ modelId: "gpt-4o" }),
    });
    m.hydrate({
      conversations: [persistedConv("c1", { modelId: "claude-3" })],
      activeConversationId: "c1",
    });
    expect(m.get("c1")?.modelId).toBe("claude-3");
    // Creating a NEW one uses the resolver; existing unchanged.
    const id = m.create().id;
    expect(m.get("c1")?.modelId).toBe("claude-3");
    expect(m.get(id)?.modelId).toBe("gpt-4o");
  });
});



