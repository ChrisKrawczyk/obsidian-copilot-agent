import { describe, test, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  analyzeMoveNote,
  MAX_MOVE_NOTE_ITEMS,
  moveNoteImpl,
  moveVaultItem,
  type MoveNoteDeps,
  type MoveNoteItem,
} from "./MoveNote";
import { UndoJournal, type UndoEntry } from "../domain/UndoJournal";

let vaultRoot: string;
beforeAll(() => {
  vaultRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "copilot-agent-movenote-")));
});
afterAll(() => {
  fs.rmSync(vaultRoot, { recursive: true, force: true });
});

interface Item {
  path: string;
  children?: unknown[];
}

interface World {
  items: Map<string, Item>;
  renames: Array<[string, string]>;
  failRenameTo: Set<string>;
}

function makeWorld(files: string[], folders: string[] = []): World {
  const items = new Map<string, Item>();
  for (const f of folders) items.set(f, { path: f, children: [] });
  for (const f of files) items.set(f, { path: f });
  return { items, renames: [], failRenameTo: new Set() };
}

function makeDeps(world: World): MoveNoteDeps & { entries: UndoEntry[]; journal: UndoJournal } {
  const vault = {
    adapter: { getBasePath: () => vaultRoot },
    getAbstractFileByPath: (p: string) => world.items.get(p) ?? null,
    getAllLoadedFiles: () => [...world.items.values()],
    createFolder: async (p: string) => {
      if (world.items.has(p)) throw new Error("Folder already exists.");
      world.items.set(p, { path: p, children: [] });
    },
  };
  const fileManager = {
    renameFile: async (file: unknown, to: string) => {
      const item = file as Item;
      if (world.failRenameTo.has(to)) throw new Error(`boom ${to}`);
      const from = item.path;
      if (world.items.has(to) && world.items.get(to) !== item) throw new Error("Destination exists.");
      const moved = [...world.items.entries()].filter(([k]) => k === from || k.startsWith(from + "/"));
      for (const [k] of moved) world.items.delete(k);
      for (const [k, v] of moved) {
        const next = to + k.slice(from.length);
        v.path = next;
        world.items.set(next, v);
      }
      world.renames.push([from, to]);
    },
  };
  const journal = new UndoJournal({
    vault: vault as unknown as ConstructorParameters<typeof UndoJournal>[0] & object,
    moveItem: (from, to) => moveVaultItem(vault, fileManager, from, to),
  } as ConstructorParameters<typeof UndoJournal>[0]);
  const entries: UndoEntry[] = [];
  const record = journal.record.bind(journal);
  journal.record = (e) => {
    const out = record(e);
    entries.push(out);
    return out;
  };
  return { vault, fileManager, configDir: ".obsidian", undoJournal: journal, journal, entries };
}

function reasons(world: World, items: MoveNoteItem[]): string[] {
  return analyzeMoveNote(items, makeDeps(world)).failures.map((f) => `${f.index}:${f.reason}`);
}

describe("moveNoteImpl", () => {
  test("moves a note into a new folder and records one batch entry", async () => {
    const world = makeWorld(["Inbox/A.md", "Inbox/B.md"], ["Inbox"]);
    const deps = makeDeps(world);
    const res = await moveNoteImpl(
      [
        { from: "Inbox/A.md", to: "Meetings/2026/A.md" },
        { from: "Inbox/B.md", to: "Inbox/B renamed.md" },
      ],
      deps,
    );
    expect(res.ok).toBe(true);
    expect(world.items.has("Meetings")).toBe(true);
    expect(world.items.has("Meetings/2026")).toBe(true);
    expect(world.items.has("Meetings/2026/A.md")).toBe(true);
    expect(world.items.has("Inbox/B renamed.md")).toBe(true);
    expect(deps.entries).toHaveLength(1);
    expect(deps.entries[0].kind).toBe("batch");
    expect(deps.entries[0].items).toEqual([
      { op: "move", from: "Inbox/A.md", to: "Meetings/2026/A.md" },
      { op: "move", from: "Inbox/B.md", to: "Inbox/B renamed.md" },
    ]);
    expect(deps.entries[0].path).toBe("Meetings/2026/A.md");
  });

  test("undo moves every item back in reverse order", async () => {
    const world = makeWorld(["a.md", "b.md"]);
    const deps = makeDeps(world);
    const res = await moveNoteImpl(
      [
        { from: "a.md", to: "x/a.md" },
        { from: "b.md", to: "x/b.md" },
      ],
      deps,
    );
    if (!res.ok) throw new Error(JSON.stringify(res));
    world.renames.length = 0;
    const outcome = await deps.journal.undo(res.undoId);
    expect(outcome.ok).toBe(true);
    expect(world.renames).toEqual([
      ["x/b.md", "b.md"],
      ["x/a.md", "a.md"],
    ]);
    expect(world.items.has("a.md") && world.items.has("b.md")).toBe(true);
  });

  test("undo recreates the original parent folder if it was removed", async () => {
    const world = makeWorld(["Inbox/a.md"], ["Inbox"]);
    const deps = makeDeps(world);
    const res = await moveNoteImpl([{ from: "Inbox/a.md", to: "a.md" }], deps);
    if (!res.ok) throw new Error(JSON.stringify(res));
    world.items.delete("Inbox");
    expect((await deps.journal.undo(res.undoId)).ok).toBe(true);
    expect(world.items.get("Inbox")?.children).toBeDefined();
    expect(world.items.has("Inbox/a.md")).toBe(true);
  });

  test("moves a folder with its contents", async () => {
    const world = makeWorld(["Old/n.md", "Old/sub/m.md"], ["Old", "Old/sub"]);
    const deps = makeDeps(world);
    const res = await moveNoteImpl([{ from: "Old", to: "Archive/Old" }], deps);
    expect(res.ok && res.moved[0].kind).toBe("folder");
    expect(world.items.has("Archive/Old/sub/m.md")).toBe(true);
    expect(world.items.has("Old")).toBe(false);
  });

  test("a mid-call failure moves completed items back and records nothing", async () => {
    const world = makeWorld(["a.md", "b.md", "c.md"]);
    world.failRenameTo.add("dest/c.md");
    const deps = makeDeps(world);
    const res = await moveNoteImpl(
      [
        { from: "a.md", to: "dest/a.md" },
        { from: "b.md", to: "dest/b.md" },
        { from: "c.md", to: "dest/c.md" },
      ],
      deps,
    );
    expect(res).toMatchObject({ ok: false, reason: "move_failed", index: 2, rolledBack: true });
    expect(["a.md", "b.md", "c.md"].every((p) => world.items.has(p))).toBe(true);
    expect(deps.entries).toHaveLength(0);
  });

  test("nothing moves when any item is invalid", async () => {
    const world = makeWorld(["a.md", "b.md", "taken.md"]);
    const deps = makeDeps(world);
    const res = await moveNoteImpl(
      [
        { from: "a.md", to: "z/a.md" },
        { from: "b.md", to: "taken.md" },
      ],
      deps,
    );
    expect(res).toMatchObject({ ok: false, reason: "validation_failed" });
    expect(world.renames).toHaveLength(0);
    expect(world.items.has("a.md")).toBe(true);
  });

  test("caps and empty input", async () => {
    const deps = makeDeps(makeWorld(["a.md"]));
    expect(await moveNoteImpl([], deps)).toEqual({ ok: false, reason: "no_items" });
    const many = Array.from({ length: MAX_MOVE_NOTE_ITEMS + 1 }, (_, i) => ({ from: `n${i}.md`, to: `m${i}.md` }));
    expect(await moveNoteImpl(many, deps)).toMatchObject({ ok: false, reason: "too_many_items" });
  });

  test("reports unavailable without a file manager", async () => {
    const deps = makeDeps(makeWorld(["a.md"]));
    const res = await moveNoteImpl([{ from: "a.md", to: "b.md" }], { ...deps, fileManager: undefined });
    expect(res).toMatchObject({ ok: false, reason: "unavailable" });
  });
});

describe("analyzeMoveNote validation", () => {
  test("target exists, including a case-insensitive match", () => {
    const world = makeWorld(["Foo.md", "bar/Foo.md", "x.md"], ["bar"]);
    expect(reasons(world, [{ from: "x.md", to: "bar/foo.md" }])).toEqual(["0:target_exists"]);
    expect(reasons(world, [{ from: "x.md", to: "Foo.md" }])).toEqual(["0:target_exists"]);
  });

  test("a case-only rename of the same item is allowed", () => {
    const world = makeWorld(["Foo.md"]);
    expect(reasons(world, [{ from: "Foo.md", to: "foo.md" }])).toEqual([]);
  });

  test("missing source, same path, bad path", () => {
    const world = makeWorld(["a.md"]);
    expect(
      reasons(world, [
        { from: "nope.md", to: "x.md" },
        { from: "a.md", to: "a.md" },
        { from: "a.md", to: "../out.md" },
        { from: "", to: "b.md" },
      ]),
    ).toEqual(["0:not_found", "1:same_path", "2:invalid_path", "3:invalid_item"]);
  });

  test("duplicates, chained moves and overlapping folder moves", () => {
    const world = makeWorld(["a.md", "b.md", "F/n.md"], ["F"]);
    expect(
      reasons(world, [
        { from: "a.md", to: "x.md" },
        { from: "a.md", to: "y.md" },
      ]),
    ).toEqual(["1:duplicate_source"]);
    expect(
      reasons(world, [
        { from: "a.md", to: "x.md" },
        { from: "b.md", to: "x.md" },
      ]),
    ).toEqual(["1:duplicate_destination"]);
    expect(
      reasons(world, [
        { from: "a.md", to: "c.md" },
        { from: "b.md", to: "a.md" },
      ]),
    ).toEqual(["1:target_exists"]);
    expect(
      reasons(world, [
        { from: "F", to: "G" },
        { from: "F/n.md", to: "n.md" },
      ]),
    ).toEqual(["1:overlapping_items"]);
  });

  test("a folder can't move into its own subtree", () => {
    const world = makeWorld(["F/n.md"], ["F"]);
    expect(reasons(world, [{ from: "F", to: "F/inner/F" }])).toEqual(["0:into_own_subtree"]);
  });

  test("config dir is off limits in both directions", () => {
    const world = makeWorld([".obsidian/app.json", "a.md"], [".obsidian"]);
    expect(
      reasons(world, [
        { from: ".obsidian/app.json", to: "app.json" },
        { from: "a.md", to: ".obsidian/a.md" },
        { from: ".obsidian", to: "cfg" },
      ]),
    ).toEqual(["0:config_dir", "1:config_dir", "2:config_dir"]);
  });

  test("a destination folder that exists with different case is rejected up front", () => {
    const world = makeWorld(["a.md", "Notes/b.md"], ["Notes"]);
    expect(reasons(world, [{ from: "a.md", to: "notes/sub/a.md" }])).toEqual(["0:folder_case_mismatch"]);
    expect(reasons(world, [{ from: "a.md", to: "Notes/sub/a.md" }])).toEqual([]);
  });

  test("a destination under an existing file is rejected", () => {
    const world = makeWorld(["a.md", "file"]);
    expect(reasons(world, [{ from: "a.md", to: "file/a.md" }])).toEqual(["0:parent_is_file"]);
  });
});
