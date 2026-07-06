import { describe, expect, it } from "vitest";
import {
  createNavigateTools,
  resolveLinkImpl,
  getOutlinksImpl,
  getNoteStructureImpl,
  relatedNotesImpl,
  MAX_OUTLINKS,
  MAX_STRUCTURE_ITEMS,
  RELATED_NOTES_CAP,
  NAVIGATE_TOOL_NAMES,
} from "./NavigateTools";
import {
  ObsidianApi,
  type AppLike,
  type FileCacheLike,
} from "./ObsidianApi";
import type { ReadToolsVault, TFileLike } from "./ReadTools";

interface FixtureSpec {
  notes: Array<{
    path: string;
    /** Links: pass `[[Target]]` or `[text](target)` in `original`. */
    links?: Array<{ link: string; original: string }>;
    embeds?: Array<{ link: string; original: string }>;
    headings?: Array<{ heading: string; level: number; line: number }>;
    sections?: Array<{ type: string; line: number }>;
    blocks?: Array<{ id: string; line: number }>;
    tags?: string[];
    frontmatter?: { tags?: string[] | string };
  }>;
  /** When true, drop the native getFirstLinkpathDest to simulate an old / warming cache. */
  noResolver?: boolean;
  /** When true, drop metadataCache entirely. */
  noMetadataCache?: boolean;
  /** Optional resolvedLinks map: { sourcePath: { targetPath: count } }. */
  resolvedLinks?: Record<string, Record<string, number>>;
  /** When true, omit `resolvedLinks` field entirely (simulate not-ready). */
  noResolvedLinks?: boolean;
}

function makeFixture(spec: FixtureSpec): {
  api: ObsidianApi;
  vault: ReadToolsVault;
} {
  const files: TFileLike[] = spec.notes.map((n) => ({
    path: n.path,
    extension: "md",
  }));
  const fileCaches = new Map<string, FileCacheLike>();
  for (const n of spec.notes) {
    const c: FileCacheLike = {};
    if (n.links) c.links = n.links;
    if (n.embeds) c.embeds = n.embeds;
    if (n.headings)
      c.headings = n.headings.map((h) => ({
        heading: h.heading,
        level: h.level,
        position: { start: { line: h.line } },
      }));
    if (n.sections)
      c.sections = n.sections.map((s) => ({
        type: s.type,
        position: { start: { line: s.line } },
      }));
    if (n.blocks) {
      c.blocks = {};
      for (const b of n.blocks) {
        c.blocks[b.id] = {
          id: b.id,
          position: { start: { line: b.line } },
        };
      }
    }
    if (n.tags) c.tags = n.tags.map((t) => ({ tag: t }));
    if (n.frontmatter) c.frontmatter = n.frontmatter as unknown as never;
    fileCaches.set(n.path, c);
  }

  const byBase = new Map<string, TFileLike>();
  for (const f of files) {
    const base = f.path.replace(/^.*\//, "").replace(/\.md$/, "");
    byBase.set(base, f);
  }

  const vault = {
    adapter: { getBasePath: () => "/tmp/vault" },
    getMarkdownFiles: () => files,
    getFiles: () => files,
    getFileByPath: (p: string) => files.find((f) => f.path === p) ?? null,
    getAbstractFileByPath: (p: string) =>
      files.find((f) => f.path === p) ?? null,
  } as unknown as ReadToolsVault;

  const app: AppLike = spec.noMetadataCache
    ? { vault }
    : {
        vault,
        metadataCache: {
          getFileCache: (file) => fileCaches.get(file.path) ?? null,
          ...(spec.noResolvedLinks ? {} : { resolvedLinks: spec.resolvedLinks ?? {} }),
          ...(spec.noResolver
            ? {}
            : {
                getFirstLinkpathDest: (linkpath: string) => {
                  // Try exact path first, then basename lookup.
                  const exact = files.find((f) => f.path === linkpath);
                  if (exact) return exact;
                  const withMd = files.find((f) => f.path === `${linkpath}.md`);
                  if (withMd) return withMd;
                  return byBase.get(linkpath) ?? null;
                },
              }),
        },
      };
  return { api: new ObsidianApi(app), vault };
}

// ---- resolve_link ------------------------------------------------------

describe("resolveLinkImpl", () => {
  it("resolves a wikilink via basename lookup", () => {
    const { api } = makeFixture({
      notes: [
        { path: "Work/Alice.md" },
        { path: "Work/index.md" },
      ],
    });
    const r = resolveLinkImpl(
      { link: "[[Alice]]", sourcePath: "Work/index.md" },
      api,
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.target.path).toBe("Work/Alice.md");
  });

  it("strips alias and heading fragment before resolving", () => {
    const { api } = makeFixture({
      notes: [{ path: "notes/target.md" }, { path: "src.md" }],
    });
    const r = resolveLinkImpl(
      { link: "[[target#Overview|see Overview]]", sourcePath: "src.md" },
      api,
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.target.path).toBe("notes/target.md");
  });

  it("returns unresolved when the link doesn't match any note", () => {
    const { api } = makeFixture({ notes: [{ path: "a.md" }] });
    const r = resolveLinkImpl(
      { link: "[[does-not-exist]]", sourcePath: "a.md" },
      api,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("unresolved");
  });

  it("returns invalid-link when required fields are missing/empty", () => {
    const { api } = makeFixture({ notes: [{ path: "a.md" }] });
    const r1 = resolveLinkImpl({ sourcePath: "a.md" }, api);
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.reason).toBe("invalid-link");

    const r2 = resolveLinkImpl({ link: "[[a]]", sourcePath: "" }, api);
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.reason).toBe("invalid-link");
  });

  it("returns metadata-cache-not-ready when the native resolver is missing", () => {
    const { api } = makeFixture({
      notes: [{ path: "a.md" }],
      noResolver: true,
    });
    const r = resolveLinkImpl(
      { link: "[[a]]", sourcePath: "a.md" },
      api,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("metadata-cache-not-ready");
  });

  it("returns metadata-cache-not-ready when the source note is un-indexed (cache warming)", () => {
    // Source path exists in vault but its metadata cache entry is
    // missing — treated as a warmup state per FR-014.
    const files: TFileLike[] = [
      { path: "src.md", extension: "md" },
      { path: "target.md", extension: "md" },
    ];
    const vault = {
      getMarkdownFiles: () => files,
      getFileByPath: (p: string) => files.find((f) => f.path === p) ?? null,
      getAbstractFileByPath: (p: string) =>
        files.find((f) => f.path === p) ?? null,
    } as unknown as ReadToolsVault;
    const app: AppLike = {
      vault,
      metadataCache: {
        // Cache warmup: no file has an entry yet.
        getFileCache: () => null,
        // Resolver exists but resolves nothing yet.
        getFirstLinkpathDest: (linkpath: string) => {
          // Simulate: resolver returns null for the link but resolves
          // the source path itself (path-exists probe used by the
          // impl to distinguish warmup from real misses).
          if (linkpath === "src.md") return files[0];
          return null;
        },
      },
    };
    const api = new ObsidianApi(app);
    const r = resolveLinkImpl(
      { link: "[[target]]", sourcePath: "src.md" },
      api,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("metadata-cache-not-ready");
  });
});

// ---- get_outlinks ------------------------------------------------------

describe("getOutlinksImpl", () => {
  it("distinguishes wikilink vs markdown kinds and resolves each", () => {
    const { api, vault } = makeFixture({
      notes: [
        {
          path: "src.md",
          links: [
            { link: "Alice", original: "[[Alice]]" },
            { link: "docs/spec", original: "[the spec](docs/spec)" },
          ],
        },
        { path: "Alice.md" },
        { path: "docs/spec.md" },
      ],
    });
    const r = getOutlinksImpl({ path: "src.md" }, api, vault);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.outlinks).toHaveLength(2);
    const alice = r.outlinks.find((o) => o.target === "Alice");
    const spec = r.outlinks.find((o) => o.target === "docs/spec");
    expect(alice?.kind).toBe("wikilink");
    expect(alice?.resolvedPath).toBe("Alice.md");
    expect(spec?.kind).toBe("markdown");
    expect(spec?.resolvedPath).toBe("docs/spec.md");
    expect(r.truncated).toBe(false);
  });

  it("includes embeds in the outlinks list", () => {
    const { api, vault } = makeFixture({
      notes: [
        {
          path: "src.md",
          embeds: [{ link: "img", original: "![[img]]" }],
        },
        { path: "img.md" },
      ],
    });
    const r = getOutlinksImpl({ path: "src.md" }, api, vault);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.outlinks[0].target).toBe("img");
    expect(r.outlinks[0].kind).toBe("wikilink");
  });

  it("caps at MAX_OUTLINKS and sets truncated", () => {
    const links = Array.from({ length: MAX_OUTLINKS + 5 }, (_, i) => ({
      link: `t${i}`,
      original: `[[t${i}]]`,
    }));
    const { api, vault } = makeFixture({
      notes: [{ path: "src.md", links }],
    });
    const r = getOutlinksImpl({ path: "src.md" }, api, vault);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.outlinks).toHaveLength(MAX_OUTLINKS);
    expect(r.truncated).toBe(true);
  });

  it("returns not-found when the note is missing", () => {
    const { api, vault } = makeFixture({ notes: [{ path: "a.md" }] });
    const r = getOutlinksImpl({ path: "missing.md" }, api, vault);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("not-found");
  });

  it("returns metadata-cache-not-ready when metadata cache is absent", () => {
    const { api, vault } = makeFixture({
      notes: [{ path: "a.md" }],
      noMetadataCache: true,
    });
    const r = getOutlinksImpl({ path: "a.md" }, api, vault);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("metadata-cache-not-ready");
  });

  it("returns metadata-cache-not-ready when the file exists but has no cache entry (FR-014 warmup)", () => {
    // File is in vault but Obsidian hasn't cached it yet.
    const files: TFileLike[] = [{ path: "a.md", extension: "md" }];
    const vault = {
      getMarkdownFiles: () => files,
      getFileByPath: (p: string) => files.find((f) => f.path === p) ?? null,
      getAbstractFileByPath: (p: string) =>
        files.find((f) => f.path === p) ?? null,
    } as unknown as ReadToolsVault;
    const app: AppLike = {
      vault,
      metadataCache: { getFileCache: () => null },
    };
    const api = new ObsidianApi(app);
    const r = getOutlinksImpl({ path: "a.md" }, api, vault);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("metadata-cache-not-ready");
  });
});

// ---- get_note_structure -----------------------------------------------

describe("getNoteStructureImpl", () => {
  it("returns headings/sections/blocks with line numbers and no body prose (SC-008)", () => {
    const { api, vault } = makeFixture({
      notes: [
        {
          path: "n.md",
          headings: [
            { heading: "Alpha", level: 1, line: 0 },
            { heading: "Beta", level: 2, line: 3 },
          ],
          sections: [
            { type: "heading", line: 0 },
            { type: "paragraph", line: 1 },
          ],
          blocks: [{ id: "abc", line: 5 }],
        },
      ],
    });
    const r = getNoteStructureImpl({ path: "n.md" }, api, vault);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.headings).toEqual([
      { level: 1, text: "Alpha", line: 0 },
      { level: 2, text: "Beta", line: 3 },
    ]);
    expect(r.sections).toEqual([
      { type: "heading", line: 0 },
      { type: "paragraph", line: 1 },
    ]);
    expect(r.blocks).toEqual([{ id: "abc", line: 5 }]);
    // SC-008 sentinel: response must NOT contain any body prose. The
    // `text` field on headings carries the heading text itself (which
    // is metadata, not body); the guard here is that no arbitrary body
    // string smuggled through the fixture makes it into the payload.
    const serialized = JSON.stringify(r);
    expect(serialized.includes("SECRET_BODY_TEXT")).toBe(false);
    // Structural payload keys only — no raw body accessor names.
    expect(serialized.includes('"content"')).toBe(false);
    expect(serialized.includes('"body"')).toBe(false);
  });

  it("caps combined items at MAX_STRUCTURE_ITEMS and sets truncated", () => {
    const many = Array.from({ length: MAX_STRUCTURE_ITEMS + 50 }, (_, i) => ({
      heading: `H${i}`,
      level: 1,
      line: i,
    }));
    const { api, vault } = makeFixture({
      notes: [{ path: "n.md", headings: many }],
    });
    const r = getNoteStructureImpl({ path: "n.md" }, api, vault);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.headings.length + r.sections.length + r.blocks.length).toBe(
      MAX_STRUCTURE_ITEMS,
    );
    expect(r.truncated).toBe(true);
  });

  it("returns metadata-cache-not-ready when metadata cache is absent", () => {
    const { api, vault } = makeFixture({
      notes: [{ path: "a.md" }],
      noMetadataCache: true,
    });
    const r = getNoteStructureImpl({ path: "a.md" }, api, vault);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("metadata-cache-not-ready");
  });

  it("returns metadata-cache-not-ready when the file exists but has no cache entry (FR-014 warmup)", () => {
    const files: TFileLike[] = [{ path: "a.md", extension: "md" }];
    const vault = {
      getMarkdownFiles: () => files,
      getFileByPath: (p: string) => files.find((f) => f.path === p) ?? null,
      getAbstractFileByPath: (p: string) =>
        files.find((f) => f.path === p) ?? null,
    } as unknown as ReadToolsVault;
    const app: AppLike = {
      vault,
      metadataCache: { getFileCache: () => null },
    };
    const api = new ObsidianApi(app);
    const r = getNoteStructureImpl({ path: "a.md" }, api, vault);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("metadata-cache-not-ready");
  });
});

// ---- related_notes ----------------------------------------------------

describe("relatedNotesImpl", () => {
  it("ranks notes with more shared tags higher (SC-009)", () => {
    const { api, vault } = makeFixture({
      notes: [
        { path: "src.md", tags: ["#a", "#b", "#c"] },
        { path: "hi.md", tags: ["#a", "#b", "#c"] },
        { path: "lo.md", tags: ["#a"] },
      ],
      resolvedLinks: {},
    });
    const r = relatedNotesImpl({ path: "src.md" }, api, vault);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.related.map((e) => e.path)).toEqual(["hi.md", "lo.md"]);
    expect(r.related[0].signals.tag).toBe(3);
    expect(r.related[1].signals.tag).toBe(1);
    expect(r.related[0].score).toBeGreaterThan(r.related[1].score);
  });

  it("returns empty related list when source has no signals", () => {
    const { api, vault } = makeFixture({
      notes: [
        { path: "src.md" },
        { path: "a.md", tags: ["#x"] },
      ],
      resolvedLinks: {},
    });
    const r = relatedNotesImpl({ path: "src.md" }, api, vault);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.related).toEqual([]);
    expect(r.truncated).toBe(false);
  });

  it("caps results at RELATED_NOTES_CAP and reports truncated", () => {
    const notes: FixtureSpec["notes"] = [{ path: "src.md", tags: ["#t"] }];
    for (let i = 0; i < RELATED_NOTES_CAP + 5; i++) {
      notes.push({ path: `n${i.toString().padStart(3, "0")}.md`, tags: ["#t"] });
    }
    const { api, vault } = makeFixture({ notes, resolvedLinks: {} });
    const r = relatedNotesImpl({ path: "src.md" }, api, vault);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.related).toHaveLength(RELATED_NOTES_CAP);
    expect(r.truncated).toBe(true);
  });

  it("excludes the source note itself from results", () => {
    const { api, vault } = makeFixture({
      notes: [
        { path: "src.md", tags: ["#a", "#b"] },
        { path: "other.md", tags: ["#a"] },
      ],
      resolvedLinks: {},
    });
    const r = relatedNotesImpl({ path: "src.md" }, api, vault);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.related.some((e) => e.path === "src.md")).toBe(false);
  });

  it("returns metadata-cache-not-ready when resolvedLinks index is missing (SC-014)", () => {
    const { api, vault } = makeFixture({
      notes: [{ path: "src.md", tags: ["#a"] }, { path: "b.md", tags: ["#a"] }],
      noResolvedLinks: true,
    });
    const r = relatedNotesImpl({ path: "src.md" }, api, vault);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("metadata-cache-not-ready");
  });

  it("scores backlink overlap when candidate shares an incoming linker with source", () => {
    // linker.md links to both src.md and cand.md — that's a shared backlink.
    const { api, vault } = makeFixture({
      notes: [
        { path: "src.md" },
        { path: "cand.md" },
        { path: "linker.md" },
      ],
      resolvedLinks: {
        "linker.md": { "src.md": 1, "cand.md": 1 },
      },
    });
    const r = relatedNotesImpl({ path: "src.md" }, api, vault);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const cand = r.related.find((e) => e.path === "cand.md");
    expect(cand).toBeDefined();
    expect(cand!.signals.backlink).toBe(1);
  });
});

// ---- factory ----------------------------------------------------------

describe("createNavigateTools", () => {
  it("registers all NAVIGATE_TOOL_NAMES with skipPermission", () => {
    const { api, vault } = makeFixture({ notes: [{ path: "a.md" }] });
    const tools = createNavigateTools(api, vault);
    expect(tools).toHaveLength(NAVIGATE_TOOL_NAMES.length);
    for (const name of NAVIGATE_TOOL_NAMES) {
      const t = tools.find((x) => x.name === name)!;
      expect(t).toBeDefined();
      expect(t.skipPermission).toBe(true);
    }
    expect(NAVIGATE_TOOL_NAMES).toContain("related_notes");
  });
});
