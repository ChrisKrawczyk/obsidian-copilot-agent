import { App, PluginSettingTab, Setting, type Plugin } from "obsidian";
import type { AuthController, AuthState } from "../auth/AuthController";
import type { TokenStore } from "../auth/TokenStore";
import { DeviceFlowModal } from "../ui/DeviceFlowModal";

/**
 * Phase 3 settings. Surfaces the auth state machine + persistence toggle.
 * Subscribes to AuthController and re-renders the connection row when
 * state changes; cleans up the subscription on `hide()` to avoid leaks.
 */
export class CopilotAgentSettingTab extends PluginSettingTab {
  private unsubscribe?: () => void;
  private connectionDescEl?: HTMLElement;
  private connectionBtnSetting?: Setting;

  constructor(
    app: App,
    plugin: Plugin,
    private readonly authController: AuthController,
    private readonly tokenStore: TokenStore,
  ) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "Copilot Agent" });

    // ---- Connection ----
    const conn = containerEl.createDiv({ cls: "copilot-agent-settings-conn" });
    this.connectionDescEl = conn.createEl("p", {
      cls: "copilot-agent-settings-conn-desc",
    });

    this.connectionBtnSetting = new Setting(conn)
      .setName("GitHub connection")
      .setDesc("");

    // ---- Persistence toggle ----
    const snap = this.tokenStore.snapshot();
    new Setting(containerEl)
      .setName("Save token between sessions")
      .setDesc(
        "When ON, the OAuth token is stored as plaintext in this vault's " +
          "plugin data so you don't have to reconnect on each Obsidian " +
          "restart. SECURITY NOTE: vault folders are often synced — anyone " +
          "with file access (cloud sync, backups) can read the token. " +
          "Turn OFF to require Connect on every Obsidian restart.",
      )
      .addToggle((toggle) =>
        toggle.setValue(snap.persistEnabled).onChange(async (value) => {
          await this.authController.setPersistEnabled(value);
        }),
      );

    new Setting(containerEl)
      .setName("Permission policy")
      .setDesc(
        "Phase 2/3: deny-by-default. Every tool invocation (built-in, " +
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

    // Subscribe AFTER all DOM is built so the first render lands correctly.
    this.unsubscribe?.();
    this.unsubscribe = this.authController.subscribe((state) =>
      this.renderConnection(state),
    );
  }

  hide(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    super.hide?.();
  }

  private renderConnection(state: AuthState): void {
    if (!this.connectionDescEl || !this.connectionBtnSetting) return;
    const desc = describeState(state);
    this.connectionDescEl.setText(desc);
    this.connectionBtnSetting.setDesc(buttonDesc(state));

    // Clear and rebuild the button row each transition. Settings is
    // small so the cost is negligible.
    this.connectionBtnSetting.controlEl.empty();

    if (state.kind === "disconnected" || state.kind === "error") {
      this.connectionBtnSetting.addButton((btn) =>
        btn
          .setButtonText(state.kind === "error" ? "Reconnect" : "Connect")
          .setCta()
          .onClick(() => {
            this.openDeviceFlowModal();
          }),
      );
    } else if (state.kind === "connecting" || state.kind === "validating") {
      this.connectionBtnSetting.addButton((btn) =>
        btn
          .setButtonText("Cancel")
          .onClick(() => this.authController.cancelConnect()),
      );
    } else if (state.kind === "connected") {
      this.connectionBtnSetting.addButton((btn) =>
        btn
          .setButtonText("Disconnect")
          .setWarning()
          .onClick(async () => {
            await this.authController.disconnect();
          }),
      );
    }
  }

  private openDeviceFlowModal(): void {
    const modal = new DeviceFlowModal(this.app, this.authController);
    modal.open();
    // Kick off connect AFTER the modal has subscribed so it sees the
    // device-code event. AuthController.connect() returns the run
    // promise; we don't await here — the modal is the UX.
    void this.authController.connect();
  }
}

function describeState(state: AuthState): string {
  switch (state.kind) {
    case "disconnected":
      return "Not connected. Click Connect to sign in to GitHub.";
    case "connecting":
      return state.verification
        ? "Waiting for you to authorise in the browser…"
        : "Requesting device code from GitHub…";
    case "validating":
      return `Validating token with Copilot (${state.tokenPreview})…`;
    case "connected":
      return `Connected (${state.tokenPreview})${
        state.model ? ` · model: ${state.model}` : ""
      }`;
    case "error":
      return `Error: ${state.message}`;
  }
}

function buttonDesc(state: AuthState): string {
  switch (state.kind) {
    case "disconnected":
      return "Sign in once — token is reused on subsequent Obsidian restarts when persistence is on.";
    case "connecting":
    case "validating":
      return "Cancel to abort the in-progress sign-in.";
    case "connected":
      return "Disconnect drops the token immediately and stops the SDK runtime.";
    case "error":
      return "Click Reconnect to start a fresh Device Flow.";
  }
}
