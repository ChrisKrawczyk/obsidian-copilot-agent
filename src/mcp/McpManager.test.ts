import { describe, expect, test } from "vitest";
import { normalizeServerId } from "./McpIdentity";
import { McpManager } from "./McpManager";
import type { McpServerConfig, McpToolInventoryEntry } from "./McpTypes";

describe("McpManager", () => {
  test("manual enable publishes immutable inventory snapshots", async () => {
    const server = config("s1");
    const manager = new McpManager({
      vaultRoot: "C:\\vault",
      serversProvider: () => [server],
      runtimeFactory: () => fakeRuntime(server, [tool(server, "a")]),
    });
    await manager.enable(server.id);
    const snap = manager.inventorySnapshot();
    expect(snap).toHaveLength(1);
    expect(Object.isFrozen(snap)).toBe(true);
    expect(Object.isFrozen(snap[0])).toBe(true);
  });

  test("same-server duplicate tool rejection fails enable", async () => {
    const server = config("s1");
    const manager = new McpManager({
      vaultRoot: "C:\\vault",
      serversProvider: () => [server],
      runtimeFactory: () => fakeRuntime(server, [tool(server, "a"), tool(server, "a")]),
    });
    await expect(manager.enable(server.id)).rejects.toThrow(/Duplicate/);
    expect(manager.inventorySnapshot()).toHaveLength(0);
  });

  test("disable and unload clear volatile inventory/session state", async () => {
    const server = config("s1");
    const runtime = fakeRuntime(server, [tool(server, "a")]);
    const manager = new McpManager({
      vaultRoot: "C:\\vault",
      serversProvider: () => [server],
      runtimeFactory: () => runtime,
    });
    await manager.enable(server.id);
    await manager.disable(server.id);
    expect(manager.inventorySnapshot()).toHaveLength(0);
    await manager.unload(server.id);
    expect(manager.getRuntimeForTest(server.id)).toBeUndefined();
  });

  test("status persistence is redacted and never contains session ids", async () => {
    const server = config("s1");
    const persisted: string[] = [];
    const manager = new McpManager({
      vaultRoot: "C:\\vault",
      serversProvider: () => [server],
      persistStatus: async (_id, snapshot) => persisted.push(JSON.stringify(snapshot)),
      runtimeFactory: () =>
        ({
          connect: async () => {
            throw new Error("Mcp-Session-Id: sid Bearer abc");
          },
          snapshot: () => ({ id: server.id, status: "error", lastError: "Mcp-Session-Id: sid" }),
          disable: async () => undefined,
          unload: async () => undefined,
        }) as never,
    });
    await expect(manager.enable(server.id)).rejects.toThrow();
    expect(persisted.join("\n")).not.toContain("sid");
    expect(persisted.join("\n")).not.toContain("abc");
  });

  test.each([
    ["name", (server: McpServerConfig) => ({ ...server, name: "Renamed" })],
    ["command", (server: McpServerConfig) => ({ ...server, command: "python" })],
    ["args", (server: McpServerConfig) => ({ ...server, args: ["next.js"] })],
    ["url", () => httpConfig("https://example.com/next")],
    ["transport", () => httpConfig("https://example.com/mcp")],
  ] as const)("enable recreates runtime after %s edit", async (_label, mutate) => {
    let server: McpServerConfig = config("s1");
    const seen: McpServerConfig[] = [];
    const manager = new McpManager({
      vaultRoot: "C:\\vault",
      serversProvider: () => [server],
      runtimeFactory: (cfg) => {
        seen.push(cfg);
        return fakeRuntime(cfg, [tool(cfg, "a")]);
      },
    });
    await manager.enable(server.id);
    server = mutate(server) as McpServerConfig;
    await manager.enable(server.id);
    expect(seen).toHaveLength(2);
    expect(seen[1]).toMatchObject(server);
  });

  test("manual reconnect recreates runtime after config edit", async () => {
    let server: McpServerConfig = config("s1");
    const seen: string[] = [];
    const manager = new McpManager({
      vaultRoot: "C:\\vault",
      serversProvider: () => [server],
      runtimeFactory: (cfg) => {
        seen.push(cfg.transport === "stdio" ? cfg.command : cfg.url);
        return fakeRuntime(cfg, [tool(cfg, "a")]);
      },
    });
    await manager.enable(server.id);
    server = { ...server, command: "python" };
    await manager.manualReconnect(server.id);
    expect(seen).toEqual(["node", "python"]);
  });
});

function config(id: string): McpServerConfig {
  return {
    id: normalizeServerId(id),
    name: id,
    enabled: true,
    trustEpoch: "epoch_test" as McpServerConfig["trustEpoch"],
    transport: "stdio",
    command: "node",
    args: [],
  };
}

function httpConfig(url: string): McpServerConfig {
  return {
    id: normalizeServerId("s1"),
    name: "s1",
    enabled: true,
    trustEpoch: "epoch_test" as McpServerConfig["trustEpoch"],
    transport: "http",
    url,
  };
}

function tool(server: McpServerConfig, name: string): McpToolInventoryEntry {
  return {
    serverId: server.id,
    serverName: server.name,
    toolName: name,
    syntheticId: `mcp__${server.id}__${name}`,
  };
}

function fakeRuntime(server: McpServerConfig, tools: McpToolInventoryEntry[]) {
  return {
    connect: async () => ({ serverId: server.id, tools }),
    reconnect: async () => ({ serverId: server.id, tools }),
    snapshot: () => ({ id: server.id, status: "connected", toolCount: tools.length }),
    disable: async () => undefined,
    unload: async () => undefined,
  } as never;
}
