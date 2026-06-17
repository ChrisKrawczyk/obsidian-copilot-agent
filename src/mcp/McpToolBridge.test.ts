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

  test("isError and JSON-RPC error surface distinctly", async () => {
    const mcpErr = createMcpSdkTools(snapshot(), { manager: { callTool: vi.fn(async () => ({ isError: true, content: [{ type: "text", text: "tool failed" }] })) } as never })[0];
    await expect((mcpErr as never as { handler: (args: unknown) => Promise<unknown> }).handler({})).rejects.toThrow(/tool failed/);
    const rpcErr = createMcpSdkTools(snapshot(), { manager: { callTool: vi.fn(async () => ({ error: { message: "rpc failed" } })) } as never })[0];
    await expect((rpcErr as never as { handler: (args: unknown) => Promise<unknown> }).handler({})).rejects.toThrow(/rpc failed/);
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
