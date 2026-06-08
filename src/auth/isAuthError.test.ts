import { describe, expect, test } from "vitest";
import { isAuthError } from "./isAuthError";

describe("isAuthError", () => {
  test("returns false for nullish", () => {
    expect(isAuthError(null)).toBe(false);
    expect(isAuthError(undefined)).toBe(false);
  });

  test("detects 401/403 on top-level status", () => {
    expect(isAuthError({ status: 401 })).toBe(true);
    expect(isAuthError({ status: 403 })).toBe(true);
    expect(isAuthError({ statusCode: 401 })).toBe(true);
  });

  test("does NOT flag 500 or 400 as auth", () => {
    expect(isAuthError({ status: 500 })).toBe(false);
    expect(isAuthError({ status: 400 })).toBe(false);
  });

  test("detects nested status under cause/data/response", () => {
    expect(isAuthError({ cause: { status: 401 } })).toBe(true);
    expect(isAuthError({ data: { statusCode: 403 } })).toBe(true);
    expect(isAuthError({ response: { status: 401 } })).toBe(true);
  });

  test("detects code strings like 'unauthorized'/'invalid_token'", () => {
    expect(isAuthError({ code: "unauthorized" })).toBe(true);
    expect(isAuthError({ code: "invalid_token" })).toBe(true);
    expect(isAuthError({ code: "bad_credentials" })).toBe(true);
  });

  test("falls back to message regex", () => {
    expect(isAuthError(new Error("Bad credentials"))).toBe(true);
    expect(isAuthError(new Error("Request failed: 401 Unauthorized"))).toBe(
      true,
    );
    expect(isAuthError(new Error("token expired"))).toBe(true);
    expect(isAuthError(new Error("network unreachable"))).toBe(false);
  });

  test("safe with cyclic references", () => {
    const a: Record<string, unknown> = { status: 500 };
    a.self = a;
    expect(isAuthError(a)).toBe(false);
  });

  test("plain string with auth keyword matches", () => {
    expect(isAuthError("Unauthorized")).toBe(true);
    expect(isAuthError("OK")).toBe(false);
  });
});
