import type { McpServerId } from "./McpTypes";

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
