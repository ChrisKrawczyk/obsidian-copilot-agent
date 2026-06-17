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
import { McpNotificationQueue } from "./McpNotificationQueue";
import { McpReconnectPolicy } from "./McpReconnectPolicy";
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
  private generations = new Map<McpServerId, number>();
  private runtimeIdentityKeys = new Map<McpServerId, string>();
  private reconnectPolicies = new Map<McpServerId, McpReconnectPolicy>();
  private notificationQueue = new McpNotificationQueue({ refresh: (serverId) => this.refreshInventory(serverId) });
  private unloading = false;

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
    await this.rebindIfRuntimeIdentityChanged(config);
    const runtime = this.getOrCreate(config);
    try {
      const inventory = await runtime.connect();
      assertNoSameServerDuplicateTools(inventory.tools);
      const accepted = this.rejectBuiltinCollisions(inventory, runtime);
      this.inventories.set(serverId, accepted);
      this.policy(serverId).recordSuccess();
      await this.persist(serverId, runtime.snapshot());
    } catch (err) {
      this.inventories.delete(serverId);
      runtime.clearVolatileSession?.();
      if (config.transport === "stdio") this.policy(serverId).recordFailure(err);
      await this.persist(serverId, runtime.snapshot());
      this.options.notify?.(redactSensitive(`[Copilot Agent] MCP server failed: ${stringifyError(err)}`));
      throw err;
    }
  }

  async disable(serverId: McpServerId): Promise<void> {
    const runtime = this.runtimes.get(serverId);
    this.bumpGeneration(serverId);
    this.notificationQueue.cancel(serverId);
    this.policy(serverId).cancel();
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
    this.notificationQueue.cancel(serverId);
    this.policy(serverId).recordSuccess();
    await this.performManualReconnect(serverId, config);
  }

  private async performManualReconnect(serverId: McpServerId, config: McpServerConfig): Promise<void> {
    this.inventories.delete(serverId);
    await this.settle(serverId);
    await this.rebindIfRuntimeIdentityChanged(config);
    const runtime = this.getOrCreate(config);
    try {
      runtime.clearVolatileSession?.();
      const inventory = await (typeof (runtime as McpServerRuntime & { manualReconnect?: () => Promise<DiscoveredInventory> }).manualReconnect === "function"
        ? (runtime as McpServerRuntime & { manualReconnect: () => Promise<DiscoveredInventory> }).manualReconnect()
        : runtime.reconnect());
      assertNoSameServerDuplicateTools(inventory.tools);
      const accepted = this.rejectBuiltinCollisions(inventory, runtime);
      this.inventories.set(serverId, accepted);
      this.policy(serverId).recordSuccess();
      await this.persist(serverId, runtime.snapshot());
    } catch (err) {
      this.inventories.delete(serverId);
      runtime.clearVolatileSession?.();
      await this.persist(serverId, runtime.snapshot());
      this.options.notify?.(redactSensitive(`[Copilot Agent] MCP server failed: ${stringifyError(err)}`));
      throw err;
    }
  }

  async unload(serverId?: McpServerId): Promise<void> {
    if (serverId) {
      const runtime = this.runtimes.get(serverId);
      this.bumpGeneration(serverId);
      this.notificationQueue.cancel(serverId);
      this.policy(serverId).cancel();
      this.inventories.delete(serverId);
      this.runtimes.delete(serverId);
      this.runtimeIdentityKeys.delete(serverId);
      await this.settle(serverId);
      if (runtime) await runtime.unload();
      this.emit();
      return;
    }
    this.unloading = true;
    const entries = Array.from(this.runtimes.entries());
    for (const [id] of entries) this.bumpGeneration(id);
    this.notificationQueue.cancel();
    for (const policy of this.reconnectPolicies.values()) policy.cancel();
    this.runtimes.clear();
    this.runtimeIdentityKeys.clear();
    this.inventories.clear();
    await withTimeout(Promise.all(
      entries.map(async ([serverId, runtime]) => {
        await this.settle(serverId);
        await runtime.unload();
      }),
    ), 20_000, "MCP unload aggregate timeout exceeded.", this.options.setTimeout, this.options.clearTimeout).catch(() => undefined);
    this.reconnectPolicies.clear();
    this.unloading = false;
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
      Array.from(this.runtimes.entries()).map(([id, runtime]) => {
        const policy = this.reconnectPolicies.get(id);
        const snap = runtime.snapshot();
        return Object.freeze({
          ...snap,
          ...(policy?.status() === "reconnecting" && snap.status !== "crashloop" ? { status: "reconnecting" as const } : {}),
          ...(policy?.status() === "crashloop" ? { status: "crashloop" as const } : {}),
        });
      }),
    );
  }

  inventorySnapshot(): readonly McpToolInventoryEntry[] {
    return Object.freeze(
      Array.from(this.inventories.values()).flatMap((inventory) =>
        inventory.tools.map((tool) => Object.freeze({ ...tool })),
      ),
    );
  }

  async callTool(serverId: McpServerId, toolName: string, args: Record<string, unknown>, options: { signal?: AbortSignal } = {}): Promise<unknown> {
    const config = this.find(serverId);
    if (!config.enabled) {
      throw cancelledError("MCP server is disabled, removed, or disconnected.");
    }
    if (!this.inventories.has(serverId) && config.transport === "http") await this.enable(serverId);
    if (!this.inventories.has(serverId)) throw cancelledError("MCP server is disabled, removed, or disconnected.");
    const runtime = this.runtimes.get(serverId);
    if (!runtime || isCrashloopRuntime(runtime)) throw cancelledError("MCP server is unavailable.");
    const generation = this.generations.get(serverId) ?? 0;
    this.notificationQueue.beginCall(serverId);
    try {
      const signal = options.signal;
      const call = typeof (runtime as McpServerRuntime & { callToolCancellable?: (name: string, args: Record<string, unknown>, timeoutMs?: number, signal?: AbortSignal) => Promise<unknown> }).callToolCancellable === "function"
        ? (runtime as McpServerRuntime & { callToolCancellable: (name: string, args: Record<string, unknown>, timeoutMs?: number, signal?: AbortSignal) => Promise<unknown> }).callToolCancellable(toolName, args, config.callTimeoutMs, signal)
        : runtime.callTool(toolName, args, config.callTimeoutMs);
      const result = await withTimeout(
        call,
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
      if (config.transport === "stdio" && !this.unloading) this.policy(serverId).recordFailure(err);
      if (config.transport === "http") {
        runtime.clearVolatileSession?.();
        this.inventories.delete(serverId);
      }
      await this.settle(serverId);
      throw new Error(redactSensitive(`${err instanceof Error ? err.message : String(err)}${stderr}`));
    } finally {
      this.notificationQueue.endCall(serverId);
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
    this.runtimeIdentityKeys.set(config.id, runtimeIdentityKey(config));
    return runtime;
  }

  private async rebindIfRuntimeIdentityChanged(config: McpServerConfig): Promise<void> {
    const existing = this.runtimes.get(config.id);
    if (!existing) return;
    const nextKey = runtimeIdentityKey(config);
    if (this.runtimeIdentityKeys.get(config.id) === nextKey) return;
    this.bumpGeneration(config.id);
    this.notificationQueue.cancel(config.id);
    this.inventories.delete(config.id);
    this.runtimes.delete(config.id);
    this.runtimeIdentityKeys.delete(config.id);
    await this.settle(config.id);
    await existing.unload();
    this.emit();
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
    this.notificationQueue.notifyListChanged(serverId);
  }

  private async refreshInventory(serverId: McpServerId): Promise<void> {
    const runtime = this.runtimes.get(serverId);
    if (!runtime) return;
    try {
      const inventory = await runtime.refreshInventory();
      assertNoSameServerDuplicateTools(inventory.tools);
      this.inventories.set(serverId, this.rejectBuiltinCollisions(inventory, runtime));
      await this.persist(serverId, runtime.snapshot());
    } catch (err) {
      this.options.notify?.(redactSensitive(`[Copilot Agent] MCP inventory refresh failed: ${stringifyError(err)}`));
      await this.persist(serverId, runtime.snapshot());
    }
  }

  private policy(serverId: McpServerId): McpReconnectPolicy {
    let policy = this.reconnectPolicies.get(serverId);
    if (!policy) {
      policy = new McpReconnectPolicy({
        setTimeout: this.options.setTimeout,
        clearTimeout: this.options.clearTimeout,
        now: this.options.now,
        onAttempt: () => this.enable(serverId).catch(() => undefined),
        onStatus: async (status, lastError) => {
          const runtime = this.runtimes.get(serverId);
          if (runtime && status === "reconnecting") runtime.markReconnecting?.(lastError);
          if (runtime && status === "crashloop") {
            runtime.markCrashloop?.(lastError ?? "MCP server entered crashloop.");
            await this.settle(serverId);
          }
          if (runtime) await this.persist(serverId, runtime.snapshot());
        },
      });
      this.reconnectPolicies.set(serverId, policy);
    }
    return policy;
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

function runtimeIdentityKey(config: McpServerConfig): string {
  return JSON.stringify(
    config.transport === "stdio"
      ? {
          name: config.name,
          transport: config.transport,
          command: config.command,
          args: config.args,
        }
      : {
          name: config.name,
          transport: config.transport,
          url: config.url,
        },
  );
}
