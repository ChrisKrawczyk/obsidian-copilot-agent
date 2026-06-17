import { EventEmitter } from "node:events";
import fs from "node:fs";
import { describe, expect, test, vi } from "vitest";
import { StdioTransport, resolveCommandForSpawn } from "./StdioTransport";
import type { ChildProcessWithoutNullStreams } from "node:child_process";

describe("StdioTransport", () => {
  test("spawns with array args, shell false, filtered env, and vault cwd by default", async () => {
    const spawn = vi.fn(() => fakeChild());
    const transport = new StdioTransport(
      { command: "node", args: ["server.js"], env: { SAFE: "1" } },
      {
        vaultRoot: "C:\\vault",
        inheritedEnv: { GITHUB_TOKEN: "secret", PATH: "bin" },
        spawn,
      },
    );
    await transport.start();
    expect(spawn).toHaveBeenCalledWith(
      "node",
      ["server.js"],
      expect.objectContaining({
        shell: false,
        cwd: "C:\\vault",
        env: expect.objectContaining({ PATH: "bin", SAFE: "1" }),
      }),
    );
    expect(spawn.mock.calls[0][2].env.GITHUB_TOKEN).toBeUndefined();
  });

  test("honors per-server cwd", async () => {
    const spawn = vi.fn(() => fakeChild());
    const transport = new StdioTransport(
      { command: "node", args: [], cwd: "C:\\other" },
      { vaultRoot: "C:\\vault", spawn },
    );
    await transport.start();
    expect(spawn.mock.calls[0][2].cwd).toBe("C:\\other");
  });

  test("resolves Windows .cmd through cmd.exe while preserving metacharacters as args", () => {
    const exists = vi.spyOn(fs, "existsSync").mockImplementation((candidate) => String(candidate) === "C:\\bin\\npx.cmd");
    const resolved = resolveCommandForSpawn(
      "npx.cmd",
      { PATH: "C:\\bin" },
      "win32",
      ["server", "& notepad"],
    );
    try {
      expect(resolved.command).toBe("cmd.exe");
      expect(resolved.args).toEqual(["/d", "/s", "/c", "C:\\bin\\npx.cmd", "server", "& notepad"]);
    } finally {
      exists.mockRestore();
    }
  });

  test("falls back to cmd.exe lookup when PATH candidates do not exist", () => {
    const exists = vi.spyOn(fs, "existsSync").mockReturnValue(false);
    try {
      const resolved = resolveCommandForSpawn(
        "npx.cmd",
        { PATH: ["C:\\nope1", "C:\\nope2", "C:\\Windows\\system32"].join(";") },
        "win32",
        ["server"],
      );
      expect(resolved).toEqual({ command: "cmd.exe", args: ["/d", "/s", "/c", "npx.cmd", "server"] });
    } finally {
      exists.mockRestore();
    }
  });

  test("captures redacted 64 KiB stderr ring with truncation marker", async () => {
    const child = fakeChild();
    const transport = new StdioTransport({ command: "x", args: [] }, { vaultRoot: "C:\\v", spawn: () => child });
    await transport.start();
    child.stderr.emit("data", Buffer.from(`${"a".repeat(70 * 1024)}\nOPENAI_API_KEY=secret`));
    expect(transport.getStderrTail()).toContain("stderr truncated");
    expect(transport.getStderrTail()).not.toContain("secret");
  });

  test("stubborn child receives stdin close, SIGTERM, then forced kill warning", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const child = fakeChild();
      const forced: unknown[] = [];
      const transport = new StdioTransport(
        { id: "server", command: "node", args: [] } as never,
        { vaultRoot: "C:\\vault", spawn: () => child, onForcedKill: (event) => forced.push(event) },
      );
      await transport.start();
      const close = transport.close();
      expect(child.stdin.end).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(child.kill).toHaveBeenCalledWith("SIGTERM");
      await vi.advanceTimersByTimeAsync(5_000);
      await close;
      expect(child.kill).toHaveBeenCalledTimes(2);
      expect(forced).toHaveLength(1);
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
      vi.useRealTimers();
    }
  });

  test("clean exit after stdin close sends no kill", async () => {
    vi.useFakeTimers();
    try {
      const child = fakeChild();
      const transport = new StdioTransport({ command: "node", args: [] }, { vaultRoot: "C:\\vault", spawn: () => child });
      await transport.start();
      const close = transport.close();
      child.emit("close");
      await close;
      await vi.advanceTimersByTimeAsync(10_000);
      expect(child.kill).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

function fakeChild(): ChildProcessWithoutNullStreams {
  const child = new EventEmitter() as ChildProcessWithoutNullStreams;
  child.stdout = new EventEmitter() as ChildProcessWithoutNullStreams["stdout"];
  child.stderr = new EventEmitter() as ChildProcessWithoutNullStreams["stderr"];
  child.stdin = Object.assign(new EventEmitter(), {
    writable: true,
    write: (_chunk: unknown, cb: (err?: Error) => void) => cb(),
    end: vi.fn(),
  }) as unknown as ChildProcessWithoutNullStreams["stdin"];
  child.kill = vi.fn() as unknown as ChildProcessWithoutNullStreams["kill"];
  child.pid = 1234;
  return child;
}
