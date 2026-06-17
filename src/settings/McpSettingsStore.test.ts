import { describe, expect, it, vi } from "vitest";
import type { PluginDataIO } from "../auth/TokenStore";
import { computeTrustEpoch, normalizeServerId } from "../mcp/McpIdentity";
import type { McpServerConfig } from "../mcp/McpTypes";
import { McpSettingsStore } from "./McpSettingsStore";

function memoryIo(initial: unknown = null): PluginDataIO & { peek: () => unknown } {
  let store: unknown = initial;
  return {
    loadData: async () => store,
    saveData: async (data: unknown) => {
      store = data;
    },
    peek: () => store,
  };
}

const stdio = (id = "alpha"): McpServerConfig => {
  const config = {
    id: normalizeServerId(id),
    name: "Alpha",
    enabled: true,
    transport: "stdio" as const,
    command: "node",
    args: ["server.js"],
    future: { keep: true },
  };
  return { ...config, trustEpoch: computeTrustEpoch(config) };
};

const http = (): McpServerConfig => {
  const config = {
    id: normalizeServerId("http_server"),
    name: "HTTP",
    enabled: true,
    transport: "http" as const,
    url: "https://example.com/mcp",
    authorization: "Bearer static",
  };
  return { ...config, trustEpoch: computeTrustEpoch(config) };
};

describe("McpSettingsStore", () => {
  it("defaults missing and non-array mcpServers to []", async () => {
    expect(await new McpSettingsStore(memoryIo({ auth: {} })).load()).toEqual([]);
    expect(
      await new McpSettingsStore(memoryIo({ mcpServers: "bad" })).load(),
    ).toEqual([]);
  });

  it("drops malformed entries, preserves valid siblings, and notices dropped ids once", async () => {
    const notify = vi.fn();
    const store = new McpSettingsStore(
      memoryIo({
        mcpServers: [stdio(), { id: "bad/id", name: "Bad" }, { id: "missing" }],
      }),
      notify,
    );
    expect(await store.load()).toHaveLength(1);
    await store.load();
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][0]).toContain("bad/id");
    expect(notify.mock.calls[0][0]).toContain("missing");
  });

  it("writes cleaned shape on first subsequent save and preserves top-level siblings", async () => {
    const io = memoryIo({
      auth: { token: "tok" },
      safety: { defaultMode: "require-approval" },
      conversations: [{ id: "c1" }],
      mcpServers: [stdio(), { id: "broken" }],
    });
    const store = new McpSettingsStore(io, vi.fn());
    await store.load();
    await store.save();
    const persisted = io.peek() as { mcpServers: unknown[]; auth: unknown; safety: unknown; conversations: unknown };
    expect(persisted.mcpServers).toHaveLength(1);
    expect(persisted.auth).toEqual({ token: "tok" });
    expect(persisted.safety).toEqual({ defaultMode: "require-approval" });
    expect(persisted.conversations).toEqual([{ id: "c1" }]);
  });

  it("round-trips stdio, HTTP, unknown future keys, and static Authorization", async () => {
    const io = memoryIo({ mcpServers: [stdio(), { ...http(), futureHttp: "yes" }] });
    const store = new McpSettingsStore(io);
    const loaded = await store.load();
    await store.save(loaded);
    const saved = (io.peek() as { mcpServers: McpServerConfig[] }).mcpServers;
    expect(saved[0]).toMatchObject({
      transport: "stdio",
      command: "node",
      args: ["server.js"],
      future: { keep: true },
    });
    expect(saved[1]).toMatchObject({
      transport: "http",
      authorization: "Bearer static",
      futureHttp: "yes",
    });
  });

  it("never serializes runtime-only fields including Mcp-Session-Id", async () => {
    const server = {
      ...http(),
      status: "connected",
      lastError: "secret",
      "Mcp-Session-Id": "sid",
      headers: { Authorization: "Bearer static", "Mcp-Session-Id": "sid" },
    };
    const io = memoryIo({ mcpServers: [server] });
    const store = new McpSettingsStore(io);
    await store.load();
    await store.save();
    const saved = (io.peek() as { mcpServers: Record<string, unknown>[] })
      .mcpServers[0];
    expect(saved.status).toBeUndefined();
    expect(saved.lastError).toBeUndefined();
    expect(saved["Mcp-Session-Id"]).toBeUndefined();
    expect(saved.headers).toEqual({ Authorization: "Bearer static" });
  });

  it("rejects duplicate ids on add", async () => {
    const store = new McpSettingsStore(memoryIo({ mcpServers: [stdio()] }));
    await store.load();
    await expect(store.add(stdio("ALPHA"))).rejects.toThrow(/already exists/);
  });

  it("notifies subscribers for mutation helpers", async () => {
    const store = new McpSettingsStore(memoryIo(null));
    const seen: number[] = [];
    store.subscribe((servers) => seen.push(servers.length));
    await store.add(stdio());
    await store.setEnabled(normalizeServerId("alpha"), false);
    await store.remove(normalizeServerId("alpha"));
    expect(seen).toEqual([1, 1, 0]);
  });
});
