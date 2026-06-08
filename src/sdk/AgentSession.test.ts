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
});
