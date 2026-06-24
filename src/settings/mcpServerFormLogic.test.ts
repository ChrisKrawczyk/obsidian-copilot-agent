import { describe, expect, test } from "vitest";
import { normalizeServerId } from "../mcp/McpIdentity";
import {
  MCP_CALL_TIMEOUT_MAX_SECONDS,
  PRIVATE_NETWORK_CONFIRMATION_COPY,
  assertNoTlsBypassFields,
  buildHeaderDisplay,
  validateMcpServerForm,
} from "./mcpServerFormLogic";

describe("mcpServerFormLogic", () => {
  const ctx = { vaultRoot: "C:\\vault", pathExists: (path: string) => path === "C:\\vault" || path === "C:\\ok" };

  test("enforces stdio required command", () => {
    const result = validateMcpServerForm({ id: "srv", transport: "stdio", command: "" }, ctx);
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toMatch(/Command is required/);
  });

  test("enforces HTTP required URL", () => {
    const result = validateMcpServerForm({ id: "srv", transport: "http", url: "" }, ctx);
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toMatch(/URL is required/);
  });

  test("rejects normalized id uniqueness collisions", () => {
    const result = validateMcpServerForm(
      { id: "Alpha", transport: "stdio", command: "node" },
      { ...ctx, existingIds: [normalizeServerId("alpha")] },
    );
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toMatch(/already exists/);
  });

  test("allows editing the original id", () => {
    const id = normalizeServerId("alpha");
    const result = validateMcpServerForm(
      { id: "alpha", transport: "stdio", command: "node" },
      { ...ctx, existingIds: [id], originalId: id },
    );
    expect(result.ok).toBe(true);
  });

  test("defaults stdio cwd to vault root and exposes display-only fixed timeouts", () => {
    const result = validateMcpServerForm({ id: "defaults", transport: "stdio", command: "node" }, ctx);
    expect(result.ok).toBe(true);
    expect(result.config).not.toHaveProperty("cwd");
    expect(result.initializeTimeoutSeconds).toBe(10);
    expect(result.toolsListPageTimeoutSeconds).toBe(10);
  });

  test("parses quoted argument strings into argv entries", () => {
    const result = validateMcpServerForm({ id: "args", transport: "stdio", command: "node", args: "\"server file.js\" --flag" }, ctx);
    expect(result.ok).toBe(true);
    expect(result.config).toMatchObject({ args: ["server file.js", "--flag"] });
  });

  test("enforces timeout lower and upper bounds", () => {
    expect(validateMcpServerForm({ id: "a", transport: "stdio", command: "node", callTimeoutSeconds: 0 }, ctx).errors.join(" ")).toMatch(/greater than 0/);
    expect(validateMcpServerForm({ id: "b", transport: "stdio", command: "node", callTimeoutSeconds: -1 }, ctx).errors.join(" ")).toMatch(/greater than 0/);
    expect(validateMcpServerForm({ id: "c", transport: "stdio", command: "node", callTimeoutSeconds: MCP_CALL_TIMEOUT_MAX_SECONDS + 1 }, ctx).errors.join(" ")).toMatch(/300 seconds or less/);
  });

  test("stores tool call timeout as canonical milliseconds while reporting seconds to UI", () => {
    const result = validateMcpServerForm({ id: "timeout", transport: "stdio", command: "node", callTimeoutSeconds: 5 }, ctx);
    expect(result.ok).toBe(true);
    expect(result.callTimeoutSeconds).toBe(5);
    expect(result.config).toMatchObject({ callTimeoutMs: 5_000 });
    expect(result.config).not.toHaveProperty("callTimeoutSeconds");
  });

  test("redacts Authorization in display unless reveal is requested", () => {
    expect(buildHeaderDisplay({ authorization: "Bearer secret" })[0]).toMatchObject({ name: "Authorization", value: "••••••••", redacted: true });
    expect(buildHeaderDisplay({ authorization: "Bearer secret" }, true)[0]).toMatchObject({ value: "Bearer secret", redacted: false });
  });

  test("emits canonical static-bearer credentials for HTTP forms with an Authorization value (Phase 1 plan)", () => {
    const result = validateMcpServerForm(
      {
        id: "http_auth",
        transport: "http",
        url: "https://example.com/mcp",
        authorization: "Bearer secret",
      },
      ctx,
    );
    expect(result.ok).toBe(true);
    expect(result.config).toMatchObject({
      transport: "http",
      url: "https://example.com/mcp",
      credentials: { kind: "static-bearer", token: "Bearer secret" },
    });
    // Canonical-only: the legacy `authorization` field is no longer emitted
    // by the form. Persisted entries that still carry it are migrated by
    // the settings store on load and dropped on first save.
    expect(result.config).not.toHaveProperty("authorization");
  });

  test("omits the credentials field entirely for unauthenticated HTTP forms (preserves variant=none behavior)", () => {
    const result = validateMcpServerForm(
      { id: "http_noauth", transport: "http", url: "https://example.com/mcp" },
      ctx,
    );
    expect(result.ok).toBe(true);
    expect(result.config).toMatchObject({
      transport: "http",
      url: "https://example.com/mcp",
    });
    expect(result.config).not.toHaveProperty("credentials");
    expect(result.config).not.toHaveProperty("authorization");
  });

  test("reads Authorization from the headers map and emits canonical static-bearer credentials", () => {
    const result = validateMcpServerForm(
      {
        id: "http_hdr",
        transport: "http",
        url: "https://example.com/mcp",
        headers: { Authorization: "Bearer from-headers" },
      },
      ctx,
    );
    expect(result.ok).toBe(true);
    expect(result.config).toMatchObject({
      credentials: { kind: "static-bearer", token: "Bearer from-headers" },
    });
  });

  test("classifies loopback and https public URLs without warning", () => {
    const loopback = validateMcpServerForm({ id: "local", transport: "http", url: "http://127.0.0.1:3000/mcp" }, ctx);
    const https = validateMcpServerForm({ id: "pub", transport: "http", url: "https://example.com/mcp" }, ctx);
    expect(loopback.ok).toBe(true);
    expect(loopback.hostClass).toBe("loopback");
    expect(https.ok).toBe(true);
    expect(https.hostClass).toBe("public");
  });

  test("requires private-network confirmation copy", () => {
    const result = validateMcpServerForm({ id: "priv", transport: "http", url: "https://192.168.1.20/mcp" }, ctx);
    expect(result.ok).toBe(true);
    expect(result.confirmationRequired).toBe(true);
    expect(result.warnings).toContain(PRIVATE_NETWORK_CONFIRMATION_COPY);
  });

  test("rejects metadata and non-loopback plain HTTP", () => {
    expect(validateMcpServerForm({ id: "meta", transport: "http", url: "https://169.254.169.254/mcp" }, ctx).errors.join(" ")).toMatch(/metadata/);
    expect(validateMcpServerForm({ id: "plain", transport: "http", url: "http://example.com/mcp" }, ctx).errors.join(" ")).toMatch(/HTTPS/);
  });

  test("warns for explicit denylisted env keys but not normal env keys", () => {
    const warned = validateMcpServerForm({ id: "env", transport: "stdio", command: "node", env: { GITHUB_TOKEN: "x", OPENAI_API_KEY: "y", MY_API_KEY: "z" } }, ctx);
    expect(warned.denylistEnvWarnings.map((w) => w.key).sort()).toEqual(["GITHUB_TOKEN", "MY_API_KEY", "OPENAI_API_KEY"]);
    const clean = validateMcpServerForm({ id: "env2", transport: "stdio", command: "node", env: { PYTHONPATH: "lib" } }, ctx);
    expect(clean.denylistEnvWarnings).toHaveLength(0);
  });

  test("TLS-bypass fields are not accepted", () => {
    expect(() => assertNoTlsBypassFields({ rejectUnauthorized: false })).toThrow(/TLS bypass/);
    const result = validateMcpServerForm({ id: "tls", transport: "http", url: "https://example.com", rejectUnauthorized: false } as never, ctx);
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result.config ?? {})).not.toContain("rejectUnauthorized");
  });

  test("invalid per-server cwd produces a clear error", () => {
    const result = validateMcpServerForm({ id: "cwd", transport: "stdio", command: "node", cwd: "C:\\missing" }, ctx);
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toContain("Working directory does not exist: C:\\missing");
  });
});

describe("mcpServerFormLogic requiredSecretFields (Phase 4)", () => {
  const ctx = { vaultRoot: "C:\\vault", pathExists: (path: string) => path === "C:\\vault" };

  test("fails validation when authorization is empty and required by pack", () => {
    const result = validateMcpServerForm(
      {
        id: "srv",
        transport: "http",
        url: "https://api.example/",
        authorization: "",
        requiredSecretFields: ["authorization"],
      },
      ctx,
    );
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toMatch(/Required field authorization from imported pack/);
    expect(result.requiredSecretFields).toEqual(["authorization"]);
  });

  test("passes when required field is filled", () => {
    const result = validateMcpServerForm(
      {
        id: "srv",
        transport: "http",
        url: "https://api.example/",
        authorization: "Bearer real-token",
        requiredSecretFields: ["authorization"],
      },
      ctx,
    );
    expect(result.ok).toBe(true);
  });

  test("fails when env.<KEY> is required but missing", () => {
    const result = validateMcpServerForm(
      {
        id: "srv",
        transport: "stdio",
        command: "node",
        env: { API_KEY: "" },
        requiredSecretFields: ["env.API_KEY"],
      },
      ctx,
    );
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toMatch(/Required field env\.API_KEY/);
  });

  test("passes when env.<KEY> required field is filled", () => {
    const result = validateMcpServerForm(
      {
        id: "srv",
        transport: "stdio",
        command: "node",
        env: { API_KEY: "value-123" },
        requiredSecretFields: ["env.API_KEY"],
      },
      ctx,
    );
    expect(result.ok).toBe(true);
  });

  test("requiredSecretFields defaults to [] when omitted", () => {
    const result = validateMcpServerForm(
      { id: "srv", transport: "stdio", command: "node" },
      ctx,
    );
    expect(result.requiredSecretFields).toEqual([]);
  });
});

describe("mcpServerFormLogic credentialArgs round-trip (Phase 4)", () => {
  const ctx = { vaultRoot: "C:\\vault", pathExists: (p: string) => p === "C:\\vault" };

  test("command-based credentials preserve args from form input through to config", () => {
    const result = validateMcpServerForm(
      {
        id: "srv",
        transport: "http",
        url: "https://api.example/",
        credentialKind: "command-based",
        credentialCommand: "az",
        credentialArgs: ["account", "get-access-token", "--scope", "x"],
      },
      ctx,
    );
    expect(result.ok).toBe(true);
    expect(result.config?.credentials).toMatchObject({
      kind: "command-based",
      command: "az",
      args: ["account", "get-access-token", "--scope", "x"],
    });
  });

  test("omits args key when credentialArgs is empty or undefined", () => {
    const result = validateMcpServerForm(
      {
        id: "srv",
        transport: "http",
        url: "https://api.example/",
        credentialKind: "command-based",
        credentialCommand: "az",
      },
      ctx,
    );
    expect(result.ok).toBe(true);
    const creds = result.config?.credentials as { args?: unknown };
    expect(creds.args).toBeUndefined();
  });
});
