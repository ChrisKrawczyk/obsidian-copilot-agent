import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ConversationsStore,
  UNDO_MAX_ENTRIES,
  UNDO_TTL_MS,
} from "./ConversationsStore";
import {
  CURRENT_SCHEMA_VERSION,
  type PersistedConversation,
  type PersistedUndoEntry,
} from "./PersistedShape";

interface RecordingAdapter {
  write: ReturnType<typeof vi.fn>;
  written: Map<string, string>;
}

function makeAdapter(): RecordingAdapter {
  const written = new Map<string, string>();
  return {
    written,
    write: vi.fn(async (path: string, data: string) => {
      written.set(path, data);
    }),
  };
}

interface FakeIO {
  loadData: ReturnType<typeof vi.fn>;
  saveData: ReturnType<typeof vi.fn>;
  /** Current persisted blob (mirror of saveData arg). */
  blob: Record<string, unknown> | null;
}

function makeIO(initial: Record<string, unknown> | null = null): FakeIO {
  const io: FakeIO = {
    blob: initial,
    loadData: vi.fn(async () => io.blob),
    saveData: vi.fn(async (data: unknown) => {
      io.blob = data == null ? null : { ...(data as Record<string, unknown>) };
    }),
  };
  return io;
}

function newConv(id: string, overrides: Partial<PersistedConversation> = {}): PersistedConversation {
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

function makeStore(opts: {
  io?: FakeIO;
  adapter?: RecordingAdapter;
  debounceMs?: number;
  now?: () => number;
  notify?: (msg: string) => void;
} = {}) {
  const io = opts.io ?? makeIO();
  const adapter = opts.adapter ?? makeAdapter();
  const store = new ConversationsStore({
    io: { loadData: io.loadData, saveData: io.saveData },
    adapter: { write: adapter.write },
    pluginDataDir: ".obsidian/plugins/copilot-agent",
    debounceMs: opts.debounceMs ?? 0,
    now: opts.now,
    notify: opts.notify,
  });
  return { store, io, adapter };
}

describe("ConversationsStore — load + recovery", () => {
  it("returns recovered:false on a clean (nullish) blob", async () => {
    const { store } = makeStore();
    const r = await store.load();
    expect(r.recovered).toBe(false);
    expect(r.state.conversations).toEqual([]);
    expect(r.state.activeConversationId).toBeNull();
  });

  it("preserves auth/safety/settings on recovery (data.json is NOT renamed)", async () => {
    const io = makeIO({
      schemaVersion: 999, // unknown → triggers recovery
      conversations: "garbage",
      auth: { token: "real-auth-token" },
      safety: { defaultMode: "auto-apply-with-undo" },
      settings: { persistEnabled: true },
    });
    const adapter = makeAdapter();
    const { store } = makeStore({ io, adapter });
    const r = await store.load();
    expect(r.recovered).toBe(true);
    expect(r.recoveryPath).toMatch(/conversations_recovery\.bak\.json$/);
    // sidecar written
    expect(adapter.write).toHaveBeenCalledTimes(1);
    expect(adapter.write.mock.calls[0][0]).toMatch(
      /conversations_recovery\.bak\.json$/,
    );
    // saveData persisted defaults but kept auth/safety/settings intact
    expect(io.blob).toEqual({
      schemaVersion: CURRENT_SCHEMA_VERSION,
      conversations: [],
      activeConversationId: null,
      auth: { token: "real-auth-token" },
      safety: { defaultMode: "auto-apply-with-undo" },
      settings: { persistEnabled: true },
    });
  });

  it("recovery sidecar payload contains the malformed subtree", async () => {
    const malformed = { schemaVersion: 999, conversations: "garbage" };
    const io = makeIO(malformed);
    const adapter = makeAdapter();
    const { store } = makeStore({ io, adapter });
    await store.load();
    const sidecar = JSON.parse(adapter.write.mock.calls[0][1] as string);
    expect(sidecar.malformed).toEqual({
      schemaVersion: 999,
      conversations: "garbage",
      activeConversationId: undefined,
    });
    expect(sidecar.schemaVersionExpected).toBe(CURRENT_SCHEMA_VERSION);
  });

  it("hydrates a well-formed prior blob without recovery", async () => {
    const io = makeIO({
      schemaVersion: CURRENT_SCHEMA_VERSION,
      conversations: [
        {
          id: "c1",
          name: "Project",
          createdAt: 1,
          lastActiveAt: 2,
          messages: [],
          undoEntries: [],
        },
      ],
      activeConversationId: "c1",
    });
    const { store } = makeStore({ io });
    const r = await store.load();
    expect(r.recovered).toBe(false);
    expect(r.state.conversations).toHaveLength(1);
    expect(r.state.activeConversationId).toBe("c1");
  });
});

describe("ConversationsStore — top-level merge preserves sibling keys", () => {
  it("does not clobber auth/safety on writes", async () => {
    const io = makeIO({
      auth: { token: "tok" },
      safety: { defaultMode: "require-approval" },
    });
    const { store } = makeStore({ io });
    await store.load();
    store.upsertConversation(newConv("c1"));
    // debounceMs=0 → flushImmediate fires inside scheduleFlush, but
    // it's queued through `tail`; await it via flushNow which awaits tail.
    await store.flushNow();
    expect(io.blob).toMatchObject({
      auth: { token: "tok" },
      safety: { defaultMode: "require-approval" },
      schemaVersion: CURRENT_SCHEMA_VERSION,
      activeConversationId: null,
    });
    const conversations = (io.blob as { conversations: unknown[] }).conversations;
    expect(conversations).toHaveLength(1);
  });
});

// v0.4 (model-picker) Phase 1: per-conversation modelId must round-
// trip through the store cleanly and survive a clone (load → snapshot
// → upsert). These tests pair with migrate.test.ts; together they pin
// the persistence pipeline end-to-end.
describe("ConversationsStore — v0.4 modelId round-trip", () => {
  it("hydrates a string modelId from disk and exposes it via listConversations", async () => {
    const io = makeIO({
      schemaVersion: CURRENT_SCHEMA_VERSION,
      conversations: [
        {
          id: "c1",
          name: "x",
          createdAt: 1,
          lastActiveAt: 1,
          modelId: "gpt-4.1",
          messages: [],
          undoEntries: [],
        },
      ],
      activeConversationId: "c1",
    });
    const { store } = makeStore({ io });
    await store.load();
    expect(store.listConversations()[0].modelId).toBe("gpt-4.1");
  });

  it("hydrates a null modelId from disk verbatim (v1-migrated row)", async () => {
    const io = makeIO({
      schemaVersion: CURRENT_SCHEMA_VERSION,
      conversations: [
        {
          id: "c1",
          name: "x",
          createdAt: 1,
          lastActiveAt: 1,
          modelId: null,
          messages: [],
          undoEntries: [],
        },
      ],
      activeConversationId: "c1",
    });
    const { store } = makeStore({ io });
    await store.load();
    expect(store.listConversations()[0].modelId).toBeNull();
  });

  it("treats a missing modelId key as undefined (preserves the absence)", async () => {
    const io = makeIO({
      schemaVersion: CURRENT_SCHEMA_VERSION,
      conversations: [
        {
          id: "c1",
          name: "x",
          createdAt: 1,
          lastActiveAt: 1,
          messages: [],
          undoEntries: [],
        },
      ],
      activeConversationId: "c1",
    });
    const { store } = makeStore({ io });
    await store.load();
    expect(store.listConversations()[0].modelId).toBeUndefined();
  });

  it("upsert persists modelId to disk and survives a subsequent load", async () => {
    const io = makeIO();
    const { store } = makeStore({ io });
    await store.load();
    store.upsertConversation(newConv("c1", { modelId: "gpt-4.1" }));
    await store.flushNow();
    const persisted = (io.blob as { conversations: PersistedConversation[] })
      .conversations;
    expect(persisted[0].modelId).toBe("gpt-4.1");

    // Reload through a fresh store instance to confirm durability.
    const { store: store2 } = makeStore({ io });
    await store2.load();
    expect(store2.listConversations()[0].modelId).toBe("gpt-4.1");
  });

  it("v0.3 (schemaVersion=1) blob loads without recovery and exposes modelId=null", async () => {
    const io = makeIO({
      schemaVersion: 1,
      conversations: [
        {
          id: "c1",
          name: "x",
          createdAt: 1,
          lastActiveAt: 1,
          messages: [],
          undoEntries: [],
        },
      ],
      activeConversationId: "c1",
    });
    const { store } = makeStore({ io });
    const r = await store.load();
    expect(r.recovered).toBe(false);
    expect(store.listConversations()[0].modelId).toBeNull();
  });
});

describe("ConversationsStore — debounce + flushNow", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("coalesces multiple mutations into a single write within the window", async () => {
    const io = makeIO();
    const { store } = makeStore({ io, debounceMs: 500 });
    await store.load();
    store.upsertConversation(newConv("a"));
    store.upsertConversation(newConv("b"));
    store.upsertConversation(newConv("c"));
    expect(io.saveData).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(500);
    expect(io.saveData).toHaveBeenCalledTimes(1);
    const written = (io.blob as { conversations: PersistedConversation[] })
      .conversations;
    expect(written.map((c) => c.id).sort()).toEqual(["a", "b", "c"]);
  });

  it("flushNow cancels the pending debounce and resolves after the write", async () => {
    const io = makeIO();
    const { store } = makeStore({ io, debounceMs: 500 });
    await store.load();
    store.upsertConversation(newConv("a"));
    expect(io.saveData).not.toHaveBeenCalled();
    await store.flushNow();
    expect(io.saveData).toHaveBeenCalledTimes(1);
    // debounce timer cancelled — no second write should fire later.
    await vi.advanceTimersByTimeAsync(1000);
    expect(io.saveData).toHaveBeenCalledTimes(1);
  });

  it("flushNow is a no-op when nothing is dirty", async () => {
    const io = makeIO();
    const { store } = makeStore({ io, debounceMs: 500 });
    await store.load();
    await store.flushNow();
    expect(io.saveData).not.toHaveBeenCalled();
  });

  it("upsertConversation is a no-op when the row matches existing state (CONS-2 / SC-001)", async () => {
    // Arrange: a store pre-loaded with an existing conversation row,
    // mirroring the post-quiescent-restart shape.
    const seed: PersistedConversation = {
      id: "c1",
      name: "Already there",
      createdAt: 100,
      lastActiveAt: 200,
      messages: [],
      undoEntries: [],
    };
    const io = makeIO({
      schemaVersion: CURRENT_SCHEMA_VERSION,
      conversations: [seed],
      activeConversationId: "c1",
    });
    const { store } = makeStore({ io, debounceMs: 500 });
    await store.load();
    expect(io.saveData).not.toHaveBeenCalled();

    // Act: ConversationManager.hydrate() mirrors the persisted row
    // back into the store. With the equality guard this is a no-op.
    store.upsertConversation({ ...seed });
    await vi.advanceTimersByTimeAsync(1000);

    // Assert: no spurious flush.
    expect(io.saveData).not.toHaveBeenCalled();
  });
});

describe("ConversationsStore — write tail-serialization", () => {
  it("two concurrent flushes do not interleave saveData calls", async () => {
    const io = makeIO();
    // Slow saveData so we can prove serialization.
    const order: string[] = [];
    let counter = 0;
    io.saveData.mockImplementation(async (data: unknown) => {
      const tag = `w${++counter}`;
      order.push(`start-${tag}`);
      await new Promise((r) => setTimeout(r, 0));
      order.push(`end-${tag}`);
      io.blob = data == null ? null : { ...(data as Record<string, unknown>) };
    });
    const { store } = makeStore({ io, debounceMs: 0 });
    await store.load();
    store.upsertConversation(newConv("a"));
    const p1 = store.flushNow();
    store.upsertConversation(newConv("b"));
    const p2 = store.flushNow();
    await Promise.all([p1, p2]);
    // Whatever number of writes ended up firing, none interleaved:
    // every "end-wN" must immediately follow its matching "start-wN".
    for (let i = 0; i < order.length; i += 2) {
      expect(order[i].startsWith("start-")).toBe(true);
      expect(order[i + 1]).toBe(order[i].replace("start-", "end-"));
    }
    // Both mutations are persisted in the final blob (writes coalesce
    // through the cached state).
    const conversations = (io.blob as { conversations: PersistedConversation[] })
      .conversations;
    expect(conversations.map((c) => c.id).sort()).toEqual(["a", "b"]);
  });
});

describe("ConversationsStore — recordUndo SF-2 50-cap", () => {
  it("evicts the oldest entry synchronously when at cap", async () => {
    const io = makeIO();
    let t = 1000;
    const { store } = makeStore({ io, now: () => t++ });
    await store.load();
    store.upsertConversation(newConv("c1"));
    for (let i = 0; i < UNDO_MAX_ENTRIES; i++) {
      const r = store.recordUndo("c1", undoEntry(`u${i}`, 1000 + i));
      expect(r.evictedId).toBeNull();
    }
    const evict = store.recordUndo("c1", undoEntry("u-new", 9999));
    expect(evict.evictedId).toBe("u0"); // oldest by recordedAt
    const conv = store.listConversations()[0];
    expect(conv.undoEntries).toHaveLength(UNDO_MAX_ENTRIES);
    expect(conv.undoEntries.map((e) => e.id)).not.toContain("u0");
    expect(conv.undoEntries.at(-1)?.id).toBe("u-new");
  });
});

describe("ConversationsStore — pruneOnLoad TTL", () => {
  it("drops entries older than 7 days across multiple conversations", async () => {
    const io = makeIO();
    const NOW = 10_000_000_000;
    const STALE = NOW - UNDO_TTL_MS - 1;
    const FRESH = NOW - 60_000;
    const { store } = makeStore({ io, now: () => NOW });
    await store.load();
    store.upsertConversation(
      newConv("c1", {
        undoEntries: [
          undoEntry("stale-1", STALE),
          undoEntry("fresh-1", FRESH),
        ],
      }),
    );
    store.upsertConversation(
      newConv("c2", {
        undoEntries: [undoEntry("stale-2", STALE)],
      }),
    );
    store.upsertConversation(
      newConv("c3", {
        undoEntries: [undoEntry("fresh-2", FRESH)],
      }),
    );
    const r = store.pruneOnLoad();
    expect(r.droppedCount).toBe(2);
    const byId = Object.fromEntries(
      store.listConversations().map((c) => [c.id, c.undoEntries.map((e) => e.id)]),
    );
    expect(byId.c1).toEqual(["fresh-1"]);
    expect(byId.c2).toEqual([]);
    expect(byId.c3).toEqual(["fresh-2"]);
  });

  it("is idempotent / no-op when nothing is stale", async () => {
    const io = makeIO();
    const { store } = makeStore({ io, now: () => 5_000_000 });
    await store.load();
    store.upsertConversation(
      newConv("c1", { undoEntries: [undoEntry("u", 4_999_999)] }),
    );
    expect(store.pruneOnLoad().droppedCount).toBe(0);
  });
});

describe("ConversationsStore — message + active operations", () => {
  it("appendMessage updates lastActiveAt to now()", async () => {
    let t = 100;
    const { store } = makeStore({ now: () => t++ });
    await store.load();
    store.upsertConversation(newConv("c1", { lastActiveAt: 0 }));
    store.appendMessage("c1", {
      id: "m1",
      role: "user",
      content: "hi",
      status: "complete",
      createdAt: 99,
    });
    const c = store.listConversations()[0];
    expect(c.messages).toHaveLength(1);
    expect(c.lastActiveAt).toBeGreaterThanOrEqual(100);
  });

  it("setActiveId rejects unknown ids", async () => {
    const { store } = makeStore();
    await store.load();
    expect(() => store.setActiveId("nope")).toThrow();
  });

  it("removeConversation clears activeId when removing the active one", async () => {
    const { store } = makeStore();
    await store.load();
    store.upsertConversation(newConv("c1"));
    store.setActiveId("c1");
    store.removeConversation("c1");
    expect(store.getActiveId()).toBeNull();
  });
});

function undoEntry(id: string, recordedAt: number): PersistedUndoEntry {
  return {
    id,
    kind: "modify",
    scope: "vault",
    path: "n.md",
    recordedAt,
  };
}


describe("ConversationsStore — markUndone immediate flush (FR-013)", () => {
  it("flushes synchronously without waiting for debounce", async () => {
    const io = makeIO();
    const { store } = makeStore({ io, debounceMs: 500 });
    await store.load();
    store.upsertConversation(newConv("c1"));
    store.recordUndo("c1", undoEntry("u1", 1000));
    await store.flushNow();
    io.saveData.mockClear();
    store.markUndone("c1", "u1");
    // Drain the tail (immediate flush is fire-and-forget through enqueue).
    await new Promise((r) => setTimeout(r, 0));
    await store.flushNow();
    expect(io.saveData).toHaveBeenCalled();
    const persistedConv = (io.blob as { conversations: PersistedConversation[] })
      .conversations[0];
    expect(persistedConv.undoEntries[0].undone).toBe(true);
  });
});

describe("ConversationsStore — 5MB size warning (SC-011)", () => {
  it("fires notify exactly once when payload crosses 5 MB", async () => {
    const io = makeIO();
    const notify = vi.fn();
    const { store } = makeStore({ io, notify, debounceMs: 0 });
    await store.load();
    store.upsertConversation(newConv("c1"));
    // Push the persisted blob over 5 MB by inserting one huge message.
    const big = "x".repeat(5 * 1024 * 1024 + 100);
    store.appendMessage("c1", {
      id: "m1",
      role: "user",
      content: big,
      createdAt: 1,
    });
    await store.flushNow();
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][0]).toMatch(/5 MB/);
    // Subsequent flushes do NOT re-fire.
    store.appendMessage("c1", {
      id: "m2",
      role: "user",
      content: "small",
      createdAt: 2,
    });
    await store.flushNow();
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("does not fire when payload stays under 5 MB", async () => {
    const io = makeIO();
    const notify = vi.fn();
    const { store } = makeStore({ io, notify });
    await store.load();
    store.upsertConversation(newConv("c1"));
    store.appendMessage("c1", {
      id: "m1",
      role: "user",
      content: "hello",
      createdAt: 1,
    });
    await store.flushNow();
    expect(notify).not.toHaveBeenCalled();
  });
});
