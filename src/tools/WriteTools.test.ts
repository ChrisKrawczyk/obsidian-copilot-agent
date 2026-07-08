import { describe, expect, test, beforeAll, afterAll, beforeEach } from "vitest";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import {
  createFileImpl,
  editFileImpl,
  deleteFileImpl,
  hasUnsavedEditorChanges,
  createWriteTools,
  processFileImpl,
  ProcessAbort,
  type WriteToolsVault,
  type WriteToolsDeps,
  WRITE_TOOL_NAMES,
} from "./WriteTools";
import { UndoJournal } from "../domain/UndoJournal";
import type { TFileLike } from "./ReadTools";

let tmpRoot: string;

beforeAll(() => {
  tmpRoot = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "copilot-agent-writetools-")),
  );
  fs.mkdirSync(path.join(tmpRoot, "inbox"), { recursive: true });
});

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function makeVault(initialFiles: Record<string, string> = {}): {
  vault: WriteToolsVault;
  files: Map<string, string>;
  processInFlight: () => number;
  processCounts: () => Map<string, number>;
} {
  const files = new Map<string, string>(Object.entries(initialFiles));
  // Per-path chain of pending `process` calls to serialize concurrent
  // callers deterministically, matching Obsidian's atomic RMW.
  const chains = new Map<string, Promise<unknown>>();
  const inFlight = new Map<string, number>();
  const counts = new Map<string, number>();
  const bumpInFlight = (p: string, delta: number) => {
    const n = (inFlight.get(p) ?? 0) + delta;
    if (n <= 0) inFlight.delete(p);
    else inFlight.set(p, n);
  };
  const vault: WriteToolsVault = {
    adapter: { getBasePath: () => tmpRoot },
    getFileByPath: (p) =>
      files.has(p) ? ({ path: p, extension: "md" } satisfies TFileLike) : null,
    getAbstractFileByPath: (p) =>
      files.has(p) ? ({ path: p, extension: "md" } satisfies TFileLike) : null,
    getMarkdownFiles: () =>
      [...files.keys()].map((p) => ({ path: p, extension: "md" })),
    getFiles: () =>
      [...files.keys()].map((p) => ({ path: p, extension: "md" })),
    read: async (file) => files.get(file.path) ?? "",
    cachedRead: async (file) => files.get(file.path) ?? "",
    create: async (p, c) => {
      if (files.has(p)) throw new Error(`exists: ${p}`);
      // Mirror to disk so resolveVaultPath/realpath works.
      const abs = path.join(tmpRoot, p);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, c);
      files.set(p, c);
      return { path: p };
    },
    modify: async (file, c) => {
      files.set(file.path, c);
      fs.writeFileSync(path.join(tmpRoot, file.path), c);
      return file;
    },
    process: async (file, fn) => {
      const p = file.path;
      counts.set(p, (counts.get(p) ?? 0) + 1);
      bumpInFlight(p, 1);
      const prev = chains.get(p) ?? Promise.resolve();
      const run = prev.then(async () => {
        const before = files.get(p) ?? "";
        const after = fn(before);
        files.set(p, after);
        fs.writeFileSync(path.join(tmpRoot, p), after);
        return after;
      });
      chains.set(
        p,
        run.catch(() => undefined),
      );
      try {
        return await run;
      } finally {
        bumpInFlight(p, -1);
      }
    },
    trash: async (file) => {
      files.delete(file.path);
      try {
        fs.unlinkSync(path.join(tmpRoot, file.path));
      } catch {}
    },
  };
  return {
    vault,
    files,
    processInFlight: () => {
      let max = 0;
      for (const n of inFlight.values()) if (n > max) max = n;
      return max;
    },
    processCounts: () => new Map(counts),
  };
}

function makeDeps(initialFiles: Record<string, string> = {}): WriteToolsDeps & {
  files: Map<string, string>;
  journal: UndoJournal;
  processInFlight: () => number;
  processCounts: () => Map<string, number>;
} {
  const v = makeVault(initialFiles);
  const journal = new UndoJournal(v.vault);
  return {
    vault: v.vault,
    undoJournal: journal,
    files: v.files,
    journal,
    processInFlight: v.processInFlight,
    processCounts: v.processCounts,
  };
}

describe("createFileImpl", () => {
  test("creates a new file and records undo", async () => {
    const deps = makeDeps();
    const r = await createFileImpl("inbox/new.md", "hello", deps);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.path).toBe("inbox/new.md");
    expect(deps.files.get("inbox/new.md")).toBe("hello");
    const entry = deps.journal.get(r.undoId);
    expect(entry?.kind).toBe("create");
  });

  test("refuses when file already exists", async () => {
    const deps = makeDeps({ "inbox/x.md": "existing" });
    const r = await createFileImpl("inbox/x.md", "new", deps);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/already exists/i);
  });

  test("rejects path traversal", async () => {
    const deps = makeDeps();
    const r = await createFileImpl("../escape.md", "x", deps);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/traversal/i);
  });

  test("rejects Windows-absolute path", async () => {
    const deps = makeDeps();
    const r = await createFileImpl("C:\\evil.md", "x", deps);
    expect(r.ok).toBe(false);
  });
});

describe("editFileImpl", () => {
  test("overwrites and records before/after for undo", async () => {
    const deps = makeDeps({ "inbox/x.md": "BEFORE" });
    const r = await editFileImpl("inbox/x.md", "AFTER", deps);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(deps.files.get("inbox/x.md")).toBe("AFTER");
    const entry = deps.journal.get(r.undoId);
    expect(entry?.kind).toBe("modify");
    expect(entry?.before).toBe("BEFORE");
    expect(entry?.after).toBe("AFTER");
  });

  test("refuses when file does not exist", async () => {
    const deps = makeDeps();
    const r = await editFileImpl("missing.md", "x", deps);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/does not exist/i);
  });

  test("refuses on unsaved-editor conflict", async () => {
    const deps = makeDeps({ "notes.md": "DISK" });
    const r = await editFileImpl("notes.md", "NEW", {
      ...deps,
      workspace: {
        getLeavesOfType: () => [
          {
            view: {
              file: { path: "notes.md" },
              getViewData: () => "DIRTY_BUFFER",
            },
          },
        ],
      },
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/unsaved changes/i);
    expect(deps.files.get("notes.md")).toBe("DISK");
  });

  test("proceeds when editor buffer matches disk (no conflict)", async () => {
    const deps = makeDeps({ "notes.md": "MATCH" });
    const r = await editFileImpl("notes.md", "NEW", {
      ...deps,
      workspace: {
        getLeavesOfType: () => [
          {
            view: {
              file: { path: "notes.md" },
              getViewData: () => "MATCH",
            },
          },
        ],
      },
    });
    expect(r.ok).toBe(true);
  });
});

describe("processFileImpl", () => {
  test("records undo with before from callback input and after from callback return", async () => {
    const deps = makeDeps({ "inbox/x.md": "ORIG" });
    const r = await processFileImpl(
      "inbox/x.md",
      (data) => data + "\nappended",
      deps,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.kind).toBe("modify");
    expect(r.changed).toBe(true);
    if (!r.changed) return;
    expect(deps.files.get("inbox/x.md")).toBe("ORIG\nappended");
    const entry = deps.journal.get(r.undoId);
    expect(entry?.kind).toBe("modify");
    expect(entry?.before).toBe("ORIG");
    expect(entry?.after).toBe("ORIG\nappended");
  });

  test("no-op: callback returns unchanged content — no write, no undo", async () => {
    const deps = makeDeps({ "inbox/x.md": "SAME" });
    const r = await processFileImpl("inbox/x.md", (data) => data, deps);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.changed).toBe(false);
    // No undoId in the no-op branch — nothing to undo.
    expect((r as { undoId?: string }).undoId).toBeUndefined();
  });

  test("ProcessAbort → ok:false with aborted:true, no write, no undo", async () => {
    const deps = makeDeps({ "inbox/x.md": "KEEP" });
    const r = await processFileImpl(
      "inbox/x.md",
      () => {
        throw new ProcessAbort("target line not found");
      },
      deps,
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.aborted).toBe(true);
    expect(r.error).toMatch(/target line not found/);
    expect(deps.files.get("inbox/x.md")).toBe("KEEP");
  });

  test("refuses when file does not exist", async () => {
    const deps = makeDeps();
    const r = await processFileImpl("missing.md", (d) => d + "!", deps);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/does not exist/i);
  });

  test("refuses on unsaved-editor conflict (guard runs before atomic section)", async () => {
    const deps = makeDeps({ "notes.md": "DISK" });
    const r = await processFileImpl("notes.md", (d) => d + "X", {
      ...deps,
      workspace: {
        getLeavesOfType: () => [
          {
            view: {
              file: { path: "notes.md" },
              getViewData: () => "DIRTY_BUFFER",
            },
          },
        ],
      },
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/unsaved changes/i);
    expect(deps.files.get("notes.md")).toBe("DISK");
  });

  test("falls back to modify() when vault lacks process()", async () => {
    const deps = makeDeps({ "inbox/x.md": "ORIG" });
    // Remove process to force fallback.
    (deps.vault as { process?: unknown }).process = undefined;
    const r = await processFileImpl(
      "inbox/x.md",
      (data) => data + " + fallback",
      deps,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.changed).toBe(true);
    if (!r.changed) return;
    expect(deps.files.get("inbox/x.md")).toBe("ORIG + fallback");
    const entry = deps.journal.get(r.undoId);
    expect(entry?.before).toBe("ORIG");
    expect(entry?.after).toBe("ORIG + fallback");
  });

  test("fallback path honors ProcessAbort", async () => {
    const deps = makeDeps({ "inbox/x.md": "KEEP" });
    (deps.vault as { process?: unknown }).process = undefined;
    const r = await processFileImpl(
      "inbox/x.md",
      () => {
        throw new ProcessAbort("nothing to do");
      },
      deps,
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.aborted).toBe(true);
    expect(r.error).toMatch(/nothing to do/);
    expect(deps.files.get("inbox/x.md")).toBe("KEEP");
  });

  test("parallel same-path callers see linearized before/after (no lost updates)", async () => {
    const deps = makeDeps({ "inbox/log.md": "" });
    const N = 20;
    const results = await Promise.all(
      Array.from({ length: N }, (_, i) =>
        processFileImpl(
          "inbox/log.md",
          (data) => (data ? data + "\n" : "") + `line-${i}`,
          deps,
        ),
      ),
    );
    for (const r of results) expect(r.ok).toBe(true);
    const final = deps.files.get("inbox/log.md") ?? "";
    const lines = final.split("\n").filter((l) => l.length > 0);
    expect(lines.length).toBe(N);
    // Every line-i must appear exactly once.
    const seen = new Set(lines);
    expect(seen.size).toBe(N);
    for (let i = 0; i < N; i++) expect(seen.has(`line-${i}`)).toBe(true);
  });
});

describe("deleteFileImpl", () => {
  test("trashes and records before for undo", async () => {
    const deps = makeDeps({ "trash-me.md": "GOODBYE" });
    const r = await deleteFileImpl("trash-me.md", deps);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(deps.files.has("trash-me.md")).toBe(false);
    const entry = deps.journal.get(r.undoId);
    expect(entry?.kind).toBe("delete");
    expect(entry?.before).toBe("GOODBYE");
  });

  test("refuses when file does not exist", async () => {
    const deps = makeDeps();
    const r = await deleteFileImpl("phantom.md", deps);
    expect(r.ok).toBe(false);
  });
});

describe("hasUnsavedEditorChanges", () => {
  test("returns false when workspace is undefined", async () => {
    expect(await hasUnsavedEditorChanges("x.md", "disk", undefined)).toBe(false);
  });
  test("returns false when no leaves match path", async () => {
    const r = await hasUnsavedEditorChanges("x.md", "disk", {
      getLeavesOfType: () => [
        { view: { file: { path: "other.md" }, getViewData: () => "anything" } },
      ],
    });
    expect(r).toBe(false);
  });
});

describe("createWriteTools", () => {
  test("returns three tools with overridesBuiltInTool", () => {
    const deps = makeDeps();
    const tools = createWriteTools(deps);
    expect(tools.map((t) => t.name).sort()).toEqual([
      "create_file",
      "delete_file",
      "edit_file",
    ]);
    expect(tools.every((t) => t.overridesBuiltInTool === true)).toBe(true);
    // None should skipPermission — writes go through SafetyPolicy.
    expect(tools.every((t) => t.skipPermission !== true)).toBe(true);
  });
  test("WRITE_TOOL_NAMES matches", () => {
    expect([...WRITE_TOOL_NAMES].sort()).toEqual([
      "create_file",
      "delete_file",
      "edit_file",
    ]);
  });
});
