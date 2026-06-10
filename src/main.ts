import { Notice, Plugin } from "obsidian";
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
import { SafetyState } from "./domain/SafetyPolicy";
import { UndoJournal } from "./domain/UndoJournal";
import { SafetySettingsStore } from "./settings/SafetySettingsStore";
import { assemblePreamble } from "./domain/PreambleAssembler";
import { formatTodayInTimezone } from "./domain/formatToday";

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

    const agent = new CopilotAgentSession({
      cliPath,
      gitHubToken: null,
      baseDirectory,
      decider: denyAll,
      logLevel: "info",
      onAuthError: (err) => controllerRef?.notifyAuthFailure(err),
      // Phase 5+6: register vault read/write tools. Read tools use
      // skipPermission (always allowed inside vault). Write tools
      // intentionally DO NOT skip permission — every invocation flows
      // through SafetyPolicy below.
      tools: [
        ...(readTools as unknown as import("./sdk/AgentSession").SdkTool[]),
        ...(writeTools as unknown as import("./sdk/AgentSession").SdkTool[]),
      ],
      // Phase 6: route all permission requests through SafetyPolicy.
      // `config` is read on every decision so settings changes apply
      // immediately. `extractVaultPath` pulls the candidate vault
      // path out of write-tool args for allowlist matching.
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
          const args = (req as { args?: { path?: unknown } }).args;
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
    void (async () => {
      try {
        await tokenStore.load();
        await safetySettingsStore.load();
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
