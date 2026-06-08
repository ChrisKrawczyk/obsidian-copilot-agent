import { Notice, Plugin } from "obsidian";
import { DEV_TOKEN } from "./dev-token.local";
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

export default class CopilotAgentPlugin extends Plugin {
  private agent: AgentSession | null = null;

  async onload(): Promise<void> {
    console.log("[copilot-agent] Loading Phase 2 plugin");

    if (!DEV_TOKEN || DEV_TOKEN.startsWith("REPLACE_WITH_")) {
      new Notice(
        "[Copilot Agent] Dev token not set. Edit src/dev-token.local.ts and " +
          "rebuild. The chat view will load but sends will fail.",
        12000,
      );
    }

    let initPromise: Promise<void>;
    try {
      const cliPath = resolveCliBinaryPath(this);
      const baseDirectory = getAbsolutePluginDir(this) ?? process.cwd();
      this.agent = new CopilotAgentSession({
        cliPath,
        gitHubToken: DEV_TOKEN,
        baseDirectory,
        decider: denyAll,
        logLevel: "info",
      });
      initPromise = this.agent.init();
      // Swallow rejection here so it doesn't surface as an unhandled
      // promise rejection — the view re-awaits and renders the failure.
      initPromise.catch((err) => {
        console.error("[copilot-agent] init failed", err);
      });
    } catch (err) {
      console.error("[copilot-agent] startup error", err);
      new Notice(
        `[Copilot Agent] Startup failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
        12000,
      );
      initPromise = Promise.reject(err);
      initPromise.catch(() => {
        /* prevent unhandled rejection */
      });
    }

    if (!this.agent) {
      this.agent = stubAgent(initPromise);
    }

    registerChatView(this, { agent: this.agent, initPromise });
    this.addSettingTab(new CopilotAgentSettingTab(this.app, this));
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

function stubAgent(initPromise: Promise<void>): AgentSession {
  return {
    init: () => initPromise,
    sendMessage: async () => {
      await initPromise;
      throw new Error("Agent not initialised");
    },
    resetConversation: async () => {
      /* no-op */
    },
    dispose: async () => {
      /* no-op */
    },
    getModel: () => undefined,
  };
}
