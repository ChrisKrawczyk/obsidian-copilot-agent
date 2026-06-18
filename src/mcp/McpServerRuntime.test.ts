import { describe, expect, test, vi } from "vitest";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { normalizeServerId } from "./McpIdentity";
import type { McpServerConfig } from "./McpTypes";
import {
  MCP_ADVERTISED_PROTOCOL_VERSION,
  MCP_DISCOVERY_TIMEOUT_MS,
  MCP_INITIALIZE_TIMEOUT_MS,
  MCP_MAX_TOOL_LIST_PAGES,
  MCP_MAX_TOOLS_PER_SERVER,
  McpServerRuntime,
  type McpServerRuntimeOptions,
  negotiateProtocolVersion,
} from "./McpServerRuntime";

describe("McpServerRuntime", () => {
  test("initialize sends advertised version and roots capability", async () => {
    const transport = new FakeTransport({
      initialize: {
        protocolVersion: "2025-06-18",
        capabilities: { tools: {} },
      },
      "tools/list": { tools: [] },
    });
    await runtime(transport).connect();
    const init = transport.requests.find((r) => r.method === "initialize");
    expect(init?.params).toMatchObject({
      protocolVersion: MCP_ADVERTISED_PROTOCOL_VERSION,
      capabilities: { roots: { listChanged: false } },
    });
    expect(transport.notifications).toContain("notifications/initialized");
  });

  test("tools capability absent marks incompatible with zero tools before tools/list", async () => {
    const transport = new FakeTransport({
      initialize: { protocolVersion: "2025-06-18", capabilities: {} },
    });
    const rt = runtime(transport);
    await rt.connect();
    expect(rt.snapshot()).toMatchObject({ status: "error", toolCount: 0 });
    expect(transport.requests.some((r) => r.method === "tools/list")).toBe(false);
  });

  test("tools/list_changed subscription is tracked only when advertised", async () => {
    const yes = runtime(
      new FakeTransport({
        initialize: {
          protocolVersion: "2025-06-18",
          capabilities: { tools: { listChanged: true } },
        },
        "tools/list": { tools: [] },
      }),
    );
    await yes.connect();
    expect(yes.hasListChangedSubscription()).toBe(true);

    const no = runtime(
      new FakeTransport({
        initialize: {
          protocolVersion: "2025-06-18",
          capabilities: { tools: {} },
        },
        "tools/list": { tools: [] },
      }),
    );
    await no.connect();
    expect(no.hasListChangedSubscription()).toBe(false);
  });

  test("initialize timeout is 10 seconds", async () => {
    vi.useFakeTimers();
    try {
      const rt = runtime(new FakeTransport({}, { noResponses: true }));
      const promise = rt.connect();
      const expectation = expect(promise).rejects.toThrow(/initialize.*timed out/);
      await vi.advanceTimersByTimeAsync(MCP_INITIALIZE_TIMEOUT_MS);
      await expectation;
    } finally {
      vi.useRealTimers();
    }
  });

  test("same-load tools/list and tools/call retain volatile session id", async () => {
    const transport = new FakeTransport(
      {
        initialize: {
          protocolVersion: "2025-06-18",
          capabilities: { tools: {} },
        },
        "tools/list": { tools: [{ name: "echo" }] },
        "tools/call": { content: [{ type: "text", text: "ok" }] },
      },
      { sessionId: "sid-secret" },
    );
    const rt = runtime(transport);
    await rt.connect();
    await rt.callTool("echo", {});
    expect(rt.getVolatileSessionIdForTest()).toBe("sid-secret");
    await rt.disable();
    expect(rt.getVolatileSessionIdForTest()).toBeUndefined();
  });

  test("tools/call timeout defaults to 60 seconds", async () => {
    const transport = new HangingCallTransport();
    const rt = runtime(transport);
    await rt.connect();
    vi.useFakeTimers();
    try {
      const call = rt.callTool("echo", {});
      const expectation = expect(call).rejects.toThrow(/tools\/call.*timed out/);
      await vi.advanceTimersByTimeAsync(60_000);
      await expectation;
    } finally {
      vi.useRealTimers();
    }
  });

  test("Stop during tools/call sends bounded cancellation payload and late response is ignored", async () => {
    const transport = new HangingCallTransport();
    const rt = runtime(transport);
    await rt.connect();
    const controller = new AbortController();
    const call = rt.callToolCancellable("echo", { secret: "do-not-send" }, 60_000, controller.signal);
    controller.abort();
    await expect(call).rejects.toMatchObject({ name: "CancelledError" });
    const cancel = transport.sentMessages.find((message) => (message as { method?: string }).method === "notifications/cancelled") as { params?: unknown } | undefined;
    expect(cancel?.params).toEqual({ requestId: "oca-3", reason: "user_cancelled" });
    expect(JSON.stringify(cancel)).not.toContain("do-not-send");
  });

  test("tools/call honors per-server callTimeoutMs", async () => {
    const transport = new HangingCallTransport();
    const rt = runtime(transport, { ...config(), callTimeoutMs: 5_000 });
    await rt.connect();
    vi.useFakeTimers();
    try {
      const call = rt.callTool("echo", {});
      const expectation = expect(call).rejects.toThrow(/tools\/call.*timed out/);
      await vi.advanceTimersByTimeAsync(5_000);
      await expectation;
    } finally {
      vi.useRealTimers();
    }
  });

  test("numeric server-originated ids do not collide with prefixed client request ids", async () => {
    const transport = new HangingCallTransport();
    const rt = runtime(transport);
    await rt.connect();
    vi.useFakeTimers();
    try {
      const call = rt.callTool("echo", {});
      const expectation = expect(call).rejects.toThrow(/tools\/call.*timed out/);
      transport.onmessage?.({ jsonrpc: "2.0", id: 1, result: { content: "wrong" } } as JSONRPCMessage);
      await vi.advanceTimersByTimeAsync(60_000);
      await expectation;
    } finally {
      vi.useRealTimers();
    }
  });

  test("unload mid-handshake aborts initialize and never publishes connected", async () => {
    vi.useFakeTimers();
    try {
      const rt = runtime(new FakeTransport({}, { noResponses: true }));
      const connect = rt.connect();
      await rt.unload();
      await expect(connect).rejects.toThrow(/cancelled|closed|timed out/i);
      expect(rt.snapshot().status).not.toBe("connected");
    } finally {
      vi.useRealTimers();
    }
  });

  test("Stop never sends notifications/cancelled for initialize", async () => {
    vi.useFakeTimers();
    try {
      const transport = new FakeTransport({}, { noResponses: true });
      const rt = runtime(transport);
      const connect = rt.connect();
      await rt.unload();
      await expect(connect).rejects.toThrow(/cancelled|closed|timed out/i);
      expect(transport.sentMessages.some((message) => (message as { method?: string }).method === "notifications/cancelled")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  test("HTTP shutdown attempts bounded DELETE with session id then clears it", async () => {
    const fetchSpy = vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }));
    const transport = new FakeTransport(
      {
        initialize: { protocolVersion: "2025-06-18", capabilities: { tools: {} } },
        "tools/list": { tools: [] },
      },
      { sessionId: "sid-secret" },
    );
    const rt = runtime(transport, httpConfig(), { fetch: fetchSpy as never });
    await rt.connect();
    vi.useFakeTimers();
    try {
      const unload = rt.unload();
      await vi.advanceTimersByTimeAsync(1_500);
      await unload;
      expect(fetchSpy).toHaveBeenCalledWith("https://example.com/mcp", expect.objectContaining({
        method: "DELETE",
        headers: expect.objectContaining({ "Mcp-Session-Id": "sid-secret" }),
      }));
      expect(rt.getVolatileSessionIdForTest()).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  test("five crashes in five minutes enter crashloop terminal state", async () => {
    let now = 0;
    const rt = runtime(new FakeTransport({}), config(), {
      now: () => now,
      transportFactory: () => new FakeTransport({ initialize: new Error("boom") }),
    });
    for (let i = 0; i < 5; i += 1) {
      await expect(rt.connect()).rejects.toThrow();
      now += 30_000;
    }
    expect(rt.snapshot()).toMatchObject({ status: "crashloop", toolCount: 0 });
  });

  test("crashloop blocks automatic connect until manualReconnect resets attempts", async () => {
    let now = 0;
    const factory = vi.fn(() => new FakeTransport({ initialize: new Error("boom") }));
    const rt = runtime(new FakeTransport({}), config(), {
      now: () => now,
      transportFactory: factory,
    });
    for (let i = 0; i < 5; i += 1) {
      await expect(rt.connect()).rejects.toThrow();
      now += 30_000;
    }
    expect(rt.snapshot()).toMatchObject({ status: "crashloop", toolCount: 0 });
    factory.mockClear();
    await rt.connect();
    expect(factory).not.toHaveBeenCalled();
    expect(rt.snapshot()).toMatchObject({ status: "crashloop", toolCount: 0 });
    factory.mockImplementationOnce(() => new FakeTransport({
      initialize: { protocolVersion: "2025-06-18", capabilities: { tools: {} } },
      "tools/list": { tools: [] },
    }));
    await rt.manualReconnect();
    expect(factory).toHaveBeenCalledTimes(1);
    expect(rt.snapshot()).toMatchObject({ status: "connected", toolCount: 0 });
  });

  test("session id and SDK errors are redacted from snapshots", async () => {
    const transport = new FakeTransport(
      {
        initialize: {
          protocolVersion: "2025-06-18",
          capabilities: { tools: {} },
        },
        "tools/list": new Error("Bearer abc Mcp-Session-Id: sid OPENAI_API_KEY=sk"),
      },
      { sessionId: "sid" },
    );
    const rt = runtime(transport);
    await expect(rt.connect()).rejects.toThrow();
    const snap = JSON.stringify(rt.snapshot());
    expect(snap).not.toContain("abc");
    expect(snap).not.toContain("sid ");
    expect(snap).not.toContain("sk");
  });

  test("rejects same-server duplicate tools", async () => {
    const rt = runtime(
      new FakeTransport({
        initialize: {
          protocolVersion: "2025-06-18",
          capabilities: { tools: {} },
        },
        "tools/list": { tools: [{ name: "a" }, { name: "a" }] },
      }),
    );
    await expect(rt.connect()).rejects.toThrow(/Duplicate/);
  });

  test("enforces 50 page and 1000 tool caps", async () => {
    const pages: Record<string, unknown> = {
      initialize: {
        protocolVersion: "2025-06-18",
        capabilities: { tools: {} },
      },
    };
    for (let i = 0; i < MCP_MAX_TOOL_LIST_PAGES + 1; i += 1) {
      pages[`tools/list:${i === 0 ? "" : `c${i}`}`] = {
        tools: [],
        nextCursor: `c${i + 1}`,
      };
    }
    await expect(runtime(new FakeTransport(pages)).connect()).rejects.toThrow(/page cap/);

    const tooManyTools = Array.from({ length: MCP_MAX_TOOLS_PER_SERVER + 1 }, (_, i) => ({
      name: `t${i}`,
    }));
    await expect(
      runtime(
        new FakeTransport({
          initialize: { protocolVersion: "2025-06-18", capabilities: { tools: {} } },
          "tools/list": { tools: tooManyTools },
        }),
      ).connect(),
    ).rejects.toThrow(/tool cap/);
  });

  test("tools/list discovery uses one aggregate deadline with shortened page timeout", async () => {
    const timerDelays: number[] = [];
    const pages: Record<string, unknown> = {
      initialize: {
        protocolVersion: "2025-06-18",
        capabilities: { tools: {} },
      },
      "tools/list:": { tools: [], nextCursor: "c1" },
      "tools/list:c1": { tools: [], nextCursor: "c2" },
      "tools/list:c2": { tools: [], nextCursor: "c3" },
      "tools/list:c3": { tools: [] },
    };
    const nowValues = [0, 0, 9_000, 18_000, MCP_DISCOVERY_TIMEOUT_MS - 4_000];
    await runtime(new FakeTransport(pages), config(), {
      now: () => nowValues.shift() ?? MCP_DISCOVERY_TIMEOUT_MS,
      setTimeout: ((handler: TimerHandler, timeout?: number) => {
        void handler;
        timerDelays.push(timeout ?? 0);
        return 0;
      }) as typeof setTimeout,
      clearTimeout: (() => undefined) as typeof clearTimeout,
    }).connect();
    expect(timerDelays.slice(2)).toEqual([10_000, 10_000, 10_000, 4_000]);

    const expired = new FakeTransport({
      initialize: { protocolVersion: "2025-06-18", capabilities: { tools: {} } },
      "tools/list": { tools: [] },
    });
    await expect(
      runtime(expired, config(), {
        now: vi.fn().mockReturnValueOnce(0).mockReturnValueOnce(MCP_DISCOVERY_TIMEOUT_MS),
      }).connect(),
    ).rejects.toThrow(/aggregate timeout/);
    expect(expired.requests.filter((r) => r.method === "tools/list")).toHaveLength(0);
  });

  test("protocol matrix accepts supported versions and rejects legacy SSE/unknown", () => {
    const versions = ["2025-06-18", "2024-11-05", "1999-01-01"] as const;
    const transports = ["stdio", "http", "legacy-sse"] as const;
    const outcomes = transports.flatMap((transport) =>
      versions.map((serverReturns) => {
        try {
          return [transport, serverReturns, negotiateProtocolVersion(serverReturns, transport)];
        } catch {
          return [transport, serverReturns, "reject"];
        }
      }),
    );
    expect(outcomes).toContainEqual(["stdio", "2024-11-05", "2024-11-05"]);
    expect(outcomes).toContainEqual(["http", "2024-11-05", "2024-11-05"]);
    expect(outcomes).toContainEqual(["legacy-sse", "2025-06-18", "reject"]);
    expect(outcomes).toContainEqual(["legacy-sse", "2024-11-05", "reject"]);
    expect(outcomes).toContainEqual(["stdio", "1999-01-01", "reject"]);
  });

  test.each([
    ["stdio", "2025-06-18", "2025-06-18"],
    ["stdio", "2024-11-05", "2024-11-05"],
    ["stdio", "1999-01-01", "reject"],
    ["http", "2025-06-18", "2025-06-18"],
    ["http", "2024-11-05", "2024-11-05"],
    ["http", "1999-01-01", "reject"],
    ["legacy-sse", "2025-06-18", "reject"],
    ["legacy-sse", "2024-11-05", "reject"],
    ["legacy-sse", "1999-01-01", "reject"],
  ] as const)("protocol fixture %s %s -> %s", (transport, serverReturns, expected) => {
    if (expected === "reject") {
      expect(() => negotiateProtocolVersion(serverReturns, transport)).toThrow();
    } else {
      expect(negotiateProtocolVersion(serverReturns, transport)).toBe(expected);
    }
  });

  test.each(["2025-06-18", "2024-11-05"] as const)(
    "Streamable HTTP accepts supported protocol %s",
    async (protocolVersion) => {
      const transport = new FakeTransport({
        initialize: { protocolVersion, capabilities: { tools: {} } },
        "tools/list": { tools: [] },
      });
      await expect(runtime(transport, httpConfig()).connect()).resolves.toMatchObject({
        tools: [],
      });
    },
  );
});

function runtime(
  transport: Transport,
  serverConfig: McpServerConfig = config(),
  overrides: Partial<McpServerRuntimeOptions> = {},
): McpServerRuntime {
  return new McpServerRuntime(serverConfig, {
    vaultRoot: "C:\\vault",
    transportFactory: () => transport,
    ...overrides,
  });
}

function config(): McpServerConfig {
  return {
    id: normalizeServerId("server"),
    name: "Server",
    enabled: true,
    trustEpoch: "epoch_test" as McpServerConfig["trustEpoch"],
    transport: "stdio",
    command: "node",
    args: [],
  };
}

function httpConfig(): McpServerConfig {
  return {
    id: normalizeServerId("server"),
    name: "Server",
    enabled: true,
    trustEpoch: "epoch_test" as McpServerConfig["trustEpoch"],
    transport: "http",
    url: "https://example.com/mcp",
  };
}

class FakeTransport implements Transport {
  onmessage?: (message: JSONRPCMessage) => void;
  onclose?: () => void;
  onerror?: (error: Error) => void;
  requests: { method: string; params: unknown }[] = [];
  notifications: string[] = [];
  sentMessages: JSONRPCMessage[] = [];
  sessionId?: string;

  constructor(
    private readonly responses: Record<string, unknown>,
    opts: {
      noResponses?: boolean;
      sessionId?: string;
    } = {},
  ) {
    this.noResponses = opts.noResponses ?? false;
    this.sessionId = opts.sessionId;
  }
  private readonly noResponses: boolean;

  async start(): Promise<void> {}

  async send(message: JSONRPCMessage): Promise<void> {
    this.sentMessages.push(message);
    const m = message as { id?: string | number; method?: string; params?: { cursor?: string } };
    if (m.id === undefined) {
      if (m.method) this.notifications.push(m.method);
      return;
    }
    this.requests.push({ method: m.method ?? "", params: m.params });
    if (this.noResponses) return;
    const key =
      m.method === "tools/list"
        ? `tools/list:${m.params?.cursor ?? ""}`
        : (m.method ?? "");
    const response = this.responses[key] ?? this.responses[m.method ?? ""];
    setTimeout(() => {
      if (response instanceof Error) {
        this.onmessage?.({
          jsonrpc: "2.0",
          id: m.id,
          error: { code: -32000, message: response.message },
        } as JSONRPCMessage);
      } else {
        this.onmessage?.({ jsonrpc: "2.0", id: m.id, result: response } as JSONRPCMessage);
      }
    }, 0);
  }

  async close(): Promise<void> {
    this.onclose?.();
  }
}

class HangingCallTransport implements Transport {
  onmessage?: (message: JSONRPCMessage) => void;
  onclose?: () => void;
  requests: { method: string; params: unknown }[] = [];
  sentMessages: JSONRPCMessage[] = [];

  async start(): Promise<void> {}

  async send(message: JSONRPCMessage): Promise<void> {
    this.sentMessages.push(message);
    const m = message as { id?: string | number; method?: string; params?: unknown };
    if (m.id === undefined) return;
    this.requests.push({ method: m.method ?? "", params: m.params });
    if (m.method === "initialize") {
      setTimeout(() => this.onmessage?.({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} } } } as JSONRPCMessage), 0);
    } else if (m.method === "tools/list") {
      setTimeout(() => this.onmessage?.({ jsonrpc: "2.0", id: m.id, result: { tools: [{ name: "echo" }] } } as JSONRPCMessage), 0);
    }
  }

  async close(): Promise<void> {
    this.onclose?.();
  }
}
