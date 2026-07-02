import {
  type CommandBasedCredentials,
  type NoneCredentials,
  type OAuthPkceCredentials,
  type ServerCredentials,
  type StaticBearerCredentials,
} from "../mcp/credentials/CredentialTypes";

export interface ParseCredentialsError {
  pointer: string;
  message: string;
}

export type ParseCredentialsResult =
  | { ok: true; value: ServerCredentials | undefined }
  | { ok: false; error: ParseCredentialsError };

/**
 * Parse a `credentials` block from persisted or imported config.
 *
 * - Returns `{ ok: true, value: undefined }` when `value` is `undefined`
 *   (caller decides how to handle absence — e.g. synthesize from legacy
 *   `authorization`).
 * - Returns `{ ok: false }` with a JSON-pointer-relative error otherwise.
 * - For `oauth-pkce`, preserves the full input object verbatim
 *   (including unknown future keys) per SC-008 byte-equivalence.
 */
export function parseServerCredentials(
  value: unknown,
  pointerBase = "",
): ParseCredentialsResult {
  if (value === undefined) return { ok: true, value: undefined };
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return fail(pointerBase, "credentials must be an object");
  }
  const obj = value as Record<string, unknown>;
  const kind = obj.kind;
  if (kind === "none") {
    const result: NoneCredentials = { kind: "none" };
    return { ok: true, value: result };
  }
  if (kind === "static-bearer") {
    if (typeof obj.token !== "string" || obj.token.length === 0) {
      return fail(pointerBase + "/token", "token must be a non-empty string");
    }
    const result: StaticBearerCredentials = {
      kind: "static-bearer",
      token: obj.token,
    };
    return { ok: true, value: result };
  }
  if (kind === "command-based") {
    if (typeof obj.command !== "string" || obj.command.length === 0) {
      return fail(pointerBase + "/command", "command must be a non-empty string");
    }
    if (
      obj.args !== undefined &&
      (!Array.isArray(obj.args) ||
        obj.args.some((arg) => typeof arg !== "string"))
    ) {
      return fail(pointerBase + "/args", "args must be an array of strings");
    }
    if (obj.tokenPath !== undefined && typeof obj.tokenPath !== "string") {
      return fail(pointerBase + "/tokenPath", "tokenPath must be a string");
    }
    if (obj.expiryPath !== undefined && typeof obj.expiryPath !== "string") {
      return fail(pointerBase + "/expiryPath", "expiryPath must be a string");
    }
    if (
      obj.refreshBufferSeconds !== undefined &&
      (typeof obj.refreshBufferSeconds !== "number" ||
        !Number.isFinite(obj.refreshBufferSeconds) ||
        obj.refreshBufferSeconds < 0)
    ) {
      return fail(
        pointerBase + "/refreshBufferSeconds",
        "refreshBufferSeconds must be a non-negative finite number",
      );
    }
    const result: CommandBasedCredentials = {
      kind: "command-based",
      command: obj.command,
      ...(Array.isArray(obj.args) ? { args: [...(obj.args as string[])] } : {}),
      ...(typeof obj.tokenPath === "string" ? { tokenPath: obj.tokenPath } : {}),
      ...(typeof obj.expiryPath === "string" ? { expiryPath: obj.expiryPath } : {}),
      ...(typeof obj.refreshBufferSeconds === "number"
        ? { refreshBufferSeconds: obj.refreshBufferSeconds }
        : {}),
    };
    return { ok: true, value: result };
  }
  if (kind === "oauth-pkce") {
    if (typeof obj.authorizationEndpoint !== "string") {
      return fail(
        pointerBase + "/authorizationEndpoint",
        "authorizationEndpoint must be a string",
      );
    }
    if (typeof obj.tokenEndpoint !== "string") {
      return fail(pointerBase + "/tokenEndpoint", "tokenEndpoint must be a string");
    }
    if (typeof obj.clientId !== "string") {
      return fail(pointerBase + "/clientId", "clientId must be a string");
    }
    if (
      !Array.isArray(obj.scopes) ||
      obj.scopes.some((scope) => typeof scope !== "string")
    ) {
      return fail(pointerBase + "/scopes", "scopes must be an array of strings");
    }
    if (obj.tenantId !== undefined && typeof obj.tenantId !== "string") {
      return fail(pointerBase + "/tenantId", "tenantId must be a string");
    }
    if (obj.redirectUri !== undefined && typeof obj.redirectUri !== "string") {
      return fail(pointerBase + "/redirectUri", "redirectUri must be a string");
    }
    if (
      obj.refreshTokenRef !== undefined &&
      typeof obj.refreshTokenRef !== "string"
    ) {
      return fail(
        pointerBase + "/refreshTokenRef",
        "refreshTokenRef must be a string",
      );
    }
    if (obj.pkceMethod !== undefined && typeof obj.pkceMethod !== "string") {
      return fail(pointerBase + "/pkceMethod", "pkceMethod must be a string");
    }
    // Preserve full object (including unknown future keys) verbatim per SC-008.
    const result: OAuthPkceCredentials = {
      ...(obj as OAuthPkceCredentials),
      kind: "oauth-pkce",
    };
    return { ok: true, value: result };
  }
  return fail(pointerBase + "/kind", "credentials.kind is unsupported");
}

function fail(pointer: string, message: string): ParseCredentialsResult {
  return { ok: false, error: { pointer, message } };
}
