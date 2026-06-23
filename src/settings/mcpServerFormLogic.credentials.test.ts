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
  test("PA-1: failed with copyable appends `Run: <copyable>`", () => {
    const out = buildCredentialStatusText({
      state: "failed",
      remediation: "Azure CLI credentials are not signed in or have expired.",
      copyable: "az login --tenant 72f988bf-86f1-41af-91ab-2d7cd011db47",
    });
    expect(out).toMatch(/Azure CLI/);
    expect(out).toMatch(/Run: az login --tenant 72f988bf-86f1-41af-91ab-2d7cd011db47/);
  });
  test("SM-3: ok with nextRefreshAt renders relative refresh hint", () => {
    const now = 1_000_000_000_000;
    const out = buildCredentialStatusText({
      state: "ok",
      expiresAt: now + 60 * 60_000,
      nextRefreshAt: now + 15 * 60_000,
      now,
    });
    expect(out).toMatch(/ok \(expires in 60 min\)/);
    expect(out).toMatch(/Next refresh in 15 min/);
  });
  test("SM-3: lastTestResult ok renders inline", () => {
    const now = 1_000_000_000_000;
    const out = buildCredentialStatusText({
      state: "ok",
      lastTestResult: { ok: true, at: now - 30_000 },
      now,
    });
    expect(out).toMatch(/Last test: OK \(30s ago\)/);
  });
  test("SM-3: lastTestResult failure renders inline with detail", () => {
    const now = 1_000_000_000_000;
    const out = buildCredentialStatusText({
      state: "ok",
      lastTestResult: { ok: false, at: now - 120_000, error: "Server returned HTTP 401." },
      now,
    });
    expect(out).toMatch(/Last test: failed \(2m ago\) — Server returned HTTP 401/);
  });
});
