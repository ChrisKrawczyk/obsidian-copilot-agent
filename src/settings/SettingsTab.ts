import { App, PluginSettingTab, Setting } from "obsidian";
import type { Plugin } from "obsidian";

/**
 * Phase 2 settings tab. Single placeholder section indicating that the
 * dev token is read from `src/dev-token.local.ts`. Phase 3 replaces this
 * with full Device-Flow OAuth and persistence controls.
 */
export class CopilotAgentSettingTab extends PluginSettingTab {
  constructor(app: App, plugin: Plugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "Copilot Agent (Spike)" });

    new Setting(containerEl)
      .setName("Connection")
      .setDesc(
        "Phase 2: using the hardcoded development token from " +
          "src/dev-token.local.ts. Phase 3 will replace this with " +
          "a 'Connect to GitHub' button (Device Flow OAuth) and " +
          "token persistence controls.",
      );

    new Setting(containerEl)
      .setName("Permission policy")
      .setDesc(
        "Phase 2: deny-by-default. Every tool invocation (built-in, " +
          "MCP, or custom) is rejected at the universal-approval-gate. " +
          "Phase 6 introduces SafetyPolicy with vault-scoped allow rules.",
      );

    new Setting(containerEl)
      .setName("Copilot CLI binary")
      .setDesc(
        "Place the platform-specific binary (copilot.exe on Windows, " +
          "copilot on macOS/Linux) in this plugin's directory. See " +
          "README → 'Installing the Copilot CLI binary'.",
      );
  }
}
