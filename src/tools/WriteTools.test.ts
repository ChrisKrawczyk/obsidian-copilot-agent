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
} {
  const files = new Map<string, string>(Object.entries(initialFiles));
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
    trash: async (file) => {
      files.delete(file.path);
      try {
        fs.unlinkSync(path.join(tmpRoot, file.path));
      } catch {}
    },
  };
  return { vault, files };
}

function makeDeps(initialFiles: Record<string, string> = {}): WriteToolsDeps & {
  files: Map<string, string>;
  journal: UndoJournal;
} {
  const { vault, files } = makeVault(initialFiles);
  const journal = new UndoJournal(vault);
  return { vault, undoJournal: journal, files, journal };
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
