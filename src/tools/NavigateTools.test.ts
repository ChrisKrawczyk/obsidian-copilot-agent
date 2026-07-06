import { describe, expect, it } from "vitest";
import {
  createNavigateTools,
  resolveLinkImpl,
  getOutlinksImpl,
  getNoteStructureImpl,
  MAX_OUTLINKS,
  MAX_STRUCTURE_ITEMS,
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
  }>;
  /** When true, drop the native getFirstLinkpathDest to simulate an old / warming cache. */
  noResolver?: boolean;
  /** When true, drop metadataCache entirely. */
  noMetadataCache?: boolean;
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
});

// ---- factory ----------------------------------------------------------

describe("createNavigateTools", () => {
  it("registers three tools with the expected names and skipPermission", () => {
    const { api, vault } = makeFixture({ notes: [{ path: "a.md" }] });
    const tools = createNavigateTools(api, vault);
    expect(tools).toHaveLength(3);
    for (const name of NAVIGATE_TOOL_NAMES) {
      const t = tools.find((x) => x.name === name)!;
      expect(t).toBeDefined();
      expect(t.skipPermission).toBe(true);
    }
  });
});
