import type {
  McpServerConfig,
  McpServerId,
  McpServerRuntimeSnapshot,
  McpToolInventoryEntry,
} from "./McpTypes";
import {
  MCP_CALL_TIMEOUT_MS,
  McpServerRuntime,
  type DiscoveredInventory,
  type McpServerRuntimeOptions,
} from "./McpServerRuntime";
import { redactSensitive } from "./redactSensitive";

export interface McpManagerOptions extends McpServerRuntimeOptions {
  serversProvider: () => McpServerConfig[];
  persistStatus?: (serverId: McpServerId, snapshot: McpServerRuntimeSnapshot) => void | Promise<void>;
  notify?: (message: string) => void;
  runtimeFactory?: (config: McpServerConfig, options: McpServerRuntimeOptions) => McpServerRuntime;
  settleTrackedCalls?: (serverId: McpServerId) => void | Promise<void>;
  builtinToolNames?: readonly string[];
}

export class McpManager {
  private runtimes = new Map<McpServerId, McpServerRuntime>();
  private inventories = new Map<McpServerId, DiscoveredInventory>();
  private listeners = new Set<() => void>();
  private connectPromises = new Map<McpServerId, Promise<void>>();
  private inFlightCalls = new Map<McpServerId, number>();
  private generations = new Map<McpServerId, number>();
  private staleInventory = new Set<McpServerId>();

  constructor(private readonly options: McpManagerOptions) {}

  async enable(serverId: McpServerId): Promise<void> {
    const config = this.find(serverId);
    if (!config.enabled) return;
    if (isCrashloopRuntime(this.runtimes.get(serverId))) return;
    const existing = this.connectPromises.get(serverId);
    if (existing) return existing;
    const promise = this.enableInternal(serverId, config).finally(() => this.connectPromises.delete(serverId));
    this.connectPromises.set(serverId, promise);
    return promise;
  }

  private async enableInternal(serverId: McpServerId, config: McpServerConfig): Promise<void> {
    const runtime = this.getOrCreate(config);
    try {
      const inventory = await runtime.connect();
      assertNoSameServerDuplicateTools(inventory.tools);
      const accepted = this.rejectBuiltinCollisions(inventory, runtime);
      this.inventories.set(serverId, accepted);
      await this.persist(serverId, runtime.snapshot());
    } catch (err) {
      this.inventories.delete(serverId);
      await this.persist(serverId, runtime.snapshot());
      this.options.notify?.(redactSensitive(`[Copilot Agent] MCP server failed: ${stringifyError(err)}`));
      throw err;
    }
  }

  async disable(serverId: McpServerId): Promise<void> {
    const runtime = this.runtimes.get(serverId);
    this.bumpGeneration(serverId);
    this.inventories.delete(serverId);
    await this.settle(serverId);
    if (runtime) {
      await runtime.disable();
      await this.persist(serverId, runtime.snapshot());
    } else {
      this.emit();
    }
  }

  async remove(serverId: McpServerId): Promise<void> {
    await this.unload(serverId);
  }

  async reconnect(serverId: McpServerId): Promise<void> {
    await this.manualReconnect(serverId);
  }

  async manualReconnect(serverId: McpServerId): Promise<void> {
    const config = this.find(serverId);
    if (!config.enabled) return;
    const existing = this.connectPromises.get(serverId);
    if (existing) return existing;
    const promise = this.manualReconnectInternal(serverId, config).finally(() => this.connectPromises.delete(serverId));
    this.connectPromises.set(serverId, promise);
    return promise;
  }

  private async manualReconnectInternal(serverId: McpServerId, config: McpServerConfig): Promise<void> {
    this.bumpGeneration(serverId);
    this.inventories.delete(serverId);
    await this.settle(serverId);
    const runtime = this.getOrCreate(config);
    try {
      const inventory = await (typeof (runtime as McpServerRuntime & { manualReconnect?: () => Promise<DiscoveredInventory> }).manualReconnect === "function"
        ? (runtime as McpServerRuntime & { manualReconnect: () => Promise<DiscoveredInventory> }).manualReconnect()
        : runtime.reconnect());
      assertNoSameServerDuplicateTools(inventory.tools);
      const accepted = this.rejectBuiltinCollisions(inventory, runtime);
      this.inventories.set(serverId, accepted);
      await this.persist(serverId, runtime.snapshot());
    } catch (err) {
      this.inventories.delete(serverId);
      await this.persist(serverId, runtime.snapshot());
      this.options.notify?.(redactSensitive(`[Copilot Agent] MCP server failed: ${stringifyError(err)}`));
      throw err;
    }
  }

  async unload(serverId?: McpServerId): Promise<void> {
    if (serverId) {
      const runtime = this.runtimes.get(serverId);
      this.bumpGeneration(serverId);
      this.inventories.delete(serverId);
      this.runtimes.delete(serverId);
      await this.settle(serverId);
      if (runtime) await runtime.unload();
      this.emit();
      return;
    }
    const entries = Array.from(this.runtimes.entries());
    for (const [id] of entries) this.bumpGeneration(id);
    this.runtimes.clear();
    this.inventories.clear();
    await Promise.all(
      entries.map(async ([serverId, runtime]) => {
        await this.settle(serverId);
        await runtime.unload();
      }),
    );
    this.emit();
  }

  async enableAllConfigured(): Promise<void> {
    const configs = this.options.serversProvider().filter((server) => server.enabled);
    await Promise.allSettled(configs.map((server) => this.enable(server.id)));
  }

  async reconcileConfiguredServers(): Promise<void> {
    const configs = this.options.serversProvider();
    const configuredIds = new Set(configs.map((server) => server.id));
    await Promise.all(
      Array.from(this.runtimes.keys()).map((serverId) =>
        configuredIds.has(serverId) ? Promise.resolve() : this.unload(serverId),
      ),
    );
    await Promise.all(
      configs.filter((server) => !server.enabled).map((server) => this.disable(server.id)),
    );
  }

  statusSnapshot(): readonly McpServerRuntimeSnapshot[] {
    return Object.freeze(
      Array.from(this.runtimes.values()).map((runtime) => Object.freeze({ ...runtime.snapshot() })),
    );
  }

  inventorySnapshot(): readonly McpToolInventoryEntry[] {
    return Object.freeze(
      Array.from(this.inventories.values()).flatMap((inventory) =>
        inventory.tools.map((tool) => Object.freeze({ ...tool })),
      ),
    );
  }

  async callTool(serverId: McpServerId, toolName: string, args: Record<string, unknown>): Promise<unknown> {
    const config = this.find(serverId);
    if (!config.enabled || !this.inventories.has(serverId)) {
      throw cancelledError("MCP server is disabled, removed, or disconnected.");
    }
    const runtime = this.runtimes.get(serverId);
    if (!runtime || isCrashloopRuntime(runtime)) throw cancelledError("MCP server is unavailable.");
    const generation = this.generations.get(serverId) ?? 0;
    this.inFlightCalls.set(serverId, (this.inFlightCalls.get(serverId) ?? 0) + 1);
    try {
      const result = await withTimeout(
        runtime.callTool(toolName, args, config.callTimeoutMs),
        config.callTimeoutMs ?? MCP_CALL_TIMEOUT_MS,
        "MCP tool call timed out.",
        this.options.setTimeout,
        this.options.clearTimeout,
      );
      if ((this.generations.get(serverId) ?? 0) !== generation || !this.find(serverId).enabled) {
        throw cancelledError("MCP tool call was cancelled.");
      }
      return result;
    } catch (err) {
      if ((this.generations.get(serverId) ?? 0) !== generation) {
        throw cancelledError("MCP tool call was cancelled.");
      }
      const snap = runtime.snapshot();
      const stderr = snap.stderrTail ? `\nstderr:\n${snap.stderrTail}` : "";
      throw new Error(redactSensitive(`${err instanceof Error ? err.message : String(err)}${stderr}`));
    } finally {
      const remaining = Math.max(0, (this.inFlightCalls.get(serverId) ?? 1) - 1);
      if (remaining === 0) this.inFlightCalls.delete(serverId);
      else this.inFlightCalls.set(serverId, remaining);
    }
  }

  getRuntimeForTest(serverId: McpServerId): McpServerRuntime | undefined {
    return this.runtimes.get(serverId);
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private getOrCreate(config: McpServerConfig): McpServerRuntime {
    const existing = this.runtimes.get(config.id);
    if (existing) return existing;
    const runtime = this.options.runtimeFactory
      ? this.options.runtimeFactory(config, { ...this.options, onListChanged: (id) => this.handleListChanged(id) })
      : new McpServerRuntime(config, { ...this.options, onListChanged: (id) => this.handleListChanged(id) });
    this.runtimes.set(config.id, runtime);
    return runtime;
  }

  private find(serverId: McpServerId): McpServerConfig {
    const config = this.options.serversProvider().find((server) => server.id === serverId);
    if (!config) throw new Error(`MCP server id "${serverId}" was not found.`);
    return config;
  }

  private async persist(serverId: McpServerId, snapshot: McpServerRuntimeSnapshot): Promise<void> {
    if (this.options.persistStatus) {
      await this.options.persistStatus(serverId, sanitizeSnapshot(snapshot));
    }
    this.emit();
  }

  private async settle(serverId: McpServerId): Promise<void> {
    await this.options.settleTrackedCalls?.(serverId);
  }

  private bumpGeneration(serverId: McpServerId): void {
    this.generations.set(serverId, (this.generations.get(serverId) ?? 0) + 1);
  }

  private async handleListChanged(serverId: McpServerId): Promise<void> {
    if ((this.inFlightCalls.get(serverId) ?? 0) > 0) {
      this.staleInventory.add(serverId);
      return;
    }
    const runtime = this.runtimes.get(serverId);
    if (!runtime) return;
    try {
      const inventory = await runtime.refreshInventory();
      assertNoSameServerDuplicateTools(inventory.tools);
      this.inventories.set(serverId, this.rejectBuiltinCollisions(inventory, runtime));
      this.staleInventory.delete(serverId);
      await this.persist(serverId, runtime.snapshot());
    } catch (err) {
      this.inventories.delete(serverId);
      this.options.notify?.(redactSensitive(`[Copilot Agent] MCP inventory refresh failed: ${stringifyError(err)}`));
      await this.persist(serverId, runtime.snapshot());
    }
  }

  private rejectBuiltinCollisions(inventory: DiscoveredInventory, runtime: McpServerRuntime): DiscoveredInventory {
    const builtin = new Set(this.options.builtinToolNames ?? []);
    const tools = inventory.tools.filter((tool) => {
      if (!builtin.has(tool.syntheticId)) return true;
      const reason = `MCP tool "${tool.syntheticId}" collides with a built-in vault tool; built-in wins.`;
      runtime.markInventoryRejected(reason);
      this.options.notify?.(redactSensitive(`[Copilot Agent] ${reason}`));
      return false;
    });
    return Object.freeze({ ...inventory, tools });
  }

  private emit(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        // Runtime snapshot listeners must not affect transport lifecycle.
      }
    }
  }
}

function cancelledError(message: string): Error {
  const err = new Error(message);
  err.name = "CancelledError";
  return err;
}

function isCrashloopRuntime(runtime: McpServerRuntime | undefined): boolean {
  return typeof (runtime as McpServerRuntime & { isCrashloop?: () => boolean } | undefined)?.isCrashloop === "function" &&
    (runtime as McpServerRuntime & { isCrashloop: () => boolean }).isCrashloop();
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

export function assertNoSameServerDuplicateTools(tools: readonly McpToolInventoryEntry[]): void {
  const seen = new Set<string>();
  for (const tool of tools) {
    if (seen.has(tool.toolName)) {
      throw new Error(`Duplicate MCP tool "${tool.toolName}" on server "${tool.serverId}".`);
    }
    seen.add(tool.toolName);
  }
}

function sanitizeSnapshot(snapshot: McpServerRuntimeSnapshot): McpServerRuntimeSnapshot {
  return Object.freeze({
    ...snapshot,
    ...(snapshot.lastError ? { lastError: redactSensitive(snapshot.lastError) } : {}),
    ...(snapshot.stderrTail ? { stderrTail: redactSensitive(snapshot.stderrTail) } : {}),
    ...(snapshot.instructions ? { instructions: redactSensitive(snapshot.instructions) } : {}),
  });
}

function stringifyError(err: unknown): string {
  return redactSensitive(err instanceof Error ? err.message : String(err));
}
