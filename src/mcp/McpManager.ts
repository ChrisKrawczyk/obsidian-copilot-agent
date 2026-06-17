import type {
  McpServerConfig,
  McpServerId,
  McpServerRuntimeSnapshot,
  McpToolInventoryEntry,
} from "./McpTypes";
import {
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
}

export class McpManager {
  private runtimes = new Map<McpServerId, McpServerRuntime>();
  private inventories = new Map<McpServerId, DiscoveredInventory>();

  constructor(private readonly options: McpManagerOptions) {}

  async enable(serverId: McpServerId): Promise<void> {
    const config = this.find(serverId);
    if (!config.enabled) return;
    const runtime = this.getOrCreate(config);
    try {
      const inventory = await runtime.connect();
      assertNoSameServerDuplicateTools(inventory.tools);
      this.inventories.set(serverId, inventory);
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
    this.inventories.delete(serverId);
    if (runtime) {
      await runtime.disable();
      await this.persist(serverId, runtime.snapshot());
    }
  }

  async reconnect(serverId: McpServerId): Promise<void> {
    await this.unload(serverId);
    await this.enable(serverId);
  }

  async unload(serverId?: McpServerId): Promise<void> {
    if (serverId) {
      const runtime = this.runtimes.get(serverId);
      this.inventories.delete(serverId);
      this.runtimes.delete(serverId);
      if (runtime) await runtime.unload();
      return;
    }
    const runtimes = Array.from(this.runtimes.values());
    this.runtimes.clear();
    this.inventories.clear();
    await Promise.all(runtimes.map((runtime) => runtime.unload()));
  }

  async enableAllConfigured(): Promise<void> {
    const configs = this.options.serversProvider().filter((server) => server.enabled);
    await Promise.all(configs.map((server) => this.enable(server.id).catch(() => undefined)));
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

  getRuntimeForTest(serverId: McpServerId): McpServerRuntime | undefined {
    return this.runtimes.get(serverId);
  }

  private getOrCreate(config: McpServerConfig): McpServerRuntime {
    const existing = this.runtimes.get(config.id);
    if (existing) return existing;
    const runtime = this.options.runtimeFactory
      ? this.options.runtimeFactory(config, this.options)
      : new McpServerRuntime(config, this.options);
    this.runtimes.set(config.id, runtime);
    return runtime;
  }

  private find(serverId: McpServerId): McpServerConfig {
    const config = this.options.serversProvider().find((server) => server.id === serverId);
    if (!config) throw new Error(`MCP server id "${serverId}" was not found.`);
    return config;
  }

  private async persist(serverId: McpServerId, snapshot: McpServerRuntimeSnapshot): Promise<void> {
    if (!this.options.persistStatus) return;
    await this.options.persistStatus(serverId, sanitizeSnapshot(snapshot));
  }
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
