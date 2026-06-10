import { describe, expect, test, beforeAll, afterAll } from "vitest";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import {
  createReadNoteTools,
  getActiveNoteImpl,
  listRecentNotesImpl,
  findBacklinksImpl,
  vaultTreeImpl,
  vaultMetadataImpl,
  READ_NOTE_TOOL_NAMES,
} from "./ReadNoteTools";
import {
  ObsidianApi,
  type AppLike,
  type FileCacheLike,
} from "./ObsidianApi";
import type { ReadToolsVault, TFileLike } from "./ReadTools";

let tmpRoot: string;

beforeAll(() => {
  tmpRoot = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "copilot-agent-readnote-")),
  );
  fs.mkdirSync(path.join(tmpRoot, "inbox"), { recursive: true });
  fs.mkdirSync(path.join(tmpRoot, "projects"), { recursive: true });
});

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

interface FixtureFile extends TFileLike {
  stat?: { size: number; mtime: number };
}

function makeApp(opts: {
  activeFile?: TFileLike | null;
  files?: FixtureFile[];
  folders?: string[];
  resolvedLinks?: Record<string, Record<string, number>>;
  fileCaches?: Map<string, FileCacheLike>;
  fileContents?: Map<string, string>;
}): { app: AppLike; vault: ReadToolsVault } {
  const files = opts.files ?? [];
  const folders = new Set(opts.folders ?? []);

  const folderChildren = new Map<
    string,
    Array<{ path: string; name: string; extension?: string; stat?: { size: number; mtime: number } }>
  >();
  for (const folder of folders) folderChildren.set(folder, []);
  for (const f of files) {
    const parent = f.path.includes("/") ? f.path.slice(0, f.path.lastIndexOf("/")) : "";
    if (!folderChildren.has(parent)) folderChildren.set(parent, []);
    folderChildren.get(parent)!.push({
      path: f.path,
      name: f.path.split("/").pop()!,
      extension: f.extension ?? "md",
      stat: f.stat,
    });
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
    read: async (file) =>
      opts.fileContents?.get(file.path) ?? `content of ${file.path}`,
    cachedRead: async (file) =>
      opts.fileContents?.get(file.path) ?? `content of ${file.path}`,
  };

  const app: AppLike = {
    vault,
    workspace: { getActiveFile: () => opts.activeFile ?? null },
    metadataCache: {
      resolvedLinks: opts.resolvedLinks,
      getFileCache: opts.fileCaches
        ? (file) => opts.fileCaches!.get(file.path) ?? null
        : undefined,
    },
  };
  return { app, vault };
}

describe("getActiveNoteImpl", () => {
  test("returns path + content when a note is active", async () => {
    const file: FixtureFile = { path: "inbox/today.md", extension: "md" };
    const fileContents = new Map([["inbox/today.md", "# Today"]]);
    const { app, vault } = makeApp({ activeFile: file, files: [file], fileContents });
    const r = await getActiveNoteImpl(new ObsidianApi(app), vault);
    expect(r).toEqual({ ok: true, path: "inbox/today.md", content: "# Today" });
  });

  test("returns structured no_active_note when nothing focused", async () => {
    const { app, vault } = makeApp({ activeFile: null });
    const r = await getActiveNoteImpl(new ObsidianApi(app), vault);
    expect(r).toEqual({ ok: false, reason: "no_active_note" });
  });

  test("treats a non-markdown active file as no_active_note (defence)", async () => {
    const file: FixtureFile = { path: "diagram.canvas", extension: "canvas" };
    const { app, vault } = makeApp({ activeFile: file, files: [file] });
    const r = await getActiveNoteImpl(new ObsidianApi(app), vault);
    expect(r).toEqual({ ok: false, reason: "no_active_note" });
  });

  test("returns no_active_note when workspace.getActiveFile throws (native-failed surfaces as no_active_note)", async () => {
    const { vault } = makeApp({});
    const app: AppLike = {
      vault,
      workspace: {
        getActiveFile: () => {
          throw new Error("boom");
        },
      },
    };
    const r = await getActiveNoteImpl(new ObsidianApi(app), vault);
    // native-failed isn't a tool-error reason in this layer; we treat it
    // the same as no_active_note to avoid leaking internal errors.
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("no_active_note");
  });
});

describe("listRecentNotesImpl", () => {
  test("returns notes sorted by mtime descending, default 20", async () => {
    const files: FixtureFile[] = Array.from({ length: 30 }, (_, i) => ({
      path: `n${i}.md`,
      extension: "md",
      stat: { size: 1, mtime: i },
    }));
    const { app } = makeApp({ files });
    const r = await listRecentNotesImpl(new ObsidianApi(app), 20);
    expect(r.returned).toBe(20);
    expect(r.notes[0].path).toBe("n29.md");
    expect(r.notes[19].path).toBe("n10.md");
  });

  test("caps at 100", async () => {
    const files: FixtureFile[] = Array.from({ length: 200 }, (_, i) => ({
      path: `n${i}.md`,
      extension: "md",
      stat: { size: 1, mtime: i },
    }));
    const { app } = makeApp({ files });
    const r = await listRecentNotesImpl(new ObsidianApi(app), 500);
    expect(r.returned).toBe(100);
  });
});

describe("findBacklinksImpl (resolved-link index path)", () => {
  test("returns sources from resolvedLinks with link-form discrimination", async () => {
    const target: FixtureFile = { path: "alpha.md", extension: "md" };
    const sourceWiki: FixtureFile = { path: "src1.md", extension: "md" };
    const sourceMd: FixtureFile = { path: "src2.md", extension: "md" };
    const files = [target, sourceWiki, sourceMd];
    const fileCaches = new Map<string, FileCacheLike>([
      [
        "src1.md",
        { links: [{ link: "alpha", original: "[[alpha]]" }] },
      ],
      [
        "src2.md",
        { links: [{ link: "alpha.md", original: "[Alpha](alpha.md)" }] },
      ],
    ]);
    const resolvedLinks = {
      "src1.md": { "alpha.md": 1 },
      "src2.md": { "alpha.md": 1 },
    };
    const { app, vault } = makeApp({ files, fileCaches, resolvedLinks });
    const r = await findBacklinksImpl(new ObsidianApi(app), vault, "alpha.md");
    expect(r.target).toBe("alpha.md");
    expect(r.usedFallback).toBe(false);
    expect(r.backlinks.length).toBe(2);
    const wiki = r.backlinks.find((b) => b.sourcePath === "src1.md");
    const md = r.backlinks.find((b) => b.sourcePath === "src2.md");
    expect(wiki?.linkForm).toBe("wikilink");
    expect(md?.linkForm).toBe("markdown");
  });

  test("falls back to regex scan when resolvedLinks is unavailable", async () => {
    const target: FixtureFile = { path: "alpha.md", extension: "md" };
    const source: FixtureFile = { path: "src.md", extension: "md" };
    const files = [target, source];
    const fileContents = new Map([
      ["src.md", "see [[alpha]] and also [link](alpha.md)\n"],
    ]);
    const { app, vault } = makeApp({ files, fileContents }); // no resolvedLinks
    const r = await findBacklinksImpl(new ObsidianApi(app), vault, "alpha.md");
    expect(r.usedFallback).toBe(true);
    expect(r.backlinks.length).toBeGreaterThanOrEqual(2);
    expect(r.backlinks.some((b) => b.linkForm === "wikilink")).toBe(true);
    expect(r.backlinks.some((b) => b.linkForm === "markdown")).toBe(true);
  });

  test("fallback reports truncated=true when match cap (50) trips", async () => {
    // 60 sources each contain one wikilink to alpha → should cap at 50.
    const target: FixtureFile = { path: "alpha.md", extension: "md" };
    const sources: FixtureFile[] = Array.from({ length: 60 }, (_, i) => ({
      path: `s${i}.md`,
      extension: "md",
    }));
    const fileContents = new Map<string, string>(
      sources.map((s) => [s.path, "see [[alpha]]\n"]),
    );
    const { app, vault } = makeApp({
      files: [target, ...sources],
      fileContents,
    });
    const r = await findBacklinksImpl(new ObsidianApi(app), vault, "alpha.md");
    expect(r.usedFallback).toBe(true);
    expect(r.truncated).toBe(true);
    expect(r.backlinks.length).toBeLessThanOrEqual(50);
  });

  test("rejects traversal target paths", async () => {
    const { app, vault } = makeApp({});
    await expect(
      findBacklinksImpl(new ObsidianApi(app), vault, "inbox/../etc"),
    ).rejects.toThrow(/traversal/i);
  });

  test("fallback silently skips source files whose path fails vault containment", async () => {
    // Synthesize an index entry whose path traverses out of the vault.
    // resolveVaultPath should reject it on validation, so the fallback
    // must skip it rather than read its body.
    const target: FixtureFile = { path: "alpha.md", extension: "md" };
    const bad: FixtureFile = { path: "../escape.md", extension: "md" };
    const good: FixtureFile = { path: "good.md", extension: "md" };
    const fileContents = new Map([
      ["../escape.md", "[[alpha]]\n"],
      ["good.md", "[[alpha]]\n"],
    ]);
    const { app, vault } = makeApp({
      files: [target, bad, good],
      fileContents,
    });
    const r = await findBacklinksImpl(
      new ObsidianApi(app),
      vault,
      "alpha.md",
    );
    expect(r.usedFallback).toBe(true);
    expect(r.backlinks.some((b) => b.sourcePath === "good.md")).toBe(true);
    expect(r.backlinks.some((b) => b.sourcePath === "../escape.md")).toBe(
      false,
    );
  });
});

describe("vaultTreeImpl", () => {
  test("happy path at default depth", async () => {
    const files: FixtureFile[] = [
      { path: "a.md", extension: "md" },
      { path: "inbox/today.md", extension: "md" },
    ];
    const { app } = makeApp({ files, folders: ["inbox"] });
    const r = await vaultTreeImpl(new ObsidianApi(app), "", 2);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.root.kind).toBe("folder");
    expect(r.truncated).toBe(false);
  });

  test("not_found for missing folder", async () => {
    const { app } = makeApp({});
    const r = await vaultTreeImpl(new ObsidianApi(app), "does/not/exist", 2);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("not_found");
  });

  test("invalid_path for traversal", async () => {
    const { app } = makeApp({});
    const r = await vaultTreeImpl(new ObsidianApi(app), "inbox/../../etc", 2);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("invalid_path");
  });

  test("not_a_folder when path resolves to a file", async () => {
    const file: FixtureFile = { path: "n.md", extension: "md" };
    const { app } = makeApp({ files: [file] });
    const r = await vaultTreeImpl(new ObsidianApi(app), "n.md", 2);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("not_a_folder");
  });
});

describe("vaultMetadataImpl", () => {
  test("returns tags + headings + frontmatter without note body", async () => {
    const file: FixtureFile = {
      path: "n.md",
      extension: "md",
      stat: { size: 42, mtime: 1000 },
    };
    const fileCaches = new Map<string, FileCacheLike>([
      [
        "n.md",
        {
          tags: [{ tag: "#inline" }, { tag: "#dup" }],
          headings: [{ heading: "Hi", level: 1 }],
          frontmatter: { tags: ["fm-tag", "dup"], title: "T" },
        },
      ],
    ]);
    const resolvedLinks = { "n.md": { "b.md": 1, "c.md": 2 } };
    const { app, vault } = makeApp({
      files: [file],
      fileCaches,
      resolvedLinks,
    });
    const r = await vaultMetadataImpl(new ObsidianApi(app), vault, "n.md");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.tags).toContain("#inline");
    expect(r.tags).toContain("#fm-tag");
    // Dedup: only one #dup even though inline + frontmatter both supplied it.
    expect(r.tags.filter((t) => t === "#dup").length).toBe(1);
    expect(r.headings).toEqual([{ heading: "Hi", level: 1 }]);
    expect(r.frontmatter.title).toBe("T");
    expect(r.outboundLinks.sort()).toEqual(["b.md", "c.md"]);
    expect(r.stat).toEqual({ size: 42, mtime: 1000 });
    // Note body MUST NOT be in the response.
    expect((r as unknown as { content?: unknown }).content).toBeUndefined();
  });

  test("not_found for unknown path", async () => {
    const { app, vault } = makeApp({});
    const r = await vaultMetadataImpl(
      new ObsidianApi(app),
      vault,
      "missing.md",
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("not_found");
  });

  test("invalid_path for traversal", async () => {
    const { app, vault } = makeApp({});
    const r = await vaultMetadataImpl(
      new ObsidianApi(app),
      vault,
      "inbox/../../etc",
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("invalid_path");
  });

  test("returns not_found when path resolves to a folder (not a file)", async () => {
    const { app, vault } = makeApp({ folders: ["inbox"] });
    const r = await vaultMetadataImpl(
      new ObsidianApi(app),
      vault,
      "inbox",
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("not_found");
  });
});

describe("createReadNoteTools tool registration", () => {
  test("registers exactly the 5 names in READ_NOTE_TOOL_NAMES, all skipPermission:true", () => {
    const { app, vault } = makeApp({});
    const tools = createReadNoteTools(new ObsidianApi(app), vault);
    const names = tools.map((t) => (t as unknown as { name: string }).name);
    expect(names.sort()).toEqual([...READ_NOTE_TOOL_NAMES].sort());
    for (const t of tools) {
      expect((t as unknown as { skipPermission?: boolean }).skipPermission).toBe(
        true,
      );
    }
  });
});

describe("findBacklinksImpl — final-review F10 (strict linkpath match)", () => {
  test("does NOT treat 'alpha-prime' or 'alphabet' as a link to 'alpha'", async () => {
    const target: FixtureFile = { path: "alpha.md", extension: "md" };
    const sourceWithDistinctLinks: FixtureFile = { path: "src.md", extension: "md" };
    // The cache has links to OTHER notes whose basenames merely CONTAIN
    // "alpha" as a substring (e.g. alpha-prime, alphabet). Previously
    // these false-positived because of an original.includes(target)
    // check. We assert they no longer appear.
    const fileCaches = new Map<string, FileCacheLike>([
      [
        "src.md",
        {
          links: [
            { link: "alpha-prime", original: "[[alpha-prime]]" },
            { link: "alphabet", original: "[[alphabet]]" },
          ],
        },
      ],
    ]);
    // resolvedLinks claims src.md does in fact have a resolved link
    // to lpha.md (perhaps via a different link the test doesn't model),
    // so the per-link filter is the gate under test.
    const resolvedLinks = { "src.md": { "alpha.md": 1 } };
    const { app, vault } = makeApp({
      files: [target, sourceWithDistinctLinks],
      fileCaches,
      resolvedLinks,
    });
    const r = await findBacklinksImpl(new ObsidianApi(app), vault, "alpha.md");
    expect(r.backlinks.length).toBe(0);
  });

  test("accepts wikilink with section + alias suffixes", async () => {
    const target: FixtureFile = { path: "alpha.md", extension: "md" };
    const source: FixtureFile = { path: "src.md", extension: "md" };
    const fileCaches = new Map<string, FileCacheLike>([
      [
        "src.md",
        { links: [{ link: "alpha", original: "[[alpha#Heading|nice alias]]" }] },
      ],
    ]);
    const resolvedLinks = { "src.md": { "alpha.md": 1 } };
    const { app, vault } = makeApp({
      files: [target, source],
      fileCaches,
      resolvedLinks,
    });
    const r = await findBacklinksImpl(new ObsidianApi(app), vault, "alpha.md");
    expect(r.backlinks.length).toBe(1);
    expect(r.backlinks[0].linkForm).toBe("wikilink");
  });
});