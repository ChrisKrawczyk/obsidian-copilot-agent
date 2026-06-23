import { describe, expect, test } from "vitest";
import { sanitizeError } from "./McpServerRuntime";
import { McpHttpError } from "./McpHttpError";
import { CredentialResolutionFailed } from "./credentials/CredentialResolver";

describe("sanitizeError preserves typed errors (Phase 4)", () => {
  test("preserves McpHttpError instance with status + wwwAuthenticate fields", () => {
    const err = new McpHttpError(401, "Bearer");
    const sanitized = sanitizeError(err);
    expect(sanitized).toBeInstanceOf(McpHttpError);
    expect((sanitized as McpHttpError).status).toBe(401);
    expect((sanitized as McpHttpError).wwwAuthenticate).toBe("Bearer");
  });

  test("preserves CredentialResolutionFailed instance with error.kind", () => {
    const err = new CredentialResolutionFailed({
      kind: "timeout",
      detail: "Command timed out",
    });
    const sanitized = sanitizeError(err);
    expect(sanitized).toBeInstanceOf(CredentialResolutionFailed);
    expect((sanitized as CredentialResolutionFailed).error.kind).toBe("timeout");
  });

  test("plain Error gets cloned with redacted message", () => {
    const err = new Error("token=Bearer abcdef123");
    const sanitized = sanitizeError(err);
    expect(sanitized).not.toBe(err);
    expect(sanitized.message).not.toContain("abcdef123");
  });

  test("redacts message on typed-error mutation in place", () => {
    const err = new McpHttpError(401, null);
    err.message = "auth=Bearer abcdef123";
    const sanitized = sanitizeError(err);
    expect(sanitized).toBe(err);
    expect(sanitized.message).not.toContain("abcdef123");
  });
});
