import { EventEmitter } from "node:events";
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
    const resolved = resolveCommandForSpawn(
      "npx.cmd",
      { PATH: "C:\\bin" },
      "win32",
      ["server", "& notepad"],
    );
    expect(resolved.command).toBe("cmd.exe");
    expect(resolved.args).toEqual(["/d", "/s", "/c", "C:\\bin\\npx.cmd", "server", "& notepad"]);
  });

  test("captures redacted 64 KiB stderr ring with truncation marker", async () => {
    const child = fakeChild();
    const transport = new StdioTransport({ command: "x", args: [] }, { vaultRoot: "C:\\v", spawn: () => child });
    await transport.start();
    child.stderr.emit("data", Buffer.from(`${"a".repeat(70 * 1024)}\nOPENAI_API_KEY=secret`));
    expect(transport.getStderrTail()).toContain("stderr truncated");
    expect(transport.getStderrTail()).not.toContain("secret");
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
  return child;
}
