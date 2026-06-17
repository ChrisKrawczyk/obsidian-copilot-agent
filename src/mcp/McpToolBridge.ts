import { defineTool, type Tool } from "@github/copilot-sdk";
import type { McpManager } from "./McpManager";
import type { McpToolRegistrySnapshot } from "./McpToolRegistry";
import { normalizeMcpArgs, normalizeMcpResult } from "./normalizeMcpResult";

export interface McpToolBridgeOptions {
  manager: Pick<McpManager, "callTool">;
  approval?: (toolCall: { syntheticId: string; args: unknown }) => Promise<"approved" | "rejected"> | "approved" | "rejected";
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
        const raw = await options.manager.callTool(entry.serverId, entry.toolName, args && typeof args === "object" ? args as Record<string, unknown> : {});
        const normalized = normalizeMcpResult(raw);
        if (normalized.isError) throw new Error(normalized.content);
        return normalized.content;
      },
    }),
  ) as unknown as Tool[];
}

export function mcpArgsPreview(args: unknown): string {
  return normalizeMcpArgs(args);
}
