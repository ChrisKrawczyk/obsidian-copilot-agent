import { describe, expect, test } from "vitest";
import {
  SECRET_PLACEHOLDER,
  isKnownCredentialKind,
  knownStructuralFieldsForCredentials,
  secretFieldsForCredentials,
} from "./packSecretPolicy";

describe("packSecretPolicy", () => {
  test("matrix per kind", () => {
    expect(secretFieldsForCredentials("none")).toEqual([]);
    expect(secretFieldsForCredentials("static-bearer")).toEqual(["token"]);
    expect(secretFieldsForCredentials("command-based")).toEqual([]);
    expect(secretFieldsForCredentials("oauth-pkce")).toEqual([
      "refreshTokenRef",
      "tenantId",
    ]);
  });

  test("tenantId listed as secret-bearing for oauth-pkce (privacy NFR)", () => {
    expect(secretFieldsForCredentials("oauth-pkce")).toContain("tenantId");
  });

  test("returned arrays are frozen", () => {
    expect(Object.isFrozen(secretFieldsForCredentials("oauth-pkce"))).toBe(true);
    expect(Object.isFrozen(secretFieldsForCredentials("static-bearer"))).toBe(true);
  });

  test("isKnownCredentialKind discriminates", () => {
    expect(isKnownCredentialKind("none")).toBe(true);
    expect(isKnownCredentialKind("static-bearer")).toBe(true);
    expect(isKnownCredentialKind("command-based")).toBe(true);
    expect(isKnownCredentialKind("oauth-pkce")).toBe(true);
    expect(isKnownCredentialKind("bogus")).toBe(false);
    expect(isKnownCredentialKind(undefined)).toBe(false);
  });

  test("structural sets exclude secret-bearing fields", () => {
    const ob = knownStructuralFieldsForCredentials("oauth-pkce");
    expect(ob.has("clientId")).toBe(true);
    expect(ob.has("tenantId")).toBe(false);
    expect(ob.has("refreshTokenRef")).toBe(false);
  });

  test("SECRET_PLACEHOLDER is the locked literal", () => {
    expect(SECRET_PLACEHOLDER).toBe("__NEEDS_VALUE__");
  });

  test("unknown credential kind → exporter callers must treat ALL fields as secret", () => {
    // Contract: secretFieldsForCredentials returns the empty sentinel for an
    // unknown kind. Callers are required to check isKnownCredentialKind FIRST
    // and (when false) treat every credential field as secret. This test
    // pins both halves of that contract.
    expect(isKnownCredentialKind("future-variant")).toBe(false);
    expect(secretFieldsForCredentials("future-variant")).toEqual([]);
  });
});
