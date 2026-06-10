import { describe, test, expect, beforeAll, afterAll } from "vitest";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import {
  createNoteImpl,
  editNoteImpl,
  openNoteImpl,
  insertIntoActiveNoteImpl,
  createDailyNoteImpl,
  createTaskImpl,
  createWriteNoteTools,
  type WriteNoteToolsDeps,
} from "./WriteNoteTools";
import {
  DEFAULT_VAULT_AWARENESS_SETTINGS,
  type VaultAwarenessSettings,
} from "../settings/VaultAwarenessSettings";
import { ObsidianApi, type AppLike } from "./ObsidianApi";
import type { TFileLike } from "./ReadTools";
import { UndoJournal } from "../domain/UndoJournal";

let tmpRoot: string;

beforeAll(() => {
  tmpRoot = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "copilot-agent-writenote-")),
  );
});

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

interface FakeFile extends TFileLike {
  content?: string;
}

interface FakeWorld {
  files: Map<string, FakeFile>;
  basePath: string;
  active: FakeFile | null;
  viewMode: "source" | "preview";
  editorBuffer: string;
  editorCursor: { line: number; ch: number };
  openCalls: string[];
  /** Optional Daily Notes plugin config (folder/format/template). */
  dailyNotesConfig?: { folder?: string; format?: string; template?: string };
  /** Whether the Obsidian Tasks community plugin is enabled. */
  tasksPluginEnabled?: boolean;
  /** Vault-awareness settings exposed to createTaskImpl via deps.vaultAwareness(). */
  vaultAwareness?: VaultAwarenessSettings;
}

function makeDeps(world: FakeWorld): WriteNoteToolsDeps {
  const sym = Symbol("MarkdownView");

  const editor = {
    getValue: () => world.editorBuffer,
    replaceRange: (
      content: string,
      from: { line: number; ch: number },
      to?: { line: number; ch: number },
    ) => {
      const buf = world.editorBuffer;
      const lines = buf.split("\n");
      const offsetOf = (p: { line: number; ch: number }): number => {
        let o = 0;
        for (let i = 0; i < p.line; i++) o += lines[i].length + 1;
        return o + p.ch;
      };
      const a = offsetOf(from);
      const b = to ? offsetOf(to) : a;
      world.editorBuffer = buf.slice(0, a) + content + buf.slice(b);
    },
    getCursor: () => world.editorCursor,
    setCursor: (p: { line: number; ch: number }) => {
      world.editorCursor = p;
    },
  };

  const view = {
    editor,
    file: world.active,
    getMode: () => world.viewMode,
  };

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
    } as unknown as AppLike["vault"],
    workspace: {
      markdownViewSymbol: sym,
      getActiveFile: () => world.active,
      getActiveViewOfType: (k: unknown) => (k === sym ? view : null),
      getLeaf: () => ({
        openFile: async (file: TFileLike) => {
          world.openCalls.push(file.path);
          world.active = world.files.get(file.path) ?? file;
        },
      }),
    },
    internalPlugins: world.dailyNotesConfig
      ? {
          plugins: {
            "daily-notes": {
              instance: { options: world.dailyNotesConfig },
            },
          },
        }
      : { plugins: {} },
    plugins: {
      plugins: world.tasksPluginEnabled ? { "obsidian-tasks-plugin": {} } : {},
    },
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
    now: () => new Date(2026, 5, 9, 12, 0, 0),
    vaultAwareness: () =>
      world.vaultAwareness ?? { ...DEFAULT_VAULT_AWARENESS_SETTINGS },
  };
}

function makeWorld(opts: Partial<FakeWorld> = {}): FakeWorld {
  return {
    files: new Map(),
    basePath: tmpRoot,
    active: null,
    viewMode: "source",
    editorBuffer: "",
    editorCursor: { line: 0, ch: 0 },
    openCalls: [],
    ...opts,
  };
}

describe("createNoteImpl", () => {
  test("creates a new note via richer surface and reports usedFallback: false", async () => {
    const world = makeWorld();
    const deps = makeDeps(world);
    const r = await createNoteImpl("foo.md", "hello", deps);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.kind).toBe("create_note");
      expect(r.path).toBe("foo.md");
      expect(r.undoSurface).toBe("journal");
      expect(typeof r.undoId).toBe("string");
      expect(r.usedFallback).toBe(false);
    }
    expect(world.files.get("foo.md")?.content).toBe("hello");
  });

  test("falls back to lower-level vault adapter when richer surface fails", async () => {
    const world = makeWorld();
    const deps = makeDeps(world);
    // Force ObsidianApi.createNote to throw so we exercise the fallback path.
    const origCreate = (deps.vault as { create?: unknown }).create as (
      p: string,
      d: string,
    ) => Promise<unknown>;
    let calls = 0;
    (deps.vault as unknown as { create: (p: string, d: string) => Promise<unknown> }).create =
      async (p: string, d: string) => {
        calls += 1;
        if (calls === 1) throw new Error("simulated native failure");
        return await origCreate(p, d);
      };
    const r = await createNoteImpl("foo.md", "hi", deps);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.usedFallback).toBe(true);
      expect(r.undoId).toBeTruthy();
    }
    expect(calls).toBe(2);
    expect(world.files.get("foo.md")?.content).toBe("hi");
  });

  test("returns collision error with note-flavored message", async () => {
    const world = makeWorld({
      files: new Map([["foo.md", { path: "foo.md", content: "x" }]]),
    });
    const deps = makeDeps(world);
    const r = await createNoteImpl("foo.md", "y", deps);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/already exists.*edit_note/);
  });

  test("rejects absolute paths via VaultPathError", async () => {
    const world = makeWorld();
    const deps = makeDeps(world);
    const r = await createNoteImpl("C:/elsewhere/foo.md", "x", deps);
    expect(r.ok).toBe(false);
  });
});

describe("editNoteImpl", () => {
  test("append concatenates and reports usedFallback: false", async () => {
    const world = makeWorld({
      files: new Map([["a.md", { path: "a.md", content: "hello" }]]),
    });
    const deps = makeDeps(world);
    const r = await editNoteImpl("a.md", "append", " world", deps);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.usedFallback).toBe(false);
    expect(world.files.get("a.md")?.content).toBe("hello world");
  });

  test("prepend prepends", async () => {
    const world = makeWorld({
      files: new Map([["a.md", { path: "a.md", content: "hello" }]]),
    });
    const deps = makeDeps(world);
    const r = await editNoteImpl("a.md", "prepend", "X ", deps);
    expect(r.ok).toBe(true);
    expect(world.files.get("a.md")?.content).toBe("X hello");
  });

  test("replace overwrites", async () => {
    const world = makeWorld({
      files: new Map([["a.md", { path: "a.md", content: "hello" }]]),
    });
    const deps = makeDeps(world);
    const r = await editNoteImpl("a.md", "replace", "fresh", deps);
    expect(r.ok).toBe(true);
    expect(world.files.get("a.md")?.content).toBe("fresh");
  });

  test("error when note doesn't exist", async () => {
    const world = makeWorld();
    const deps = makeDeps(world);
    const r = await editNoteImpl("missing.md", "append", "x", deps);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/does not exist.*create_note/);
  });

  test("falls back to editFileImpl when richer surface fails", async () => {
    const world = makeWorld({
      files: new Map([["a.md", { path: "a.md", content: "old" }]]),
    });
    const deps = makeDeps(world);
    const origModify = (deps.vault as { modify?: unknown }).modify as (
      f: TFileLike,
      d: string,
    ) => Promise<void>;
    let calls = 0;
    (deps.vault as unknown as { modify: (f: TFileLike, d: string) => Promise<void> }).modify =
      async (f: TFileLike, d: string) => {
        calls += 1;
        if (calls === 1) throw new Error("simulated native failure");
        return await origModify(f, d);
      };
    const r = await editNoteImpl("a.md", "replace", "fresh", deps);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.usedFallback).toBe(true);
    expect(calls).toBe(2);
    expect(world.files.get("a.md")?.content).toBe("fresh");
  });

  test("refuses to overwrite a dirty open editor on the richer-surface happy path", async () => {
    const world = makeWorld({
      files: new Map([["a.md", { path: "a.md", content: "on-disk" }]]),
    });
    const deps = makeDeps(world);
    // Fake a dirty open editor: getLeavesOfType returns a leaf whose
    // view.getViewData() differs from the on-disk content.
    const dirtyView = {
      file: { path: "a.md" },
      getViewData: () => "DIRTY-BUFFER",
    };
    (deps.workspace as unknown as {
      getLeavesOfType: (t: string) => Array<{ view: unknown }>;
    }).getLeavesOfType = (t: string) =>
      t === "markdown" ? [{ view: dirtyView }] : [];
    const r = await editNoteImpl("a.md", "replace", "fresh", deps);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/unsaved changes/i);
    // On-disk content untouched.
    expect(world.files.get("a.md")?.content).toBe("on-disk");
  });
});

describe("openNoteImpl", () => {
  test("opens an existing note", async () => {
    const world = makeWorld({
      files: new Map([["a.md", { path: "a.md", content: "hi" }]]),
    });
    const deps = makeDeps(world);
    const r = await openNoteImpl("a.md", deps);
    expect(r.ok).toBe(true);
    expect(world.openCalls).toEqual(["a.md"]);
  });

  test("error when note missing", async () => {
    const world = makeWorld();
    const deps = makeDeps(world);
    const r = await openNoteImpl("missing.md", deps);
    expect(r.ok).toBe(false);
  });
});

describe("insertIntoActiveNoteImpl", () => {
  test("uses editor surface when present and reports editor-native undo", async () => {
    const file: FakeFile = { path: "active.md", content: "AB" };
    const world = makeWorld({
      files: new Map([[file.path, file]]),
      active: file,
      editorBuffer: "AB",
    });
    const deps = makeDeps(world);
    const r = await insertIntoActiveNoteImpl("append", "C", deps);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.undoSurface).toBe("editor-native");
      expect(r.undoId).toBeUndefined();
      expect(r.path).toBe("active.md");
    }
    expect(world.editorBuffer).toBe("ABC");
  });

  test("permits inserts even in preview mode (FR-012 guard intentionally dropped)", async () => {
    const file: FakeFile = { path: "active.md", content: "x" };
    const world = makeWorld({
      files: new Map([[file.path, file]]),
      active: file,
      viewMode: "preview",
      editorBuffer: "x",
    });
    const deps = makeDeps(world);
    const r = await insertIntoActiveNoteImpl("append", "y", deps);
    expect(r.ok).toBe(true);
    expect(world.editorBuffer).toBe("xy");
  });

  test("error when no active note", async () => {
    const world = makeWorld();
    const deps = makeDeps(world);
    const r = await insertIntoActiveNoteImpl("append", "y", deps);
    expect(r.ok).toBe(false);
  });
});

describe("createDailyNoteImpl", () => {
  test("creates today's daily note at fallback path and opens it", async () => {
    const world = makeWorld();
    const deps = makeDeps(world);
    const r = await createDailyNoteImpl(deps);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.kind).toBe("create_daily_note");
      expect(r.path).toBe("2026-06-09.md");
      expect(r.source).toBe("fallback");
      expect(r.undoSurface).toBe("journal");
      expect(r.templateApplied).toBe(false);
    }
    expect(world.files.has("2026-06-09.md")).toBe(true);
    expect(world.files.get("2026-06-09.md")?.content).toBe("");
    expect(world.openCalls).toEqual(["2026-06-09.md"]);
  });

  test("opens existing daily note without creating a new entry", async () => {
    const existing: FakeFile = { path: "2026-06-09.md", content: "old" };
    const world = makeWorld({
      files: new Map([[existing.path, existing]]),
    });
    const deps = makeDeps(world);
    const r = await createDailyNoteImpl(deps);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.path).toBe("2026-06-09.md");
      // No new write, hence no journal undoId.
      expect(r.undoId).toBeUndefined();
    }
    expect(world.openCalls).toEqual(["2026-06-09.md"]);
    expect(world.files.get("2026-06-09.md")?.content).toBe("old");
  });

  test("applies the configured template when one is readable", async () => {
    const tpl: FakeFile = {
      path: "Templates/Daily.md",
      content: "# {{date}}\n\n- [ ] Plan\n",
    };
    const world = makeWorld({
      files: new Map([[tpl.path, tpl]]),
      dailyNotesConfig: { template: "Templates/Daily.md" },
    });
    const deps = makeDeps(world);
    const r = await createDailyNoteImpl(deps);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.templateApplied).toBe(true);
      expect(r.source).toBe("plugin-config");
    }
    expect(world.files.get("2026-06-09.md")?.content).toBe(tpl.content);
  });

  test("template path without .md extension is normalized", async () => {
    const tpl: FakeFile = { path: "Templates/Daily.md", content: "x" };
    const world = makeWorld({
      files: new Map([[tpl.path, tpl]]),
      dailyNotesConfig: { template: "Templates/Daily" },
    });
    const deps = makeDeps(world);
    const r = await createDailyNoteImpl(deps);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.templateApplied).toBe(true);
  });

  test("missing template file → empty note + templateApplied: false", async () => {
    const world = makeWorld({
      dailyNotesConfig: { template: "Templates/missing.md" },
    });
    const deps = makeDeps(world);
    const r = await createDailyNoteImpl(deps);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.templateApplied).toBe(false);
    expect(world.files.get("2026-06-09.md")?.content).toBe("");
  });
});

describe("insert_into_active_note path equivalence (gate ↔ handler)", () => {
  test("gate path === handler path — happy editor case", async () => {
    const file: FakeFile = { path: "active.md", content: "AB" };
    const world = makeWorld({
      files: new Map([[file.path, file]]),
      active: file,
      editorBuffer: "AB",
    });
    const deps = makeDeps(world);
    // Gate-side resolution (mirrors `safety.extractVaultPath` in main.ts)
    const gatePath = deps.api.getActiveNotePath();
    const r = await insertIntoActiveNoteImpl("append", "C", deps);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.path).toBe(gatePath);
  });

  test("gate path === handler path — disk fallback when editor missing", async () => {
    // Active file present but no editor view available.
    const file: FakeFile = { path: "active.md", content: "AB" };
    const world = makeWorld({
      files: new Map([[file.path, file]]),
      active: file,
      editorBuffer: "AB",
    });
    const deps = makeDeps(world);
    // Strip getActiveViewOfType so getEditorForActive returns no-editor.
    (deps.api as unknown as { app: AppLike }).app.workspace = {
      markdownViewSymbol: undefined,
      getActiveFile: () => world.active,
      getLeaf: () => ({ openFile: async () => undefined }),
    };
    const gatePath = deps.api.getActiveNotePath();
    expect(gatePath).toBe("active.md");
    const r = await insertIntoActiveNoteImpl("append", "C", deps);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.path).toBe(gatePath);
      // Disk path → journal undo, not editor-native.
      expect(r.undoSurface).toBe("journal");
      expect(typeof r.undoId).toBe("string");
    }
    expect(world.files.get("active.md")?.content).toBe("ABC");
  });
});

describe("createWriteNoteTools factory", () => {
  test("registers exactly create_note, edit_note, open_note, insert_into_active_note, create_daily_note, create_task", () => {
    const world = makeWorld();
    const deps = makeDeps(world);
    const tools = createWriteNoteTools(deps);
    const names = tools.map((t) => (t as unknown as { name: string }).name);
    expect(names).toEqual([
      "create_note",
      "edit_note",
      "open_note",
      "insert_into_active_note",
      "create_daily_note",
      "create_task",
    ]);
  });

  test("only open_note has skipPermission: true", () => {
    const world = makeWorld();
    const deps = makeDeps(world);
    const tools = createWriteNoteTools(deps);
    const skipFlags = tools.map(
      (t) => (t as unknown as { skipPermission?: boolean }).skipPermission ?? false,
    );
    expect(skipFlags).toEqual([false, false, true, false, false, false]);
  });
});

describe("create_daily_note path equivalence (gate ↔ handler)", () => {
  test("gate path equals handler path across multiple clock values", async () => {
    // Replicate the gate-side resolution that main.ts does:
    // `safety.extractVaultPath` returns resolveDailyNotePath(api, now()).path.
    const { resolveDailyNotePath } = await import("./DailyNotePath");
    const days = [
      new Date(2026, 0, 1),   // 2026-01-01
      new Date(2026, 5, 9),   // 2026-06-09
      new Date(2027, 11, 31), // 2027-12-31
    ];
    for (const day of days) {
      const world = makeWorld();
      const deps = { ...makeDeps(world), now: () => day };
      const gatePath = resolveDailyNotePath(deps.api, day).path;
      const r = await createDailyNoteImpl(deps);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.path).toBe(gatePath);
    }
  });
});


describe("createTaskImpl", () => {
  test("Tasks plugin present → emits emoji syntax and appends to existing daily note", async () => {
    const today: FakeFile = { path: "2026-06-09.md", content: "" };
    const world = makeWorld({
      files: new Map([[today.path, today]]),
      tasksPluginEnabled: true,
    });
    const deps = makeDeps(world);
    const r = await createTaskImpl(
      { description: "Email Bob", dueDate: "2026-06-12", priority: "high" },
      deps,
    );
    expect(r.ok).toBe(true);
    expect(r.formatSource).toBe("tasks-plugin");
    expect(r.targetPath).toBe("2026-06-09.md");
    expect(r.existingTargetCreated).toBe(false);
    expect(r.usedFallback).toBe(true);
    const written = world.files.get("2026-06-09.md")!.content!;
    expect(written).toBe("- [ ] Email Bob ⏫ 📅 2026-06-12\n");
  });

  test("Tasks plugin absent → emits GFM inline metadata", async () => {
    const today: FakeFile = { path: "2026-06-09.md", content: "Hello" };
    const world = makeWorld({
      files: new Map([[today.path, today]]),
      tasksPluginEnabled: false,
    });
    const deps = makeDeps(world);
    const r = await createTaskImpl(
      { description: "Write notes", scheduledDate: "2026-06-15" },
      deps,
    );
    expect(r.ok).toBe(true);
    expect(r.formatSource).toBe("gfm");
    const written = world.files.get("2026-06-09.md")!.content!;
    // Separator newline inserted before task because existing content didn't end with \n.
    expect(written).toBe("Hello\n- [ ] Write notes (scheduled: 2026-06-15)\n");
  });

  test("target daily note doesn't exist → creates it and reports existingTargetCreated: true", async () => {
    const world = makeWorld({ tasksPluginEnabled: false });
    const deps = makeDeps(world);
    const r = await createTaskImpl({ description: "Buy milk" }, deps);
    expect(r.ok).toBe(true);
    expect(r.existingTargetCreated).toBe(true);
    expect(r.targetPath).toBe("2026-06-09.md");
    expect(world.files.get("2026-06-09.md")?.content).toBe("- [ ] Buy milk\n");
  });

  test("daily-note target seeded from Daily Notes template when freshly created", async () => {
    const tpl: FakeFile = {
      path: "Templates/Daily.md",
      content: "# {{date}}\n\n## Tasks\n",
    };
    const world = makeWorld({
      files: new Map([[tpl.path, tpl]]),
      dailyNotesConfig: { template: "Templates/Daily.md" },
      tasksPluginEnabled: false,
    });
    const deps = makeDeps(world);
    const r = await createTaskImpl({ description: "Stretch" }, deps);
    expect(r.ok).toBe(true);
    expect(r.existingTargetCreated).toBe(true);
    const written = world.files.get("2026-06-09.md")!.content!;
    expect(written).toBe("# {{date}}\n\n## Tasks\n- [ ] Stretch\n");
  });

  test("custom-path mode appends to configured file and never touches the daily note", async () => {
    const inbox: FakeFile = { path: "Inbox.md", content: "Existing\n" };
    const world = makeWorld({
      files: new Map([[inbox.path, inbox]]),
      tasksPluginEnabled: false,
      vaultAwareness: {
        ...DEFAULT_VAULT_AWARENESS_SETTINGS,
        taskTargetMode: "custom-path",
        customTaskTargetPath: "Inbox.md",
      },
    });
    const deps = makeDeps(world);
    const r = await createTaskImpl({ description: "Triage" }, deps);
    expect(r.ok).toBe(true);
    expect(r.targetPath).toBe("Inbox.md");
    expect(r.existingTargetCreated).toBe(false);
    expect(world.files.get("Inbox.md")?.content).toBe(
      "Existing\n- [ ] Triage\n",
    );
    // Daily note must NOT be created in custom-path mode.
    expect(world.files.get("2026-06-09.md")).toBeUndefined();
  });

  test("custom-path mode whitespace-only target falls back to daily-note mode", async () => {
    const world = makeWorld({
      tasksPluginEnabled: false,
      vaultAwareness: {
        ...DEFAULT_VAULT_AWARENESS_SETTINGS,
        taskTargetMode: "custom-path",
        customTaskTargetPath: "   ",
      },
    });
    const deps = makeDeps(world);
    const r = await createTaskImpl({ description: "Plan" }, deps);
    expect(r.ok).toBe(true);
    expect(r.targetPath).toBe("2026-06-09.md");
  });

  test("rejects non-strict due dates without mutating the vault", async () => {
    const world = makeWorld({ tasksPluginEnabled: false });
    const deps = makeDeps(world);
    const r = await createTaskImpl(
      { description: "Reply", dueDate: "Friday" },
      deps,
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("invalid_date_format");
    expect(r.field).toBe("dueDate");
    expect(world.files.size).toBe(0);
  });

  test("rejects non-strict scheduled dates without mutating the vault", async () => {
    const world = makeWorld({ tasksPluginEnabled: false });
    const deps = makeDeps(world);
    const r = await createTaskImpl(
      { description: "Sync", scheduledDate: "2026/06/15" },
      deps,
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("invalid_date_format");
    expect(r.field).toBe("scheduledDate");
    expect(world.files.size).toBe(0);
  });

  test("rejects empty description without mutating the vault", async () => {
    const world = makeWorld({ tasksPluginEnabled: false });
    const deps = makeDeps(world);
    const r = await createTaskImpl({ description: "   " }, deps);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("missing_description");
    expect(world.files.size).toBe(0);
  });

  test("usedFallback is always true in current Phase-5 wiring (editFileImpl path)", async () => {
    const today: FakeFile = { path: "2026-06-09.md", content: "" };
    const world = makeWorld({
      files: new Map([[today.path, today]]),
      tasksPluginEnabled: false,
    });
    const deps = makeDeps(world);
    const r = await createTaskImpl({ description: "Anything" }, deps);
    expect(r.ok).toBe(true);
    expect(r.usedFallback).toBe(true);
  });

  test("refuses to append when the target has unsaved editor changes", async () => {
    const today: FakeFile = { path: "2026-06-09.md", content: "On disk" };
    const world = makeWorld({
      files: new Map([[today.path, today]]),
      tasksPluginEnabled: false,
    });
    const deps = makeDeps(world);
    // Wire a dirty leaf for the daily-note path so hasUnsavedEditorChanges trips.
    const dirtyView = {
      file: { path: "2026-06-09.md" },
      getViewData: () => "In editor (dirty)",
    };
    (deps.workspace as unknown as {
      getLeavesOfType: (t: string) => Array<{ view: unknown }>;
    }).getLeavesOfType = (t: string) =>
      t === "markdown" ? [{ view: dirtyView }] : [];
    const r = await createTaskImpl({ description: "Skip me" }, deps);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/unsaved changes/);
    // Disk content untouched.
    expect(world.files.get("2026-06-09.md")?.content).toBe("On disk");
  });
});