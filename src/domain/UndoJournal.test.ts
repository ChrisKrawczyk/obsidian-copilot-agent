import { describe, expect, test, beforeEach } from "vitest";
import { UndoJournal, type UndoJournalVault } from "./UndoJournal";

type FakeFile = { path: string };

function makeFakeVault() {
  const files = new Map<string, string>();
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

describe("UndoJournal", () => {
  let setup: ReturnType<typeof makeFakeVault>;
  let j: UndoJournal;

  beforeEach(() => {
    setup = makeFakeVault();
    j = new UndoJournal(setup.vault);
  });

  test("records and undoes a create", async () => {
    await setup.vault.create!("inbox/x.md", "hello");
    const e = j.record({
      kind: "create",
      scope: "vault",
      path: "inbox/x.md",
      after: "hello",
    });
    const r = await j.undo(e.id);
    expect(r.ok).toBe(true);
    expect(setup.files.has("inbox/x.md")).toBe(false);
  });

  test("records and undoes a modify", async () => {
    await setup.vault.create!("notes.md", "ORIGINAL");
    await setup.vault.modify!({ path: "notes.md" }, "CHANGED");
    const e = j.record({
      kind: "modify",
      scope: "vault",
      path: "notes.md",
      before: "ORIGINAL",
      after: "CHANGED",
    });
    const r = await j.undo(e.id);
    expect(r.ok).toBe(true);
    expect(setup.files.get("notes.md")).toBe("ORIGINAL");
  });

  test("records and undoes a delete", async () => {
    await setup.vault.create!("notes.md", "ORIGINAL");
    await setup.vault.trash!({ path: "notes.md" });
    const e = j.record({
      kind: "delete",
      scope: "vault",
      path: "notes.md",
      before: "ORIGINAL",
    });
    const r = await j.undo(e.id);
    expect(r.ok).toBe(true);
    expect(setup.files.get("notes.md")).toBe("ORIGINAL");
  });

  test("modify undo refuses when file has changed since the action", async () => {
    await setup.vault.create!("notes.md", "ORIGINAL");
    await setup.vault.modify!({ path: "notes.md" }, "CHANGED");
    const e = j.record({
      kind: "modify",
      scope: "vault",
      path: "notes.md",
      before: "ORIGINAL",
      after: "CHANGED",
    });
    // Simulate someone else editing the file.
    await setup.vault.modify!({ path: "notes.md" }, "USER-EDITED");
    const r = await j.undo(e.id);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/changed/i);
    expect(setup.files.get("notes.md")).toBe("USER-EDITED");
  });

  test("create undo refuses when file content has changed", async () => {
    await setup.vault.create!("inbox/x.md", "hello");
    const e = j.record({
      kind: "create",
      scope: "vault",
      path: "inbox/x.md",
      after: "hello",
    });
    await setup.vault.modify!({ path: "inbox/x.md" }, "edited by user");
    const r = await j.undo(e.id);
    expect(r.ok).toBe(false);
    expect(setup.files.has("inbox/x.md")).toBe(true);
  });

  test("delete undo refuses when path now exists again", async () => {
    await setup.vault.create!("notes.md", "ORIGINAL");
    await setup.vault.trash!({ path: "notes.md" });
    const e = j.record({
      kind: "delete",
      scope: "vault",
      path: "notes.md",
      before: "ORIGINAL",
    });
    // Some other process recreates the file.
    await setup.vault.create!("notes.md", "DIFFERENT");
    const r = await j.undo(e.id);
    expect(r.ok).toBe(false);
    expect(setup.files.get("notes.md")).toBe("DIFFERENT");
  });

  test("double-undo refuses", async () => {
    await setup.vault.create!("notes.md", "X");
    const e = j.record({
      kind: "create",
      scope: "vault",
      path: "notes.md",
      after: "X",
    });
    expect((await j.undo(e.id)).ok).toBe(true);
    const r = await j.undo(e.id);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/already been undone/i);
  });

  test("unknown id returns ok:false", async () => {
    const r = await j.undo("does-not-exist");
    expect(r.ok).toBe(false);
  });

  test("extra-vault scope not supported in this phase", async () => {
    const e = j.record({
      kind: "modify",
      scope: "extra-vault",
      path: "/abs/path",
      before: "x",
      after: "y",
    });
    const r = await j.undo(e.id);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/extra-vault/i);
  });

  test("clear wipes the journal", async () => {
    const e = j.record({ kind: "create", scope: "vault", path: "x.md" });
    j.clear();
    expect(j.get(e.id)).toBeUndefined();
  });
});
