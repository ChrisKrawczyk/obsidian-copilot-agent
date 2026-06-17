import { defineTool, type Tool } from "@github/copilot-sdk";
import type { McpManager } from "./McpManager";
import type { McpToolRegistrySnapshot } from "./McpToolRegistry";
import { normalizeMcpArgs, normalizeMcpResult } from "./normalizeMcpResult";
import { MCP_CALL_TIMEOUT_MS } from "./McpServerRuntime";

export interface McpToolBridgeOptions {
  manager: Pick<McpManager, "callTool"> & Partial<Pick<McpManager, "statusSnapshot">>;
  approval?: (toolCall: { syntheticId: string; args: unknown }) => Promise<"approved" | "rejected"> | "approved" | "rejected";
  callTimeoutMs?: number;
  setTimeout?: typeof setTimeout;
  clearTimeout?: typeof clearTimeout;
}

export function createMcpSdkTools(snapshot: McpToolRegistrySnapshot, options: McpToolBridgeOptions): Tool[] {
  return snapshot.tools.map((entry) =>
    defineTool(entry.syntheticId, {
      description: entry.description ?? `MCP tool ${entry.toolName} from ${entry.serverName}`,
      parameters: entry.inputSchema as Parameters<typeof defineTool>[1]["parameters"],
      skipPermission: false,
      handler: async (args: unknown) => {
        const decision = await Promise.resolve(options.approval?.({ syntheticId: entry.syntheticId, args }) ?? "approved");
        if (decision !== "approved") {
          const err = new Error("MCP tool call rejected by approval policy.");
          (err as Error & { cancelled?: boolean }).cancelled = true;
          throw err;
        }
        const statuses = options.manager.statusSnapshot?.();
        const status = statuses?.find((snapshot) => snapshot.id === entry.serverId);
        if (statuses && (!status || status.status !== "connected")) throw cancelledError("MCP server is disabled, removed, or disconnected.");
        if ((status as typeof status & { enabled?: boolean } | undefined)?.enabled === false) {
          throw cancelledError("MCP server is disabled, removed, or disconnected.");
        }
        const raw = await withTimeout(
          options.manager.callTool(entry.serverId, entry.toolName, args && typeof args === "object" ? args as Record<string, unknown> : {}),
          options.callTimeoutMs ?? MCP_CALL_TIMEOUT_MS,
          "MCP tool call timed out.",
          options.setTimeout,
          options.clearTimeout,
        );
        const normalized = normalizeMcpResult(raw);
        if (normalized.isError) {
          throw new Error(`${normalized.errorKind === "json-rpc" ? "MCP JSON-RPC error" : "MCP tool reported error"}: ${normalized.content}`);
        }
        return normalized.content;
      },
    }),
  ) as unknown as Tool[];
}

export function mcpArgsPreview(args: unknown): string {
  return normalizeMcpArgs(args);
}

function cancelledError(message: string): Error {
  const err = new Error(message);
  err.name = "CancelledError";
  (err as Error & { cancelled?: boolean }).cancelled = true;
  return err;
}

function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  message: string,
  setTimer: typeof setTimeout = setTimeout,
  clearTimer: typeof clearTimeout = clearTimeout,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimer(() => reject(new Error(message)), ms);
    promise.then(
      (value) => {
        clearTimer(timer);
        resolve(value);
      },
      (err) => {
        clearTimer(timer);
        reject(err);
      },
    );
  });
}
