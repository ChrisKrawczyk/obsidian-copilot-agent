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

  describe("waitUntilEnabledReady (Phase 9)", () => {
    test("resolves immediately when no servers are enabled", async () => {
      const manager = new McpManager({
        vaultRoot: "C:\\vault",
        serversProvider: () => [],
        runtimeFactory: () => fakeRuntime(config("x"), []),
      });
      await expect(manager.waitUntilEnabledReady(1000)).resolves.toBeUndefined();
    });

    test("resolves after all enabled servers reach terminal status", async () => {
      const server = config("s1");
      const manager = new McpManager({
        vaultRoot: "C:\\vault",
        serversProvider: () => [server],
        runtimeFactory: () => fakeRuntime(server, [tool(server, "a")]),
      });
      // Not-yet-enabled: no runtime exists, so gate should not resolve.
      const started = manager.waitUntilEnabledReady(5000);
      let resolved = false;
      void started.then(() => {
        resolved = true;
      });
      await new Promise((r) => setTimeout(r, 20));
      expect(resolved).toBe(false);
      // Enabling causes runtime creation + connect() success → status
      // becomes "connected" (terminal). Gate should resolve.
      await manager.enable(server.id);
      await started;
      expect(resolved).toBe(true);
    });

    test("resolves after timeout even if a server never becomes ready", async () => {
      const server = config("slow");
      // Runtime that hangs on connect: gate falls back to timeout.
      const hangingRuntime = () =>
        ({
          connect: () => new Promise(() => undefined),
          reconnect: () => new Promise(() => undefined),
          snapshot: () => ({ id: server.id, status: "connecting", toolCount: 0 }),
          disable: async () => undefined,
          unload: async () => undefined,
        }) as never;
      const manager = new McpManager({
        vaultRoot: "C:\\vault",
        serversProvider: () => [server],
        runtimeFactory: hangingRuntime,
      });
      // Kick off enable in the background (never resolves).
      void manager.enable(server.id).catch(() => undefined);
      const t0 = Date.now();
      await manager.waitUntilEnabledReady(100);
      const elapsed = Date.now() - t0;
      expect(elapsed).toBeGreaterThanOrEqual(90);
      expect(elapsed).toBeLessThan(500);
    });

    test("error status counts as terminal (broken server doesn't block gate)", async () => {
      // Use HTTP transport so `enableInternal` does not push the
      // reconnect policy into "reconnecting" on failure (that override
      // would mask the "error" snapshot in statusSnapshot()).
      const server = httpConfig("https://example.invalid");
      const failingRuntime = () =>
        ({
          connect: async () => {
            throw new Error("boom");
          },
          reconnect: async () => {
            throw new Error("boom");
          },
          snapshot: () => ({ id: server.id, status: "error", toolCount: 0 }),
          disable: async () => undefined,
          unload: async () => undefined,
          clearVolatileSession: () => undefined,
        }) as never;
      const manager = new McpManager({
        vaultRoot: "C:\\vault",
        serversProvider: () => [server],
        runtimeFactory: failingRuntime,
      });
      await manager.enable(server.id).catch(() => undefined);
      await expect(manager.waitUntilEnabledReady(5000)).resolves.toBeUndefined();
    });
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
