import { describe, test, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { updateTasksImpl, MAX_UPDATE_TASKS_TARGETS, type UpdateTasksInput } from "./UpdateTasks";
import { DEFAULT_VAULT_AWARENESS_SETTINGS } from "../settings/VaultAwarenessSettings";
import { ObsidianApi, type AppLike } from "./ObsidianApi";
import type { TFileLike } from "./ReadTools";
import type { WriteNoteToolsDeps } from "./WriteNoteTools";
import { UndoJournal, type UndoEntry } from "../domain/UndoJournal";

let vaultRoot: string;
beforeAll(() => {
  vaultRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "copilot-agent-updatetasks-")));
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
      [...world.dirty.entries()].map(([path, buf]) => ({
        view: { file: { path }, getViewData: () => buf },
      })),
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

const A = "# A\n- [ ] alpha\n- [ ] beta\ntext";
const B = "- [ ] gamma 📅 2026-06-12\n";

function done(targets: UpdateTasksInput["targets"]): UpdateTasksInput {
  return { targets, patch: { setStatus: "done" } };
}

const content = (w: World, p: string) => w.files.get(p)?.content;

describe("updateTasksImpl", () => {
  test("updates tasks across notes with one batch undo entry", async () => {
    const world = makeWorld({ "a.md": A, "b.md": B });
    const deps = makeDeps(world);
    const r = await updateTasksImpl(
      done([
        { path: "a.md", line: 2, expectedRawLine: "- [ ] alpha" },
        { path: "b.md", line: 1, expectedRawLine: "- [ ] gamma 📅 2026-06-12" },
        { path: "a.md", line: 3, expectedRawLine: "- [ ] beta" },
      ]),
      deps,
    );
    expect(r).toMatchObject({ ok: true, changed: true, tasksChanged: 3, notesChanged: 2, undoSurface: "journal" });
    expect(content(world, "a.md")).toBe("# A\n- [x] alpha (completed: 2026-06-09)\n- [x] beta (completed: 2026-06-09)\ntext");
    expect(content(world, "b.md")).toBe("- [x] gamma 📅 2026-06-12 ✅ 2026-06-09\n");
    if (!r.ok) return;
    expect(r.results.map((x) => `${x.path}:${x.line}`)).toEqual(["a.md:2", "b.md:1", "a.md:3"]);
    expect(r.results[0].changedFields).toEqual(expect.arrayContaining(["status", "completedDate"]));
    const entries = deps.entries;
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ id: r.undoId, kind: "batch", label: "3 tasks in 2 notes" });
    expect(entries[0].items).toHaveLength(2);
  });

  test("undo restores every note", async () => {
    const world = makeWorld({ "a.md": A, "b.md": B });
    const deps = makeDeps(world);
    const r = await updateTasksImpl(
      done([
        { path: "a.md", line: 2, expectedRawLine: "- [ ] alpha" },
        { path: "b.md", line: 1, expectedRawLine: "- [ ] gamma 📅 2026-06-12" },
      ]),
      deps,
    );
    if (!r.ok || !r.undoId) throw new Error("expected success");
    const u = await deps.undoJournal.undo(r.undoId);
    expect(u.ok).toBe(true);
    expect(content(world, "a.md")).toBe(A);
    expect(content(world, "b.md")).toBe(B);
  });

  test("a stale target fails validation and writes nothing", async () => {
    const world = makeWorld({ "a.md": A, "b.md": B });
    const deps = makeDeps(world);
    const r = await updateTasksImpl(
      done([
        { path: "a.md", line: 2, expectedRawLine: "- [ ] alpha" },
        { path: "b.md", line: 1, expectedRawLine: "- [ ] gone" },
        { path: "missing.md", line: 1, expectedRawLine: "- [ ] x" },
      ]),
      deps,
    );
    expect(r).toMatchObject({
      ok: false,
      reason: "validation_failed",
      failures: [
        { index: 1, path: "b.md", reason: "task_not_found" },
        { index: 2, path: "missing.md", reason: "not_found" },
      ],
    });
    expect(content(world, "a.md")).toBe(A);
    expect(deps.entries).toHaveLength(0);
  });

  test("rejects duplicates, non-task lines, malformed and ambiguous targets", async () => {
    const world = makeWorld({ "a.md": A, "d.md": "- [ ] same\n- [ ] same" });
    const r = await updateTasksImpl(
      done([
        { path: "a.md", line: 2, expectedRawLine: "- [ ] alpha" },
        { path: "a.md", line: 2, expectedRawLine: "- [ ] alpha" },
        { path: "a.md", line: 1, expectedRawLine: "# A" },
        { path: "a.md", line: 3 },
        { path: "d.md", line: 9, expectedRawLine: "- [ ] same" },
      ]),
      makeDeps(world),
    );
    if (r.ok || r.reason !== "validation_failed") throw new Error("expected validation failure");
    expect(r.failures.map((f) => [f.index, f.reason])).toEqual([
      [1, "duplicate_target"],
      [2, "not_a_task"],
      [3, "invalid_target"],
      [4, "ambiguous_match"],
    ]);
    expect(r.failures[3].candidates).toHaveLength(2);
  });

  test("a note with unsaved editor changes fails validation", async () => {
    const world = makeWorld({ "a.md": A });
    world.dirty.set("a.md", A + "\nunsaved");
    const r = await updateTasksImpl(
      done([{ path: "a.md", line: 2, expectedRawLine: "- [ ] alpha" }]),
      makeDeps(world),
    );
    expect(r).toMatchObject({ ok: false, reason: "validation_failed", failures: [{ reason: "unsaved_changes" }] });
  });

  test("enforces target count limits and patch validation", async () => {
    const deps = makeDeps(makeWorld({ "a.md": A }));
    expect(await updateTasksImpl(done([]), deps)).toEqual({ ok: false, reason: "no_targets" });
    const many = Array.from({ length: MAX_UPDATE_TASKS_TARGETS + 1 }, () => ({
      path: "a.md",
      line: 2,
      expectedRawLine: "- [ ] alpha",
    }));
    expect(await updateTasksImpl(done(many), deps)).toMatchObject({ reason: "too_many_targets", count: 201 });
    expect(
      await updateTasksImpl(
        { targets: [{ path: "a.md", line: 2, expectedRawLine: "- [ ] alpha" }], patch: { setDueDate: "June" } },
        deps,
      ),
    ).toMatchObject({ ok: false, reason: "invalid_date_format" });
  });

  test("rejects calls whose snapshot would exceed the batch cap", async () => {
    const big = "- [ ] big\n" + "x".repeat(1_100_000);
    const world = makeWorld({ "big.md": big });
    const r = await updateTasksImpl(done([{ path: "big.md", line: 1, expectedRawLine: "- [ ] big" }]), makeDeps(world));
    expect(r).toMatchObject({ ok: false, reason: "snapshot_too_large" });
    expect(content(world, "big.md")).toBe(big);
  });

  test("no-op patches succeed without an undo entry", async () => {
    const world = makeWorld({ "c.md": "- [x] done ✅ 2026-06-01" });
    const deps = makeDeps(world);
    const r = await updateTasksImpl(
      done([{ path: "c.md", line: 1, expectedRawLine: "- [x] done ✅ 2026-06-01" }]),
      deps,
    );
    expect(r).toMatchObject({ ok: true, changed: false, tasksChanged: 0 });
    expect(deps.entries).toHaveLength(0);
  });

  test("re-anchors when lines shift between validation and write", async () => {
    const world = makeWorld({ "a.md": A });
    world.beforeProcess = (p) => {
      const e = world.files.get(p)!;
      e.content = "inserted\n" + e.content;
    };
    const r = await updateTasksImpl(
      done([{ path: "a.md", line: 2, expectedRawLine: "- [ ] alpha" }]),
      makeDeps(world),
    );
    expect(r).toMatchObject({ ok: true, results: [{ line: 3 }] });
    expect(content(world, "a.md")).toBe("inserted\n# A\n- [x] alpha (completed: 2026-06-09)\n- [ ] beta\ntext");
  });

  test("a concurrent change rolls back notes already written", async () => {
    const world = makeWorld({ "a.md": A, "b.md": B });
    world.beforeProcess = (p) => {
      if (p === "b.md") world.files.get("b.md")!.content = "- [ ] rewritten";
    };
    const deps = makeDeps(world);
    const r = await updateTasksImpl(
      done([
        { path: "a.md", line: 2, expectedRawLine: "- [ ] alpha" },
        { path: "b.md", line: 1, expectedRawLine: "- [ ] gamma 📅 2026-06-12" },
      ]),
      deps,
    );
    world.beforeProcess = undefined;
    expect(r).toMatchObject({ ok: false, reason: "concurrent_change", path: "b.md", rolledBack: true });
    expect(content(world, "a.md")).toBe(A);
    expect(content(world, "b.md")).toBe("- [ ] rewritten");
    expect(deps.entries).toHaveLength(0);
  });
});
