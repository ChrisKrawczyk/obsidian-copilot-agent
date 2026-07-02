import type {
  McpRuntimeStatus,
  McpServerConfig,
  McpServerId,
  McpServerRuntimeSnapshot,
  McpToolInventoryEntry,
  ServerCredentials,
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
import {
  CredentialResolutionFailed,
  type CredentialResolver,
  type CredentialResolutionError,
  type ResolvedCredential,
} from "./credentials/CredentialResolver";
import {
  DefaultRemediationFormatter,
  type RemediationContext,
  type RemediationFormatter,
} from "./credentials/RemediationFormatter";
import { McpHttpError } from "./McpHttpError";

export interface McpManagerOptions extends McpServerRuntimeOptions {
  serversProvider: () => McpServerConfig[];
  persistStatus?: (serverId: McpServerId, snapshot: McpServerRuntimeSnapshot) => void | Promise<void>;
  notify?: (message: string) => void;
  runtimeFactory?: (config: McpServerConfig, options: McpServerRuntimeOptions) => McpServerRuntime;
  settleTrackedCalls?: (serverId: McpServerId) => void | Promise<void>;
  builtinToolNames?: readonly string[];
  /** Optional credential resolver (Phase 4). When absent, HTTP servers fall back to `config.authorization`. */
  credentialResolver?: CredentialResolver;
  /** Optional remediation formatter (Phase 4). Defaults to `DefaultRemediationFormatter`. */
  remediationFormatter?: RemediationFormatter;
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
  private readonly remediationFormatter: RemediationFormatter;
  /** Tracks whether the most recent HTTP call already retried after a 401 (prevents re-entrant retry storms). */
  private retryGuard = new Set<McpServerId>();

  constructor(private readonly options: McpManagerOptions) {
    this.remediationFormatter = options.remediationFormatter ?? new DefaultRemediationFormatter();
  }

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
    // Idempotency guard: if there's no runtime, or the runtime is already in
    // its terminal disabled state with no inventory, this is a no-op. This
    // matters because the settings store subscriber re-invokes reconcile (and
    // hence disable) on every persist; without this short-circuit, the chain
    // becomes a self-feeding loop that freezes the UI.
    if (!runtime && !this.inventories.has(serverId) && !this.reconnectPolicies.has(serverId)) {
      return;
    }
    if (runtime && runtime.snapshot().status === "disabled" && !this.inventories.has(serverId)) {
      return;
    }
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

  /**
   * Phase 9 (MCP readiness gate): resolves when every currently-enabled
   * MCP server has reached a terminal runtime status — `connected`,
   * `error`, `crashloop`, or `disabled`. `connecting` and `reconnecting`
   * are transient and block resolution until they settle.
   *
   * Used by `CopilotAgentSession.init()` to delay `client.createSession()`
   * until MCP tool inventories are populated for enabled servers. Without
   * this gate, on plugin reload the SDK session is created with an empty
   * MCP tool list because stdio child processes are still spawning; the
   * tool list is then frozen for the lifetime of that session (there is
   * no `updateTools()` API in the current SDK version).
   *
   * Semantics:
   *  - Servers whose runtime does not yet exist (getOrCreate hasn't fired
   *    for them yet) are treated as "not ready", so we wait for the
   *    lifecycle to have at least attempted them.
   *  - `error` / `crashloop` are terminal for this gate: a broken server
   *    should not block the whole session forever. The user will still
   *    see the error in settings; missing tools from that specific server
   *    are the acceptable outcome.
   *  - On timeout, resolves with whatever tools are ready. Degrading
   *    gracefully is better than hanging the agent.
   *  - If no servers are enabled, resolves immediately.
   *
   * Never rejects.
   */
  async waitUntilEnabledReady(timeoutMs: number): Promise<void> {
    const isTerminal = (status: McpRuntimeStatus): boolean =>
      status === "connected" ||
      status === "error" ||
      status === "crashloop" ||
      status === "disabled";
    const enabledIds = (): Set<McpServerId> =>
      new Set(
        this.options
          .serversProvider()
          .filter((c) => c.enabled)
          .map((c) => c.id),
      );
    const allReady = (): boolean => {
      const ids = enabledIds();
      if (ids.size === 0) return true;
      const statusById = new Map(
        this.statusSnapshot().map((s) => [s.id, s.status] as const),
      );
      for (const id of ids) {
        const status = statusById.get(id);
        if (!status) return false; // runtime not yet created
        if (!isTerminal(status)) return false;
      }
      return true;
    };
    if (allReady()) return;
    await new Promise<void>((resolve) => {
      let done = false;
      const finish = (): void => {
        if (done) return;
        done = true;
        try {
          unsub();
        } catch {
          /* ignore */
        }
        clearTimeout(timer);
        resolve();
      };
      const unsub = this.subscribe(() => {
        if (allReady()) finish();
      });
      const timer = setTimeout(finish, Math.max(0, timeoutMs));
    });
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
      const invoke = (): Promise<unknown> => {
        const call = typeof (runtime as McpServerRuntime & { callToolCancellable?: (name: string, args: Record<string, unknown>, timeoutMs?: number, signal?: AbortSignal) => Promise<unknown> }).callToolCancellable === "function"
          ? (runtime as McpServerRuntime & { callToolCancellable: (name: string, args: Record<string, unknown>, timeoutMs?: number, signal?: AbortSignal) => Promise<unknown> }).callToolCancellable(toolName, args, config.callTimeoutMs, signal)
          : runtime.callTool(toolName, args, config.callTimeoutMs);
        return withTimeout(
          call,
          config.callTimeoutMs ?? MCP_CALL_TIMEOUT_MS,
          "MCP tool call timed out.",
          this.options.setTimeout,
          this.options.clearTimeout,
        );
      };
      let result: unknown;
      try {
        result = await invoke();
      } catch (firstErr) {
        // FR-014 + SC-004: credential resolution failures propagate up from
        // the dynamic getAuthorization callback. Surface them via the
        // formatter so the user sees a command-failed / timeout hint
        // instead of a downstream HTTP error.
        if (firstErr instanceof CredentialResolutionFailed) {
          throw this.formatResolutionError(config, firstErr);
        }
        const httpErr = extractMcpHttpError(firstErr);
        // FR-005, FR-007: on a 401 we invalidate the credential cache and
        // retry exactly once. A second 401 is surfaced through the
        // remediation formatter rather than retried again.
        if (
          httpErr?.status === 401 &&
          config.transport === "http" &&
          this.options.credentialResolver &&
          !this.retryGuard.has(serverId)
        ) {
          this.retryGuard.add(serverId);
          try {
            this.options.credentialResolver.invalidate(serverId);
            result = await invoke();
          } catch (retryErr) {
            const retryHttp = extractMcpHttpError(retryErr);
            if (retryHttp?.status === 401) {
              // SM-6 + FR-009: a second 401 means the freshly-resolved
              // credentials were also rejected. Update the runtime snapshot
              // so the settings row reflects the rejection (the previous
              // implementation only updated the chat error).
              this.recordServerCredentialRejection(
                serverId,
                config,
                retryHttp.wwwAuthenticate ?? undefined,
              );
              throw this.formatRemediationError(config, "unauthorized", retryHttp.wwwAuthenticate ?? undefined);
            }
            // PA-3: if the retry path itself failed during credential
            // resolution (e.g. `az` now exits non-zero), reformat through
            // the same path used on the first try so the user-facing
            // error retains the `az login` hint instead of being
            // stringified as a raw `CredentialResolutionFailed`.
            if (retryErr instanceof CredentialResolutionFailed) {
              throw this.formatResolutionError(config, retryErr);
            }
            throw retryErr;
          } finally {
            this.retryGuard.delete(serverId);
          }
        } else if (httpErr?.status === 403) {
          // FR-005: 403 is a consent / authorization failure, not a stale
          // token — surface remediation without retrying.
          throw this.formatRemediationError(config, "denied", httpErr.wwwAuthenticate ?? undefined);
        } else {
          throw firstErr;
        }
      }
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

  private formatRemediationError(
    config: McpServerConfig,
    kind: "unauthorized" | "denied",
    detail: string | undefined,
  ): Error {
    const credentials: ServerCredentials | undefined =
      config.transport === "http" ? config.credentials : undefined;
    const variant: ServerCredentials["kind"] = credentials?.kind ?? "none";
    const command =
      credentials && credentials.kind === "command-based" ? credentials.command : null;
    const ctx: RemediationContext = {
      variant,
      command,
      lastTenantId:
        this.options.credentialResolver?.getLastKnownTenantId?.(config.id) ?? null,
      error: { kind, detail },
    };
    const remediation = this.remediationFormatter.format(ctx);
    return new Error(redactSensitive(formatMessageWithCopyable(remediation.text, remediation.copyable)));
  }

  private formatResolutionError(config: McpServerConfig, err: CredentialResolutionFailed): Error {
    const credentials: ServerCredentials | undefined =
      config.transport === "http" ? config.credentials : undefined;
    const variant: ServerCredentials["kind"] = credentials?.kind ?? "none";
    const command =
      credentials && credentials.kind === "command-based" ? credentials.command : null;
    const kind: "timeout" | "command-failed" =
      err.error.kind === "timeout" ? "timeout" : "command-failed";
    const remediation = this.remediationFormatter.format({
      variant,
      command,
      lastTenantId:
        this.options.credentialResolver?.getLastKnownTenantId?.(config.id) ?? null,
      error: { kind, detail: err.error.detail },
    });
    return new Error(redactSensitive(formatMessageWithCopyable(remediation.text, remediation.copyable)));
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
    const runtimeOptions: McpServerRuntimeOptions = {
      ...this.options,
      onListChanged: (id) => this.handleListChanged(id),
      // Bind a dynamic Authorization provider per server so HTTP runtimes
      // pick up credential rotations without rebinding the transport.
      getAuthorization: config.transport === "http"
        ? () => this.resolveAuthorizationForServer(config.id)
        : undefined,
    };
    const runtime = this.options.runtimeFactory
      ? this.options.runtimeFactory(config, runtimeOptions)
      : new McpServerRuntime(config, runtimeOptions);
    this.runtimes.set(config.id, runtime);
    this.runtimeIdentityKeys.set(config.id, runtimeIdentityKey(config));
    return runtime;
  }

  /**
   * Phase 4: resolve the dynamic Authorization header for an HTTP server.
   *
   * Returns the authorization string (Bearer-prefixed), or `null` when the
   * server has no credentials configured. When the resolver throws and no
   * legacy `config.authorization` fallback exists, the error is re-thrown
   * so it propagates through `getAuthorization()` → fetch wrapper → SDK →
   * `callTool` catch block, which renders a remediation hint via the
   * formatter. This is the FR-014 / SC-004 contract: a failed credential
   * command surfaces a `command-failed` chat error, not a generic 401.
   */
  private async resolveAuthorizationForServer(serverId: McpServerId): Promise<string | null> {
    const config = this.options.serversProvider().find((s) => s.id === serverId);
    if (!config || config.transport !== "http") return null;
    const credentials: ServerCredentials | undefined = config.credentials;
    const resolver = this.options.credentialResolver;
    if (!credentials || !resolver) {
      return config.authorization ?? null;
    }
    try {
      const resolved: ResolvedCredential | null = await resolver.resolve(serverId, credentials);
      this.recordCredentialSuccess(serverId, credentials.kind, resolved);
      return resolved?.authorization ?? config.authorization ?? null;
    } catch (err) {
      this.recordCredentialFailure(serverId, credentials, err);
      // FR-014 + SC-004: if no static fallback exists, propagate so the chat
      // error reports the underlying credential failure (command-failed /
      // timeout) rather than a downstream 401 with no token to retry with.
      if (!config.authorization) throw err;
      return config.authorization;
    }
  }

  private recordCredentialSuccess(
    serverId: McpServerId,
    variant: ServerCredentials["kind"],
    resolved: ResolvedCredential | null,
  ): void {
    const runtime = this.runtimes.get(serverId);
    if (!runtime?.setCredentialSnapshot) return;
    if (!resolved) {
      runtime.setCredentialSnapshot({ state: "not-applicable", variant });
      return;
    }
    // SM-3 / Phase 5 minimum: when expiry is known, also compute the next
    // refresh point (expiry minus refresh buffer) so the settings row can
    // render a "Next refresh in N min" hint.
    const config = this.options.serversProvider().find((s) => s.id === serverId);
    const credentials: ServerCredentials | undefined =
      config && config.transport === "http" ? config.credentials : undefined;
    const refreshBufferMs =
      credentials && credentials.kind === "command-based"
        ? (credentials.refreshBufferSeconds ?? 300) * 1000
        : 0;
    const nextRefreshAt =
      resolved.expiresAt != null
        ? Math.max(0, resolved.expiresAt - refreshBufferMs)
        : null;
    runtime.setCredentialSnapshot({
      state: "ok",
      variant,
      ...(resolved.expiresAt != null ? { expiresAt: resolved.expiresAt } : {}),
      ...(nextRefreshAt != null ? { nextRefreshAt } : {}),
    });
  }

  /**
   * SM-6 / FR-009: called when the server returns 401 even after the
   * 401-retry path re-resolved credentials. Updates the runtime snapshot so
   * the settings row shows the rejection (the previous implementation only
   * surfaced the rejection through the chat error).
   */
  private recordServerCredentialRejection(
    serverId: McpServerId,
    config: McpServerConfig,
    wwwAuthenticate: string | undefined,
  ): void {
    const runtime = this.runtimes.get(serverId);
    if (!runtime?.setCredentialSnapshot) return;
    const credentials: ServerCredentials | undefined =
      config.transport === "http" ? config.credentials : undefined;
    if (!credentials) return;
    const remediation = this.remediationFormatter.format({
      variant: credentials.kind,
      command: credentials.kind === "command-based" ? credentials.command : null,
      lastTenantId: this.options.credentialResolver?.getLastKnownTenantId?.(serverId) ?? null,
      error: { kind: "unauthorized", detail: wwwAuthenticate },
    });
    runtime.setCredentialSnapshot({
      state: "failed",
      variant: credentials.kind,
      lastError: redactSensitive("Credentials rejected by server."),
      remediation: redactSensitive(remediation.text),
      ...(remediation.copyable ? { copyable: redactSensitive(remediation.copyable) } : {}),
    });
  }

  private recordCredentialFailure(
    serverId: McpServerId,
    credentials: ServerCredentials,
    err: unknown,
  ): void {
    const runtime = this.runtimes.get(serverId);
    if (!runtime?.setCredentialSnapshot) return;
    const errorKind = mapResolutionErrorKind(err);
    const remediation = this.remediationFormatter.format({
      variant: credentials.kind,
      command: credentials.kind === "command-based" ? credentials.command : null,
      lastTenantId: this.options.credentialResolver?.getLastKnownTenantId?.(serverId) ?? null,
      error: { kind: errorKind, detail: extractResolutionDetail(err) },
    });
    runtime.setCredentialSnapshot({
      state: "failed",
      variant: credentials.kind,
      lastError: redactSensitive(extractResolutionDetail(err) ?? "Credential resolution failed."),
      remediation: redactSensitive(remediation.text),
      ...(remediation.copyable ? { copyable: redactSensitive(remediation.copyable) } : {}),
    });
    this.options.notify?.(redactSensitive(`[Copilot Agent] ${formatMessageWithCopyable(remediation.text, remediation.copyable)}`));
  }

  /**
   * Phase 4 hook: settings UI calls this when the credentials block (and only
   * the credentials block) of a server changes. Invalidates the resolver's
   * cache so the next request triggers a fresh resolution. MUST NOT revoke
   * SafetyPolicy grants (FR-011: credential edits leave trust-epoch invariant).
   */
  onCredentialConfigChanged(serverId: McpServerId): void {
    this.options.credentialResolver?.invalidate(serverId);
  }

  /**
   * Phase 4 surface (full impl in Phase 5 settings UI): spin up a transient
   * runtime, attempt initialize, then tear down — without touching the live
   * runtime / inventory / grants. Returns a structured result the UI can
   * render. This skeleton wires through the same credential resolver so
   * test-time credential failures surface identical messaging to live use.
   */
  async testConnection(serverId: McpServerId): Promise<{ ok: true } | { ok: false; error: string }> {
    const config = this.find(serverId);
    if (config.transport !== "http") {
      return { ok: false, error: "testConnection currently supports HTTP servers only." };
    }
    const runtimeOptions: McpServerRuntimeOptions = {
      ...this.options,
      getAuthorization: () => this.resolveAuthorizationForServer(serverId),
    };
    const transient = this.options.runtimeFactory
      ? this.options.runtimeFactory(config, runtimeOptions)
      : new McpServerRuntime(config, runtimeOptions);
    try {
      await transient.connect({ manual: true });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: redactSensitive(err instanceof Error ? err.message : String(err)) };
    } finally {
      try {
        await transient.unload();
      } catch {
        // ignore teardown errors — transient resource only
      }
    }
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

function extractMcpHttpError(err: unknown): McpHttpError | null {
  if (err instanceof McpHttpError) return err;
  // SDK transports may wrap errors thrown from the fetch layer. Walk the
  // common nesting points so a wrapped 401 is still detected.
  const candidates: unknown[] = [];
  if (err && typeof err === "object") {
    const e = err as { cause?: unknown; originalError?: unknown; error?: unknown };
    candidates.push(e.cause, e.originalError, e.error);
  }
  for (const candidate of candidates) {
    if (candidate instanceof McpHttpError) return candidate;
  }
  return null;
}

function mapResolutionErrorKind(err: unknown): "command-failed" | "timeout" | "unauthorized" {
  if (err instanceof CredentialResolutionFailed) {
    const e: CredentialResolutionError = err.error;
    if (e.kind === "timeout") return "timeout";
    return "command-failed";
  }
  return "command-failed";
}

function extractResolutionDetail(err: unknown): string | undefined {
  if (err instanceof CredentialResolutionFailed) return err.error.detail;
  if (err instanceof Error) return err.message;
  return undefined;
}

/**
 * PA-1 / FR-014: append `Run: <copyable>` to the user-facing error message
 * when the formatter produced a copyable remediation command (e.g.
 * `az login --tenant <id>`). Single source of truth so chat error and
 * settings row stay in sync.
 */
function formatMessageWithCopyable(text: string, copyable: string | undefined): string {
  if (!copyable) return text;
  return `${text}\nRun: ${copyable}`;
}
