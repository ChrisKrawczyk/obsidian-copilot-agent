import { describe, expect, test, vi } from "vitest";
import { normalizeServerId } from "./mcp/McpIdentity";
import { McpManager } from "./mcp/McpManager";
import type { McpServerConfig } from "./mcp/McpTypes";
import {
  disableMcpServerLifecycle,
  disposeMcpLifecycle,
  removeMcpServerLifecycle,
  startMcpLifecycle,
} from "./main";

function server(id: string, enabled = true): McpServerConfig {
  return { id: normalizeServerId(id), name: id, enabled, trustEpoch: "epoch_test" as McpServerConfig["trustEpoch"], transport: "stdio", command: "node", args: [] };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

describe("main MCP lifecycle orchestration", () => {
  test("no servers means no spawn/fetch runtime construction", async () => {
    const runtimeFactory = vi.fn();
    const manager = new McpManager({ vaultRoot: "C:\\vault", serversProvider: () => [], runtimeFactory });
    await startMcpLifecycle(manager);
    expect(runtimeFactory).not.toHaveBeenCalled();
  });

  test("enabled servers start asynchronously and in parallel with allSettled semantics", async () => {
    const a = server("a");
    const b = server("b");
    const first = deferred<void>();
    const second = deferred<void>();
    const connects: string[] = [];
    const manager = new McpManager({
      vaultRoot: "C:\\vault",
      serversProvider: () => [a, b],
      runtimeFactory: (config) => ({
        connect: vi.fn(async () => {
          connects.push(config.id);
          await (config.id === a.id ? first.promise : second.promise);
          if (config.id === a.id) throw new Error("boom");
          return { serverId: config.id, tools: [] };
        }),
        snapshot: () => ({ id: config.id, status: config.id === a.id ? "error" : "connected" }),
        disable: vi.fn(async () => undefined),
        unload: vi.fn(async () => undefined),
      }) as never,
    });
    const started = startMcpLifecycle(manager);
    await Promise.resolve();
    expect(connects.sort()).toEqual(["a", "b"]);
    first.resolve();
    second.resolve();
    await expect(started).resolves.toBeUndefined();
  });

  test("disabled servers do not connect", async () => {
    const runtimeFactory = vi.fn();
    const manager = new McpManager({ vaultRoot: "C:\\vault", serversProvider: () => [server("off", false)], runtimeFactory });
    await startMcpLifecycle(manager);
    expect(runtimeFactory).not.toHaveBeenCalled();
  });

  test("unload disposes manager exactly once", async () => {
    const manager = { unload: vi.fn(async () => undefined) };
    await disposeMcpLifecycle(manager);
    expect(manager.unload).toHaveBeenCalledTimes(1);
  });

  test("remove stops active runtime and clears grants", async () => {
    const active = server("active");
    const runtime = { connect: vi.fn(async () => ({ serverId: active.id, tools: [] })), snapshot: () => ({ id: active.id, status: "connected" }), disable: vi.fn(), unload: vi.fn(async () => undefined) };
    const manager = new McpManager({ vaultRoot: "C:\\vault", serversProvider: () => [active], runtimeFactory: () => runtime as never });
    await manager.enable(active.id);
    const safety = { revokeGrantsForServer: vi.fn(async () => undefined) };
    await removeMcpServerLifecycle(manager, safety, active.id);
    expect(runtime.unload).toHaveBeenCalledTimes(1);
    expect(safety.revokeGrantsForServer).toHaveBeenCalledWith(active.id);
  });

  test("remove/disable settles tracked calls before late runtime responses can render", async () => {
    const active = server("active");
    const order: string[] = [];
    const runtime = {
      connect: vi.fn(async () => ({ serverId: active.id, tools: [] })),
      snapshot: () => ({ id: active.id, status: "connected" }),
      disable: vi.fn(async () => { order.push("disable"); }),
      unload: vi.fn(async () => { order.push("unload"); }),
    };
    const manager = new McpManager({
      vaultRoot: "C:\\vault",
      serversProvider: () => [active],
      runtimeFactory: () => runtime as never,
      settleTrackedCalls: async () => { order.push("settle"); },
    });
    await manager.enable(active.id);
    await disableMcpServerLifecycle(manager, active.id);
    await manager.enable(active.id);
    await removeMcpServerLifecycle(manager, { revokeGrantsForServer: vi.fn(async () => undefined) }, active.id);
    expect(order).toEqual(["settle", "disable", "settle", "unload"]);
  });
});
