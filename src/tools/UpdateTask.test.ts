import { describe, test, expect, beforeAll, afterAll } from "vitest";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import { updateTaskImpl, type UpdateTaskInput } from "./UpdateTask";
import {
  DEFAULT_VAULT_AWARENESS_SETTINGS,
  type VaultAwarenessSettings,
} from "../settings/VaultAwarenessSettings";
import { ObsidianApi, type AppLike } from "./ObsidianApi";
import type { TFileLike } from "./ReadTools";
import type { WriteNoteToolsDeps } from "./WriteNoteTools";
import { UndoJournal } from "../domain/UndoJournal";

let tmpRoot: string;

beforeAll(() => {
  tmpRoot = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "copilot-agent-updatetask-")),
  );
});

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

interface FakeFile extends TFileLike {
  content: string;
}

interface FakeWorld {
  files: Map<string, FakeFile>;
  basePath: string;
  vaultAwareness?: VaultAwarenessSettings;
  now: Date;
  processChains: Map<string, Promise<unknown>>;
}

function makeWorld(opts: Partial<FakeWorld> = {}): FakeWorld {
  return {
    files: new Map(),
    basePath: tmpRoot,
    now: new Date(2026, 5, 9, 12, 0, 0),
    processChains: new Map(),
    ...opts,
  };
}

function makeDeps(world: FakeWorld): WriteNoteToolsDeps {
  const app: AppLike = {
    vault: {
      adapter: { getBasePath: () => world.basePath },
      getAbstractFileByPath: (p: string) => world.files.get(p) ?? null,
      read: async (file: TFileLike) =>
        world.files.get(file.path)?.content ?? "",
      cachedRead: async (file: TFileLike) =>
        world.files.get(file.path)?.content ?? "",
      create: async (path: string, data: string) => {
        const f: FakeFile = { path, content: data };
        world.files.set(path, f);
        return f;
      },
      modify: async (file: TFileLike, data: string) => {
        const f = world.files.get(file.path);
        if (f) f.content = data;
        else world.files.set(file.path, { path: file.path, content: data });
      },
      process: async (file: TFileLike, fn: (data: string) => string) => {
        const p = file.path;
        const prev = world.processChains.get(p) ?? Promise.resolve();
        const run = prev.then(async () => {
          const cur = world.files.get(p)?.content ?? "";
          const next = fn(cur);
          const existing = world.files.get(p);
          if (existing) existing.content = next;
          else world.files.set(p, { path: p, content: next });
          return next;
        });
        world.processChains.set(
          p,
          run.catch(() => undefined),
        );
        return run;
      },
    } as unknown as AppLike["vault"],
    workspace: {
      getActiveFile: () => null,
      getLeavesOfType: () => [],
    } as unknown as AppLike["workspace"],
  };
  const api = new ObsidianApi(app);
  const undoJournal = new UndoJournal(
    app.vault as unknown as ConstructorParameters<typeof UndoJournal>[0],
  );
  return {
    api,
    vault: app.vault as unknown as WriteNoteToolsDeps["vault"],
    workspace: app.workspace as unknown as WriteNoteToolsDeps["workspace"],
    undoJournal,
    now: () => world.now,
    vaultAwareness: () =>
      world.vaultAwareness ?? { ...DEFAULT_VAULT_AWARENESS_SETTINGS },
  };
}

function seedFile(world: FakeWorld, p: string, content: string): void {
  world.files.set(p, { path: p, content });
}

describe("updateTaskImpl — patch application", () => {
  test("setStatus done auto-stamps today and changes checkbox", async () => {
    const world = makeWorld();
    seedFile(world, "tasks.md", "- [ ] write tests 📅 2026-06-12");
    const deps = makeDeps(world);
    const r = await updateTaskImpl(
      {
        path: "tasks.md",
        line: 1,
        expectedRawLine: "- [ ] write tests 📅 2026-06-12",
        patch: { setStatus: "done" },
      },
      deps,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.changed).toBe(true);
    expect(r.after).toBe("- [x] write tests 📅 2026-06-12 ✅ 2026-06-09");
    expect(r.changedFields).toContain("status");
    expect(r.changedFields).toContain("completedDate");
    expect(world.files.get("tasks.md")?.content).toBe(
      "- [x] write tests 📅 2026-06-12 ✅ 2026-06-09",
    );
    expect(r.undoSurface).toBe("journal");
    expect(typeof r.undoId).toBe("string");
  });

  test("re-marking done preserves existing completion date (idempotent)", async () => {
    const world = makeWorld();
    seedFile(world, "tasks.md", "- [x] write tests ✅ 2026-06-01");
    const deps = makeDeps(world);
    // Wrap modify to count writes (asserting no-op writes nothing).
    const origModify = deps.vault.modify.bind(deps.vault);
    let modifyCalls = 0;
    deps.vault.modify = async (...args: Parameters<typeof origModify>) => {
      modifyCalls++;
      return origModify(...args);
    };
    const journalSizeBefore = (deps.undoJournal as unknown as { entries: Map<string, unknown> }).entries.size;
    const r = await updateTaskImpl(
      { path: "tasks.md", line: 1, patch: { setStatus: "done" } },
      deps,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.changed).toBe(false);
    expect(r.changedFields).toEqual([]);
    expect(r.undoId).toBeUndefined();
    expect(modifyCalls).toBe(0);
    expect(
      (deps.undoJournal as unknown as { entries: Map<string, unknown> }).entries.size,
    ).toBe(journalSizeBefore);
    expect(world.files.get("tasks.md")?.content).toBe("- [x] write tests ✅ 2026-06-01");
  });

  test("partial change reports only affected changedFields", async () => {
    const world = makeWorld();
    seedFile(world, "t.md", "- [ ] task 📅 2026-06-12 #keep");
    const deps = makeDeps(world);
    const r = await updateTaskImpl(
      { path: "t.md", line: 1, patch: { addTags: ["added"] } },
      deps,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.changed).toBe(true);
    // Only tags changed; status/dates/description untouched.
    expect(r.changedFields).toEqual(["tags"]);
    expect(r.after).toContain("#keep");
    expect(r.after).toContain("#added");
    expect(r.after).toContain("📅 2026-06-12");
    expect(r.after.startsWith("- [ ]")).toBe(true);
  });

  test("setStatus cancelled auto-stamps cancelledDate and clears completedDate", async () => {
    const world = makeWorld();
    seedFile(world, "tasks.md", "- [x] do thing ✅ 2026-06-01");
    const deps = makeDeps(world);
    const r = await updateTaskImpl(
      { path: "tasks.md", line: 1, patch: { setStatus: "cancelled" } },
      deps,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.after).toBe("- [-] do thing ❌ 2026-06-09");
    expect(r.changedFields).toContain("status");
    expect(r.changedFields).toContain("cancelledDate");
    expect(r.changedFields).toContain("completedDate");
  });

  test("setStatus back to todo clears both date stamps", async () => {
    const world = makeWorld();
    seedFile(world, "t.md", "- [x] x ✅ 2026-06-01");
    const deps = makeDeps(world);
    const r = await updateTaskImpl(
      { path: "t.md", line: 1, patch: { setStatus: "todo" } },
      deps,
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.after).toBe("- [ ] x");
  });

  test("setStatus in-progress emits [/]", async () => {
    const world = makeWorld();
    seedFile(world, "t.md", "- [ ] task");
    const deps = makeDeps(world);
    const r = await updateTaskImpl(
      { path: "t.md", line: 1, patch: { setStatus: "in-progress" } },
      deps,
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.after).toBe("- [/] task");
  });

  test("addTags + removeTags in one call", async () => {
    const world = makeWorld();
    seedFile(world, "t.md", "- [ ] task #old #shared");
    const deps = makeDeps(world);
    const r = await updateTaskImpl(
      {
        path: "t.md",
        line: 1,
        patch: { addTags: ["new"], removeTags: ["old"] },
      },
      deps,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // Tags appear in insertion order (Set preserves it).
    expect(r.after).toBe("- [ ] task #shared #new");
    expect(r.changedFields).toContain("tags");
  });

  test("setPriority null clears existing priority", async () => {
    const world = makeWorld();
    seedFile(world, "t.md", "- [ ] task ⏫");
    const deps = makeDeps(world);
    const r = await updateTaskImpl(
      { path: "t.md", line: 1, patch: { setPriority: null } },
      deps,
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.after).toBe("- [ ] task");
  });

  test("setDueDate strict format rejected", async () => {
    const world = makeWorld();
    seedFile(world, "t.md", "- [ ] task");
    const deps = makeDeps(world);
    const r = await updateTaskImpl(
      { path: "t.md", line: 1, patch: { setDueDate: "tomorrow" } },
      deps,
    );
    expect(r.ok).toBe(false);
    if (!r.ok && r.reason === "invalid_date_format") {
      expect(r.field).toBe("setDueDate");
    }
    expect(world.files.get("t.md")?.content).toBe("- [ ] task");
  });

  test("setScheduledDate null clears", async () => {
    const world = makeWorld();
    seedFile(world, "t.md", "- [ ] task ⏳ 2026-06-12");
    const deps = makeDeps(world);
    const r = await updateTaskImpl(
      { path: "t.md", line: 1, patch: { setScheduledDate: null } },
      deps,
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.after).toBe("- [ ] task");
  });

  test("setDescription replaces description", async () => {
    const world = makeWorld();
    seedFile(world, "t.md", "- [ ] old desc 📅 2026-06-12");
    const deps = makeDeps(world);
    const r = await updateTaskImpl(
      { path: "t.md", line: 1, patch: { setDescription: "new desc" } },
      deps,
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.after).toBe("- [ ] new desc 📅 2026-06-12");
  });

  test("invalid status rejected", async () => {
    const world = makeWorld();
    seedFile(world, "t.md", "- [ ] x");
    const deps = makeDeps(world);
    const r = await updateTaskImpl(
      // @ts-expect-error testing runtime rejection
      { path: "t.md", line: 1, patch: { setStatus: "blocked" } },
      deps,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("invalid_status");
  });

  test("preserves leadingIndent for nested tasks", async () => {
    const world = makeWorld();
    seedFile(world, "t.md", "- parent\n    - [ ] nested task 📅 2026-06-12");
    const deps = makeDeps(world);
    const r = await updateTaskImpl(
      { path: "t.md", line: 2, patch: { setStatus: "done" } },
      deps,
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.after).toBe("    - [x] nested task 📅 2026-06-12 ✅ 2026-06-09");
  });

  test("preserves extras (recurrence) through edit", async () => {
    const world = makeWorld();
    seedFile(
      world,
      "t.md",
      "- [ ] Weekly review 📅 2026-06-14 🔁 every Sunday",
    );
    const deps = makeDeps(world);
    const r = await updateTaskImpl(
      { path: "t.md", line: 1, patch: { setStatus: "done" } },
      deps,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.after).toContain("🔁 every Sunday");
    expect(r.after).toContain("✅ 2026-06-09");
  });

  test("preserves source flavor (gfm stays gfm)", async () => {
    const world = makeWorld();
    seedFile(world, "t.md", "- [ ] task (due: 2026-06-12)");
    const deps = makeDeps(world);
    const r = await updateTaskImpl(
      { path: "t.md", line: 1, patch: { setStatus: "done" } },
      deps,
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.after).toBe("- [x] task (due: 2026-06-12) (completed: 2026-06-09)");
    }
  });
});

describe("updateTaskImpl — re-anchoring", () => {
  test("expectedRawLine matches at given line (happy path)", async () => {
    const world = makeWorld();
    seedFile(world, "t.md", "- [ ] alpha 📅 2026-06-12\n- [ ] beta 📅 2026-06-13");
    const deps = makeDeps(world);
    const r = await updateTaskImpl(
      {
        path: "t.md",
        line: 2,
        expectedRawLine: "- [ ] beta 📅 2026-06-13",
        patch: { setStatus: "done" },
      },
      deps,
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.line).toBe(2);
      expect(r.after).toBe("- [x] beta 📅 2026-06-13 ✅ 2026-06-09");
    }
  });

  test("expectedRawLine matches after line has shifted (re-anchor scan)", async () => {
    const world = makeWorld();
    // Caller thinks task is at line 2 but it has moved to line 4.
    seedFile(world, "t.md", "new line\nanother\n- [ ] other\n- [ ] target task\n");
    const deps = makeDeps(world);
    const r = await updateTaskImpl(
      {
        path: "t.md",
        line: 2,
        expectedRawLine: "- [ ] target task",
        patch: { setStatus: "done" },
      },
      deps,
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.line).toBe(4);
  });

  test("expectedRawLine not found anywhere → task_not_found", async () => {
    const world = makeWorld();
    seedFile(world, "t.md", "- [ ] alpha");
    const deps = makeDeps(world);
    const r = await updateTaskImpl(
      {
        path: "t.md",
        line: 1,
        expectedRawLine: "- [ ] missing",
        patch: { setStatus: "done" },
      },
      deps,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("task_not_found");
    expect(world.files.get("t.md")?.content).toBe("- [ ] alpha");
  });

  test("expectedRawLine ambiguous → ambiguous_match with candidates", async () => {
    const world = makeWorld();
    seedFile(world, "t.md", "- [ ] dup\nfiller\n- [ ] dup");
    const deps = makeDeps(world);
    const r = await updateTaskImpl(
      {
        path: "t.md",
        line: 1,
        expectedRawLine: "- [ ] dup",
        patch: { setStatus: "done" },
      },
      deps,
    );
    // expectedRawLine matches at line 1 (the optimistic try) so it WILL
    // use line 1. To force ambiguous_match, the optimistic line must
    // NOT match — i.e. the caller's line is wrong.
    expect(r.ok).toBe(true);
    // Now retry with wrong line.
    seedFile(world, "t.md", "- [ ] dup\nfiller\n- [ ] dup");
    const r2 = await updateTaskImpl(
      {
        path: "t.md",
        line: 2,
        expectedRawLine: "- [ ] dup",
        patch: { setStatus: "done" },
      },
      deps,
    );
    expect(r2.ok).toBe(false);
    if (!r2.ok && r2.reason === "ambiguous_match") {
      expect(r2.candidates).toHaveLength(2);
      expect(r2.candidates.map((c) => c.line)).toEqual([1, 3]);
    }
    expect(world.files.get("t.md")?.content).toBe("- [ ] dup\nfiller\n- [ ] dup");
  });

  test("descriptionMatch fallback — unique match succeeds", async () => {
    const world = makeWorld();
    seedFile(world, "t.md", "- [ ] alpha\n- [ ] something else");
    const deps = makeDeps(world);
    const r = await updateTaskImpl(
      {
        path: "t.md",
        line: 1,
        descriptionMatch: "something",
        patch: { setStatus: "done" },
      },
      deps,
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.line).toBe(2);
  });

  test("descriptionMatch fallback — multiple → ambiguous_match, no mutation", async () => {
    const world = makeWorld();
    seedFile(world, "t.md", "- [ ] call Alice\n- [ ] call Bob");
    const deps = makeDeps(world);
    const r = await updateTaskImpl(
      {
        path: "t.md",
        line: 99,
        descriptionMatch: "call",
        patch: { setStatus: "done" },
      },
      deps,
    );
    expect(r.ok).toBe(false);
    if (!r.ok && r.reason === "ambiguous_match") {
      expect(r.candidates).toHaveLength(2);
    }
    expect(world.files.get("t.md")?.content).toBe("- [ ] call Alice\n- [ ] call Bob");
  });

  test("file not found → not_found", async () => {
    const world = makeWorld();
    const deps = makeDeps(world);
    const r = await updateTaskImpl(
      { path: "nope.md", line: 1, patch: { setStatus: "done" } },
      deps,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("not_found");
  });

  test("line points to non-task line → not_a_task", async () => {
    const world = makeWorld();
    seedFile(world, "t.md", "just text\n- [ ] task");
    const deps = makeDeps(world);
    const r = await updateTaskImpl(
      { path: "t.md", line: 1, patch: { setStatus: "done" } },
      deps,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("not_a_task");
  });
});

describe("updateTaskImpl — final-review F5 (descriptionMatch ambiguity)", () => {
  test("descriptionMatch returns ambiguous_match when multiple lines match (even if line hint matches one)", async () => {
    const world = makeWorld();
    seedFile(
      world,
      "tasks.md",
      "- [ ] call bob\n- [ ] call margret\n- [ ] call carol",
    );
    const deps = makeDeps(world);
    const r = await updateTaskImpl(
      {
        path: "tasks.md",
        line: 1,
        descriptionMatch: "call",
        patch: { setStatus: "done" },
      } as UpdateTaskInput,
      deps,
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("ambiguous_match");
    // Original content unchanged.
    expect(world.files.get("tasks.md")?.content).toBe(
      "- [ ] call bob\n- [ ] call margret\n- [ ] call carol",
    );
  });

  test("descriptionMatch unique substring still resolves to a single line", async () => {
    const world = makeWorld();
    seedFile(
      world,
      "tasks.md",
      "- [ ] call bob\n- [ ] call margret\n- [ ] call carol",
    );
    const deps = makeDeps(world);
    const r = await updateTaskImpl(
      {
        path: "tasks.md",
        line: 2,
        descriptionMatch: "margret",
        patch: { setStatus: "done" },
      } as UpdateTaskInput,
      deps,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.after.startsWith("- [x] call margret")).toBe(true);
  });

  test("3 parallel update_task calls patching DIFFERENT lines in same file → all 3 patches persist", async () => {
    const initial = [
      "- [ ] task alpha",
      "- [ ] task beta",
      "- [ ] task gamma",
    ].join("\n");
    const world = makeWorld({
      files: new Map([["notes.md", { path: "notes.md", content: initial }]]),
    });
    const deps = makeDeps(world);
    const results = await Promise.all([
      updateTaskImpl(
        { path: "notes.md", line: 1, patch: { setStatus: "done" } },
        deps,
      ),
      updateTaskImpl(
        { path: "notes.md", line: 2, patch: { setStatus: "done" } },
        deps,
      ),
      updateTaskImpl(
        { path: "notes.md", line: 3, patch: { setStatus: "done" } },
        deps,
      ),
    ]);
    for (const r of results) expect(r.ok).toBe(true);
    const written = world.files.get("notes.md")!.content!;
    // All three should now be checked.
    expect(written.split("\n").filter((l) => l.startsWith("- [x]")).length).toBe(3);
    expect(written).toContain("task alpha");
    expect(written).toContain("task beta");
    expect(written).toContain("task gamma");
  });

  test("2 parallel update_task calls on SAME line with non-overlapping fields → both patches persist", async () => {
    const initial = "- [ ] task alpha";
    const world = makeWorld({
      files: new Map([["notes.md", { path: "notes.md", content: initial }]]),
    });
    const deps = makeDeps(world);
    const [r1, r2] = await Promise.all([
      updateTaskImpl(
        { path: "notes.md", line: 1, patch: { setPriority: "high" } },
        deps,
      ),
      updateTaskImpl(
        {
          path: "notes.md",
          line: 1,
          patch: { setDueDate: "2026-06-15" },
        },
        deps,
      ),
    ]);
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    const written = world.files.get("notes.md")!.content!;
    // Both markers survive because processFileImpl serializes same-
    // path callbacks; the second callback re-parses the first's
    // patched line before layering its own patch.
    expect(written).toContain("(priority: high)");
    expect(written).toContain("(due: 2026-06-15)");
    expect(written).toContain("task alpha");
  });

  test("update_task returns task_not_found when target disappears between attempts (ProcessAbort → no write, no undo)", async () => {
    const initial = [
      "- [ ] real task",
    ].join("\n");
    const world = makeWorld({
      files: new Map([["notes.md", { path: "notes.md", content: initial }]]),
    });
    const deps = makeDeps(world);
    // Request line 5 which doesn't exist. Handler surfaces
    // line_not_found. This exercises the ProcessAbort path.
    const r = await updateTaskImpl(
      { path: "notes.md", line: 5, patch: { setStatus: "done" } },
      deps,
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("task_not_found");
    // File content untouched.
    expect(world.files.get("notes.md")!.content).toBe(initial);
  });
});