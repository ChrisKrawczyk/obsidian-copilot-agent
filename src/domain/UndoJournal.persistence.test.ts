// v0.3 Phase 4: persistence wiring on UndoJournal.
//
// These tests pin the contract the manager relies on:
//  - `persist("add", entry)` fires after every record() append.
//  - `persist("evict", entry)` fires when the cap forces eviction,
//    BEFORE the new entry is stored.
//  - `persist("mark-undone", entry)` fires after a successful undo().
//  - Subscriber throws don't corrupt the journal.
//  - `initialEntries` hydrate without re-firing persist callbacks.
//  - Pre-v0.3 callers passing the bare vault keep working unchanged.

import { describe, expect, test } from "vitest";
import {
  UndoJournal,
  type UndoEntry,
  type UndoJournalPersistOp,
  type UndoJournalVault,
} from "./UndoJournal";
import type { PersistedUndoEntry } from "../persistence/PersistedShape";

type FakeFile = { path: string };

function makeFakeVault() {
  const files = new Map<string, string>();
  const vault: UndoJournalVault = {
    getFileByPath: (p) =>
      files.has(p) ? ({ path: p } satisfies FakeFile) : null,
    read: async (file) => files.get((file as FakeFile).path) ?? "",
    cachedRead: async (file) => files.get((file as FakeFile).path) ?? "",
    create: async (p, c) => {
      files.set(p, c);
      return { path: p };
    },
    modify: async (file, c) => {
      files.set((file as FakeFile).path, c);
      return file;
    },
    trash: async (file) => {
      files.delete((file as FakeFile).path);
    },
  };
  return { vault, files };
}

interface PersistCall {
  op: UndoJournalPersistOp;
  entry: UndoEntry;
}

function makeRecorder() {
  const calls: PersistCall[] = [];
  const persist = (op: UndoJournalPersistOp, entry: UndoEntry) =>
    calls.push({ op, entry: { ...entry } });
  return { calls, persist };
}

describe("UndoJournal persistence wiring (Phase 4)", () => {
  test("legacy bare-vault constructor still works (no persist callback)", () => {
    const { vault } = makeFakeVault();
    const j = new UndoJournal(vault);
    const e = j.record({
      kind: "create",
      scope: "vault",
      path: "a.md",
      after: "x",
    });
    expect(e.id).toMatch(/^undo-\d+$/);
    expect(j.get(e.id)).toBeDefined();
  });

  test("record() fires persist('add', entry) with id + recordedAt populated", () => {
    const { vault } = makeFakeVault();
    const r = makeRecorder();
    const j = new UndoJournal({ vault, persist: r.persist });

    const e = j.record({
      kind: "modify",
      scope: "vault",
      path: "a.md",
      before: "old",
      after: "new",
    });

    expect(r.calls).toHaveLength(1);
    expect(r.calls[0].op).toBe("add");
    expect(r.calls[0].entry.id).toBe(e.id);
    expect(typeof r.calls[0].entry.recordedAt).toBe("number");
  });

  test("undo() fires persist('mark-undone', entry) on success", async () => {
    const { vault, files } = makeFakeVault();
    files.set("a.md", "old");
    const r = makeRecorder();
    const j = new UndoJournal({ vault, persist: r.persist });

    await vault.modify!({ path: "a.md" }, "new");
    files.set("a.md", "new");
    const e = j.record({
      kind: "modify",
      scope: "vault",
      path: "a.md",
      before: "old",
      after: "new",
    });

    const out = await j.undo(e.id);
    expect(out.ok).toBe(true);

    const undoneCalls = r.calls.filter((c) => c.op === "mark-undone");
    expect(undoneCalls).toHaveLength(1);
    expect(undoneCalls[0].entry.id).toBe(e.id);
    expect(undoneCalls[0].entry.undone).toBe(true);
  });

  test("undo() that fails its guard does NOT fire persist('mark-undone')", async () => {
    const { vault, files } = makeFakeVault();
    files.set("a.md", "drifted");
    const r = makeRecorder();
    const j = new UndoJournal({ vault, persist: r.persist });

    const e = j.record({
      kind: "modify",
      scope: "vault",
      path: "a.md",
      before: "old",
      after: "new",
    });

    const out = await j.undo(e.id);
    expect(out.ok).toBe(false);
    const undone = r.calls.filter((c) => c.op === "mark-undone");
    expect(undone).toHaveLength(0);
  });

  test("cap eviction fires persist('evict', entry) BEFORE the new add", () => {
    const { vault } = makeFakeVault();
    const r = makeRecorder();
    const j = new UndoJournal({
      vault,
      persist: r.persist,
      maxEntries: 2,
    });

    const a = j.record({ kind: "create", scope: "vault", path: "a", after: "1" });
    const b = j.record({ kind: "create", scope: "vault", path: "b", after: "2" });
    const c = j.record({ kind: "create", scope: "vault", path: "c", after: "3" });

    // Order should be: add(a), add(b), evict(a), add(c)
    expect(r.calls.map((x) => x.op)).toEqual([
      "add",
      "add",
      "evict",
      "add",
    ]);
    expect(r.calls[2].entry.id).toBe(a.id);
    expect(r.calls[3].entry.id).toBe(c.id);
    // b survives because it was the second-oldest.
    expect(j.get(a.id)).toBeUndefined();
    expect(j.get(b.id)).toBeDefined();
    expect(j.get(c.id)).toBeDefined();
  });

  test("initialEntries hydrate WITHOUT firing persist callbacks", () => {
    const { vault } = makeFakeVault();
    const r = makeRecorder();
    const seed: PersistedUndoEntry[] = [
      {
        id: "undo-seed-1",
        kind: "create",
        scope: "vault",
        path: "a.md",
        after: "x",
        recordedAt: 100,
      },
      {
        id: "undo-seed-2",
        kind: "modify",
        scope: "vault",
        path: "b.md",
        before: "old",
        after: "new",
        recordedAt: 200,
      },
    ];

    const j = new UndoJournal({
      vault,
      persist: r.persist,
      initialEntries: seed,
    });

    expect(r.calls).toHaveLength(0);
    expect(j.get("undo-seed-1")).toBeDefined();
    expect(j.get("undo-seed-2")).toBeDefined();
  });

  test("a throwing persist callback does NOT corrupt journal state", () => {
    const { vault } = makeFakeVault();
    const j = new UndoJournal({
      vault,
      persist: () => {
        throw new Error("boom");
      },
    });

    // Should not throw out of record().
    const e = j.record({
      kind: "create",
      scope: "vault",
      path: "a.md",
      after: "x",
    });
    expect(j.get(e.id)).toBeDefined();
  });

  test("hydrated entries are subject to the cap when more arrive than maxEntries", () => {
    const { vault } = makeFakeVault();
    const seed: PersistedUndoEntry[] = Array.from({ length: 5 }, (_, i) => ({
      id: `undo-seed-${i}`,
      kind: "create" as const,
      scope: "vault" as const,
      path: `f${i}.md`,
      after: String(i),
      recordedAt: i,
    }));
    const j = new UndoJournal({
      vault,
      maxEntries: 3,
      initialEntries: seed,
    });

    // Last 3 survive (oldest dropped first).
    expect(j.get("undo-seed-0")).toBeUndefined();
    expect(j.get("undo-seed-1")).toBeUndefined();
    expect(j.get("undo-seed-2")).toBeDefined();
    expect(j.get("undo-seed-3")).toBeDefined();
    expect(j.get("undo-seed-4")).toBeDefined();
  });
});
