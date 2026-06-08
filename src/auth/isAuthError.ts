/**
 * Structured detection of GitHub auth failures. Looks at numeric status,
 * code strings, and JSON-RPC payloads from the SDK runtime before falling
 * back to a message regex. Kept structural so it works against:
 *   - Obsidian `requestUrl` errors (have `status`)
 *   - fetch-style errors (`status`, `statusCode`)
 *   - JSON-RPC errors from the SDK (nested `data.error`, `data.statusCode`)
 *   - generic `Error` with telltale text
 */
export function isAuthError(err: unknown): boolean {
  if (!err) return false;
  const seen = new Set<unknown>();
  return walk(err, seen);
}

function walk(node: unknown, seen: Set<unknown>): boolean {
  if (node === null || node === undefined) return false;
  if (typeof node !== "object" && typeof node !== "string") {
    if (typeof node === "number") return node === 401 || node === 403;
    return false;
  }
  if (typeof node === "string") {
    return matchesAuthMessage(node);
  }
  if (seen.has(node)) return false;
  seen.add(node);
  const r = node as Record<string, unknown>;

  for (const k of ["status", "statusCode", "httpStatus", "responseStatus"]) {
    const v = r[k];
    if (typeof v === "number" && (v === 401 || v === 403)) return true;
  }
  for (const k of ["code", "error", "type"]) {
    const v = r[k];
    if (typeof v === "string" && AUTH_CODES.has(v)) return true;
  }
  for (const k of ["cause", "data", "error", "response", "body", "payload"]) {
    if (k in r && walk(r[k], seen)) return true;
  }
  const msg = r.message;
  if (typeof msg === "string" && matchesAuthMessage(msg)) return true;

  return false;
}

const AUTH_CODES = new Set<string>([
  "unauthorized",
  "Unauthorized",
  "UNAUTHORIZED",
  "forbidden",
  "Forbidden",
  "FORBIDDEN",
  "invalid_token",
  "bad_credentials",
  "BadCredentials",
  "401",
  "403",
]);

const AUTH_MESSAGE_RE =
  /\b(401|403|unauthorized|forbidden|bad credentials|invalid (?:auth )?token|authentication failed|token (?:is )?(?:invalid|expired|revoked))\b/i;

function matchesAuthMessage(s: string): boolean {
  return AUTH_MESSAGE_RE.test(s);
}
