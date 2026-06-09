import { describe, expect, test, beforeAll, afterAll } from "vitest";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import {
  resolveVaultPath,
  toVaultRelative,
  lookupTFile,
  VaultPathError,
  type VaultLike,
} from "./VaultPath";

let tmpRoot: string;

beforeAll(() => {
  // Real temp directory so realpath / containment checks run against a
  // real filesystem rather than a mock that hand-waves symlinks.
  tmpRoot = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "copilot-agent-vaultpath-")),
  );
  fs.mkdirSync(path.join(tmpRoot, "inbox"), { recursive: true });
  fs.writeFileSync(path.join(tmpRoot, "inbox", "note.md"), "# hi\n");
  fs.writeFileSync(path.join(tmpRoot, "root-note.md"), "root\n");
});

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function makeVault(): VaultLike {
  return {
    adapter: { getBasePath: () => tmpRoot },
    getFileByPath: (p: string) => {
      const abs = path.join(tmpRoot, p);
      if (fs.existsSync(abs) && fs.statSync(abs).isFile()) return { path: p };
      return null;
    },
    getAbstractFileByPath: (p: string) => {
      const abs = path.join(tmpRoot, p);
      if (fs.existsSync(abs)) return { path: p };
      return null;
    },
  };
}

describe("resolveVaultPath - valid inputs", () => {
  test("relative path without leading slash resolves under root", () => {
    const v = makeVault();
    const r = resolveVaultPath("inbox/note.md", v);
    expect(r).toBe(path.join(tmpRoot, "inbox", "note.md"));
  });

  test("leading slash is stripped (treated as vault-relative)", () => {
    const v = makeVault();
    const r = resolveVaultPath("/inbox/note.md", v);
    expect(r).toBe(path.join(tmpRoot, "inbox", "note.md"));
  });

  test("leading slashes on relative path treated same as plain relative", () => {
    const v = makeVault();
    expect(resolveVaultPath("//inbox/note.md", v)).toBe(
      resolveVaultPath("inbox/note.md", v),
    );
  });

  test("non-existent leaf still resolves (allowed for future writes)", () => {
    const v = makeVault();
    const r = resolveVaultPath("inbox/new-note.md", v);
    expect(r).toBe(path.join(tmpRoot, "inbox", "new-note.md"));
  });

  test("backslash separators are handled (Windows-style)", () => {
    const v = makeVault();
    const r = resolveVaultPath("inbox\\note.md", v);
    expect(r).toBe(path.join(tmpRoot, "inbox", "note.md"));
  });

  test("internal dot segments are collapsed", () => {
    const v = makeVault();
    const r = resolveVaultPath("./inbox/./note.md", v);
    expect(r).toBe(path.join(tmpRoot, "inbox", "note.md"));
  });
});

describe("resolveVaultPath - rejections", () => {
  const v = makeVault();

  test("rejects empty string", () => {
    expect(() => resolveVaultPath("", v)).toThrow(VaultPathError);
    expect(() => resolveVaultPath("   ", v)).toThrow(VaultPathError);
  });

  test("rejects non-string input", () => {
    // @ts-expect-error - validating runtime guard
    expect(() => resolveVaultPath(42, v)).toThrow(VaultPathError);
  });

  test("rejects UNC-style path (Phase 7 will route as extra-vault)", () => {
    expect(() => resolveVaultPath("\\\\server\\share\\file", v)).toThrow(
      /UNC/i,
    );
  });

  test("rejects Windows-style absolute path with drive letter", () => {
    expect(() => resolveVaultPath("C:\\Windows\\System32", v)).toThrow(
      VaultPathError,
    );
    expect(() => resolveVaultPath("c:/Windows/System32", v)).toThrow(
      VaultPathError,
    );
  });

  test("rejects path containing `..` segment", () => {
    expect(() => resolveVaultPath("inbox/../../../etc", v)).toThrow(
      /traversal/i,
    );
    expect(() => resolveVaultPath("..", v)).toThrow(/traversal/i);
    expect(() => resolveVaultPath("../sibling.md", v)).toThrow(/traversal/i);
  });

  test("rejects mixed-separator `..` segment (Windows-style escape)", () => {
    expect(() => resolveVaultPath("inbox\\..\\..\\etc", v)).toThrow(
      /traversal/i,
    );
  });

  test("rejects bare vault root references", () => {
    expect(() => resolveVaultPath(".", v)).toThrow(VaultPathError);
    // Note: `/` after slash-stripping becomes empty string → empty path
    expect(() => resolveVaultPath("/", v)).toThrow(VaultPathError);
  });

  test("rejects when adapter cannot expose getBasePath (mobile)", () => {
    const broken: VaultLike = { adapter: {} };
    expect(() => resolveVaultPath("inbox/note.md", broken)).toThrow(
      /getBasePath/i,
    );
  });
});

describe("resolveVaultPath - symlink containment", () => {
  test("symlink pointing OUTSIDE the vault is rejected", () => {
    // Create an "escape hatch" symlink inside the vault that resolves
    // to a path outside the vault root. If `realpath` containment
    // works correctly, resolving through it must fail.
    const outsideTarget = fs.mkdtempSync(
      path.join(os.tmpdir(), "copilot-agent-escape-"),
    );
    fs.writeFileSync(path.join(outsideTarget, "secret"), "owned\n");
    const linkPath = path.join(tmpRoot, "escape-link");
    try {
      fs.symlinkSync(outsideTarget, linkPath, "dir");
    } catch (err) {
      // Windows requires elevated privileges for symlinks; skip the
      // check on platforms where we can't create one. The realpath
      // defence is well-covered on POSIX CI; on Windows the absolute /
      // `..` rejections still apply.
      console.warn("Skipping symlink test: cannot create symlink", err);
      fs.rmSync(outsideTarget, { recursive: true, force: true });
      return;
    }
    try {
      const v = makeVault();
      expect(() => resolveVaultPath("escape-link/secret", v)).toThrow(
        /escapes the vault root/i,
      );
    } finally {
      fs.rmSync(linkPath, { force: true });
      fs.rmSync(outsideTarget, { recursive: true, force: true });
    }
  });

  test("symlink pointing INSIDE the vault is allowed", () => {
    const linkPath = path.join(tmpRoot, "alias.md");
    try {
      fs.symlinkSync(path.join(tmpRoot, "root-note.md"), linkPath, "file");
    } catch {
      return; // see symlink test note above
    }
    try {
      const v = makeVault();
      const r = resolveVaultPath("alias.md", v);
      // realpath resolves the alias to the underlying note inside the vault
      expect(r).toBe(path.join(tmpRoot, "root-note.md"));
    } finally {
      fs.rmSync(linkPath, { force: true });
    }
  });
});

describe("toVaultRelative", () => {
  test("converts absolute path back to forward-slash vault path", () => {
    const v = makeVault();
    const abs = path.join(tmpRoot, "inbox", "note.md");
    expect(toVaultRelative(abs, v)).toBe("inbox/note.md");
  });
});

describe("lookupTFile", () => {
  test("returns file when Obsidian knows the path", () => {
    const v = makeVault();
    expect(lookupTFile("inbox/note.md", v)).not.toBeNull();
  });

  test("returns null when Obsidian does not know the path", () => {
    const v = makeVault();
    expect(lookupTFile("inbox/missing.md", v)).toBeNull();
  });

  test("falls back to getAbstractFileByPath when getFileByPath unavailable", () => {
    const v: VaultLike = {
      adapter: { getBasePath: () => tmpRoot },
      getAbstractFileByPath: (p) =>
        p === "inbox/note.md" ? { path: p } : null,
    };
    expect(lookupTFile("inbox/note.md", v)).not.toBeNull();
    expect(lookupTFile("missing.md", v)).toBeNull();
  });
});
