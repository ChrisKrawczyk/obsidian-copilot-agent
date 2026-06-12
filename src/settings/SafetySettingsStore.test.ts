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
  it("defaults to true on a fresh load with no persisted data (v0.3: opt-out gating)", async () => {
    const io = memoryIo(null);
    const store = new SafetySettingsStore(io);
    const snap = await store.load();
    expect(snap.exposeRawFsTools).toBe(true);
    expect(DEFAULT_SAFETY_SETTINGS.exposeRawFsTools).toBe(true);
  });

  it("defaults to true when the safety subtree omits the field (mergeWithDefaults)", async () => {
    const io = memoryIo({
      auth: { foo: "bar" },
      safety: {
        defaultMode: "auto-apply-with-undo",
        allowlist: ["Inbox/copilot"],
        // exposeRawFsTools intentionally omitted — pre-v0.3 persisted
        // blobs (which never wrote this field) should land on the new
        // opt-out default rather than silently gating the agent.
      },
    });
    const store = new SafetySettingsStore(io);
    const snap = await store.load();
    expect(snap.exposeRawFsTools).toBe(true);
    // Other fields still load through mergeWithDefaults.
    expect(snap.defaultMode).toBe("auto-apply-with-undo");
    expect(snap.allowlist).toEqual(["Inbox/copilot"]);
  });

  it("rejects non-boolean exposeRawFsTools values and falls back to the default (true)", async () => {
    const io = memoryIo({
      safety: { exposeRawFsTools: "yes" },
    });
    const store = new SafetySettingsStore(io);
    const snap = await store.load();
    expect(snap.exposeRawFsTools).toBe(true);
  });

  it("persists exposeRawFsTools=false (user opt-out) and round-trips through load()", async () => {
    const io = memoryIo(null);
    const writer = new SafetySettingsStore(io);
    await writer.load();
    await writer.setExposeRawFsTools(false);

    const reader = new SafetySettingsStore(io);
    const snap = await reader.load();
    expect(snap.exposeRawFsTools).toBe(false);
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

// v0.4 (model-picker) Phase 2: defaultModelId persistence. Pinned to
// the per-conversation modelId metadata in Phase 1: this is the
// global default applied at NEW conversation creation only — existing
// conversations are never mutated.
describe("SafetySettingsStore — defaultModelId (v0.4 Phase 2)", () => {
  it("defaults to null (Auto sentinel) on a fresh load", async () => {
    const store = new SafetySettingsStore(memoryIo(null));
    const snap = await store.load();
    expect(snap.defaultModelId).toBeNull();
    expect(DEFAULT_SAFETY_SETTINGS.defaultModelId).toBeNull();
  });

  it("round-trips a string id through setDefaultModelId + load()", async () => {
    const io = memoryIo(null);
    const store = new SafetySettingsStore(io);
    await store.load();
    await store.setDefaultModelId("gpt-4.1");
    expect(store.snapshot().defaultModelId).toBe("gpt-4.1");

    // Reload through a fresh instance to confirm durability.
    const store2 = new SafetySettingsStore(io);
    const snap2 = await store2.load();
    expect(snap2.defaultModelId).toBe("gpt-4.1");
  });

  it("round-trips the null Auto sentinel verbatim", async () => {
    const io = memoryIo(null);
    const store = new SafetySettingsStore(io);
    await store.load();
    await store.setDefaultModelId("gpt-4.1");
    await store.setDefaultModelId(null);
    expect(store.snapshot().defaultModelId).toBeNull();

    const store2 = new SafetySettingsStore(io);
    const snap2 = await store2.load();
    expect(snap2.defaultModelId).toBeNull();
  });

  it("preserves sibling top-level keys (auth/conversations) on persist", async () => {
    const io = memoryIo({
      auth: { token: "tok" },
      conversations: ["sentinel"],
      schemaVersion: 2,
    });
    const store = new SafetySettingsStore(io);
    await store.load();
    await store.setDefaultModelId("gpt-4.1");
    const persisted = io.peek() as Record<string, unknown>;
    expect(persisted.auth).toEqual({ token: "tok" });
    expect(persisted.conversations).toEqual(["sentinel"]);
    expect(persisted.schemaVersion).toBe(2);
    expect(
      (persisted.safety as { defaultModelId: string | null }).defaultModelId,
    ).toBe("gpt-4.1");
  });

  it("treats non-string non-null persisted values as null on load (defensive)", async () => {
    const io = memoryIo({
      safety: {
        defaultModelId: 42,
      },
    });
    const store = new SafetySettingsStore(io);
    const snap = await store.load();
    expect(snap.defaultModelId).toBeNull();
  });

  it("treats empty-string persisted value as null (matches Settings dropdown convention)", async () => {
    const io = memoryIo({
      safety: {
        defaultModelId: "",
      },
    });
    const store = new SafetySettingsStore(io);
    const snap = await store.load();
    expect(snap.defaultModelId).toBeNull();
  });

  it("subscribe() fires when defaultModelId changes", async () => {
    const store = new SafetySettingsStore(memoryIo(null));
    await store.load();
    const seen: (string | null)[] = [];
    store.subscribe((s) => seen.push(s.defaultModelId));
    await store.setDefaultModelId("gpt-4.1");
    await store.setDefaultModelId(null);
    expect(seen).toEqual(["gpt-4.1", null]);
  });
});
