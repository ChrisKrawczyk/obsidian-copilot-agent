import { describe, expect, test } from "vitest";
import { credentialsChanged } from "./McpServersSection";
import { computeTrustEpoch, normalizeServerId } from "../mcp/McpIdentity";
import type { McpServerConfig } from "../mcp/McpTypes";

function http(overrides: Partial<McpServerConfig> = {}): McpServerConfig {
  const base = {
    id: normalizeServerId("http"),
    name: "HTTP",
    enabled: true,
    transport: "http" as const,
    url: "https://example.com/mcp",
    ...overrides,
  };
  return { ...base, trustEpoch: computeTrustEpoch(base) } as McpServerConfig;
}

describe("McpServersSection credentialsChanged + grant survival (FR-011)", () => {
  test("detects authorization → credentials migration", () => {
    const prev = http({ authorization: "Bearer abc" });
    const next = http({ credentials: { kind: "static-bearer", token: "abc" } });
    expect(credentialsChanged(prev, next)).toBe(true);
  });

  test("detects token rotation inside static-bearer", () => {
    const prev = http({ credentials: { kind: "static-bearer", token: "v1" } });
    const next = http({ credentials: { kind: "static-bearer", token: "v2" } });
    expect(credentialsChanged(prev, next)).toBe(true);
  });

  test("detects command edit inside command-based", () => {
    const prev = http({ credentials: { kind: "command-based", command: "az x" } });
    const next = http({ credentials: { kind: "command-based", command: "az y" } });
    expect(credentialsChanged(prev, next)).toBe(true);
  });

  test("returns false when no credential fields changed", () => {
    const prev = http({ credentials: { kind: "static-bearer", token: "v1" } });
    const next = http({ credentials: { kind: "static-bearer", token: "v1" } });
    expect(credentialsChanged(prev, next)).toBe(false);
  });

  test("returns false when transport changes (separate code path handles full rebuild)", () => {
    const prev = http();
    const next = {
      ...prev,
      transport: "stdio" as const,
      command: "node",
      args: [],
    } as McpServerConfig;
    expect(credentialsChanged(prev, next)).toBe(false);
  });

  test("trust epoch is invariant when only credentials change (FR-011)", () => {
    const prev = http({ credentials: { kind: "static-bearer", token: "v1" } });
    const next = http({ credentials: { kind: "command-based", command: "az token" } });
    expect(prev.trustEpoch).toBe(next.trustEpoch);
    expect(credentialsChanged(prev, next)).toBe(true);
  });
});
