import { describe, expect, test } from "vitest";
import { findTasksImpl } from "./FindTasks";
import { ObsidianApi, type AppLike, type FileCacheLike } from "./ObsidianApi";
import type { ReadToolsVault, TFileLike } from "./ReadTools";

interface FixtureFile extends TFileLike {}

function makeWorld(files: Array<{ path: string; content: string }>): {
  api: ObsidianApi;
  vault: ReadToolsVault;
} {
  const fixtureFiles: FixtureFile[] = files.map((f) => ({
    path: f.path,
    extension: "md",
  }));
  const contents = new Map(files.map((f) => [f.path, f.content]));

  // Build a FileCacheLike with listItems for each file, where each
  // checkbox line gets an entry with `task` set to the status char.
  const caches = new Map<string, FileCacheLike>();
  for (const f of files) {
    const lines = f.content.split("\n");
    const listItems: NonNullable<FileCacheLike["listItems"]> = [];
    lines.forEach((line, i) => {
      const m = /^\s*- \[(.)\]/.exec(line);
      if (m) {
        listItems.push({
          position: { start: { line: i } },
          task: m[1],
        });
      }
    });
    caches.set(f.path, { listItems });
  }

  const vault: ReadToolsVault = {
    adapter: { getBasePath: () => "/tmp/vault" },
    getFileByPath: (p) => fixtureFiles.find((f) => f.path === p) ?? null,
    getAbstractFileByPath: (p) => fixtureFiles.find((f) => f.path === p) ?? null,
    getMarkdownFiles: () => fixtureFiles,
    getFiles: () => fixtureFiles,
    read: async (file) => contents.get(file.path) ?? "",
    cachedRead: async (file) => contents.get(file.path) ?? "",
  };

  const app: AppLike = {
    vault,
    metadataCache: {
      getFileCache: (file) => caches.get(file.path) ?? null,
    },
  };
  return { api: new ObsidianApi(app), vault };
}

describe("findTasksImpl", () => {
  test("enumerates tasks across multiple files with 1-based line numbers", async () => {
    const { api, vault } = makeWorld([
      { path: "a.md", content: "# A\n\n- [ ] task one\n- [x] task two ✅ 2026-06-12" },
      { path: "b.md", content: "- [ ] task three" },
    ]);
    const r = await findTasksImpl({}, { api, vault });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.results.map((h) => `${h.path}:${h.line}`)).toEqual([
      "a.md:3",
      "a.md:4",
      "b.md:1",
    ]);
    expect(r.scanned).toBe(2);
    expect(r.truncated).toBe(false);
  });

  test("status filter matches exact status", async () => {
    const { api, vault } = makeWorld([
      { path: "a.md", content: "- [ ] todo\n- [/] in progress\n- [x] done\n- [-] cancelled" },
    ]);
    const r = await findTasksImpl({ status: "in-progress" }, { api, vault });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.results).toHaveLength(1);
    expect(r.results[0].parsed.status).toBe("in-progress");
  });

  test("tag filter is case-insensitive exact match", async () => {
    const { api, vault } = makeWorld([
      { path: "a.md", content: "- [ ] alpha #Work\n- [ ] beta #home\n- [ ] gamma #work-stuff" },
    ]);
    const r = await findTasksImpl({ tag: "work" }, { api, vault });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.results).toHaveLength(1);
    expect(r.results[0].parsed.description).toBe("alpha");
  });

  test("dueBefore/dueAfter inclusive", async () => {
    const { api, vault } = makeWorld([
      {
        path: "a.md",
        content:
          "- [ ] one 📅 2026-06-10\n- [ ] two 📅 2026-06-15\n- [ ] three 📅 2026-06-20",
      },
    ]);
    const r = await findTasksImpl(
      { dueAfter: "2026-06-11", dueBefore: "2026-06-19" },
      { api, vault },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.results.map((h) => h.parsed.description)).toEqual(["two"]);
  });

  test("descriptionRegex filter", async () => {
    const { api, vault } = makeWorld([
      { path: "a.md", content: "- [ ] call Alice\n- [ ] email Bob\n- [ ] meet Charlie" },
    ]);
    const r = await findTasksImpl({ descriptionRegex: "^(call|email)" }, { api, vault });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.results.map((h) => h.parsed.description)).toEqual(["call Alice", "email Bob"]);
  });

  test("invalid regex returns structured error", async () => {
    const { api, vault } = makeWorld([{ path: "a.md", content: "- [ ] x" }]);
    const r = await findTasksImpl({ descriptionRegex: "[" }, { api, vault });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("invalid_regex");
  });

  test("invalid date format returns structured error", async () => {
    const { api, vault } = makeWorld([{ path: "a.md", content: "- [ ] x" }]);
    const r = await findTasksImpl({ dueBefore: "tomorrow" }, { api, vault });
    expect(r.ok).toBe(false);
    if (!r.ok && r.reason === "invalid_date_format") expect(r.field).toBe("dueBefore");
  });

  test("path filter scopes to single note", async () => {
    const { api, vault } = makeWorld([
      { path: "a.md", content: "- [ ] in a" },
      { path: "b.md", content: "- [ ] in b" },
    ]);
    const r = await findTasksImpl({ path: "b.md" }, { api, vault });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.results.map((h) => h.path)).toEqual(["b.md"]);
    expect(r.scanned).toBe(1);
  });

  test("path filter — unknown file returns empty results", async () => {
    const { api, vault } = makeWorld([{ path: "a.md", content: "- [ ] x" }]);
    const r = await findTasksImpl({ path: "nope.md" }, { api, vault });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.results).toEqual([]);
  });

  test("non-task list items (plain bullets) are ignored", async () => {
    const { api, vault } = makeWorld([
      { path: "a.md", content: "- plain bullet\n- [ ] actual task" },
    ]);
    const r = await findTasksImpl({}, { api, vault });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.results).toHaveLength(1);
  });

  test("preserves recurrence marker in raw line", async () => {
    const { api, vault } = makeWorld([
      { path: "a.md", content: "- [ ] Weekly review 📅 2026-06-14 🔁 every Sunday" },
    ]);
    const r = await findTasksImpl({}, { api, vault });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.results[0].raw).toContain("🔁 every Sunday");
    expect(r.results[0].parsed.extras).toBe("🔁 every Sunday");
  });
});
