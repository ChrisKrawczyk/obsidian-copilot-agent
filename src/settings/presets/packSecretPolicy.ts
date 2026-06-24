import type { ServerCredentialKind } from "../../mcp/credentials/CredentialTypes";

/**
 * Canonical placeholder value substituted for secret-bearing fields when a
 * pack is exported. **PUBLIC CONTRACT**: this exact string is recognized by
 * the import-side preflight as "the user must supply a value before saving".
 * Changing it is a breaking change to pack files in the wild.
 */
export const SECRET_PLACEHOLDER = "__NEEDS_VALUE__";

/** Per-kind secret-bearing field list (see Phase 1C secret matrix). */
export type SecretFieldList = readonly string[];

const EMPTY: SecretFieldList = Object.freeze([]);
const STATIC_BEARER: SecretFieldList = Object.freeze(["token"]);
const COMMAND_BASED: SecretFieldList = Object.freeze([]);
// oauth-pkce: tenantId is forbidden in shareable packs by the Spec privacy
// NFR; refreshTokenRef is obviously secret-bearing. Any unknown future key
// is treated as secret-bearing by the exporter (defensive default).
const OAUTH_PKCE: SecretFieldList = Object.freeze(["refreshTokenRef", "tenantId"]);

/** Structural fields that are EXPLICITLY safe to preserve for each kind. */
const KNOWN_STRUCTURAL: Record<ServerCredentialKind, ReadonlySet<string>> = {
  none: new Set(["kind"]),
  "static-bearer": new Set(["kind"]),
  "command-based": new Set([
    "kind",
    "command",
    "args",
    "tokenPath",
    "expiryPath",
    "refreshBufferSeconds",
  ]),
  "oauth-pkce": new Set([
    "kind",
    "clientId",
    "authorizationEndpoint",
    "tokenEndpoint",
    "scopes",
    "redirectUri",
    "pkceMethod",
  ]),
};

/**
 * Returns the list of credential fields whose VALUES are secret-bearing
 * for the given kind. The exporter substitutes `SECRET_PLACEHOLDER` for
 * every listed field and ALSO for any field on `oauth-pkce` that is
 * neither in the known-structural set nor in `OAUTH_PKCE` (defensive
 * default for unknown future keys).
 *
 * For unknown credential kinds, returns a sentinel: callers MUST treat
 * every field on the credential object as secret-bearing.
 */
export function secretFieldsForCredentials(
  kind: ServerCredentialKind | string,
): SecretFieldList {
  switch (kind) {
    case "none":
      return EMPTY;
    case "static-bearer":
      return STATIC_BEARER;
    case "command-based":
      return COMMAND_BASED;
    case "oauth-pkce":
      return OAUTH_PKCE;
    default:
      return EMPTY; // Sentinel — callers must check isKnownCredentialKind.
  }
}

export function isKnownCredentialKind(
  kind: unknown,
): kind is ServerCredentialKind {
  return (
    kind === "none" ||
    kind === "static-bearer" ||
    kind === "command-based" ||
    kind === "oauth-pkce"
  );
}

export function knownStructuralFieldsForCredentials(
  kind: ServerCredentialKind,
): ReadonlySet<string> {
  return KNOWN_STRUCTURAL[kind];
}
