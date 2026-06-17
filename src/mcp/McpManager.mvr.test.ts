import { describe, expect, test, vi } from "vitest";
import { normalizeServerId } from "./McpIdentity";
import { McpManager } from "./McpManager";
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
