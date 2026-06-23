import { requestUrl } from "obsidian";

/**
 * Build a `fetch`-compatible function backed by Obsidian's `requestUrl`.
 *
 * Why we need it: Obsidian's renderer process enforces browser CORS for
 * `window.fetch`. Most MCP HTTP endpoints (including
 * `https://mcp.svc.cloud.microsoft/enterprise`) do not emit
 * `Access-Control-Allow-Origin` for Obsidian's `app://obsidian.md` origin,
 * so browser fetch fails with "Failed to fetch" before the request body is
 * even returned. `requestUrl` issues the request from Electron's main
 * process, bypassing CORS the same way every Obsidian community plugin
 * does for non-CORS-enabled APIs.
 *
 * Trade-offs vs. browser fetch:
 *   - `requestUrl` follows HTTP 3xx redirects internally; our
 *     `createMcpHttpFetchWrapper` redirect-validation loop only sees the
 *     final response. We still pre-validate the configured server URL
 *     against private-network / metadata-host guardrails before the call.
 *   - The full response body is buffered before we synthesize a `Response`,
 *     so true streaming SSE consumers see the whole event log at once.
 *     MCP Streamable HTTP's initialize round-trip is one POST + one
 *     response, which is exactly what this adapter is designed for.
 *   - `AbortSignal` is honoured around (not during) the call. `requestUrl`
 *     has no native abort plumbing.
 */
export function createObsidianFetch(): typeof fetch {
  const adapter = async (
    input: RequestInfo | URL,
    init: RequestInit = {},
  ): Promise<Response> => {
    const url =
      input instanceof URL
        ? input.href
        : input instanceof Request
        ? input.url
        : String(input);
    const method = (init.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    const headers: Record<string, string> = {};
    const initHeaders = new Headers(
      init.headers ?? (input instanceof Request ? input.headers : undefined),
    );
    initHeaders.forEach((value, key) => {
      headers[key] = value;
    });
    const body = await coerceBody(init.body);
    if (init.signal?.aborted) {
      throw new DOMException("Aborted", "AbortError");
    }
    const resp = await requestUrl({
      url,
      method,
      headers,
      body,
      throw: false,
    });
    if (init.signal?.aborted) {
      throw new DOMException("Aborted", "AbortError");
    }
    const responseHeaders = new Headers();
    for (const [k, v] of Object.entries(resp.headers ?? {})) {
      responseHeaders.set(k, Array.isArray(v) ? v.join(", ") : String(v));
    }
    const buffer =
      resp.arrayBuffer ?? new TextEncoder().encode(resp.text ?? "").buffer;
    return new Response(buffer, {
      status: resp.status,
      headers: responseHeaders,
    });
  };
  return adapter as typeof fetch;
}

async function coerceBody(
  body: BodyInit | null | undefined,
): Promise<string | ArrayBuffer | undefined> {
  if (body == null) return undefined;
  if (typeof body === "string") return body;
  if (body instanceof ArrayBuffer) return body;
  if (body instanceof Uint8Array) {
    const slice = body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength);
    return slice as ArrayBuffer;
  }
  if (body instanceof URLSearchParams) return body.toString();
  if (typeof Blob !== "undefined" && body instanceof Blob) {
    return await body.arrayBuffer();
  }
  if (typeof FormData !== "undefined" && body instanceof FormData) {
    throw new Error("FormData bodies are not supported via requestUrl.");
  }
  return JSON.stringify(body);
}
