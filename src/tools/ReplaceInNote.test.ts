import { describe, test, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  formatReplaceDiffHunks,
  MAX_REPLACE_IN_NOTE_OCCURRENCES,
  parseReplaceInNoteArgs,
  planReplaceInNote,
  replaceInNoteImpl,
  validateReplaceInNoteInput,
  type ReplaceInNoteInput,
} from "./ReplaceInNote";
import { createWriteNoteTools, type WriteNoteToolsDeps } from "./WriteNoteTools";
import { DEFAULT_VAULT_AWARENESS_SETTINGS } from "../settings/VaultAwarenessSettings";
import { ObsidianApi, type AppLike } from "./ObsidianApi";
import type { TFileLike } from "./ReadTools";
import { UndoJournal, type UndoEntry } from "../domain/UndoJournal";

let vaultRoot: string;
beforeAll(() => {
  vaultRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "copilot-agent-replace-")));
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

function input(oldText: string, newText: string, extra: Partial<ReplaceInNoteInput> = {}): ReplaceInNoteInput {
  return { path: "n.md", oldText, newText, expectedOccurrences: 1, ...extra };
}

const TABLE = "# Sales\n\n| Q | Sales |\n|---|---|\n| Q2 | 10 |\n| Q3 | 12 |\n| Q4 | 15 |\n\nNotes below.\n";

describe("parseReplaceInNoteArgs / validateReplaceInNoteInput", () => {
  test("expectedOccurrences defaults to 1", () => {
    expect(parseReplaceInNoteArgs({ path: "a.md", oldText: "x", newText: "y" }).expectedOccurrences).toBe(1);
    expect(parseReplaceInNoteArgs({ path: "a.md", oldText: "x", newText: "y", expectedOccurrences: null }).expectedOccurrences).toBe(1);
  });
  test("missing strings throw", () => {
    expect(() => parseReplaceInNoteArgs({ path: "a.md", newText: "y" })).toThrow("`oldText` is required");
    expect(() => parseReplaceInNoteArgs({ oldText: "x", newText: "y" })).toThrow("`path` is required");
    expect(() => parseReplaceInNoteArgs({ path: "a.md", oldText: "x" })).toThrow("`newText` is required");
  });
  test("rejects empty oldText, identical text and bad counts", () => {
    expect(validateReplaceInNoteInput(input("", "y"))).toBe("oldText must not be empty.");
    expect(validateReplaceInNoteInput(input("x", "x"))).toMatch(/identical/);
    for (const n of [0, -1, 1.5, Number.NaN, MAX_REPLACE_IN_NOTE_OCCURRENCES + 1]) {
      expect(validateReplaceInNoteInput(input("x", "y", { expectedOccurrences: n }))).toMatch(/expectedOccurrences/);
    }
    expect(validateReplaceInNoteInput(input("x", "", { expectedOccurrences: 3 }))).toBeUndefined();
  });
  test("a non-numeric expectedOccurrences is invalid", () => {
    const parsed = parseReplaceInNoteArgs({ path: "a.md", oldText: "x", newText: "y", expectedOccurrences: "2" });
    expect(validateReplaceInNoteInput(parsed)).toMatch(/expectedOccurrences/);
  });
});

describe("planReplaceInNote", () => {
  test("replaces exactly the one matching row", () => {
    const r = planReplaceInNote(TABLE, input("| Q3 | 12 |", "| Q3 | 14 |"));
    expect(r).toEqual({ ok: true, count: 1, content: TABLE.replace("| Q3 | 12 |", "| Q3 | 14 |") });
  });
  test("reports zero matches", () => {
    const r = planReplaceInNote(TABLE, input("| Q5 |", "x"));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("no_match");
    expect(r.found).toBe(0);
    expect(r.error).toContain("(0 matches)");
  });
  test("reports an ambiguous match with the count and how to fix it", () => {
    const r = planReplaceInNote("a | b | a", input("a", "c"));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("count_mismatch");
    expect(r.found).toBe(2);
    expect(r.error).toMatch(/^Found 2 matches of oldText in "n\.md", expected 1\./);
    expect(r.error).toContain("expectedOccurrences: 2");
  });
  test("replaces every match when the count equals expectedOccurrences", () => {
    expect(planReplaceInNote("a b a b a", input("a", "x", { expectedOccurrences: 3 }))).toMatchObject({
      ok: true,
      count: 3,
      content: "x b x b x",
    });
    const r = planReplaceInNote("a b a", input("a", "x", { expectedOccurrences: 3 }));
    expect(r).toMatchObject({ ok: false, reason: "count_mismatch", found: 2 });
  });
  test("is literal, case-sensitive and inserts newText verbatim", () => {
    expect(planReplaceInNote("cost (a+b)* here", input("(a+b)*", "$1 $& $$"))).toMatchObject({
      ok: true,
      content: "cost $1 $& $$ here",
    });
    expect(planReplaceInNote("Alpha alpha", input("alpha", "beta"))).toMatchObject({ ok: true, content: "Alpha beta" });
  });
  test("counts non-overlapping matches", () => {
    expect(planReplaceInNote("aaa", input("aa", "b"))).toMatchObject({ ok: true, count: 1, content: "ba" });
  });
  test("matches across lines", () => {
    expect(planReplaceInNote("one\ntwo\nthree", input("one\ntwo", "1\n2"))).toMatchObject({ ok: true, content: "1\n2\nthree" });
  });
  test("hints at CRLF line endings when a multi-line oldText is missing", () => {
    const r = planReplaceInNote("one\r\ntwo", input("one\ntwo", "x"));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("CRLF");
  });
  test("a deleting replacement is allowed", () => {
    expect(planReplaceInNote("keep drop keep", input(" drop", ""))).toMatchObject({ ok: true, content: "keep keep" });
  });
});

describe("formatReplaceDiffHunks", () => {
  test("shows the changed line with two lines of context either side", () => {
    expect(formatReplaceDiffHunks(TABLE, "| Q3 | 12 |", "| Q3 | 14 |")).toEqual([
      ["@@ line 6 @@", "  |---|---|", "  | Q2 | 10 |", "- | Q3 | 12 |", "+ | Q3 | 14 |", "  | Q4 | 15 |", "  "].join("\n"),
    ]);
  });
  test("shows whole lines for a partial-line match", () => {
    expect(formatReplaceDiffHunks("a\nprefix OLD suffix\nb", "OLD", "NEW", 0)).toEqual([
      "@@ line 2 @@\n- prefix OLD suffix\n+ prefix NEW suffix",
    ]);
  });
  test("multi-line replacements list every removed and added line", () => {
    expect(formatReplaceDiffHunks("x\none\ntwo\ny", "one\ntwo", "1", 1)).toEqual([
      "@@ line 2 @@\n  x\n- one\n- two\n+ 1\n  y",
    ]);
  });
  test("matches on the same line share one hunk; distant matches get their own", () => {
    const content = "a a\n1\n2\n3\n4\n5\n6\na";
    const hunks = formatReplaceDiffHunks(content, "a", "b", 1);
    expect(hunks).toEqual(["@@ line 1 @@\n- a a\n+ b b\n  1", "@@ line 8 @@\n  6\n- a\n+ b"]);
  });
  test("clips long lines and drops trailing CR", () => {
    const [hunk] = formatReplaceDiffHunks(`${"z".repeat(300)} OLD\r\nnext`, "OLD", "NEW", 1);
    const lines = hunk.split("\n");
    expect(lines[1].length).toBeLessThanOrEqual(202);
    expect(lines[1].endsWith("…")).toBe(true);
    expect(lines[3]).toBe("  next");
  });
  test("no matches means no hunks", () => {
    expect(formatReplaceDiffHunks("abc", "x", "y")).toEqual([]);
  });
});

describe("replaceInNoteImpl", () => {
  test("edits one row, leaves the rest untouched and records one Undo entry", async () => {
    const world = makeWorld({ "n.md": TABLE });
    const deps = makeDeps(world);
    const r = await replaceInNoteImpl(input("| Q3 | 12 |", "| Q3 | 14 |"), deps);
    expect(r).toMatchObject({ ok: true, path: "n.md", replacements: 1, undoSurface: "journal" });
    expect(world.files.get("n.md")!.content).toBe(TABLE.replace("12", "14"));
    expect(deps.entries).toHaveLength(1);
    expect(deps.entries[0]).toMatchObject({ kind: "modify", path: "n.md", before: TABLE });
    if (!r.ok) return;
    expect(r.undoId).toBe(deps.entries[0].id);
    expect((await deps.undoJournal.undo(r.undoId!)).ok).toBe(true);
    expect(world.files.get("n.md")!.content).toBe(TABLE);
  });
  test("no match or an ambiguous match writes nothing", async () => {
    const world = makeWorld({ "n.md": "a a" });
    const deps = makeDeps(world);
    expect(await replaceInNoteImpl(input("z", "y"), deps)).toMatchObject({ ok: false, reason: "no_match", found: 0 });
    expect(await replaceInNoteImpl(input("a", "y"), deps)).toMatchObject({ ok: false, reason: "count_mismatch", found: 2 });
    expect(world.files.get("n.md")!.content).toBe("a a");
    expect(deps.entries).toHaveLength(0);
  });
  test("refuses notes with unsaved editor changes", async () => {
    const world = makeWorld({ "n.md": "a" });
    world.dirty.set("n.md", "a edited");
    const deps = makeDeps(world);
    expect(await replaceInNoteImpl(input("a", "b"), deps)).toMatchObject({ ok: false, reason: "unsaved_changes" });
    expect(world.files.get("n.md")!.content).toBe("a");
  });
  test("refuses missing files, non-notes, escaping paths and bad args", async () => {
    const world = makeWorld({ "img.png": "a" });
    const deps = makeDeps(world);
    expect(await replaceInNoteImpl(input("a", "b", { path: "gone.md" }), deps)).toMatchObject({ ok: false, reason: "not_found" });
    expect(await replaceInNoteImpl(input("a", "b", { path: "img.png" }), deps)).toMatchObject({ ok: false, reason: "not_a_note" });
    expect(await replaceInNoteImpl(input("a", "b", { path: "../x.md" }), deps)).toMatchObject({ ok: false, reason: "invalid_path" });
    expect(await replaceInNoteImpl(input("", "b"), deps)).toMatchObject({ ok: false, reason: "invalid_args" });
    expect(world.files.get("img.png")!.content).toBe("a");
  });
  test("plain-text notes are allowed", async () => {
    const world = makeWorld({ "t.txt": "hello" });
    expect(await replaceInNoteImpl(input("hello", "bye", { path: "t.txt" }), makeDeps(world))).toMatchObject({ ok: true });
    expect(world.files.get("t.txt")!.content).toBe("bye");
  });
  test("re-checks the count on the content read inside the atomic write", async () => {
    const world = makeWorld({ "n.md": "one target" });
    world.beforeProcess = (p) => {
      world.files.get(p)!.content = "target and target";
    };
    const deps = makeDeps(world);
    const r = await replaceInNoteImpl(input("target", "hit"), deps);
    expect(r).toMatchObject({ ok: false, reason: "count_mismatch", found: 2 });
    expect(world.files.get("n.md")!.content).toBe("target and target");
    expect(deps.entries).toHaveLength(0);
  });
  test("applies to the current content when a concurrent change keeps the count", async () => {
    const world = makeWorld({ "n.md": "one target" });
    world.beforeProcess = (p) => {
      world.files.get(p)!.content = "two target";
    };
    const deps = makeDeps(world);
    expect(await replaceInNoteImpl(input("target", "hit"), deps)).toMatchObject({ ok: true, replacements: 1 });
    expect(world.files.get("n.md")!.content).toBe("two hit");
    expect(deps.entries[0]).toMatchObject({ before: "two target", after: "two hit" });
  });
  test("is registered as a permission-gated tool that runs the impl", async () => {
    const world = makeWorld({ "n.md": TABLE });
    const tools = createWriteNoteTools(makeDeps(world));
    const tool = tools.find((t) => (t as unknown as { name: string }).name === "replace_in_note") as unknown as {
      skipPermission?: boolean;
      handler: (args: unknown) => Promise<unknown>;
    };
    expect(tool.skipPermission).toBeFalsy();
    const r = await tool.handler({ path: "n.md", oldText: "| Q2 | 10 |", newText: "| Q2 | 11 |" });
    expect(r).toMatchObject({ ok: true, replacements: 1 });
    expect(world.files.get("n.md")!.content).toContain("| Q2 | 11 |");
  });
});
