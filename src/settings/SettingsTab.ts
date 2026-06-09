import { App, PluginSettingTab, Setting, type Plugin } from "obsidian";
import type { AuthController, AuthState } from "../auth/AuthController";
import type { TokenStore } from "../auth/TokenStore";
import { DeviceFlowModal } from "../ui/DeviceFlowModal";
import {
  KNOWN_BUILTIN_KINDS,
  type SafetySettingsStore,
} from "./SafetySettingsStore";

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
    private readonly safetyStore?: SafetySettingsStore,
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

    // ---- Phase 6: SafetyPolicy ----
    if (this.safetyStore) {
      const safety = this.safetyStore.snapshot();
      containerEl.createEl("h3", { text: "Safety" });

      new Setting(containerEl)
        .setName("Default policy for vault writes")
        .setDesc(
          "Auto-apply with undo: vault writes (create/edit/delete) " +
            "proceed silently and a journal entry is recorded so you " +
            "can revert from the chat. Require approval: every write " +
            "surfaces an inline Approve / Approve-for-session / Reject " +
            "prompt before it runs. Built-ins (shell, url, …) always " +
            "require approval unless individually toggled below.",
        )
        .addDropdown((dd) =>
          dd
            .addOption("require-approval", "Require approval (recommended)")
            .addOption(
              "auto-apply-with-undo",
              "Auto-apply with undo (vault only)",
            )
            .setValue(safety.defaultMode)
            .onChange(async (value) => {
              await this.safetyStore!.setDefaultMode(
                value === "auto-apply-with-undo"
                  ? "auto-apply-with-undo"
                  : "require-approval",
              );
            }),
        );

      new Setting(containerEl)
        .setName("Vault allowlist")
        .setDesc(
          "Vault-relative path prefixes that bypass the approval prompt " +
            "for writes (one per line). E.g. `Inbox/copilot` permits " +
            "writes to that subfolder and any file inside it. Path " +
            "traversal (`..`), absolute paths, and Windows drive " +
            "letters are rejected.",
        )
        .addTextArea((ta) => {
          ta.inputEl.rows = 4;
          ta.inputEl.style.width = "100%";
          ta.setValue(safety.allowlist.join("\n")).onChange(async (raw) => {
            const entries = raw
              .split(/\r?\n/)
              .map((s) => s.trim())
              .filter((s) => s.length > 0);
            await this.safetyStore!.setAllowlist(entries);
          });
        });

      containerEl.createEl("h4", { text: "Auto-approve built-ins" });
      containerEl.createEl("p", {
        cls: "setting-item-description",
        text:
          "Each toggle silently approves the matching SDK permission " +
          "category. Keep these OFF unless you trust the model to act " +
          "without confirmation — there is NO undo for built-ins.",
      });

      for (const kind of KNOWN_BUILTIN_KINDS) {
        new Setting(containerEl)
          .setName(builtinLabel(kind))
          .setDesc(builtinDesc(kind))
          .addToggle((toggle) =>
            toggle
              .setValue(safety.autoApproveBuiltins[kind] ?? false)
              .onChange(async (value) => {
                await this.safetyStore!.setBuiltinAutoApprove(kind, value);
              }),
          );
      }
    } else {
      new Setting(containerEl)
        .setName("Permission policy")
        .setDesc(
          "Phase 2/3: deny-by-default. Every tool invocation (built-in, " +
            "MCP, or custom) is rejected at the universal-approval-gate.",
        );
    }

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
    // Kick off connect FIRST so the synchronous state gate transitions to
    // `connecting` before the modal subscribes on open(). Otherwise the
    // modal's first listener tick sees `disconnected` and self-closes
    // (treating it as "user cancelled").
    void this.authController.connect();
    modal.open();
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

function builtinLabel(kind: string): string {
  switch (kind) {
    case "shell":
      return "Shell commands";
    case "url":
      return "URL fetches (web_fetch)";
    case "memory":
      return "Memory writes";
    case "hook":
      return "Hook execution";
    case "write":
      return "Non-vault file writes";
    case "read":
      return "Non-vault file reads";
    default:
      return kind;
  }
}

function builtinDesc(kind: string): string {
  switch (kind) {
    case "shell":
      return "Approves every shell command the agent proposes — high risk. Leave OFF in most cases.";
    case "url":
      return "Approves every outbound HTTP fetch the agent proposes (web pages, APIs).";
    case "memory":
      return "Approves writes to Copilot's long-term memory file.";
    case "hook":
      return "Approves execution of plugin/CLI hooks the model triggers.";
    case "write":
      return "Approves writes to files OUTSIDE the active vault. Vault writes are governed by the policy above.";
    case "read":
      return "Approves reads from files OUTSIDE the active vault. Vault reads are always allowed (Phase 5 read tools).";
    default:
      return "";
  }
}
