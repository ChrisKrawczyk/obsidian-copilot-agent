import { MarkdownView, Notice, Plugin } from "obsidian";
import {
  CopilotAgentSession,
  type AgentSession,
} from "./sdk/AgentSession";
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
import { createReadTools } from "./tools/ReadTools";
import { createWriteTools } from "./tools/WriteTools";
import { ObsidianApi } from "./tools/ObsidianApi";
import { createReadNoteTools } from "./tools/ReadNoteTools";
import { createWriteNoteTools } from "./tools/WriteNoteTools";
import { createSearchTools } from "./tools/SearchTools";
import { resolveDailyNotePath } from "./tools/DailyNotePath";
import { SafetyState } from "./domain/SafetyPolicy";
import { UndoJournal } from "./domain/UndoJournal";
import { SafetySettingsStore } from "./settings/SafetySettingsStore";
import { assemblePreamble } from "./domain/PreambleAssembler";
import { formatTodayInTimezone } from "./domain/formatToday";
import { filterRawFsToolsIfGated } from "./domain/toolGating";

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
  private agent: AgentSession | null = null;

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
    const undoJournal = new UndoJournal(
      this.app.vault as unknown as ConstructorParameters<typeof UndoJournal>[0],
    );

    // We need the AuthController reference before the agent (for
    // onAuthError) AND vice-versa (AuthController wraps the agent
    // token sink). Resolve by assigning post-construction.
    let controllerRef: AuthController | null = null;

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
      undoJournal,
    });
    // Phase 3 (Chat UX + Vault Tools): construct ObsidianApi once and
    // share with the read-note tool factory. Phase 4 will reuse the
    // same instance for write-note tools.
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
        // Bind methods so Obsidian's `this`-sensitive APIs work.
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
        // Obsidian's runtime MarkdownView class — required so
        // getActiveViewOfType(MarkdownView) hits the markdown editor.
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
    const readNoteTools = createReadNoteTools(
      obsidianApi,
      this.app.vault as unknown as Parameters<typeof createReadTools>[0],
    );
    // v0.3 Phase 2: read-only search tools (search_by_tag, search_by_name,
    // list_all_tags). All three skipPermission per FR-017.
    const searchTools = createSearchTools(
      obsidianApi,
      this.app.vault as unknown as Parameters<typeof createReadTools>[0],
    );
    // Phase 4: vault-write note tools. Reuses writeTools' deps + the
    // shared ObsidianApi instance + a deterministic clock (for daily
    // notes). Each handler enforces FR-012 (read-only guard) where
    // applicable; permission gating is handled by SafetyPolicy below.
    const now = (): Date => new Date();
    const writeNoteTools = createWriteNoteTools({
      vault: this.app.vault as unknown as Parameters<
        typeof createWriteTools
      >[0]["vault"],
      workspace: this.app.workspace as unknown as Parameters<
        typeof createWriteTools
      >[0]["workspace"],
      undoJournal,
      api: obsidianApi,
      now,
      vaultAwareness: () => safetySettingsStore.snapshot().vaultAwareness,
    });

    const agent = new CopilotAgentSession({
      cliPath,
      gitHubToken: null,
      baseDirectory,
      decider: denyAll,
      logLevel: "info",
      onAuthError: (err) => controllerRef?.notifyAuthFailure(err),
      // Phase 3+4: register vault read/write tools. Read tools use
      // skipPermission (always allowed inside vault). Write tools
      // intentionally DO NOT skip permission — every invocation flows
      // through SafetyPolicy below. `open_note` is the one exception:
      // it's read-equivalent navigation and sets skipPermission itself.
      //
      // v0.3 Phase 1: when `exposeRawFsToolsAtStartup` is false, the
      // six v0.1 raw-FS tools (view/read_file/search_content/
      // create_file/edit_file/delete_file) are filtered out so the
      // model can't invoke them. Filtering is done once at startup
      // (per FR-015's "next session start" rule and C2-A's frozen-
      // snapshot guarantee). `ALL_VAULT_TOOL_ENTRIES` stays unchanged
      // so historical messages still render those tool names.
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
      // Phase 6: route all permission requests through SafetyPolicy.
      // `config` is read on every decision so settings changes apply
      // immediately. `extractVaultPath` pulls the candidate vault
      // path out of write-tool args for allowlist matching. For
      // `create_daily_note` we synthesize the path the same way the
      // handler will, so gate-side and write-side paths match exactly.
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
            // F2: mirror createTaskImpl's target resolution so the per-path
            // allowlist sees the same path the handler will write to.
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
      // Phase 2 (Chat UX + Vault Tools): vault-aware preamble. Read on
      // every first send so settings updates apply on the next session
      // reset without restarting the runtime.
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
    this.agent = agent;

    const tokenSink: AgentTokenSink = {
      setToken: (token) => agent.setToken(token),
      reconnect: () => agent.reconnect(),
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
        await controller.hydrate();
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
    );
    this.addSettingTab(settingsTab);

    registerChatView(this, {
      agent,
      auth: controller,
      undoJournal,
      openSettings: () => {
        // Obsidian doesn't expose a typed API for "open my settings tab",
        // but the workspace command does the right thing. Falls back to
        // a notice if the API isn't available.
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
  }

  async onunload(): Promise<void> {
    console.log("[copilot-agent] Unloading");
    const agent = this.agent;
    this.agent = null;
    if (agent) {
      try {
        await agent.dispose();
      } catch (e) {
        console.warn("[copilot-agent] dispose threw", e);
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
