import { describe, expect, test, vi } from "vitest";
import { createMcpSdkTools } from "./McpToolBridge";
import type { McpToolRegistrySnapshot } from "./McpToolRegistry";
import type { McpServerId } from "./McpTypes";

describe("McpToolBridge", () => {
  test("approved synthetic id routes to correct server and tool", async () => {
    const callTool = vi.fn(async () => ({ content: [{ type: "text", text: "ok" }] }));
    const [tool] = createMcpSdkTools(snapshot(), { manager: { callTool } as never });
    await expect((tool as never as { handler: (args: unknown) => Promise<unknown> }).handler({ a: 1 })).resolves.toBe("ok");
    expect(callTool).toHaveBeenCalledWith("s1", "read__File", { a: 1 });
  });

  test("rejection skips tools/call", async () => {
    const callTool = vi.fn();
    const [tool] = createMcpSdkTools(snapshot(), {
      manager: { callTool } as never,
      approval: () => "rejected",
    });
    await expect((tool as never as { handler: (args: unknown) => Promise<unknown> }).handler({})).rejects.toThrow(/rejected/);
    expect(callTool).not.toHaveBeenCalled();
  });

  test("cancelled and crash failures finalize as errors without undo ids", async () => {
    const err = new Error("cancelled");
    err.name = "CancelledError";
    const [tool] = createMcpSdkTools(snapshot(), { manager: { callTool: vi.fn(async () => { throw err; }) } as never });
    await expect((tool as never as { handler: (args: unknown) => Promise<unknown> }).handler({})).rejects.toThrow(/cancelled/);
    expect("undoId" in (tool as object)).toBe(false);
  });

  test("isError and JSON-RPC error surface as tool-result content (not thrown)", async () => {
    // Industry pattern: return errors as content so LLM/UI always see the message.
    // Hard invocation failures (unavailable, cancelled, timed out) still throw — see other tests.
    const mcpErr = createMcpSdkTools(snapshot(), { manager: { callTool: vi.fn(async () => ({ isError: true, content: [{ type: "text", text: "tool failed" }] })) } as never })[0];
    await expect((mcpErr as never as { handler: (args: unknown) => Promise<unknown> }).handler({})).resolves.toBe("Error: MCP tool reported error: tool failed");
    const rpcErr = createMcpSdkTools(snapshot(), { manager: { callTool: vi.fn(async () => ({ error: { message: "rpc failed" } })) } as never })[0];
    await expect((rpcErr as never as { handler: (args: unknown) => Promise<unknown> }).handler({})).resolves.toMatch(/^Error: MCP JSON-RPC error:[\s\S]*rpc failed/);
  });

  test("empty-content tool error still surfaces a non-empty message", async () => {
    // Regression: prior code returned "" for `{isError: true, content: []}`, causing the
    // SDK to render the useless generic "Tool execution failed" fallback. Now we always
    // include a fallback description so the user knows the tool errored.
    const [tool] = createMcpSdkTools(snapshot(), { manager: { callTool: vi.fn(async () => ({ isError: true, content: [] })) } as never });
    const result = await (tool as never as { handler: (args: unknown) => Promise<unknown> }).handler({});
    expect(result).toBe("Error: MCP tool reported error: (no error details returned by the server)");
  });

  test("60s default timeout finalizes a failed call", async () => {
    vi.useFakeTimers();
    try {
      const [tool] = createMcpSdkTools(snapshot(), { manager: { callTool: vi.fn(() => new Promise(() => undefined)) } as never });
      const call = (tool as never as { handler: (args: unknown) => Promise<unknown> }).handler({});
      const expectation = expect(call).rejects.toThrow(/timed out/);
      await vi.advanceTimersByTimeAsync(60_000);
      await expectation;
    } finally {
      vi.useRealTimers();
    }
  });

  test("removed between approval and dispatch aborts with cancelled", async () => {
    const callTool = vi.fn();
    const [tool] = createMcpSdkTools(snapshot(), {
      manager: { callTool, statusSnapshot: () => [] } as never,
      approval: async () => "approved",
    });
    await expect((tool as never as { handler: (args: unknown) => Promise<unknown> }).handler({})).rejects.toMatchObject({ name: "CancelledError" });
    expect(callTool).not.toHaveBeenCalled();
  });

  test("disabled between approval and dispatch aborts with cancelled", async () => {
    const callTool = vi.fn();
    const [tool] = createMcpSdkTools(snapshot(), {
      manager: { callTool, statusSnapshot: () => [{ id: "s1" as McpServerId, status: "connected", enabled: false }] } as never,
      approval: async () => "approved",
    });
    await expect((tool as never as { handler: (args: unknown) => Promise<unknown> }).handler({})).rejects.toMatchObject({ name: "CancelledError" });
    expect(callTool).not.toHaveBeenCalled();
  });

  test("server crash mid-call finalizes call with error", async () => {
    const [tool] = createMcpSdkTools(snapshot(), {
      manager: { callTool: vi.fn(async () => { throw new Error("server crashed"); }) } as never,
    });
    await expect((tool as never as { handler: (args: unknown) => Promise<unknown> }).handler({})).rejects.toThrow(/server crashed/);
  });

  test("late responses after abort are discarded", async () => {
    vi.useFakeTimers();
    const debug = vi.spyOn(console, "debug").mockImplementation(() => undefined);
    try {
      let resolve!: (value: unknown) => void;
      const callTool = vi.fn(() => new Promise((r) => { resolve = r; }));
      const [tool] = createMcpSdkTools(snapshot(), { manager: { callTool } as never, callTimeoutMs: 10 });
      const call = (tool as never as { handler: (args: unknown) => Promise<unknown> }).handler({});
      const expectation = expect(call).rejects.toThrow(/timed out/);
      await vi.advanceTimersByTimeAsync(10);
      resolve({ content: [{ type: "text", text: "late ok" }] });
      await vi.runAllTimersAsync();
      await expectation;
      expect(debug).toHaveBeenCalled();
    } finally {
      debug.mockRestore();
      vi.useRealTimers();
    }
  });

  test("Stop cancellation forwards AbortSignal and logs late response discard", async () => {
    const debug = vi.spyOn(console, "debug").mockImplementation(() => undefined);
    try {
      let resolve!: (value: unknown) => void;
      const callTool = vi.fn((_server, _tool, _args, _options?: { signal?: AbortSignal }) =>
        new Promise((r) => {
          resolve = r;
        }));
      const [tool] = createMcpSdkTools(snapshot(), { manager: { callTool } as never });
      const controller = new AbortController();
      const call = (tool as never as { handler: (args: unknown, invocation?: unknown) => Promise<unknown> }).handler({ secret: "x" }, { signal: controller.signal });
      controller.abort();
      await expect(call).rejects.toMatchObject({ name: "CancelledError" });
      resolve({ content: [{ type: "text", text: "late" }] });
      await new Promise((r) => setTimeout(r, 0));
      expect(callTool.mock.calls[0][3]).toMatchObject({ signal: controller.signal });
    } finally {
      debug.mockRestore();
    }
  });
});

function snapshot(): McpToolRegistrySnapshot {
  return Object.freeze({
    tools: Object.freeze([
      Object.freeze({
        serverId: "s1" as McpServerId,
        serverName: "Server",
        toolName: "read__File",
        syntheticId: "mcp__s1__read__File",
      }),
    ]),
    rejected: Object.freeze([]),
    instructionsByServer: Object.freeze({}),
  });
}
