import { describe, expect, it } from "vitest";
import {
  DEFAULT_SAFETY_SETTINGS,
  SafetySettingsStore,
} from "./SafetySettingsStore";
import type { PluginDataIO } from "../auth/TokenStore";

/**
 * Minimal in-memory PluginDataIO double mirroring the Obsidian
 * `Plugin.loadData()`/`saveData()` contract. Sufficient for testing
 * the top-level-merge persistence shape.
 */
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

describe("SafetySettingsStore — exposeRawFsTools (v0.3 Phase 1)", () => {
  it("defaults to false on a fresh load with no persisted data", async () => {
    const io = memoryIo(null);
    const store = new SafetySettingsStore(io);
    const snap = await store.load();
    expect(snap.exposeRawFsTools).toBe(false);
    expect(DEFAULT_SAFETY_SETTINGS.exposeRawFsTools).toBe(false);
  });

  it("defaults to false when the safety subtree omits the field (mergeWithDefaults)", async () => {
    const io = memoryIo({
      auth: { foo: "bar" },
      safety: {
        defaultMode: "auto-apply-with-undo",
        allowlist: ["Inbox/copilot"],
        // exposeRawFsTools intentionally omitted
      },
    });
    const store = new SafetySettingsStore(io);
    const snap = await store.load();
    expect(snap.exposeRawFsTools).toBe(false);
    // Other fields still load through mergeWithDefaults.
    expect(snap.defaultMode).toBe("auto-apply-with-undo");
    expect(snap.allowlist).toEqual(["Inbox/copilot"]);
  });

  it("rejects non-boolean exposeRawFsTools values and falls back to false", async () => {
    const io = memoryIo({
      safety: { exposeRawFsTools: "yes" },
    });
    const store = new SafetySettingsStore(io);
    const snap = await store.load();
    expect(snap.exposeRawFsTools).toBe(false);
  });

  it("persists exposeRawFsTools=true and round-trips through load()", async () => {
    const io = memoryIo(null);
    const writer = new SafetySettingsStore(io);
    await writer.load();
    await writer.setExposeRawFsTools(true);

    const reader = new SafetySettingsStore(io);
    const snap = await reader.load();
    expect(snap.exposeRawFsTools).toBe(true);
  });

  it("preserves unrelated top-level keys (auth) when persisting the toggle", async () => {
    const io = memoryIo({
      auth: { token: "abc", persistEnabled: true },
      safety: {
        defaultMode: "require-approval",
        allowlist: [],
      },
    });
    const store = new SafetySettingsStore(io);
    await store.load();
    await store.setExposeRawFsTools(true);

    const persisted = io.peek() as {
      auth?: unknown;
      safety?: { exposeRawFsTools?: unknown };
    };
    expect(persisted.auth).toEqual({ token: "abc", persistEnabled: true });
    expect(persisted.safety?.exposeRawFsTools).toBe(true);
  });

  it("snapshot() returns the toggle value (deep-ish copy independence)", async () => {
    const io = memoryIo(null);
    const store = new SafetySettingsStore(io);
    await store.load();
    await store.setExposeRawFsTools(true);
    const snap1 = store.snapshot();
    const snap2 = store.snapshot();
    expect(snap1.exposeRawFsTools).toBe(true);
    expect(snap2.exposeRawFsTools).toBe(true);
    // Mutating one snapshot's allowlist doesn't leak across snapshots,
    // but the boolean is a primitive so this just verifies no aliasing.
    snap1.allowlist.push("X");
    expect(snap2.allowlist).not.toContain("X");
  });

  it("subscribe() fires when exposeRawFsTools changes", async () => {
    const io = memoryIo(null);
    const store = new SafetySettingsStore(io);
    await store.load();
    const seen: boolean[] = [];
    store.subscribe((s) => seen.push(s.exposeRawFsTools));
    await store.setExposeRawFsTools(true);
    await store.setExposeRawFsTools(false);
    expect(seen).toEqual([true, false]);
  });
});
