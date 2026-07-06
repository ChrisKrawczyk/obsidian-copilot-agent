import { describe, expect, test, beforeAll, afterAll } from "vitest";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import {
  readFileImpl,
  viewImpl,
  searchContentImpl,
  searchInFiles,
  createReadTools,
  type ReadToolsVault,
  type TFileLike,
} from "./ReadTools";

let tmpRoot: string;

beforeAll(() => {
  tmpRoot = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "copilot-agent-readtools-")),
  );
  fs.mkdirSync(path.join(tmpRoot, "inbox"), { recursive: true });
  fs.mkdirSync(path.join(tmpRoot, "projects", "alpha"), { recursive: true });
  fs.writeFileSync(
    path.join(tmpRoot, "inbox", "today.md"),
    "# Today\n\nremember to ship phase 5\n",
  );
  fs.writeFileSync(
    path.join(tmpRoot, "projects", "alpha", "spec.md"),
    "Alpha project spec.\n\nThe foo widget supports bar.\n",
  );
  fs.writeFileSync(
    path.join(tmpRoot, "projects", "alpha", "notes.md"),
    "alpha notes\nbar baz\n",
  );
});

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function makeVault(): ReadToolsVault {
  const knownFiles: TFileLike[] = [
    { path: "inbox/today.md", extension: "md" },
    { path: "projects/alpha/spec.md", extension: "md" },
    { path: "projects/alpha/notes.md", extension: "md" },
  ];
  return {
    adapter: { getBasePath: () => tmpRoot },
    getFileByPath: (p) => knownFiles.find((f) => f.path === p) ?? null,
    getAbstractFileByPath: (p) => knownFiles.find((f) => f.path === p) ?? null,
    getMarkdownFiles: () => knownFiles,
    getFiles: () => knownFiles,
    read: async (file) => fs.readFileSync(path.join(tmpRoot, file.path), "utf8"),
    cachedRead: async (file) =>
      fs.readFileSync(path.join(tmpRoot, file.path), "utf8"),
  };
}

describe("readFileImpl", () => {
  test("reads a vault-tracked file by relative path", async () => {
    const r = await readFileImpl("inbox/today.md", makeVault());
    expect(r.path).toBe("inbox/today.md");
    expect(r.content).toContain("ship phase 5");
    expect(r.truncated).toBeUndefined();
  });

  test("accepts a leading-slash relative path", async () => {
    const r = await readFileImpl("/inbox/today.md", makeVault());
    expect(r.content).toContain("Today");
  });

  test("rejects path containing ..", async () => {
    await expect(readFileImpl("inbox/../etc", makeVault())).rejects.toThrow(
      /traversal/i,
    );
  });

  test("rejects Windows absolute path", async () => {
    await expect(readFileImpl("C:\\Windows\\hosts", makeVault())).rejects.toThrow(
      /Absolute Windows/i,
    );
  });

  test("returns clear error when file is not in the vault index", async () => {
    await expect(readFileImpl("nope/missing.md", makeVault())).rejects.toThrow(
      /not found in vault/i,
    );
  });
});

describe("viewImpl", () => {
  test("lists all files when no directory given", async () => {
    const r = await viewImpl("", makeVault());
    expect(r.directory).toBe("");
    expect(r.entries).toHaveLength(3);
  });

  test("lists files under a subdirectory", async () => {
    const r = await viewImpl("projects/alpha", makeVault());
    expect(r.directory).toBe("projects/alpha");
    expect(r.entries.map((e) => e.path).sort()).toEqual([
      "projects/alpha/notes.md",
      "projects/alpha/spec.md",
    ]);
  });

  test("rejects traversal paths", async () => {
    await expect(viewImpl("../etc", makeVault())).rejects.toThrow(/traversal/i);
  });
});

describe("searchContentImpl", () => {
  test("finds substring matches across files", async () => {
    const r = await searchContentImpl("bar", false, makeVault());
    expect(r.matches.length).toBeGreaterThan(0);
    expect(r.matches.every((m) => m.snippet.includes("bar"))).toBe(true);
  });

  test("regex mode treats query as a regex", async () => {
    const r = await searchContentImpl("ba[rz]", true, makeVault());
    expect(r.matches.length).toBeGreaterThanOrEqual(2);
  });

  test("invalid regex throws", async () => {
    await expect(searchContentImpl("(unclosed", true, makeVault())).rejects.toThrow(
      /Invalid regex/i,
    );
  });

  test("returns line numbers (1-based) and path for matches", async () => {
    const r = await searchContentImpl("Today", false, makeVault());
    expect(r.matches[0]).toMatchObject({
      path: "inbox/today.md",
      line: 1,
    });
  });

  test("skips known-files entries whose path escapes the vault via symlink", async () => {
    // Set up: an external file outside the vault root, and a symlink
    // inside the vault that points at it. The vault's "known files"
    // index claims the symlink is a regular markdown file in the
    // vault. resolveVaultPath should refuse to dereference it.
    const externalRoot = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "copilot-agent-external-")),
    );
    try {
      const secretPath = path.join(externalRoot, "secret.md");
      fs.writeFileSync(secretPath, "TOPSECRET tripwire content\n");
      const linkPath = path.join(tmpRoot, "leak.md");
      try {
        fs.symlinkSync(secretPath, linkPath, "file");
      } catch (err) {
        // Windows without SeCreateSymbolicLinkPrivilege — skip.
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "EPERM" || code === "ENOSYS") return;
        throw err;
      }
      try {
        const knownFiles: TFileLike[] = [
          { path: "inbox/today.md", extension: "md" },
          { path: "leak.md", extension: "md" },
        ];
        const vault: ReadToolsVault = {
          adapter: { getBasePath: () => tmpRoot },
          getFileByPath: (p) => knownFiles.find((f) => f.path === p) ?? null,
          getAbstractFileByPath: (p) =>
            knownFiles.find((f) => f.path === p) ?? null,
          getMarkdownFiles: () => knownFiles,
          getFiles: () => knownFiles,
          read: async (file) =>
            fs.readFileSync(path.join(tmpRoot, file.path), "utf8"),
          cachedRead: async (file) =>
            fs.readFileSync(path.join(tmpRoot, file.path), "utf8"),
        };
        const r = await searchContentImpl("TOPSECRET", false, vault);
        // The symlinked file must be silently skipped — no leak.md
        // match, no error surfaced to the caller.
        expect(r.matches.find((m) => m.path === "leak.md")).toBeUndefined();
        expect(
          r.matches.every((m) => !m.snippet.includes("TOPSECRET")),
        ).toBe(true);
      } finally {
        fs.rmSync(linkPath, { force: true });
      }
    } finally {
      fs.rmSync(externalRoot, { recursive: true, force: true });
    }
  });
});

describe("createReadTools", () => {
  test("returns three tools with expected names and flags", () => {
    const tools = createReadTools(makeVault());
    expect(tools).toHaveLength(3);
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    expect(byName.read_file).toBeDefined();
    expect(byName.view).toBeDefined();
    expect(byName.search_content).toBeDefined();
    expect(byName.read_file.overridesBuiltInTool).toBe(true);
    expect(byName.view.overridesBuiltInTool).toBe(true);
    expect(byName.read_file.skipPermission).toBe(true);
    expect(byName.search_content.skipPermission).toBe(true);
  });

  test("read_file tool handler round-trips via the SDK shape", async () => {
    const tools = createReadTools(makeVault());
    const tool = tools.find((t) => t.name === "read_file")!;
    const result = (await tool.handler!(
      { path: "inbox/today.md" },
      { sessionId: "s", toolCallId: "t", toolName: "read_file", arguments: {} },
    )) as { content: string };
    expect(result.content).toContain("ship phase 5");
  });
});

describe("searchInFiles", () => {
  test("substring mode matches legacy searchContentImpl output", async () => {
    const vault = makeVault();
    const files = vault.getMarkdownFiles!();
    const legacy = await searchContentImpl("bar", false, vault);
    const next = await searchInFiles(files, "bar", vault, { mode: "substring" });
    // Byte-identical match record shape (no score/spans) and same
    // totals/ordering — this is the SC-003 anchor for legacy behavior.
    expect(next.matches).toEqual(legacy.matches);
    expect(next.totalMatches).toBe(legacy.totalMatches);
    expect(next.truncated).toBe(legacy.truncated);
    expect(next.matches[0].score).toBeUndefined();
    expect(next.matches[0].spans).toBeUndefined();
  });

  test("regex mode matches legacy searchContentImpl output (SC-003)", async () => {
    const vault = makeVault();
    const files = vault.getMarkdownFiles!();
    const legacy = await searchContentImpl("ba.", true, vault);
    const next = await searchInFiles(files, "ba.", vault, { mode: "regex" });
    expect(next.matches).toEqual(legacy.matches);
    expect(next.totalMatches).toBe(legacy.totalMatches);
    expect(next.truncated).toBe(legacy.truncated);
    for (const m of next.matches) {
      expect(m.score).toBeUndefined();
      expect(m.spans).toBeUndefined();
    }
  });

  test("search_content tool handler preserves legacy output when mode is omitted (SC-003)", async () => {
    const vault = makeVault();
    const tools = createReadTools(vault);
    const tool = tools.find((t) => t.name === "search_content")!;
    const legacySubstring = await searchContentImpl("bar", false, vault);
    const handlerSubstring = (await tool.handler!(
      { query: "bar" },
      { sessionId: "s", toolCallId: "t", toolName: "search_content", arguments: {} },
    )) as typeof legacySubstring;
    expect(handlerSubstring).toEqual(legacySubstring);

    const legacyRegex = await searchContentImpl("ba.", true, vault);
    const handlerRegex = (await tool.handler!(
      { query: "ba.", regex: true },
      { sessionId: "s", toolCallId: "t", toolName: "search_content", arguments: {} },
    )) as typeof legacyRegex;
    expect(handlerRegex).toEqual(legacyRegex);
    for (const m of handlerRegex.matches as Array<{ score?: number; spans?: unknown }>) {
      expect(m.score).toBeUndefined();
      expect(m.spans).toBeUndefined();
    }
  });

  test("simple mode returns ranked matches with spans and scores", async () => {
    const vault = makeVault();
    const files = vault.getMarkdownFiles!();
    const r = await searchInFiles(files, "bar", vault, { mode: "simple" });
    expect(r.matches.length).toBeGreaterThan(0);
    for (const m of r.matches) {
      expect(typeof m.score).toBe("number");
      expect(Array.isArray(m.spans)).toBe(true);
      expect(m.spans!.length).toBeGreaterThan(0);
    }
    // Sorted by score desc.
    for (let i = 1; i < r.matches.length; i++) {
      expect(r.matches[i - 1].score! >= r.matches[i].score!).toBe(true);
    }
  });

  test("fuzzy mode tolerates a single dropped character", async () => {
    const vault = makeVault();
    const files = vault.getMarkdownFiles!();
    // "wiget" is "widget" with a dropped 'd'. Fuzzy subsequence
    // should still match the "widget" occurrence in spec.md.
    const r = await searchInFiles(files, "wiget", vault, { mode: "fuzzy" });
    expect(r.matches.length).toBeGreaterThan(0);
    expect(r.matches.some((m) => m.path === "projects/alpha/spec.md")).toBe(
      true,
    );
    expect(r.matches[0].score).toBeGreaterThan(0);
    expect(r.matches[0].spans!.length).toBeGreaterThan(0);
  });

  test("respects overridden limit and reports truncation", async () => {
    const vault = makeVault();
    const files = vault.getMarkdownFiles!();
    const r = await searchInFiles(files, "bar", vault, {
      mode: "simple",
      limit: 1,
    });
    expect(r.matches.length).toBe(1);
    expect(r.truncated).toBe(true);
    expect(r.totalMatches).toBeGreaterThan(1);
  });

  test("regex mode with invalid regex throws", async () => {
    const vault = makeVault();
    const files = vault.getMarkdownFiles!();
    await expect(
      searchInFiles(files, "([", vault, { mode: "regex" }),
    ).rejects.toThrow(/Invalid regex/);
  });
});
