import { describe, expect, test, vi } from "vitest";
import { normalizeServerId } from "./McpIdentity";
import { McpManager } from "./McpManager";
import type { McpServerConfig, McpToolInventoryEntry } from "./McpTypes";

describe("McpManager resilience", () => {
  test("stdio exit mid-call errors deterministically and built-in callers remain outside MCP inventory", async () => {
    const s = config("stdio", "stdio");
    const rt = runtime(s, { callTool: vi.fn(async () => { throw new Error("stdio exited"); }) });
    const manager = managerFor(s, rt);
    await manager.enable(s.id);
    await expect(manager.callTool(s.id, "x", {})).rejects.toThrow(/stdio exited/);
    expect(manager.inventorySnapshot().map((t) => t.syntheticId)).not.toContain("read_file");
  });

  test("HTTP drop mid-call clears inventory so next call reinitializes", async () => {
    const s = config("http", "http");
    const connect = vi.fn(async () => ({ serverId: s.id, tools: [tool(s, "x")] }));
    const callTool = vi.fn()
      .mockRejectedValueOnce(new Error("network 404 not found"))
      .mockResolvedValueOnce({ content: [{ type: "text", text: "ok" }] });
    const manager = managerFor(s, runtime(s, { connect, callTool }));
    await manager.enable(s.id);
    await expect(manager.callTool(s.id, "x", {})).rejects.toThrow(/404/);
    await manager.callTool(s.id, "x", {});
    expect(connect).toHaveBeenCalledTimes(2);
  });

  test("volatile session clearing is requested on initialize failure", async () => {
    const s = config("http", "http");
    const clearVolatileSession = vi.fn();
    const manager = managerFor(s, runtime(s, {
      connect: vi.fn(async () => { throw new Error("initialize failed Mcp-Session-Id: secret"); }),
      clearVolatileSession,
      snapshot: () => ({ id: s.id, status: "error", lastError: "initialize failed" }),
    }));
    await expect(manager.enable(s.id)).rejects.toThrow(/initialize failed/);
    expect(clearVolatileSession).toHaveBeenCalled();
  });

  test("refresh failure preserves previous inventory", async () => {
    const s = config("stdio", "stdio");
    let onListChanged!: (id: typeof s.id) => void;
    const manager = new McpManager({
      vaultRoot: "C:\\vault",
      serversProvider: () => [s],
      runtimeFactory: (_config, opts) => {
        onListChanged = opts.onListChanged as never;
        return runtime(s, { refreshInventory: vi.fn(async () => { throw new Error("refresh failed"); }) }) as never;
      },
    });
    await manager.enable(s.id);
    expect(manager.inventorySnapshot()).toHaveLength(1);
    onListChanged(s.id);
    await Promise.resolve();
    expect(manager.inventorySnapshot()).toHaveLength(1);
  });

  test("disable is idempotent and keeps cleanup ordered", async () => {
    const s = config("stdio", "stdio");
    const rt = runtime(s);
    const manager = managerFor(s, rt);
    await manager.enable(s.id);
    await manager.disable(s.id);
    await manager.disable(s.id);
    expect(rt.disable).toHaveBeenCalledTimes(2);
    expect(manager.inventorySnapshot()).toHaveLength(0);
  });

  test("remove is idempotent after runtime is already unloaded", async () => {
    const s = config("stdio", "stdio");
    const rt = runtime(s);
    const manager = managerFor(s, rt);
    await manager.enable(s.id);
    await manager.remove(s.id);
    await manager.remove(s.id);
    expect(rt.unload).toHaveBeenCalledTimes(1);
    expect(manager.getRuntimeForTest(s.id)).toBeUndefined();
  });

  test("pending MCP approval resolves cancelled on runtime disconnect before tools/call dispatch", async () => {
    const s = config("stdio", "stdio");
    let cancelPendingApproval!: (reason: string) => void;
    const rt = runtime(s, {
      callTool: vi.fn(async (name: string) => {
        if (name === "x") throw new Error("server disconnected");
        return { content: [{ type: "text", text: "unexpected" }] };
      }),
    });
    const manager = managerFor(s, rt, {
      settleTrackedCalls: () => cancelPendingApproval?.("MCP server disconnected."),
    });
    await manager.enable(s.id);
    const pending = pendingApprovalDispatch(s, manager, (cancel) => {
      cancelPendingApproval = cancel;
    });

    await expect(manager.callTool(s.id, "x", {})).rejects.toThrow(/server disconnected/);

    await expect(pending).resolves.toEqual({ kind: "cancelled", reason: "MCP server disconnected." });
    expect(rt.callTool).toHaveBeenCalledTimes(1);
    expect(rt.callTool).toHaveBeenCalledWith("x", {}, undefined);
  });

  test("pending MCP approval resolves cancelled on crashloop transition before tools/call dispatch", async () => {
    const s = config("stdio", "stdio");
    let cancelPendingApproval!: (reason: string) => void;
    const rt = runtime(s, {
      connect: vi.fn(async () => { throw new Error("boot failed"); }),
    });
    const manager = managerFor(s, rt, {
      settleTrackedCalls: () => cancelPendingApproval?.("MCP server disconnected."),
    });
    const pending = pendingApprovalDispatch(s, manager, (cancel) => {
      cancelPendingApproval = cancel;
    });

    for (let i = 0; i < 5; i += 1) {
      await expect(manager.enable(s.id)).rejects.toThrow(/boot failed/);
    }

    await expect(pending).resolves.toEqual({ kind: "cancelled", reason: "MCP server disconnected." });
    expect(rt.callTool).not.toHaveBeenCalled();
  });
});

function managerFor(
  s: McpServerConfig,
  rt: Record<string, unknown>,
  overrides: Partial<ConstructorParameters<typeof McpManager>[0]> = {},
): McpManager {
  return new McpManager({
    vaultRoot: "C:\\vault",
    serversProvider: () => [s],
    runtimeFactory: () => rt as never,
    ...overrides,
  });
}

type PendingApprovalChoice =
  | { kind: "approved" }
  | { kind: "cancelled"; reason: string };

async function pendingApprovalDispatch(
  s: McpServerConfig,
  manager: McpManager,
  captureCancel: (cancel: (reason: string) => void) => void,
): Promise<PendingApprovalChoice> {
  const approval = new Promise<PendingApprovalChoice>((resolve) => {
    captureCancel((reason) => resolve({ kind: "cancelled", reason }));
  });
  const choice = await approval;
  if (choice.kind === "approved") await manager.callTool(s.id, "read", {});
  return choice;
}

function runtime(s: McpServerConfig, overrides: Record<string, unknown> = {}) {
  const tools = [tool(s, "x")];
  return {
    connect: vi.fn(async () => ({ serverId: s.id, tools })),
    manualReconnect: vi.fn(async () => ({ serverId: s.id, tools })),
    reconnect: vi.fn(async () => ({ serverId: s.id, tools })),
    snapshot: () => ({ id: s.id, status: "connected", toolCount: tools.length }),
    disable: vi.fn(async () => undefined),
    unload: vi.fn(async () => undefined),
    isCrashloop: () => false,
    clearVolatileSession: vi.fn(),
    callTool: vi.fn(async () => ({ content: [{ type: "text", text: "ok" }] })),
    refreshInventory: vi.fn(async () => ({ serverId: s.id, tools })),
    markInventoryRejected: vi.fn(),
    markReconnecting: vi.fn(),
    markCrashloop: vi.fn(),
    ...overrides,
  };
}

function config(id: string, transport: "stdio" | "http"): McpServerConfig {
  return transport === "stdio"
    ? { id: normalizeServerId(id), name: id, enabled: true, trustEpoch: "e" as never, transport, command: "node", args: [] }
    : { id: normalizeServerId(id), name: id, enabled: true, trustEpoch: "e" as never, transport, url: "https://example.com/mcp" };
}

function tool(s: McpServerConfig, name: string): McpToolInventoryEntry {
  return { serverId: s.id, serverName: s.name, toolName: name, syntheticId: `mcp__${s.id}__${name}` };
}
