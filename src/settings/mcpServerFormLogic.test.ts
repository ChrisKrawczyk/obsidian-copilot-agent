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

  test("redacts Authorization in display unless reveal is requested", () => {
    expect(buildHeaderDisplay({ authorization: "Bearer secret" })[0]).toMatchObject({ name: "Authorization", value: "••••••••", redacted: true });
    expect(buildHeaderDisplay({ authorization: "Bearer secret" }, true)[0]).toMatchObject({ value: "Bearer secret", redacted: false });
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
