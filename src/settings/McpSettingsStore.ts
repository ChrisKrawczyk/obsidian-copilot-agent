import { Notice } from "obsidian";
import type { PluginDataIO } from "../auth/TokenStore";
import {
  type CommandBasedCredentials,
  type NoneCredentials,
  type OAuthPkceCredentials,
  type ServerCredentials,
  type StaticBearerCredentials,
} from "../mcp/credentials/CredentialTypes";
import { computeTrustEpoch, normalizeServerId } from "../mcp/McpIdentity";
import type {
  McpServerConfig,
  McpServerId,
  McpServerRuntimeSnapshot,
} from "../mcp/McpTypes";
import { redactSensitive } from "../mcp/redactSensitive";

interface PersistedShapeWithMcp {
  mcpServers?: unknown;
  mcpAuthorizationNoticeShown?: unknown;
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
  private authorizationNoticeShown = false;
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
      this.authorizationNoticeShown = raw?.mcpAuthorizationNoticeShown === true;
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
    this.authorizationNoticeShown =
      raw?.mcpAuthorizationNoticeShown === true ||
      valid.some(
        (server) =>
          server.transport === "http" &&
          (!!server.authorization ||
            server.credentials?.kind === "static-bearer"),
      );
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

  hasAuthorizationNoticeShown(): boolean {
    return this.authorizationNoticeShown;
  }

  async markAuthorizationNoticeShown(): Promise<void> {
    if (this.authorizationNoticeShown) return;
    this.authorizationNoticeShown = true;
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
        mcpAuthorizationNoticeShown: this.authorizationNoticeShown,
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
  const callTimeoutMs = normalizeCallTimeoutMs(raw);
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
      ...(callTimeoutMs ? { callTimeoutMs } : {}),
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
    const credentialsParse = parseCredentials(raw.credentials);
    if (credentialsParse === "invalid") return { ok: false, label: id };
    // Legacy migration: if no `credentials` block but `authorization` is set,
    // synthesize `static-bearer` credentials in-memory. The legacy field stays
    // on the parsed config so first-load reads do not rewrite the file; the
    // canonical-form rewrite happens at persist time (see
    // toPersistedServerConfig). Phase 1 plan, FR-002.
    const credentials: ServerCredentials | undefined =
      credentialsParse ??
      (typeof raw.authorization === "string" && raw.authorization.length > 0
        ? { kind: "static-bearer", token: raw.authorization }
        : undefined);
    const config = {
      ...base,
      ...(callTimeoutMs ? { callTimeoutMs } : {}),
      id,
      name: raw.name,
      enabled: raw.enabled,
      transport: "http" as const,
      url: raw.url,
      ...(raw.authorization ? { authorization: raw.authorization } : {}),
      ...(credentials ? { credentials } : {}),
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
    if (key === "callTimeoutSeconds") continue;
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

function normalizeCallTimeoutMs(raw: Record<string, unknown>): number | undefined {
  if (typeof raw.callTimeoutMs === "number" && Number.isFinite(raw.callTimeoutMs) && raw.callTimeoutMs > 0) {
    return Math.floor(raw.callTimeoutMs);
  }
  if (typeof raw.callTimeoutSeconds === "number" && Number.isFinite(raw.callTimeoutSeconds) && raw.callTimeoutSeconds > 0) {
    return Math.floor(raw.callTimeoutSeconds * 1000);
  }
  return undefined;
}

function toPersistedServerConfig(server: McpServerConfig): McpServerConfig {
  const parsed = parseServerConfig(server);
  const canonical = parsed.ok ? parsed.config : server;
  // Phase 1 plan: when a canonical `credentials: { kind: "static-bearer", ...}`
  // block exists alongside the legacy `authorization` string, persist the
  // canonical form only. This is the one-time migration that happens whenever
  // the user touches the entry — load-time reads do not rewrite the file.
  if (
    canonical.transport === "http" &&
    canonical.credentials &&
    canonical.credentials.kind === "static-bearer" &&
    typeof (canonical as { authorization?: unknown }).authorization === "string"
  ) {
    const { authorization: _drop, ...rest } = canonical as McpServerConfig & {
      authorization?: string;
    };
    return cloneServerConfig(rest as McpServerConfig);
  }
  return cloneServerConfig(canonical);
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

/**
 * Parse the `credentials` block of a persisted HTTP MCP server entry.
 *
 * Returns `undefined` when the field is absent (caller may then synthesize
 * from legacy `authorization`). Returns `"invalid"` when the field is
 * present but malformed — caller must treat the whole entry as malformed
 * so it lands in the dropped-entries notice (mirrors existing behavior for
 * other invalid fields).
 *
 * For `oauth-pkce` the parser preserves the full input object verbatim
 * (including unknown future keys) to satisfy SC-008's byte-equivalence
 * obligation: the variant is reserved-but-inert in this release and any
 * stored data must round-trip losslessly to a future plugin version that
 * implements OAuth + PKCE.
 */
function parseCredentials(
  value: unknown,
): ServerCredentials | undefined | "invalid" {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) return "invalid";
  const obj = value as Record<string, unknown>;
  const kind = obj.kind;
  if (kind === "none") {
    const result: NoneCredentials = { kind: "none" };
    return result;
  }
  if (kind === "static-bearer") {
    if (typeof obj.token !== "string" || obj.token.length === 0) return "invalid";
    const result: StaticBearerCredentials = {
      kind: "static-bearer",
      token: obj.token,
    };
    return result;
  }
  if (kind === "command-based") {
    if (typeof obj.command !== "string" || obj.command.length === 0) return "invalid";
    if (
      obj.args !== undefined &&
      (!Array.isArray(obj.args) || obj.args.some((arg) => typeof arg !== "string"))
    ) {
      return "invalid";
    }
    if (obj.tokenPath !== undefined && typeof obj.tokenPath !== "string") return "invalid";
    if (obj.expiryPath !== undefined && typeof obj.expiryPath !== "string") return "invalid";
    if (
      obj.refreshBufferSeconds !== undefined &&
      (typeof obj.refreshBufferSeconds !== "number" ||
        !Number.isFinite(obj.refreshBufferSeconds) ||
        obj.refreshBufferSeconds < 0)
    ) {
      return "invalid";
    }
    const result: CommandBasedCredentials = {
      kind: "command-based",
      command: obj.command,
      ...(Array.isArray(obj.args) ? { args: [...(obj.args as string[])] } : {}),
      ...(typeof obj.tokenPath === "string" ? { tokenPath: obj.tokenPath } : {}),
      ...(typeof obj.expiryPath === "string" ? { expiryPath: obj.expiryPath } : {}),
      ...(typeof obj.refreshBufferSeconds === "number"
        ? { refreshBufferSeconds: obj.refreshBufferSeconds }
        : {}),
    };
    return result;
  }
  if (kind === "oauth-pkce") {
    // Required fields per FR-012; types validated, but the entire object is
    // preserved (including any unknown future keys) so the persisted shape
    // round-trips byte-equivalent to disk (SC-008).
    if (typeof obj.authorizationEndpoint !== "string") return "invalid";
    if (typeof obj.tokenEndpoint !== "string") return "invalid";
    if (typeof obj.clientId !== "string") return "invalid";
    if (
      !Array.isArray(obj.scopes) ||
      obj.scopes.some((scope) => typeof scope !== "string")
    ) {
      return "invalid";
    }
    if (obj.tenantId !== undefined && typeof obj.tenantId !== "string") return "invalid";
    if (obj.redirectUri !== undefined && typeof obj.redirectUri !== "string") return "invalid";
    if (obj.refreshTokenRef !== undefined && typeof obj.refreshTokenRef !== "string") return "invalid";
    if (obj.pkceMethod !== undefined && typeof obj.pkceMethod !== "string") return "invalid";
    // Preserve full object (including unknown future keys) verbatim.
    const result: OAuthPkceCredentials = {
      ...(obj as OAuthPkceCredentials),
      kind: "oauth-pkce",
    };
    return result;
  }
  return "invalid";
}
