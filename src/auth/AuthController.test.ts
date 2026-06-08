import { describe, expect, test, vi } from "vitest";
import {
  AuthController,
  type AgentTokenSink,
  type AuthState,
} from "./AuthController";
import type { HttpClient, HttpResponse } from "./HttpClient";
import { TokenStore, type PluginDataIO } from "./TokenStore";

function tokenStore(blob: unknown = {}) {
  let cur: unknown = blob;
  const io: PluginDataIO = {
    loadData: async () => cur,
    saveData: async (d) => {
      cur = d;
    },
  };
  const store = new TokenStore(io);
  return {
    store,
    io,
    get blob() {
      return cur as Record<string, unknown>;
    },
  };
}

function fakeHttp(responses: Array<{ status: number; body: unknown }>): {
  http: HttpClient;
} {
  let i = 0;
  const http: HttpClient = {
    async postForm() {
      const r = responses[i++] ?? responses[responses.length - 1];
      const text = JSON.stringify(r.body);
      const resp: HttpResponse = { status: r.status, json: r.body, text };
      return resp;
    },
  };
  return { http };
}

function fakeSink(opts: {
  reconnect?: () => Promise<string | undefined>;
  setToken?: (t: string | null) => Promise<void>;
} = {}): {
  sink: AgentTokenSink;
  setTokenCalls: Array<string | null>;
  reconnectCalls: number;
} {
  const setTokenCalls: Array<string | null> = [];
  let reconnectCalls = 0;
  return {
    sink: {
      setToken: opts.setToken
        ? async (t) => {
            setTokenCalls.push(t);
            return opts.setToken!(t);
          }
        : async (t) => {
            setTokenCalls.push(t);
          },
      reconnect: async () => {
        reconnectCalls += 1;
        return opts.reconnect ? opts.reconnect() : "gpt-4.1";
      },
    },
    setTokenCalls,
    get reconnectCalls() {
      return reconnectCalls;
    },
  };
}

describe("AuthController.connect", () => {
  test("happy path: connecting → validating → connected", async () => {
    const { store } = tokenStore({});
    await store.load();
    const { http } = fakeHttp([
      {
        status: 200,
        body: {
          device_code: "d",
          user_code: "ABC",
          verification_uri: "https://github.com/login/device",
          expires_in: 900,
          interval: 0,
        },
      },
      { status: 200, body: { access_token: "gho_ok" } },
    ]);
    const sink = fakeSink();
    const ctrl = new AuthController({
      http,
      tokenStore: store,
      agentTokenSink: sink.sink,
    });
    const seen: AuthState["kind"][] = [];
    ctrl.subscribe((s) => seen.push(s.kind));
    await ctrl.connect();
    expect(seen).toContain("connecting");
    expect(seen).toContain("validating");
    expect(seen).toContain("connected");
    expect(sink.setTokenCalls).toContain("gho_ok");
    expect(sink.reconnectCalls).toBeGreaterThan(0);
  });

  test("double-connect throws on second concurrent call", async () => {
    const { store } = tokenStore({});
    await store.load();
    // Hangs until cancelled — we want the first connect to stay
    // mid-flight while we test the synchronous gate.
    const http: HttpClient = {
      postForm: (_url, _params, options) =>
        new Promise((_resolve, reject) => {
          options?.signal?.addEventListener("abort", () =>
            reject(new DOMException("Aborted", "AbortError")),
          );
        }),
    };
    const sink = fakeSink();
    const ctrl = new AuthController({
      http,
      tokenStore: store,
      agentTokenSink: sink.sink,
    });
    const p = ctrl.connect();
    await expect(ctrl.connect()).rejects.toThrow(/Cannot connect/);
    ctrl.cancelConnect();
    await p.catch(() => {});
  });

  test("cancelConnect transitions to disconnected", async () => {
    const { store } = tokenStore({});
    await store.load();
    let aborted = false;
    const http: HttpClient = {
      postForm: (_url, _params, options) =>
        new Promise((_resolve, reject) => {
          options?.signal?.addEventListener("abort", () => {
            aborted = true;
            reject(new DOMException("Aborted", "AbortError"));
          });
        }),
    };
    const sink = fakeSink();
    const ctrl = new AuthController({
      http,
      tokenStore: store,
      agentTokenSink: sink.sink,
    });
    const p = ctrl.connect();
    ctrl.cancelConnect();
    await p;
    expect(aborted).toBe(true);
    expect(ctrl.getState().kind).toBe("disconnected");
  });

  test("validation failure rolls back token + flips to error", async () => {
    const ctx = tokenStore({});
    await ctx.store.load();
    const { http } = fakeHttp([
      {
        status: 200,
        body: {
          device_code: "d",
          user_code: "ABC",
          verification_uri: "https://github.com/login/device",
          expires_in: 900,
          interval: 0,
        },
      },
      { status: 200, body: { access_token: "gho_bad" } },
    ]);
    const sink = fakeSink({
      reconnect: async () => {
        throw Object.assign(new Error("no copilot"), { status: 403 });
      },
    });
    const ctrl = new AuthController({
      http,
      tokenStore: ctx.store,
      agentTokenSink: sink.sink,
    });
    await ctrl.connect();
    expect(ctrl.getState().kind).toBe("error");
    // Token was wiped from the store after the failure.
    expect((ctx.blob.auth as Record<string, unknown>).token).toBeNull();
    // setToken(null) was called on the agent to stop the runtime.
    expect(sink.setTokenCalls).toContain(null);
  });
});

describe("AuthController.hydrate", () => {
  test("no persisted token → disconnected", async () => {
    const { store } = tokenStore({});
    await store.load();
    const ctrl = new AuthController({
      http: { postForm: async () => ({ status: 0, json: null, text: "" }) },
      tokenStore: store,
      agentTokenSink: fakeSink().sink,
    });
    await ctrl.hydrate();
    expect(ctrl.getState().kind).toBe("disconnected");
  });

  test("valid persisted token → connected after validating", async () => {
    const { store } = tokenStore({ auth: { token: "gho_persist" } });
    await store.load();
    const sink = fakeSink();
    const ctrl = new AuthController({
      http: { postForm: async () => ({ status: 0, json: null, text: "" }) },
      tokenStore: store,
      agentTokenSink: sink.sink,
    });
    const seen: AuthState["kind"][] = [];
    ctrl.subscribe((s) => seen.push(s.kind));
    await ctrl.hydrate();
    expect(seen).toContain("validating");
    expect(ctrl.getState().kind).toBe("connected");
    expect(sink.setTokenCalls).toContain("gho_persist");
  });

  test("revoked persisted token wipes itself + flips to error", async () => {
    const ctx = tokenStore({ auth: { token: "gho_revoked" } });
    await ctx.store.load();
    const sink = fakeSink({
      reconnect: async () => {
        throw Object.assign(new Error("Bad credentials"), { status: 401 });
      },
    });
    const ctrl = new AuthController({
      http: { postForm: async () => ({ status: 0, json: null, text: "" }) },
      tokenStore: ctx.store,
      agentTokenSink: sink.sink,
    });
    await ctrl.hydrate();
    expect(ctrl.getState().kind).toBe("error");
    expect((ctx.blob.auth as Record<string, unknown>).token).toBeNull();
  });
});

describe("AuthController.disconnect", () => {
  test("clears token + transitions to disconnected", async () => {
    const ctx = tokenStore({ auth: { token: "gho_x" } });
    await ctx.store.load();
    const sink = fakeSink();
    const ctrl = new AuthController({
      http: { postForm: async () => ({ status: 0, json: null, text: "" }) },
      tokenStore: ctx.store,
      agentTokenSink: sink.sink,
    });
    await ctrl.hydrate();
    await ctrl.disconnect();
    expect(ctrl.getState().kind).toBe("disconnected");
    expect((ctx.blob.auth as Record<string, unknown>).token).toBeNull();
    expect(sink.setTokenCalls.at(-1)).toBeNull();
  });
});

describe("AuthController.notifyAuthFailure", () => {
  test("flips connected → error with helpful message", async () => {
    const { store } = tokenStore({ auth: { token: "gho_x" } });
    await store.load();
    const ctrl = new AuthController({
      http: { postForm: async () => ({ status: 0, json: null, text: "" }) },
      tokenStore: store,
      agentTokenSink: fakeSink().sink,
    });
    await ctrl.hydrate();
    expect(ctrl.getState().kind).toBe("connected");
    ctrl.notifyAuthFailure(new Error("Bad credentials"));
    expect(ctrl.getState().kind).toBe("error");
  });

  test("ignores notifications while disconnected", async () => {
    const { store } = tokenStore({});
    await store.load();
    const ctrl = new AuthController({
      http: { postForm: async () => ({ status: 0, json: null, text: "" }) },
      tokenStore: store,
      agentTokenSink: fakeSink().sink,
    });
    await ctrl.hydrate();
    ctrl.notifyAuthFailure(new Error("transient"));
    expect(ctrl.getState().kind).toBe("disconnected");
  });
});
