import { describe, expect, it } from "vitest";
import {
  computeTrustEpoch,
  formatMcpApprovalKey,
  normalizeServerId,
} from "./McpIdentity";
import type { McpServerConfig } from "./McpTypes";

const stdio = (overrides: Partial<McpServerConfig> = {}): McpServerConfig =>
  ({
    id: normalizeServerId("server_one"),
    name: "Server One",
    enabled: true,
    transport: "stdio",
    command: "node",
    args: ["server.js"],
    trustEpoch: "epoch_test",
    ...overrides,
  }) as McpServerConfig;

describe("McpIdentity", () => {
  it("normalizes stable ids without depending on display name edits", () => {
    const id = normalizeServerId("Server_One");
    expect(id).toBe("server_one");
    expect({ ...stdio({ id }), name: "Renamed" }.id).toBe(id);
  });

  it("rejects reserved prefix, control/NUL/path separators, invalid chars, and long ids", () => {
    for (const raw of [
      "mcp__server",
      "bad\nid",
      "bad\u0000id",
      "bad/id",
      "bad\\id",
      "bad.id",
      "a".repeat(65),
    ]) {
      expect(() => normalizeServerId(raw)).toThrow();
    }
  });

  it("rotates trust epoch on name, command, args, url, or transport changes", () => {
    const base = computeTrustEpoch(stdio());
    expect(computeTrustEpoch(stdio({ name: "Renamed" }))).not.toBe(base);
    expect(computeTrustEpoch(stdio({ command: "python" }))).not.toBe(base);
    expect(computeTrustEpoch(stdio({ args: ["other.py"] }))).not.toBe(base);
    expect(
      computeTrustEpoch({
        id: normalizeServerId("server_one"),
        name: "Server One",
        enabled: true,
        transport: "http",
        url: "https://example.com/mcp",
        trustEpoch: "epoch_test",
      }),
    ).not.toBe(base);
    expect(
      computeTrustEpoch({
        id: normalizeServerId("server_one"),
        name: "Server One",
        enabled: true,
        transport: "http",
        url: "https://other.example/mcp",
        trustEpoch: "epoch_test",
      }),
    ).not.toBe(
      computeTrustEpoch({
        id: normalizeServerId("server_one"),
        name: "Server One",
        enabled: true,
        transport: "http",
        url: "https://example.com/mcp",
        trustEpoch: "epoch_test",
      }),
    );
  });

  it("does not rotate trust epoch on enable/status edits", () => {
    const base = computeTrustEpoch(stdio());
    expect(computeTrustEpoch(stdio({ enabled: false }))).toBe(base);
    expect(computeTrustEpoch(stdio({ status: "error", lastError: "boom" }))).toBe(
      base,
    );
  });

  it("formats canonical MCP approval keys", () => {
    expect(
      formatMcpApprovalKey(
        normalizeServerId("server_one"),
        "tool__name",
        computeTrustEpoch(stdio()),
      ),
    ).toMatch(/^mcp:server_one:epoch_[0-9a-f]+:tool__name$/);
  });
});
