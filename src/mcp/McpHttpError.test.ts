import { describe, expect, test } from "vitest";
import { McpHttpError, isMcpHttpError } from "./McpHttpError";

describe("McpHttpError", () => {
  test("carries status and preserves a (redacted) wwwAuthenticate", () => {
    const err = new McpHttpError(401, 'Bearer realm="graph"');
    expect(err.status).toBe(401);
    expect(err.wwwAuthenticate).toContain("Bearer");
    expect(err.message).toMatch(/401/);
  });

  test("redacts embedded Bearer <token> in wwwAuthenticate and message", () => {
    const challenge = 'Bearer realm="graph", error="invalid_token" Bearer abcdef123456';
    const err = new McpHttpError(401, challenge);
    expect(err.wwwAuthenticate).not.toContain("abcdef123456");
    expect(err.message).not.toContain("abcdef123456");
  });

  test("status>=400 errors include status in default message", () => {
    const err = new McpHttpError(403, null);
    expect(err.message).toContain("403");
  });

  test("isMcpHttpError type guard", () => {
    expect(isMcpHttpError(new McpHttpError(500, null))).toBe(true);
    expect(isMcpHttpError(new Error("nope"))).toBe(false);
    expect(isMcpHttpError(null)).toBe(false);
  });
});
