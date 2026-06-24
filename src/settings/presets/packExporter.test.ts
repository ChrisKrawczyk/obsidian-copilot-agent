import { describe, expect, test } from "vitest";
import type { McpServerConfig, McpServerId, McpTrustEpoch } from "../../mcp/McpTypes";
import { exportServersAsPack } from "./packExporter";
import { SECRET_PLACEHOLDER } from "./packSecretPolicy";
import { validatePack } from "./packValidator";

const META = { id: "exported", label: "Exported", version: "1" };

function brand(id: string): McpServerId {
  return id as McpServerId;
}

function epoch(): McpTrustEpoch {
  return "epoch_test" as McpTrustEpoch;
}

function httpServer(
  partial: Partial<McpServerConfig> = {},
): McpServerConfig {
  return {
    id: brand("s1"),
    name: "Example",
    enabled: true,
    trustEpoch: epoch(),
    transport: "http",
    url: "https://example.com/mcp",
    ...partial,
  } as McpServerConfig;
}

function stdioServer(
  partial: Partial<McpServerConfig> = {},
): McpServerConfig {
  return {
    id: brand("s1"),
    name: "Example",
    enabled: true,
    trustEpoch: epoch(),
    transport: "stdio",
    command: "node",
    args: ["server.js"],
    ...partial,
  } as McpServerConfig;
}

describe("exportServersAsPack", () => {
  test("runtime/vault-state/persistence fields stripped (FR-011, SC-002)", () => {
    const server = httpServer({
      status: "connected",
      lastError: "x",
      tools: [],
      lastConnectedAt: 1,
      callTimeoutMs: 30000,
    } as Partial<McpServerConfig>);
    const pack = exportServersAsPack([server], META);
    const serialized = JSON.stringify(pack);
    for (const field of [
      "status",
      "lastError",
      "tools",
      "lastConnectedAt",
      "callTimeoutMs",
      "enabled",
      "trustEpoch",
    ]) {
      expect(serialized).not.toContain(`"${field}"`);
    }
  });

  test("denylisted env value templatized; non-denylisted preserved verbatim (FR-020, SC-002)", () => {
    const server = stdioServer({
      env: {
        OPENAI_API_KEY: "sk-leak",
        LOG_LEVEL: "debug",
      },
    });
    const pack = exportServersAsPack([server], META);
    const preset = pack.presets[0];
    expect(preset.server.transport).toBe("stdio");
    if (preset.server.transport !== "stdio") throw new Error("unreachable");
    expect(preset.server.env?.OPENAI_API_KEY).toBe(SECRET_PLACEHOLDER);
    expect(preset.server.env?.LOG_LEVEL).toBe("debug");
    expect(JSON.stringify(pack)).not.toContain("sk-leak");
  });

  test("HTTP static-bearer token replaced with placeholder; literal never appears", () => {
    const server = httpServer({
      credentials: { kind: "static-bearer", token: "super-secret-token-XYZ" },
    });
    const pack = exportServersAsPack([server], META);
    const serialized = JSON.stringify(pack);
    expect(serialized).not.toContain("super-secret-token-XYZ");
    expect(serialized).toContain(SECRET_PLACEHOLDER);
  });

  test("command-based: command and args preserved verbatim (FR-020 carve-out, SC-009)", () => {
    const server = httpServer({
      url: "https://mcp.svc.cloud.microsoft/enterprise",
      credentials: {
        kind: "command-based",
        command: "az account get-access-token --scope api://x/.default --output json",
        tokenPath: "accessToken",
        expiryPath: "expiresOn",
        refreshBufferSeconds: 300,
      },
    });
    const pack = exportServersAsPack([server], META);
    const creds = pack.presets[0].credentials;
    expect(creds.kind).toBe("command-based");
    if (creds.kind !== "command-based") throw new Error("unreachable");
    expect(creds.command).toBe(
      "az account get-access-token --scope api://x/.default --output json",
    );
    expect(creds.tokenPath).toBe("accessToken");
    expect(creds.expiryPath).toBe("expiresOn");
    expect(creds.refreshBufferSeconds).toBe(300);
  });

  test("oauth-pkce: unknown future key templatized; tenantId templatized; clientId preserved", () => {
    const server = httpServer({
      credentials: {
        kind: "oauth-pkce",
        authorizationEndpoint: "https://login.example.com/authorize",
        tokenEndpoint: "https://login.example.com/token",
        clientId: "public-client-id",
        scopes: ["read"],
        tenantId: "00000000-aaaa-bbbb-cccc-000000000000",
        refreshTokenRef: "vault-keychain-ref",
        futureSecret: "oh-no",
      } as McpServerConfig["credentials"],
    });
    const pack = exportServersAsPack([server], META);
    const creds = pack.presets[0].credentials as Record<string, unknown>;
    expect(creds.clientId).toBe("public-client-id");
    expect(creds.tenantId).toBe(SECRET_PLACEHOLDER);
    expect(creds.refreshTokenRef).toBe(SECRET_PLACEHOLDER);
    expect(creds.futureSecret).toBe(SECRET_PLACEHOLDER);
    const serialized = JSON.stringify(pack);
    expect(serialized).not.toContain("00000000-aaaa-bbbb-cccc");
    expect(serialized).not.toContain("vault-keychain-ref");
    expect(serialized).not.toContain("oh-no");
  });

  test("legacy HTTP authorization migrates to { kind: static-bearer, token: PLACEHOLDER }", () => {
    const server = httpServer({
      authorization: "Bearer legacy-token",
    } as Partial<McpServerConfig>);
    const pack = exportServersAsPack([server], META);
    const creds = pack.presets[0].credentials;
    expect(creds.kind).toBe("static-bearer");
    if (creds.kind !== "static-bearer") throw new Error("unreachable");
    expect(creds.token).toBe(SECRET_PLACEHOLDER);
    expect(JSON.stringify(pack)).not.toContain("legacy-token");
  });

  test("duplicate server names dedupe preset ids (-2, -3 within pack)", () => {
    const a = httpServer({ id: brand("a"), name: "Mail" });
    const b = httpServer({ id: brand("b"), name: "Mail" });
    const c = httpServer({ id: brand("c"), name: "Mail" });
    const pack = exportServersAsPack([a, b, c], META);
    expect(pack.presets.map((p) => p.id)).toEqual(["mail", "mail-2", "mail-3"]);
  });

  test("round-trip: pack validates for N in {1, 5, 20} (SC-002)", () => {
    for (const N of [1, 5, 20]) {
      const servers = Array.from({ length: N }, (_, i) =>
        httpServer({ id: brand(`s${i}`), name: `Server ${i}` }),
      );
      const pack = exportServersAsPack(servers, META);
      const validation = validatePack(pack);
      expect(validation.ok, `N=${N}`).toBe(true);
    }
  });

  test("FR-020 explicit: every secret field appears as placeholder and no original value remains", () => {
    const server = httpServer({
      credentials: { kind: "static-bearer", token: "leak-me-XYZ-123" },
    });
    const pack = exportServersAsPack([server], META);
    const json = JSON.stringify(pack);
    expect(json).not.toContain("leak-me-XYZ-123");
    expect(pack.presets[0].credentials.kind).toBe("static-bearer");
    if (pack.presets[0].credentials.kind === "static-bearer") {
      expect(pack.presets[0].credentials.token).toBe(SECRET_PLACEHOLDER);
    }
  });
});
