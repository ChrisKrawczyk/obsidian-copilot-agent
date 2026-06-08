/**
 * Pure functions for GitHub's OAuth Device Flow. No SDK or Obsidian
 * imports — everything I/O goes through the injected `HttpClient` so tests
 * can simulate every documented response shape (RFC 8628 §3.5):
 *   - 200 + `access_token`              → success
 *   - 4xx/200 + `error: authorization_pending` → keep polling at interval
 *   - 4xx/200 + `error: slow_down`      → keep polling at interval + 5s
 *   - 4xx/200 + `error: expired_token`  → user took too long
 *   - 4xx/200 + `error: access_denied`  → user pressed Deny on GitHub
 *
 * GitHub historically returns HTTP 200 with the error in the body even on
 * polling errors; some other providers use 400/401. We treat status as a
 * tiebreaker only — the body's `error` field is the source of truth.
 */
import type { HttpClient } from "./HttpClient";

export const GITHUB_DEVICE_CODE_URL = "https://github.com/login/device/code";
export const GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token";

/**
 * gh CLI's public OAuth client ID. Reused under the documented v0.1
 * "personal spike" posture — see Spec §Risks. Replace with our own
 * registered app before any wider distribution.
 */
export const GH_CLI_CLIENT_ID = "178c6fc778ccc68e1d6a";

/**
 * Empty scope: Copilot's API authorisation is account-entitlement based,
 * not OAuth-scope based, so an unscoped user-to-server token is the
 * minimum-viable request. If the SDK ever rejects, the next escalation
 * step is `read:user` (still minimal, no repo access). Avoid `repo` and
 * `workflow` here — those grant write access we don't need.
 */
export const DEFAULT_SCOPE = "";

export interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  /** Some GH responses also include a complete URL with code embedded. */
  verification_uri_complete?: string;
  expires_in: number;
  interval: number;
}

export interface DeviceFlowOptions {
  http: HttpClient;
  clientId?: string;
  scope?: string;
  /** Cancel an in-flight poll loop. */
  signal?: AbortSignal;
  /** Sleep helper (overridable in tests). */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Called once we have a device code so callers can render the modal. */
  onDeviceCode?: (resp: DeviceCodeResponse) => void;
  /** Hard upper bound on total polling time (covers buggy `expires_in`). */
  pollCeilingMs?: number;
}

export class DeviceFlowError extends Error {
  constructor(
    message: string,
    readonly code:
      | "device_code_failed"
      | "expired_token"
      | "access_denied"
      | "aborted"
      | "malformed_response"
      | "http_error",
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "DeviceFlowError";
  }
}

/** Run the full flow end-to-end and return the access token. */
export async function runDeviceFlow(
  opts: DeviceFlowOptions,
): Promise<{ token: string; tokenType: string; scope: string }> {
  const code = await requestDeviceCode(opts);
  opts.onDeviceCode?.(code);
  return pollForToken(code, opts);
}

export async function requestDeviceCode(
  opts: DeviceFlowOptions,
): Promise<DeviceCodeResponse> {
  const clientId = opts.clientId ?? GH_CLI_CLIENT_ID;
  const scope = opts.scope ?? DEFAULT_SCOPE;
  let resp;
  try {
    resp = await opts.http.postForm(
      GITHUB_DEVICE_CODE_URL,
      { client_id: clientId, scope },
      { signal: opts.signal },
    );
  } catch (e) {
    if (isAbort(e)) {
      throw new DeviceFlowError("Device flow aborted", "aborted", e);
    }
    throw new DeviceFlowError(
      `Device code request failed: ${
        e instanceof Error ? e.message : String(e)
      }`,
      "http_error",
      e,
    );
  }
  const body = parseJsonOrThrow(resp.text, resp.json);
  if (resp.status >= 400 || typeof body.device_code !== "string") {
    const ghErr = typeof body.error === "string" ? body.error : undefined;
    throw new DeviceFlowError(
      ghErr
        ? `GitHub rejected device code request: ${ghErr}${
            typeof body.error_description === "string"
              ? ` (${body.error_description})`
              : ""
          }`
        : `Device code request failed (HTTP ${resp.status})`,
      "device_code_failed",
    );
  }
  return {
    device_code: body.device_code as string,
    user_code: String(body.user_code ?? ""),
    verification_uri: String(body.verification_uri ?? ""),
    verification_uri_complete:
      typeof body.verification_uri_complete === "string"
        ? body.verification_uri_complete
        : undefined,
    expires_in:
      typeof body.expires_in === "number" ? body.expires_in : 900,
    interval: typeof body.interval === "number" ? body.interval : 5,
  };
}

export async function pollForToken(
  code: DeviceCodeResponse,
  opts: DeviceFlowOptions,
): Promise<{ token: string; tokenType: string; scope: string }> {
  const clientId = opts.clientId ?? GH_CLI_CLIENT_ID;
  const sleep = opts.sleep ?? defaultSleep;
  const ceilingMs = opts.pollCeilingMs ?? 30 * 60 * 1000;
  const startedAt = Date.now();
  let intervalSec = code.interval >= 0 ? code.interval : 5;

  while (true) {
    if (opts.signal?.aborted) {
      throw new DeviceFlowError("Device flow aborted", "aborted");
    }
    if (Date.now() - startedAt > ceilingMs) {
      throw new DeviceFlowError("Device flow timed out", "expired_token");
    }
    try {
      await sleep(intervalSec * 1000, opts.signal);
    } catch (e) {
      if (isAbort(e)) {
        throw new DeviceFlowError("Device flow aborted", "aborted", e);
      }
      throw e;
    }
    if (opts.signal?.aborted) {
      throw new DeviceFlowError("Device flow aborted", "aborted");
    }

    let resp;
    try {
      resp = await opts.http.postForm(
        GITHUB_TOKEN_URL,
        {
          client_id: clientId,
          device_code: code.device_code,
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        },
        { signal: opts.signal },
      );
    } catch (e) {
      if (isAbort(e)) {
        throw new DeviceFlowError("Device flow aborted", "aborted", e);
      }
      throw new DeviceFlowError(
        `Token poll request failed: ${
          e instanceof Error ? e.message : String(e)
        }`,
        "http_error",
        e,
      );
    }

    const body = parseJsonOrNull(resp.text, resp.json);
    if (!body) {
      throw new DeviceFlowError(
        `Malformed token response (HTTP ${resp.status}): ${resp.text.slice(0, 200)}`,
        "malformed_response",
      );
    }

    if (typeof body.access_token === "string" && body.access_token.length > 0) {
      return {
        token: body.access_token,
        tokenType:
          typeof body.token_type === "string" ? body.token_type : "bearer",
        scope: typeof body.scope === "string" ? body.scope : "",
      };
    }

    const ghErr = typeof body.error === "string" ? body.error : undefined;
    if (ghErr === "authorization_pending") {
      continue;
    }
    if (ghErr === "slow_down") {
      // RFC 8628 §3.5: client MUST increase interval by 5 seconds.
      intervalSec += 5;
      continue;
    }
    if (ghErr === "expired_token") {
      throw new DeviceFlowError(
        "Device code expired before authorisation",
        "expired_token",
      );
    }
    if (ghErr === "access_denied") {
      throw new DeviceFlowError(
        "User declined the authorisation request",
        "access_denied",
      );
    }
    throw new DeviceFlowError(
      `Unexpected token response (HTTP ${resp.status}): ${
        ghErr ?? resp.text.slice(0, 200)
      }`,
      "http_error",
    );
  }
}

// ---- helpers ----

function parseJsonOrThrow(
  text: string,
  parsed: unknown,
): Record<string, unknown> {
  if (parsed && typeof parsed === "object") {
    return parsed as Record<string, unknown>;
  }
  try {
    const v = JSON.parse(text);
    if (v && typeof v === "object") return v as Record<string, unknown>;
  } catch {
    /* fall through */
  }
  throw new DeviceFlowError(
    `Malformed JSON response: ${text.slice(0, 200)}`,
    "malformed_response",
  );
}

function parseJsonOrNull(
  text: string,
  parsed: unknown,
): Record<string, unknown> | null {
  if (parsed && typeof parsed === "object") {
    return parsed as Record<string, unknown>;
  }
  try {
    const v = JSON.parse(text);
    if (v && typeof v === "object") return v as Record<string, unknown>;
    return null;
  } catch {
    return null;
  }
}

function isAbort(e: unknown): boolean {
  if (!e || typeof e !== "object") return false;
  const r = e as Record<string, unknown>;
  return r.name === "AbortError" || r.code === "ABORT_ERR";
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new DOMException("Aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
