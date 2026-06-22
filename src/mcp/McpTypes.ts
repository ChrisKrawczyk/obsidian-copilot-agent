import type { ServerCredentials } from "./credentials/CredentialTypes";

export type {
  ServerCredentials,
  ServerCredentialKind,
  NoneCredentials,
  StaticBearerCredentials,
  CommandBasedCredentials,
  OAuthPkceCredentials,
} from "./credentials/CredentialTypes";

export type McpServerId = string & { readonly __brand: "McpServerId" };
export type McpTrustEpoch = string & { readonly __brand: "McpTrustEpoch" };

export type McpTransport = "stdio" | "http";

export type McpRuntimeStatus =
  | "disabled"
  | "disconnected"
  | "connecting"
  | "reconnecting"
  | "connected"
  | "error"
  | "crashloop";

export interface McpServerConfigBase {
  id: McpServerId;
  name: string;
  enabled: boolean;
  trustEpoch: McpTrustEpoch;
  callTimeoutMs?: number;
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
  /**
   * Legacy field retained for one release of read-only backward compatibility.
   * New saves emit a canonical `credentials: { kind: "static-bearer", token }`
   * instead. The settings store migrates legacy `authorization` to
   * `credentials` on load (FR-001, FR-002, Phase 1 plan).
   */
  authorization?: string;
  credentials?: ServerCredentials;
}

export type McpServerConfig = McpStdioServerConfig | McpHttpServerConfig;

export interface McpServerRuntimeSnapshot {
  id: McpServerId;
  status: McpRuntimeStatus;
  lastError?: string;
  toolCount?: number;
  instructions?: string;
  protocolVersion?: string;
  stderrTail?: string;
}

export interface McpServerRedactedSnapshot {
  id: McpServerId;
  name: string;
  enabled: boolean;
  transport: McpTransport;
  status?: McpRuntimeStatus;
  lastError?: string;
}

export interface McpToolInventoryEntry {
  serverId: McpServerId;
  serverName: string;
  toolName: string;
  syntheticId: string;
  description?: string;
  inputSchema?: unknown;
}
