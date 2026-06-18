import { describe, expect, test, vi } from "vitest";
import { normalizeServerId } from "./McpIdentity";
import { McpManager } from "./McpManager";
import { buildMcpToolRegistrySnapshot } from "./McpToolRegistry";
import type { McpServerConfig, McpToolInventoryEntry } from "./McpTypes";

describe("McpManager MVR", () => {
  test("initialize is single-flight", async () => {
    const s = config("s");
    let releases!: () => void;
    const started = new Promise<void>((resolve) => { releases = resolve; });
    const connect = vi.fn(async () => { await started; return { serverId: s.id, tools: [tool(s, "x")] }; });
    const manager = managerFor(s, { connect });
    const a = manager.enable(s.id);
    const b = manager.enable(s.id);
    releases();
    await Promise.all([a, b]);
    expect(connect).toHaveBeenCalledTimes(1);
  });

  test("disable/remove abort by generation and removes tools", async () => {
    const s = config("s");
    let reject!: (err: Error) => void;
    const callTool = vi.fn(() => new Promise((_resolve, rej) => { reject = rej; }));
    const rt = runtime(s, { callTool });
    const manager = managerFor(s, rt);
    await manager.enable(s.id);
    const call = manager.callTool(s.id, "x", {});
    await manager.disable(s.id);
    reject(new Error("late"));
    await expect(call).rejects.toMatchObject({ name: "CancelledError" });
    expect(manager.inventorySnapshot()).toHaveLength(0);
  });

  test("fake-time tool-call timeout defaults to 60 seconds", async () => {
    const s = config("s");
    const manager = managerFor(s, runtime(s, { callTool: vi.fn(() => new Promise(() => undefined)) }));
    await manager.enable(s.id);
    vi.useFakeTimers();
    try {
      const call = manager.callTool(s.id, "x", {});
      const expectation = expect(call).rejects.toThrow(/timed out/);
      await vi.advanceTimersByTimeAsync(60_000);
      await expectation;
    } finally {
      vi.useRealTimers();
    }
  });

  test("mid-call crash finalizes error and leaves terminal UI state", async () => {
    const s = config("s");
    let reject!: (err: Error) => void;
    let crashed = false;
    const manager = managerFor(s, runtime(s, {
      callTool: vi.fn(() => new Promise((_resolve, rej) => { reject = rej; })),
      isCrashloop: () => crashed,
      snapshot: () => ({ id: s.id, status: crashed ? "crashloop" : "connected", toolCount: crashed ? 0 : 1 }),
    }));
    await manager.enable(s.id);
    const call = manager.callTool(s.id, "x", {});
    crashed = true;
    reject(new Error("server crashed"));
    await expect(call).rejects.toThrow(/server crashed/);
    expect(manager.statusSnapshot()[0]).toMatchObject({ status: "crashloop", toolCount: 0 });
  });

  test("remove triggers abort cancelled", async () => {
    const s = config("s");
    let reject!: (err: Error) => void;
    const manager = managerFor(s, runtime(s, { callTool: vi.fn(() => new Promise((_resolve, rej) => { reject = rej; })) }));
    await manager.enable(s.id);
    const call = manager.callTool(s.id, "x", {});
    await manager.remove(s.id);
    reject(new Error("late"));
    await expect(call).rejects.toMatchObject({ name: "CancelledError" });
  });

  test("reconnect triggers abort cancelled", async () => {
    const s = config("s");
    let reject!: (err: Error) => void;
    const manager = managerFor(s, runtime(s, { callTool: vi.fn(() => new Promise((_resolve, rej) => { reject = rej; })) }));
    await manager.enable(s.id);
    const call = manager.callTool(s.id, "x", {});
    await manager.reconnect(s.id);
    reject(new Error("late"));
    await expect(call).rejects.toMatchObject({ name: "CancelledError" });
  });

  test("crashloop terminal state hard-disables server and removes registry tools", async () => {
    const s = config("s");
    let crashed = false;
    const connect = vi.fn(async () => {
      if (crashed) throw new Error("crashloop");
      return { serverId: s.id, tools: [tool(s, "x")] };
    });
    const rt = runtime(s, {
      connect,
      isCrashloop: () => crashed,
      snapshot: () => ({ id: s.id, status: crashed ? "crashloop" : "connected", toolCount: crashed ? 0 : 1 }),
    });
    const manager = managerFor(s, rt);
    await manager.enable(s.id);
    crashed = true;
    await manager.enable(s.id);
    expect(connect).toHaveBeenCalledTimes(1);
    const snap = buildMcpToolRegistrySnapshot({
      inventory: [tool(s, "x")],
      statuses: manager.statusSnapshot(),
    });
    expect(snap.tools).toHaveLength(0);
  });

  test("crashloop enable is a no-op until manualReconnect resets attempts", async () => {
    const s = config("s");
    let crashed = false;
    const connect = vi.fn(async () => ({ serverId: s.id, tools: [tool(s, "x")] }));
    const rt = runtime(s, {
      connect,
      isCrashloop: () => crashed,
      snapshot: () => ({ id: s.id, status: crashed ? "crashloop" : "connected", toolCount: crashed ? 0 : 1 }),
      manualReconnect: vi.fn(async () => {
        crashed = false;
        return connect();
      }),
    });
    const manager = managerFor(s, rt);
    await manager.enable(s.id);
    crashed = true;
    await manager.enable(s.id);
    expect(connect).toHaveBeenCalledTimes(1);
    await manager.manualReconnect(s.id);
    expect(rt.manualReconnect).toHaveBeenCalledTimes(1);
    expect(connect).toHaveBeenCalledTimes(2);
    expect(crashed).toBe(false);
  });

  test("stderr is surfaced redacted on failure", async () => {
    const s = config("s");
    const manager = managerFor(s, runtime(s, {
      callTool: vi.fn(async () => { throw new Error("boom"); }),
      snapshot: () => ({ id: s.id, status: "connected", stderrTail: "Authorization: Bearer secret" }),
    }));
    await manager.enable(s.id);
    await expect(manager.callTool(s.id, "x", {})).rejects.toThrow(/stderr/);
    await expect(manager.callTool(s.id, "x", {})).rejects.not.toThrow(/secret/);
  });

  test("idle list_changed refreshes once; in-flight only marks stale", async () => {
    const s = config("s");
    let onListChanged!: (id: typeof s.id) => void;
    const refreshInventory = vi.fn(async () => ({ serverId: s.id, tools: [tool(s, "y")] }));
    const rt = runtime(s, { refreshInventory });
    const manager = new McpManager({
      vaultRoot: "C:\\vault",
      serversProvider: () => [s],
      runtimeFactory: (_c, opts) => {
        onListChanged = opts.onListChanged as never;
        return rt as never;
      },
    });
    await manager.enable(s.id);
    await onListChanged(s.id);
    expect(refreshInventory).toHaveBeenCalledTimes(1);
    rt.callTool = vi.fn(() => new Promise(() => undefined));
    void manager.callTool(s.id, "x", {});
    await onListChanged(s.id);
    expect(refreshInventory).toHaveBeenCalledTimes(1);
  });
});

function managerFor(s: McpServerConfig, rt: Partial<ReturnType<typeof runtime>>) {
  return new McpManager({ vaultRoot: "C:\\vault", serversProvider: () => [s], runtimeFactory: () => runtime(s, rt) as never });
}

function runtime(s: McpServerConfig, overrides: Record<string, unknown> = {}) {
  const tools = [tool(s, "x")];
  return {
    connect: vi.fn(async () => ({ serverId: s.id, tools })),
    manualReconnect: vi.fn(async () => ({ serverId: s.id, tools })),
    snapshot: () => ({ id: s.id, status: "connected", toolCount: tools.length }),
    disable: vi.fn(async () => undefined),
    unload: vi.fn(async () => undefined),
    isCrashloop: () => false,
    callTool: vi.fn(async () => ({ content: [{ type: "text", text: "ok" }] })),
    refreshInventory: vi.fn(async () => ({ serverId: s.id, tools })),
    markInventoryRejected: vi.fn(),
    ...overrides,
  };
}

function config(id: string): McpServerConfig {
  return { id: normalizeServerId(id), name: id, enabled: true, trustEpoch: "e" as never, transport: "stdio", command: "node", args: [] };
}

function tool(s: McpServerConfig, name: string): McpToolInventoryEntry {
  return { serverId: s.id, serverName: s.name, toolName: name, syntheticId: `mcp__${s.id}__${name}` };
}
