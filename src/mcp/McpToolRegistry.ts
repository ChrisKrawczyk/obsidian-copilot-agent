import type { McpServerId, McpServerRuntimeSnapshot, McpToolInventoryEntry } from "./McpTypes";
import { parseSyntheticId, isValidMcpToolName } from "./McpToolIdentity";
import { redactSensitive } from "./redactSensitive";

export interface McpRegisteredTool extends McpToolInventoryEntry {
  instructions?: string;
}

export interface McpToolRegistrySnapshot {
  tools: readonly McpRegisteredTool[];
  rejected: readonly { serverId: McpServerId; toolName: string; reason: string }[];
  instructionsByServer: Readonly<Record<string, string>>;
}

export interface McpToolRegistryInput {
  inventory: readonly McpToolInventoryEntry[];
  statuses?: readonly (McpServerRuntimeSnapshot & { enabled?: boolean })[];
  builtinToolNames?: readonly string[];
  notify?: (message: string) => void;
}

export class McpToolRegistry {
  private snapshotValue: McpToolRegistrySnapshot = freezeSnapshot([], [], {});

  update(input: McpToolRegistryInput): McpToolRegistrySnapshot {
    this.snapshotValue = buildMcpToolRegistrySnapshot(input);
    return this.snapshot();
  }

  snapshot(): McpToolRegistrySnapshot {
    return this.snapshotValue;
  }
}

export function buildMcpToolRegistrySnapshot(input: McpToolRegistryInput): McpToolRegistrySnapshot {
  const builtin = new Set(input.builtinToolNames ?? []);
  const statuses = input.statuses ? new Map(input.statuses.map((status) => [status.id, status])) : undefined;
  const instructionsByServer: Record<string, string> = {};
  for (const status of input.statuses ?? []) {
    if (status.instructions) instructionsByServer[status.id] = status.instructions;
  }

  const byServer = new Map<McpServerId, McpToolInventoryEntry[]>();
  for (const tool of input.inventory) {
    const arr = byServer.get(tool.serverId) ?? [];
    arr.push(tool);
    byServer.set(tool.serverId, arr);
  }

  const accepted: McpRegisteredTool[] = [];
  const rejected: { serverId: McpServerId; toolName: string; reason: string }[] = [];
  for (const [serverId, tools] of byServer) {
    const status = statuses?.get(serverId);
    if (statuses && (!status || status.status !== "connected" || status.enabled === false)) {
      continue;
    }
    const seen = new Set<string>();
    const dup = tools.find((tool) => {
      if (seen.has(tool.toolName)) return true;
      seen.add(tool.toolName);
      return false;
    });
    if (dup) {
      rejected.push({ serverId, toolName: dup.toolName, reason: "same-server duplicate tool name" });
      continue;
    }
    for (const tool of tools) {
      const parsed = parseSyntheticId(tool.syntheticId);
      let reason: string | undefined;
      if (!isValidMcpToolName(tool.toolName)) reason = "invalid MCP tool name";
      else if (!parsed || parsed.serverId !== tool.serverId || parsed.toolName !== tool.toolName) {
        reason = "synthetic id does not match server/tool";
      } else if (builtin.has(tool.syntheticId)) {
        reason = "MCP synthetic id collides with built-in vault tool";
      }
      if (reason) {
        rejected.push({ serverId, toolName: tool.toolName, reason });
        input.notify?.(redactSensitive(`[Copilot Agent] MCP tool rejected: ${reason}.`));
        continue;
      }
      accepted.push(Object.freeze({ ...tool, ...(instructionsByServer[serverId] ? { instructions: instructionsByServer[serverId] } : {}) }));
    }
  }
  return freezeSnapshot(accepted, rejected, instructionsByServer);
}

function freezeSnapshot(
  tools: McpRegisteredTool[],
  rejected: { serverId: McpServerId; toolName: string; reason: string }[],
  instructionsByServer: Record<string, string>,
): McpToolRegistrySnapshot {
  return Object.freeze({
    tools: Object.freeze(tools.map((tool) => Object.freeze({ ...tool }))),
    rejected: Object.freeze(rejected.map((entry) => Object.freeze({ ...entry }))),
    instructionsByServer: Object.freeze({ ...instructionsByServer }),
  });
}
