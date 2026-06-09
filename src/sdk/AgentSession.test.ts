import { describe, expect, test, vi } from "vitest";
import {
  CopilotAgentSession,
  type SdkClient,
  type SdkModule,
  type SdkPermissionRequest,
  type SdkPermissionResult,
  type SdkSession,
} from "./AgentSession";
import { denyAll } from "../domain/PermissionDecision";

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

function makeAgent(handles: FakeHandles, decider = denyAll) {
  return new CopilotAgentSession(
    {
      cliPath: "/fake/copilot.exe",
      gitHubToken: "fake-token",
      baseDirectory: "/fake/plugin",
      decider,
    },
    async () => handles.sdk,
  );
}

describe("CopilotAgentSession", () => {
  test("init() starts client, pings, and creates a session with builtin tools exposed", async () => {
    const h = makeFakeSdk();
    const agent = makeAgent(h);
    await agent.init();

    expect(h.startCalls).toBe(1);
    expect(h.pingCalls).toBe(1);
    expect(h.lastCreateSession.model).toBe("gpt-4.1");
    expect(h.lastCreateSession.availableTools).toEqual(["builtin:*"]);
    expect(h.permissionHandler).toBeTypeOf("function");
    expect(agent.getModel()).toBe("gpt-4.1");

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
    // unsubscribed each event subscription exactly once. Phase 5
    // subscribes to delta + tool.start + tool.complete = 3 subs.
    expect(abortCalls).toBe(1);
    expect(unsubCalls).toBe(3);

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
