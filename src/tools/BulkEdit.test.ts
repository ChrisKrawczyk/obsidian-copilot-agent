import { describe, test, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  bulkEditImpl,
  compileFind,
  MAX_BULK_EDIT_NOTES,
  replaceAllCounted,
  type BulkEditInput,
} from "./BulkEdit";
import { DEFAULT_VAULT_AWARENESS_SETTINGS } from "../settings/VaultAwarenessSettings";
import { ObsidianApi, type AppLike } from "./ObsidianApi";
import type { TFileLike } from "./ReadTools";
import type { WriteNoteToolsDeps } from "./WriteNoteTools";
import { UndoJournal, type UndoEntry } from "../domain/UndoJournal";

let vaultRoot: string;
beforeAll(() => {
  vaultRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "copilot-agent-bulkedit-")));
});
afterAll(() => {
  fs.rmSync(vaultRoot, { recursive: true, force: true });
});

interface World {
  files: Map<string, { path: string; content: string }>;
  dirty: Map<string, string>;
  beforeProcess?: (path: string) => void;
}

function makeWorld(seed: Record<string, string>): World {
  const files = new Map<string, { path: string; content: string }>();
  for (const [p, c] of Object.entries(seed)) files.set(p, { path: p, content: c });
  return { files, dirty: new Map() };
}

function makeDeps(world: World): WriteNoteToolsDeps & { undoJournal: UndoJournal; entries: UndoEntry[] } {
  const vault = {
    adapter: { getBasePath: () => vaultRoot },
    getAbstractFileByPath: (p: string) => world.files.get(p) ?? null,
    read: async (f: TFileLike) => world.files.get(f.path)?.content ?? "",
    modify: async (f: TFileLike, data: string) => {
      const e = world.files.get(f.path);
      if (e) e.content = data;
    },
    process: async (f: TFileLike, fn: (data: string) => string) => {
      world.beforeProcess?.(f.path);
      const e = world.files.get(f.path)!;
      const next = fn(e.content);
      e.content = next;
      return next;
    },
  };
  const workspace = {
    getActiveFile: () => null,
    getLeavesOfType: () =>
      [...world.dirty.entries()].map(([p, buf]) => ({ view: { file: { path: p }, getViewData: () => buf } })),
  };
  const app = { vault, workspace } as unknown as AppLike;
  const undoJournal = new UndoJournal(vault as unknown as ConstructorParameters<typeof UndoJournal>[0]);
  const entries: UndoEntry[] = [];
  const record = undoJournal.record.bind(undoJournal);
  undoJournal.record = (e) => {
    const out = record(e);
    entries.push(out);
    return out;
  };
  return {
    entries,
    api: new ObsidianApi(app),
    vault: vault as unknown as WriteNoteToolsDeps["vault"],
    workspace: workspace as unknown as WriteNoteToolsDeps["workspace"],
    undoJournal,
    now: () => new Date(2026, 5, 9, 12),
    vaultAwareness: () => ({ ...DEFAULT_VAULT_AWARENESS_SETTINGS }),
  };
}

function content(world: World, p: string): string | undefined {
  return world.files.get(p)?.content;
}

function run(input: Partial<BulkEditInput> & Pick<BulkEditInput, "paths" | "find">, world: World) {
  const deps = makeDeps(world);
  return { deps, result: bulkEditImpl({ replace: "", ...input }, deps) };
}

describe("compileFind", () => {
  test("rejects an empty find", () => {
    expect(compileFind({ find: "" })).toMatchObject({ ok: false, reason: "invalid_find" });
  });
  test("rejects an invalid regex with its error", () => {
    const r = compileFind({ find: "(", regex: true });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(/Invalid regular expression/);
  });
  test("rejects a regex that matches the empty string", () => {
    expect(compileFind({ find: "a*", regex: true })).toMatchObject({ ok: false });
    expect(compileFind({ find: "^", regex: true })).toMatchObject({ ok: false });
  });
  test("literal mode escapes regex metacharacters", () => {
    const r = compileFind({ find: "a.b(c)" });
    if (!r.ok) throw new Error("compile failed");
    expect(replaceAllCounted("a.b(c) axb(c)", r, "Z")).toMatchObject({ content: "Z axb(c)", count: 1 });
  });
});

describe("replaceAllCounted", () => {
  test("literal replacement inserts $ verbatim", () => {
    const r = compileFind({ find: "price" });
    if (!r.ok) throw new Error();
    expect(replaceAllCounted("price price", r, "$1 $& $$").content).toBe("$1 $& $$ $1 $& $$");
  });
  test("regex replacement expands capture groups", () => {
    const r = compileFind({ find: "#proj-(\\w+)", regex: true });
    if (!r.ok) throw new Error();
    const out = replaceAllCounted("see #proj-x and #proj-yz", r, "#project-$1");
    expect(out).toMatchObject({ content: "see #project-x and #project-yz", count: 2 });
    const named = compileFind({ find: "(?<d>\\d+)px", regex: true });
    if (!named.ok) throw new Error();
    expect(replaceAllCounted("10px", named, "$<d>em $$").content).toBe("10em $");
  });
  test("ignoreCase matches any case", () => {
    const r = compileFind({ find: "todo", ignoreCase: true });
    if (!r.ok) throw new Error();
    expect(replaceAllCounted("TODO todo ToDo", r, "done")).toMatchObject({ content: "done done done", count: 3 });
  });
  test("^ and $ match at line boundaries; dot does not cross lines", () => {
    const r = compileFind({ find: "^- (.+)$", regex: true });
    if (!r.ok) throw new Error();
    expect(replaceAllCounted("- a\n- b\ntext", r, "* $1").content).toBe("* a\n* b\ntext");
    const dot = compileFind({ find: "a.b", regex: true });
    if (!dot.ok) throw new Error();
    expect(replaceAllCounted("a\nb", dot, "X").count).toBe(0);
  });
  test("samples show up to three changed lines", () => {
    const r = compileFind({ find: "x" });
    if (!r.ok) throw new Error();
    const out = replaceAllCounted("x1 x2\nx3\nx4\nx5", r, "y");
    if (!out.ok) throw new Error();
    expect(out.count).toBe(5);
    expect(out.samples).toEqual([
      { before: "x1 x2", after: "y1 y2" },
      { before: "x3", after: "y3" },
      { before: "x4", after: "y4" },
    ]);
  });
  test("stops counting past the limit and leaves the content untouched", () => {
    const r = compileFind({ find: "x" });
    if (!r.ok) throw new Error();
    expect(replaceAllCounted("xxxxxx", r, "y", 3)).toEqual({
      ok: true,
      content: "xxxxxx",
      count: 4,
      samples: [],
      overLimit: true,
    });
  });
  test("samples of multi-line matches show line breaks as ⏎", () => {
    const r = compileFind({ find: "a\nb" });
    if (!r.ok) throw new Error();
    const out = replaceAllCounted("a\nb", r, "c\nd");
    if (!out.ok) throw new Error();
    expect(out.samples).toEqual([{ before: "a⏎b", after: "c⏎d" }]);
  });
  test("samples on long lines start near the match", () => {
    const r = compileFind({ find: "old" });
    if (!r.ok) throw new Error();
    const out = replaceAllCounted(`${"w".repeat(300)} old tail`, r, "new");
    if (!out.ok) throw new Error();
    expect(out.samples[0]).toEqual({ before: `…${"w".repeat(39)} old tail`, after: `…${"w".repeat(39)} new tail` });
  });
  test("regex samples use the match's own expansion", () => {
    const r = compileFind({ find: "(?<=#)old", regex: true });
    if (!r.ok) throw new Error();
    const out = replaceAllCounted("old #old #old", r, "new");
    expect(out).toMatchObject({ content: "old #new #new", samples: [{ before: "old #old #old", after: "old #new #new" }] });
  });
  test("zero-length matches are refused", () => {
    const r = compileFind({ find: "(?=a)", regex: true });
    if (!r.ok) throw new Error();
    expect(replaceAllCounted("bab", r, "X").ok).toBe(false);
  });
});

describe("bulkEditImpl", () => {
  test("edits every matching note with one batch entry and leaves others untouched", async () => {
    const world = makeWorld({ "a.md": "#proj-x one", "b.md": "#proj-x #proj-x", "c.md": "nothing" });
    const { deps, result } = run({ paths: ["a.md", "b.md", "c.md"], find: "#proj-x", replace: "#project-x" }, world);
    expect(await result).toMatchObject({
      ok: true,
      changed: true,
      totalReplacements: 3,
      notesChanged: 2,
      results: [
        { path: "a.md", replacements: 1 },
        { path: "b.md", replacements: 2 },
        { path: "c.md", replacements: 0 },
      ],
    });
    expect(content(world, "b.md")).toBe("#project-x #project-x");
    expect(content(world, "c.md")).toBe("nothing");
    expect(deps.entries).toHaveLength(1);
    expect(deps.entries[0].label).toBe("3 replacements in 2 notes");
    expect(deps.entries[0].items?.map((i) => i.op === "modify" && i.path)).toEqual(["a.md", "b.md"]);
  });

  test("undo restores every edited note", async () => {
    const world = makeWorld({ "a.md": "foo", "b.md": "foo foo" });
    const { deps, result } = run({ paths: ["a.md", "b.md"], find: "foo", replace: "bar" }, world);
    const r = await result;
    if (!r.ok || !r.undoId) throw new Error(JSON.stringify(r));
    expect((await deps.undoJournal.undo(r.undoId)).ok).toBe(true);
    expect(content(world, "a.md")).toBe("foo");
    expect(content(world, "b.md")).toBe("foo foo");
  });

  test("zero matches overall succeeds without an undo entry", async () => {
    const world = makeWorld({ "a.md": "abc" });
    const { deps, result } = run({ paths: ["a.md"], find: "zzz" }, world);
    expect(await result).toMatchObject({ ok: true, changed: false, totalReplacements: 0 });
    expect(deps.entries).toHaveLength(0);
  });

  test("any invalid path means nothing is written and every failure is listed", async () => {
    const world = makeWorld({ "a.md": "foo", "img.png": "foo", "d.md": "foo" });
    world.dirty.set("d.md", "foo edited");
    const { deps, result } = run({ paths: ["a.md", "img.png", "missing.md", "d.md", "a.md"], find: "foo", replace: "bar" }, world);
    const r = await result;
    expect(r).toMatchObject({ ok: false, reason: "validation_failed" });
    if (r.ok || r.reason !== "validation_failed") throw new Error();
    expect(r.failures.map((f) => `${f.index}:${f.reason}`)).toEqual([
      "1:not_a_note",
      "2:not_found",
      "3:unsaved_changes",
      "4:duplicate_path",
    ]);
    expect(content(world, "a.md")).toBe("foo");
    expect(deps.entries).toHaveLength(0);
  });

  test("plain-text notes are allowed", async () => {
    const world = makeWorld({ "n.txt": "foo" });
    expect(await run({ paths: ["n.txt"], find: "foo", replace: "bar" }, world).result).toMatchObject({ ok: true });
    expect(content(world, "n.txt")).toBe("bar");
  });

  test("a note changed between validation and write rolls back earlier notes", async () => {
    const world = makeWorld({ "a.md": "foo", "b.md": "foo" });
    world.beforeProcess = (p) => {
      if (p === "b.md") world.files.get("b.md")!.content = "foo changed";
    };
    const { deps, result } = run({ paths: ["a.md", "b.md"], find: "foo", replace: "bar" }, world);
    expect(await result).toMatchObject({ ok: false, reason: "concurrent_change", path: "b.md", rolledBack: true });
    expect(content(world, "a.md")).toBe("foo");
    expect(deps.entries).toHaveLength(0);
  });

  test("caps and find errors are reported before reading", async () => {
    const world = makeWorld({});
    expect(await run({ paths: [], find: "x" }, world).result).toEqual({ ok: false, reason: "no_paths" });
    const many = Array.from({ length: MAX_BULK_EDIT_NOTES + 1 }, (_, i) => `n${i}.md`);
    expect(await run({ paths: many, find: "x" }, world).result).toMatchObject({ reason: "too_many_paths" });
    expect(await run({ paths: ["a.md"], find: "" }, world).result).toMatchObject({ reason: "invalid_find" });
  });

  test("notes too large to snapshot are rejected", async () => {
    const big = "foo " + "x".repeat(1_100_000);
    const world = makeWorld({ "a.md": big });
    expect(await run({ paths: ["a.md"], find: "foo", replace: "bar" }, world).result).toMatchObject({
      ok: false,
      reason: "snapshot_too_large",
    });
    expect(content(world, "a.md")).toBe(big);
  });

  test("too many replacements is rejected", async () => {
    const world = makeWorld({ "a.md": "x".repeat(5001) });
    expect(await run({ paths: ["a.md"], find: "x", replace: "y" }, world).result).toMatchObject({
      ok: false,
      reason: "too_many_replacements",
      count: 5001,
    });
    expect(content(world, "a.md")).toBe("x".repeat(5001));
  });

  test("counting stops once the replacement cap is exceeded across notes", async () => {
    const world = makeWorld({ "a.md": "x".repeat(3000), "b.md": "x".repeat(30000), "c.md": "x" });
    expect(await run({ paths: ["a.md", "b.md", "c.md"], find: "x", replace: "y" }, world).result).toMatchObject({
      ok: false,
      reason: "too_many_replacements",
      count: 5001,
    });
  });
});
