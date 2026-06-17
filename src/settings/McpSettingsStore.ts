import { Notice } from "obsidian";
import type { PluginDataIO } from "../auth/TokenStore";
import { computeTrustEpoch, normalizeServerId } from "../mcp/McpIdentity";
import type {
  McpServerConfig,
  McpServerId,
  McpServerRuntimeSnapshot,
} from "../mcp/McpTypes";
import { redactSensitive } from "../mcp/redactSensitive";

interface PersistedShapeWithMcp {
  mcpServers?: unknown;
  [topLevelKey: string]: unknown;
}

type NotifyFn = (message: string) => void;

export interface McpSettingsMutationResult {
  serverId: McpServerId;
  trustEpochChanged: boolean;
  removed?: boolean;
}

const RUNTIME_KEYS = new Set([
  "status",
  "lastError",
  "lastConnectedAt",
  "lastDisconnectedAt",
  "mcpSessionId",
  "Mcp-Session-Id",
  "sessionId",
  "tools",
  "instructions",
]);

export class McpSettingsStore {
  private tail: Promise<void> = Promise.resolve();
  private cached: McpServerConfig[] = [];
  private listeners = new Set<(servers: McpServerConfig[]) => void>();
  private lastDropNotice = "";

  constructor(
    private readonly io: PluginDataIO,
    private readonly notify: NotifyFn = (message) => {
      new Notice(message, 8000);
    },
  ) {}

  async load(): Promise<McpServerConfig[]> {
    const raw = (await this.io.loadData()) as
      | PersistedShapeWithMcp
      | null
      | undefined;
    const entries = raw && typeof raw === "object" ? raw.mcpServers : undefined;
    if (!Array.isArray(entries)) {
      this.cached = [];
      return this.snapshot();
    }

    const valid: McpServerConfig[] = [];
    const dropped: string[] = [];
    const seen = new Set<string>();
    for (const entry of entries) {
      const parsed = parseServerConfig(entry);
      if (!parsed.ok) {
        dropped.push(parsed.label);
        continue;
      }
      if (seen.has(parsed.config.id)) {
        dropped.push(parsed.config.id);
        continue;
      }
      seen.add(parsed.config.id);
      valid.push(parsed.config);
    }
    this.cached = valid;
    this.notifyDroppedOnce(dropped);
    return this.snapshot();
  }

  snapshot(): McpServerConfig[] {
    return this.cached.map(cloneServerConfig);
  }

  subscribe(fn: (servers: McpServerConfig[]) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  async save(servers: McpServerConfig[] = this.cached): Promise<void> {
    this.cached = sanitizeAndDedupeOrThrow(servers);
    await this.persist();
  }

  async add(server: McpServerConfig): Promise<void> {
    await this.addServer(server);
  }

  async update(
    serverId: McpServerId,
    update: Partial<McpServerConfig>,
  ): Promise<void> {
    await this.updateServer(serverId, update);
  }

  async remove(serverId: McpServerId): Promise<void> {
    await this.removeServer(serverId);
  }

  async setEnabled(serverId: McpServerId, enabled: boolean): Promise<McpSettingsMutationResult> {
    const existing = this.findOrThrow(serverId);
    if (existing.enabled === enabled) {
      return { serverId, trustEpochChanged: false };
    }
    return this.updateServer(serverId, { enabled } as Partial<McpServerConfig>);
  }

  async addServer(server: McpServerConfig): Promise<McpSettingsMutationResult> {
    const normalized = sanitizeAndDedupeOrThrow([server])[0];
    if (this.cached.some((existing) => existing.id === normalized.id)) {
      throw new Error(`MCP server id "${normalized.id}" already exists.`);
    }
    this.cached = [...this.cached, normalized];
    await this.persist();
    return { serverId: normalized.id, trustEpochChanged: false };
  }

  async updateServer(
    serverId: McpServerId,
    update: Partial<McpServerConfig>,
  ): Promise<McpSettingsMutationResult> {
    const before = this.findOrThrow(serverId);
    let found = false;
    const next: McpServerConfig[] = this.cached.map((server): McpServerConfig => {
      if (server.id !== serverId) return server;
      found = true;
      return { ...server, ...update, id: server.id } as McpServerConfig;
    });
    if (!found) throw new Error(`MCP server id "${serverId}" was not found.`);
    this.cached = sanitizeAndDedupeOrThrow(next);
    await this.persist();
    const after = this.findOrThrow(serverId);
    return { serverId, trustEpochChanged: before.trustEpoch !== after.trustEpoch };
  }

  async removeServer(serverId: McpServerId): Promise<McpSettingsMutationResult> {
    const next = this.cached.filter((server) => server.id !== serverId);
    if (next.length === this.cached.length) {
      throw new Error(`MCP server id "${serverId}" was not found.`);
    }
    this.cached = next;
    await this.persist();
    return { serverId, trustEpochChanged: true, removed: true };
  }

  async recordStatus(
    serverId: McpServerId,
    snapshot: McpServerRuntimeSnapshot,
  ): Promise<McpSettingsMutationResult> {
    const existing = this.findOrThrow(serverId);
    this.cached = this.cached.map((server) =>
      server.id === serverId
        ? ({
            ...server,
            status: snapshot.status,
            ...(snapshot.lastError ? { lastError: snapshot.lastError } : { lastError: undefined }),
            ...(snapshot.toolCount !== undefined ? { toolCount: snapshot.toolCount } : {}),
          } as McpServerConfig)
        : server,
    );
    await this.persist();
    return { serverId: existing.id, trustEpochChanged: false };
  }

  private findOrThrow(serverId: McpServerId): McpServerConfig {
    const server = this.cached.find((entry) => entry.id === serverId);
    if (!server) throw new Error(`MCP server id "${serverId}" was not found.`);
    return server;
  }

  private persist(): Promise<void> {
    const snap = this.snapshot();
    this.listeners.forEach((fn) => {
      try {
        fn(snap);
      } catch {
        // Subscriber failures must not interrupt persistence.
      }
    });
    return this.enqueue(async () => {
      const fresh = (await this.io.loadData()) as
        | PersistedShapeWithMcp
        | null
        | undefined;
      const base =
        fresh && typeof fresh === "object" ? (fresh as PersistedShapeWithMcp) : {};
      await this.io.saveData({
        ...base,
        mcpServers: snap.map(toPersistedServerConfig),
      });
    });
  }

  private enqueue(fn: () => Promise<void>): Promise<void> {
    const next = this.tail.then(fn, fn);
    this.tail = next.then(
      () => {},
      () => {},
    );
    return next;
  }

  private notifyDroppedOnce(labels: string[]): void {
    if (labels.length === 0) return;
    const signature = labels.join("\u0000");
    if (signature === this.lastDropNotice) return;
    this.lastDropNotice = signature;
    this.notify(
      redactSensitive(
        `[Copilot Agent] Dropped malformed MCP server entries: ${labels.join(", ")}`,
      ),
    );
  }
}

function sanitizeAndDedupeOrThrow(servers: McpServerConfig[]): McpServerConfig[] {
  const seen = new Set<string>();
  return servers.map((server) => {
    const parsed = parseServerConfig(server);
    if (!parsed.ok) throw new Error(`Invalid MCP server config: ${parsed.label}`);
    if (seen.has(parsed.config.id)) {
      throw new Error(`MCP server id "${parsed.config.id}" already exists.`);
    }
    seen.add(parsed.config.id);
    return parsed.config;
  });
}

function parseServerConfig(
  entry: unknown,
): { ok: true; config: McpServerConfig } | { ok: false; label: string } {
  const label = discernLabel(entry);
  if (!entry || typeof entry !== "object") return { ok: false, label };
  const raw = entry as Record<string, unknown>;
  if (typeof raw.id !== "string" || typeof raw.name !== "string") {
    return { ok: false, label };
  }
  if (raw.name.length === 0 || typeof raw.enabled !== "boolean") {
    return { ok: false, label };
  }
  let id: McpServerId;
  try {
    id = normalizeServerId(raw.id);
  } catch {
    return { ok: false, label };
  }
  const base = stripRuntimeFields(raw);
  if (raw.transport === "stdio") {
    if (typeof raw.command !== "string" || !Array.isArray(raw.args)) {
      return { ok: false, label: id };
    }
    const args = raw.args.filter((arg): arg is string => typeof arg === "string");
    if (args.length !== raw.args.length) return { ok: false, label: id };
    const env = parseStringRecord(raw.env);
    if (raw.env !== undefined && !env) return { ok: false, label: id };
    const cwd = raw.cwd === undefined || typeof raw.cwd === "string" ? raw.cwd : null;
    if (cwd === null) return { ok: false, label: id };
    const config = {
      ...base,
      id,
      name: raw.name,
      enabled: raw.enabled,
      transport: "stdio" as const,
      command: raw.command,
      args,
      ...(env ? { env } : {}),
      ...(cwd ? { cwd } : {}),
    };
    return { ok: true, config: withTrustEpoch(config) };
  }

  if (raw.transport === "http") {
    if (typeof raw.url !== "string") return { ok: false, label: id };
    if (
      raw.authorization !== undefined &&
      typeof raw.authorization !== "string"
    ) {
      return { ok: false, label: id };
    }
    const config = {
      ...base,
      id,
      name: raw.name,
      enabled: raw.enabled,
      transport: "http" as const,
      url: raw.url,
      ...(raw.authorization ? { authorization: raw.authorization } : {}),
    };
    return { ok: true, config: withTrustEpoch(config) };
  }
  return { ok: false, label: id };
}

function withTrustEpoch<T extends Record<string, unknown>>(
  config: T,
): T & Pick<McpServerConfig, "trustEpoch"> {
  return {
    ...config,
    trustEpoch: computeTrustEpoch(config as unknown as McpServerConfig),
  };
}

function parseStringRecord(value: unknown): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const entries = Object.entries(value);
  if (entries.some(([, entry]) => typeof entry !== "string")) return undefined;
  return Object.fromEntries(entries) as Record<string, string>;
}

function stripRuntimeFields(raw: Record<string, unknown>): Record<string, unknown> {
  const cleaned: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (RUNTIME_KEYS.has(key)) continue;
    if (key === "headers" && value && typeof value === "object" && !Array.isArray(value)) {
      cleaned.headers = Object.fromEntries(
        Object.entries(value as Record<string, unknown>).filter(
          ([header]) => header.toLowerCase() !== "mcp-session-id",
        ),
      );
      continue;
    }
    cleaned[key] = value;
  }
  return cleaned;
}

function toPersistedServerConfig(server: McpServerConfig): McpServerConfig {
  const parsed = parseServerConfig(server);
  return cloneServerConfig(parsed.ok ? parsed.config : server);
}

function cloneServerConfig(server: McpServerConfig): McpServerConfig {
  return JSON.parse(JSON.stringify(server)) as McpServerConfig;
}

function discernLabel(entry: unknown): string {
  if (entry && typeof entry === "object") {
    const raw = entry as Record<string, unknown>;
    if (typeof raw.id === "string" && raw.id.length > 0) return raw.id;
    if (typeof raw.name === "string" && raw.name.length > 0) return raw.name;
  }
  return "(unknown)";
}
