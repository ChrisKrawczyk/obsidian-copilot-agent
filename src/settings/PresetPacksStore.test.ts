import { describe, expect, test, vi } from "vitest";
import type { PluginDataIO } from "../auth/TokenStore";
import { PresetPacksStore } from "./PresetPacksStore";
import type { Pack } from "./presets/packTypes";

function memoryIo(initial: unknown = null): PluginDataIO & { peek: () => unknown } {
  let store: unknown = initial;
  return {
    loadData: async () => store,
    saveData: async (data: unknown) => {
      store = data;
    },
    peek: () => store,
  };
}

function pack(id: string, overrides: Partial<Pack> = {}): Pack {
  return {
    schemaVersion: 1,
    id,
    label: overrides.label ?? id.toUpperCase(),
    version: overrides.version ?? "1",
    presets: overrides.presets ?? [
      {
        id: "p1",
        label: "Preset 1",
        server: { name: "Preset 1", transport: "http", url: "https://example.com/mcp" },
        credentials: { kind: "none" },
      },
    ],
  };
}

function makeStore(io: PluginDataIO, notify = vi.fn()) {
  let n = 0;
  let t = 1_700_000_000_000;
  return new PresetPacksStore(
    io,
    notify,
    () => ++t,
    () => `rid${++n}`,
  );
}

describe("PresetPacksStore", () => {
  test("empty load yields empty snapshot", async () => {
    const store = makeStore(memoryIo({ auth: { token: "tok" } }));
    expect(await store.load()).toEqual([]);
    expect(store.snapshot()).toEqual([]);
  });

  test("loads one valid record", async () => {
    const io = memoryIo({
      mcpPresetPacks: [
        { recordId: "abc", pack: pack("vendor"), importedAt: 100, sourcePath: "/x.json" },
      ],
    });
    const store = makeStore(io);
    const snap = await store.load();
    expect(snap).toHaveLength(1);
    expect(snap[0].recordId).toBe("abc");
    expect(snap[0].pack.id).toBe("vendor");
    expect(snap[0].sourcePath).toBe("/x.json");
  });

  test("drops malformed pack records and emits a one-time Notice", async () => {
    const notify = vi.fn();
    const io = memoryIo({
      mcpPresetPacks: [
        { recordId: "ok", pack: pack("vendor"), importedAt: 1, sourcePath: "/v.json" },
        { recordId: "bad", pack: { id: "broken" }, importedAt: 2, sourcePath: "/b.json" }, // fails validation
        { recordId: "bogus", pack: { id: "builtin", schemaVersion: 1, label: "x", version: "1", presets: [] }, importedAt: 3, sourcePath: "/r.json" }, // reserved id
      ],
    });
    const store = makeStore(io, notify);
    expect(await store.load()).toHaveLength(1);
    await store.load();
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][0]).toMatch(/broken/);
    expect(notify.mock.calls[0][0]).toMatch(/builtin/);
  });

  test("addOrReplace creates by pack.id then replaces with fresh recordId + importedAt", async () => {
    const io = memoryIo({});
    const store = makeStore(io);
    await store.load();
    const created = await store.addOrReplace(pack("vendor"), "/v.json");
    expect(store.snapshot()).toHaveLength(1);
    expect(created.recordId).toBe("rid1");
    expect(created.sourcePath).toBe("/v.json");
    const updated = await store.addOrReplace(
      pack("vendor", { label: "Vendor v2", version: "2" }),
      "/v2.json",
    );
    expect(store.snapshot()).toHaveLength(1);
    expect(updated.recordId).toBe("rid2");
    expect(updated.recordId).not.toBe(created.recordId);
    expect(updated.importedAt).toBeGreaterThan(created.importedAt);
    expect(store.snapshot()[0].pack.label).toBe("Vendor v2");
  });

  test("remove(packId) deletes the matching record", async () => {
    const io = memoryIo({});
    const store = makeStore(io);
    await store.load();
    await store.addOrReplace(pack("alpha"), "/a.json");
    await store.addOrReplace(pack("beta"), "/b.json");
    expect(store.snapshot()).toHaveLength(2);
    await store.remove("alpha");
    const ids = store.snapshot().map((r) => r.pack.id);
    expect(ids).toEqual(["beta"]);
  });

  test("remove(packId) does NOT touch sibling mcpServers key (FR-008)", async () => {
    const io = memoryIo({
      mcpServers: [{ id: "s1", name: "x", enabled: true, transport: "stdio", command: "node", args: [] }],
      mcpPresetPacks: [
        { recordId: "r", pack: pack("alpha"), importedAt: 1, sourcePath: "/a.json" },
      ],
    });
    const store = makeStore(io);
    await store.load();
    const before = (io.peek() as { mcpServers: unknown }).mcpServers;
    await store.remove("alpha");
    const after = (io.peek() as { mcpServers: unknown }).mcpServers;
    expect(after).toEqual(before);
  });

  test("persist preserves sibling top-level keys (mcpServers/safety/auth/conversations)", async () => {
    const io = memoryIo({
      auth: { token: "tok" },
      safety: { defaultMode: "require-approval" },
      conversations: [{ id: "c1" }],
      mcpServers: [{ id: "s1" }],
    });
    const store = makeStore(io);
    await store.load();
    await store.addOrReplace(pack("vendor"), "/v.json");
    const persisted = io.peek() as Record<string, unknown>;
    expect(persisted.auth).toEqual({ token: "tok" });
    expect(persisted.safety).toEqual({ defaultMode: "require-approval" });
    expect(persisted.conversations).toEqual([{ id: "c1" }]);
    expect(persisted.mcpServers).toEqual([{ id: "s1" }]);
    expect(Array.isArray(persisted.mcpPresetPacks)).toBe(true);
    expect((persisted.mcpPresetPacks as unknown[])).toHaveLength(1);
  });

  test("round-trip: load → addOrReplace → load is canonically equivalent", async () => {
    const io = memoryIo({});
    const a = makeStore(io);
    await a.load();
    await a.addOrReplace(pack("vendor"), "/x.json");
    const b = makeStore(io);
    const snap = await b.load();
    expect(snap).toHaveLength(1);
    expect(snap[0].pack.id).toBe("vendor");
    expect(snap[0].sourcePath).toBe("/x.json");
  });

  test("subscribers fire on persist", async () => {
    const io = memoryIo({});
    const store = makeStore(io);
    await store.load();
    const sub = vi.fn();
    store.subscribe(sub);
    await store.addOrReplace(pack("vendor"), "/v.json");
    expect(sub).toHaveBeenCalled();
    expect(sub.mock.calls[0][0][0].pack.id).toBe("vendor");
  });

  test("snapshot returns deep clones (mutation does not affect store)", async () => {
    const io = memoryIo({});
    const store = makeStore(io);
    await store.load();
    await store.addOrReplace(pack("vendor"), "/v.json");
    const s1 = store.snapshot();
    s1[0].pack.label = "tampered";
    expect(store.snapshot()[0].pack.label).not.toBe("tampered");
  });

  test("recordId is unique per insert", async () => {
    const io = memoryIo({});
    const store = makeStore(io);
    await store.load();
    await store.addOrReplace(pack("a"), "/a.json");
    await store.addOrReplace(pack("b"), "/b.json");
    await store.addOrReplace(pack("c"), "/c.json");
    const ids = store.snapshot().map((r) => r.recordId);
    expect(new Set(ids).size).toBe(3);
  });

  test("non-array mcpPresetPacks falls back to []", async () => {
    const store = makeStore(memoryIo({ mcpPresetPacks: "bogus" }));
    expect(await store.load()).toEqual([]);
  });

  test("addOrReplace replaces in place (preserves order)", async () => {
    const io = memoryIo({});
    const store = makeStore(io);
    await store.load();
    await store.addOrReplace(pack("alpha"), "/a.json");
    await store.addOrReplace(pack("beta"), "/b.json");
    await store.addOrReplace(pack("gamma"), "/g.json");
    await store.addOrReplace(
      pack("beta", { label: "Beta v2", version: "2" }),
      "/b2.json",
    );
    const ids = store.snapshot().map((r) => r.pack.id);
    expect(ids).toEqual(["alpha", "beta", "gamma"]);
    expect(store.snapshot()[1].pack.label).toBe("Beta v2");
    expect(store.snapshot()[1].sourcePath).toBe("/b2.json");
  });

  test("drops records missing sourcePath (required field)", async () => {
    const notify = vi.fn();
    const io = memoryIo({
      mcpPresetPacks: [
        { recordId: "ok", pack: pack("good"), importedAt: 1, sourcePath: "/g.json" },
        { recordId: "bad", pack: pack("nopath"), importedAt: 2 },
      ],
    });
    const store = makeStore(io, notify);
    const snap = await store.load();
    expect(snap).toHaveLength(1);
    expect(snap[0].pack.id).toBe("good");
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][0]).toMatch(/nopath/);
  });
});
