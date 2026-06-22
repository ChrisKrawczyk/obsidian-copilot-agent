import { describe, expect, it } from "vitest";
import {
  DEFAULT_EXPIRY_PATH,
  DEFAULT_REFRESH_BUFFER_SECONDS,
  DEFAULT_TOKEN_PATH,
  isCommandBased,
  isNone,
  isOAuthPkce,
  isStaticBearer,
  type ServerCredentials,
} from "./CredentialTypes";

describe("CredentialTypes", () => {
  it("exposes Azure-CLI-aligned defaults", () => {
    expect(DEFAULT_TOKEN_PATH).toBe("accessToken");
    expect(DEFAULT_EXPIRY_PATH).toBe("expiresOn");
    expect(DEFAULT_REFRESH_BUFFER_SECONDS).toBe(300);
  });

  it("narrows ServerCredentials via type guards", () => {
    const none: ServerCredentials = { kind: "none" };
    const bearer: ServerCredentials = {
      kind: "static-bearer",
      token: "Bearer abc",
    };
    const cmd: ServerCredentials = {
      kind: "command-based",
      command: "az account get-access-token",
    };
    const pkce: ServerCredentials = {
      kind: "oauth-pkce",
      authorizationEndpoint: "https://example/authorize",
      tokenEndpoint: "https://example/token",
      clientId: "client",
      scopes: ["openid"],
    };

    expect(isNone(none)).toBe(true);
    expect(isStaticBearer(none)).toBe(false);

    expect(isStaticBearer(bearer)).toBe(true);
    expect(isCommandBased(bearer)).toBe(false);

    expect(isCommandBased(cmd)).toBe(true);
    expect(isOAuthPkce(cmd)).toBe(false);

    expect(isOAuthPkce(pkce)).toBe(true);
    expect(isNone(pkce)).toBe(false);
  });

  it("permits unknown future keys on oauth-pkce shapes (SC-008 index signature)", () => {
    const pkce: ServerCredentials = {
      kind: "oauth-pkce",
      authorizationEndpoint: "https://example/authorize",
      tokenEndpoint: "https://example/token",
      clientId: "client",
      scopes: ["openid"],
      // Unknown future fields must compile cleanly via the index signature.
      futureExtension: { ok: true },
    };
    expect(isOAuthPkce(pkce)).toBe(true);
    expect((pkce as Record<string, unknown>).futureExtension).toEqual({
      ok: true,
    });
  });
});
