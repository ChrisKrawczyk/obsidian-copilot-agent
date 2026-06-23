import { describe, expect, test, vi } from "vitest";
import { normalizeServerId } from "./McpIdentity";
import { McpManager } from "./McpManager";
import { McpHttpError } from "./McpHttpError";
import type {
  McpHttpServerConfig,
  McpServerConfig,
  McpToolInventoryEntry,
} from "./McpTypes";
import type { CredentialResolver, ResolvedCredential } from "./credentials/CredentialResolver";
import type { ServerCredentials } from "./credentials/CredentialTypes";

function httpServer(id: string, credentials?: ServerCredentials): McpHttpServerConfig {
  return {
    id: normalizeServerId(id),
    name: id,
    enabled: true,
    trustEpoch: "epoch_test" as McpServerConfig["trustEpoch"],
    transport: "http",
    url: "https://example.com/mcp",
    ...(credentials ? { credentials } : {}),
  };
}

function fakeRuntime(server: McpServerConfig, opts: {
  callImpl: (toolName: string, args: Record<string, unknown>) => Promise<unknown>;
  tools?: McpToolInventoryEntry[];
}) {
  const tools = opts.tools ?? [];
  const runtime = {
    connect: async () => ({ serverId: server.id, tools }),
    reconnect: async () => ({ serverId: server.id, tools }),
    snapshot: () => ({ id: server.id, status: "connected", toolCount: tools.length }),
    disable: async () => undefined,
    unload: async () => undefined,
    clearVolatileSession: () => undefined,
    setCredentialSnapshot: vi.fn(),
    callTool: async (toolName: string, args: Record<string, unknown>) =>
      opts.callImpl(toolName, args),
  };
  return runtime as never;
}

function stubResolver(overrides: Partial<CredentialResolver> = {}): CredentialResolver {
  return {
    resolve: vi.fn(async () => ({ authorization: "Bearer ok", expiresAt: null, tenantId: null } as ResolvedCredential)),
    invalidate: vi.fn(),
    clear: vi.fn(),
    getLastKnownTenantId: vi.fn(() => null),
    ...overrides,
  } as unknown as CredentialResolver;
}

describe("McpManager Phase 4 credential integration", () => {
  test("401 from server triggers exactly one invalidate + retry; success on retry returns result", async () => {
    const creds: ServerCredentials = { kind: "static-bearer", token: "abc" };
    const server = httpServer("s1", creds);
    let callCount = 0;
    const runtime = fakeRuntime(server, {
      callImpl: async () => {
        callCount += 1;
        if (callCount === 1) throw new McpHttpError(401, "Bearer");
        return { ok: true };
      },
      tools: [{ serverId: server.id, serverName: server.name, toolName: "t", syntheticId: `mcp__${server.id}__t` }],
    });
    const resolver = stubResolver();
    const manager = new McpManager({
      vaultRoot: "C:\\vault",
      serversProvider: () => [server],
      runtimeFactory: () => runtime,
      credentialResolver: resolver,
    });
    await manager.enable(server.id);
    const result = await manager.callTool(server.id, "t", {});
    expect(result).toEqual({ ok: true });
    expect(callCount).toBe(2);
    expect(resolver.invalidate).toHaveBeenCalledTimes(1);
    expect(resolver.invalidate).toHaveBeenCalledWith(server.id);
  });

  test("two consecutive 401s surface remediation error (no infinite retry)", async () => {
    const creds: ServerCredentials = { kind: "static-bearer", token: "abc" };
    const server = httpServer("s1", creds);
    let callCount = 0;
    const runtime = fakeRuntime(server, {
      callImpl: async () => {
        callCount += 1;
        throw new McpHttpError(401, "Bearer");
      },
      tools: [{ serverId: server.id, serverName: server.name, toolName: "t", syntheticId: `mcp__${server.id}__t` }],
    });
    const manager = new McpManager({
      vaultRoot: "C:\\vault",
      serversProvider: () => [server],
      runtimeFactory: () => runtime,
      credentialResolver: stubResolver(),
    });
    await manager.enable(server.id);
    await expect(manager.callTool(server.id, "t", {})).rejects.toThrow(/Credentials rejected/);
    expect(callCount).toBe(2);
  });

  test("403 surfaces consent message without retry", async () => {
    const creds: ServerCredentials = { kind: "static-bearer", token: "abc" };
    const server = httpServer("s1", creds);
    let callCount = 0;
    const runtime = fakeRuntime(server, {
      callImpl: async () => {
        callCount += 1;
        throw new McpHttpError(403, null);
      },
      tools: [{ serverId: server.id, serverName: server.name, toolName: "t", syntheticId: `mcp__${server.id}__t` }],
    });
    const manager = new McpManager({
      vaultRoot: "C:\\vault",
      serversProvider: () => [server],
      runtimeFactory: () => runtime,
      credentialResolver: stubResolver(),
    });
    await manager.enable(server.id);
    await expect(manager.callTool(server.id, "t", {})).rejects.toThrow(/denied access/);
    expect(callCount).toBe(1);
  });

  test("onCredentialConfigChanged invokes resolver.invalidate for the named server only", () => {
    const server = httpServer("s1", { kind: "static-bearer", token: "abc" });
    const resolver = stubResolver();
    const manager = new McpManager({
      vaultRoot: "C:\\vault",
      serversProvider: () => [server],
      credentialResolver: resolver,
    });
    manager.onCredentialConfigChanged(server.id);
    expect(resolver.invalidate).toHaveBeenCalledTimes(1);
    expect(resolver.invalidate).toHaveBeenCalledWith(server.id);
  });

  test("non-McpHttpError pass-through is unchanged", async () => {
    const server = httpServer("s1", { kind: "static-bearer", token: "abc" });
    const runtime = fakeRuntime(server, {
      callImpl: async () => {
        throw new Error("transport blew up");
      },
      tools: [{ serverId: server.id, serverName: server.name, toolName: "t", syntheticId: `mcp__${server.id}__t` }],
    });
    const manager = new McpManager({
      vaultRoot: "C:\\vault",
      serversProvider: () => [server],
      runtimeFactory: () => runtime,
      credentialResolver: stubResolver(),
    });
    await manager.enable(server.id);
    await expect(manager.callTool(server.id, "t", {})).rejects.toThrow(/transport blew up/);
  });

  test("manager with no resolver does not retry 401 (preserves legacy behavior)", async () => {
    const server = httpServer("s1");
    let callCount = 0;
    const runtime = fakeRuntime(server, {
      callImpl: async () => {
        callCount += 1;
        throw new McpHttpError(401, null);
      },
      tools: [{ serverId: server.id, serverName: server.name, toolName: "t", syntheticId: `mcp__${server.id}__t` }],
    });
    const manager = new McpManager({
      vaultRoot: "C:\\vault",
      serversProvider: () => [server],
      runtimeFactory: () => runtime,
    });
    await manager.enable(server.id);
    await expect(manager.callTool(server.id, "t", {})).rejects.toThrow();
    expect(callCount).toBe(1);
  });

  test("CredentialResolutionFailed (command-failed) surfaces formatter command-failed message; no retry", async () => {
    const creds: ServerCredentials = { kind: "command-based", command: "az account get-access-token" };
    const server = httpServer("s1", creds);
    // The runtime is set up so that callTool only fires if it actually gets
    // called. We want to assert the resolution failure short-circuits.
    const callImpl = vi.fn(async () => {
      throw new (await import("./credentials/CredentialResolver")).CredentialResolutionFailed({
        kind: "command-failed",
        detail: "az exited with code 1",
        exitCode: 1,
      });
    });
    const runtime = fakeRuntime(server, {
      callImpl,
      tools: [{ serverId: server.id, serverName: server.name, toolName: "t", syntheticId: `mcp__${server.id}__t` }],
    });
    const manager = new McpManager({
      vaultRoot: "C:\\vault",
      serversProvider: () => [server],
      runtimeFactory: () => runtime,
      credentialResolver: stubResolver(),
    });
    await manager.enable(server.id);
    await expect(manager.callTool(server.id, "t", {})).rejects.toThrow(/Credential command failed/);
    // Only one call attempt — no retry on resolution failure
    expect(callImpl).toHaveBeenCalledTimes(1);
  });

  test("CredentialResolutionFailed (timeout) surfaces timeout message", async () => {
    const creds: ServerCredentials = { kind: "command-based", command: "az account get-access-token" };
    const server = httpServer("s1", creds);
    const callImpl = vi.fn(async () => {
      throw new (await import("./credentials/CredentialResolver")).CredentialResolutionFailed({
        kind: "timeout",
        detail: "Command timed out after 15000ms",
      });
    });
    const runtime = fakeRuntime(server, {
      callImpl,
      tools: [{ serverId: server.id, serverName: server.name, toolName: "t", syntheticId: `mcp__${server.id}__t` }],
    });
    const manager = new McpManager({
      vaultRoot: "C:\\vault",
      serversProvider: () => [server],
      runtimeFactory: () => runtime,
      credentialResolver: stubResolver(),
    });
    await manager.enable(server.id);
    await expect(manager.callTool(server.id, "t", {})).rejects.toThrow(/timed out/);
  });

  test("PA-1: copyable `az login --tenant <id>` is appended to chat error for M365 unauthorized", async () => {
    // Use the real M365RemediationFormatter so the copyable wires through.
    const { M365RemediationFormatter } = await import("./credentials/M365RemediationFormatter");
    const creds: ServerCredentials = { kind: "command-based", command: "az account get-access-token" };
    const server = httpServer("m365", creds);
    let callCount = 0;
    const runtime = fakeRuntime(server, {
      callImpl: async () => {
        callCount += 1;
        throw new McpHttpError(401, "Bearer");
      },
      tools: [{ serverId: server.id, serverName: server.name, toolName: "t", syntheticId: `mcp__${server.id}__t` }],
    });
    const resolver = stubResolver({
      getLastKnownTenantId: vi.fn(() => "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"),
    } as Partial<CredentialResolver>);
    const manager = new McpManager({
      vaultRoot: "C:\\vault",
      serversProvider: () => [server],
      runtimeFactory: () => runtime,
      credentialResolver: resolver,
      remediationFormatter: new M365RemediationFormatter(),
    });
    await manager.enable(server.id);
    const err = await manager.callTool(server.id, "t", {}).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/Azure CLI credentials/);
    expect((err as Error).message).toMatch(/Run: az login --tenant aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/);
    expect(callCount).toBe(2);
  });

  test("PA-1: copyable round-trips into runtime.setCredentialSnapshot on resolution failure", async () => {
    const { M365RemediationFormatter } = await import("./credentials/M365RemediationFormatter");
    const { CredentialResolutionFailed } = await import("./credentials/CredentialResolver");
    const creds: ServerCredentials = { kind: "command-based", command: "az account get-access-token" };
    const server = httpServer("m365", creds);
    const setCredentialSnapshot = vi.fn();
    // Wire up a runtime whose callImpl actually invokes the
    // getAuthorization callback the manager supplies, so the resolver
    // failure path runs through recordCredentialFailure.
    let getAuth: (() => Promise<string | null>) | undefined;
    const runtime = {
      connect: async () => ({ serverId: server.id, tools: [{ serverId: server.id, serverName: server.name, toolName: "t", syntheticId: `mcp__${server.id}__t` }] }),
      reconnect: async () => ({ serverId: server.id, tools: [] }),
      snapshot: () => ({ id: server.id, status: "connected", toolCount: 1 }),
      disable: async () => undefined,
      unload: async () => undefined,
      clearVolatileSession: () => undefined,
      setCredentialSnapshot,
      callTool: async () => {
        // Drive the dynamic-auth callback exactly like the real HTTP
        // transport would inside fetch.
        if (getAuth) await getAuth();
        return { ok: true };
      },
    } as never;
    const resolver = stubResolver({
      resolve: vi.fn(async () => {
        throw new CredentialResolutionFailed({
          kind: "command-failed",
          detail: "az exited with code 1",
          exitCode: 1,
        });
      }),
      getLastKnownTenantId: vi.fn(() => "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"),
    } as Partial<CredentialResolver>);
    const manager = new McpManager({
      vaultRoot: "C:\\vault",
      serversProvider: () => [server],
      runtimeFactory: (_cfg, opts) => {
        getAuth = opts.getAuthorization as (() => Promise<string | null>) | undefined;
        return runtime;
      },
      credentialResolver: resolver,
      remediationFormatter: new M365RemediationFormatter(),
    });
    await manager.enable(server.id);
    await expect(manager.callTool(server.id, "t", {})).rejects.toThrow(/Azure CLI/);
    const failureCall = setCredentialSnapshot.mock.calls.find((c) => c[0]?.state === "failed");
    expect(failureCall).toBeDefined();
    expect(failureCall![0].copyable).toBe("az login --tenant aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
    expect(failureCall![0].remediation).toMatch(/Azure CLI/);
  });

  test("PA-3: 401 retry path that fails with CredentialResolutionFailed surfaces formatted hint, not raw error", async () => {
    const { M365RemediationFormatter } = await import("./credentials/M365RemediationFormatter");
    const { CredentialResolutionFailed } = await import("./credentials/CredentialResolver");
    const creds: ServerCredentials = { kind: "command-based", command: "az account get-access-token" };
    const server = httpServer("m365", creds);
    let callCount = 0;
    const runtime = fakeRuntime(server, {
      callImpl: async () => {
        callCount += 1;
        if (callCount === 1) throw new McpHttpError(401, "Bearer");
        // On retry, the credential resolver itself fails (e.g. `az` exits
        // non-zero during the re-resolve). Without PA-3, this would be
        // rethrown verbatim and the user-facing error would lose the
        // `az login` hint.
        throw new CredentialResolutionFailed({
          kind: "command-failed",
          detail: "az exited with code 1",
          exitCode: 1,
        });
      },
      tools: [{ serverId: server.id, serverName: server.name, toolName: "t", syntheticId: `mcp__${server.id}__t` }],
    });
    const resolver = stubResolver({
      getLastKnownTenantId: vi.fn(() => "tenant-abc"),
    } as Partial<CredentialResolver>);
    const manager = new McpManager({
      vaultRoot: "C:\\vault",
      serversProvider: () => [server],
      runtimeFactory: () => runtime,
      credentialResolver: resolver,
      remediationFormatter: new M365RemediationFormatter(),
    });
    await manager.enable(server.id);
    const err = await manager.callTool(server.id, "t", {}).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/Azure CLI/);
    expect((err as Error).message).toMatch(/Run: az login --tenant tenant-abc/);
    expect(callCount).toBe(2);
  });

  test("SM-6 / FR-009: two 401s update runtime.setCredentialSnapshot to state=failed", async () => {
    const { M365RemediationFormatter } = await import("./credentials/M365RemediationFormatter");
    const creds: ServerCredentials = { kind: "command-based", command: "az account get-access-token" };
    const server = httpServer("m365", creds);
    const setCredentialSnapshot = vi.fn();
    const runtime = {
      ...fakeRuntime(server, {
        callImpl: async () => {
          throw new McpHttpError(401, "Bearer");
        },
        tools: [{ serverId: server.id, serverName: server.name, toolName: "t", syntheticId: `mcp__${server.id}__t` }],
      }),
      setCredentialSnapshot,
    } as never;
    const resolver = stubResolver({
      getLastKnownTenantId: vi.fn(() => "tenant-xyz"),
    } as Partial<CredentialResolver>);
    const manager = new McpManager({
      vaultRoot: "C:\\vault",
      serversProvider: () => [server],
      runtimeFactory: () => runtime,
      credentialResolver: resolver,
      remediationFormatter: new M365RemediationFormatter(),
    });
    await manager.enable(server.id);
    await expect(manager.callTool(server.id, "t", {})).rejects.toThrow(/Azure CLI/);
    const failureCall = setCredentialSnapshot.mock.calls.find((c) => c[0]?.state === "failed");
    expect(failureCall).toBeDefined();
    expect(failureCall![0].lastError).toMatch(/Credentials rejected by server/);
    expect(failureCall![0].copyable).toBe("az login --tenant tenant-xyz");
  });
});
