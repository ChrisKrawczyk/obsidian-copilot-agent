import { redactSensitive } from "./redactSensitive";

/**
 * Typed HTTP error surfaced from `createMcpHttpFetchWrapper` for non-OK
 * responses (status >= 400). Carries `status` and `wwwAuthenticate`
 * so the manager's 401-retry path can dispatch correctly without
 * having to string-match against opaque SDK error messages.
 *
 * The `message` field preserves the existing redacted-string contract
 * (`redactSensitive` applied; embedded `Bearer <token>` inside the
 * `wwwAuthenticate` challenge is scrubbed). Scheme / realm tokens are
 * NOT secrets and survive unredacted so they can be shown to the user
 * in chat errors (FR-014 + spec edge case 5).
 */
export class McpHttpError extends Error {
  readonly status: number;
  readonly wwwAuthenticate: string | null;

  constructor(status: number, wwwAuthenticate: string | null, message?: string) {
    super(
      redactSensitive(
        message ??
          `MCP HTTP request failed with status ${status}${
            wwwAuthenticate ? `: ${wwwAuthenticate}` : ""
          }.`,
      ),
    );
    this.name = "McpHttpError";
    this.status = status;
    this.wwwAuthenticate = wwwAuthenticate
      ? redactSensitive(wwwAuthenticate)
      : null;
  }
}

export function isMcpHttpError(value: unknown): value is McpHttpError {
  return value instanceof McpHttpError;
}
