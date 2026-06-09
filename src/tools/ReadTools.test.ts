import { describe, expect, test, beforeAll, afterAll } from "vitest";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import {
  readFileImpl,
  viewImpl,
  searchContentImpl,
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
