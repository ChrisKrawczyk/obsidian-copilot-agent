import { MarkdownView, Notice, Plugin } from "obsidian";
import {
  CopilotAgentSession,
  resolveHeuristicModelId,
  type AgentSession,
  type SdkClient,
  type SdkModule,
} from "./sdk/AgentSession";
import { ModelCatalog } from "./sdk/ModelCatalog";
import {
  resolveCliBinaryPath,
  getAbsolutePluginDir,
} from "./sdk/resolveCliBinaryPath";
import {
  FetcherError,
  detectPlatformTuple,
  ensureInstalled as ensureBinaryInstalled,
  getRequiredBinaryPath,
  isInstalled as isBinaryInstalled,
} from "./sdk/BinaryFetcher";
import { PINNED_BINARY_VERSION } from "./sdk/pinnedBinaryVersion";
import { denyAll } from "./domain/PermissionDecision";
import { registerChatView } from "./ui/ChatViewRegistration";
import { CopilotAgentSettingTab } from "./settings/SettingsTab";
import { obsidianHttpClient } from "./auth/HttpClient";
import { TokenStore } from "./auth/TokenStore";
import { AuthController, type AgentTokenSink } from "./auth/AuthController";
import { ConversationsStore } from "./persistence/ConversationsStore";
import { createReadTools } from "./tools/ReadTools";
import { createWriteTools } from "./tools/WriteTools";
import { ObsidianApi } from "./tools/ObsidianApi";
import { createReadNoteTools } from "./tools/ReadNoteTools";
import { createWriteNoteTools } from "./tools/WriteNoteTools";
import { createSearchTools } from "./tools/SearchTools";
import { resolveDailyNotePath } from "./tools/DailyNotePath";
import { SafetyState } from "./domain/SafetyPolicy";
import { SafetySettingsStore } from "./settings/SafetySettingsStore";
import { McpSettingsStore } from "./settings/McpSettingsStore";
import { McpManager } from "./mcp/McpManager";
import type { McpServerId } from "./mcp/McpTypes";
import { resolveMcpToolSourceMetadata } from "./mcp/McpToolIdentity";
import { buildMcpToolRegistrySnapshot } from "./mcp/McpToolRegistry";
import { createMcpSdkTools } from "./mcp/McpToolBridge";
import { assemblePreamble } from "./domain/PreambleAssembler";
import { formatTodayInTimezone } from "./domain/formatToday";
import { filterRawFsToolsIfGated } from "./domain/toolGating";
import { ConversationManager } from "./domain/ConversationManager";
import { flushThenDispose, makeQuitFlushHandler } from "./lifecycle";
import {
  hydrateChatState,
  type ConversationRuntime,
  makeRuntimeJournal,
  type ConversationRuntimeFactory,
} from "./domain/ConversationRuntime";

export interface McpLifecycleController {
  enableAllConfigured: () => Promise<void>;
  reconcileConfiguredServers: () => Promise<void>;
  unload: () => Promise<void>;
}

export function startMcpLifecycle(manager: Pick<McpLifecycleController, "enableAllConfigured">): Promise<void> {
  return manager.enableAllConfigured();
}

export function reconcileMcpLifecycle(manager: Pick<McpLifecycleController, "reconcileConfiguredServers">): Promise<void> {
  return manager.reconcileConfiguredServers();
}

export function disposeMcpLifecycle(manager: Pick<McpLifecycleController, "unload">): Promise<void> {
  return manager.unload();
}

export async function disableMcpServerLifecycle(
  manager: Pick<McpManager, "disable">,
  serverId: McpServerId,
): Promise<void> {
  await manager.disable(serverId);
}

export async function removeMcpServerLifecycle(
  manager: Pick<McpManager, "remove">,
  safetyStore: Pick<SafetySettingsStore, "revokeGrantsForServer">,
  serverId: McpServerId,
): Promise<void> {
  await manager.remove(serverId);
  await safetyStore.revokeGrantsForServer(serverId);
}

/**
 * Phase 3 wiring:
 *   1. Build TokenStore + AuthController early (they hold no SDK state).
 *   2. Build AgentSession with no token initially. AuthController will
 *      push the token in once Device Flow completes (or hydrate() finds
 *      a persisted one).
 *   3. Forward agent auth failures back into AuthController so the UI
 *      moves to `error` instead of silently retrying.
 */
export default class CopilotAgentPlugin extends Plugin {
  private conversationManager: ConversationManager | null = null;
  /** Held so `onunload()` can flush pending debounced writes before
   *  the plugin process is torn down. */
  private conversationsStore: ConversationsStore | null = null;
  /** v0.4 Phase 2: disposes the shared CopilotClient backing the
   *  catalog. Safe to call multiple times; idempotent. */
  private disposeSharedSdkClient: (() => Promise<void>) | null = null;
  mcpSettingsStore: McpSettingsStore | null = null;
  mcpManager: McpManager | null = null;
  /** v0.6 Phase 2: most-recent BinaryFetcher failure, surfaced by the
   *  Settings tab's CliBinarySection so the user can see why startup
   *  short-circuited and click Retry. Null on success or before any
   *  attempt has been made. */
  binaryFetchError: FetcherError | null = null;
  /** v0.6 Phase 2: exposed for CliBinarySection. */
  readonly pinnedBinaryVersion: string = PINNED_BINARY_VERSION;
  private settingsTab: CopilotAgentSettingTab | null = null;

  /**
   * v0.6 Phase 2: idempotent CLI binary acquisition. Called from Band B
   * of `onload()` and also from the Settings tab's Retry button.
   * Resolves to the binary path on success, null on failure (caller is
   * expected to read `this.binaryFetchError` for the reason).
   *
   * Behavior:
   *   1. If `isInstalled` reports true, returns the path immediately —
   *      preserves the dev-deploy fast path (FR-026).
   *   2. Otherwise constructs a persistent Notice ("Downloading…"),
   *      runs `BinaryFetcher.ensureInstalled` with byte-progress updates,
   *      and dismisses the Notice on resolution.
   *   3. On `FetcherError`, stores the error on the plugin instance and
   *      displays a 12-second error Notice routed to the user's Settings
   *      → CliBinarySection. Returns null.
   */
  async ensureCliBinaryReady(): Promise<string | null> {
    try {
      if (isBinaryInstalled(this, this.pinnedBinaryVersion)) {
        this.binaryFetchError = null;
        return getRequiredBinaryPath(this);
      }
    } catch (err) {
      if (err instanceof FetcherError && err.kind === "unsupported-platform") {
        this.binaryFetchError = err;
        new Notice(
          `[Copilot Agent] Unsupported platform. Open Settings → Copilot Agent for details.`,
          12000,
        );
        return null;
      }
      // Fall through and treat as a fetch attempt.
    }
    const startedAt = Date.now();
    const progressNotice = new Notice(
      "[Copilot Agent] Downloading Copilot CLI binary (~150 MB)… preparing",
      0,
    );
    let lastUpdate = 0;
    try {
      const path = await ensureBinaryInstalled(
        this,
        this.pinnedBinaryVersion,
        (bytes, total) => {
          // Throttle setMessage to ~5 Hz so we don't churn the DOM on
          // fast connections (chunks arrive every few ms).
          const now = Date.now();
          if (now - lastUpdate < 200 && bytes < (total ?? Infinity)) return;
          lastUpdate = now;
          const pct = total ? Math.min(100, Math.floor((bytes / total) * 100)) : null;
          const msg =
            pct !== null
              ? `[Copilot Agent] Downloading Copilot CLI binary… ${pct}% (${formatBytes(bytes)}/${formatBytes(total ?? bytes)})`
              : `[Copilot Agent] Downloading Copilot CLI binary… ${formatBytes(bytes)}`;
          try {
            (progressNotice as unknown as { setMessage?: (m: string) => void })
              .setMessage?.(msg);
          } catch {
            // Notice.setMessage isn't typed in all Obsidian versions; ignore.
          }
        },
      );
      // Show a brief success message before dismissing so a sub-second
      // download (enterprise fast networks) is still visible to the user.
      try {
        (progressNotice as unknown as { setMessage?: (m: string) => void })
          .setMessage?.(`[Copilot Agent] Copilot CLI binary installed (v${this.pinnedBinaryVersion}).`);
      } catch {
        // ignore
      }
      const elapsedMs = Date.now() - startedAt;
      const minDisplayMs = 2500;
      if (elapsedMs < minDisplayMs) {
        await new Promise((r) => setTimeout(r, minDisplayMs - elapsedMs));
      }
      progressNotice.hide();
      this.binaryFetchError = null;
      return path;
    } catch (err) {
      progressNotice.hide();
      const fe =
        err instanceof FetcherError
          ? err
          : new FetcherError(
              "filesystem",
              err instanceof Error ? err.message : String(err),
              err,
            );
      this.binaryFetchError = fe;
      console.error("[copilot-agent] CLI binary acquisition failed", fe);
      new Notice(
        `[Copilot Agent] Copilot CLI binary download failed (${fe.kind}). Open Settings → Copilot Agent → Retry.`,
        12000,
      );
      return null;
    }
  }

  async onload(): Promise<void> {
    console.log("[copilot-agent] Loading Phase 3 plugin");

    // === Band A — settings tab registered first so Retry is reachable
    // even when Band B fails. The tab is constructed with no late-bound
    // deps; only the CliBinarySection renders pre-attach. ===
    this.settingsTab = new CopilotAgentSettingTab(this.app, this);
    this.register(() => this.settingsTab?.hide());
    this.addSettingTab(this.settingsTab);

    // === Band B + C — deferred behind onLayoutReady so the download
    // Notice isn't hidden under Obsidian's plugin-loading splash screen,
    // and so a slow fetch can't trigger the "plugin took too long to
    // load" warning. We must NOT await onLayoutReady inside onload()
    // itself — that deadlocks because layout-ready fires after plugins
    // finish loading. Fire-and-forget the continuation. ===
    this.app.workspace.onLayoutReady(() => {
      void this.completeDeferredInit();
    });
  }

  private async completeDeferredInit(): Promise<void> {
    const cliPath = await this.ensureCliBinaryReady();
    if (!cliPath) {
      return;
    }
    const baseDirectory = getAbsolutePluginDir(this) ?? process.cwd();
    // resolveCliBinaryPath remains as the synchronous fast-path probe
    // for callsites that don't take a Promise; it should agree with
    // cliPath now that ensureInstalled succeeded.
    void resolveCliBinaryPath;

    // === Band C — runtime-ready init (existing pre-v0.6 onload body) ===

    const tokenStore = new TokenStore({
      loadData: () => this.loadData(),
      saveData: (data) => this.saveData(data),
    });

    const safetySettingsStore = new SafetySettingsStore({
      loadData: () => this.loadData(),
      saveData: (data) => this.saveData(data),
    });
    const mcpSettingsStore = new McpSettingsStore({
      loadData: () => this.loadData(),
      saveData: (data) => this.saveData(data),
    });
    this.mcpSettingsStore = mcpSettingsStore;

    // v0.3 Phase 3: ConversationsStore. Owns its own top-level
    // `conversations`/`activeConversationId`/`schemaVersion` keys but
    // shares the same data.json blob via merge-and-write. Settings UI
    // and chat layers don't touch it directly until Phase 4 wires the
    // ConversationManager.
    const pluginDataDir = `${this.app.vault.configDir}/plugins/${this.manifest.id}`;
    const conversationsStore = new ConversationsStore({
      io: {
        loadData: () => this.loadData(),
        saveData: (data) => this.saveData(data),
      },
      adapter: this.app.vault.adapter as unknown as ConstructorParameters<
        typeof ConversationsStore
      >[0]["adapter"],
      pluginDataDir,
      // v0.3 Phase 6 (SC-011): one-shot 5 MB warning. Notice text is
      // produced by the store; we only own the surface (so tests can
      // stub it without dragging in Obsidian's Notice).
      notify: (message) => {
        new Notice(message, 8000);
      },
    });
    void conversationsStore; // Phase 4 wires this into ConversationManager.
    this.conversationsStore = conversationsStore;
    // v0.3 Phase 1 (FR-014/FR-015 + C2-A): load safety settings BEFORE
    // constructing the agent so the gated-tools decision uses the
    // persisted value, not defaults. The snapshot captured here is
    // frozen for the lifetime of this plugin instance — toggling the
    // "Expose v0.1 raw-filesystem tools" setting from the UI updates
    // persisted state but does not reach this already-running session.
    // A plugin reload is required to re-snapshot, which is exactly the
    // "next session start" semantic FR-015 promises.
    try {
      await safetySettingsStore.load();
    } catch (e) {
      console.error("[copilot-agent] safety settings load failed", e);
    }
    try {
      await mcpSettingsStore.load();
    } catch (e) {
      console.error("[copilot-agent] MCP settings load failed", e);
    }
    const exposeRawFsToolsAtStartup =
      safetySettingsStore.snapshot().exposeRawFsTools;
    const safetyState = new SafetyState();
    const vaultRoot =
      (this.app.vault.adapter as { getBasePath?: () => string }).getBasePath?.() ??
      baseDirectory;
    const liveRuntimes = new Set<{
      session: AgentSession;
      conversationId: string;
    }>();
    const mcpManager = new McpManager({
      vaultRoot,
      serversProvider: () => mcpSettingsStore.snapshot(),
      notify: (message) => new Notice(message, 8000),
      persistStatus: (serverId, snapshot) =>
        mcpSettingsStore.recordStatus(serverId, snapshot).then(() => undefined),
      settleTrackedCalls: async (serverId) => {
        await Promise.all(Array.from(liveRuntimes).map(async ({ session }) => {
          session.cancelPendingMcpApprovalsForServer(serverId, "MCP server disconnected.");
          session.cancelMcpCallsForServer(serverId, "MCP server disconnected.");
        }));
      },
      onForcedKill: (event) => {
        // eslint-disable-next-line no-console -- documented redaction seam (Phase 6 forced MCP child shutdown warning)
        console.warn(`[Copilot Agent] ${event.reason} pid=${event.pid ?? "unknown"} serverId=${event.serverId}`);
      },
    });
    this.mcpManager = mcpManager;
    const unsubscribeMcpSettings = mcpSettingsStore.subscribe(() => {
      void reconcileMcpLifecycle(mcpManager).catch((err) => {
        console.warn("[copilot-agent] MCP lifecycle reconcile failed", err);
      });
    });
    this.register(unsubscribeMcpSettings);
    void startMcpLifecycle(mcpManager).catch((err) => {
      console.warn("[copilot-agent] MCP startup failed", err);
    });

    // v0.3 Phase 4: per-conversation runtime architecture. Replaces
    // the single global UndoJournal + AgentSession with a factory the
    // ConversationManager calls lazily, once per conversation.
    //
    // Tools are statically bound to *each* runtime's journal at
    // construction time, so the "active vs originating" mid-stream
    // conversation-switch class of bugs is structurally impossible.
    //
    // Read-only tools (readTools, readNoteTools, searchTools) hold no
    // per-conversation state and could in principle be shared, but
    // for cohesion we still build them inside the factory — the SDK
    // doesn't share `Tool` arrays across sessions.
    //
    // The frozen gated-tools snapshot (`exposeRawFsToolsAtStartup`)
    // is captured INTO the closure here, so toggling the setting
    // mid-session never reaches an already-built runtime nor any
    // future runtime within this plugin instance — exactly the FR-015
    // "next session start" semantic.

    // We need the AuthController reference before the agent (for
    // onAuthError) AND vice-versa (AuthController wraps the agent
    // token sink). Resolve by assigning post-construction.
    let controllerRef: AuthController | null = null;

    // ObsidianApi is stateless — share across runtimes.
    const ws = this.app.workspace as unknown as {
      getActiveFile: () => unknown;
      getActiveViewOfType: (k: unknown) => unknown;
      getLeaf: (n?: boolean) => unknown;
    };
    const obsidianApi = new ObsidianApi({
      vault: this.app.vault as unknown as Parameters<
        typeof createReadTools
      >[0],
      workspace: {
        getActiveFile: () =>
          ws.getActiveFile() as ReturnType<
            NonNullable<
              NonNullable<
                ConstructorParameters<typeof ObsidianApi>[0]["workspace"]
              >["getActiveFile"]
            >
          >,
        getActiveViewOfType: (kind: unknown) =>
          ws.getActiveViewOfType(kind) as ReturnType<
            NonNullable<
              NonNullable<
                ConstructorParameters<typeof ObsidianApi>[0]["workspace"]
              >["getActiveViewOfType"]
            >
          >,
        getLeaf: (newLeaf?: boolean) =>
          ws.getLeaf(newLeaf) as ReturnType<
            NonNullable<
              NonNullable<
                ConstructorParameters<typeof ObsidianApi>[0]["workspace"]
              >["getLeaf"]
            >
          >,
        markdownViewSymbol: MarkdownView,
      },
      metadataCache: this.app.metadataCache as unknown as ConstructorParameters<
        typeof ObsidianApi
      >[0]["metadataCache"],
      internalPlugins: (this.app as unknown as {
        internalPlugins?: ConstructorParameters<
          typeof ObsidianApi
        >[0]["internalPlugins"];
      }).internalPlugins,
      plugins: (this.app as unknown as {
        plugins?: ConstructorParameters<typeof ObsidianApi>[0]["plugins"];
      }).plugins,
    });

    const now = (): Date => new Date();

    // Latest token broadcast across all live runtime sessions. Updated
    // by the AuthController via the tokenSink and re-applied to any
    // newly-constructed runtime so it starts authenticated.
    let currentToken: string | null = null;

    // v0.4 (model-picker) Phase 2: shared CopilotClient + ModelCatalog.
    // This client is independent of per-conversation runtime clients
    // (each AgentSession constructs its own via doInit()). Its sole
    // job is to back `ModelCatalog.refresh()` so the Settings UI and
    // (Phase 4) chat-header picker can list available models without
    // racing per-conversation init. The catalog reads the live shared
    // client through a provider closure so token rotations can swap
    // it without re-constructing the catalog (and losing subscribers).
    let sharedSdkClient: SdkClient | null = null;
    let sharedSdkModulePromise: Promise<SdkModule> | null = null;
    const loadSharedSdk = (): Promise<SdkModule> => {
      if (!sharedSdkModulePromise) {
        sharedSdkModulePromise = import("@github/copilot-sdk").then(
          (m) => m as unknown as SdkModule,
        );
      }
      return sharedSdkModulePromise;
    };
    const disposeSharedClient = async (): Promise<void> => {
      const old = sharedSdkClient;
      sharedSdkClient = null;
      if (old) {
        try {
          await old.stop?.();
        } catch (err) {
          console.warn(
            "[copilot-agent] shared SDK client stop failed",
            err,
          );
        }
      }
    };
    const rebuildSharedClient = async (token: string | null): Promise<void> => {
      await disposeSharedClient();
      if (!token) return;
      try {
        const sdk = await loadSharedSdk();
        const Client = sdk.CopilotClient;
        if (!Client) throw new Error("SDK lacks CopilotClient");
        const next = new Client({
          gitHubToken: token,
          useLoggedInUser: false,
          mode: "empty",
          baseDirectory,
          connection: { kind: "stdio", path: cliPath },
          logLevel: "info",
        }) as SdkClient;
        // The SDK requires start()+ping() before any RPC (including
        // listModels). AgentSession does the same handshake for its
        // per-conversation client; the shared catalog client needs it
        // too or refresh() fails with "Client not connected".
        if (typeof next.start === "function") {
          await next.start();
        }
        if (typeof next.ping === "function") {
          await next.ping();
        }
        sharedSdkClient = next;
      } catch (err) {
        console.warn(
          "[copilot-agent] shared SDK client construction failed",
          err,
        );
        sharedSdkClient = null;
      }
    };
    const modelCatalog = new ModelCatalog(() => sharedSdkClient);
    this.disposeSharedSdkClient = disposeSharedClient;

    // Registry of live (instantiated) runtimes — used by the
    // broadcasting tokenSink so token rotations reach every runtime
    // that has actually been built. Lazily-uninstantiated runtimes
    // start with `currentToken` at construction time, so they don't
    // need broadcasts.
    // The factory that ConversationManager uses to materialize a
    // runtime on first activation. Captures all shared deps via
    // closure; binds tools to the per-runtime journal.
    const runtimeFactory: ConversationRuntimeFactory = (
      metadata,
      hydration,
      persistAdapter,
    ) => {
      // CONS-3 / Plan Phase 6: use the helper so the runtime journal
      // gets the defensive TTL backstop (`loadOptions.ttlMs`). The
      // authoritative 7-day prune still runs in `ConversationsStore.
      // pruneOnLoad` before any runtime is materialised; this guard is
      // for the rare case where a stale entry slips past the
      // pre-runtime prune (e.g. a never-opened conversation hydrating
      // after a long sleep).
      const journal = makeRuntimeJournal(
        this.app.vault as unknown as Parameters<typeof makeRuntimeJournal>[0],
        hydration?.undoEntries,
        persistAdapter,
      );

      const readTools = createReadTools(
        this.app.vault as unknown as Parameters<typeof createReadTools>[0],
      );
      const writeTools = createWriteTools({
        vault: this.app.vault as unknown as Parameters<
          typeof createWriteTools
        >[0]["vault"],
        workspace: this.app.workspace as unknown as Parameters<
          typeof createWriteTools
        >[0]["workspace"],
        undoJournal: journal,
      });
      const readNoteTools = createReadNoteTools(
        obsidianApi,
        this.app.vault as unknown as Parameters<typeof createReadTools>[0],
      );
      const searchTools = createSearchTools(
        obsidianApi,
        this.app.vault as unknown as Parameters<typeof createReadTools>[0],
      );
      const writeNoteTools = createWriteNoteTools({
        vault: this.app.vault as unknown as Parameters<
          typeof createWriteTools
        >[0]["vault"],
        workspace: this.app.workspace as unknown as Parameters<
          typeof createWriteTools
        >[0]["workspace"],
        undoJournal: journal,
        api: obsidianApi,
        now,
        vaultAwareness: () => safetySettingsStore.snapshot().vaultAwareness,
      });
      const vaultTools = filterRawFsToolsIfGated(
        [
          ...(readTools as unknown as import("./sdk/AgentSession").SdkTool[]),
          ...(writeTools as unknown as import("./sdk/AgentSession").SdkTool[]),
          ...(readNoteTools as unknown as import("./sdk/AgentSession").SdkTool[]),
          ...(searchTools as unknown as import("./sdk/AgentSession").SdkTool[]),
          ...(writeNoteTools as unknown as import("./sdk/AgentSession").SdkTool[]),
        ],
        exposeRawFsToolsAtStartup,
      );
      const mcpSnapshot = () =>
        buildMcpToolRegistrySnapshot({
          inventory: mcpManager.inventorySnapshot(),
          statuses: mcpManager.statusSnapshot(),
          builtinToolNames: vaultTools.map((tool) => tool.name),
          notify: (message) => new Notice(message, 8000),
        });

      const session = new CopilotAgentSession({
        cliPath,
        gitHubToken: currentToken,
        baseDirectory,
        decider: denyAll,
        logLevel: "info",
        onAuthError: (err) => controllerRef?.notifyAuthFailure(err),
        // v0.4 Phase 2: share the catalog with each AgentSession so
        // pickModel() can hit the cached chatModels list and skip the
        // per-session listModels() round-trip when the catalog is
        // already `ready`. Catalog-degraded states fall back to v0.3.
        catalog: modelCatalog,
        // v0.4 Phase 3 (FR-007 + SC-002): seed the per-conversation
        // model id from persisted metadata so reopening a conversation
        // re-uses its previously-resolved model rather than re-running
        // the global default → heuristic chain. `null` (v0.3-migrated)
        // and `undefined` (fresh-without-resolution) both mean
        // "AgentSession.pickModel decides at init"; Phase 5 will add
        // lazy resolution + backfill.
        preferredModel:
          typeof metadata.modelId === "string" && metadata.modelId.length > 0
            ? metadata.modelId
            : undefined,
        // v0.3 Phase 1: gated tool list captured at plugin onload and
        // frozen via `exposeRawFsToolsAtStartup`. Toggling the setting
        // mid-session does not reach this runtime, nor any future
        // runtime built within this plugin instance — exactly the
        // FR-015 "next session start" semantic.
        tools: vaultTools,
        mcpTools: () =>
          createMcpSdkTools(mcpSnapshot(), { manager: mcpManager }) as unknown as import("./sdk/AgentSession").SdkTool[],
        safety: {
          config: () => {
            const snap = safetySettingsStore.snapshot();
            return {
              fsDefaultMode: snap.defaultMode,
              vaultAllowlist: snap.allowlist,
              builtinAutoApprove: snap.autoApproveBuiltins,
              mcpAutoApprove: snap.mcpAutoApprove,
            };
          },
          state: safetyState,
          getMcpToolSourceMetadata: (req) =>
            resolveMcpToolSourceMetadata(
              typeof req.toolName === "string" ? req.toolName : undefined,
              mcpSettingsStore.snapshot(),
              new Map(mcpManager.statusSnapshot().map((snapshot) => [snapshot.id, snapshot.status])),
            ),
          extractVaultPath: (req) => {
            const r = req as { toolName?: unknown; args?: { path?: unknown } };
            const tool = typeof r.toolName === "string" ? r.toolName : "";
            if (tool === "create_daily_note") {
              return resolveDailyNotePath(obsidianApi, now()).path;
            }
            if (tool === "insert_into_active_note") {
              return obsidianApi.getActiveNotePath() ?? undefined;
            }
            if (tool === "create_task") {
              const va = safetySettingsStore.snapshot().vaultAwareness;
              if (
                va.taskTargetMode === "custom-path" &&
                typeof va.customTaskTargetPath === "string" &&
                va.customTaskTargetPath.trim().length > 0
              ) {
                return va.customTaskTargetPath.trim();
              }
              return resolveDailyNotePath(obsidianApi, now()).path;
            }
            const args = r.args;
            return typeof args?.path === "string" ? args.path : undefined;
          },
        },
        preamble: () => {
          const va = safetySettingsStore.snapshot().vaultAwareness;
          if (va.mode === "none") return null;
          const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
          const todayInTimezone = formatTodayInTimezone(new Date(), timezone);
          const text = assemblePreamble({
            mode: va.mode,
            vaultRootAbsPath: vaultRoot,
            timezone,
            todayInTimezone,
            customBody: va.customBody,
            excludeRawFs: !exposeRawFsToolsAtStartup,
            mcp: { tools: mcpSnapshot().tools },
          });
          return text || null;
        },
      });

      const state = hydrateChatState(hydration?.messages);
      const liveEntry = { session, conversationId: metadata.id };
      liveRuntimes.add(liveEntry);

      const runtime: ConversationRuntime = {
        conversationId: metadata.id,
        session,
        journal,
        state,
        async setModelId(newId, opts) {
          // v0.4 FR-005: freeze any live streaming placeholder as
          // `interrupted` BEFORE the SDK abort fires so the stream
          // finalizer buckets the cancellation as a clean interruption
          // rather than as `error`. Mirrors ChatView.handleStop().
          state.interruptStreamingMessage();
          await session.swapModel(newId);
          if (opts.persist) {
            try {
              conversationManager.setConversationModelId(metadata.id, newId);
            } catch (err) {
              console.warn(
                "[copilot-agent] setConversationModelId after swap failed",
                err,
              );
            }
          }
        },
        async dispose() {
          liveRuntimes.delete(liveEntry);
          try {
            await session.dispose();
          } catch (err) {
            console.warn("[copilot-agent] runtime session.dispose threw", err);
          }
        },
      };
      return runtime;
    };

    // Construct the conversation manager. It will hydrate from the
    // ConversationsStore once the async hydrate block runs below.
    const conversationManager = new ConversationManager({
      runtimeFactory,
      store: conversationsStore,
      // v0.4 Phase 3 (FR-007): synchronous resolver that walks the
      // priority chain at creation time. Returns null when the catalog
      // is non-ready so AgentSession.pickModel falls back to v0.3
      // listModels at init (Phase 5 will add lazy backfill).
      resolveCreationModelId: () => {
        const configuredDefault =
          safetySettingsStore.snapshot().defaultModelId;
        const state = modelCatalog.getState();
        if (state.kind !== "ready") {
          return { modelId: null, configuredDefault };
        }
        if (
          typeof configuredDefault === "string" &&
          configuredDefault.length > 0
        ) {
          if (modelCatalog.isModelAvailable(configuredDefault)) {
            return { modelId: configuredDefault, configuredDefault };
          }
          // Configured default not in chatModels → fall through to
          // heuristic, then surface a one-shot Notice.
          const heuristic = resolveHeuristicModelId(state.chatModels);
          return {
            modelId: heuristic,
            configuredDefault,
            defaultWasUnavailable: true,
          };
        }
        return {
          modelId: resolveHeuristicModelId(state.chatModels),
          configuredDefault: null,
        };
      },
      onUnavailableDefault: (configuredDefault) => {
        new Notice(
          `Configured default model "${configuredDefault}" is not available. Falling back to a recommended model.`,
          6000,
        );
      },
    });
    this.conversationManager = conversationManager;

    // Broadcasting token sink: pushes token updates to every live
    // runtime AND remembers the latest value for runtimes that haven't
    // been instantiated yet (they pick it up from `currentToken` at
    // construction time).
    const tokenSink: AgentTokenSink = {
      setToken: async (token) => {
        currentToken = token;
        for (const entry of liveRuntimes) {
          try {
            await entry.session.setToken(token);
          } catch (err) {
            console.warn("[copilot-agent] session.setToken broadcast", err);
          }
        }
        // v0.4 Phase 2: rebuild the shared catalog client whenever
        // the token rotates (entitlements may have changed). We don't
        // await the refresh — Settings UI subscribes to catalog state
        // and re-renders on its own; failures stay scoped to the
        // catalog's `error` state and don't break auth.
        await rebuildSharedClient(token);
        void modelCatalog.refresh().catch((err) => {
          console.warn("[copilot-agent] modelCatalog.refresh failed", err);
        });
      },
      reconnect: async () => {
        // Reconnect every live session; only one can stream at a time
        // per SI-11 but token rotations may require all to refresh.
        const targets = Array.from(liveRuntimes);
        const results = await Promise.all(
          targets.map((e) =>
            e.session
              .reconnect()
              .then((id: string | undefined) => id)
              .catch((err: unknown) => {
                console.warn(
                  "[copilot-agent] session.reconnect broadcast",
                  err,
                );
                return undefined;
              }),
          ),
        );
        // Surface the first model id we successfully resolved so the
        // AuthController UI can display it (matches v0.2 behaviour where
        // there was a single session).
        return results.find((id): id is string => typeof id === "string");
      },
    };
    const controller = new AuthController({
      http: obsidianHttpClient(),
      tokenStore,
      agentTokenSink: tokenSink,
    });
    controllerRef = controller;

    // Hydrate from disk asynchronously. We don't block onload — the
    // chat view subscribes to the AuthController and renders whatever
    // state arrives.
    //
    // Note: `safetySettingsStore.load()` already ran above (synchronously
    // awaited before agent construction, so the v0.3 raw-FS gating
    // decision uses the persisted value). We don't reload it here.
    void (async () => {
      try {
        await tokenStore.load();
        // v0.3 Phase 3: hydrate persisted conversations + run TTL prune
        // BEFORE auth hydrate. The reconnect step inside auth hydrate
        // calls `tokenSink.reconnect()` which broadcasts to every live
        // ConversationRuntime — if no runtime is live yet, the model id
        // can't be resolved and the UI shows "Connected" without the
        // model name. Materialising the active runtime before auth
        // hydrate keeps the model display populated on first load.
        const result = await conversationsStore.load();
        if (result.recovered) {
          new Notice(
            `[Copilot Agent] Conversation history was unreadable and has been reset. A backup of the prior data was saved to: ${
              result.recoveryPath ?? "(plugin data dir)"
            }`,
            12000,
          );
        }
        const pruned = conversationsStore.pruneOnLoad();
        if (pruned.droppedCount > 0) {
          await conversationsStore.flushNow();
        }
        // v0.3 Phase 4: hydrate the manager from the loaded store.
        // This establishes the catalog + active id, but does NOT
        // instantiate any runtime yet (lazy on first getActiveRuntime).
        const snap = conversationsStore.snapshot();
        conversationManager.hydrate({
          conversations: snap.conversations,
          activeConversationId: snap.activeConversationId,
        });
        // Materialise the active runtime so the broadcasting tokenSink
        // has a live AgentSession to forward setToken/reconnect to
        // during auth hydrate (otherwise the resolved model id never
        // makes it back to the UI on first load).
        try {
          conversationManager.getActiveRuntime();
        } catch (err) {
          console.warn(
            "[copilot-agent] failed to warm active runtime pre-auth",
            err,
          );
        }
        await controller.hydrate();
        // v0.4 Phase 2: kick the catalog after auth hydrate so the
        // Settings UI shows real models the moment it opens. The
        // tokenSink also fires `setToken` on every rotation which
        // re-runs this; the explicit call here covers the case where
        // hydrate finds a persisted token and pushes it directly
        // without going through the sink.
        if (currentToken) {
          await rebuildSharedClient(currentToken);
          void modelCatalog.refresh().catch((err) => {
            console.warn("[copilot-agent] modelCatalog.refresh failed", err);
          });
        }
      } catch (e) {
        console.error("[copilot-agent] hydrate failed", e);
        new Notice(
          `[Copilot Agent] Auth hydrate failed: ${
            e instanceof Error ? e.message : String(e)
          }`,
          8000,
        );
      }
    })();

    if (this.settingsTab) {
      this.settingsTab.attachLateDeps({
        authController: controller,
        tokenStore,
        safetyStore: safetySettingsStore,
        modelCatalog,
        mcpSettingsStore,
        mcpManager,
      });
    }

    registerChatView(this, {
      manager: conversationManager,
      auth: controller,
      // SINGLE-2 / FR-015: Undo suppression must match the runtime's
      // actual tool surface, which was frozen at plugin onload via
      // `exposeRawFsToolsAtStartup`. Reading the live setting here
      // would let a mid-session toggle hide Undo buttons even though
      // the running runtime still has those tools registered.
      getExposeRawFsTools: () => exposeRawFsToolsAtStartup,
      // v0.4 Phase 4: shared catalog so the chat header's model
      // picker can read state + subscribe to refresh transitions
      // without re-listing models per view.
      modelCatalog,
      openSettings: () => {
        const setting = (this.app as unknown as {
          setting?: {
            open: () => void;
            openTabById: (id: string) => void;
          };
        }).setting;
        if (setting?.open && setting?.openTabById) {
          setting.open();
          setting.openTabById(this.manifest.id);
        } else {
          new Notice(
            "Open Settings → Community plugins → Copilot Agent to connect.",
            6000,
          );
        }
      },
    });

    // v0.3 Phase 5 (FR-008 durability): Obsidian awaits handlers on
    // its `quit` event before closing the app, giving us a final
    // opportunity to flush any pending debounced writes. `onunload`
    // covers plugin disable/reload; `quit` covers the close-window
    // path where `onunload` may or may not fire depending on platform.
    // Typed loosely because the Obsidian d.ts in this repo's
    // node_modules doesn't declare the `quit` channel.
    try {
      const ws = this.app.workspace as unknown as {
        on?: (name: string, cb: () => void | Promise<void>) => unknown;
      };
      const ref = ws.on?.("quit", makeQuitFlushHandler(() => this.conversationsStore));
      if (ref) this.register(() => (this.app.workspace as unknown as {
        offref?: (r: unknown) => void;
      }).offref?.(ref));
    } catch (err) {
      console.warn("[copilot-agent] could not register quit handler", err);
    }
  }

  async onunload(): Promise<void> {
    console.log("[copilot-agent] Unloading");
    const manager = this.conversationManager;
    const mcpManager = this.mcpManager;
    const store = this.conversationsStore;
    const disposeShared = this.disposeSharedSdkClient;
    this.conversationManager = null;
    this.mcpManager = null;
    this.conversationsStore = null;
    this.disposeSharedSdkClient = null;
    this.mcpSettingsStore = null;
    // Flush BEFORE disposing runtimes so any in-flight debounced
    // conversation/undo writes land. dispose only cancels SDK streams;
    // the journal/store deltas are already committed in memory.
    await flushThenDispose(store, manager);
    if (mcpManager) {
      await disposeMcpLifecycle(mcpManager);
    }
    // v0.4 Phase 2: stop the shared catalog client AFTER the per-
    // conversation runtimes are torn down so we don't race them on
    // shutdown.
    if (disposeShared) {
      try {
        await disposeShared();
      } catch (err) {
        console.warn(
          "[copilot-agent] shared SDK client dispose failed",
          err,
        );
      }
    }
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

void detectPlatformTuple; // re-export anchor; consumed by tests

/**
 * Format `now` as YYYY-MM-DD in the supplied IANA timezone. Used by the
 * preamble callback so the model receives an unambiguous local date even
 * when the Obsidian renderer is running in a different host TZ.
 *
 * Moved to ./domain/formatToday so SettingsTab can render the preview
 * with the same date — see commit fixing the impl-review finding.
 */
