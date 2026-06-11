import { describe, expect, test, vi } from "vitest";
import { flushThenDispose, makeQuitFlushHandler } from "./lifecycle";

describe("flushThenDispose (Phase 5 onunload)", () => {
  test("flushes BEFORE disposing (ordering matters)", async () => {
    const calls: string[] = [];
    const store = {
      flushNow: vi.fn(async () => {
        calls.push("flush");
      }),
    };
    const manager = {
      disposeAll: vi.fn(async () => {
        calls.push("dispose");
      }),
    };
    await flushThenDispose(store, manager);
    expect(calls).toEqual(["flush", "dispose"]);
    expect(store.flushNow).toHaveBeenCalledTimes(1);
    expect(manager.disposeAll).toHaveBeenCalledTimes(1);
  });

  test("still disposes even if flush throws", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const store = { flushNow: vi.fn(async () => { throw new Error("flush boom"); }) };
    const manager = { disposeAll: vi.fn(async () => {}) };
    await flushThenDispose(store, manager);
    expect(manager.disposeAll).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  test("survives a throwing dispose without leaking the error", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const store = { flushNow: vi.fn(async () => {}) };
    const manager = { disposeAll: vi.fn(async () => { throw new Error("dispose boom"); }) };
    await expect(flushThenDispose(store, manager)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  test("no-ops when both inputs are null", async () => {
    await expect(flushThenDispose(null, null)).resolves.toBeUndefined();
  });

  test("flushes when manager is null", async () => {
    const store = { flushNow: vi.fn(async () => {}) };
    await flushThenDispose(store, null);
    expect(store.flushNow).toHaveBeenCalledTimes(1);
  });
});

describe("makeQuitFlushHandler (Phase 5 workspace.on('quit'))", () => {
  test("reads the store fresh each tick", async () => {
    let store: { flushNow: ReturnType<typeof vi.fn> } | null = null;
    const handler = makeQuitFlushHandler(() => store);

    // First tick: no store yet → resolves without throwing.
    await expect(handler()).resolves.toBeUndefined();

    // Store appears → next tick flushes it.
    store = { flushNow: vi.fn(async () => {}) };
    await handler();
    expect(store.flushNow).toHaveBeenCalledTimes(1);

    // Store cleared again (plugin unloaded mid-quit) → no throw.
    store = null;
    await expect(handler()).resolves.toBeUndefined();
  });

  test("does NOT throw when flushNow throws (Obsidian awaits quit handlers)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const store = { flushNow: vi.fn(async () => { throw new Error("disk full"); }) };
    const handler = makeQuitFlushHandler(() => store);
    await expect(handler()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
