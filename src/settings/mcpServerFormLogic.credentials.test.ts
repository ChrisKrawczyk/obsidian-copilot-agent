import { describe, expect, test } from "vitest";
import { buildCredentialStatusText, validateMcpServerForm } from "./mcpServerFormLogic";

const ctx = { vaultRoot: "C:\\vault", pathExists: (path: string) => path === "C:\\vault" };

describe("Phase 5 credentialKind validation", () => {
  test("HTTP + credentialKind 'none' + no authorization → no credentials block", () => {
    const result = validateMcpServerForm(
      { id: "srv", transport: "http", url: "https://example.com/mcp", credentialKind: "none" },
      ctx,
    );
    expect(result.ok).toBe(true);
    if (result.config?.transport === "http") {
      expect(result.config.credentials).toBeUndefined();
    }
  });

  test("HTTP + credentialKind 'static-bearer' without token → error", () => {
    const result = validateMcpServerForm(
      {
        id: "srv",
        transport: "http",
        url: "https://example.com/mcp",
        credentialKind: "static-bearer",
      },
      ctx,
    );
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toMatch(/static bearer/i);
  });

  test("HTTP + credentialKind 'static-bearer' with token → emits static-bearer credentials", () => {
    const result = validateMcpServerForm(
      {
        id: "srv",
        transport: "http",
        url: "https://example.com/mcp",
        credentialKind: "static-bearer",
        authorization: "Bearer abc123",
      },
      ctx,
    );
    expect(result.ok).toBe(true);
    expect(result.config?.transport === "http" && result.config.credentials).toEqual({
      kind: "static-bearer",
      token: "Bearer abc123",
    });
  });

  test("HTTP + credentialKind 'command-based' without command → error", () => {
    const result = validateMcpServerForm(
      {
        id: "srv",
        transport: "http",
        url: "https://example.com/mcp",
        credentialKind: "command-based",
        credentialCommand: "",
      },
      ctx,
    );
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toMatch(/command-based/i);
  });

  test("HTTP + credentialKind 'command-based' emits canonical block with defaults respected", () => {
    const result = validateMcpServerForm(
      {
        id: "srv",
        transport: "http",
        url: "https://example.com/mcp",
        credentialKind: "command-based",
        credentialCommand: "az account get-access-token --scope x --output json",
        credentialTokenPath: "accessToken",
        credentialExpiryPath: "expiresOn",
        credentialRefreshBufferSeconds: 300,
      },
      ctx,
    );
    expect(result.ok).toBe(true);
    if (result.config?.transport === "http") {
      expect(result.config.credentials).toEqual({
        kind: "command-based",
        command: "az account get-access-token --scope x --output json",
        tokenPath: "accessToken",
        expiryPath: "expiresOn",
        refreshBufferSeconds: 300,
      });
    }
  });

  test("refresh buffer out of range → error", () => {
    const result = validateMcpServerForm(
      {
        id: "srv",
        transport: "http",
        url: "https://example.com/mcp",
        credentialKind: "command-based",
        credentialCommand: "az foo",
        credentialRefreshBufferSeconds: 999_999,
      },
      ctx,
    );
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toMatch(/Refresh buffer/);
  });

  test("refresh buffer negative → error", () => {
    const result = validateMcpServerForm(
      {
        id: "srv",
        transport: "http",
        url: "https://example.com/mcp",
        credentialKind: "command-based",
        credentialCommand: "az foo",
        credentialRefreshBufferSeconds: -1,
      },
      ctx,
    );
    expect(result.ok).toBe(false);
  });

  test("legacy: no credentialKind + authorization → static-bearer (backward compat)", () => {
    const result = validateMcpServerForm(
      {
        id: "srv",
        transport: "http",
        url: "https://example.com/mcp",
        authorization: "Bearer x",
      },
      ctx,
    );
    expect(result.ok).toBe(true);
    if (result.config?.transport === "http") {
      expect(result.config.credentials).toEqual({ kind: "static-bearer", token: "Bearer x" });
    }
  });
});

describe("buildCredentialStatusText", () => {
  test("no state → 'not yet resolved'", () => {
    expect(buildCredentialStatusText({})).toMatch(/not yet resolved/);
  });
  test("ok with future expiry → includes minutes", () => {
    const now = 1_000_000_000_000;
    const out = buildCredentialStatusText({
      state: "ok",
      expiresAt: now + 30 * 60_000,
      now,
    });
    expect(out).toMatch(/ok \(expires in 30 min\)/);
  });
  test("failed includes remediation", () => {
    const out = buildCredentialStatusText({ state: "failed", remediation: "Run az login" });
    expect(out).toMatch(/failed — Run az login/);
  });
  test("not-applicable", () => {
    expect(buildCredentialStatusText({ state: "not-applicable" })).toMatch(/not applicable/);
  });
});
