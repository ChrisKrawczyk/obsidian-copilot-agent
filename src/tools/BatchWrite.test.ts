import { describe, test, expect } from "vitest";
import { applyBatchModifications } from "./BatchWrite";
import { ProcessAbort, type WriteToolsVault } from "./WriteTools";
import type { TFileLike } from "./ReadTools";

function makeVault(seed: Record<string, string>, opts: { noProcess?: boolean; failOn?: string } = {}) {
  const files = new Map<string, { path: string; content: string }>();
  for (const [p, c] of Object.entries(seed)) files.set(p, { path: p, content: c });
  const vault: WriteToolsVault = {
    adapter: {},
    getAbstractFileByPath: (p) => files.get(p) ?? null,
    read: async (f: TFileLike) => files.get(f.path)!.content,
    modify: async (f: TFileLike, data: string) => {
      if (f.path === opts.failOn) throw new Error("disk full");
      files.get(f.path)!.content = data;
    },
  };
  if (!opts.noProcess) {
    vault.process = async (f, fn) => {
      if (f.path === opts.failOn) throw new Error("disk full");
      const e = files.get(f.path)!;
      e.content = fn(e.content);
      return e.content;
    };
  }
  return { vault, files };
}

const upper = (path: string) => ({ path, transform: (d: string) => d.toUpperCase() });

describe("applyBatchModifications", () => {
  test("writes each plan and returns modify items for changed files only", async () => {
    const { vault, files } = makeVault({ "a.md": "a", "b.md": "B" });
    const r = await applyBatchModifications([upper("a.md"), upper("b.md")], { vault });
    expect(r).toEqual({ ok: true, items: [{ op: "modify", path: "a.md", before: "a", after: "A" }] });
    expect(files.get("a.md")!.content).toBe("A");
  });

  test("rolls back when the written snapshots exceed the budget", async () => {
    const { vault, files } = makeVault({ "a.md": "aaaa", "b.md": "bbbb" });
    const r = await applyBatchModifications([upper("a.md"), upper("b.md")], { vault }, 12);
    expect(r).toMatchObject({ ok: false, path: "b.md", aborted: true, rollbackFailures: [] });
    expect(r.ok ? "" : r.error).toMatch(/Undo snapshot limit/);
    expect(files.get("a.md")!.content).toBe("aaaa");
    expect(files.get("b.md")!.content).toBe("bbbb");
  });

  test("an abort rolls back files already written", async () => {
    const { vault, files } = makeVault({ "a.md": "a", "b.md": "b" });
    const r = await applyBatchModifications(
      [
        upper("a.md"),
        {
          path: "b.md",
          transform: () => {
            throw new ProcessAbort("changed");
          },
        },
      ],
      { vault },
    );
    expect(r).toEqual({ ok: false, path: "b.md", error: "changed", aborted: true, rollbackFailures: [] });
    expect(files.get("a.md")!.content).toBe("a");
  });

  test("a write error rolls back and is not reported as an abort", async () => {
    const { vault, files } = makeVault({ "a.md": "a", "b.md": "b" }, { failOn: "b.md" });
    const r = await applyBatchModifications([upper("a.md"), upper("b.md")], { vault });
    expect(r).toMatchObject({ ok: false, path: "b.md", aborted: false });
    expect(files.get("a.md")!.content).toBe("a");
  });

  test("rollback leaves a file alone if it changed after our write", async () => {
    const { vault, files } = makeVault({ "a.md": "a", "b.md": "b" });
    const r = await applyBatchModifications(
      [
        upper("a.md"),
        {
          path: "b.md",
          transform: () => {
            files.get("a.md")!.content = "user edit";
            throw new ProcessAbort("changed");
          },
        },
      ],
      { vault },
    );
    expect(r).toMatchObject({ ok: false, rollbackFailures: ["a.md"] });
    expect(files.get("a.md")!.content).toBe("user edit");
  });

  test("a missing file fails the batch", async () => {
    const { vault } = makeVault({ "a.md": "a" });
    const r = await applyBatchModifications([upper("gone.md")], { vault });
    expect(r).toMatchObject({ ok: false, path: "gone.md", aborted: false });
  });

  test("falls back to read + modify without process()", async () => {
    const { vault, files } = makeVault({ "a.md": "a", "b.md": "b" }, { noProcess: true });
    const r = await applyBatchModifications([upper("a.md"), upper("b.md")], { vault });
    expect(r.ok).toBe(true);
    expect(files.get("b.md")!.content).toBe("B");
  });
});
