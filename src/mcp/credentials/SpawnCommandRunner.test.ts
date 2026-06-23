import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SpawnCommandRunner, resolveCommandForSpawn } from "./SpawnCommandRunner";

const NODE = process.execPath;

describe("SpawnCommandRunner", () => {
  describe("happy path", () => {
    it("runs a real command and returns stdout / stderr / exitCode=0", async () => {
      const runner = new SpawnCommandRunner();
      const payload = { accessToken: "x", expiresOn: 9_999_999_999 };
      const result = await runner.run(
        [NODE, "-e", `process.stdout.write(JSON.stringify(${JSON.stringify(payload)}))`],
        5_000,
      );
      expect(result.exitCode).toBe(0);
      expect(result.timedOut).toBe(false);
      expect(JSON.parse(result.stdout)).toEqual(payload);
    });

    it("captures stderr separately from stdout", async () => {
      const runner = new SpawnCommandRunner();
      const result = await runner.run(
        [NODE, "-e", `process.stderr.write("oops"); process.exit(3);`],
        5_000,
      );
      expect(result.exitCode).toBe(3);
      expect(result.stderr).toBe("oops");
      expect(result.stdout).toBe("");
    });

    it("delivers metacharacter argv literally (no shell expansion)", async () => {
      const runner = new SpawnCommandRunner();
      const result = await runner.run(
        [
          NODE,
          "-e",
          "process.stdout.write(JSON.stringify(process.argv.slice(1)))",
          "; echo x",
          "& whoami",
          "$(whoami)",
          "|cat",
        ],
        5_000,
      );
      expect(result.exitCode).toBe(0);
      const argv = JSON.parse(result.stdout) as string[];
      expect(argv).toEqual(["; echo x", "& whoami", "$(whoami)", "|cat"]);
    });
  });

  describe("timeout", () => {
    it("kills a long-running command and reports timedOut=true", async () => {
      const runner = new SpawnCommandRunner();
      const started = Date.now();
      const result = await runner.run(
        [NODE, "-e", "setTimeout(() => {}, 60_000)"],
        300,
      );
      const elapsed = Date.now() - started;
      expect(result.timedOut).toBe(true);
      expect(result.exitCode).toBe(-1);
      // Allow a generous margin; child kill + grace must complete well under 60s.
      expect(elapsed).toBeLessThan(5_000);
    });
  });

  describe("edge cases", () => {
    it("returns a synthetic failure when argv is empty", async () => {
      const runner = new SpawnCommandRunner();
      const result = await runner.run([], 1_000);
      expect(result.exitCode).toBe(-1);
      expect(result.timedOut).toBe(false);
      expect(result.stderr).toContain("empty");
    });

    it("surfaces spawn errors (ENOENT) without throwing", async () => {
      const runner = new SpawnCommandRunner();
      const result = await runner.run(
        ["this-binary-does-not-exist-xyzzy-12345"],
        2_000,
      );
      expect(result.exitCode).toBe(-1);
      expect(result.timedOut).toBe(false);
      expect(result.stderr.length).toBeGreaterThan(0);
    });
  });
});

describe("resolveCommandForSpawn", () => {
  it("passes through non-cmd commands unchanged on Windows", () => {
    const out = resolveCommandForSpawn("node", ["-e", "1"], {}, "win32");
    expect(out).toEqual({ command: "node", args: ["-e", "1"], usedCmdWrapper: false });
  });

  it("wraps cmd targets in cmd.exe /d /s /c with cross-spawn-style quoting", () => {
    const out = resolveCommandForSpawn(
      "C:\\Tools\\az.cmd",
      ["account", "get-access-token"],
      {},
      "win32",
    );
    expect(out.command).toBe("cmd.exe");
    expect(out.usedCmdWrapper).toBe(true);
    expect(out.args).toEqual([
      "/d",
      "/s",
      "/c",
      '""C:\\Tools\\az.cmd" "account" "get-access-token""',
    ]);
  });

  it("wraps .bat targets the same way as .cmd", () => {
    const out = resolveCommandForSpawn("C:\\Tools\\helper.bat", ["x"], {}, "win32");
    expect(out.command).toBe("cmd.exe");
    expect(out.usedCmdWrapper).toBe(true);
    expect(out.args).toEqual(["/d", "/s", "/c", '""C:\\Tools\\helper.bat" "x""']);
  });

  it("resolves bare .cmd via PATH on Windows", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "resolveCmd-"));
    try {
      const cmdPath = path.join(tmpDir, "fake.cmd");
      fs.writeFileSync(cmdPath, "@echo off\n");
      const env = { PATH: tmpDir };
      const out = resolveCommandForSpawn("fake.cmd", ["arg1"], env, "win32");
      expect(out.args).toEqual(["/d", "/s", "/c", `""${cmdPath}" "arg1""`]);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("does NOT wrap .cmd extension on non-Windows platforms", () => {
    const out = resolveCommandForSpawn("script.cmd", ["x"], {}, "linux");
    expect(out).toEqual({ command: "script.cmd", args: ["x"], usedCmdWrapper: false });
  });

  it("resolves bare command via PATHEXT (Windows) — `az` → `az.cmd` wrapper", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "resolveBareCmd-"));
    try {
      const cmdPath = path.join(tmpDir, "az.cmd");
      fs.writeFileSync(cmdPath, "@echo off\n");
      const env = { PATH: tmpDir, PATHEXT: ".COM;.EXE;.BAT;.CMD" };
      const out = resolveCommandForSpawn("az", ["account", "get-access-token"], env, "win32");
      expect(out.command).toBe("cmd.exe");
      expect(out.usedCmdWrapper).toBe(true);
      expect(out.args).toEqual([
        "/d",
        "/s",
        "/c",
        `""${cmdPath}" "account" "get-access-token""`,
      ]);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("falls back to raw command on Windows when bare name not found on PATH", () => {
    const out = resolveCommandForSpawn("nonexistent-tool-xyz", ["x"], { PATH: "" }, "win32");
    expect(out).toEqual({ command: "nonexistent-tool-xyz", args: ["x"], usedCmdWrapper: false });
  });

  it("quotes args containing whitespace-free cmd metacharacters so each token remains a single arg", () => {
    const out = resolveCommandForSpawn(
      "C:\\Tools\\az.cmd",
      ["&whoami", "|x", "(echo)", ">redir"],
      {},
      "win32",
    );
    // Each metacharacter-bearing token is its own `"..."` quoted segment;
    // cmd's tokenizer treats them as single args after the outer wrap is
    // stripped by `/s /c`.
    expect(out.args[3]).toBe(
      '""C:\\Tools\\az.cmd" "&whoami" "|x" "(echo)" ">redir""',
    );
  });

  it("escapes internal double quotes per CommandLineToArgvW rules", () => {
    const out = resolveCommandForSpawn(
      "C:\\Tools\\az.cmd",
      ['has "quotes"'],
      {},
      "win32",
    );
    expect(out.args[3]).toBe('""C:\\Tools\\az.cmd" "has \\"quotes\\"""');
  });

  it("escapes `%` to suppress cmd variable expansion (no env-var leak through .cmd wrappers)", () => {
    const out = resolveCommandForSpawn(
      "C:\\Tools\\az.cmd",
      ["%USERNAME%", "x%FOO%y"],
      {},
      "win32",
    );
    // Each `%` becomes `"^%"`, breaking out of the surrounding quoted run
    // so cmd's `^%` literal-escape applies (only valid outside quotes).
    expect(out.args[3]).toContain('"^%"USERNAME"^%"');
    expect(out.args[3]).toContain('"x"^%"FOO"^%"y"');
  });

  it("does not over-escape when argv has no `%`", () => {
    const out = resolveCommandForSpawn("C:\\Tools\\az.cmd", ["plain"], {}, "win32");
    expect(out.args[3]).not.toContain("^%");
  });

  it("SM-4: resolves bare command via PATHEXT case-insensitively (Windows env preserves `PathExt` casing)", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "resolveBareCmdCi-"));
    try {
      const cmdPath = path.join(tmpDir, "az.cmd");
      fs.writeFileSync(cmdPath, "@echo off\n");
      // Note the casing: `PathExt`, not `PATHEXT`. Node preserves env key
      // casing on Windows, so the lookup must be case-insensitive.
      const env = { PATH: tmpDir, PathExt: ".COM;.EXE;.BAT;.CMD" };
      const out = resolveCommandForSpawn("az", ["account", "get-access-token"], env, "win32");
      expect(out.command).toBe("cmd.exe");
      expect(out.usedCmdWrapper).toBe(true);
      expect(out.args[3]).toContain("az.cmd");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("SpawnCommandRunner Windows .cmd wrapper integration", () => {
  // Strategy: write a `.cmd` wrapper that invokes `node` with a fixed inline
  // script and forwards %* to it. The .cmd's job is purely to be the
  // `.cmd` entry point; the real argv inspection happens in node, which
  // reads process.argv directly from the OS argv array (no batch
  // re-interpolation of metacharacters).

  function makeCmdScript(tmpDir: string): string {
    const nodePath = process.execPath;
    const scriptPath = path.join(tmpDir, "print-argv.cmd");
    // The %* expands to the joined raw arg string. node parses its own
    // command line via the OS argv array, so metacharacter interpretation
    // by cmd at the script-line level is the actual risk surface we're
    // testing.
    const cmd =
      "@echo off\r\n" +
      `"${nodePath}" -e "process.stdout.write(JSON.stringify(process.argv.slice(1)))" %*\r\n`;
    fs.writeFileSync(scriptPath, cmd);
    return scriptPath;
  }

  it("delivers a benign arg through the .cmd wrapper unchanged", async () => {
    if (process.platform !== "win32") return;
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "spawnCmd-"));
    try {
      const scriptPath = makeCmdScript(tmpDir);
      const runner = new SpawnCommandRunner();
      const result = await runner.run([scriptPath, "hello-world"], 10_000);
      expect(result.exitCode).toBe(0);
      const argv = JSON.parse(result.stdout) as string[];
      expect(argv).toEqual(["hello-world"]);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("blocks whitespace-free cmd metacharacters from being interpreted (&, |, >, <, (, ))", async () => {
    if (process.platform !== "win32") return;
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "spawnCmd-"));
    try {
      const scriptPath = makeCmdScript(tmpDir);
      const runner = new SpawnCommandRunner();
      const malicious = ["&whoami", "|whoami", "(echo)", ">leak.txt", "<input"];
      const result = await runner.run([scriptPath, ...malicious], 10_000);
      expect(result.exitCode).toBe(0);
      const argv = JSON.parse(result.stdout) as string[];
      expect(argv).toEqual(malicious);
      // No stray leak.txt should have been created in the test cwd.
      expect(fs.existsSync(path.join(process.cwd(), "leak.txt"))).toBe(false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("delivers an arg with spaces and metacharacters as a single argv element", async () => {
    if (process.platform !== "win32") return;
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "spawnCmd-"));
    try {
      const scriptPath = makeCmdScript(tmpDir);
      const runner = new SpawnCommandRunner();
      const result = await runner.run([scriptPath, "& whoami in one arg"], 10_000);
      expect(result.exitCode).toBe(0);
      const argv = JSON.parse(result.stdout) as string[];
      expect(argv).toEqual(["& whoami in one arg"]);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("blocks cmd environment-variable expansion of `%VAR%` in argv", async () => {
    if (process.platform !== "win32") return;
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "spawnCmd-"));
    try {
      const scriptPath = makeCmdScript(tmpDir);
      const runner = new SpawnCommandRunner();
      // `%USERNAME%` is always defined on Windows; if expansion leaks the
      // value would arrive in argv instead of the literal `%USERNAME%`.
      // Also test `%FOO%` (likely unset) and `%COMSPEC%` (always set).
      const malicious = ["%USERNAME%", "%FOO%", "prefix-%COMSPEC%-suffix"];
      const result = await runner.run([scriptPath, ...malicious], 10_000);
      expect(result.exitCode).toBe(0);
      const argv = JSON.parse(result.stdout) as string[];
      expect(argv).toEqual(malicious);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
