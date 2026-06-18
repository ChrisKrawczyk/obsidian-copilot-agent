import { describe, expect, test } from "vitest";
import {
  assertNoTlsBypassOptions,
  classifyHost,
  validateMcpHttpUrl,
  validateRedirectHop,
} from "./httpPolicy";

describe("httpPolicy", () => {
  test.each([
    ["localhost", "loopback"],
    ["127.0.0.1", "loopback"],
    ["::1", "loopback"],
    ["10.1.2.3", "private"],
    ["172.16.0.1", "private"],
    ["192.168.0.1", "private"],
    ["fc00::1", "private"],
    ["example.com", "public"],
  ] as const)("classifies %s as %s", (host, expected) => {
    expect(classifyHost(host)).toBe(expected);
  });

  test("rejects non-loopback plaintext HTTP", () => {
    expect(() => validateMcpHttpUrl("http://example.com/mcp")).toThrow(/HTTPS/);
    expect(validateMcpHttpUrl("http://localhost:3000/mcp").hostClass).toBe("loopback");
  });

  test("rejects metadata IPs and metadata hostnames", () => {
    expect(() => validateMcpHttpUrl("https://169.254.169.254/latest")).toThrow(
      /metadata/,
    );
    expect(() => validateMcpHttpUrl("https://metadata.google.internal")).toThrow(
      /metadata/,
    );
  });

  test("classifies private ranges as requiring confirmation", () => {
    const result = validateMcpHttpUrl("https://192.168.1.5/mcp");
    expect(result.hostClass).toBe("private");
    expect(result.confirmationRequired).toBe(true);
  });

  test("allows normal public HTTPS", () => {
    const result = validateMcpHttpUrl("https://example.com/mcp");
    expect(result.hostClass).toBe("public");
    expect(result.confirmationRequired).toBe(false);
  });

  test("negative static assertions reject TLS bypass option names", () => {
    expect(() => assertNoTlsBypassOptions({ rejectUnauthorized: false })).toThrow();
    expect(() => assertNoTlsBypassOptions({ insecure: true })).toThrow();
    expect(() => assertNoTlsBypassOptions({ skipTls: true })).toThrow();
    expect(() => assertNoTlsBypassOptions({ redirect: "manual" })).not.toThrow();
  });

  test("runtime redirects reject metadata and unconfirmed private destinations", () => {
    expect(() =>
      validateRedirectHop(new URL("https://example.com"), "https://169.254.169.254", 1),
    ).toThrow(/metadata/);
    expect(() =>
      validateRedirectHop(new URL("https://example.com"), "https://10.0.0.2", 1),
    ).toThrow(/private/);
  });

  test("documents DNS rebinding is deferred by validating only URL host classes", () => {
    expect(classifyHost("example.internal")).toBe("public");
  });
});
