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
  onListChanged?: (serverId: McpServerConfig["id"]) => void;
  onForcedKill?: (event: { serverId: McpServerConfig["id"]; pid?: number; reason: string }) => void;
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
  private crashAttempts: number[] = [];
  private lifecycleEpoch = 0;

  constructor(
    private readonly config: McpServerConfig,
    private readonly options: McpServerRuntimeOptions,
  ) {}

  async connect(options: { manual?: boolean } = {}): Promise<DiscoveredInventory> {
    if (this.status === "crashloop" && !options.manual) return this.inventory();
    if (options.manual) this.crashAttempts = [];
    const epoch = this.lifecycleEpoch;
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
        this.rejectPending(new Error("MCP transport closed during request."));
        if (this.status === "connected") this.status = "disconnected";
      };
      await withTimeout(
        transport.start(),
        MCP_INITIALIZE_TIMEOUT_MS,
        "MCP initialize timed out.",
        this.options.setTimeout,
        this.options.clearTimeout,
      );
      this.assertNotAborted(epoch);
      const init = await this.request(
        "initialize",
        {
          protocolVersion: MCP_ADVERTISED_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: "obsidian-copilot-agent", version: "0.5.0" },
        },
        MCP_INITIALIZE_TIMEOUT_MS,
      );
      this.assertNotAborted(epoch);
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
      this.assertNotAborted(epoch);
      if (!result.capabilities || result.capabilities.tools === undefined) {
        this.status = "error";
        this.lastError = "MCP server does not advertise tools capability.";
        this.tools = [];
        return this.inventory();
      }
      this.listChangedSubscribed = result.capabilities.tools.listChanged === true;
      this.tools = await this.discoverTools();
      this.assertNotAborted(epoch);
      this.status = "connected";
      return this.inventory();
    } catch (err) {
      this.sessionId = undefined;
      this.tools = [];
      this.setError(err);
      this.recordCrashAttempt();
      throw new Error(this.lastError);
    }
  }

  async callTool(name: string, args: Record<string, unknown>, timeoutMs = this.config.callTimeoutMs ?? MCP_CALL_TIMEOUT_MS): Promise<unknown> {
    return this.request("tools/call", { name, arguments: args }, Math.min(timeoutMs, this.config.callTimeoutMs ?? timeoutMs));
  }

  async callToolCancellable(
    name: string,
    args: Record<string, unknown>,
    timeoutMs = this.config.callTimeoutMs ?? MCP_CALL_TIMEOUT_MS,
    signal?: AbortSignal,
  ): Promise<unknown> {
    return this.request("tools/call", { name, arguments: args }, Math.min(timeoutMs, this.config.callTimeoutMs ?? timeoutMs), signal);
  }

  async refreshInventory(): Promise<DiscoveredInventory> {
    if (this.status !== "connected") throw new Error("MCP server is not connected.");
    this.tools = await this.discoverTools();
    return this.inventory();
  }

  async disable(): Promise<void> {
    this.lifecycleEpoch++;
    await this.close();
    this.status = "disabled";
  }

  async unload(): Promise<void> {
    this.lifecycleEpoch++;
    await this.close();
  }

  async reconnect(): Promise<DiscoveredInventory> {
    this.lifecycleEpoch++;
    await this.close();
    return this.connect();
  }

  async manualReconnect(): Promise<DiscoveredInventory> {
    this.lifecycleEpoch++;
    await this.close();
    return this.connect({ manual: true });
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

  markInventoryRejected(reason: string): void {
    this.lastError = redactSensitive(reason);
  }

  markReconnecting(reason?: string): void {
    this.status = "reconnecting";
    if (reason) this.lastError = redactSensitive(reason);
  }

  markCrashloop(reason: string): void {
    this.status = "crashloop";
    this.tools = [];
    this.sessionId = undefined;
    this.lastError = redactSensitive(reason);
  }

  clearVolatileSession(): void {
    this.sessionId = undefined;
  }

  isCrashloop(): boolean {
    return this.status === "crashloop";
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
      return new StdioTransport(this.config, {
        vaultRoot: this.options.vaultRoot,
        setTimeout: this.options.setTimeout,
        clearTimeout: this.options.clearTimeout,
        onForcedKill: (event) => this.options.onForcedKill?.({ serverId: this.config.id, ...event }),
      });
    }
    return createStreamableHttpTransport(this.config, this.options.fetch ?? fetch);
  }

  private async discoverTools(): Promise<McpToolInventoryEntry[]> {
    const now = this.options.now ?? Date.now;
    const deadline = now() + MCP_DISCOVERY_TIMEOUT_MS;
    const discovered: McpToolInventoryEntry[] = [];
    const seen = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < MCP_MAX_TOOL_LIST_PAGES; page += 1) {
      const remaining = deadline - now();
      if (remaining <= 0) {
        throw new Error("MCP tools/list aggregate timeout exceeded.");
      }
      const result = (await this.request(
        "tools/list",
        cursor ? { cursor } : {},
        Math.min(MCP_LIST_PAGE_TIMEOUT_MS, remaining),
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

  private request(method: string, params: unknown, timeoutMs: number, signal?: AbortSignal): Promise<unknown> {
    const transport = this.transport;
    if (!transport) return Promise.reject(new Error("MCP transport is not connected."));
    const id = `oca-${this.nextId++}`;
    let settled = false;
    const cleanup = (): void => {
      settled = true;
      this.pending.delete(id);
      signal?.removeEventListener("abort", abort);
    };
    const abort = (): void => {
      if (settled) return;
      void this.notification("notifications/cancelled", { requestId: id, reason: "user_cancelled" });
      const pending = this.pending.get(id);
      cleanup();
      pending?.reject(cancelledError("MCP tool call was cancelled."));
    };
    if (signal?.aborted) {
      return Promise.reject(cancelledError("MCP tool call was cancelled."));
    }
    return withTimeout(
      new Promise<unknown>((resolve, reject) => {
        this.pending.set(id, {
          resolve: (value) => {
            cleanup();
            resolve(value);
          },
          reject: (err) => {
            cleanup();
            reject(err);
          },
        });
        if (method === "tools/call") signal?.addEventListener("abort", abort, { once: true });
        void transport.send({ jsonrpc: "2.0", id, method, params } as JSONRPCMessage).catch((err) => {
          cleanup();
          reject(sanitizeError(err));
        });
      }),
      timeoutMs,
      `MCP request "${method}" timed out.`,
      this.options.setTimeout,
      this.options.clearTimeout,
    ).catch(async (err) => {
      cleanup();
      if (method === "tools/call" && !(err instanceof Error && err.name === "CancelledError")) {
        void this.notification("notifications/cancelled", { requestId: id, reason: "user_cancelled" }).catch(() => undefined);
      }
      if (this.config.transport === "http" && this.sessionId) {
        this.sessionId = undefined;
        if (/404|not found/i.test(err instanceof Error ? err.message : String(err))) {
          await this.close().catch(() => undefined);
        }
      }
      throw err;
    });
  }

  private notification(method: string, params?: unknown): Promise<void> {
    const transport = this.transport;
    if (!transport) return Promise.resolve();
    return transport.send({ jsonrpc: "2.0", method, ...(params ? { params } : {}) } as JSONRPCMessage);
  }

  private handleMessage(message: JSONRPCMessage): void {
    const notification = message as { method?: string };
    if (notification.method === "notifications/tools/list_changed") {
      this.options.onListChanged?.(this.config.id);
      return;
    }
    const maybe = message as { id?: string | number; result?: unknown; error?: { message?: string; code?: number | string; data?: unknown } };
    if (maybe.id === undefined) return;
    const pending = this.pending.get(maybe.id);
    if (!pending) return;
    this.pending.delete(maybe.id);
    if (maybe.error) {
      pending.reject(new Error(redactSensitive(`JSON-RPC error: ${maybe.error.message ?? "MCP request failed."}`)));
    } else {
      pending.resolve(maybe.result);
    }
  }

  private async close(): Promise<void> {
    const transport = this.transport;
    await this.deleteHttpSessionBestEffort();
    this.sessionId = undefined;
    this.transport = null;
    this.rejectPending(new Error("MCP transport closed."));
    if (transport) await transport.close().catch((err) => this.setError(err));
  }

  private setError(err: unknown): void {
    const safe = sanitizeError(err);
    this.status = "error";
    const stderr = this.stderrTail();
    this.lastError = redactSensitive(`${safe.message}${safe.stack ? `\n${safe.stack}` : ""}${stderr ? `\nstderr:\n${stderr}` : ""}`);
  }

  private stderrTail(): string | undefined {
    return this.transport instanceof StdioTransport ? this.transport.getStderrTail() : undefined;
  }

  private rejectPending(err: Error): void {
    this.pending.forEach((pending) => pending.reject(sanitizeError(err)));
    this.pending.clear();
  }

  private async deleteHttpSessionBestEffort(): Promise<void> {
    if (this.config.transport !== "http" || !this.sessionId) return;
    const sessionId = this.sessionId;
    this.sessionId = undefined;
    const controller = new AbortController();
    const timer = (this.options.setTimeout ?? setTimeout)(() => controller.abort(), 1_500);
    try {
      await (this.options.fetch ?? fetch)(this.config.url, {
        method: "DELETE",
        headers: {
          "Mcp-Session-Id": sessionId,
          ...(this.protocolVersion ? { "MCP-Protocol-Version": this.protocolVersion } : {}),
          ...(this.config.authorization ? { Authorization: this.config.authorization } : {}),
        },
        signal: controller.signal,
      });
    } catch (err) {
      this.lastError = redactSensitive(`MCP HTTP session cleanup failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      (this.options.clearTimeout ?? clearTimeout)(timer);
    }
  }

  private assertNotAborted(epoch: number): void {
    if (this.lifecycleEpoch !== epoch) {
      this.status = "disconnected";
      throw cancelledError("MCP initialize was cancelled.");
    }
  }

  private recordCrashAttempt(): void {
    const now = this.options.now?.() ?? Date.now();
    this.crashAttempts = [...this.crashAttempts.filter((t) => now - t <= 5 * 60_000), now];
    if (this.crashAttempts.length >= 5) {
      this.status = "crashloop";
      this.tools = [];
      this.lastError = redactSensitive("MCP server entered crashloop after 5 failures in 5 minutes.");
    }
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

export function createMcpHttpFetchWrapper(
  baseFetch: typeof fetch,
  bodyLimitBytes = MCP_HTTP_BODY_LIMIT_BYTES,
): typeof fetch {
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
        return enforceResponseSize(response, bodyLimitBytes);
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
  if (transport === "legacy-sse") {
    throw new Error("Unsupported MCP transport: legacy HTTP+SSE is not supported in v0.5.");
  }
  if (serverReturns === MCP_ADVERTISED_PROTOCOL_VERSION) return serverReturns;
  if (
    serverReturns === MCP_COMPAT_PROTOCOL_VERSION &&
    (transport === "stdio" || transport === "http")
  ) {
    return serverReturns;
  }
  throw new Error(`Unsupported MCP protocol version: ${serverReturns ?? "(missing)"}.`);
}

function enforceResponseSize(response: Response, bodyLimitBytes: number): Response {
  const contentLength = Number(response.headers.get("content-length") ?? "0");
  if (contentLength > bodyLimitBytes) {
    throw new Error(`MCP HTTP response exceeds ${formatByteLimit(bodyLimitBytes)}.`);
  }
  if (!response.body) return response;

  const contentType = response.headers.get("content-type") ?? "";
  const body = contentType.toLowerCase().includes("text/event-stream")
    ? capSseResponseBody(response.body, bodyLimitBytes)
    : capResponseBody(response.body, bodyLimitBytes);
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

function capResponseBody(body: ReadableStream<Uint8Array>, bodyLimitBytes: number): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  let consumed = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) {
        controller.close();
        return;
      }
      consumed += value.byteLength;
      if (consumed > bodyLimitBytes) {
        throw new Error(`MCP HTTP response exceeds ${formatByteLimit(bodyLimitBytes)}.`);
      }
      controller.enqueue(value);
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}

function capSseResponseBody(body: ReadableStream<Uint8Array>, bodyLimitBytes: number): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  let consumed = 0;
  let eventBytes = 0;
  let lineContentBytes = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) {
        controller.close();
        return;
      }
      for (const byte of value) {
        eventBytes += 1;
        if (eventBytes > bodyLimitBytes) {
          throw new Error(`MCP SSE event exceeds ${formatByteLimit(bodyLimitBytes)}.`);
        }
        if (byte === 10) {
          if (lineContentBytes === 0) eventBytes = 0;
          lineContentBytes = 0;
        } else if (byte !== 13) {
          lineContentBytes += 1;
        }
      }
      consumed += value.byteLength;
      if (consumed > bodyLimitBytes) {
        throw new Error(`MCP HTTP response exceeds ${formatByteLimit(bodyLimitBytes)}.`);
      }
      controller.enqueue(value);
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}

function formatByteLimit(bytes: number): string {
  return bytes === MCP_HTTP_BODY_LIMIT_BYTES ? "16 MiB" : `${bytes} bytes`;
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
        reject(sanitizeError(err));
      },
    );
  });
}

function sanitizeError(err: unknown): Error {
  const source = err instanceof Error ? err : new Error(String(err));
  const next = new Error(redactSensitive(source.message));
  next.name = source.name;
  next.stack = source.stack ? redactSensitive(source.stack) : undefined;
  return next;
}

function cancelledError(message: string): Error {
  const err = new Error(message);
  err.name = "CancelledError";
  return err;
}

function truncate(text: string, max: number): string | undefined {
  if (!text) return undefined;
  if (text.length <= max) return redactSensitive(text);
  return redactSensitive(`${text.slice(0, max)}\n[truncated]`);
}

export { MCP_STDIO_FRAME_LIMIT_BYTES };
