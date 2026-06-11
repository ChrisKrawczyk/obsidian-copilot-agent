// v0.3 Phase 4: ConversationRuntime helpers.
//
// `ConversationRuntime` itself is an interface — its implementations
// are produced by the factory closure in `main.ts`. These tests cover
// the two pure helpers exported alongside it (`hydrateChatState`,
// `makeRuntimeJournal`) and the cross-runtime isolation invariant
// that the per-conversation architecture is meant to deliver: tools
// bound to runtime A's journal must record into A and never into B.

import { describe, expect, test, vi } from "vitest";
import {
  hydrateChatState,
  makeRuntimeJournal,
} from "./ConversationRuntime";
import type {
  PersistedMessage,
  PersistedUndoEntry,
} from "../persistence/PersistedShape";
import type { UndoJournalVault } from "./UndoJournal";

function makeVault(): UndoJournalVault {
  const files = new Map<string, string>();
  return {
    getFileByPath: (p) => (files.has(p) ? { path: p } : null),
    cachedRead: async (file) =>
      files.get((file as { path: string }).path) ?? "",
    create: async (p, c) => {
      files.set(p, c);
      return { path: p };
    },
    modify: async (file, c) => {
      files.set((file as { path: string }).path, c);
      return file;
    },
    trash: async (file) => {
      files.delete((file as { path: string }).path);
    },
  };
}

describe("hydrateChatState", () => {
  test("empty / undefined input yields a fresh ChatState", () => {
    const a = hydrateChatState();
    const b = hydrateChatState([]);
    expect(a.getMessages()).toEqual([]);
    expect(b.getMessages()).toEqual([]);
  });

  test("seeds messages with persisted ids and statuses", () => {
    const seed: PersistedMessage[] = [
      {
        id: "m1",
        role: "user",
        content: "hi",
        status: "complete",
        createdAt: 1,
      },
      {
        id: "m2",
        role: "assistant",
        content: "hello",
        status: "interrupted",
        createdAt: 2,
      },
    ];
    const s = hydrateChatState(seed);
    expect(s.getMessages().map((m) => m.id)).toEqual(["m1", "m2"]);
    expect(s.getMessages()[1].status).toBe("interrupted");
  });

  test("appending after hydration uses a NEW id past the persisted max", () => {
    const seed: PersistedMessage[] = [
      {
        id: "m7",
        role: "user",
        content: "x",
        status: "complete",
        createdAt: 1,
      },
    ];
    const s = hydrateChatState(seed);
    const newId = s.append({ role: "assistant", content: "y" });
    // Counter starts past 7 → first new id is m8
    expect(newId).toBe("m8");
  });
});

describe("makeRuntimeJournal", () => {
  test("hydrates from persisted entries without firing the persist callback", () => {
    const vault = makeVault();
    const persist = vi.fn();
    const seed: PersistedUndoEntry[] = [
      {
        id: "undo-seed-1",
        kind: "create",
        scope: "vault",
        path: "a.md",
        after: "x",
        // v0.3 Phase 6: makeRuntimeJournal now applies a defensive TTL
        // backstop (UNDO_TTL_MS). Use `now()` so the seed survives.
        recordedAt: Date.now(),
      },
    ];
    const j = makeRuntimeJournal(vault, seed, { onJournalOp: persist });
    expect(j.get("undo-seed-1")).toBeDefined();
    expect(persist).not.toHaveBeenCalled();
  });

  test("forwards record() into the per-runtime persistAdapter as 'add'", () => {
    const vault = makeVault();
    const persist = vi.fn();
    const j = makeRuntimeJournal(vault, undefined, { onJournalOp: persist });
    const e = j.record({
      kind: "create",
      scope: "vault",
      path: "a.md",
      after: "x",
    });
    expect(persist).toHaveBeenCalledTimes(1);
    expect(persist.mock.calls[0][0]).toBe("add");
    expect(persist.mock.calls[0][1].id).toBe(e.id);
  });

  test("two runtimes get isolated journals (record on A does NOT appear on B)", () => {
    const vault = makeVault();
    const persistA = vi.fn();
    const persistB = vi.fn();
    const a = makeRuntimeJournal(vault, undefined, { onJournalOp: persistA });
    const b = makeRuntimeJournal(vault, undefined, { onJournalOp: persistB });

    const eA = a.record({
      kind: "create",
      scope: "vault",
      path: "a.md",
      after: "x",
    });

    expect(persistA).toHaveBeenCalledTimes(1);
    expect(persistB).not.toHaveBeenCalled();
    expect(a.get(eA.id)).toBeDefined();
    expect(b.get(eA.id)).toBeUndefined();
  });

  test("works without a persist adapter (legacy in-memory only)", () => {
    const vault = makeVault();
    const j = makeRuntimeJournal(vault);
    const e = j.record({
      kind: "create",
      scope: "vault",
      path: "a.md",
      after: "x",
    });
    expect(j.get(e.id)).toBeDefined();
  });
});
