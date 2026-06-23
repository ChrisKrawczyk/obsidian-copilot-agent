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

  it("round-trips stdio + HTTP entries, preserves unknown future keys, and migrates legacy Authorization to canonical credentials", async () => {
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
    // Phase 1: legacy `authorization` string is migrated to canonical
    // `credentials: { kind: "static-bearer", token }` on first save and the
    // legacy field is dropped from disk. Unknown future keys still survive.
    expect(saved[1]).toMatchObject({
      transport: "http",
      credentials: { kind: "static-bearer", token: "Bearer static" },
      futureHttp: "yes",
    });
    expect((saved[1] as Record<string, unknown>).authorization).toBeUndefined();
  });

  it("migrates legacy callTimeoutSeconds to canonical callTimeoutMs", async () => {
    const server = { ...stdio(), callTimeoutSeconds: 120 };
    const io = memoryIo({ mcpServers: [server] });
    const store = new McpSettingsStore(io);
    const loaded = await store.load();
    expect(loaded[0]).toMatchObject({ callTimeoutMs: 120_000 });
    expect((loaded[0] as unknown as Record<string, unknown>).callTimeoutSeconds).toBeUndefined();
    await store.save();
    const saved = (io.peek() as { mcpServers: Record<string, unknown>[] }).mcpServers[0];
    expect(saved.callTimeoutMs).toBe(120_000);
    expect(saved.callTimeoutSeconds).toBeUndefined();
  });

  it("persists authorization notice flag", async () => {
    const io = memoryIo({ mcpServers: [] });
    const store = new McpSettingsStore(io);
    await store.load();
    expect(store.hasAuthorizationNoticeShown()).toBe(false);
    await store.markAuthorizationNoticeShown();
    expect((io.peek() as { mcpAuthorizationNoticeShown: boolean }).mcpAuthorizationNoticeShown).toBe(true);
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

  describe("credentials variants (FR-001, FR-002, FR-012)", () => {
    function httpWithCreds(credentials: unknown): Record<string, unknown> {
      return {
        id: "http_server",
        name: "HTTP",
        enabled: true,
        transport: "http",
        url: "https://example.com/mcp",
        credentials,
      };
    }

    it("parses `none` credentials and persists them losslessly", async () => {
      const io = memoryIo({ mcpServers: [httpWithCreds({ kind: "none" })] });
      const store = new McpSettingsStore(io);
      const loaded = await store.load();
      expect((loaded[0] as { credentials?: unknown }).credentials).toEqual({
        kind: "none",
      });
      await store.save();
      const saved = (io.peek() as { mcpServers: Record<string, unknown>[] })
        .mcpServers[0];
      expect(saved.credentials).toEqual({ kind: "none" });
    });

    it("parses `static-bearer` credentials and shows the authorization notice", async () => {
      const io = memoryIo({
        mcpServers: [
          httpWithCreds({ kind: "static-bearer", token: "Bearer abc" }),
        ],
      });
      const store = new McpSettingsStore(io);
      await store.load();
      expect(store.hasAuthorizationNoticeShown()).toBe(true);
    });

    it("parses `command-based` credentials with optional fields and persists them losslessly", async () => {
      const credentials = {
        kind: "command-based",
        command: "az account get-access-token --scope foo --output json",
        args: ["foo", "bar"],
        tokenPath: "accessToken",
        expiryPath: "expiresOn",
        refreshBufferSeconds: 600,
      };
      const io = memoryIo({ mcpServers: [httpWithCreds(credentials)] });
      const store = new McpSettingsStore(io);
      const loaded = await store.load();
      expect((loaded[0] as { credentials?: unknown }).credentials).toEqual(
        credentials,
      );
      await store.save();
      const saved = (io.peek() as { mcpServers: Record<string, unknown>[] })
        .mcpServers[0];
      expect(saved.credentials).toEqual(credentials);
    });

    it("rejects malformed `command-based` credentials (missing required command)", async () => {
      const notify = vi.fn();
      const io = memoryIo({
        mcpServers: [httpWithCreds({ kind: "command-based" })],
      });
      const store = new McpSettingsStore(io, notify);
      expect(await store.load()).toHaveLength(0);
      expect(notify).toHaveBeenCalled();
    });

    it("rejects unknown credential kinds", async () => {
      const notify = vi.fn();
      const io = memoryIo({
        mcpServers: [httpWithCreds({ kind: "bogus", anything: "yes" })],
      });
      const store = new McpSettingsStore(io, notify);
      expect(await store.load()).toHaveLength(0);
      expect(notify).toHaveBeenCalled();
    });

    it("round-trips the full `oauth-pkce` reserved field set with byte equivalence (SC-008, FR-012)", async () => {
      // FR-012 enumerates 9 fields. The persisted shape must round-trip
      // byte-equivalent through save -> load -> save so a future plugin
      // version implementing OAuth + PKCE can read configs written today
      // without migration loss.
      const credentials = {
        kind: "oauth-pkce",
        authorizationEndpoint: "https://login.example.com/oauth/authorize",
        tokenEndpoint: "https://login.example.com/oauth/token",
        clientId: "client-abc-123",
        tenantId: "tenant-xyz-789",
        scopes: ["openid", "profile", "https://api.example.com/.default"],
        redirectUri: "obsidian://copilot-agent/oauth/callback",
        refreshTokenRef: "ref:keychain:server-id:refresh",
        pkceMethod: "S256",
        // Unknown future keys must round-trip too — the index signature on
        // OAuthPkceCredentials preserves them so a future plugin version
        // can read them after introducing the field.
        deviceCodeEndpoint: "https://login.example.com/oauth/devicecode",
        customExtension: { audit: true, count: 7 },
      };
      const io = memoryIo({ mcpServers: [httpWithCreds(credentials)] });
      const store = new McpSettingsStore(io);
      await store.load();
      await store.save();
      const firstSave = (io.peek() as { mcpServers: Record<string, unknown>[] })
        .mcpServers[0];
      const firstSaveJson = JSON.stringify(firstSave.credentials);
      // Save -> load -> save second round must be byte-equivalent on the
      // credentials block.
      const store2 = new McpSettingsStore(io);
      await store2.load();
      await store2.save();
      const secondSave = (
        io.peek() as { mcpServers: Record<string, unknown>[] }
      ).mcpServers[0];
      expect(JSON.stringify(secondSave.credentials)).toBe(firstSaveJson);
      // Every enumerated FR-012 field survives by value
      expect(secondSave.credentials).toMatchObject(credentials);
    });

    it("migrates legacy `authorization` to `credentials` on load and drops the legacy field on first save", async () => {
      const io = memoryIo({
        mcpServers: [
          {
            id: "legacy",
            name: "Legacy",
            enabled: true,
            transport: "http",
            url: "https://example.com/mcp",
            authorization: "Bearer legacy",
          },
        ],
      });
      const store = new McpSettingsStore(io);
      const loaded = await store.load();
      // In-memory migration: synthesize static-bearer credentials. The
      // legacy `authorization` field stays on the in-memory shape so that
      // a load-without-save does not rewrite the file on disk.
      expect((loaded[0] as { credentials?: unknown }).credentials).toEqual({
        kind: "static-bearer",
        token: "Bearer legacy",
      });
      expect(
        (loaded[0] as { authorization?: unknown }).authorization,
      ).toBe("Bearer legacy");
      await store.save();
      // After save, the legacy field is gone from disk; only canonical
      // `credentials` remains.
      const saved = (io.peek() as { mcpServers: Record<string, unknown>[] })
        .mcpServers[0];
      expect(saved.authorization).toBeUndefined();
      expect(saved.credentials).toEqual({
        kind: "static-bearer",
        token: "Bearer legacy",
      });
    });

    it("never serializes runtime credential status fields (FR-002 plaintext scope)", async () => {
      // Confirms that adding `credentials` does not inadvertently widen the
      // runtime-field strip path. A future runtime snapshot field like
      // `credentialStatus` injected onto a server entry must still be
      // dropped by stripRuntimeFields on save.
      const io = memoryIo({
        mcpServers: [
          {
            ...httpWithCreds({ kind: "static-bearer", token: "Bearer x" }),
            status: "connected",
          },
        ],
      });
      const store = new McpSettingsStore(io);
      await store.load();
      await store.save();
      const saved = (io.peek() as { mcpServers: Record<string, unknown>[] })
        .mcpServers[0];
      expect(saved.status).toBeUndefined();
      expect(saved.credentials).toEqual({
        kind: "static-bearer",
        token: "Bearer x",
      });
    });
  });
});
