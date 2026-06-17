export type McpServerId = string & { readonly __brand: "McpServerId" };
export type McpTrustEpoch = string & { readonly __brand: "McpTrustEpoch" };

export type McpTransport = "stdio" | "http";

export type McpRuntimeStatus =
  | "disabled"
  | "disconnected"
  | "connecting"
  | "connected"
  | "error"
  | "crashloop";

export interface McpServerConfigBase {
  id: McpServerId;
  name: string;
  enabled: boolean;
  trustEpoch: McpTrustEpoch;
  [futureKey: string]: unknown;
}

export interface McpStdioServerConfig extends McpServerConfigBase {
  transport: "stdio";
  command: string;
  args: string[];
  env?: Record<string, string>;
  cwd?: string;
}

export interface McpHttpServerConfig extends McpServerConfigBase {
  transport: "http";
  url: string;
  authorization?: string;
}

export type McpServerConfig = McpStdioServerConfig | McpHttpServerConfig;

export interface McpServerRuntimeSnapshot {
  id: McpServerId;
  status: McpRuntimeStatus;
  lastError?: string;
  toolCount?: number;
}

export interface McpServerRedactedSnapshot {
  id: McpServerId;
  name: string;
  enabled: boolean;
  transport: McpTransport;
  status?: McpRuntimeStatus;
  lastError?: string;
}
