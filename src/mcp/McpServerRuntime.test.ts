import { describe, expect, test, vi } from "vitest";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { normalizeServerId } from "./McpIdentity";
import type { McpServerConfig } from "./McpTypes";
import {
  MCP_ADVERTISED_PROTOCOL_VERSION,
  MCP_INITIALIZE_TIMEOUT_MS,
  MCP_MAX_TOOL_LIST_PAGES,
  MCP_MAX_TOOLS_PER_SERVER,
  McpServerRuntime,
  negotiateProtocolVersion,
} from "./McpServerRuntime";

describe("McpServerRuntime", () => {
  test("initialize sends advertised version and empty client capabilities", async () => {
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
      capabilities: {},
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
    ["legacy-sse", "2025-06-18", "2025-06-18"],
    ["legacy-sse", "2024-11-05", "reject"],
    ["legacy-sse", "1999-01-01", "reject"],
  ] as const)("protocol fixture %s %s -> %s", (transport, serverReturns, expected) => {
    if (expected === "reject") {
      expect(() => negotiateProtocolVersion(serverReturns, transport)).toThrow();
    } else {
      expect(negotiateProtocolVersion(serverReturns, transport)).toBe(expected);
    }
  });
});

function runtime(transport: Transport): McpServerRuntime {
  return new McpServerRuntime(config(), {
    vaultRoot: "C:\\vault",
    transportFactory: () => transport,
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

class FakeTransport implements Transport {
  onmessage?: (message: JSONRPCMessage) => void;
  onclose?: () => void;
  onerror?: (error: Error) => void;
  requests: { method: string; params: unknown }[] = [];
  notifications: string[] = [];
  sessionId?: string;

  constructor(
    private readonly responses: Record<string, unknown>,
    opts: { noResponses?: boolean; sessionId?: string } = {},
  ) {
    this.noResponses = opts.noResponses ?? false;
    this.sessionId = opts.sessionId;
  }

  private readonly noResponses: boolean;

  async start(): Promise<void> {}

  async send(message: JSONRPCMessage): Promise<void> {
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
