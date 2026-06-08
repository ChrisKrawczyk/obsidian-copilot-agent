import { describe, expect, test, vi } from "vitest";
import {
  DeviceFlowError,
  GITHUB_DEVICE_CODE_URL,
  GITHUB_TOKEN_URL,
  pollForToken,
  requestDeviceCode,
  runDeviceFlow,
} from "./DeviceFlow";
import type { HttpClient, HttpResponse } from "./HttpClient";

interface ScriptedResponse {
  url?: string;
  status: number;
  body: unknown;
  /** When set, the body is returned as `text` only — `json` is null. */
  rawText?: string;
}

function fakeHttp(scripted: ScriptedResponse[]): {
  http: HttpClient;
  calls: Array<{ url: string; params: Record<string, string> }>;
} {
  const calls: Array<{ url: string; params: Record<string, string> }> = [];
  let idx = 0;
  const http: HttpClient = {
    async postForm(url, params, options) {
      calls.push({ url, params });
      if (options?.signal?.aborted) {
        throw new DOMException("Aborted", "AbortError");
      }
      const r = scripted[idx++];
      if (!r) throw new Error("No more scripted responses");
      const text = r.rawText ?? JSON.stringify(r.body);
      const json = r.rawText ? null : r.body;
      const resp: HttpResponse = { status: r.status, json, text };
      return resp;
    },
  };
  return { http, calls };
}

const codeOk = {
  status: 200,
  body: {
    device_code: "dev123",
    user_code: "ABCD-1234",
    verification_uri: "https://github.com/login/device",
    expires_in: 900,
    interval: 1,
  },
};

describe("requestDeviceCode", () => {
  test("returns parsed code on 200", async () => {
    const { http, calls } = fakeHttp([codeOk]);
    const r = await requestDeviceCode({ http });
    expect(r.user_code).toBe("ABCD-1234");
    expect(r.device_code).toBe("dev123");
    expect(calls[0].url).toBe(GITHUB_DEVICE_CODE_URL);
    expect(calls[0].params.client_id).toBeTruthy();
  });

  test("throws DeviceFlowError on 4xx with error body", async () => {
    const { http } = fakeHttp([
      {
        status: 400,
        body: { error: "invalid_client", error_description: "nope" },
      },
    ]);
    await expect(requestDeviceCode({ http })).rejects.toMatchObject({
      code: "device_code_failed",
    });
  });

  test("throws on malformed JSON", async () => {
    const { http } = fakeHttp([{ status: 200, body: null, rawText: "not json" }]);
    await expect(requestDeviceCode({ http })).rejects.toMatchObject({
      code: "malformed_response",
    });
  });
});

describe("pollForToken", () => {
  const code = {
    device_code: "dev123",
    user_code: "ABCD-1234",
    verification_uri: "https://github.com/login/device",
    expires_in: 900,
    interval: 1,
  };

  test("returns access token on success", async () => {
    const { http } = fakeHttp([
      { status: 200, body: { access_token: "gho_abc", token_type: "bearer" } },
    ]);
    const result = await pollForToken(code, {
      http,
      sleep: () => Promise.resolve(),
    });
    expect(result.token).toBe("gho_abc");
  });

  test("retries on authorization_pending (regardless of status)", async () => {
    const sleeps: number[] = [];
    const { http, calls } = fakeHttp([
      { status: 200, body: { error: "authorization_pending" } },
      { status: 400, body: { error: "authorization_pending" } },
      { status: 200, body: { access_token: "gho_xyz" } },
    ]);
    const result = await pollForToken(code, {
      http,
      sleep: (ms) => {
        sleeps.push(ms);
        return Promise.resolve();
      },
    });
    expect(result.token).toBe("gho_xyz");
    expect(calls).toHaveLength(3);
    // Three poll attempts → three sleeps (one before each attempt).
    expect(sleeps).toHaveLength(3);
  });

  test("increments interval by 5s on slow_down", async () => {
    const sleeps: number[] = [];
    const { http } = fakeHttp([
      { status: 200, body: { error: "slow_down" } },
      { status: 200, body: { access_token: "gho_xyz" } },
    ]);
    await pollForToken(
      { ...code, interval: 1 },
      {
        http,
        sleep: (ms) => {
          sleeps.push(ms);
          return Promise.resolve();
        },
      },
    );
    // First sleep at 1s, then bumped to 6s after slow_down.
    expect(sleeps).toEqual([1000, 6000]);
  });

  test("expired_token surfaces as DeviceFlowError", async () => {
    const { http } = fakeHttp([
      { status: 200, body: { error: "expired_token" } },
    ]);
    await expect(
      pollForToken(code, { http, sleep: () => Promise.resolve() }),
    ).rejects.toMatchObject({ code: "expired_token" });
  });

  test("access_denied surfaces as DeviceFlowError", async () => {
    const { http } = fakeHttp([
      { status: 200, body: { error: "access_denied" } },
    ]);
    await expect(
      pollForToken(code, { http, sleep: () => Promise.resolve() }),
    ).rejects.toMatchObject({ code: "access_denied" });
  });

  test("aborts mid-sleep when signal fires", async () => {
    const { http } = fakeHttp([]);
    const ac = new AbortController();
    const promise = pollForToken(code, {
      http,
      signal: ac.signal,
      sleep: (_ms, signal) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener("abort", () => {
            reject(new DOMException("Aborted", "AbortError"));
          });
        }),
    });
    // Fire abort on next tick so polling has time to enter sleep.
    setTimeout(() => ac.abort(), 0);
    await expect(promise).rejects.toMatchObject({ code: "aborted" });
  });

  test("malformed JSON polling response throws malformed_response", async () => {
    const { http } = fakeHttp([
      { status: 200, body: null, rawText: "<html>down</html>" },
    ]);
    await expect(
      pollForToken(code, { http, sleep: () => Promise.resolve() }),
    ).rejects.toMatchObject({ code: "malformed_response" });
  });

  test("uses GITHUB_TOKEN_URL with grant_type", async () => {
    const { http, calls } = fakeHttp([
      { status: 200, body: { access_token: "gho_abc" } },
    ]);
    await pollForToken(code, { http, sleep: () => Promise.resolve() });
    expect(calls[0].url).toBe(GITHUB_TOKEN_URL);
    expect(calls[0].params.grant_type).toBe(
      "urn:ietf:params:oauth:grant-type:device_code",
    );
    expect(calls[0].params.device_code).toBe("dev123");
  });
});

describe("runDeviceFlow", () => {
  test("invokes onDeviceCode then resolves with token", async () => {
    const { http } = fakeHttp([
      codeOk,
      { status: 200, body: { access_token: "gho_full" } },
    ]);
    const onCode = vi.fn();
    const r = await runDeviceFlow({
      http,
      sleep: () => Promise.resolve(),
      onDeviceCode: onCode,
    });
    expect(onCode).toHaveBeenCalledOnce();
    expect(r.token).toBe("gho_full");
  });
});

describe("DeviceFlowError", () => {
  test("is an Error with code", () => {
    const e = new DeviceFlowError("oops", "expired_token");
    expect(e).toBeInstanceOf(Error);
    expect(e.code).toBe("expired_token");
  });
});
