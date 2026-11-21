import { describe, expect, test, vi } from "vitest";
import {
  CopilotAgentSession,
  classifyToolSource,
  type AgentSessionOptions,
  type SdkClient,
  type SdkModule,
  type SdkPermissionRequest,
  type SdkPermissionResult,
  type SdkSession,
  type SdkTool,
  type StreamEvent,
} from "./AgentSession";
import { denyAll } from "../domain/PermissionDecision";
import { SafetyState, formatMcpGrantKey } from "../domain/SafetyPolicy";
import { normalizeServerId } from "../mcp/McpIdentity";
import { McpManager } from "../mcp/McpManager";
import { formatSyntheticId } from "../mcp/McpToolIdentity";
import type { McpServerConfig, McpServerId, McpTrustEpoch } from "../mcp/McpTypes";

const mcpServerId = "server-a" as McpServerId;
const mcpEpoch1 = "epoch_1" as McpTrustEpoch;
const mcpEpoch2 = "epoch_2" as McpTrustEpoch;

interface FakeHandles {
  sdk: SdkModule;
  client: SdkClient;
  session: SdkSession;
  /** Capture last createSession options so tests can inspect availableTools, model, etc. */
  lastCreateSession: { model?: string; availableTools?: unknown };
  /** Captured onPermissionRequest handler from createSession. */
  permissionHandler:
    | ((
        r: SdkPermissionRequest,
      ) => Promise<SdkPermissionResult> | SdkPermissionResult)
    | null;
  startCalls: number;
  pingCalls: number;
  stopCalls: number;
  forceStopCalls: number;
  disconnectCalls: number;
  abortCalls: number;
  sendCalls: string[];
  /** v0.4 Phase 3: setModel call log (each entry is the new model id). */
  setModelCalls: string[];
  /** Override setModel to throw / behave abnormally. */
  setModelImpl: ((id: string) => Promise<void> | void) | null;
  /** Override what sendAndWait returns. */
  setSendResponse: (resp: unknown) => void;
  /** Override what listModels returns. */
  setModels: (models: Array<{ id: string; policy?: { state?: string } }>) => void;
}

function makeFakeSdk(): FakeHandles {
  const handles: FakeHandles = {
    // Filled in below.
    sdk: undefined as unknown as SdkModule,
    client: undefined as unknown as SdkClient,
    session: undefined as unknown as SdkSession,
    lastCreateSession: {},
    permissionHandler: null,
    startCalls: 0,
    pingCalls: 0,
    stopCalls: 0,
    forceStopCalls: 0,
    disconnectCalls: 0,
    abortCalls: 0,
    sendCalls: [],
    setModelCalls: [],
    setModelImpl: null,
    setSendResponse: () => {},
    setModels: () => {},
  };

  let sendResponse: unknown = "ok";
  handles.setSendResponse = (r) => {
    sendResponse = r;
  };
  let models: Array<{ id: string; policy?: { state?: string } }> = [
    { id: "gpt-4.1" },
    { id: "gpt-4o" },
  ];
  handles.setModels = (m) => {
    models = m;
  };

  const session: SdkSession = {
    sendAndWait: async (prompt: string) => {
      handles.sendCalls.push(prompt);
      return sendResponse;
    },
    abort: () => {
      handles.abortCalls += 1;
    },
    disconnect: async () => {
      handles.disconnectCalls += 1;
    },
    setModel: async (id: string) => {
      handles.setModelCalls.push(id);
      if (handles.setModelImpl) {
        await handles.setModelImpl(id);
      }
    },
  };

  const client: SdkClient = {
    start: async () => {
      handles.startCalls += 1;
    },
    ping: async () => {
      handles.pingCalls += 1;
    },
    listModels: async () => models,
    createSession: async (opts) => {
      handles.lastCreateSession = {
        model: opts.model,
        availableTools: opts.availableTools,
      };
      handles.permissionHandler = opts.onPermissionRequest;
      return session;
    },
    stop: async () => {
      handles.stopCalls += 1;
      return [];
    },
    forceStop: async () => {
      handles.forceStopCalls += 1;
    },
  };

  const sdk: SdkModule = {
    CopilotClient: function (this: unknown) {
      return client;
    } as unknown as SdkModule["CopilotClient"],
  };

  handles.sdk = sdk;
  handles.client = client;
  handles.session = session;
  return handles;
}

function makeAgent(
  handles: FakeHandles,
  decider = denyAll,
  extraOpts: {
    preamble?: () => string | null;
    catalog?: import("./ModelCatalog").ModelCatalog;
    resumeSessionId?: string | null;
    onSessionOpened?: AgentSessionOptions["onSessionOpened"];
  } = {},
) {
  return new CopilotAgentSession(
    {
      cliPath: "/fake/copilot.exe",
      gitHubToken: "fake-token",
      baseDirectory: "/fake/plugin",
      decider,
      preamble: extraOpts.preamble,
      catalog: extraOpts.catalog,
      resumeSessionId: extraOpts.resumeSessionId,
      onSessionOpened: extraOpts.onSessionOpened,
    },
    async () => handles.sdk,
  );
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function attachStreamingHandlers(handles: FakeHandles) {
  const handlers: {
    delta?: (event: {
      type: "assistant.message_delta";
      data: { deltaContent: string };
    }) => void;
    toolStart?: (event: {
      type: "tool.execution_start";
      data: {
        toolCallId: string;
        toolName: string;
        arguments?: Record<string, unknown>;
        mcpServerName?: string;
      };
    }) => void;
    toolComplete?: (event: {
      type: "tool.execution_complete";
      data: {
        toolCallId: string;
        success: boolean;
        result?: { content?: string; detailedContent?: string };
        error?: { code?: string; message: string };
      };
    }) => void;
  } = {};
  handles.session.on = (eventType, handler) => {
    if (eventType === "assistant.message_delta") {
      handlers.delta = handler as typeof handlers.delta;
      return () => {
        handlers.delta = undefined;
      };
    }
    if (eventType === "tool.execution_start") {
      handlers.toolStart = handler as typeof handlers.toolStart;
      return () => {
        handlers.toolStart = undefined;
      };
    }
    if (eventType === "tool.execution_complete") {
      handlers.toolComplete = handler as typeof handlers.toolComplete;
      return () => {
        handlers.toolComplete = undefined;
      };
    }
    return () => {};
  };
  return handlers;
}

function mcpTestServer(id: string): McpServerConfig {
  return {
    id: normalizeServerId(id),
    name: id,
    enabled: true,
    trustEpoch: "epoch_test" as McpTrustEpoch,
    transport: "stdio",
    command: "node",
    args: [],
  };
}

function makeMcpLifecycleManager(
  agents: Array<{
    cancelPendingMcpApprovalsForServer: (serverId: string, reason?: string) => void;
    cancelMcpCallsForServer: (serverId: string, reason?: string) => void;
  }>,
  reason: () => string,
) {
  const serverX = mcpTestServer("server-x");
  const serverY = mcpTestServer("server-y");
  const manager = new McpManager({
    vaultRoot: "C:\\vault",
    serversProvider: () => [serverX, serverY],
    runtimeFactory: (config) =>
      ({
        connect: vi.fn(async () => ({ serverId: config.id, tools: [] })),
        snapshot: () => ({ id: config.id, status: "connected" }),
        disable: vi.fn(async () => undefined),
        unload: vi.fn(async () => undefined),
        callTool: vi.fn(async () => {
          throw new Error("server disconnected");
        }),
      }) as never,
    settleTrackedCalls: async (serverId) => {
      for (const agent of agents) {
        agent.cancelPendingMcpApprovalsForServer(serverId, reason());
        agent.cancelMcpCallsForServer(serverId, reason());
      }
    },
  });
  return { manager, serverX: serverX.id, serverY: serverY.id };
}

describe("CopilotAgentSession", () => {
  test("init() starts client, pings, and creates a session with builtin tools exposed", async () => {
    const h = makeFakeSdk();
    const agent = makeAgent(h);
    await agent.init();

    expect(h.startCalls).toBe(1);
    expect(h.pingCalls).toBe(1);
    expect(h.lastCreateSession.model).toBe("gpt-4.1");
    expect(h.lastCreateSession.availableTools).toEqual([
      "builtin:*",
      "custom:*",
      "mcp:*",
    ]);
    expect(h.permissionHandler).toBeTypeOf("function");
    expect(agent.getModel()).toBe("gpt-4.1");

    await agent.dispose();
  });

  test("MCP synthetic custom tools are handed to SDK session boundaries", async () => {
    const h = makeFakeSdk();
    let capturedTools: unknown;
    h.client.createSession = async (opts) => {
      capturedTools = opts.tools;
      h.permissionHandler = opts.onPermissionRequest;
      return h.session;
    };
    const agent = new CopilotAgentSession(
      {
        cliPath: "/fake/copilot.exe",
        gitHubToken: "fake-token",
        baseDirectory: "/fake/plugin",
        decider: denyAll,
        tools: [{ name: "read_file" }],
        mcpTools: () => [{ name: formatSyntheticId(mcpServerId, "read__File") }],
      },
      async () => h.sdk,
    );
    await agent.init();
    expect((capturedTools as Array<{ name: string }>).map((t) => t.name)).toEqual([
      "read_file",
      "mcp__server-a__read__File",
    ]);
    await agent.dispose();
  });

  test("init() is idempotent — concurrent callers share the same promise", async () => {
    const h = makeFakeSdk();
    const agent = makeAgent(h);
    await Promise.all([agent.init(), agent.init(), agent.init()]);
    expect(h.startCalls).toBe(1);
    await agent.dispose();
  });

  test("init() failure is recoverable on retry", async () => {
    const h = makeFakeSdk();
    h.client.start = async () => {
      throw new Error("boom");
    };
    const agent = makeAgent(h);
    await expect(agent.init()).rejects.toThrow("boom");
    // Replace start with a working one and retry.
    h.client.start = async () => {
      h.startCalls += 1;
    };
    await expect(agent.init()).resolves.toBeUndefined();
    await agent.dispose();
  });

  test("pickModel prefers gpt-4.1 → gpt-4o → gpt-* → first available", async () => {
    const h = makeFakeSdk();
    h.setModels([
      { id: "claude-something" },
      { id: "gpt-3.5-turbo" },
      { id: "gpt-4o" },
    ]);
    const agent = makeAgent(h);
    await agent.init();
    expect(agent.getModel()).toBe("gpt-4o");
    await agent.dispose();
  });

  test("pickModel filters disabled models when at least one is enabled", async () => {
    const h = makeFakeSdk();
    h.setModels([
      { id: "gpt-4.1", policy: { state: "disabled" } },
      { id: "gpt-4o", policy: { state: "enabled" } },
    ]);
    const agent = makeAgent(h);
    await agent.init();
    expect(agent.getModel()).toBe("gpt-4o");
    await agent.dispose();
  });

  // v0.4 (model-picker) Phase 2: pure heuristic resolver + catalog
  // injection. The resolver matches v0.3 ordering verbatim — these
  // tests pin that contract so phases 3-5 can build on it.
  test("resolveHeuristicModelId preserves the gpt-4.1 → gpt-4o → gpt-* → first ordering", async () => {
    const { resolveHeuristicModelId } = await import("./AgentSession");
    expect(
      resolveHeuristicModelId([
        { id: "claude-3-5-sonnet" },
        { id: "gpt-4.1" },
        { id: "gpt-4o" },
      ]),
    ).toBe("gpt-4.1");
    expect(
      resolveHeuristicModelId([{ id: "claude-3-5-sonnet" }, { id: "gpt-4o" }]),
    ).toBe("gpt-4o");
    expect(
      resolveHeuristicModelId([
        { id: "claude-3-5-sonnet" },
        { id: "gpt-3.5-turbo" },
      ]),
    ).toBe("gpt-3.5-turbo"); // first gpt-* wins
    expect(resolveHeuristicModelId([{ id: "claude-3-5-sonnet" }])).toBe(
      "claude-3-5-sonnet",
    );
  });

  test("resolveHeuristicModelId returns null on empty / id-less input", async () => {
    const { resolveHeuristicModelId } = await import("./AgentSession");
    expect(resolveHeuristicModelId([])).toBeNull();
    expect(resolveHeuristicModelId([{}])).toBeNull();
  });

  test("resolveHeuristicModelId falls back to all records when every record is disabled", async () => {
    const { resolveHeuristicModelId } = await import("./AgentSession");
    expect(
      resolveHeuristicModelId([
        { id: "gpt-4.1", policy: { state: "disabled" } },
        { id: "gpt-4o", policy: { state: "disabled" } },
      ]),
    ).toBe("gpt-4.1");
  });

  test("doInit uses the catalog's cached chatModels when ready (no listModels call)", async () => {
    const h = makeFakeSdk();
    h.setModels([{ id: "gpt-4.1" }, { id: "claude-3-5-sonnet" }]);
    // Track listModels invocations on the per-session client. The
    // catalog uses its OWN client (separate from the per-session
    // client) so we can pin "agent's client.listModels never runs".
    let perSessionListModelsCalls = 0;
    const originalListModels = h.client.listModels!;
    (h.client as { listModels: typeof originalListModels }).listModels =
      async () => {
        perSessionListModelsCalls++;
        return originalListModels();
      };

    const { ModelCatalog } = await import("./ModelCatalog");
    const catalogClient = {
      createSession: () => Promise.reject(new Error("unused")),
      listModels: async () => [{ id: "gpt-4o" }, { id: "gpt-4.1" }],
    } as unknown as SdkClient;
    const catalog = new ModelCatalog(() => catalogClient);
    await catalog.refresh();
    expect(catalog.getState().kind).toBe("ready");

    const agent = makeAgent(h, denyAll, { catalog });
    await agent.init();
    // Catalog's chatModels = [gpt-4o, gpt-4.1] → resolver picks gpt-4.1.
    expect(agent.getModel()).toBe("gpt-4.1");
    expect(perSessionListModelsCalls).toBe(0);
    await agent.dispose();
  });

  test("doInit falls back to client.listModels when catalog is in error state", async () => {
    const h = makeFakeSdk();
    h.setModels([{ id: "gpt-4o" }]);
    const { ModelCatalog } = await import("./ModelCatalog");
    const catalog = new ModelCatalog(() =>
      ({
        createSession: () => Promise.reject(new Error("x")),
        listModels: async () => {
          throw new Error("catalog down");
        },
      }) as unknown as SdkClient,
    );
    await catalog.refresh();
    expect(catalog.getState().kind).toBe("error");

    const agent = makeAgent(h, denyAll, { catalog });
    await agent.init();
    // Falls back to per-session listModels → gpt-4o.
    expect(agent.getModel()).toBe("gpt-4o");
    await agent.dispose();
  });

  test("sendMessage forwards prompt and returns extracted text", async () => {
    const h = makeFakeSdk();
    h.setSendResponse({ data: { content: "world" } });
    const agent = makeAgent(h);
    const reply = await agent.sendMessage("hello");
    expect(h.sendCalls).toEqual(["hello"]);
    expect(reply.content).toBe("world");
    expect(reply.toolCalls).toEqual([]);
    await agent.dispose();
  });

  test("permission handler runs the decider and returns reject with feedback", async () => {
    const h = makeFakeSdk();
    const agent = makeAgent(h);
    await agent.init();

    const result = await h.permissionHandler!({
      id: "tc1",
      kind: "shell",
      toolName: "shell",
    });

    expect(result.kind).toBe("reject");
    if (result.kind === "reject") {
      expect(result.feedback).toMatch(/Tool execution is disabled/);
      expect(result.feedback).toMatch(/shell/);
    }
    await agent.dispose();
  });

  test("denied tool calls during a turn are surfaced on the response", async () => {
    const h = makeFakeSdk();
    h.setSendResponse({ content: "I cannot do that" });
    const agent = makeAgent(h);
    await agent.init();

    // Original sendAndWait fires the permission handler mid-turn.
    const originalSend = h.session.sendAndWait;
    h.session.sendAndWait = async (prompt: string) => {
      await h.permissionHandler!({
        id: "tc1",
        kind: "shell",
        toolName: "ls",
      });
      return originalSend.call(h.session, prompt);
    };

    const reply = await agent.sendMessage("run ls");
    expect(reply.content).toBe("I cannot do that");
    expect(reply.toolCalls).toHaveLength(1);
    expect(reply.toolCalls[0]).toMatchObject({
      id: "tc1",
      kind: "shell",
      name: "ls",
      outcome: "denied",
    });
    await agent.dispose();
  });

  test("custom decider can approve once", async () => {
    const h = makeFakeSdk();
    const agent = makeAgent(h, () => ({ kind: "approve-once" }));
    await agent.init();
    const result = await h.permissionHandler!({
      kind: "shell",
      toolName: "echo",
    });
    expect(result.kind).toBe("approve-once");
    await agent.dispose();
  });

  test("dispose disconnects session and stops client", async () => {
    const h = makeFakeSdk();
    const agent = makeAgent(h);
    await agent.init();
    await agent.dispose();
    expect(h.disconnectCalls).toBe(1);
    expect(h.stopCalls).toBe(1);
  });

  test("dispose is idempotent and second call is a no-op", async () => {
    const h = makeFakeSdk();
    const agent = makeAgent(h);
    await agent.init();
    await agent.dispose();
    await agent.dispose();
    expect(h.stopCalls).toBe(1);
  });

  test("dispose force-stops if client.stop hangs", async () => {
    const h = makeFakeSdk();
    h.client.stop = () => new Promise(() => {}); // never resolves
    const agent = makeAgent(h);
    await agent.init();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await agent.dispose();
    expect(h.forceStopCalls).toBe(1);
    warn.mockRestore();
  }, 10_000);

  test("sendMessage after dispose rejects", async () => {
    const h = makeFakeSdk();
    const agent = makeAgent(h);
    await agent.init();
    await agent.dispose();
    await expect(agent.sendMessage("hi")).rejects.toThrow(/disposed/);
  });

  test("dispose while init is in flight stops the runtime instead of leaking", async () => {
    const h = makeFakeSdk();
    // Make ping() take ~50ms so dispose() can run mid-init.
    h.client.ping = async () => {
      h.pingCalls += 1;
      await new Promise((r) => setTimeout(r, 50));
    };
    const agent = makeAgent(h);
    const initP = agent.init();
    // Let init proceed past sdkLoader + start() + into the await on ping().
    await new Promise((r) => setTimeout(r, 10));
    const disposeP = agent.dispose();
    const results = await Promise.allSettled([initP, disposeP]);
    expect(results[1].status).toBe("fulfilled"); // dispose succeeded
    // init either rejected (bailIfDisposed) or fulfilled (slipped through);
    // either way the client must have been stopped at least once.
    expect(h.stopCalls).toBeGreaterThanOrEqual(1);
  });

  test("resetConversation swaps SDK session without restarting the client", async () => {
    const h = makeFakeSdk();
    const agent = makeAgent(h);
    await agent.init();
    expect(h.startCalls).toBe(1);

    // Spy on createSession count by wrapping.
    const before = h.disconnectCalls;
    await agent.resetConversation();

    // Old session disconnected; client.start was NOT called again.
    expect(h.disconnectCalls).toBe(before + 1);
    expect(h.startCalls).toBe(1);

    // Send still works on the new session.
    h.setSendResponse("ok");
    const reply = await agent.sendMessage("hi");
    expect(reply.content).toBe("ok");
    await agent.dispose();
  });

  test("createSession is called with streaming:true", async () => {
    const h = makeFakeSdk();
    let lastStreaming: unknown;
    const originalCreate = h.client.createSession;
    h.client.createSession = async (opts) => {
      lastStreaming = (opts as unknown as { streaming?: boolean }).streaming;
      return originalCreate.call(h.client, opts);
    };
    const agent = makeAgent(h);
    await agent.init();
    expect(lastStreaming).toBe(true);
    await agent.dispose();
  });

  test("sendMessageStreaming yields deltas in order then a terminal complete", async () => {
    const h = makeFakeSdk();
    // Capture the delta handler the agent installs, plus defer sendAndWait
    // so we can interleave delta emission and resolution.
    let deltaHandler:
      | ((event: { type: "assistant.message_delta"; data: { deltaContent: string } }) => void)
      | null = null;
    h.session.on = (eventType, handler) => {
      // Phase 5 subscribes to assistant.message_delta plus the two
      // tool.execution_* events; only capture the delta handler here.
      if (eventType === "assistant.message_delta") {
        deltaHandler = handler as typeof deltaHandler;
        return () => {
          deltaHandler = null;
        };
      }
      return () => {};
    };
    let resolveSend!: (resp: unknown) => void;
    h.session.sendAndWait = (prompt) => {
      h.sendCalls.push(prompt);
      return new Promise((resolve) => {
        resolveSend = resolve;
      });
    };

    const agent = makeAgent(h);
    await agent.init();

    const iter = agent.sendMessageStreaming("hi")[Symbol.asyncIterator]();
    // Kick the generator so it subscribes to `on` before we emit deltas.
    const firstP = iter.next();
    await new Promise((r) => setTimeout(r, 0));

    deltaHandler!({ type: "assistant.message_delta", data: { deltaContent: "Hel" } });
    deltaHandler!({ type: "assistant.message_delta", data: { deltaContent: "lo" } });

    const first = await firstP;
    expect(first.value).toEqual({ type: "delta", text: "Hel" });
    const second = await iter.next();
    expect(second.value).toEqual({ type: "delta", text: "lo" });

    resolveSend({ data: { content: "Hello world" } });
    const third = await iter.next();
    expect(third.value).toEqual({
      type: "complete",
      content: "Hello world",
      toolCalls: [],
    });
    const fourth = await iter.next();
    expect(fourth.done).toBe(true);

    // Handler was unsubscribed on completion.
    expect(deltaHandler).toBeNull();

    await agent.dispose();
  });

  test("cancelCurrent during streaming aborts the SDK session and ends the stream cleanly", async () => {
    const h = makeFakeSdk();
    let deltaHandler:
      | ((event: { type: "assistant.message_delta"; data: { deltaContent: string } }) => void)
      | null = null;
    h.session.on = (eventType, handler) => {
      if (eventType === "assistant.message_delta") {
        deltaHandler = handler as typeof deltaHandler;
        return () => {
          deltaHandler = null;
        };
      }
      return () => {};
    };
    let rejectSend!: (err: unknown) => void;
    h.session.sendAndWait = (prompt) => {
      h.sendCalls.push(prompt);
      return new Promise((_resolve, reject) => {
        rejectSend = reject;
      });
    };
    h.session.abort = async () => {
      h.abortCalls += 1;
      // Realistic SDK behaviour: pending sendAndWait rejects after abort.
      rejectSend(new Error("AbortError: cancelled by user"));
    };

    const agent = makeAgent(h);
    await agent.init();

    const iter = agent.sendMessageStreaming("write a long story")[Symbol.asyncIterator]();
    const firstP = iter.next();
    await new Promise((r) => setTimeout(r, 0));
    deltaHandler!({ type: "assistant.message_delta", data: { deltaContent: "Once " } });
    const first = await firstP;
    expect(first.value).toEqual({ type: "delta", text: "Once " });

    await agent.cancelCurrent();
    expect(h.abortCalls).toBe(1);

    // After cancel, the iterator emits a terminal complete with whatever
    // final content the SDK provided (empty here) and toolCalls, then ends.
    const second = await iter.next();
    expect(second.value).toEqual({ type: "complete", content: "", toolCalls: [] });
    const done = await iter.next();
    expect(done.done).toBe(true);

    await agent.dispose();
  });

  test("sendMessageStreaming propagates non-abort errors", async () => {
    const h = makeFakeSdk();
    h.session.on = () => () => {};
    h.session.sendAndWait = async () => {
      throw new Error("model exploded");
    };

    const agent = makeAgent(h);
    await agent.init();

    const iter = agent.sendMessageStreaming("hi")[Symbol.asyncIterator]();
    await expect(iter.next()).rejects.toThrow(/model exploded/);
    await agent.dispose();
  });

  test("early iterator close aborts the in-flight SDK turn", async () => {
    const h = makeFakeSdk();
    let deltaHandler:
      | ((event: { type: "assistant.message_delta"; data: { deltaContent: string } }) => void)
      | null = null;
    let unsubCalls = 0;
    h.session.on = (eventType, handler) => {
      if (eventType === "assistant.message_delta") {
        deltaHandler = handler as typeof deltaHandler;
      }
      return () => {
        unsubCalls += 1;
        if (eventType === "assistant.message_delta") {
          deltaHandler = null;
        }
      };
    };
    let rejectSend!: (err: unknown) => void;
    h.session.sendAndWait = (prompt) => {
      h.sendCalls.push(prompt);
      return new Promise((_resolve, reject) => {
        rejectSend = reject;
      });
    };
    let abortCalls = 0;
    h.session.abort = async () => {
      abortCalls += 1;
      rejectSend(new Error("AbortError"));
    };

    const agent = makeAgent(h);
    await agent.init();

    const iter = agent.sendMessageStreaming("write a long story")[Symbol.asyncIterator]();
    const firstP = iter.next();
    await new Promise((r) => setTimeout(r, 0));
    deltaHandler!({ type: "assistant.message_delta", data: { deltaContent: "Once " } });
    await firstP;

    // Consumer closes the iterator early before the turn completes.
    const ret = await iter.return!();
    expect(ret.done).toBe(true);
    // Generator's finally must have aborted the SDK turn and
    // unsubscribed each event subscription exactly once: delta,
    // tool.start, tool.complete, user.message, assistant.message,
    // session.idle and session.error.
    expect(abortCalls).toBe(1);
    expect(unsubCalls).toBe(7);

    await agent.dispose();
  });

  test("tool.execution_start + tool.execution_complete events flow into stream and toolCalls", async () => {
    const h = makeFakeSdk();
    type ToolStartHandler = (event: {
      type: "tool.execution_start";
      data: {
        toolCallId: string;
        toolName: string;
        arguments?: Record<string, unknown>;
        mcpServerName?: string;
      };
    }) => void;
    type ToolCompleteHandler = (event: {
      type: "tool.execution_complete";
      data: {
        toolCallId: string;
        success: boolean;
        result?: { content?: string };
        error?: { message: string };
      };
    }) => void;
    let toolStart: ToolStartHandler | null = null;
    let toolComplete: ToolCompleteHandler | null = null;
    h.session.on = (eventType, handler) => {
      if (eventType === "tool.execution_start")
        toolStart = handler as ToolStartHandler;
      if (eventType === "tool.execution_complete")
        toolComplete = handler as ToolCompleteHandler;
      return () => {};
    };
    let resolveSend!: (resp: unknown) => void;
    h.session.sendAndWait = (prompt) => {
      h.sendCalls.push(prompt);
      return new Promise((resolve) => {
        resolveSend = resolve;
      });
    };

    const agent = new CopilotAgentSession(
      {
        cliPath: "/fake/copilot.exe",
        gitHubToken: "fake-token",
        baseDirectory: "/fake/plugin",
        decider: denyAll,
        tools: [{ name: "read_file" }],
      },
      async () => h.sdk,
    );
    await agent.init();

    const iter = agent
      .sendMessageStreaming("read inbox/today.md")
      [Symbol.asyncIterator]();
    const firstP = iter.next();
    await new Promise((r) => setTimeout(r, 0));

    toolStart!({
      type: "tool.execution_start",
      data: {
        toolCallId: "call-1",
        toolName: "read_file",
        arguments: { path: "inbox/today.md" },
      },
    });
    toolComplete!({
      type: "tool.execution_complete",
      data: {
        toolCallId: "call-1",
        success: true,
        result: { content: "# Today\n\nphase 5 ships" },
      },
    });

    const first = await firstP;
    expect(first.value).toMatchObject({
      type: "tool_call_start",
      toolCall: { id: "call-1", name: "read_file", source: "custom" },
    });
    const second = await iter.next();
    expect(second.value).toMatchObject({
      type: "tool_call_complete",
      id: "call-1",
      outcome: "completed",
      content: "# Today\n\nphase 5 ships",
    });

    resolveSend({ data: { content: "Your note says: phase 5 ships" } });
    const third = await iter.next();
    expect(third.value).toMatchObject({
      type: "complete",
      content: "Your note says: phase 5 ships",
    });
    // The terminal complete carries the consolidated toolCalls snapshot
    // with the completed outcome.
    const complete = third.value as {
      type: "complete";
      toolCalls: Array<{
        id: string;
        outcome: string;
        source?: string;
        resultContent?: string;
      }>;
    };
    expect(complete.toolCalls).toHaveLength(1);
    expect(complete.toolCalls[0]).toMatchObject({
      id: "call-1",
      outcome: "completed",
      source: "custom",
    });

    await agent.dispose();
  });

  test("Phase 8: MCP tool result starting with 'Error: MCP ...' sentinel is reclassified to errored", async () => {
    // McpToolBridge (Phase 8) returns MCP tool-execution errors as
    // tool-result content so the message reaches chat even when the SDK
    // error pipeline drops it. The SDK marks such calls success:true,
    // which would paint a green completed pill on a call that actually
    // failed. AgentSession detects the sentinel prefix and re-classifies
    // the outcome to "errored" with the content moved into the error slot
    // so the chat renders a red pill and an "Error" body section.
    const h = makeFakeSdk();
    type ToolStartHandler = (event: {
      type: "tool.execution_start";
      data: {
        toolCallId: string;
        toolName: string;
        arguments?: Record<string, unknown>;
        mcpServerName?: string;
      };
    }) => void;
    type ToolCompleteHandler = (event: {
      type: "tool.execution_complete";
      data: {
        toolCallId: string;
        success: boolean;
        result?: { content?: string };
        error?: { message: string };
      };
    }) => void;
    let toolStart: ToolStartHandler | null = null;
    let toolComplete: ToolCompleteHandler | null = null;
    h.session.on = (eventType, handler) => {
      if (eventType === "tool.execution_start")
        toolStart = handler as ToolStartHandler;
      if (eventType === "tool.execution_complete")
        toolComplete = handler as ToolCompleteHandler;
      return () => {};
    };
    let resolveSend!: (resp: unknown) => void;
    h.session.sendAndWait = (prompt) => {
      h.sendCalls.push(prompt);
      return new Promise((resolve) => {
        resolveSend = resolve;
      });
    };

    const agent = new CopilotAgentSession(
      {
        cliPath: "/fake/copilot.exe",
        gitHubToken: "fake-token",
        baseDirectory: "/fake/plugin",
        decider: denyAll,
        tools: [{ name: "read_file" }],
      },
      async () => h.sdk,
    );
    await agent.init();

    const iter = agent
      .sendMessageStreaming("call mcp tool that will error")
      [Symbol.asyncIterator]();
    const firstP = iter.next();
    await new Promise((r) => setTimeout(r, 0));

    toolStart!({
      type: "tool.execution_start",
      data: {
        toolCallId: "call-err",
        toolName: formatSyntheticId(mcpServerId, "search"),
        mcpServerName: "agency-mail",
        arguments: { q: "bad" },
      },
    });
    // Simulate McpToolBridge returning an isError result as content.
    toolComplete!({
      type: "tool.execution_complete",
      data: {
        toolCallId: "call-err",
        success: true,
        result: { content: "Error: MCP tool reported error: Graph rejected NotARealField" },
      },
    });

    // First yields the start; second yields the complete after reclass.
    await firstP;
    const second = await iter.next();
    expect(second.value).toMatchObject({
      type: "tool_call_complete",
      id: "call-err",
      outcome: "errored",
      content: undefined,
      errorMessage: "Error: MCP tool reported error: Graph rejected NotARealField",
    });

    resolveSend({ data: { content: "ok" } });
    await iter.next();
    await agent.dispose();
  });

  test("Phase 8: non-MCP tool with content starting 'Error:' is NOT reclassified", async () => {
    // The reclassification only fires when source === "mcp" AND the
    // content matches the exact McpToolBridge sentinel prefixes. A
    // custom tool that legitimately returns text starting with "Error:"
    // must stay classified as completed.
    const h = makeFakeSdk();
    type ToolStartHandler = (event: {
      type: "tool.execution_start";
      data: { toolCallId: string; toolName: string; arguments?: Record<string, unknown> };
    }) => void;
    type ToolCompleteHandler = (event: {
      type: "tool.execution_complete";
      data: { toolCallId: string; success: boolean; result?: { content?: string } };
    }) => void;
    let toolStart: ToolStartHandler | null = null;
    let toolComplete: ToolCompleteHandler | null = null;
    h.session.on = (eventType, handler) => {
      if (eventType === "tool.execution_start")
        toolStart = handler as ToolStartHandler;
      if (eventType === "tool.execution_complete")
        toolComplete = handler as ToolCompleteHandler;
      return () => {};
    };
    let resolveSend!: (resp: unknown) => void;
    h.session.sendAndWait = (prompt) => {
      h.sendCalls.push(prompt);
      return new Promise((resolve) => {
        resolveSend = resolve;
      });
    };
    const agent = new CopilotAgentSession(
      {
        cliPath: "/fake/copilot.exe",
        gitHubToken: "fake-token",
        baseDirectory: "/fake/plugin",
        decider: denyAll,
        tools: [{ name: "read_file" }],
      },
      async () => h.sdk,
    );
    await agent.init();
    const iter = agent.sendMessageStreaming("read")[Symbol.asyncIterator]();
    const firstP = iter.next();
    await new Promise((r) => setTimeout(r, 0));
    toolStart!({
      type: "tool.execution_start",
      data: { toolCallId: "call-2", toolName: "read_file", arguments: { path: "notes.md" } },
    });
    toolComplete!({
      type: "tool.execution_complete",
      data: {
        toolCallId: "call-2",
        success: true,
        result: { content: "Error: file not found (this is legitimate content)" },
      },
    });
    await firstP;
    const second = await iter.next();
    expect(second.value).toMatchObject({
      type: "tool_call_complete",
      id: "call-2",
      outcome: "completed",
      content: "Error: file not found (this is legitimate content)",
    });
    resolveSend({ data: { content: "done" } });
    await iter.next();
    await agent.dispose();
  });

  test("Phase 9: init awaits mcpReadinessGate before creating SDK session", async () => {
    // The plugin passes McpManager.waitUntilEnabledReady() as this
    // callback so stdio MCP servers finish spawning before the tool
    // snapshot is frozen into the SDK session.
    const h = makeFakeSdk();
    let resolveGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      resolveGate = resolve;
    });
    let gateAwaitedBeforeCreateSession = false;
    let sessionCreated = false;
    const originalCreateSession = h.client.createSession;
    h.client.createSession = async (opts) => {
      sessionCreated = true;
      return originalCreateSession(opts);
    };
    const agent = new CopilotAgentSession(
      {
        cliPath: "/fake/copilot.exe",
        gitHubToken: "fake-token",
        baseDirectory: "/fake/plugin",
        decider: denyAll,
        tools: [{ name: "read_file" }],
        mcpReadinessGate: async () => {
          gateAwaitedBeforeCreateSession = !sessionCreated;
          await gate;
        },
      },
      async () => h.sdk,
    );
    const initP = agent.init();
    // Yield the event loop so init() reaches the gate. createSession
    // must not have fired yet.
    await new Promise((r) => setTimeout(r, 20));
    expect(sessionCreated).toBe(false);
    resolveGate();
    await initP;
    expect(sessionCreated).toBe(true);
    expect(gateAwaitedBeforeCreateSession).toBe(true);
    await agent.dispose();
  });

  test("Phase 9: mcpReadinessGate that throws does NOT wedge init", async () => {
    // The gate should be best-effort: a broken gate must not block
    // session creation forever.
    const h = makeFakeSdk();
    const agent = new CopilotAgentSession(
      {
        cliPath: "/fake/copilot.exe",
        gitHubToken: "fake-token",
        baseDirectory: "/fake/plugin",
        decider: denyAll,
        tools: [{ name: "read_file" }],
        mcpReadinessGate: async () => {
          throw new Error("gate crashed");
        },
      },
      async () => h.sdk,
    );
    await expect(agent.init()).resolves.toBeUndefined();
    await agent.dispose();
  });

  test("MCP Readiness UX Phase 2: onReadinessGateEvent fires start then resolved once per init", async () => {
    const h = makeFakeSdk();
    let resolveGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      resolveGate = resolve;
    });
    const events: Array<"start" | "resolved"> = [];
    const agent = new CopilotAgentSession(
      {
        cliPath: "/fake/copilot.exe",
        gitHubToken: "fake-token",
        baseDirectory: "/fake/plugin",
        decider: denyAll,
        tools: [{ name: "read_file" }],
        mcpReadinessGate: () => gate,
        onReadinessGateEvent: (kind) => events.push(kind),
      },
      async () => h.sdk,
    );
    const initP = agent.init();
    // Yield so the gate is awaited and `start` fires.
    await new Promise((r) => setTimeout(r, 10));
    expect(events).toEqual(["start"]);
    expect(agent.isReadinessGateWaiting()).toBe(true);
    resolveGate();
    await initP;
    expect(events).toEqual(["start", "resolved"]);
    expect(agent.isReadinessGateWaiting()).toBe(false);
    await agent.dispose();
  });

  test("MCP Readiness UX Phase 2: onReadinessGateEvent always emits resolved even when gate throws", async () => {
    const h = makeFakeSdk();
    const events: Array<"start" | "resolved"> = [];
    const agent = new CopilotAgentSession(
      {
        cliPath: "/fake/copilot.exe",
        gitHubToken: "fake-token",
        baseDirectory: "/fake/plugin",
        decider: denyAll,
        tools: [{ name: "read_file" }],
        mcpReadinessGate: async () => {
          throw new Error("gate crashed");
        },
        onReadinessGateEvent: (kind) => events.push(kind),
      },
      async () => h.sdk,
    );
    await agent.init();
    expect(events).toEqual(["start", "resolved"]);
    expect(agent.isReadinessGateWaiting()).toBe(false);
    await agent.dispose();
  });

  test("MCP Readiness UX Phase 2: isReadinessGateWaiting is false before init and after dispose", async () => {
    const h = makeFakeSdk();
    const agent = new CopilotAgentSession(
      {
        cliPath: "/fake/copilot.exe",
        gitHubToken: "fake-token",
        baseDirectory: "/fake/plugin",
        decider: denyAll,
        tools: [{ name: "read_file" }],
        mcpReadinessGate: async () => undefined,
      },
      async () => h.sdk,
    );
    expect(agent.isReadinessGateWaiting()).toBe(false);
    await agent.init();
    expect(agent.isReadinessGateWaiting()).toBe(false);
    await agent.dispose();
    expect(agent.isReadinessGateWaiting()).toBe(false);
  });

  test("MCP Readiness UX Phase 2: onReadinessGateEvent listener that throws does not wedge gate", async () => {
    // Regression: a bad listener must not stall the gate. The
    // internal emit helper swallows listener throws.
    const h = makeFakeSdk();
    const agent = new CopilotAgentSession(
      {
        cliPath: "/fake/copilot.exe",
        gitHubToken: "fake-token",
        baseDirectory: "/fake/plugin",
        decider: denyAll,
        tools: [{ name: "read_file" }],
        mcpReadinessGate: async () => undefined,
        onReadinessGateEvent: () => {
          throw new Error("bad listener");
        },
      },
      async () => h.sdk,
    );
    await expect(agent.init()).resolves.toBeUndefined();
    expect(agent.isReadinessGateWaiting()).toBe(false);
    await agent.dispose();
  });

  test("MCP Readiness UX Phase 2: onReadinessGateEvent fires start/resolved on each resetConversation", async () => {
    // Every gate-awaiting entry point (init, resetConversation, and
    // the deferred-catalog recovery in send) must emit its own
    // start/resolved pair. This test covers the resetConversation
    // path so the pill flips again when the user clears the
    // conversation and a fresh createSession runs.
    const h = makeFakeSdk();
    const events: Array<"start" | "resolved"> = [];
    const agent = new CopilotAgentSession(
      {
        cliPath: "/fake/copilot.exe",
        gitHubToken: "fake-token",
        baseDirectory: "/fake/plugin",
        decider: denyAll,
        tools: [{ name: "read_file" }],
        mcpReadinessGate: async () => undefined,
        onReadinessGateEvent: (kind) => events.push(kind),
      },
      async () => h.sdk,
    );
    await agent.init();
    expect(events).toEqual(["start", "resolved"]);
    events.length = 0;
    await agent.resetConversation();
    expect(events).toEqual(["start", "resolved"]);
    await agent.dispose();
  });

  test("MCP Readiness UX Phase 2: dispose clears isReadinessGateWaiting even if gate is still parked", async () => {
    // Plan requirement (§isReadinessGateWaiting): the flag must
    // read false after dispose returns, even if an
    // awaitMcpReadinessGate was still awaiting its inner promise
    // when dispose was invoked. Otherwise a late-bound ChatView
    // calling the getter after dispose would render a phantom pill.
    const h = makeFakeSdk();
    let resolveGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      resolveGate = resolve;
    });
    const agent = new CopilotAgentSession(
      {
        cliPath: "/fake/copilot.exe",
        gitHubToken: "fake-token",
        baseDirectory: "/fake/plugin",
        decider: denyAll,
        tools: [{ name: "read_file" }],
        mcpReadinessGate: () => gate,
      },
      async () => h.sdk,
    );
    const initP = agent.init();
    // Yield so the gate is entered and the flag flips to true.
    await new Promise((r) => setTimeout(r, 10));
    expect(agent.isReadinessGateWaiting()).toBe(true);
    // Kick off dispose. It will race-with-timeout the initPromise;
    // resolve the gate concurrently so initPromise settles quickly.
    const disposeP = agent.dispose();
    resolveGate();
    await Promise.all([disposeP, initP.catch(() => undefined)]);
    expect(agent.isReadinessGateWaiting()).toBe(false);
  });

  test("denied permission request emits live tool_call_start + tool_call_complete during streaming", async () => {
    const h = makeFakeSdk();
    h.session.on = () => () => {};
    let resolveSend!: (resp: unknown) => void;
    h.session.sendAndWait = (prompt) => {
      h.sendCalls.push(prompt);
      return new Promise((resolve) => {
        resolveSend = resolve;
      });
    };

    const agent = makeAgent(h);
    await agent.init();

    const iter = agent.sendMessageStreaming("run shell")[Symbol.asyncIterator]();
    const firstP = iter.next();
    await new Promise((r) => setTimeout(r, 0));

    // Simulate the SDK asking permission for a shell call.
    const decision = await h.permissionHandler!({
      id: "deny-1",
      kind: "shell",
      toolName: "shell",
    });
    expect(decision.kind).toBe("reject");

    const first = await firstP;
    expect(first.value).toMatchObject({
      type: "tool_call_start",
      toolCall: { id: "deny-1", outcome: "denied", source: "builtin" },
    });
    const second = await iter.next();
    expect(second.value).toMatchObject({
      type: "tool_call_complete",
      id: "deny-1",
      outcome: "denied",
    });

    resolveSend({ data: { content: "Sorry, I couldn't run that." } });
    const third = await iter.next();
    expect(third.value).toMatchObject({ type: "complete" });

    await agent.dispose();
  });

  test("custom tools from opts.tools are forwarded to createSession", async () => {
    const h = makeFakeSdk();
    let lastTools: unknown = null;
    h.client.createSession = async (opts) => {
      h.lastCreateSession = {
        model: opts.model,
        availableTools: opts.availableTools,
      };
      lastTools = opts.tools;
      h.permissionHandler = opts.onPermissionRequest;
      return h.session;
    };
    const agent = new CopilotAgentSession(
      {
        cliPath: "/fake/copilot.exe",
        gitHubToken: "fake-token",
        baseDirectory: "/fake/plugin",
        decider: denyAll,
        tools: [{ name: "read_file" }, { name: "view" }],
      },
      async () => h.sdk,
    );
    await agent.init();
    expect(Array.isArray(lastTools)).toBe(true);
    expect((lastTools as Array<{ name: string }>).map((t) => t.name)).toEqual([
      "read_file",
      "view",
    ]);
    await agent.dispose();
  });
});

describe("CopilotAgentSession - SafetyPolicy path (Phase 6)", () => {
  function makeSafetyAgent(
    handles: FakeHandles,
    overrides: {
      defaultMode?: "auto-apply-with-undo" | "require-approval";
      vaultAllowlist?: string[];
      builtinAutoApprove?: Record<string, boolean>;
      mcpAutoApprove?: Record<string, boolean>;
      getMcpToolSourceMetadata?: NonNullable<
        AgentSessionOptions["safety"]
      >["getMcpToolSourceMetadata"];
      extractVaultPaths?: NonNullable<AgentSessionOptions["safety"]>["extractVaultPaths"];
      describeApproval?: NonNullable<AgentSessionOptions["safety"]>["describeApproval"];
    } = {},
  ) {
    const state = new SafetyState();
    const agent = new CopilotAgentSession(
      {
        cliPath: "/fake/copilot.exe",
        gitHubToken: "fake-token",
        baseDirectory: "/fake/plugin",
        decider: denyAll,
        safety: {
          config: () => ({
            fsDefaultMode: overrides.defaultMode ?? "auto-apply-with-undo",
            vaultAllowlist: overrides.vaultAllowlist ?? [],
            builtinAutoApprove: overrides.builtinAutoApprove ?? {},
            mcpAutoApprove: overrides.mcpAutoApprove ?? {},
          }),
          state,
          getMcpToolSourceMetadata: overrides.getMcpToolSourceMetadata,
          extractVaultPaths: overrides.extractVaultPaths,
          describeApproval: overrides.describeApproval,
        },
      },
      async () => handles.sdk,
    );
    return { agent, state };
  }

  async function capturePrompt(
    h: FakeHandles,
    agent: CopilotAgentSession,
    request: Parameters<NonNullable<FakeHandles["permissionHandler"]>>[0],
  ): Promise<{ summary?: string; detail?: string }> {
    let resolveSend!: (value: unknown) => void;
    h.session.sendAndWait = (prompt: string) => {
      h.sendCalls.push(prompt);
      return new Promise((resolve) => {
        resolveSend = resolve;
      });
    };
    const seen: unknown[] = [];
    const drain = (async () => {
      for await (const ev of agent.sendMessageStreaming("go")) seen.push(ev);
    })();
    await new Promise((r) => setTimeout(r, 5));
    const permission = h.permissionHandler!(request);
    for (let i = 0; i < 50 && !agent.hasPendingApprovals(); i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    const id = (request as { toolCallId: string }).toolCallId;
    agent.resolveApproval(id, { kind: "reject", reason: "test" });
    await permission;
    resolveSend({ data: { content: "done" } });
    await drain;
    const prompt = seen.find(
      (ev) => (ev as { type?: string }).type === "approval_prompt",
    ) as { toolCall: { approval?: { summary?: string; detail?: string } } } | undefined;
    return prompt?.toolCall.approval ?? {};
  }

  describe("batch vault-write approval hooks", () => {
    const req = {
      toolCallId: "tc-batch",
      kind: "custom-tool",
      toolName: "update_tasks",
      args: { targets: [{ path: "inbox/a.md" }, { path: "archive/b.md" }] },
    };

    test("multi-path allowlist auto-applies only when every path is covered", async () => {
      const h = makeFakeSdk();
      const { agent } = makeSafetyAgent(h, {
        defaultMode: "require-approval",
        vaultAllowlist: ["inbox", "archive"],
        extractVaultPaths: () => ["inbox/a.md", "archive/b.md"],
      });
      await agent.init();
      expect((await h.permissionHandler!(req)).kind).toBe("approve-once");
      await agent.dispose();

      const h2 = makeFakeSdk();
      const { agent: agent2 } = makeSafetyAgent(h2, {
        defaultMode: "require-approval",
        vaultAllowlist: ["inbox"],
        extractVaultPaths: () => ["inbox/a.md", "archive/b.md"],
      });
      await agent2.init();
      expect((await h2.permissionHandler!({ ...req, toolCallId: "tc-batch-2" })).kind).toBe("reject");
      await agent2.dispose();
    });

    test("describeApproval supplies the prompt summary and detail for vault writes", async () => {
      const h = makeFakeSdk();
      const describeApproval = vi.fn(async () => ({ summary: "update_tasks: 2 tasks in 2 notes", detail: "preview" }));
      const { agent } = makeSafetyAgent(h, { defaultMode: "require-approval", describeApproval });
      await agent.init();
      const approval = await capturePrompt(h, agent, req);
      expect(approval).toMatchObject({ summary: "update_tasks: 2 tasks in 2 notes", detail: "preview" });
      await agent.dispose();
    });

    test("a throwing describeApproval falls back to the default prompt", async () => {
      const h = makeFakeSdk();
      const { agent } = makeSafetyAgent(h, {
        defaultMode: "require-approval",
        describeApproval: async () => {
          throw new Error("boom");
        },
      });
      await agent.init();
      const approval = await capturePrompt(h, agent, req);
      expect(approval.summary).toBe("update_tasks");
      expect(approval.detail).toContain('"archive/b.md"');
      await agent.dispose();
    });

    test("shell approvals never consult describeApproval", async () => {
      const h = makeFakeSdk();
      const describeApproval = vi.fn(async () => ({ summary: "nope", detail: "nope" }));
      const { agent } = makeSafetyAgent(h, { describeApproval });
      await agent.init();
      const approval = await capturePrompt(h, agent, {
        toolCallId: "tc-shell",
        kind: "shell",
        fullCommandText: "Move-Item a.md b.md",
      });
      expect(approval).toMatchObject({ summary: "Run shell command", detail: "Move-Item a.md b.md" });
      expect(describeApproval).not.toHaveBeenCalled();
      await agent.dispose();
    });
  });

  test("auto-applies vault writes in default mode and returns approve-once", async () => {
    const h = makeFakeSdk();
    const { agent } = makeSafetyAgent(h);
    await agent.init();
    const result = await h.permissionHandler!({
      toolCallId: "tc-w1",
      kind: "custom-tool",
      toolName: "create_file",
      args: { path: "inbox/new.md", content: "x" },
    });
    expect(result.kind).toBe("approve-once");
    await agent.dispose();
  });

  test("rejects when no UI stream is attached and mode requires approval", async () => {
    const h = makeFakeSdk();
    const { agent } = makeSafetyAgent(h, { defaultMode: "require-approval" });
    await agent.init();
    const result = await h.permissionHandler!({
      toolCallId: "tc-w2",
      kind: "custom-tool",
      toolName: "edit_file",
      args: { path: "x.md", content: "y" },
    });
    expect(result.kind).toBe("reject");
    if (result.kind === "reject") {
      expect(result.feedback).toMatch(/No UI/i);
    }
    await agent.dispose();
  });

  test("MCP and built-in calls require approval by default (no UI -> reject)", async () => {
    const h = makeFakeSdk();
    const { agent } = makeSafetyAgent(h);
    await agent.init();
    const mcpResult = await h.permissionHandler!({
      toolCallId: "tc-mcp",
      kind: "mcp",
      serverName: "my-server",
      toolName: "do-thing",
    });
    expect(mcpResult.kind).toBe("reject");

    const shellResult = await h.permissionHandler!({
      toolCallId: "tc-sh",
      kind: "shell",
      fullCommandText: "ls -la",
    });
    expect(shellResult.kind).toBe("reject");
    await agent.dispose();
  });

  test("synthetic MCP ids classify to source mcp", () => {
    expect(
      classifyToolSource(
        "custom-tool",
        formatSyntheticId(mcpServerId, "read_resource"),
        new Set(),
      ),
    ).toBe("mcp");
  });

  test("MCP grant lookup reads current trust epoch synchronously at decision time", async () => {
    const h = makeFakeSdk();
    let epoch = mcpEpoch1;
    const { agent } = makeSafetyAgent(h, {
      mcpAutoApprove: {
        [formatMcpGrantKey(mcpServerId, "read", mcpEpoch2)]: true,
      },
      getMcpToolSourceMetadata: () => ({
        source: "mcp",
        stableServerId: mcpServerId,
        serverName: "Server A",
        toolName: "read",
        trustEpoch: epoch,
      }),
    });
    await agent.init();
    const toolName = formatSyntheticId(mcpServerId, "read");
    expect(
      (
        await h.permissionHandler!({
          toolCallId: "tc-mcp-current-1",
          kind: "mcp",
          toolName,
        })
      ).kind,
    ).toBe("reject");
    epoch = mcpEpoch2;
    expect(
      (
        await h.permissionHandler!({
          toolCallId: "tc-mcp-current-2",
          kind: "mcp",
          toolName,
        })
      ).kind,
    ).toBe("approve-once");
    await agent.dispose();
  });

  test("persistent MCP grant requires approval when runtime metadata is unavailable", async () => {
    const h = makeFakeSdk();
    const { agent } = makeSafetyAgent(h, {
      mcpAutoApprove: {
        [formatMcpGrantKey(mcpServerId, "read", mcpEpoch1)]: true,
      },
      getMcpToolSourceMetadata: () => null,
    });
    await agent.init();
    const result = await h.permissionHandler!({
      toolCallId: "tc-mcp-disconnected",
      kind: "mcp",
      toolName: formatSyntheticId(mcpServerId, "read"),
    });
    expect(result.kind).toBe("reject");
    if (result.kind === "reject") expect(result.feedback).toMatch(/metadata|No UI/i);
    await agent.dispose();
  });

  test("approve-for-session grants exact MCP server/tool/epoch only", async () => {
    const h = makeFakeSdk();
    let resolveSend!: (value: unknown) => void;
    h.session.sendAndWait = () =>
      new Promise((resolve) => {
        resolveSend = resolve;
      });
    const { agent } = makeSafetyAgent(h, {
      getMcpToolSourceMetadata: () => ({
        source: "mcp",
        stableServerId: mcpServerId,
        serverName: "Server A",
        toolName: "read",
        trustEpoch: mcpEpoch1,
      }),
    });
    await agent.init();
    const iter = agent.sendMessageStreaming("trigger")[Symbol.asyncIterator]();
    const firstEvent = iter.next();
    await new Promise((r) => setTimeout(r, 0));
    const permission = h.permissionHandler!({
      toolCallId: "tc-mcp-session",
      kind: "mcp",
      toolName: formatSyntheticId(mcpServerId, "read"),
    });
    await firstEvent;
    agent.resolveApproval("tc-mcp-session", { kind: "approve-for-session" });
    expect((await permission).kind).toBe("approve-once");

    expect(
      (
        await h.permissionHandler!({
          toolCallId: "tc-mcp-session-2",
          kind: "mcp",
          toolName: formatSyntheticId(mcpServerId, "read"),
        })
      ).kind,
    ).toBe("approve-once");
    resolveSend({ data: { content: "done" } });
    await iter.next();
    await agent.dispose();
  });

  test("server removed between approval and dispatch rejects before approval reaches SDK", async () => {
    const h = makeFakeSdk();
    let resolveSend!: (value: unknown) => void;
    h.session.sendAndWait = () =>
      new Promise((resolve) => {
        resolveSend = resolve;
      });
    let present = true;
    const { agent } = makeSafetyAgent(h, {
      getMcpToolSourceMetadata: () =>
        present
          ? {
              source: "mcp",
              stableServerId: mcpServerId,
              serverName: "Server A",
              toolName: "read",
              trustEpoch: mcpEpoch1,
            }
          : null,
    });
    await agent.init();
    const iter = agent.sendMessageStreaming("trigger")[Symbol.asyncIterator]();
    const firstEvent = iter.next();
    await new Promise((r) => setTimeout(r, 0));
    const permission = h.permissionHandler!({
      toolCallId: "tc-mcp-removed",
      kind: "mcp",
      toolName: formatSyntheticId(mcpServerId, "read"),
    });
    await firstEvent;
    present = false;
    agent.resolveApproval("tc-mcp-removed", { kind: "approve-once" });
    const result = await permission;
    expect(result.kind).toBe("reject");
    resolveSend({ data: { content: "done" } });
    await iter.next();
    await agent.dispose();
  });

  test("cancels in-flight MCP approval by exact server id and is idempotent", async () => {
    const h = makeFakeSdk();
    let resolveSend!: (value: unknown) => void;
    h.session.sendAndWait = (prompt: string) => {
      h.sendCalls.push(prompt);
      return new Promise((resolve) => {
        resolveSend = resolve;
      });
    };
    const { agent } = makeSafetyAgent(h, {
      defaultMode: "require-approval",
      getMcpToolSourceMetadata: () => ({
        source: "mcp",
        stableServerId: mcpServerId,
        serverName: "Server A",
        toolName: "read",
        trustEpoch: mcpEpoch1,
      }),
    });
    await agent.init();
    const eventsPromise = (async () => {
      const seen: unknown[] = [];
      for await (const ev of agent.sendMessageStreaming("trigger")) seen.push(ev);
      return seen;
    })();
    await new Promise((r) => setTimeout(r, 5));
    const permission = h.permissionHandler!({
      toolCallId: "tc-mcp-pending-cancel",
      kind: "mcp",
      toolName: formatSyntheticId(mcpServerId, "read"),
    });
    await new Promise((r) => setTimeout(r, 5));
    expect(agent.hasPendingApprovals()).toBe(true);

    agent.cancelPendingMcpApprovalsForServer("server", "Wrong server.");
    await new Promise((r) => setTimeout(r, 0));
    expect(agent.hasPendingApprovals()).toBe(true);

    agent.cancelPendingMcpApprovalsForServer(mcpServerId, "MCP server disabled.");
    expect(() =>
      agent.cancelPendingMcpApprovalsForServer(mcpServerId, "MCP server disabled."),
    ).not.toThrow();
    const result = await permission;
    expect(result).toEqual({
      kind: "reject",
      feedback: "MCP server disabled.",
    });
    expect(agent.hasPendingApprovals()).toBe(false);

    resolveSend({ data: { content: "done" } });
    const events = await eventsPromise;
    expect(
      events.find(
        (ev) =>
          typeof ev === "object" &&
          ev !== null &&
          (ev as { type?: string }).type === "approval_resolved",
      ),
    ).toMatchObject({
      choice: { kind: "cancelled", reason: "MCP server disabled." },
    });
    expect(
      events.find(
        (ev) =>
          typeof ev === "object" &&
          ev !== null &&
          (ev as { type?: string; id?: string }).type === "tool_call_complete" &&
          (ev as { id?: string }).id === "tc-mcp-pending-cancel",
      ),
    ).toMatchObject({
      outcome: "cancelled",
      errorMessage: "MCP server disabled.",
    });
    expect(
      events.some(
        (ev) =>
          typeof ev === "object" &&
          ev !== null &&
          (ev as { type?: string; outcome?: string }).type === "tool_call_complete" &&
          (ev as { outcome?: string }).outcome === "completed",
      ),
    ).toBe(false);
    await agent.dispose();
  });

  test.each([
    ["disable", "MCP server disabled."],
    ["disconnect", "MCP server disconnected."],
  ])(
    "M3 isolation: server-X %s cancels only matching in-flight MCP calls",
    async (lifecycleEvent, reason) => {
      const hA = makeFakeSdk();
      const hB = makeFakeSdk();
      const handlersA = attachStreamingHandlers(hA);
      const handlersB = attachStreamingHandlers(hB);
      const sendA = deferred<unknown>();
      const sendB = deferred<unknown>();
      hA.session.sendAndWait = (prompt) => {
        hA.sendCalls.push(prompt);
        return sendA.promise;
      };
      hB.session.sendAndWait = (prompt) => {
        hB.sendCalls.push(prompt);
        return sendB.promise;
      };

      const agentA = makeAgent(hA);
      const agentB = makeAgent(hB);
      await agentA.init();
      await agentB.init();
      const { manager, serverX } = makeMcpLifecycleManager(
        [agentA, agentB],
        () => reason,
      );
      await manager.enableAllConfigured();

      const iterA = agentA.sendMessageStreaming("session A streaming text")[Symbol.asyncIterator]();
      const iterB = agentB.sendMessageStreaming("session B uses MCP")[Symbol.asyncIterator]();
      const firstA = iterA.next();
      const firstB = iterB.next();
      await new Promise((r) => setTimeout(r, 0));

      handlersA.delta!({
        type: "assistant.message_delta",
        data: { deltaContent: "still " },
      });
      expect(await firstA).toEqual({
        value: { type: "delta", text: "still " },
        done: false,
      });

      handlersB.toolStart!({
        type: "tool.execution_start",
        data: {
          toolCallId: "b-mcp-x",
          toolName: formatSyntheticId(serverX, "read"),
          mcpServerName: "server-X",
          arguments: { path: "x.md" },
        },
      });
      expect(await firstB).toMatchObject({
        value: {
          type: "tool_call_start",
          toolCall: {
            id: "b-mcp-x",
            source: "mcp",
            outcome: "approved",
          },
        },
        done: false,
      });

      const builtInStart = iterB.next();
      handlersB.toolStart!({
        type: "tool.execution_start",
        data: {
          toolCallId: "b-shell",
          toolName: "shell",
          arguments: { command: "echo ok" },
        },
      });
      expect(await builtInStart).toMatchObject({
        value: {
          type: "tool_call_start",
          toolCall: {
            id: "b-shell",
            source: "builtin",
            outcome: "approved",
          },
        },
        done: false,
      });

      if (lifecycleEvent === "disable") {
        await manager.disable(serverX);
      } else {
        await expect(manager.callTool(serverX, "read", {})).rejects.toThrow(
          /server disconnected/,
        );
      }

      expect(await iterB.next()).toEqual({
        value: {
          type: "tool_call_complete",
          id: "b-mcp-x",
          outcome: "cancelled",
          errorMessage: reason,
        },
        done: false,
      });
      expect(hA.abortCalls).toBe(0);
      expect(hB.abortCalls).toBe(0);

      const secondA = iterA.next();
      handlersA.delta!({
        type: "assistant.message_delta",
        data: { deltaContent: "streaming" },
      });
      expect(await secondA).toEqual({
        value: { type: "delta", text: "streaming" },
        done: false,
      });

      const builtInComplete = iterB.next();
      handlersB.toolComplete!({
        type: "tool.execution_complete",
        data: {
          toolCallId: "b-mcp-x",
          success: true,
          result: { content: "late mcp result" },
        },
      });
      handlersB.toolComplete!({
        type: "tool.execution_complete",
        data: {
          toolCallId: "b-shell",
          success: true,
          result: { content: "ok" },
        },
      });
      expect(await builtInComplete).toEqual({
        value: {
          type: "tool_call_complete",
          id: "b-shell",
          outcome: "completed",
          content: "ok",
          errorMessage: undefined,
        },
        done: false,
      });

      sendA.resolve({ data: { content: "A done" } });
      sendB.resolve({ data: { content: "B done" } });
      expect(await iterA.next()).toMatchObject({
        value: { type: "complete", content: "A done" },
        done: false,
      });
      expect(await iterB.next()).toMatchObject({
        value: { type: "complete", content: "B done" },
        done: false,
      });
      expect((await iterA.next()).done).toBe(true);
      expect((await iterB.next()).done).toBe(true);
      await agentA.dispose();
      await agentB.dispose();
    },
  );

  test("M3 isolation: server-Y lifecycle cancellation leaves server-X calls in another session running", async () => {
    const hA = makeFakeSdk();
    const hB = makeFakeSdk();
    const handlersA = attachStreamingHandlers(hA);
    const handlersB = attachStreamingHandlers(hB);
    const sendA = deferred<unknown>();
    const sendB = deferred<unknown>();
    hA.session.sendAndWait = (prompt) => {
      hA.sendCalls.push(prompt);
      return sendA.promise;
    };
    hB.session.sendAndWait = (prompt) => {
      hB.sendCalls.push(prompt);
      return sendB.promise;
    };

    const agentA = makeAgent(hA);
    const agentB = makeAgent(hB);
    await agentA.init();
    await agentB.init();
    const { manager, serverX, serverY } = makeMcpLifecycleManager(
      [agentA, agentB],
      () => "MCP server disconnected.",
    );
    await manager.enableAllConfigured();

    const iterA = agentA.sendMessageStreaming("session A uses server Y")[Symbol.asyncIterator]();
    const iterB = agentB.sendMessageStreaming("session B uses server X")[Symbol.asyncIterator]();
    const firstA = iterA.next();
    const firstB = iterB.next();
    await new Promise((r) => setTimeout(r, 0));

    handlersA.toolStart!({
      type: "tool.execution_start",
      data: {
        toolCallId: "a-mcp-y",
        toolName: formatSyntheticId(serverY, "lookup"),
        mcpServerName: "server-Y",
        arguments: { query: "a" },
      },
    });
    handlersB.toolStart!({
      type: "tool.execution_start",
      data: {
        toolCallId: "b-mcp-x",
        toolName: formatSyntheticId(serverX, "lookup"),
        mcpServerName: "server-X",
        arguments: { query: "b" },
      },
    });
    expect(await firstA).toMatchObject({
      value: { type: "tool_call_start", toolCall: { id: "a-mcp-y", source: "mcp" } },
      done: false,
    });
    expect(await firstB).toMatchObject({
      value: { type: "tool_call_start", toolCall: { id: "b-mcp-x", source: "mcp" } },
      done: false,
    });

    await manager.disable(serverY);

    expect(await iterA.next()).toEqual({
      value: {
        type: "tool_call_complete",
        id: "a-mcp-y",
        outcome: "cancelled",
        errorMessage: "MCP server disconnected.",
      },
      done: false,
    });

    const serverXComplete = iterB.next();
    handlersA.toolComplete!({
      type: "tool.execution_complete",
      data: {
        toolCallId: "a-mcp-y",
        success: true,
        result: { content: "late y result" },
      },
    });
    handlersB.toolComplete!({
      type: "tool.execution_complete",
      data: {
        toolCallId: "b-mcp-x",
        success: true,
        result: { content: "x result" },
      },
    });
    expect(await serverXComplete).toEqual({
      value: {
        type: "tool_call_complete",
        id: "b-mcp-x",
        outcome: "completed",
        content: "x result",
        errorMessage: undefined,
      },
      done: false,
    });
    expect(hA.abortCalls).toBe(0);
    expect(hB.abortCalls).toBe(0);

    sendA.resolve({ data: { content: "A done" } });
    sendB.resolve({ data: { content: "B done" } });
    expect(await iterA.next()).toMatchObject({
      value: { type: "complete", content: "A done" },
      done: false,
    });
    expect(await iterB.next()).toMatchObject({
      value: { type: "complete", content: "B done" },
      done: false,
    });
    expect((await iterA.next()).done).toBe(true);
    expect((await iterB.next()).done).toBe(true);
    await agentA.dispose();
    await agentB.dispose();
  });

  test("server cancellation clears resolved MCP approvals with NUL-separated cache keys", async () => {
    const h = makeFakeSdk();
    const mcpAutoApprove = {
      [formatMcpGrantKey(mcpServerId, "read", mcpEpoch1)]: true,
    };
    const { agent } = makeSafetyAgent(h, {
      mcpAutoApprove,
      getMcpToolSourceMetadata: () => ({
        source: "mcp",
        stableServerId: mcpServerId,
        serverName: "Server A",
        toolName: "read",
        trustEpoch: mcpEpoch1,
      }),
    });
    await agent.init();
    const request = {
      toolCallId: "tc-mcp-cache-cancel",
      kind: "mcp",
      toolName: formatSyntheticId(mcpServerId, "read"),
    };
    expect((await h.permissionHandler!(request)).kind).toBe("approve-once");
    delete mcpAutoApprove[formatMcpGrantKey(mcpServerId, "read", mcpEpoch1)];

    agent.cancelPendingMcpApprovalsForServer(mcpServerId);

    expect((await h.permissionHandler!(request)).kind).toBe("reject");
    await agent.dispose();
  });

  test("resolved approval cache clears on MCP epoch rotation, disable, disconnect, and crashloop", async () => {
    for (const state of ["epoch", "disable", "disconnect", "crashloop"]) {
      const h = makeFakeSdk();
      let metadata:
        | {
            source: "mcp";
            stableServerId: typeof mcpServerId;
            serverName: string;
            toolName: string;
            trustEpoch: McpTrustEpoch;
          }
        | null = {
        source: "mcp",
        stableServerId: mcpServerId,
        serverName: "Server A",
        toolName: "read",
        trustEpoch: mcpEpoch1,
      };
      const { agent } = makeSafetyAgent(h, {
        mcpAutoApprove: {
          [formatMcpGrantKey(mcpServerId, "read", mcpEpoch1)]: true,
        },
        getMcpToolSourceMetadata: () => metadata,
      });
      await agent.init();
      const request = {
        toolCallId: `tc-mcp-cache-${state}`,
        kind: "mcp",
        toolName: formatSyntheticId(mcpServerId, "read"),
      };
      expect((await h.permissionHandler!(request)).kind).toBe("approve-once");
      metadata =
        state === "epoch"
          ? { ...metadata!, trustEpoch: mcpEpoch2 }
          : null;
      expect((await h.permissionHandler!(request)).kind).toBe("reject");
      await agent.dispose();
    }
  });

  test("built-in toggle auto-approves matching kind", async () => {
    const h = makeFakeSdk();
    const { agent } = makeSafetyAgent(h, {
      builtinAutoApprove: { shell: true },
    });
    await agent.init();
    const result = await h.permissionHandler!({
      toolCallId: "tc-sh2",
      kind: "shell",
      fullCommandText: "echo hi",
    });
    expect(result.kind).toBe("approve-once");
    await agent.dispose();
  });

  test("allowlist auto-approves matching vault path even when default mode is require-approval", async () => {
    const h = makeFakeSdk();
    const { agent } = makeSafetyAgent(h, {
      defaultMode: "require-approval",
      vaultAllowlist: ["inbox"],
    });
    await agent.init();
    const result = await h.permissionHandler!({
      toolCallId: "tc-w3",
      kind: "custom-tool",
      toolName: "create_file",
      args: { path: "inbox/today.md", content: "x" },
    });
    expect(result.kind).toBe("approve-once");
    await agent.dispose();
  });

  test("Phase 4 vault-write tools classify as source: vault and auto-apply in default mode", async () => {
    const h = makeFakeSdk();
    const { agent } = makeSafetyAgent(h);
    await agent.init();
    for (const toolName of [
      "create_note",
      "edit_note",
      "insert_into_active_note",
      "create_daily_note",
      "create_task",
      "update_task",
      "update_tasks",
      "move_note",
      "bulk_edit",
    ]) {
      const result = await h.permissionHandler!({
        toolCallId: `tc-vw-${toolName}`,
        kind: "custom-tool",
        toolName,
        args: { path: "inbox/x.md" },
      });
      expect(
        result.kind,
        `tool ${toolName} should be classified as vault and auto-applied`,
      ).toBe("approve-once");
    }
    await agent.dispose();
  });

  test("resolveApproval is a no-op for an unknown id", async () => {
    const h = makeFakeSdk();
    const { agent } = makeSafetyAgent(h);
    await agent.init();
    // Should not throw.
    agent.resolveApproval("does-not-exist", { kind: "approve-once" });
    await agent.dispose();
  });

  test("cancelCurrent rejects pending approvals so SDK does not hang", async () => {
    const h = makeFakeSdk();
    const { agent } = makeSafetyAgent(h, { defaultMode: "require-approval" });
    await agent.init();
    // Start streaming so currentStreamPush is set, then race a
    // permission request that requires approval. We don't ever click
    // approve — cancelCurrent should resolve the deferred as reject.
    const iter = agent.sendMessageStreaming("trigger");
    const collector = (async () => {
      const seen: unknown[] = [];
      for await (const ev of iter) seen.push(ev);
      return seen;
    })();
    // Wait one tick so the stream subscribes its handlers.
    await new Promise((r) => setTimeout(r, 5));
    const permissionResultPromise = h.permissionHandler!({
      toolCallId: "tc-pending",
      kind: "shell",
      fullCommandText: "rm -rf /",
    });
    await new Promise((r) => setTimeout(r, 5));
    await agent.cancelCurrent();
    const result = await permissionResultPromise;
    expect(result.kind).toBe("reject");
    await collector.catch(() => {});
    await agent.dispose();
  });

  describe("Phase 2 — preamble injection", () => {
    test("prepends preamble to the FIRST send and leaves subsequent sends untouched", async () => {
      const h = makeFakeSdk();
      const agent = makeAgent(h, denyAll, {
        preamble: () => "PREAMBLE-X",
      });
      await agent.sendMessage("hello");
      await agent.sendMessage("world");
      expect(h.sendCalls.length).toBe(2);
      expect(h.sendCalls[0]).toContain("PREAMBLE-X");
      expect(h.sendCalls[0]).toContain("hello");
      expect(h.sendCalls[1]).toBe("world");
      const probe = agent.preambleProbe();
      expect(probe.firstSend).toContain("PREAMBLE-X");
      expect(probe.followupSend).toBe("world");
      expect(probe.firstSendArmed).toBe(false);
      await agent.dispose();
    });

    test("preamble: () => null short-circuits — first send is untouched", async () => {
      const h = makeFakeSdk();
      const agent = makeAgent(h, denyAll, { preamble: () => null });
      await agent.sendMessage("hi");
      expect(h.sendCalls).toEqual(["hi"]);
      await agent.dispose();
    });

    test("preamble: () => '' (empty) short-circuits — first send is untouched", async () => {
      const h = makeFakeSdk();
      const agent = makeAgent(h, denyAll, { preamble: () => "" });
      await agent.sendMessage("hi");
      expect(h.sendCalls).toEqual(["hi"]);
      await agent.dispose();
    });

    test("preamble callback throwing does NOT block the send", async () => {
      const h = makeFakeSdk();
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const agent = makeAgent(h, denyAll, {
        preamble: () => {
          throw new Error("boom");
        },
      });
      await agent.sendMessage("hi");
      expect(h.sendCalls).toEqual(["hi"]);
      warnSpy.mockRestore();
      await agent.dispose();
    });

    test("resetConversation re-arms the preamble (next send is treated as a first send again)", async () => {
      const h = makeFakeSdk();
      let counter = 0;
      const agent = makeAgent(h, denyAll, {
        preamble: () => `PREAMBLE-${++counter}`,
      });
      await agent.sendMessage("a");
      await agent.sendMessage("b");
      await agent.resetConversation();
      await agent.sendMessage("c");
      expect(h.sendCalls.length).toBe(3);
      expect(h.sendCalls[0]).toContain("PREAMBLE-1");
      expect(h.sendCalls[1]).toBe("b");
      expect(h.sendCalls[2]).toContain("PREAMBLE-2");
      await agent.dispose();
    });

    test("with no preamble option configured, sends are pass-through (legacy behaviour)", async () => {
      const h = makeFakeSdk();
      const agent = makeAgent(h);
      await agent.sendMessage("a");
      await agent.sendMessage("b");
      expect(h.sendCalls).toEqual(["a", "b"]);
      await agent.dispose();
    });

    test("preamble is also injected on the streaming send path", async () => {
      const h = makeFakeSdk();
      const agent = makeAgent(h, denyAll, {
        preamble: () => "STREAM-PREAMBLE",
      });
      // Drain the iterator to drive the streaming send path to completion.
      for await (const _ of agent.sendMessageStreaming("hello-stream")) {
        // no-op
      }
      expect(h.sendCalls.length).toBe(1);
      expect(h.sendCalls[0]).toContain("STREAM-PREAMBLE");
      expect(h.sendCalls[0]).toContain("hello-stream");
      await agent.dispose();
    });
  });

  // v0.4 Phase 3 (FR-005): swapModel — in-place model swap.
  describe("swapModel", () => {
    test("identity no-op when newId === selectedModel does NOT call setModel", async () => {
      const h = makeFakeSdk();
      const agent = makeAgent(h);
      await agent.init();
      expect(agent.getModel()).toBe("gpt-4.1");
      await agent.swapModel("gpt-4.1");
      expect(h.setModelCalls).toEqual([]);
      expect(agent.getModel()).toBe("gpt-4.1");
      await agent.dispose();
    });

    test("happy path: cancels pending stream + calls SDK setModel + updates selectedModel", async () => {
      const h = makeFakeSdk();
      const agent = makeAgent(h);
      await agent.init();
      await agent.swapModel("gpt-4o");
      expect(h.setModelCalls).toEqual(["gpt-4o"]);
      // cancelCurrent flows through to session.abort.
      expect(h.abortCalls).toBe(1);
      expect(agent.getModel()).toBe("gpt-4o");
      await agent.dispose();
    });

    test("selectedModel is only updated AFTER setModel resolves (rejection leaves state unchanged)", async () => {
      const h = makeFakeSdk();
      h.setModelImpl = async () => {
        throw new Error("SDK rejected model");
      };
      const agent = makeAgent(h);
      await agent.init();
      const before = agent.getModel();
      await expect(agent.swapModel("gpt-4o")).rejects.toThrow(
        "SDK rejected model",
      );
      expect(agent.getModel()).toBe(before);
      await agent.dispose();
    });

    test("pre-init swap records preferred override and seeds next init", async () => {
      const h = makeFakeSdk();
      const agent = makeAgent(h);
      // swap BEFORE init — no SDK session exists yet.
      await agent.swapModel("gpt-4o");
      expect(h.setModelCalls).toEqual([]);
      expect(agent.getModel()).toBe("gpt-4o");
      // After init, the preferred override drives pickModel.
      await agent.init();
      expect(h.lastCreateSession.model).toBe("gpt-4o");
      await agent.dispose();
    });

    test("preferred override survives reconnect", async () => {
      const h = makeFakeSdk();
      const agent = makeAgent(h);
      await agent.init();
      await agent.swapModel("gpt-4o");
      // Reconnect rebuilds the SDK session via init; the override
      // should drive pickModel rather than reverting to opts.preferredModel.
      await agent.reconnect();
      expect(h.lastCreateSession.model).toBe("gpt-4o");
      await agent.dispose();
    });

    test("throws when disposed", async () => {
      const h = makeFakeSdk();
      const agent = makeAgent(h);
      await agent.init();
      await agent.dispose();
      await expect(agent.swapModel("gpt-4o")).rejects.toThrow(
        /disposed/i,
      );
    });

    test("throws when SDK session lacks setModel", async () => {
      const h = makeFakeSdk();
      // Strip setModel after the fake is built so init still succeeds.
      delete (h.session as { setModel?: unknown }).setModel;
      const agent = makeAgent(h);
      await agent.init();
      await expect(agent.swapModel("gpt-4o")).rejects.toThrow(
        /setModel/,
      );
    });
  });
});

// ---------- v0.4 Phase 5 (S1): deferred-init recovery ----------

describe("CopilotAgentSession — SDK session resume", () => {
  function withResume(
    h: FakeHandles,
    resume: (id: string) => Promise<SdkSession>,
  ) {
    const calls = { resume: [] as string[], create: 0, deleted: [] as string[] };
    const create = h.client.createSession;
    let createdCount = 0;
    h.client.createSession = async (opts) => {
      calls.create += 1;
      const s = await create(opts);
      return Object.assign(Object.create(s) as SdkSession, {
        sessionId: `new-${++createdCount}`,
      });
    };
    h.client.resumeSession = async (id) => {
      calls.resume.push(id);
      return resume(id);
    };
    h.client.deleteSession = async (id) => {
      calls.deleted.push(id);
    };
    return calls;
  }

  test("resumes the persisted session and re-sends the preamble", async () => {
    const h = makeFakeSdk();
    const calls = withResume(h, async (id) =>
      Object.assign(Object.create(h.session) as SdkSession, { sessionId: id }),
    );
    const opened = vi.fn();
    const agent = makeAgent(h, denyAll, {
      resumeSessionId: "sess-1",
      preamble: () => "PREAMBLE",
      onSessionOpened: opened,
    });
    await agent.sendMessage("hello");
    expect(calls.resume).toEqual(["sess-1"]);
    expect(calls.create).toBe(0);
    expect(h.sendCalls[0]).toBe("PREAMBLE\n\n---\n\n## User request\n\nhello");
    expect(opened).toHaveBeenCalledWith({ sessionId: "sess-1", resumed: true, cause: "init" });
    await agent.dispose();
  });

  test("a one-off resume failure keeps the saved session and retries it", async () => {
    const h = makeFakeSdk();
    let fail = true;
    const calls = withResume(h, async (id) => {
      if (fail) {
        fail = false;
        throw new Error("session is locked");
      }
      return Object.assign(Object.create(h.session) as SdkSession, { sessionId: id });
    });
    h.client.getSessionMetadata = async () => ({ sessionId: "sess-1" });
    const opened = vi.fn();
    const agent = makeAgent(h, denyAll, { resumeSessionId: "sess-1", onSessionOpened: opened });
    await expect(agent.sendMessage("hello")).rejects.toThrow(/Couldn't reopen.*session is locked/);
    expect(calls.create).toBe(0);
    expect(opened).not.toHaveBeenCalled();
    await agent.sendMessage("hello");
    expect(calls.resume).toEqual(["sess-1", "sess-1"]);
    expect(calls.create).toBe(0);
    expect(opened).toHaveBeenCalledWith({ sessionId: "sess-1", resumed: true, cause: "init" });
    await agent.dispose();
  });

  test("a session that keeps failing to resume is replaced on the second attempt", async () => {
    const h = makeFakeSdk();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const calls = withResume(h, async () => {
      throw new Error("corrupt");
    });
    h.client.getSessionMetadata = async () => ({ sessionId: "bad" });
    const opened = vi.fn();
    const agent = makeAgent(h, denyAll, { resumeSessionId: "bad", onSessionOpened: opened });
    await expect(agent.sendMessage("one")).rejects.toThrow(/Couldn't reopen/);
    await agent.sendMessage("two");
    expect(calls.create).toBe(1);
    expect(opened).toHaveBeenCalledWith({
      sessionId: "new-1",
      resumed: false,
      resumeFailedFor: "bad",
      cause: "init",
    });
    warn.mockRestore();
    await agent.dispose();
  });

  test("concurrent deferred recoveries resume the session once and keep the user's model pick", async () => {
    const h = makeFakeSdk();
    (h.client as { listModels: () => Promise<unknown> }).listModels = async () => {
      throw new Error("boom");
    };
    const calls = withResume(h, async (id) =>
      Object.assign(Object.create(h.session) as SdkSession, { sessionId: id }),
    );
    const { ModelCatalog } = await import("./ModelCatalog");
    let catalogModelsFn: () => Promise<Array<{ id: string }>> = async () => {
      throw new Error("catalog down");
    };
    const catalog = new ModelCatalog(
      () =>
        ({
          createSession: () => Promise.reject(new Error("x")),
          listModels: () => catalogModelsFn(),
        }) as unknown as SdkClient,
    );
    await catalog.refresh();
    let gateCalls = 0;
    const slow = deferred<void>();
    const agent = new CopilotAgentSession(
      {
        cliPath: "/fake/copilot.exe",
        gitHubToken: "fake-token",
        baseDirectory: "/fake/plugin",
        decider: denyAll,
        catalog,
        resumeSessionId: "sess-1",
        mcpReadinessGate: async () => {
          gateCalls += 1;
          await slow.promise;
        },
      },
      async () => h.sdk,
    );
    await agent.init();
    expect(agent.hasDeferredSession()).toBe(true);

    catalogModelsFn = async () => [{ id: "gpt-4o" }];
    await catalog.refresh();
    await new Promise((r) => setTimeout(r, 0));
    const swap = agent.swapModel("claude-x");
    await new Promise((r) => setTimeout(r, 0));
    slow.resolve();
    await swap;

    expect(gateCalls).toBe(1);
    expect(calls.resume).toEqual(["sess-1"]);
    expect(agent.hasDeferredSession()).toBe(false);
    expect(agent.getModel()).toBe("claude-x");
    expect(h.setModelCalls).toEqual(["claude-x"]);
    await agent.dispose();
  });

  test("falls back to a new session and reports the failed id", async () => {
    const h = makeFakeSdk();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const calls = withResume(h, async () => {
      throw new Error("Session not found");
    });
    const opened = vi.fn();
    const agent = makeAgent(h, denyAll, {
      resumeSessionId: "gone",
      preamble: () => "PREAMBLE",
      onSessionOpened: opened,
    });
    await agent.sendMessage("hello");
    expect(calls.create).toBe(1);
    expect(h.sendCalls[0]).toContain("PREAMBLE");
    expect(opened).toHaveBeenCalledWith({
      sessionId: "new-1",
      resumed: false,
      resumeFailedFor: "gone",
      cause: "init",
    });
    warn.mockRestore();
    await agent.dispose();
  });

  test("re-init after a runtime restart resumes the session it created", async () => {
    const h = makeFakeSdk();
    const calls = withResume(h, async (id) =>
      Object.assign(Object.create(h.session) as SdkSession, { sessionId: id }),
    );
    const agent = makeAgent(h);
    await agent.init();
    expect(calls.create).toBe(1);
    await agent.reconnect();
    expect(calls.resume).toEqual(["new-1"]);
    expect(calls.create).toBe(1);
    await agent.dispose();
  });

  test("resetConversation deletes the old session and reports the new one", async () => {
    const h = makeFakeSdk();
    const calls = withResume(h, async (id) =>
      Object.assign(Object.create(h.session) as SdkSession, { sessionId: id }),
    );
    const opened = vi.fn();
    const agent = makeAgent(h, denyAll, { resumeSessionId: "sess-1", onSessionOpened: opened });
    await agent.init();
    await agent.resetConversation();
    expect(calls.deleted).toEqual(["sess-1"]);
    expect(opened).toHaveBeenLastCalledWith({ sessionId: "new-1", resumed: false, cause: "reset" });
    await agent.reconnect();
    expect(calls.resume).toEqual(["sess-1", "new-1"]);
    await agent.dispose();
  });

  test("priorContext sits between the preamble and the user request", async () => {
    const h = makeFakeSdk();
    const agent = makeAgent(h, denyAll, { preamble: () => "PREAMBLE" });
    for await (const _ of agent.sendMessageStreaming("now", { priorContext: "EXCERPT" })) {
      // drain
    }
    for await (const _ of agent.sendMessageStreaming("later", { priorContext: "EXCERPT2" })) {
      // drain
    }
    const first = h.sendCalls[0];
    expect(first.indexOf("PREAMBLE")).toBeLessThan(first.indexOf("EXCERPT"));
    expect(first.indexOf("EXCERPT")).toBeLessThan(first.indexOf("## User request\n\nnow"));
    expect(h.sendCalls[1]).toBe("EXCERPT2\n\n---\n\n## User request\n\nlater");
    await agent.dispose();
  });
});

describe("CopilotAgentSession — deferred-init (v0.4 Phase 5 S1)", () => {
  test("catalog non-ready AND per-session listModels throws → init succeeds in deferred state", async () => {
    const h = makeFakeSdk();
    // Per-session listModels also throws so pickModel cannot resolve.
    (h.client as { listModels: () => Promise<unknown> }).listModels =
      async () => {
        throw new Error("client.listModels boom");
      };
    const { ModelCatalog } = await import("./ModelCatalog");
    const catalog = new ModelCatalog(
      () =>
        ({
          createSession: () => Promise.reject(new Error("x")),
          listModels: async () => {
            throw new Error("catalog down");
          },
        }) as unknown as SdkClient,
    );
    await catalog.refresh();
    expect(catalog.getState().kind).toBe("error");

    const agent = makeAgent(h, denyAll, { catalog });
    await agent.init(); // does NOT throw
    expect(agent.hasDeferredSession()).toBe(true);
    expect(agent.getModel()).toBeUndefined();
    // No createSession was called yet — we only saw client.start + ping.
    expect(h.lastCreateSession.model).toBeUndefined();

    await expect(agent.sendMessage("hi")).rejects.toThrow(/pick a model/i);
    await agent.dispose();
  });

  test("catalog non-ready, listModels fails → catalog later transitions to ready → session auto-recovers", async () => {
    const h = makeFakeSdk();
    (h.client as { listModels: () => Promise<unknown> }).listModels =
      async () => {
        throw new Error("client.listModels boom");
      };

    const { ModelCatalog } = await import("./ModelCatalog");
    let catalogModelsFn: () => Promise<Array<{ id: string }>> = async () => {
      throw new Error("catalog down");
    };
    const catalogClient = {
      createSession: () => Promise.reject(new Error("x")),
      listModels: () => catalogModelsFn(),
    } as unknown as SdkClient;
    const catalog = new ModelCatalog(() => catalogClient);
    await catalog.refresh();
    expect(catalog.getState().kind).toBe("error");

    const agent = makeAgent(h, denyAll, { catalog });
    await agent.init();
    expect(agent.hasDeferredSession()).toBe(true);

    // Catalog "recovers" — refresh returns chat models. The agent
    // subscription should auto-trigger tryRecoverDeferred which
    // builds the SDK session. Per-session listModels is still
    // broken (catalog's ready chatModels are used via the resolver).
    catalogModelsFn = async () => [{ id: "gpt-4o" }];
    await catalog.refresh();
    // Allow microtasks queued by the subscriber to drain.
    await new Promise((r) => setTimeout(r, 0));
    expect(catalog.getState().kind).toBe("ready");
    expect(agent.hasDeferredSession()).toBe(false);
    expect(agent.getModel()).toBe("gpt-4o");
    expect(h.lastCreateSession.model).toBe("gpt-4o");

    // sendMessage now works.
    h.setSendResponse({ data: { content: "hello" } });
    const reply = await agent.sendMessage("ping");
    expect(reply.content).toBe("hello");
    await agent.dispose();
  });

  test("MCP Readiness UX Phase 2: tryRecoverDeferred emits start/resolved when catalog transitions to ready", async () => {
    // Deferred-init flow (`ImplementationPlan.md:297-304`): init()
    // returns without calling the gate (createSession is deferred
    // because catalog is non-ready). Later, when the catalog
    // recovers, `tryRecoverDeferred` fires — and IT calls the gate.
    // The pill must therefore see start/resolved on this path too,
    // not only on init/resetConversation.
    const h = makeFakeSdk();
    (h.client as { listModels: () => Promise<unknown> }).listModels =
      async () => {
        throw new Error("client.listModels boom");
      };
    const { ModelCatalog } = await import("./ModelCatalog");
    let catalogModelsFn: () => Promise<Array<{ id: string }>> = async () => {
      throw new Error("catalog down");
    };
    const catalogClient = {
      createSession: () => Promise.reject(new Error("x")),
      listModels: () => catalogModelsFn(),
    } as unknown as SdkClient;
    const catalog = new ModelCatalog(() => catalogClient);
    await catalog.refresh();
    expect(catalog.getState().kind).toBe("error");

    const events: Array<"start" | "resolved"> = [];
    const agent = new CopilotAgentSession(
      {
        cliPath: "/fake/copilot.exe",
        gitHubToken: "fake-token",
        baseDirectory: "/fake/plugin",
        decider: denyAll,
        catalog,
        mcpReadinessGate: async () => undefined,
        onReadinessGateEvent: (kind) => events.push(kind),
      },
      async () => h.sdk,
    );
    await agent.init();
    // Init deferred — gate NOT called yet.
    expect(agent.hasDeferredSession()).toBe(true);
    expect(events).toEqual([]);
    // Catalog recovers → tryRecoverDeferred fires → gate is called.
    catalogModelsFn = async () => [{ id: "gpt-4o" }];
    await catalog.refresh();
    await new Promise((r) => setTimeout(r, 0));
    expect(agent.hasDeferredSession()).toBe(false);
    // start/resolved must have fired exactly once during recovery.
    expect(events).toEqual(["start", "resolved"]);
    await agent.dispose();
  });

  test("deferred → swapModel(newId) creates the SDK session in-place (user explicit pick path)", async () => {
    const h = makeFakeSdk();
    (h.client as { listModels: () => Promise<unknown> }).listModels =
      async () => {
        throw new Error("boom");
      };
    const { ModelCatalog } = await import("./ModelCatalog");
    const catalog = new ModelCatalog(
      () =>
        ({
          createSession: () => Promise.reject(new Error("x")),
          listModels: async () => {
            throw new Error("catalog down");
          },
        }) as unknown as SdkClient,
    );
    await catalog.refresh();

    const agent = makeAgent(h, denyAll, { catalog });
    await agent.init();
    expect(agent.hasDeferredSession()).toBe(true);

    // User picks an id from the (degraded) picker — this should
    // still create the session via the explicit preferred id path.
    await agent.swapModel("gpt-4o");
    expect(agent.hasDeferredSession()).toBe(false);
    expect(agent.getModel()).toBe("gpt-4o");
    expect(h.lastCreateSession.model).toBe("gpt-4o");
    await agent.dispose();
  });

  test("hasPendingApprovals on a deferred agent is false (no pending approvals possible)", async () => {
    const h = makeFakeSdk();
    (h.client as { listModels: () => Promise<unknown> }).listModels =
      async () => {
        throw new Error("boom");
      };
    const { ModelCatalog } = await import("./ModelCatalog");
    const catalog = new ModelCatalog(
      () =>
        ({
          createSession: () => Promise.reject(new Error("x")),
          listModels: async () => {
            throw new Error("down");
          },
        }) as unknown as SdkClient,
    );
    await catalog.refresh();
    const agent = makeAgent(h, denyAll, { catalog });
    await agent.init();
    expect(agent.hasDeferredSession()).toBe(true);
    expect(agent.hasPendingApprovals()).toBe(false);
    await agent.dispose();
  });
});

// ---------- MCP Readiness UX: applyToolListChange via session.setTools ----------

describe("CopilotAgentSession — applyToolListChange (session.setTools)", () => {
  test("hasLiveToolUpdate returns false when session has no setTools primitive", async () => {
    // Default fake SDK session in makeFakeSdk has no setTools.
    const h = makeFakeSdk();
    const agent = makeAgent(h, denyAll);
    expect(agent.hasLiveToolUpdate()).toBe(false); // pre-init
    await agent.init();
    expect(agent.hasLiveToolUpdate()).toBe(false); // post-init
    await agent.dispose();
  });

  test("hasLiveToolUpdate returns true when session exposes setTools primitive", async () => {
    const h = makeFakeSdk();
    (h.session as unknown as { setTools: () => Promise<void> }).setTools =
      async () => {};
    const agent = makeAgent(h, denyAll);
    await agent.init();
    expect(agent.hasLiveToolUpdate()).toBe(true);
    await agent.dispose();
  });

  test("applyToolListChange is a no-op when session is not yet created (pre-init)", async () => {
    // The watcher can fire onTransition before any conversation has
    // been activated — the plugin holds a session-less runtime in
    // that case. Must not throw and must not log noise.
    const h = makeFakeSdk();
    const agent = makeAgent(h, denyAll);
    await expect(agent.applyToolListChange()).resolves.toBeUndefined();
    await agent.dispose();
  });

  test("applyToolListChange logs no-op fallback once when session lacks setTools (FR-011)", async () => {
    // Strict no-op: FR-011 requires the plugin to not pretend the
    // update succeeded when it can't. We log at debug once so the
    // fallback is visible in diagnostics but a flapping server
    // can't spam the console.
    const h = makeFakeSdk();
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
    try {
      const agent = makeAgent(h, denyAll);
      await agent.init();
      await agent.applyToolListChange();
      await agent.applyToolListChange();
      await agent.applyToolListChange();
      const fallbackLogs = debugSpy.mock.calls.filter((args) =>
        String(args[0] ?? "").includes("FR-011 fallback"),
      );
      expect(fallbackLogs.length).toBe(1);
      await agent.dispose();
    } finally {
      debugSpy.mockRestore();
    }
  });

  test("applyToolListChange calls session.setTools with merged tools when primitive is present", async () => {
    // Planning-docs S1: the SDK receives the FULL merged tool list
    // (base custom + MCP), not an MCP-only list — otherwise the
    // session's conversation-specific custom tools would be
    // silently deleted.
    const h = makeFakeSdk();
    const updateCalls: Array<unknown[]> = [];
    (h.session as unknown as {
      setTools: (tools: unknown) => Promise<void>;
    }).setTools = async (tools) => {
      updateCalls.push([tools]);
    };
    const mcpToolsList = [{ name: "mcp:svc/hello" }] as unknown as SdkTool[];
    const agent = new CopilotAgentSession(
      {
        cliPath: "/fake/copilot.exe",
        gitHubToken: "fake-token",
        baseDirectory: "/fake/plugin",
        decider: denyAll,
        tools: [{ name: "read_file" }, { name: "write_file" }],
        mcpTools: () => mcpToolsList,
      },
      async () => h.sdk,
    );
    await agent.init();
    await agent.applyToolListChange();
    expect(updateCalls.length).toBe(1);
    const applied = updateCalls[0][0] as Array<{ name: string }>;
    // Must contain both custom (base) and MCP tools.
    expect(applied.map((t) => t.name).sort()).toEqual(
      ["mcp:svc/hello", "read_file", "write_file"].sort(),
    );
    await agent.dispose();
  });

  test("applyToolListChange latches during streaming and drains once with last-write-wins snapshot", async () => {
    // Turn-boundary queueing: two transitions during a stream must
    // result in exactly ONE drain call using the LATEST mcpTools
    // snapshot at drain time (not the snapshot at latch time).
    const h = makeFakeSdk();
    const updateCalls: Array<Array<{ name: string }>> = [];
    (h.session as unknown as {
      setTools: (tools: unknown) => Promise<void>;
    }).setTools = async (tools) => {
      updateCalls.push((tools ?? []) as Array<{ name: string }>);
    };
    // Hold sendAndWait open until we say so, so isStreamingFlag stays true.
    const sendGate = deferred<unknown>();
    h.session.sendAndWait = async () => sendGate.promise;
    let mcpSnapshot: Array<{ name: string }> = [{ name: "mcp:v1" }];
    const agent = new CopilotAgentSession(
      {
        cliPath: "/fake/copilot.exe",
        gitHubToken: "fake-token",
        baseDirectory: "/fake/plugin",
        decider: denyAll,
        tools: [{ name: "read_file" }],
        mcpTools: () => mcpSnapshot as unknown as SdkTool[],
      },
      async () => h.sdk,
    );
    await agent.init();
    const iter = agent.sendMessageStreaming("hi")[Symbol.asyncIterator]();
    // Start the iterator body; it will suspend inside the queue loop
    // waiting for sendAndWait to settle. isStreamingFlag flips true
    // before that suspension.
    const nextP = iter.next();
    await new Promise((r) => setTimeout(r, 0));
    // First transition: latches.
    mcpSnapshot = [{ name: "mcp:v1" }, { name: "mcp:v2" }];
    await agent.applyToolListChange();
    // Second transition: latch already set — last-write-wins.
    mcpSnapshot = [{ name: "mcp:final" }];
    await agent.applyToolListChange();
    expect(updateCalls.length).toBe(0); // still latched
    // Now let sendAndWait resolve so the generator can complete.
    sendGate.resolve({ data: { content: "ok" } });
    // Drain the terminal event and finish the iterator.
    const first = await nextP;
    if (!first.done) {
      while (true) {
        const step = await iter.next();
        if (step.done) break;
      }
    }
    // Give the fire-and-forget drain a microtask to complete.
    await new Promise((r) => setTimeout(r, 10));
    // Exactly one drain, using the FINAL snapshot at drain time.
    expect(updateCalls.length).toBe(1);
    expect(updateCalls[0].map((t) => t.name).sort()).toEqual(
      ["mcp:final", "read_file"].sort(),
    );
    await agent.dispose();
  });

  test("applyToolListChange applies immediately when session is idle (not streaming)", async () => {
    const h = makeFakeSdk();
    const updateCalls: unknown[] = [];
    (h.session as unknown as {
      setTools: (tools: unknown) => Promise<void>;
    }).setTools = async (tools) => {
      updateCalls.push(tools);
    };
    const agent = makeAgent(h, denyAll);
    await agent.init();
    await agent.applyToolListChange();
    expect(updateCalls.length).toBe(1);
    await agent.dispose();
  });

  test("dispose drops any pending tool-update latch (post-dispose safety)", async () => {
    // If a transition latched during a stream and the user
    // dispatched dispose() before the drain fired, the drain must
    // not call into the dead session.
    const h = makeFakeSdk();
    const updateCalls: unknown[] = [];
    (h.session as unknown as {
      setTools: (tools: unknown) => Promise<void>;
    }).setTools = async (tools) => {
      updateCalls.push(tools);
    };
    const sendGate = deferred<unknown>();
    h.session.sendAndWait = async () => sendGate.promise;
    const agent = makeAgent(h, denyAll);
    await agent.init();
    const iter = agent.sendMessageStreaming("hi")[Symbol.asyncIterator]();
    const nextP = iter.next();
    await new Promise((r) => setTimeout(r, 0));
    await agent.applyToolListChange(); // latches
    // Now dispose while the latch is set and the stream is in flight.
    await agent.dispose();
    // Release the gate so the generator can unwind cleanly.
    sendGate.resolve({ data: { content: "ok" } });
    // Drain the iterator to release its resources.
    try {
      const first = await nextP;
      if (!first.done) {
        while (true) {
          const step = await iter
            .next()
            .catch(() => ({ done: true, value: undefined }));
          if (step.done) break;
        }
      }
    } catch {
      /* dispose may have already torn things down */
    }
    await new Promise((r) => setTimeout(r, 10));
    const postDisposeCalls = updateCalls.length;
    // A subsequent applyToolListChange must remain a no-op after dispose.
    await agent.applyToolListChange();
    expect(updateCalls.length).toBe(postDisposeCalls);
    // And post-dispose hasLiveToolUpdate must report false.
    expect(agent.hasLiveToolUpdate()).toBe(false);
  });

  test("applyToolListChange swallows SDK errors (never crashes plugin)", async () => {
    // A misbehaving SDK primitive must not propagate to the
    // watcher subscription in main.ts. The next transition will
    // retry with a fresh snapshot.
    const h = makeFakeSdk();
    (h.session as unknown as {
      setTools: () => Promise<void>;
    }).setTools = async () => {
      throw new Error("SDK boom");
    };
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const agent = makeAgent(h, denyAll);
      await agent.init();
      await expect(agent.applyToolListChange()).resolves.toBeUndefined();
      // Warning was logged so the failure is diagnosable.
      const relevant = warnSpy.mock.calls.filter((args) =>
        String(args[0] ?? "").includes("SDK setTools threw"),
      );
      expect(relevant.length).toBe(1);
      await agent.dispose();
    } finally {
      warnSpy.mockRestore();
    }
  });

  test("dispose during an in-flight setTools swallows the rejection without warning", async () => {
    const h = makeFakeSdk();
    const gate = deferred<void>();
    (h.session as unknown as {
      setTools: () => Promise<void>;
    }).setTools = () => gate.promise;
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const agent = makeAgent(h, denyAll);
      await agent.init();
      const p = agent.applyToolListChange();
      await agent.dispose();
      gate.reject(new Error("Session is disconnected"));
      await expect(p).resolves.toBeUndefined();
      const relevant = warnSpy.mock.calls.filter((args) =>
        String(args[0] ?? "").includes("SDK setTools threw"),
      );
      expect(relevant.length).toBe(0);
    } finally {
      warnSpy.mockRestore();
    }
  });

  test("applyToolListChange passes [] (not undefined) when the merged tool list is empty", async () => {
    // setTools([]) removes every client tool; undefined is not a valid
    // argument. toolsForSession() returns undefined for an empty list
    // (createSession convention), so the call site must coalesce.
    const h = makeFakeSdk();
    const calls: unknown[] = [];
    (h.session as unknown as {
      setTools: (tools: unknown) => Promise<void>;
    }).setTools = async (tools) => {
      calls.push(tools);
    };
    const agent = new CopilotAgentSession(
      {
        cliPath: "/fake/copilot.exe",
        gitHubToken: "fake-token",
        baseDirectory: "/fake/plugin",
        decider: denyAll,
        tools: [],
        mcpTools: () => [],
      },
      async () => h.sdk,
    );
    await agent.init();
    await agent.applyToolListChange();
    expect(calls).toEqual([[]]);
    await agent.dispose();
  });

  test("legacy updateTools name is ignored (never shipped in the SDK)", async () => {
    const h = makeFakeSdk();
    let called = false;
    (h.session as unknown as { updateTools: () => Promise<void> }).updateTools =
      async () => {
        called = true;
      };
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
    try {
      const agent = makeAgent(h, denyAll);
      await agent.init();
      expect(agent.hasLiveToolUpdate()).toBe(false);
      await agent.applyToolListChange();
      expect(called).toBe(false);
      await agent.dispose();
    } finally {
      debugSpy.mockRestore();
    }
  });
});

describe("CopilotAgentSession follow-ups (steering and queueing)", () => {
  type Handler = (event: unknown) => void;

  function wireBus(h: FakeHandles) {
    const handlers = new Map<string, Handler>();
    h.session.on = ((eventType: string, handler: Handler) => {
      handlers.set(eventType, handler);
      return () => handlers.delete(eventType);
    }) as SdkSession["on"];
    const emit = (type: string, event: Record<string, unknown> = {}) =>
      handlers.get(type)?.({ type, ...event });
    const sends: Array<{ prompt: string; mode?: string; clientTurnId?: string }> = [];
    let n = 0;
    h.session.send = async (opts) => {
      sends.push(opts);
      n += 1;
      return `msg-${n}`;
    };
    const run = deferred<unknown>();
    h.session.sendAndWait = (prompt) => {
      h.sendCalls.push(prompt);
      return run.promise;
    };
    return { emit, sends, run, handlers };
  }

  async function startStream(agent: CopilotAgentSession) {
    let ready = false;
    const unsub = agent.onFollowUpAvailabilityChange(() => {
      ready = agent.canSendFollowUp();
    });
    const iter = agent.sendMessageStreaming("first")[Symbol.asyncIterator]();
    const events: StreamEvent[] = [];
    let finished = false;
    const pump = (async () => {
      try {
        while (true) {
          const r = await iter.next();
          if (r.done) break;
          events.push(r.value);
        }
      } finally {
        finished = true;
        unsub();
      }
    })();
    await flush();
    return { events, pump, isFinished: () => finished, isReady: () => ready };
  }

  const flush = () => new Promise((r) => setTimeout(r, 0));

  test("steering consumed mid-run splits segments and keeps the stream until idle", async () => {
    const h = makeFakeSdk();
    const bus = wireBus(h);
    const agent = makeAgent(h);
    await agent.init();
    const s = await startStream(agent);

    expect(s.isReady()).toBe(true);
    expect(agent.canSendFollowUp()).toBe(true);
    await agent.sendFollowUp("f1", "use bullet points", "steer");
    expect(bus.sends).toEqual([
      { prompt: "use bullet points", mode: "immediate", clientTurnId: "f1" },
    ]);

    bus.emit("assistant.message", { data: { content: "Draft one" } });
    bus.emit("user.message", {
      data: { content: "use bullet points", clientTurnId: "f1", delivery: "steering" },
    });
    bus.emit("assistant.message", { data: { content: "- one\n- two" } });
    bus.emit("session.idle");
    bus.run.resolve({ data: { content: "- one\n- two" } });
    await s.pump;

    expect(s.events).toEqual([
      {
        type: "follow_up_consumed",
        id: "f1",
        text: "use bullet points",
        mode: "steer",
        previousSegmentContent: "Draft one",
      },
      { type: "complete", content: "- one\n- two", toolCalls: [] },
    ]);
    expect(agent.canSendFollowUp()).toBe(false);
    await agent.dispose();
  });

  test("queued follow-up keeps the stream open past sendAndWait until its run idles", async () => {
    const h = makeFakeSdk();
    const bus = wireBus(h);
    const agent = makeAgent(h);
    await agent.init();
    const s = await startStream(agent);

    await agent.sendFollowUp("q1", "then summarise", "queue");
    expect(bus.sends[0]).toMatchObject({ mode: "enqueue", clientTurnId: "q1" });

    bus.emit("assistant.message", { data: { content: "Answer one" } });
    bus.run.resolve({ data: { content: "Answer one" } });
    await flush();
    expect(s.isFinished()).toBe(false);

    bus.emit("user.message", { data: { messageId: "msg-1", delivery: "queued" } });
    bus.emit("assistant.message", { data: { content: "Summary" } });
    await flush();
    expect(s.isFinished()).toBe(false);
    bus.emit("session.idle");
    await s.pump;

    expect(s.events.map((e) => e.type)).toEqual(["follow_up_consumed", "complete"]);
    expect(s.events[1]).toMatchObject({ type: "complete", content: "Summary" });
    await agent.dispose();
  });

  test("withdrawing an unread follow-up removes it so the stream ends at settle", async () => {
    const h = makeFakeSdk();
    const bus = wireBus(h);
    const withdrawCalls: unknown[] = [];
    h.session.rpc = {
      queue: {
        withdrawMessage: async (p) => {
          withdrawCalls.push(p);
          return { removed: true };
        },
      },
    };
    const agent = makeAgent(h);
    await agent.init();
    const s = await startStream(agent);

    await agent.sendFollowUp("q1", "later", "queue");
    expect(await agent.withdrawFollowUp("q1")).toBe(true);
    expect(withdrawCalls).toEqual([{ messageId: "msg-1", expectedPrompt: "later" }]);

    bus.run.resolve({ data: { content: "done" } });
    await s.pump;
    expect(s.events).toEqual([{ type: "complete", content: "done", toolCalls: [] }]);
    expect(h.abortCalls).toBe(0);
    await agent.dispose();
  });

  test("cancelCurrent ends a stream that is waiting on a queued run", async () => {
    const h = makeFakeSdk();
    const bus = wireBus(h);
    const agent = makeAgent(h);
    await agent.init();
    const s = await startStream(agent);

    await agent.sendFollowUp("q1", "later", "queue");
    bus.run.resolve({ data: { content: "done" } });
    await flush();
    expect(s.isFinished()).toBe(false);

    await agent.cancelCurrent();
    await s.pump;
    expect(h.abortCalls).toBe(1);
    expect(s.events).toEqual([{ type: "complete", content: "done", toolCalls: [] }]);
    await agent.dispose();
  });

  test("a failed follow-up send rejects and does not hold the stream open", async () => {
    const h = makeFakeSdk();
    const bus = wireBus(h);
    h.session.send = async () => {
      throw new Error("send failed");
    };
    const agent = makeAgent(h);
    await agent.init();
    const s = await startStream(agent);

    await expect(agent.sendFollowUp("f1", "x", "steer")).rejects.toThrow("send failed");
    bus.run.resolve({ data: { content: "done" } });
    await s.pump;
    expect(s.events).toEqual([{ type: "complete", content: "done", toolCalls: [] }]);
    await agent.dispose();
  });

  test("sendFollowUp rejects when no stream is live", async () => {
    const h = makeFakeSdk();
    wireBus(h);
    const agent = makeAgent(h);
    await agent.init();
    expect(agent.canSendFollowUp()).toBe(false);
    await expect(agent.sendFollowUp("f1", "x", "steer")).rejects.toThrow(/No reply/);
    await agent.dispose();
  });

  test("an idle that arrives before the send is acknowledged still ends the stream", async () => {
    const h = makeFakeSdk();
    const bus = wireBus(h);
    const ack = deferred<string>();
    h.session.send = () => ack.promise;
    const agent = makeAgent(h);
    await agent.init();
    const s = await startStream(agent);

    const sending = agent.sendFollowUp("q1", "next", "queue");
    bus.run.resolve({ data: { content: "one" } });
    bus.emit("user.message", { data: { clientTurnId: "q1", delivery: "queued" } });
    bus.emit("assistant.message", { data: { content: "two" } });
    bus.emit("session.idle");
    ack.resolve("msg-1");
    await sending;
    await s.pump;
    expect(s.events.at(-1)).toMatchObject({ type: "complete", content: "two" });
    await agent.dispose();
  });

  test("a withdrawal that wins after consumption drops the transcript split", async () => {
    const h = makeFakeSdk();
    const bus = wireBus(h);
    const withdrawn = deferred<{ removed: boolean; interrupted?: boolean }>();
    h.session.rpc = { queue: { withdrawMessage: () => withdrawn.promise } };
    const agent = makeAgent(h);
    await agent.init();
    const s = await startStream(agent);

    await agent.sendFollowUp("f1", "oops", "steer");
    const result = agent.withdrawFollowUp("f1");
    await flush();
    bus.emit("assistant.message_delta", { data: { deltaContent: "Draft" } });
    bus.emit("assistant.message", { data: { content: "Draft" } });
    bus.emit("user.message", { data: { clientTurnId: "f1", delivery: "steering" } });
    bus.emit("assistant.message_delta", { data: { deltaContent: "more" } });
    bus.emit("assistant.message", { data: { content: "more" } });
    await flush();
    expect(s.events).toEqual([{ type: "delta", text: "Draft" }]);

    withdrawn.resolve({ removed: true, interrupted: true });
    expect(await result).toBe(true);
    bus.run.resolve({ data: { content: "Draft" } });
    await s.pump;
    expect(s.events).toEqual([
      { type: "delta", text: "Draft" },
      { type: "complete", content: "Draft", toolCalls: [] },
    ]);
    await agent.dispose();
  });

  test("a withdrawal that loses releases the held consumption in order", async () => {
    const h = makeFakeSdk();
    const bus = wireBus(h);
    const withdrawn = deferred<{ removed: boolean }>();
    h.session.rpc = { queue: { withdrawMessage: () => withdrawn.promise } };
    const agent = makeAgent(h);
    await agent.init();
    const s = await startStream(agent);

    await agent.sendFollowUp("f1", "keep", "steer");
    const result = agent.withdrawFollowUp("f1");
    await flush();
    bus.emit("user.message", { data: { clientTurnId: "f1", delivery: "steering" } });
    bus.emit("assistant.message_delta", { data: { deltaContent: "after" } });
    withdrawn.resolve({ removed: false });
    expect(await result).toBe(false);
    bus.emit("session.idle");
    bus.run.resolve({ data: { content: "x" } });
    await s.pump;
    expect(s.events.map((e) => e.type)).toEqual(["follow_up_consumed", "delta", "complete"]);
    await agent.dispose();
  });

  test("a session.error in a queued run fails the stream", async () => {
    const h = makeFakeSdk();
    const bus = wireBus(h);
    const agent = makeAgent(h);
    await agent.init();
    const s = await startStream(agent);

    await agent.sendFollowUp("q1", "next", "queue");
    bus.run.resolve({ data: { content: "one" } });
    bus.emit("session.error", {
      data: { message: "rate limited", originatingMessageId: "msg-1" },
    });
    await expect(s.pump).rejects.toThrow("rate limited");
    await agent.dispose();
  });

  test("a follow-up that fails to send after an earlier run idled doesn't hang the stream", async () => {
    const h = makeFakeSdk();
    const bus = wireBus(h);
    const agent = makeAgent(h);
    await agent.init();
    const s = await startStream(agent);

    await agent.sendFollowUp("q1", "next", "queue");
    bus.run.resolve({ data: { content: "one" } });
    bus.emit("user.message", { data: { clientTurnId: "q1", delivery: "queued" } });
    bus.emit("assistant.message", { data: { content: "two" } });
    h.session.send = async () => {
      throw new Error("send failed");
    };
    bus.emit("session.idle");
    await expect(agent.sendFollowUp("q2", "later", "queue")).rejects.toThrow("send failed");
    await s.pump;
    expect(s.events.at(-1)).toMatchObject({ type: "complete", content: "two" });
    await agent.dispose();
  });

  test("a split omits the segment's final text when deltas streamed past it", async () => {
    const h = makeFakeSdk();
    const bus = wireBus(h);
    const agent = makeAgent(h);
    await agent.init();
    const s = await startStream(agent);

    await agent.sendFollowUp("f1", "steer", "steer");
    bus.emit("assistant.message", { data: { content: "Checking…" } });
    bus.emit("assistant.message_delta", { data: { deltaContent: "Found 3" } });
    bus.emit("user.message", { data: { clientTurnId: "f1", delivery: "steering" } });
    bus.emit("session.idle");
    bus.run.resolve({ data: { content: "x" } });
    await s.pump;
    const consumed = s.events.find((e) => e.type === "follow_up_consumed");
    expect(consumed).toMatchObject({ previousSegmentContent: undefined });
    await agent.dispose();
  });

  test("dispose fails a stream that is waiting on a queued run", async () => {
    const h = makeFakeSdk();
    const bus = wireBus(h);
    const agent = makeAgent(h);
    await agent.init();
    const s = await startStream(agent);

    await agent.sendFollowUp("q1", "next", "queue");
    bus.run.resolve({ data: { content: "one" } });
    await flush();
    await agent.dispose();
    await expect(s.pump).rejects.toThrow(/Session ended/);
  });

  test("Stop during an in-flight send re-aborts once the send lands", async () => {
    const h = makeFakeSdk();
    const bus = wireBus(h);
    const ack = deferred<string>();
    h.session.send = () => ack.promise;
    const agent = makeAgent(h);
    await agent.init();
    const s = await startStream(agent);

    const sending = agent.sendFollowUp("q1", "next", "queue");
    bus.run.resolve({ data: { content: "one" } });
    await agent.cancelCurrent();
    await flush();
    expect(s.isFinished()).toBe(false);
    ack.resolve("msg-1");
    await sending;
    await s.pump;
    expect(h.abortCalls).toBe(2);
    await agent.dispose();
  });
});
