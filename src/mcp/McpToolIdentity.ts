import type { McpRuntimeStatus, McpServerConfig, McpServerId, McpTrustEpoch } from "./McpTypes";

const PREFIX = "mcp__";
const FORBIDDEN_TOOL_CHARS = /[\u0000-\u001f\u007f/\\]/;

export function formatSyntheticId(serverId: McpServerId, toolName: string): string {
  return `${PREFIX}${serverId}__${toolName}`;
}

export function parseSyntheticId(
  id: string,
): { serverId: McpServerId; toolName: string } | null {
  if (!id.startsWith(PREFIX)) return null;
  const rest = id.slice(PREFIX.length);
  const splitAt = rest.indexOf("__");
  if (splitAt <= 0) return null;
  const serverId = rest.slice(0, splitAt) as McpServerId;
  const toolName = rest.slice(splitAt + 2);
  if (toolName.length === 0 || FORBIDDEN_TOOL_CHARS.test(toolName)) return null;
  return { serverId, toolName };
}

export function isValidMcpToolName(toolName: string): boolean {
  return toolName.length > 0 && !FORBIDDEN_TOOL_CHARS.test(toolName);
}

export interface McpToolSourceMetadata {
  source: "mcp";
  stableServerId: McpServerId;
  serverName: string;
  toolName: string;
  trustEpoch: McpTrustEpoch;
}

export function resolveMcpToolSourceMetadata(
  syntheticId: string | undefined,
  servers: readonly Pick<
    McpServerConfig,
    "id" | "name" | "enabled" | "trustEpoch"
  >[],
  statusByServer?: ReadonlyMap<McpServerId, McpRuntimeStatus>,
): McpToolSourceMetadata | null {
  if (!syntheticId) return null;
  const parsed = parseSyntheticId(syntheticId);
  if (!parsed) return null;
  const server = servers.find((entry) => entry.id === parsed.serverId);
  if (!server || server.enabled === false) return null;
  if (statusByServer && statusByServer.get(server.id) !== "connected") return null;
  return {
    source: "mcp",
    stableServerId: server.id,
    serverName: server.name,
    toolName: parsed.toolName,
    trustEpoch: server.trustEpoch,
  };
}
