export const DEFAULT_TOKEN_PATH = "accessToken";
export const DEFAULT_EXPIRY_PATH = "expiresOn";
export const DEFAULT_REFRESH_BUFFER_SECONDS = 300;

export interface NoneCredentials {
  kind: "none";
}

export interface StaticBearerCredentials {
  kind: "static-bearer";
  token: string;
}

export interface CommandBasedCredentials {
  kind: "command-based";
  command: string;
  args?: string[];
  tokenPath?: string;
  expiryPath?: string;
  refreshBufferSeconds?: number;
}

/**
 * Reserved-but-inert OAuth 2.1 + PKCE credentials shape (FR-012).
 *
 * No runtime code in this release consumes this variant; the schema is
 * preserved verbatim so a future plugin version implementing OAuth + PKCE
 * can read configurations written today without migration loss. The index
 * signature lets unknown future fields round-trip losslessly through the
 * settings store (SC-008 byte-equivalence obligation).
 */
export interface OAuthPkceCredentials {
  kind: "oauth-pkce";
  authorizationEndpoint: string;
  tokenEndpoint: string;
  clientId: string;
  tenantId?: string;
  scopes: string[];
  redirectUri?: string;
  refreshTokenRef?: string;
  pkceMethod?: string;
  [futureKey: string]: unknown;
}

export type ServerCredentials =
  | NoneCredentials
  | StaticBearerCredentials
  | CommandBasedCredentials
  | OAuthPkceCredentials;

export type ServerCredentialKind = ServerCredentials["kind"];

export function isNone(value: ServerCredentials): value is NoneCredentials {
  return value.kind === "none";
}

export function isStaticBearer(
  value: ServerCredentials,
): value is StaticBearerCredentials {
  return value.kind === "static-bearer";
}

export function isCommandBased(
  value: ServerCredentials,
): value is CommandBasedCredentials {
  return value.kind === "command-based";
}

export function isOAuthPkce(
  value: ServerCredentials,
): value is OAuthPkceCredentials {
  return value.kind === "oauth-pkce";
}
