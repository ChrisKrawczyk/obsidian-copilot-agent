import { describe, expect, test, beforeAll, afterAll } from "vitest";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import {
  ObsidianApi,
  type AppLike,
  type EditorPos,
  type FileCacheLike,
  MAX_TREE_NODES,
} from "./ObsidianApi";
import type { ReadToolsVault, TFileLike } from "./ReadTools";

let tmpRoot: string;

beforeAll(() => {
  tmpRoot = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "copilot-agent-obsidianapi-")),
  );
  fs.mkdirSync(path.join(tmpRoot, "inbox"), { recursive: true });
  fs.mkdirSync(path.join(tmpRoot, "projects"), { recursive: true });
});

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

interface NodeStat {
  size: number;
  mtime: number;
}

interface FixtureFile extends TFileLike {
  stat?: NodeStat;
}

function makeApp(opts: {
  activeFile?: TFileLike | null;
  files?: FixtureFile[];
  folders?: string[];
  resolvedLinks?: Record<string, Record<string, number>>;
  fileCaches?: Map<string, FileCacheLike>;
}): AppLike {
  const files = opts.files ?? [];
  const folders = new Set(opts.folders ?? []);

  // Build a folder→children map for abstract-file lookups.
  const folderChildren = new Map<
    string,
    Array<{ path: string; name: string; extension?: string; stat?: NodeStat }>
  >();
  for (const folder of folders) {
    folderChildren.set(folder, []);
  }
  for (const f of files) {
    const parent = f.path.includes("/")
      ? f.path.slice(0, f.path.lastIndexOf("/"))
      : "";
    if (!folderChildren.has(parent)) folderChildren.set(parent, []);
    folderChildren.get(parent)!.push({
      path: f.path,
      name: f.path.split("/").pop()!,
      extension: f.extension ?? "md",
      stat: f.stat,
    });
  }
  for (const folder of folders) {
    if (folder === "") continue;
    const parent = folder.includes("/")
      ? folder.slice(0, folder.lastIndexOf("/"))
      : "";
    if (!folderChildren.has(parent)) folderChildren.set(parent, []);
    if (!folderChildren.get(parent)!.some((c) => c.path === folder)) {
      folderChildren.get(parent)!.push({
        path: folder,
        name: folder.split("/").pop()!,
      });
    }
  }

  const vault: ReadToolsVault = {
    adapter: { getBasePath: () => tmpRoot },
    getFileByPath: (p) => files.find((f) => f.path === p) ?? null,
    getAbstractFileByPath: (p) => {
      if (p === "" || p === "/") {
        const children = (folderChildren.get("") ?? []).map((c) => ({
          ...c,
          children: folderChildren.get(c.path),
        }));
        return { path: "", name: "", children } as unknown as TFileLike;
      }
      const file = files.find((f) => f.path === p);
      if (file) return file;
      if (folders.has(p)) {
        const kids = (folderChildren.get(p) ?? []).map((c) => ({
          ...c,
          children: folderChildren.get(c.path),
        }));
        return { path: p, name: p.split("/").pop()!, children: kids } as unknown as TFileLike;
      }
      return null;
    },
    getMarkdownFiles: () => files,
    getFiles: () => files,
    read: async (file) => `content of ${file.path}`,
    cachedRead: async (file) => `content of ${file.path}`,
  };

  return {
    vault,
    workspace: { getActiveFile: () => opts.activeFile ?? null },
    metadataCache: {
      resolvedLinks: opts.resolvedLinks,
      getFileCache: opts.fileCaches
        ? (file) => opts.fileCaches!.get(file.path) ?? null
        : undefined,
    },
  };
}

describe("ObsidianApi error-shape: native calls that throw return discriminated union", () => {
  test("listRecentlyModifiedNotes converts a thrown getMarkdownFiles into native-failed", () => {
    const app: AppLike = {
      vault: {
        adapter: { getBasePath: () => tmpRoot },
        getMarkdownFiles: () => {
          throw new Error("kaboom");
        },
      },
    };
    const r = new ObsidianApi(app).listRecentlyModifiedNotes(5);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("native-failed");
  });

  test("getFileCache converts a thrown getFileCache into native-failed", () => {
    const file: TFileLike = { path: "n.md", extension: "md" };
    const app: AppLike = {
      vault: { adapter: { getBasePath: () => tmpRoot } },
      metadataCache: {
        getFileCache: () => {
          throw new Error("kaboom");
        },
      },
    };
    const r = new ObsidianApi(app).getFileCache(file);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("native-failed");
  });

  test("getVaultTree converts a thrown getAbstractFileByPath into native-failed", () => {
    const app: AppLike = {
      vault: {
        adapter: { getBasePath: () => tmpRoot },
        getAbstractFileByPath: () => {
          throw new Error("kaboom");
        },
      },
    };
    const r = new ObsidianApi(app).getVaultTree("inbox", 2);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("native-failed");
  });
});

describe("ObsidianApi.getActiveFile", () => {
  test("returns the active file when one is focused", () => {
    const file: TFileLike = { path: "inbox/today.md", extension: "md" };
    const api = new ObsidianApi(makeApp({ activeFile: file }));
    const r = api.getActiveFile();
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.path).toBe("inbox/today.md");
  });

  test("returns no-active-note when no markdown view is focused", () => {
    const api = new ObsidianApi(makeApp({ activeFile: null }));
    const r = api.getActiveFile();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("no-active-note");
  });

  test("returns no-active-note for a non-markdown active file (PDF/canvas)", () => {
    const file: TFileLike = { path: "diagram.canvas", extension: "canvas" };
    const api = new ObsidianApi(makeApp({ activeFile: file }));
    const r = api.getActiveFile();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("no-active-note");
  });

  test("returns native-failed when getActiveFile throws", () => {
    const app: AppLike = {
      vault: { adapter: { getBasePath: () => tmpRoot } },
      workspace: {
        getActiveFile: () => {
          throw new Error("kaboom");
        },
      },
    };
    const r = new ObsidianApi(app).getActiveFile();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("native-failed");
  });
});

describe("ObsidianApi.listRecentlyModifiedNotes", () => {
  test("returns markdown files sorted by mtime descending, clamped to maxN", () => {
    const files: FixtureFile[] = [
      { path: "a.md", extension: "md", stat: { size: 1, mtime: 100 } },
      { path: "b.md", extension: "md", stat: { size: 1, mtime: 300 } },
      { path: "c.md", extension: "md", stat: { size: 1, mtime: 200 } },
    ];
    const api = new ObsidianApi(makeApp({ files }));
    const r = api.listRecentlyModifiedNotes(2);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.map((f) => f.path)).toEqual(["b.md", "c.md"]);
  });

  test("clamps maxN to [1, 100]", () => {
    const files: FixtureFile[] = Array.from({ length: 150 }, (_, i) => ({
      path: `n${i}.md`,
      extension: "md",
      stat: { size: 1, mtime: i },
    }));
    const api = new ObsidianApi(makeApp({ files }));
    const r = api.listRecentlyModifiedNotes(500);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.length).toBe(100);
  });

  test("returns index-unavailable when vault has no getMarkdownFiles", () => {
    const app: AppLike = {
      vault: { adapter: { getBasePath: () => tmpRoot } },
    };
    const api = new ObsidianApi(app);
    const r = api.listRecentlyModifiedNotes(10);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("index-unavailable");
  });
});

describe("ObsidianApi.getResolvedLinks", () => {
  test("returns the metadataCache resolvedLinks map", () => {
    const map = { "a.md": { "b.md": 1 } };
    const api = new ObsidianApi(makeApp({ resolvedLinks: map }));
    const r = api.getResolvedLinks();
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual(map);
  });

  test("returns index-unavailable when metadataCache is missing", () => {
    const api = new ObsidianApi(makeApp({}));
    const r = api.getResolvedLinks();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("index-unavailable");
  });
});

describe("ObsidianApi.getFileCache", () => {
  test("returns the cached entry when present", () => {
    const file: TFileLike = { path: "n.md", extension: "md" };
    const cache: FileCacheLike = {
      tags: [{ tag: "#x" }],
      headings: [{ heading: "H", level: 1 }],
    };
    const fileCaches = new Map([["n.md", cache]]);
    const api = new ObsidianApi(makeApp({ files: [file], fileCaches }));
    const r = api.getFileCache(file);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.tags?.[0].tag).toBe("#x");
  });

  test("returns not-found when getFileCache returns null", () => {
    const api = new ObsidianApi(
      makeApp({ fileCaches: new Map() }),
    );
    const r = api.getFileCache({ path: "missing.md", extension: "md" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("not-found");
  });

  test("returns index-unavailable when metadataCache.getFileCache is missing", () => {
    const api = new ObsidianApi(makeApp({}));
    const r = api.getFileCache({ path: "n.md", extension: "md" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("index-unavailable");
  });

  // Regression: Obsidian's native metadataCache.getFileCache uses `this`.
  // Extracting the function and calling it bare ("const fn = mc.getFileCache;
  // fn(file)") loses `this` and the native impl throws — masking real
  // backlinks as "no source-cache available". We must invoke as a method
  // on the metadataCache object.
  test("preserves `this` when calling native getFileCache", () => {
    const file: TFileLike = { path: "n.md", extension: "md" };
    const cache: FileCacheLike = { tags: [{ tag: "#ok" }] };
    let calledWithThis: unknown = "uninit";
    const metadataCache = {
      resolvedLinks: {} as Record<string, Record<string, number>>,
      // Use a plain function so we can observe the bound `this`.
      getFileCache(this: unknown, _f: TFileLike): FileCacheLike | null {
        calledWithThis = this;
        if (this !== metadataCache) {
          throw new TypeError(
            "native getFileCache invoked without metadataCache as `this`",
          );
        }
        return cache;
      },
    };
    const api = new ObsidianApi({
      vault: { getMarkdownFiles: () => [file] } as unknown as AppLike["vault"],
      metadataCache: metadataCache as unknown as AppLike["metadataCache"],
    });
    const r = api.getFileCache(file);
    expect(r.ok).toBe(true);
    expect(calledWithThis).toBe(metadataCache);
  });
});

describe("ObsidianApi.getVaultTree", () => {
  test("returns root + children at default depth=2", () => {
    const files: FixtureFile[] = [
      { path: "a.md", extension: "md" },
      { path: "inbox/today.md", extension: "md" },
      { path: "projects/alpha/spec.md", extension: "md" },
    ];
    const api = new ObsidianApi(
      makeApp({ files, folders: ["inbox", "projects", "projects/alpha"] }),
    );
    const r = api.getVaultTree("");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.root.kind).toBe("folder");
    const childNames = r.value.root.children!.map((c) => c.name).sort();
    expect(childNames).toContain("a.md");
    expect(childNames).toContain("inbox");
    expect(r.value.truncated).toBe(false);
  });

  test("clamps depth to MAX_TREE_DEPTH (5)", () => {
    const files: FixtureFile[] = [{ path: "a.md", extension: "md" }];
    const api = new ObsidianApi(makeApp({ files }));
    const r = api.getVaultTree("", 999);
    expect(r.ok).toBe(true);
  });

  test("returns not-found for unknown folder", () => {
    const api = new ObsidianApi(makeApp({}));
    const r = api.getVaultTree("does/not/exist");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("not-found");
  });

  test("returns invalid-path for traversal escape", () => {
    const api = new ObsidianApi(makeApp({}));
    const r = api.getVaultTree("inbox/../../etc");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("invalid-path");
  });

  test("reports truncated=true once MAX_TREE_NODES is hit", () => {
    const files: FixtureFile[] = Array.from(
      { length: MAX_TREE_NODES + 50 },
      (_, i) => ({ path: `n${i}.md`, extension: "md" }),
    );
    const api = new ObsidianApi(makeApp({ files }));
    const r = api.getVaultTree("");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.truncated).toBe(true);
    expect(r.value.truncatedAt).toBeDefined();
    expect(r.value.nodeCount).toBeLessThanOrEqual(MAX_TREE_NODES);
  });
});

describe("ObsidianApi.openFile (Phase 4 helper)", () => {
  test("delegates to workspace.getLeaf(false).openFile", async () => {
    const file: TFileLike = { path: "n.md", extension: "md" };
    let opened: TFileLike | null = null;
    const app: AppLike = {
      vault: { adapter: { getBasePath: () => tmpRoot } },
      workspace: {
        getLeaf: () => ({
          openFile: async (f: TFileLike) => {
            opened = f;
          },
        }),
      },
    };
    const r = await new ObsidianApi(app).openFile(file);
    expect(r.ok).toBe(true);
    expect(opened).toEqual(file);
  });

  test("returns native-failed when openFile throws", async () => {
    const app: AppLike = {
      vault: { adapter: { getBasePath: () => tmpRoot } },
      workspace: {
        getLeaf: () => ({
          openFile: async () => {
            throw new Error("kaboom");
          },
        }),
      },
    };
    const r = await new ObsidianApi(app).openFile({
      path: "n.md",
      extension: "md",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("native-failed");
  });
});

describe("ObsidianApi.getEditorForActive / applyEditorTransform", () => {
  function makeAppWithEditor(initial: string, initialCursor?: EditorPos): {
    app: AppLike;
    captured: { value: string; cursor: EditorPos };
  } {
    const captured = {
      value: initial,
      cursor: initialCursor ?? { line: 0, ch: 0 },
    };
    const editor = {
      getValue: () => captured.value,
      replaceRange: (text: string, from: EditorPos, to?: EditorPos) => {
        const lines = captured.value.split("\n");
        const toPos =
          to ?? {
            line: from.line,
            ch: from.ch,
          };
        // Reconstruct via offsets so we don't have to manage line splices.
        const offsetFrom = posToOffset(captured.value, from);
        const offsetTo = posToOffset(captured.value, toPos);
        captured.value =
          captured.value.slice(0, offsetFrom) +
          text +
          captured.value.slice(offsetTo);
        // Silence unused-warning by referencing lines.
        void lines;
      },
      getCursor: () => captured.cursor,
      setCursor: (pos: EditorPos) => {
        captured.cursor = pos;
      },
    };
    const file: TFileLike = { path: "active.md", extension: "md" };
    const app: AppLike = {
      vault: { adapter: { getBasePath: () => tmpRoot } },
      workspace: {
        getActiveViewOfType: () => ({ editor, file }),
      },
    };
    return { app, captured };
  }

  function posToOffset(text: string, pos: EditorPos): number {
    const lines = text.split("\n");
    let off = 0;
    for (let i = 0; i < pos.line && i < lines.length; i++) {
      off += lines[i].length + 1; // +1 for the \n
    }
    return off + pos.ch;
  }

  test("getEditorForActive returns the active editor", () => {
    const { app } = makeAppWithEditor("hi");
    const r = new ObsidianApi(app).getEditorForActive();
    expect(r.ok).toBe(true);
  });

  test("getEditorForActive returns no-editor when no markdown view focused", () => {
    const app: AppLike = {
      vault: { adapter: { getBasePath: () => tmpRoot } },
      workspace: { getActiveViewOfType: () => null },
    };
    const r = new ObsidianApi(app).getEditorForActive();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("no-editor");
  });

  test("applyEditorTransform append concatenates and leaves cursor unchanged", () => {
    const { app, captured } = makeAppWithEditor("hi", { line: 0, ch: 1 });
    const r = new ObsidianApi(app).applyEditorTransform("append", "!\n");
    expect(r.ok).toBe(true);
    expect(captured.value).toBe("hi!\n");
    // FR-012: append leaves cursor in place.
    expect(captured.cursor).toEqual({ line: 0, ch: 1 });
  });

  test("applyEditorTransform prepend single-line shifts cursor column", () => {
    const { app, captured } = makeAppWithEditor("body", { line: 0, ch: 2 });
    const r = new ObsidianApi(app).applyEditorTransform("prepend", "head");
    expect(r.ok).toBe(true);
    expect(captured.value).toBe("headbody");
    // FR-012: prepend shifts cursor by the inserted code-point count.
    expect(captured.cursor).toEqual({ line: 0, ch: 6 });
  });

  test("applyEditorTransform prepend multi-line shifts cursor down by inserted line count", () => {
    const { app, captured } = makeAppWithEditor("body", { line: 0, ch: 0 });
    const r = new ObsidianApi(app).applyEditorTransform(
      "prepend",
      "L1\nL2\n",
    );
    expect(r.ok).toBe(true);
    expect(captured.value).toBe("L1\nL2\nbody");
    expect(captured.cursor.line).toBe(2);
  });

  test("applyEditorTransform replace overwrites and moves cursor to end", () => {
    const { app, captured } = makeAppWithEditor("old", { line: 0, ch: 1 });
    const r = new ObsidianApi(app).applyEditorTransform(
      "replace",
      "new content",
    );
    expect(r.ok).toBe(true);
    expect(captured.value).toBe("new content");
    expect(captured.cursor).toEqual({ line: 0, ch: 11 });
  });
});

describe("ObsidianApi.getDailyNotesConfig / isCommunityPluginEnabled", () => {
  test("returns plugin-not-enabled when daily-notes is not present", () => {
    const app: AppLike = {
      vault: { adapter: { getBasePath: () => tmpRoot } },
    };
    const r = new ObsidianApi(app).getDailyNotesConfig();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("plugin-not-enabled");
  });

  test("returns daily-notes options when enabled", () => {
    const app: AppLike = {
      vault: { adapter: { getBasePath: () => tmpRoot } },
      internalPlugins: {
        plugins: {
          "daily-notes": {
            instance: {
              options: { folder: "Daily", format: "YYYY-MM-DD", template: "" },
            },
          },
        },
      },
    };
    const r = new ObsidianApi(app).getDailyNotesConfig();
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.folder).toBe("Daily");
  });

  test("isCommunityPluginEnabled reflects plugins map", () => {
    const app: AppLike = {
      vault: { adapter: { getBasePath: () => tmpRoot } },
      plugins: { plugins: { "obsidian-tasks-plugin": {} } },
    };
    const api = new ObsidianApi(app);
    expect(api.isCommunityPluginEnabled("obsidian-tasks-plugin")).toBe(true);
    expect(api.isCommunityPluginEnabled("not-installed")).toBe(false);
  });
});
