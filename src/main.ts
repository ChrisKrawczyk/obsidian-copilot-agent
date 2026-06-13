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

  async onload(): Promise<void> {
    console.log("[copilot-agent] Loading Phase 3 plugin");

    let cliPath: string;
    let baseDirectory: string;
    try {
      cliPath = resolveCliBinaryPath(this);
      baseDirectory = getAbsolutePluginDir(this) ?? process.cwd();
    } catch (err) {
      console.error("[copilot-agent] CLI resolution failed", err);
      new Notice(
        `[Copilot Agent] CLI binary not found: ${
          err instanceof Error ? err.message : String(err)
        }`,
        12000,
      );
      return;
    }

    const tokenStore = new TokenStore({
      loadData: () => this.loadData(),
      saveData: (data) => this.saveData(data),
    });

    const safetySettingsStore = new SafetySettingsStore({
      loadData: () => this.loadData(),
      saveData: (data) => this.saveData(data),
    });

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
    const exposeRawFsToolsAtStartup =
      safetySettingsStore.snapshot().exposeRawFsTools;
    const safetyState = new SafetyState();

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
    const liveRuntimes = new Set<{
      session: AgentSession;
      conversationId: string;
    }>();

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
        tools: filterRawFsToolsIfGated(
          [
            ...(readTools as unknown as import("./sdk/AgentSession").SdkTool[]),
            ...(writeTools as unknown as import("./sdk/AgentSession").SdkTool[]),
            ...(readNoteTools as unknown as import("./sdk/AgentSession").SdkTool[]),
            ...(searchTools as unknown as import("./sdk/AgentSession").SdkTool[]),
            ...(writeNoteTools as unknown as import("./sdk/AgentSession").SdkTool[]),
          ],
          exposeRawFsToolsAtStartup,
        ),
        safety: {
          config: () => {
            const snap = safetySettingsStore.snapshot();
            return {
              fsDefaultMode: snap.defaultMode,
              vaultAllowlist: snap.allowlist,
              builtinAutoApprove: snap.autoApproveBuiltins,
            };
          },
          state: safetyState,
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
          const vaultRoot =
            (
              this.app.vault.adapter as { getBasePath?: () => string }
            ).getBasePath?.() ?? baseDirectory;
          const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
          const todayInTimezone = formatTodayInTimezone(new Date(), timezone);
          const text = assemblePreamble({
            mode: va.mode,
            vaultRootAbsPath: vaultRoot,
            timezone,
            todayInTimezone,
            customBody: va.customBody,
            excludeRawFs: !exposeRawFsToolsAtStartup,
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

    const settingsTab = new CopilotAgentSettingTab(
      this.app,
      this,
      controller,
      tokenStore,
      safetySettingsStore,
      modelCatalog,
    );
    this.addSettingTab(settingsTab);

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
    const store = this.conversationsStore;
    const disposeShared = this.disposeSharedSdkClient;
    this.conversationManager = null;
    this.conversationsStore = null;
    this.disposeSharedSdkClient = null;
    // Flush BEFORE disposing runtimes so any in-flight debounced
    // conversation/undo writes land. dispose only cancels SDK streams;
    // the journal/store deltas are already committed in memory.
    await flushThenDispose(store, manager);
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

/**
 * Format `now` as YYYY-MM-DD in the supplied IANA timezone. Used by the
 * preamble callback so the model receives an unambiguous local date even
 * when the Obsidian renderer is running in a different host TZ.
 *
 * Moved to ./domain/formatToday so SettingsTab can render the preview
 * with the same date — see commit fixing the impl-review finding.
 */
