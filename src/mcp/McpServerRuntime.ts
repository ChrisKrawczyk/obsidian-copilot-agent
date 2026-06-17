import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type {
  McpHttpServerConfig,
  McpRuntimeStatus,
  McpServerConfig,
  McpServerRuntimeSnapshot,
  McpToolInventoryEntry,
} from "./McpTypes";
import { formatSyntheticId, isValidMcpToolName } from "./McpToolIdentity";
import { redactSensitive } from "./redactSensitive";
import {
  assertNoTlsBypassOptions,
  stripCrossOriginAuthHeaders,
  validateMcpHttpUrl,
  validateRedirectHop,
} from "./httpPolicy";
import { StdioTransport, MCP_STDIO_FRAME_LIMIT_BYTES } from "./transport/StdioTransport";

export const MCP_ADVERTISED_PROTOCOL_VERSION = "2025-06-18";
export const MCP_COMPAT_PROTOCOL_VERSION = "2024-11-05";
export const MCP_INITIALIZE_TIMEOUT_MS = 10_000;
export const MCP_LIST_PAGE_TIMEOUT_MS = 10_000;
export const MCP_DISCOVERY_TIMEOUT_MS = 30_000;
export const MCP_CALL_TIMEOUT_MS = 60_000;
export const MCP_MAX_TOOL_LIST_PAGES = 50;
export const MCP_MAX_TOOLS_PER_SERVER = 1000;
export const MCP_INSTRUCTIONS_LIMIT = 4096;
export const MCP_HTTP_BODY_LIMIT_BYTES = 16 * 1024 * 1024;

export type McpTransportKind = "stdio" | "http" | "legacy-sse";

export interface McpServerRuntimeOptions {
  vaultRoot: string;
  transportFactory?: (config: McpServerConfig) => Transport;
  fetch?: typeof fetch;
  setTimeout?: typeof setTimeout;
  clearTimeout?: typeof clearTimeout;
  now?: () => number;
}

export interface DiscoveredInventory {
  serverId: McpServerConfig["id"];
  tools: McpToolInventoryEntry[];
  instructions?: string;
}

export class McpServerRuntime {
  private transport: Transport | null = null;
  private status: McpRuntimeStatus = "disconnected";
  private lastError: string | undefined;
  private tools: McpToolInventoryEntry[] = [];
  private instructions: string | undefined;
  private protocolVersion: string | undefined;
  private nextId = 1;
  private pending = new Map<
    string | number,
    { resolve: (value: unknown) => void; reject: (err: Error) => void }
  >();
  private sessionId: string | undefined;
  private listChangedSubscribed = false;

  constructor(
    private readonly config: McpServerConfig,
    private readonly options: McpServerRuntimeOptions,
  ) {}

  async connect(): Promise<DiscoveredInventory> {
    this.status = "connecting";
    this.lastError = undefined;
    this.sessionId = undefined;
    this.listChangedSubscribed = false;
    try {
      const transport = this.createTransport();
      this.transport = transport;
      transport.onmessage = (message) => this.handleMessage(message);
      transport.onerror = (err) => this.setError(err);
      transport.onclose = () => {
        if (this.status === "connected") this.status = "disconnected";
      };
      await withTimeout(transport.start(), MCP_INITIALIZE_TIMEOUT_MS, "MCP initialize timed out.");
      const init = await this.request(
        "initialize",
        {
          protocolVersion: MCP_ADVERTISED_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: "obsidian-copilot-agent", version: "0.5.0" },
        },
        MCP_INITIALIZE_TIMEOUT_MS,
      );
      const result = init as {
        protocolVersion?: string;
        capabilities?: { tools?: { listChanged?: boolean } };
        instructions?: string;
      };
      this.protocolVersion = negotiateProtocolVersion(
        result.protocolVersion,
        this.config.transport,
      );
      transport.setProtocolVersion?.(this.protocolVersion);
      this.sessionId = transport.sessionId;
      this.instructions = truncate(result.instructions ?? "", MCP_INSTRUCTIONS_LIMIT);
      await this.notification("notifications/initialized");
      if (!result.capabilities || result.capabilities.tools === undefined) {
        this.status = "error";
        this.lastError = "MCP server does not advertise tools capability.";
        this.tools = [];
        return this.inventory();
      }
      this.listChangedSubscribed = result.capabilities.tools.listChanged === true;
      this.tools = await this.discoverTools();
      this.status = "connected";
      return this.inventory();
    } catch (err) {
      this.sessionId = undefined;
      this.tools = [];
      this.setError(err);
      throw new Error(this.lastError);
    }
  }

  async callTool(name: string, args: Record<string, unknown>, timeoutMs = MCP_CALL_TIMEOUT_MS): Promise<unknown> {
    return this.request("tools/call", { name, arguments: args }, timeoutMs);
  }

  async disable(): Promise<void> {
    this.sessionId = undefined;
    await this.close();
    this.status = "disabled";
  }

  async unload(): Promise<void> {
    this.sessionId = undefined;
    await this.close();
  }

  async reconnect(): Promise<DiscoveredInventory> {
    this.sessionId = undefined;
    await this.close();
    return this.connect();
  }

  snapshot(): McpServerRuntimeSnapshot {
    const stderrTail = this.stderrTail();
    return Object.freeze({
      id: this.config.id,
      status: this.status,
      ...(this.lastError ? { lastError: redactSensitive(this.lastError) } : {}),
      toolCount: this.tools.length,
      ...(this.instructions ? { instructions: redactSensitive(this.instructions) } : {}),
      ...(this.protocolVersion ? { protocolVersion: this.protocolVersion } : {}),
      ...(stderrTail ? { stderrTail: redactSensitive(stderrTail) } : {}),
    });
  }

  inventory(): DiscoveredInventory {
    return Object.freeze({
      serverId: this.config.id,
      tools: this.tools.map((tool) => Object.freeze({ ...tool })),
      ...(this.instructions ? { instructions: redactSensitive(this.instructions) } : {}),
    });
  }

  hasListChangedSubscription(): boolean {
    return this.listChangedSubscribed;
  }

  getVolatileSessionIdForTest(): string | undefined {
    return this.sessionId;
  }

  private createTransport(): Transport {
    if (this.options.transportFactory) return this.options.transportFactory(this.config);
    if (this.config.transport === "stdio") {
      return new StdioTransport(this.config, { vaultRoot: this.options.vaultRoot });
    }
    return createStreamableHttpTransport(this.config, this.options.fetch ?? fetch);
  }

  private async discoverTools(): Promise<McpToolInventoryEntry[]> {
    const started = (this.options.now ?? Date.now)();
    const discovered: McpToolInventoryEntry[] = [];
    const seen = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < MCP_MAX_TOOL_LIST_PAGES; page += 1) {
      const now = (this.options.now ?? Date.now)();
      if (now - started > MCP_DISCOVERY_TIMEOUT_MS) {
        throw new Error("MCP tools/list aggregate timeout exceeded.");
      }
      const result = (await this.request(
        "tools/list",
        cursor ? { cursor } : {},
        MCP_LIST_PAGE_TIMEOUT_MS,
      )) as { tools?: { name: string; description?: string; inputSchema?: unknown }[]; nextCursor?: string };
      for (const tool of result.tools ?? []) {
        if (!isValidMcpToolName(tool.name)) {
          throw new Error(`Invalid MCP tool name: ${tool.name}`);
        }
        if (seen.has(tool.name)) {
          throw new Error(`Duplicate MCP tool "${tool.name}" on server "${this.config.id}".`);
        }
        seen.add(tool.name);
        discovered.push({
          serverId: this.config.id,
          serverName: this.config.name,
          toolName: tool.name,
          syntheticId: formatSyntheticId(this.config.id, tool.name),
          ...(tool.description ? { description: redactSensitive(tool.description) } : {}),
          ...(tool.inputSchema ? { inputSchema: tool.inputSchema } : {}),
        });
        if (discovered.length > MCP_MAX_TOOLS_PER_SERVER) {
          throw new Error("MCP tools/list tool cap exceeded.");
        }
      }
      cursor = result.nextCursor;
      if (!cursor) return discovered;
    }
    throw new Error("MCP tools/list page cap exceeded.");
  }

  private request(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    const transport = this.transport;
    if (!transport) return Promise.reject(new Error("MCP transport is not connected."));
    const id = this.nextId++;
    return withTimeout(
      new Promise<unknown>((resolve, reject) => {
        this.pending.set(id, { resolve, reject });
        void transport.send({ jsonrpc: "2.0", id, method, params } as JSONRPCMessage).catch((err) => {
          this.pending.delete(id);
          reject(sanitizeError(err));
        });
      }),
      timeoutMs,
      `MCP request "${method}" timed out.`,
    );
  }

  private notification(method: string): Promise<void> {
    const transport = this.transport;
    if (!transport) return Promise.resolve();
    return transport.send({ jsonrpc: "2.0", method } as JSONRPCMessage);
  }

  private handleMessage(message: JSONRPCMessage): void {
    const maybe = message as { id?: string | number; result?: unknown; error?: { message?: string } };
    if (maybe.id === undefined) return;
    const pending = this.pending.get(maybe.id);
    if (!pending) return;
    this.pending.delete(maybe.id);
    if (maybe.error) {
      pending.reject(new Error(redactSensitive(maybe.error.message ?? "MCP request failed.")));
    } else {
      pending.resolve(maybe.result);
    }
  }

  private async close(): Promise<void> {
    const transport = this.transport;
    this.transport = null;
    this.pending.forEach((pending) => pending.reject(new Error("MCP transport closed.")));
    this.pending.clear();
    if (transport) await transport.close().catch((err) => this.setError(err));
  }

  private setError(err: unknown): void {
    const safe = sanitizeError(err);
    this.status = "error";
    this.lastError = redactSensitive(`${safe.message}${safe.stack ? `\n${safe.stack}` : ""}`);
  }

  private stderrTail(): string | undefined {
    return this.transport instanceof StdioTransport ? this.transport.getStderrTail() : undefined;
  }
}

export function createStreamableHttpTransport(
  config: McpHttpServerConfig,
  baseFetch: typeof fetch,
): Transport {
  const validation = validateMcpHttpUrl(config.url, { allowPrivateNetwork: true });
  if (validation.hostClass === "metadata") throw new Error("MCP HTTP URL targets metadata.");
  const headers: Record<string, string> = {};
  if (config.authorization) headers.Authorization = config.authorization;
  return new StreamableHTTPClientTransport(validation.url, {
    requestInit: { headers },
    fetch: createMcpHttpFetchWrapper(baseFetch),
  });
}

export function createMcpHttpFetchWrapper(baseFetch: typeof fetch): typeof fetch {
  return async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    assertNoTlsBypassOptions(init as Record<string, unknown>);
    let url = input instanceof Request ? new URL(input.url) : new URL(String(input));
    let headers = new Headers(init.headers ?? (input instanceof Request ? input.headers : undefined));
    let currentInit: RequestInit = { ...init, headers, redirect: "manual" };
    for (let hop = 0; ; hop += 1) {
      const validation = validateMcpHttpUrl(url, { allowPrivateNetwork: true });
      if (validation.hostClass === "metadata") {
        throw new Error("MCP HTTP request targets metadata.");
      }
      const response = await baseFetch(validation.url, currentInit);
      const location = response.headers.get("location");
      if (![301, 302, 303, 307, 308].includes(response.status) || !location) {
        return enforceResponseSize(response);
      }
      const next = validateRedirectHop(validation.url, location, hop + 1, {
        allowPrivateNetwork: false,
      });
      headers = stripCrossOriginAuthHeaders(headers, next.crossOrigin);
      url = next.url;
      currentInit = {
        ...currentInit,
        method: response.status === 303 ? "GET" : currentInit.method,
        headers,
        redirect: "manual",
      };
    }
  };
}

export function negotiateProtocolVersion(
  serverReturns: string | undefined,
  transport: McpTransportKind,
): string {
  if (serverReturns === MCP_ADVERTISED_PROTOCOL_VERSION) return serverReturns;
  if (
    serverReturns === MCP_COMPAT_PROTOCOL_VERSION &&
    (transport === "stdio" || transport === "http")
  ) {
    return serverReturns;
  }
  if (transport === "legacy-sse") {
    throw new Error("Unsupported MCP transport: legacy HTTP+SSE is not supported in v0.5.");
  }
  throw new Error(`Unsupported MCP protocol version: ${serverReturns ?? "(missing)"}.`);
}

async function enforceResponseSize(response: Response): Promise<Response> {
  const contentLength = Number(response.headers.get("content-length") ?? "0");
  if (contentLength > MCP_HTTP_BODY_LIMIT_BYTES) {
    throw new Error("MCP HTTP response exceeds 16 MiB.");
  }
  return response;
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(sanitizeError(err));
      },
    );
  });
}

function sanitizeError(err: unknown): Error {
  const source = err instanceof Error ? err : new Error(String(err));
  const next = new Error(redactSensitive(source.message));
  next.stack = source.stack ? redactSensitive(source.stack) : undefined;
  return next;
}

function truncate(text: string, max: number): string | undefined {
  if (!text) return undefined;
  if (text.length <= max) return redactSensitive(text);
  return redactSensitive(`${text.slice(0, max)}\n[truncated]`);
}

export { MCP_STDIO_FRAME_LIMIT_BYTES };
