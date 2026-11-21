import { describe, expect, test } from "vitest";
import {
  MAX_BATCH_SNAPSHOT_BYTES,
  UndoJournal,
  batchSnapshotBytes,
  type UndoBatchItem,
  type UndoEntry,
  type UndoJournalPersistOp,
  type UndoJournalVault,
} from "./UndoJournal";
import type { PersistedUndoEntry } from "../persistence/PersistedShape";

type FakeFile = { path: string };

function makeWorld() {
  const files = new Map<string, string>();
  const folders = new Set<string>();
  let failModifyOn: string | null = null;
  const vault: UndoJournalVault = {
    getFileByPath: (p) => (files.has(p) ? ({ path: p } satisfies FakeFile) : null),
    getAbstractFileByPath: (p) =>
      files.has(p) || folders.has(p) ? ({ path: p } satisfies FakeFile) : null,
    cachedRead: async (f) => files.get((f as FakeFile).path) ?? "",
    create: async (p, c) => {
      if (files.has(p)) throw new Error(`exists: ${p}`);
      files.set(p, c);
      return { path: p };
    },
    modify: async (f, c) => {
      const p = (f as FakeFile).path;
      if (failModifyOn === p) throw new Error(`disk full: ${p}`);
      files.set(p, c);
      return f;
    },
    trash: async (f) => {
      files.delete((f as FakeFile).path);
    },
  };
  const moves: Array<[string, string]> = [];
  const moveItem = async (from: string, to: string): Promise<void> => {
    if (!files.has(from)) throw new Error(`missing: ${from}`);
    if (files.has(to) && from.toLowerCase() !== to.toLowerCase()) throw new Error(`exists: ${to}`);
    const c = files.get(from)!;
    files.delete(from);
    files.set(to, c);
    moves.push([from, to]);
  };
  return {
    vault,
    files,
    moves,
    moveItem,
    failModify: (p: string | null) => {
      failModifyOn = p;
    },
  };
}

function journal(w: ReturnType<typeof makeWorld>, persisted?: Array<[UndoJournalPersistOp, UndoEntry]>) {
  return new UndoJournal({
    vault: w.vault,
    moveItem: w.moveItem,
    persist: persisted ? (op, e) => persisted.push([op, e]) : undefined,
  });
}

function recordBatch(j: UndoJournal, items: UndoBatchItem[], label = "batch") {
  const first = items[0];
  return j.record({
    kind: "batch",
    scope: "vault",
    path: first.op === "move" ? first.to : first.path,
    items,
    label,
  });
}

describe("UndoJournal batch entries", () => {
  test("an edit that lands while Undo runs aborts the batch instead of being overwritten", async () => {
    const w = makeWorld();
    w.files.set("a.md", "A2");
    w.files.set("b.md", "B2");
    const read = w.vault.cachedRead!;
    let reads = 0;
    w.vault.cachedRead = async (f) => {
      const out = await read(f);
      if (++reads === 2) w.files.set("a.md", "user edit");
      return out;
    };
    const j = journal(w);
    const e = recordBatch(j, [
      { op: "modify", path: "a.md", before: "A1", after: "A2" },
      { op: "modify", path: "b.md", before: "B1", after: "B2" },
    ]);
    const out = await j.undo(e.id);
    expect(out.ok).toBe(false);
    expect(out.reason).toMatch(/a\.md" changed while undoing/);
    expect(w.files.get("a.md")).toBe("user edit");
    expect(w.files.get("b.md")).toBe("B2");
    expect(j.get(e.id)?.undone).toBeFalsy();
  });

  test("uses vault.process for guarded reverts when available", async () => {
    const w = makeWorld();
    w.files.set("a.md", "A2");
    const processed: string[] = [];
    w.vault.process = async (f, fn) => {
      const p = (f as FakeFile).path;
      processed.push(p);
      const next = fn(w.files.get(p) ?? "");
      w.files.set(p, next);
      return next;
    };
    const j = journal(w);
    const e = recordBatch(j, [{ op: "modify", path: "a.md", before: "A1", after: "A2" }]);
    expect((await j.undo(e.id)).ok).toBe(true);
    expect(processed).toEqual(["a.md"]);
    expect(w.files.get("a.md")).toBe("A1");
  });

  test("case-only move undo treats a distinct file at the original spelling as occupied", async () => {
    const w = makeWorld();
    w.files.set("A.md", "moved");
    w.files.set("a.md", "someone else");
    const j = journal(w);
    const e = recordBatch(j, [{ op: "move", from: "a.md", to: "A.md" }]);
    const out = await j.undo(e.id);
    expect(out.ok).toBe(false);
    expect(out.divergentPaths).toEqual(["a.md"]);
    const forced = await j.undo(e.id, { force: true });
    expect(forced).toMatchObject({ ok: true, skippedPaths: ["a.md"] });
    expect(w.files.get("a.md")).toBe("someone else");
    expect(w.moves).toEqual([]);
  });

  test("reverts every modify item atomically", async () => {
    const w = makeWorld();
    w.files.set("a.md", "A2");
    w.files.set("b.md", "B2");
    const j = journal(w);
    const e = recordBatch(j, [
      { op: "modify", path: "a.md", before: "A1", after: "A2" },
      { op: "modify", path: "b.md", before: "B1", after: "B2" },
    ]);
    const out = await j.undo(e.id);
    expect(out).toEqual({ ok: true, divergence: "ok" });
    expect(w.files.get("a.md")).toBe("A1");
    expect(w.files.get("b.md")).toBe("B1");
    expect(j.get(e.id)?.undone).toBe(true);
  });

  test("divergence on any item reverts nothing and names every divergent path", async () => {
    const w = makeWorld();
    w.files.set("a.md", "A2");
    w.files.set("b.md", "user edit");
    const j = journal(w);
    const e = recordBatch(j, [
      { op: "modify", path: "a.md", before: "A1", after: "A2" },
      { op: "modify", path: "b.md", before: "B1", after: "B2" },
      { op: "modify", path: "c.md", before: "C1", after: "C2" },
    ]);
    const out = await j.undo(e.id);
    expect(out.ok).toBe(false);
    expect(out.divergence).toBe("modified");
    expect(out.divergentPaths).toEqual(["b.md", "c.md"]);
    expect(w.files.get("a.md")).toBe("A2");
    expect(j.get(e.id)?.undone).toBeFalsy();
  });

  test("force reverts every item including divergent and missing ones", async () => {
    const w = makeWorld();
    w.files.set("a.md", "A2");
    w.files.set("b.md", "user edit");
    const j = journal(w);
    const e = recordBatch(j, [
      { op: "modify", path: "a.md", before: "A1", after: "A2" },
      { op: "modify", path: "b.md", before: "B1", after: "B2" },
      { op: "modify", path: "c.md", before: "C1", after: "C2" },
    ]);
    const out = await j.undo(e.id, { force: true });
    expect(out.ok).toBe(true);
    expect([w.files.get("a.md"), w.files.get("b.md"), w.files.get("c.md")]).toEqual(["A1", "B1", "C1"]);
  });

  test("create and delete items revert and report divergence", async () => {
    const w = makeWorld();
    w.files.set("new.md", "fresh");
    const j = journal(w);
    const e = recordBatch(j, [
      { op: "create", path: "new.md", after: "fresh" },
      { op: "delete", path: "gone.md", before: "old" },
    ]);
    expect((await j.undo(e.id)).ok).toBe(true);
    expect(w.files.has("new.md")).toBe(false);
    expect(w.files.get("gone.md")).toBe("old");

    const w2 = makeWorld();
    w2.files.set("gone.md", "someone recreated");
    const j2 = journal(w2);
    const e2 = recordBatch(j2, [{ op: "delete", path: "gone.md", before: "old" }]);
    const out = await j2.undo(e2.id);
    expect(out.divergence).toBe("existed");
    expect(out.divergentPaths).toEqual(["gone.md"]);
  });

  test("move items move back in reverse order", async () => {
    const w = makeWorld();
    w.files.set("Meetings/A.md", "a");
    w.files.set("Meetings/B.md", "b");
    const j = journal(w);
    const e = recordBatch(j, [
      { op: "move", from: "Inbox/A.md", to: "Meetings/A.md" },
      { op: "move", from: "Inbox/B.md", to: "Meetings/B.md" },
    ]);
    expect((await j.undo(e.id)).ok).toBe(true);
    expect(w.moves).toEqual([
      ["Meetings/B.md", "Inbox/B.md"],
      ["Meetings/A.md", "Inbox/A.md"],
    ]);
    expect(w.files.get("Inbox/A.md")).toBe("a");
  });

  test("case-only rename is not treated as an occupied origin", async () => {
    const w = makeWorld();
    w.files.set("A.md", "a");
    const j = journal(w);
    const e = recordBatch(j, [{ op: "move", from: "a.md", to: "A.md" }]);
    expect((await j.undo(e.id)).ok).toBe(true);
    expect(w.files.get("a.md")).toBe("a");
  });

  test("forced move undo skips items whose origin is occupied or whose target is gone", async () => {
    const w = makeWorld();
    w.files.set("Meetings/A.md", "a");
    w.files.set("Inbox/A.md", "a different file");
    w.files.set("Meetings/C.md", "c");
    const j = journal(w);
    const e = recordBatch(j, [
      { op: "move", from: "Inbox/A.md", to: "Meetings/A.md" },
      { op: "move", from: "Inbox/B.md", to: "Meetings/B.md" },
      { op: "move", from: "Inbox/C.md", to: "Meetings/C.md" },
    ]);
    const first = await j.undo(e.id);
    expect(first.ok).toBe(false);
    expect(first.divergentPaths).toEqual(["Inbox/A.md", "Meetings/B.md"]);
    const forced = await j.undo(e.id, { force: true });
    expect(forced.ok).toBe(true);
    expect(forced.skippedPaths).toEqual(["Meetings/B.md", "Inbox/A.md"]);
    expect(w.files.get("Inbox/A.md")).toBe("a different file");
    expect(w.files.get("Meetings/A.md")).toBe("a");
    expect(w.files.get("Inbox/C.md")).toBe("c");
  });

  test("move undo without a configured mover fails without changing anything", async () => {
    const w = makeWorld();
    w.files.set("b.md", "B2");
    w.files.set("Meetings/A.md", "a");
    const j = new UndoJournal({ vault: w.vault });
    const e = recordBatch(j, [
      { op: "move", from: "Inbox/A.md", to: "Meetings/A.md" },
      { op: "modify", path: "b.md", before: "B1", after: "B2" },
    ]);
    const writes: string[] = [];
    const modify = w.vault.modify!;
    w.vault.modify = async (f, c) => {
      writes.push((f as FakeFile).path);
      return modify(f, c);
    };
    const out = await j.undo(e.id);
    expect(out.ok).toBe(false);
    expect(out.reason).toMatch(/Moving files back is not available/);
    expect(writes).toEqual([]);
    expect(w.files.get("b.md")).toBe("B2");
    expect(j.get(e.id)?.undone).toBeFalsy();
  });

  test("a write failure mid-undo restores reverted items to their observed state", async () => {
    const w = makeWorld();
    w.files.set("a.md", "A2");
    w.files.set("b.md", "user edit of b");
    w.files.set("c.md", "C2");
    const j = journal(w);
    const e = recordBatch(j, [
      { op: "modify", path: "a.md", before: "A1", after: "A2" },
      { op: "modify", path: "b.md", before: "B1", after: "B2" },
      { op: "modify", path: "c.md", before: "C1", after: "C2" },
    ]);
    w.failModify("a.md");
    const out = await j.undo(e.id, { force: true });
    expect(out.ok).toBe(false);
    expect(out.reason).toMatch(/disk full/);
    expect(w.files.get("a.md")).toBe("A2");
    expect(w.files.get("b.md")).toBe("user edit of b");
    expect(w.files.get("c.md")).toBe("C2");
    expect(j.get(e.id)?.undone).toBeFalsy();
    w.failModify(null);
    expect((await j.undo(e.id, { force: true })).ok).toBe(true);
  });

  test("a batch counts as one entry toward the cap and persists its items", async () => {
    const w = makeWorld();
    const persisted: Array<[UndoJournalPersistOp, UndoEntry]> = [];
    const j = new UndoJournal({ vault: w.vault, maxEntries: 2, persist: (op, e) => persisted.push([op, e]) });
    j.record({ kind: "modify", scope: "vault", path: "x.md", before: "1", after: "2" });
    const b = recordBatch(
      j,
      [
        { op: "modify", path: "a.md", before: "A1", after: "A2" },
        { op: "modify", path: "b.md", before: "B1", after: "B2" },
      ],
      "2 tasks in 2 notes",
    );
    expect(persisted.filter(([op]) => op === "add")).toHaveLength(2);
    const added = persisted.find(([op, e]) => op === "add" && e.id === b.id)![1];
    expect(added.items).toHaveLength(2);
    expect(added.label).toBe("2 tasks in 2 notes");
    j.record({ kind: "modify", scope: "vault", path: "y.md", before: "1", after: "2" });
    expect(j.get(b.id)).toBeDefined();
    expect(persisted.filter(([op]) => op === "evict")).toHaveLength(1);
  });

  test("batch entries survive a reload and still undo every item", async () => {
    const w = makeWorld();
    w.files.set("a.md", "A2");
    w.files.set("Meetings/M.md", "m");
    const stored: PersistedUndoEntry[] = [
      {
        id: "undo-7",
        kind: "batch",
        scope: "vault",
        path: "a.md",
        recordedAt: Date.now(),
        label: "2 items",
        items: [
          { op: "modify", path: "a.md", before: "A1", after: "A2" },
          { op: "move", from: "Inbox/M.md", to: "Meetings/M.md" },
        ],
      },
    ];
    const j = new UndoJournal({ vault: w.vault, moveItem: w.moveItem, initialEntries: stored });
    expect(j.get("undo-7")?.items).toHaveLength(2);
    expect(j.get("undo-7")?.label).toBe("2 items");
    expect((await j.undo("undo-7")).ok).toBe(true);
    expect(w.files.get("a.md")).toBe("A1");
    expect(w.files.get("Inbox/M.md")).toBe("m");
  });

  test("TTL-expired batch entries are evicted with their items", () => {
    const w = makeWorld();
    const evicted: UndoEntry[] = [];
    new UndoJournal({
      vault: w.vault,
      now: () => 10_000,
      loadOptions: { ttlMs: 1000 },
      persist: (op, e) => {
        if (op === "evict") evicted.push(e);
      },
      initialEntries: [
        {
          id: "undo-1",
          kind: "batch",
          scope: "vault",
          path: "a.md",
          recordedAt: 1,
          items: [{ op: "modify", path: "a.md", before: "1", after: "2" }],
        },
      ],
    });
    expect(evicted[0].items).toHaveLength(1);
  });

  test("batchSnapshotBytes counts stored content in UTF-8", () => {
    expect(
      batchSnapshotBytes([
        { op: "modify", path: "a", before: "ab", after: "é" },
        { op: "create", path: "b", after: "xyz" },
        { op: "delete", path: "c", before: "q" },
        { op: "move", from: "d", to: "e" },
      ]),
    ).toBe(2 + 2 + 3 + 1);
    expect(MAX_BATCH_SNAPSHOT_BYTES).toBe(2 * 1024 * 1024);
  });
});
