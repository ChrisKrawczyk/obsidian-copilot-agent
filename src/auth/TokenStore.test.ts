import { describe, expect, test } from "vitest";
import { TokenStore, type PluginDataIO } from "./TokenStore";

function makeIO(initial: unknown = {}) {
  let blob: unknown = initial;
  const io: PluginDataIO = {
    loadData: async () => blob,
    saveData: async (d) => {
      blob = d;
    },
  };
  return {
    io,
    get blob() {
      return blob as Record<string, unknown>;
    },
  };
}

describe("TokenStore", () => {
  test("load() returns defaults for empty blob", async () => {
    const { io } = makeIO(null);
    const store = new TokenStore(io);
    const snap = await store.load();
    expect(snap.token).toBeNull();
    expect(snap.persistEnabled).toBe(true);
  });

  test("load() reads persisted shape", async () => {
    const { io } = makeIO({
      auth: { token: "gho_x" },
      settings: { persistEnabled: false },
    });
    const store = new TokenStore(io);
    const snap = await store.load();
    expect(snap.token).toBe("gho_x");
    expect(snap.persistEnabled).toBe(false);
  });

  test("setToken writes to disk when persistEnabled is true", async () => {
    const ctx = makeIO({});
    const store = new TokenStore(ctx.io);
    await store.load();
    await store.setToken("gho_new");
    expect((ctx.blob.auth as Record<string, unknown>).token).toBe("gho_new");
  });

  test("setToken stores null on disk when persistEnabled is false", async () => {
    const ctx = makeIO({
      settings: { persistEnabled: false },
      auth: { token: "stale" },
    });
    const store = new TokenStore(ctx.io);
    await store.load();
    await store.setToken("gho_new");
    expect((ctx.blob.auth as Record<string, unknown>).token).toBeNull();
  });

  test("setPersistEnabled(false) immediately wipes the on-disk token", async () => {
    const ctx = makeIO({
      settings: { persistEnabled: true },
      auth: { token: "gho_secret" },
    });
    const store = new TokenStore(ctx.io);
    await store.load();
    await store.setPersistEnabled(false);
    expect((ctx.blob.auth as Record<string, unknown>).token).toBeNull();
    expect((ctx.blob.settings as Record<string, unknown>).persistEnabled).toBe(
      false,
    );
  });

  test("concurrent setToken calls serialise and last write wins", async () => {
    const ctx = makeIO({});
    const store = new TokenStore(ctx.io);
    await store.load();
    await Promise.all([
      store.setToken("a"),
      store.setToken("b"),
      store.setToken("c"),
    ]);
    expect((ctx.blob.auth as Record<string, unknown>).token).toBe("c");
  });

  test("flush merges against the latest on-disk blob (no clobber)", async () => {
    const ctx = makeIO({});
    const store = new TokenStore(ctx.io);
    await store.load();
    // External writer scribbles a new field while we're between writes.
    await ctx.io.saveData({
      auth: { token: "external" },
      otherKey: "preserve me",
    });
    await store.setToken("ours");
    expect((ctx.blob as Record<string, unknown>).otherKey).toBe("preserve me");
    expect((ctx.blob.auth as Record<string, unknown>).token).toBe("ours");
  });

  test("mutating before load throws", async () => {
    const ctx = makeIO({});
    const store = new TokenStore(ctx.io);
    await expect(store.setToken("x")).rejects.toThrow(/must be called/);
  });
});
