import { describe, expect, it } from "vitest";
import {
  createSearchTools,
  searchByTagImpl,
  searchByNameImpl,
  listAllTagsImpl,
  searchVaultImpl,
  SEARCH_BY_TAG_CAP,
  SEARCH_BY_NAME_CAP,
  SEARCH_VAULT_CAP,
  collectFileTagsForFallback,
  type SearchByTagResult,
  type SearchByNameResult,
  type ListAllTagsResult,
  type SearchVaultResult,
} from "./SearchTools";
import {
  ObsidianApi,
  type AppLike,
  type FileCacheLike,
} from "./ObsidianApi";
import type { ReadToolsVault, TFileLike } from "./ReadTools";
import {
  V03_READ_TOOL_NAMES,
  COMPOUND_TOOL_NAMES,
} from "../domain/vaultToolManifest";

interface Fixture {
  files: TFileLike[];
  fileCaches: Map<string, FileCacheLike>;
}

function makeFixture(spec: {
  notes: Array<{ path: string; tags?: string[]; fmTags?: string | string[] }>;
  withGetTagsApi?: boolean;
}): {
  api: ObsidianApi;
  vault: ReadToolsVault;
  app: AppLike;
  fixture: Fixture;
} {
  const files: TFileLike[] = spec.notes.map((n) => ({
    path: n.path,
    extension: "md",
  }));
  const fileCaches = new Map<string, FileCacheLike>();
  const tagTally: Record<string, number> = {};
  for (const n of spec.notes) {
    const tags = (n.tags ?? []).map((t) => ({
      tag: t.startsWith("#") ? t : `#${t}`,
    }));
    const cache: FileCacheLike = { tags };
    if (n.fmTags !== undefined) {
      cache.frontmatter = { tags: n.fmTags };
    }
    fileCaches.set(n.path, cache);
    for (const t of collectFileTagsForFallback(cache)) {
      tagTally[t] = (tagTally[t] ?? 0) + 1;
    }
  }
  const vault = {
    adapter: { getBasePath: () => "/tmp/vault" },
    getMarkdownFiles: () => files,
    getFileByPath: (p: string) => files.find((f) => f.path === p) ?? null,
  } as unknown as ReadToolsVault;
  const app: AppLike = {
    vault,
    metadataCache: {
      getFileCache: (file) => fileCaches.get(file.path) ?? null,
      ...(spec.withGetTagsApi
        ? { getTags: () => ({ ...tagTally }) }
        : {}),
    },
  };
  return { api: new ObsidianApi(app), vault, app, fixture: { files, fileCaches } };
}

// ---- search_by_tag ---------------------------------------------------

describe("searchByTagImpl", () => {
  it("returns notes whose cache includes the tag (input without #)", async () => {
    const { api } = makeFixture({
      notes: [
        { path: "a.md", tags: ["project"] },
        { path: "b.md", tags: ["other"] },
        { path: "c.md", tags: ["project", "personal"] },
      ],
    });
    const r = (await searchByTagImpl(api, "project")) as Extract<
      SearchByTagResult,
      { ok: true }
    >;
    expect(r.ok).toBe(true);
    expect(r.tag).toBe("#project");
    expect(r.matches.map((m) => m.path).sort()).toEqual(["a.md", "c.md"]);
    expect(r.total).toBe(2);
    expect(r.truncated).toBe(false);
  });

  it("treats inputs with and without leading # identically", async () => {
    const { api } = makeFixture({
      notes: [
        { path: "a.md", tags: ["project"] },
        { path: "b.md", tags: ["project"] },
      ],
    });
    const withHash = (await searchByTagImpl(api, "#project")) as Extract<
      SearchByTagResult,
      { ok: true }
    >;
    const without = (await searchByTagImpl(api, "project")) as Extract<
      SearchByTagResult,
      { ok: true }
    >;
    expect(withHash.matches.map((m) => m.path)).toEqual(
      without.matches.map((m) => m.path),
    );
  });

  it("returns ok with empty matches when the tag is not present", async () => {
    const { api } = makeFixture({
      notes: [{ path: "a.md", tags: ["other"] }],
    });
    const r = (await searchByTagImpl(api, "ghost")) as Extract<
      SearchByTagResult,
      { ok: true }
    >;
    expect(r.ok).toBe(true);
    expect(r.matches).toEqual([]);
    expect(r.total).toBe(0);
  });

  it("returns ok with empty matches on an empty vault", async () => {
    const { api } = makeFixture({ notes: [] });
    const r = (await searchByTagImpl(api, "anything")) as Extract<
      SearchByTagResult,
      { ok: true }
    >;
    expect(r.ok).toBe(true);
    expect(r.matches).toEqual([]);
  });

  it("rejects empty / hash-only tag input as invalid-tag", async () => {
    const { api } = makeFixture({ notes: [{ path: "a.md", tags: ["x"] }] });
    const r1 = await searchByTagImpl(api, "");
    const r2 = await searchByTagImpl(api, "#");
    expect(r1.ok).toBe(false);
    expect(r2.ok).toBe(false);
    if (!r1.ok) expect(r1.reason).toBe("invalid-tag");
    if (!r2.ok) expect(r2.reason).toBe("invalid-tag");
  });

  it("truncates at SEARCH_BY_TAG_CAP and reports total + truncated=true", async () => {
    const notes = Array.from({ length: SEARCH_BY_TAG_CAP + 5 }, (_, i) => ({
      path: `${String(i).padStart(4, "0")}.md`,
      tags: ["bulk"],
    }));
    const { api } = makeFixture({ notes });
    const r = (await searchByTagImpl(api, "bulk")) as Extract<
      SearchByTagResult,
      { ok: true }
    >;
    expect(r.ok).toBe(true);
    expect(r.matches).toHaveLength(SEARCH_BY_TAG_CAP);
    expect(r.total).toBe(SEARCH_BY_TAG_CAP + 5);
    expect(r.truncated).toBe(true);
  });

  it("returns metadata-cache-not-ready when the cache is unavailable", async () => {
    const app: AppLike = {
      vault: {
        adapter: { getBasePath: () => "/tmp" },
        getMarkdownFiles: () => [],
      } as unknown as ReadToolsVault,
      // No metadataCache at all.
    };
    const api = new ObsidianApi(app);
    const r = await searchByTagImpl(api, "project");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("metadata-cache-not-ready");
  });

  it("includes notes that declare the tag in frontmatter (not inline)", async () => {
    const { api } = makeFixture({
      notes: [
        { path: "fm-array.md", fmTags: ["project", "extra"] },
        { path: "fm-string.md", fmTags: "project, extra" },
        { path: "miss.md", fmTags: "other" },
      ],
    });
    const r = (await searchByTagImpl(api, "project")) as Extract<
      SearchByTagResult,
      { ok: true }
    >;
    expect(r.matches.map((m) => m.path).sort()).toEqual([
      "fm-array.md",
      "fm-string.md",
    ]);
  });

  it("returns matches sorted by path for deterministic output", async () => {
    const { api } = makeFixture({
      notes: [
        { path: "z.md", tags: ["t"] },
        { path: "a.md", tags: ["t"] },
        { path: "m.md", tags: ["t"] },
      ],
    });
    const r = (await searchByTagImpl(api, "t")) as Extract<
      SearchByTagResult,
      { ok: true }
    >;
    expect(r.matches.map((m) => m.path)).toEqual(["a.md", "m.md", "z.md"]);
  });
});

// ---- search_by_name --------------------------------------------------

describe("searchByNameImpl", () => {
  function nameFixture(): ReadToolsVault {
    const files: TFileLike[] = [
      "Project Alpha.md",
      "Alpha Notes.md",
      "Daily/2026-06-10.md",
      "Aleph.md",
      "Other/alphabet.md",
      "Beta.md",
    ].map((p) => ({ path: p, extension: "md" }));
    return {
      adapter: { getBasePath: () => "/tmp" },
      getMarkdownFiles: () => files,
    } as unknown as ReadToolsVault;
  }

  it("ranks exact > prefix > substring", async () => {
    const r = (await searchByNameImpl(nameFixture(), "alpha")) as Extract<
      SearchByNameResult,
      { ok: true }
    >;
    expect(r.ok).toBe(true);
    // Exact: "Alpha" doesn't exist as a basename. Prefix: "Alpha Notes",
    // "Project Alpha" doesn't start with "alpha", but "Alpha Notes"
    // does. Substring catches "Project Alpha", "Other/alphabet".
    // Aleph and Beta do not match.
    expect(r.matches.map((m) => m.displayName)).toEqual([
      "Alpha Notes",
      "alphabet",
      "Project Alpha",
    ]);
  });

  it("treats query case-insensitively", async () => {
    const r = (await searchByNameImpl(nameFixture(), "ALPHA")) as Extract<
      SearchByNameResult,
      { ok: true }
    >;
    expect(r.matches.length).toBeGreaterThan(0);
  });

  it("places exact-name matches before prefix matches", async () => {
    const files: TFileLike[] = [
      { path: "Beta.md", extension: "md" },
      { path: "Beta Plan.md", extension: "md" },
    ];
    const vault = {
      adapter: { getBasePath: () => "/" },
      getMarkdownFiles: () => files,
    } as unknown as ReadToolsVault;
    const r = (await searchByNameImpl(vault, "beta")) as Extract<
      SearchByNameResult,
      { ok: true }
    >;
    expect(r.matches.map((m) => m.displayName)).toEqual(["Beta", "Beta Plan"]);
  });

  it("returns invalid-query for empty / whitespace input", async () => {
    const r1 = await searchByNameImpl(nameFixture(), "");
    const r2 = await searchByNameImpl(nameFixture(), "   ");
    expect(r1.ok).toBe(false);
    expect(r2.ok).toBe(false);
  });

  it("truncates at SEARCH_BY_NAME_CAP", async () => {
    const files: TFileLike[] = Array.from(
      { length: SEARCH_BY_NAME_CAP + 3 },
      (_, i) => ({ path: `match-${i}.md`, extension: "md" }),
    );
    const vault = {
      adapter: { getBasePath: () => "/" },
      getMarkdownFiles: () => files,
    } as unknown as ReadToolsVault;
    const r = (await searchByNameImpl(vault, "match")) as Extract<
      SearchByNameResult,
      { ok: true }
    >;
    expect(r.matches).toHaveLength(SEARCH_BY_NAME_CAP);
    expect(r.truncated).toBe(true);
    expect(r.total).toBe(SEARCH_BY_NAME_CAP + 3);
  });
});

// ---- list_all_tags ---------------------------------------------------

describe("listAllTagsImpl", () => {
  it("uses metadataCache.getTags() when available", async () => {
    const { api } = makeFixture({
      withGetTagsApi: true,
      notes: [
        { path: "a.md", tags: ["project", "work"] },
        { path: "b.md", tags: ["project"] },
        { path: "c.md", tags: ["work"] },
      ],
    });
    const r = (await listAllTagsImpl(api)) as Extract<
      ListAllTagsResult,
      { ok: true }
    >;
    expect(r.ok).toBe(true);
    // project=2, work=2 (alphabetical tiebreak)
    expect(r.tags).toEqual([
      { tag: "#project", count: 2 },
      { tag: "#work", count: 2 },
    ]);
  });

  it("falls back to scanning getFileCache when getTags() is absent — same shape", async () => {
    const withApi = makeFixture({
      withGetTagsApi: true,
      notes: [
        { path: "a.md", tags: ["x"] },
        { path: "b.md", tags: ["x", "y"] },
      ],
    });
    const withoutApi = makeFixture({
      withGetTagsApi: false,
      notes: [
        { path: "a.md", tags: ["x"] },
        { path: "b.md", tags: ["x", "y"] },
      ],
    });
    const r1 = (await listAllTagsImpl(withApi.api)) as Extract<
      ListAllTagsResult,
      { ok: true }
    >;
    const r2 = (await listAllTagsImpl(withoutApi.api)) as Extract<
      ListAllTagsResult,
      { ok: true }
    >;
    expect(r1.tags).toEqual(r2.tags);
  });

  it("sorts by count descending, alphabetical on ties", async () => {
    const { api } = makeFixture({
      withGetTagsApi: true,
      notes: [
        { path: "1.md", tags: ["zebra"] },
        { path: "2.md", tags: ["alpha"] },
        { path: "3.md", tags: ["alpha", "beta"] },
        { path: "4.md", tags: ["alpha"] },
      ],
    });
    const r = (await listAllTagsImpl(api)) as Extract<
      ListAllTagsResult,
      { ok: true }
    >;
    expect(r.tags.map((t) => t.tag)).toEqual([
      "#alpha",
      "#beta",
      "#zebra",
    ]);
    expect(r.tags[0].count).toBe(3);
  });

  it("returns metadata-cache-not-ready when both API paths are unavailable", async () => {
    const app: AppLike = {
      vault: {
        adapter: { getBasePath: () => "/" },
      } as unknown as ReadToolsVault,
    };
    const api = new ObsidianApi(app);
    const r = await listAllTagsImpl(api);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("metadata-cache-not-ready");
  });

  it("returns ok with empty tags on an empty vault", async () => {
    const { api } = makeFixture({ withGetTagsApi: true, notes: [] });
    const r = (await listAllTagsImpl(api)) as Extract<
      ListAllTagsResult,
      { ok: true }
    >;
    expect(r.ok).toBe(true);
    expect(r.tags).toEqual([]);
  });
});

// ---- factory + manifest ---------------------------------------------

describe("createSearchTools factory", () => {
  it("registers exactly V03_READ_TOOL_NAMES + COMPOUND_TOOL_NAMES, all skipPermission=true", () => {
    const { api, vault } = makeFixture({ notes: [] });
    const tools = createSearchTools(api, vault);
    const names = tools.map((t) => t.name).sort();
    const expected = [...V03_READ_TOOL_NAMES, ...COMPOUND_TOOL_NAMES].sort();
    expect(names).toEqual(expected);
    for (const t of tools) {
      // Read-only contract — permission gate must be bypassed.
      expect((t as { skipPermission?: boolean }).skipPermission).toBe(true);
    }
  });

  it("V03_READ_TOOL_NAMES is exactly the documented three names", () => {
    expect([...V03_READ_TOOL_NAMES].sort()).toEqual([
      "list_all_tags",
      "search_by_name",
      "search_by_tag",
    ]);
  });
});

// ---- search_vault (Phase 3) ------------------------------------------

function makeFsVault(
  files: Array<{ path: string; content?: string; mtime?: number }>,
  reads: { count: number },
): ReadToolsVault {
  const t: TFileLike[] = files.map((f) => ({
    path: f.path,
    extension: "md",
    stat: { mtime: f.mtime },
  }));
  const contents = new Map(files.map((f) => [f.path, f.content ?? ""]));
  return {
    adapter: { getBasePath: () => "/tmp/vault" },
    getMarkdownFiles: () => t,
    getFileByPath: (p: string) => t.find((f) => f.path === p) ?? null,
    getAbstractFileByPath: (p: string) =>
      t.find((f) => f.path === p) ?? null,
    cachedRead: async (file) => {
      reads.count++;
      return contents.get(file.path) ?? "";
    },
    read: async (file) => {
      reads.count++;
      return contents.get(file.path) ?? "";
    },
  } as unknown as ReadToolsVault;
}

describe("searchVaultImpl", () => {
  it("AND-combines tag + folder + modifiedSince + text (SC-004)", async () => {
    // Tag fixture builds AppLike + api with tag metadata.
    const { api } = makeFixture({
      notes: [
        { path: "Work/hit.md", tags: ["project"] },
        { path: "Work/miss-tag.md", tags: ["other"] },
        { path: "Work/miss-old.md", tags: ["project"] },
        { path: "Personal/wrong-folder.md", tags: ["project"] },
      ],
    });
    const reads = { count: 0 };
    const vault = makeFsVault(
      [
        { path: "Work/hit.md", content: "the sunset was lovely", mtime: 2000 },
        { path: "Work/miss-tag.md", content: "sunset", mtime: 2000 },
        { path: "Work/miss-old.md", content: "sunset", mtime: 500 },
        { path: "Personal/wrong-folder.md", content: "sunset", mtime: 2000 },
      ],
      reads,
    );
    // Rewire the fixture's app.vault to our FS-vault so findFilesByTag
    // iterates the same file set.
    (api as unknown as { app: AppLike }).app.vault = vault;
    const r = (await searchVaultImpl(
      {
        tag: "project",
        folder: "Work/",
        modifiedSinceMs: 1000,
        text: "sunset",
      },
      api,
      vault,
    )) as Extract<SearchVaultResult, { ok: true }>;
    expect(r.ok).toBe(true);
    expect(r.matches).toHaveLength(1);
    expect(r.matches[0].path).toBe("Work/hit.md");
    expect(r.shortCircuited).toBe(false);
  });

  it("short-circuits with zero body reads when structural filters exclude every note (SC-005)", async () => {
    const { api } = makeFixture({
      notes: [{ path: "Work/a.md", tags: ["other"] }],
    });
    const reads = { count: 0 };
    const vault = makeFsVault(
      [{ path: "Work/a.md", content: "sunset", mtime: 5000 }],
      reads,
    );
    (api as unknown as { app: AppLike }).app.vault = vault;
    const r = (await searchVaultImpl(
      { tag: "project", text: "sunset" },
      api,
      vault,
    )) as Extract<SearchVaultResult, { ok: true }>;
    expect(r.ok).toBe(true);
    expect(r.matches).toHaveLength(0);
    expect(r.shortCircuited).toBe(true);
    // SC-005 anchor: NOT a single body read was attempted.
    expect(reads.count).toBe(0);
  });

  it("respects SEARCH_VAULT_CAP (not the search_content default of 50)", async () => {
    const total = SEARCH_VAULT_CAP + 20;
    const files = Array.from({ length: total }, (_, i) => ({
      path: `n${i}.md`,
      content: "sunset",
      mtime: 1000,
    }));
    const reads = { count: 0 };
    const vault = makeFsVault(files, reads);
    const { api } = makeFixture({ notes: [] });
    (api as unknown as { app: AppLike }).app.vault = vault;
    const r = (await searchVaultImpl(
      { text: "sunset" },
      api,
      vault,
    )) as Extract<SearchVaultResult, { ok: true }>;
    expect(r.ok).toBe(true);
    expect(r.matches.length).toBe(SEARCH_VAULT_CAP);
    expect(r.truncated).toBe(true);
    expect(r.total).toBeGreaterThan(SEARCH_VAULT_CAP);
  });

  it("supports all three textMode values", async () => {
    const reads = { count: 0 };
    const vault = makeFsVault(
      [{ path: "a.md", content: "the widget shines", mtime: 1 }],
      reads,
    );
    const { api } = makeFixture({ notes: [] });
    (api as unknown as { app: AppLike }).app.vault = vault;
    for (const mode of ["substring", "simple", "fuzzy"] as const) {
      const r = (await searchVaultImpl(
        { text: mode === "fuzzy" ? "wiget" : "widget", textMode: mode },
        api,
        vault,
      )) as Extract<SearchVaultResult, { ok: true }>;
      expect(r.ok).toBe(true);
      expect(r.matches.length).toBeGreaterThan(0);
    }
  });

  it("returns metadata-cache-not-ready when tag is supplied and cache is warming (SC-014)", async () => {
    // App without metadataCache — findFilesByTag returns not-ready.
    const files: TFileLike[] = [{ path: "a.md", extension: "md" }];
    const vault = {
      getMarkdownFiles: () => files,
    } as unknown as ReadToolsVault;
    const app: AppLike = { vault };
    const api = new ObsidianApi(app);
    const r = await searchVaultImpl({ tag: "project" }, api, vault);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("metadata-cache-not-ready");
  });

  it("modifiedSinceMs excludes older notes", async () => {
    const reads = { count: 0 };
    const vault = makeFsVault(
      [
        { path: "new.md", content: "x", mtime: 5000 },
        { path: "old.md", content: "x", mtime: 100 },
      ],
      reads,
    );
    const { api } = makeFixture({ notes: [] });
    (api as unknown as { app: AppLike }).app.vault = vault;
    const r = (await searchVaultImpl(
      { modifiedSinceMs: 1000 },
      api,
      vault,
    )) as Extract<SearchVaultResult, { ok: true }>;
    expect(r.ok).toBe(true);
    expect(r.matches.map((m) => m.path)).toEqual(["new.md"]);
  });
});
