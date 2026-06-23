import type { McpServerConfig, McpServerId, McpTrustEpoch } from "./McpTypes";

const SERVER_ID_PATTERN = /^[a-z0-9_-]+$/;
const FORBIDDEN_CHARS = /[\u0000-\u001f\u007f/\\]/;
const MAX_SERVER_ID_LENGTH = 64;

export function normalizeServerId(raw: string): McpServerId {
  if (typeof raw !== "string") {
    throw new Error("MCP server id must be a string.");
  }
  if (FORBIDDEN_CHARS.test(raw)) {
    throw new Error("MCP server id contains forbidden characters.");
  }
  const id = raw.toLowerCase();
  if (id.length === 0 || id.length > MAX_SERVER_ID_LENGTH) {
    throw new Error("MCP server id must be 1-64 characters.");
  }
  if (id.startsWith("mcp__")) {
    throw new Error('MCP server id must not start with reserved prefix "mcp__".');
  }
  if (!SERVER_ID_PATTERN.test(id)) {
    throw new Error("MCP server id must match [a-z0-9_-]+.");
  }
  return id as McpServerId;
}

export function computeTrustEpoch(config: Pick<McpServerConfig, "name" | "transport"> & Partial<McpServerConfig>): McpTrustEpoch {
  // FR-011: trust-epoch material MUST include only identity-defining fields
  // (name, transport, command/args or url). Credential variants, token paths,
  // command lines used to resolve credentials, OAuth client ids, etc. are
  // explicitly excluded so that changes to *how* a server authenticates do
  // NOT invalidate existing per-tool approvals. Adding any credentials-derived
  // field here would silently revoke grants on every credential edit.
  const material =
    config.transport === "stdio"
      ? {
          name: config.name,
          transport: config.transport,
          command: typeof config.command === "string" ? config.command : "",
          args: Array.isArray(config.args) ? config.args : [],
        }
      : {
          name: config.name,
          transport: config.transport,
          url: typeof config.url === "string" ? config.url : "",
        };
  return (`epoch_${fnv1a64(stableStringify(material))}`) as McpTrustEpoch;
}

export function formatMcpApprovalKey(
  serverId: McpServerId,
  toolName: string,
  trustEpoch: McpTrustEpoch,
): string {
  return `mcp:${serverId}:${trustEpoch}:${toolName}`;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function fnv1a64(input: string): string {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= BigInt(input.charCodeAt(i));
    hash = (hash * prime) & mask;
  }
  return hash.toString(16).padStart(16, "0");
}
