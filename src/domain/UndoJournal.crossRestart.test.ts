import { describe, expect, test, vi } from "vitest";
import {
  UndoJournal,
  type UndoJournalVault,
  type PersistedUndoEntry,
} from "./UndoJournal";

/**
 * v0.3 Phase 6 (FR-012, FR-013, defensive TTL backstop): tests for
 * cross-restart behaviour. Owned in a separate file so the existing
 * single-process UndoJournal.test.ts stays focused on the hot path.
 */

type FakeFile = { path: string };

function makeFakeVault(initial: Record<string, string> = {}) {
  const files = new Map<string, string>(Object.entries(initial));
  const vault: UndoJournalVault = {
    getFileByPath: (p) =>
      files.has(p) ? ({ path: p } satisfies FakeFile) : null,
    read: async (file) => files.get((file as FakeFile).path) ?? "",
    cachedRead: async (file) => files.get((file as FakeFile).path) ?? "",
    create: async (p, c) => {
      if (files.has(p)) throw new Error(`exists: ${p}`);
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

describe("UndoJournal — TTL backstop on hydrate", () => {
  test("drops entries older than loadOptions.ttlMs and fires evict for each", () => {
    const { vault } = makeFakeVault();
    const persist = vi.fn();
    const now = 10_000_000;
    const seed: PersistedUndoEntry[] = [
      // fresh — kept
      {
        id: "fresh",
        kind: "create",
        scope: "vault",
        path: "a.md",
        after: "x",
        recordedAt: now - 1_000,
      },
      // stale — evicted
      {
        id: "stale",
        kind: "create",
        scope: "vault",
        path: "b.md",
        after: "y",
        recordedAt: now - 9_000,
      },
    ];
    const j = new UndoJournal({
      vault,
      initialEntries: seed,
      persist,
      loadOptions: { ttlMs: 5_000 },
      now: () => now,
    });
    expect(j.get("fresh")).toBeDefined();
    expect(j.get("stale")).toBeUndefined();
    expect(persist).toHaveBeenCalledTimes(1);
    expect(persist).toHaveBeenCalledWith(
      "evict",
      expect.objectContaining({ id: "stale" }),
    );
  });

  test("no TTL when loadOptions omitted (legacy hydration path)", () => {
    const { vault } = makeFakeVault();
    const persist = vi.fn();
    const seed: PersistedUndoEntry[] = [
      {
        id: "ancient",
        kind: "create",
        scope: "vault",
        path: "a.md",
        after: "x",
        recordedAt: 1,
      },
    ];
    const j = new UndoJournal({ vault, initialEntries: seed, persist });
    expect(j.get("ancient")).toBeDefined();
    expect(persist).not.toHaveBeenCalled();
  });
});

describe("UndoJournal — divergence detection", () => {
  test("create: file no longer exists -> divergence 'missing', force recreates the void (no-op)", async () => {
    const { vault, files } = makeFakeVault();
    const j = new UndoJournal(vault);
    await vault.create!("note.md", "hello");
    const e = j.record({
      kind: "create",
      scope: "vault",
      path: "note.md",
      after: "hello",
    });
    files.delete("note.md");

    const guarded = await j.undo(e.id);
    expect(guarded.ok).toBe(false);
    expect(guarded.divergence).toBe("missing");

    const forced = await j.undo(e.id, { force: true });
    expect(forced.ok).toBe(true);
    expect(forced.divergence).toBe("ok");
    expect(j.get(e.id)?.undone).toBe(true);
  });

  test("modify: file content differs -> divergence 'modified', force still reverts", async () => {
    const { vault, files } = makeFakeVault({ "note.md": "v2" });
    const j = new UndoJournal(vault);
    const e = j.record({
      kind: "modify",
      scope: "vault",
      path: "note.md",
      before: "v1",
      after: "v2",
    });
    files.set("note.md", "user-edit");

    const guarded = await j.undo(e.id);
    expect(guarded.ok).toBe(false);
    expect(guarded.divergence).toBe("modified");
    expect(files.get("note.md")).toBe("user-edit");

    const forced = await j.undo(e.id, { force: true });
    expect(forced.ok).toBe(true);
    expect(files.get("note.md")).toBe("v1");
  });

  test("modify: file deleted out of band -> 'missing', force recreates from before", async () => {
    const { vault, files } = makeFakeVault({ "note.md": "v2" });
    const j = new UndoJournal(vault);
    const e = j.record({
      kind: "modify",
      scope: "vault",
      path: "note.md",
      before: "v1",
      after: "v2",
    });
    files.delete("note.md");

    const guarded = await j.undo(e.id);
    expect(guarded.divergence).toBe("missing");

    const forced = await j.undo(e.id, { force: true });
    expect(forced.ok).toBe(true);
    expect(files.get("note.md")).toBe("v1");
  });

  test("delete: file already exists at path -> 'existed', force overwrites with snapshot", async () => {
    const { vault, files } = makeFakeVault();
    const j = new UndoJournal(vault);
    const e = j.record({
      kind: "delete",
      scope: "vault",
      path: "note.md",
      before: "original",
    });
    await vault.create!("note.md", "user-typed-new");

    const guarded = await j.undo(e.id);
    expect(guarded.ok).toBe(false);
    expect(guarded.divergence).toBe("existed");
    expect(files.get("note.md")).toBe("user-typed-new");

    const forced = await j.undo(e.id, { force: true });
    expect(forced.ok).toBe(true);
    expect(files.get("note.md")).toBe("original");
  });

  test("create: file modified out of band -> 'modified', force still deletes", async () => {
    const { vault, files } = makeFakeVault();
    const j = new UndoJournal(vault);
    await vault.create!("note.md", "agent-wrote");
    const e = j.record({
      kind: "create",
      scope: "vault",
      path: "note.md",
      after: "agent-wrote",
    });
    files.set("note.md", "user-edited");

    const guarded = await j.undo(e.id);
    expect(guarded.ok).toBe(false);
    expect(guarded.divergence).toBe("modified");
    expect(files.has("note.md")).toBe(true);

    const forced = await j.undo(e.id, { force: true });
    expect(forced.ok).toBe(true);
    expect(files.has("note.md")).toBe(false);
  });

  test("ok path returns divergence 'ok'", async () => {
    const { vault } = makeFakeVault({ "note.md": "v2" });
    const j = new UndoJournal(vault);
    const e = j.record({
      kind: "modify",
      scope: "vault",
      path: "note.md",
      before: "v1",
      after: "v2",
    });
    const out = await j.undo(e.id);
    expect(out.ok).toBe(true);
    expect(out.divergence).toBe("ok");
  });
});
