/**
 * Minimal HTTP client surface used by DeviceFlow. Two implementations:
 *   - obsidianHttpClient (production): wraps Obsidian's `requestUrl`, which
 *     bypasses the renderer CORS sandbox. MUST set `throw: false` so we can
 *     inspect 4xx bodies (Device Flow polling can return non-2xx with
 *     structured `error` payloads).
 *   - fakes in tests: deterministic responses keyed by URL+body.
 *
 * The interface is intentionally small (POST + form bodies + JSON parsing)
 * because that's all we need for GitHub's OAuth Device Flow endpoints.
 */

export interface HttpResponse {
  status: number;
  /** Best-effort JSON parse. `null` if body wasn't valid JSON. */
  json: unknown | null;
  /** Raw text body — always populated even when `json` is null. */
  text: string;
}

export interface HttpClient {
  postForm(
    url: string,
    params: Record<string, string>,
    options?: { signal?: AbortSignal },
  ): Promise<HttpResponse>;
}

/**
 * Production HttpClient backed by Obsidian's `requestUrl`. Lazily imports
 * obsidian so this module is still importable from non-Obsidian test
 * harnesses (vitest in node).
 */
export function obsidianHttpClient(): HttpClient {
  return {
    async postForm(url, params, options) {
      // Lazy import keeps `obsidian` out of the test bundle.
      const { requestUrl } = await import("obsidian");
      const body = new URLSearchParams(params).toString();
      if (options?.signal?.aborted) {
        throw new DOMException("Aborted", "AbortError");
      }
      // requestUrl has no native AbortSignal support. We honour `signal`
      // before/after the call; mid-call cancellation is best-effort —
      // Device Flow polling sleeps between requests, and that's where
      // we actually abort.
      const resp = await requestUrl({
        url,
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
          "User-Agent": "obsidian-copilot-agent",
        },
        body,
        // CRITICAL: GitHub's Device Flow polling returns non-2xx (or 200
        // with `error` body depending on endpoint). Default `requestUrl`
        // throws on >= 400; we need to inspect bodies, so disable that.
        throw: false,
      });
      let parsed: unknown = null;
      try {
        parsed = resp.json;
      } catch {
        try {
          parsed = JSON.parse(resp.text);
        } catch {
          parsed = null;
        }
      }
      if (options?.signal?.aborted) {
        throw new DOMException("Aborted", "AbortError");
      }
      return {
        status: resp.status,
        json: parsed,
        text: resp.text,
      };
    },
  };
}
