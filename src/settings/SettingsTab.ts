import { App, Notice, PluginSettingTab, Setting, type Plugin } from "obsidian";
import * as fs from "node:fs";
import type { AuthController, AuthState } from "../auth/AuthController";
import type { TokenStore } from "../auth/TokenStore";
import { DeviceFlowModal } from "../ui/DeviceFlowModal";
import {
  KNOWN_BUILTIN_KINDS,
  type SafetySettingsStore,
} from "./SafetySettingsStore";
import {
  assemblePreamble,
  PREAMBLE_PLACEHOLDERS,
} from "../domain/PreambleAssembler";
import { formatTodayInTimezone } from "../domain/formatToday";
import type {
  TaskTargetMode,
  VaultAwarenessMode,
} from "./VaultAwarenessSettings";
import type { ModelCatalog, ModelCatalogState } from "../sdk/ModelCatalog";
import type { McpSettingsStore } from "./McpSettingsStore";
import type { PresetPacksStore } from "./PresetPacksStore";
import type { McpManager } from "../mcp/McpManager";
import { McpServersSection } from "./McpServersSection";
import { createDesktopPackFileReader, createDesktopPackFileWriter } from "./presets/packFileIO";
import { isCommandOnPath } from "./isCommandOnPath";
import { CliBinarySection, type CliBinaryHostPlugin } from "./CliBinarySection";
import { PINNED_BINARY_VERSION } from "../sdk/pinnedBinaryVersion";

/**
 * Phase 3 settings. Surfaces the auth state machine + persistence toggle.
 * Subscribes to AuthController and re-renders the connection row when
 * state changes; cleans up the subscription on `hide()` to avoid leaks.
 *
 * v0.6 Phase 2: all dependencies past `app` + `plugin` are late-bound to
 * support the three-band onload() ordering (the settings tab is registered
 * in Band A before binary acquisition; remaining deps are attached in
 * Band C). When called pre-attach, `display()` renders only the CLI
 * binary section + a placeholder note for the rest.
 */
export class CopilotAgentSettingTab extends PluginSettingTab {
  private unsubscribe?: () => void;
  private catalogUnsubscribe?: () => void;
  private modelDropdownContainer?: HTMLElement;
  private unavailableNoticeShown = false;
  private connectionDescEl?: HTMLElement;
  private connectionBtnSetting?: Setting;
  private mcpSection?: McpServersSection;
  private cliBinarySection?: CliBinarySection;
  private readonly pluginRef: Plugin;

  private authController?: AuthController;
  private tokenStore?: TokenStore;
  private safetyStore?: SafetySettingsStore;
  private modelCatalog?: ModelCatalog;
  private mcpSettingsStore?: McpSettingsStore;
  private mcpManager?: McpManager;
  private presetPacksStore?: PresetPacksStore;

  constructor(
    app: App,
    plugin: Plugin,
    authController?: AuthController,
    tokenStore?: TokenStore,
    safetyStore?: SafetySettingsStore,
    modelCatalog?: ModelCatalog,
    mcpSettingsStore?: McpSettingsStore,
    mcpManager?: McpManager,
  ) {
    super(app, plugin);
    this.pluginRef = plugin;
    this.authController = authController;
    this.tokenStore = tokenStore;
    this.safetyStore = safetyStore;
    this.modelCatalog = modelCatalog;
    this.mcpSettingsStore = mcpSettingsStore;
    this.mcpManager = mcpManager;
  }

  /**
   * v0.6 Phase 2: Band C invokes this to attach the deps that require a
   * loaded CLI binary. If the settings pane is currently open, re-render
   * so newly-bound sections appear without the user having to navigate
   * away and back.
   */
  attachLateDeps(deps: {
    authController: AuthController;
    tokenStore: TokenStore;
    safetyStore: SafetySettingsStore;
    modelCatalog: ModelCatalog;
    mcpSettingsStore: McpSettingsStore;
    mcpManager: McpManager;
    presetPacksStore?: PresetPacksStore;
  }): void {
    this.authController = deps.authController;
    this.tokenStore = deps.tokenStore;
    this.safetyStore = deps.safetyStore;
    this.modelCatalog = deps.modelCatalog;
    this.mcpSettingsStore = deps.mcpSettingsStore;
    this.mcpManager = deps.mcpManager;
    this.presetPacksStore = deps.presetPacksStore;
    if (this.containerEl && this.containerEl.isConnected) {
      this.display();
    }
  }

  display(): void {
    const { containerEl } = this;
    this.mcpSection?.dispose();
    this.mcpSection = undefined;
    this.cliBinarySection?.dispose();
    this.cliBinarySection = undefined;
    containerEl.empty();
    containerEl.createEl("h2", { text: "Copilot Agent" });

    // ---- CLI binary section (always available, even pre-Band-C) ----
    this.cliBinarySection = new CliBinarySection({
      plugin: this.pluginRef as unknown as CliBinaryHostPlugin,
      pinnedVersion: PINNED_BINARY_VERSION,
    });
    this.cliBinarySection.mount(containerEl);

    if (!this.authController || !this.tokenStore) {
      containerEl.createEl("p", {
        cls: "setting-item-description",
        text:
          "Other settings (connection, safety, MCP servers) become available " +
          "once the Copilot CLI binary has finished loading. " +
          "If the binary download failed, click Retry above; otherwise reload Obsidian.",
      });
      return;
    }

    // ---- Connection ----
    const conn = containerEl.createDiv({ cls: "copilot-agent-settings-conn" });
    this.connectionDescEl = conn.createEl("p", {
      cls: "copilot-agent-settings-conn-desc",
    });

    this.connectionBtnSetting = new Setting(conn)
      .setName("GitHub connection")
      .setDesc("");

    // ---- Persistence toggle ----
    const snap = this.tokenStore!.snapshot();
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
          await this.authController!.setPersistEnabled(value);
        }),
      );

    // ---- v0.4 Phase 2: default model for new conversations ----
    if (this.safetyStore && this.modelCatalog) {
      this.renderDefaultModelSection(containerEl);
    }

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

      new Setting(containerEl)
        .setName("Expose v0.1 raw-filesystem tools")
        .setDesc(
          "When ON (default), the six v0.1 raw-FS tools (view, " +
            "read_file, search_content, create_file, edit_file, " +
            "delete_file) are offered to the model as a FALLBACK to " +
            "the higher-level vault tools (read_note, edit_note, " +
            "etc.); the preamble tells the model to reach for vault " +
            "tools first. Turn OFF for a strictly vault-only agent — " +
            "the raw-FS tools are then dropped from the manifest and " +
            "the model cannot invoke them. Takes effect on the next " +
            "session start (reload the plugin or restart Obsidian).",
        )
        .addToggle((toggle) =>
          toggle
            .setValue(safety.exposeRawFsTools)
            .onChange(async (value) => {
              await this.safetyStore!.setExposeRawFsTools(value);
            }),
        );

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
        "Manage the platform-specific binary above (auto-downloaded on first " +
          "launch; Retry from the CLI binary section at top to re-acquire).",
      );

    // ---- Phase 2 (Chat UX + Vault Tools): Vault awareness ----
    if (this.safetyStore) {
      this.renderVaultAwarenessSection(containerEl);
    }

    if (this.mcpSettingsStore && this.mcpManager && this.safetyStore) {
      const vaultRoot =
        (this.app.vault.adapter as { getBasePath?: () => string }).getBasePath?.() ??
        "";
      this.mcpSection = new McpServersSection({
        store: this.mcpSettingsStore,
        manager: this.mcpManager,
        safetyStore: this.safetyStore,
        vaultRoot,
        pathExists: (path) => fs.existsSync(path),
        executableExists: (command) => isCommandOnPath(command),
        presetPacksStore: this.presetPacksStore,
        packFileReader: this.presetPacksStore ? createDesktopPackFileReader() : undefined,
        packFileWriter: createDesktopPackFileWriter(this.app),
      });
      this.mcpSection.mount(containerEl);
    }

    // Subscribe AFTER all DOM is built so the first render lands correctly.
    this.unsubscribe?.();
    if (this.authController) {
      this.unsubscribe = this.authController.subscribe((state) =>
        this.renderConnection(state),
      );
    }
  }

  private renderVaultAwarenessSection(containerEl: HTMLElement): void {
    if (!this.safetyStore) return;
    const store = this.safetyStore;
    const snap = store.snapshot().vaultAwareness;

    containerEl.createEl("h3", { text: "Vault awareness" });
    containerEl.createEl("p", {
      cls: "setting-item-description",
      text:
        "Controls the vault-aware preamble prepended to the first user " +
        "message of each chat session. The preamble tells the model your " +
        "vault root, timezone, today's date, and the names of the read-only " +
        "vault tools it should prefer (so it doesn't fall back to generic " +
        "shell discovery). The default preamble does NOT enumerate your " +
        "vault folders or files.",
    });

    let customRow: Setting | undefined;
    let previewEl: HTMLPreElement | undefined;

    const renderPreview = (): void => {
      if (!previewEl) return;
      const current = store.snapshot().vaultAwareness;
      const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      const sample = assemblePreamble({
        mode: current.mode,
        vaultRootAbsPath:
          (this.app.vault.adapter as { getBasePath?: () => string })
            .getBasePath?.() ?? "<vault root>",
        timezone,
        todayInTimezone: formatTodayInTimezone(new Date(), timezone),
        customBody: current.customBody,
      });
      previewEl.setText(sample || "(empty — no preamble will be sent)");
    };

    new Setting(containerEl)
      .setName("Preamble mode")
      .setDesc(
        "None: no preamble. Default: the built-in vault-aware block. " +
          "Custom: your own template (supports the placeholders documented below).",
      )
      .addDropdown((dd) =>
        dd
          .addOption("none", "None")
          .addOption("default", "Default (recommended)")
          .addOption("custom", "Custom template")
          .setValue(snap.mode)
          .onChange(async (value) => {
            const mode = value as VaultAwarenessMode;
            await store.setVaultAwareness({ mode });
            if (customRow) {
              customRow.settingEl.style.display =
                mode === "custom" ? "" : "none";
            }
            renderPreview();
          }),
      );

    customRow = new Setting(containerEl)
      .setName("Custom preamble body")
      .setDesc(
        `Supported placeholders: ${PREAMBLE_PLACEHOLDERS.VAULT_ROOT}, ` +
          `${PREAMBLE_PLACEHOLDERS.VAULT_TIMEZONE}, ` +
          `${PREAMBLE_PLACEHOLDERS.VAULT_TODAY}, ` +
          `${PREAMBLE_PLACEHOLDERS.VAULT_TOOL_INVENTORY}, ` +
          `${PREAMBLE_PLACEHOLDERS.AUTHORING_CONVENTIONS}. ` +
          "Placeholders are substituted only when present in the body.",
      )
      .addTextArea((ta) => {
        ta.inputEl.rows = 6;
        ta.inputEl.style.width = "100%";
        ta.setValue(snap.customBody).onChange(async (value) => {
          await store.setVaultAwareness({ customBody: value });
          renderPreview();
        });
      });
    customRow.settingEl.style.display = snap.mode === "custom" ? "" : "none";

    new Setting(containerEl)
      .setName("Default task target")
      .setDesc(
        "Where Phase 5's `create_task` tool appends new tasks. Today's " +
          "Daily Note resolves at task-creation time. Custom path lets you " +
          "point at a fixed note (e.g. `Inbox/tasks.md`).",
      )
      .addDropdown((dd) =>
        dd
          .addOption("today-daily-note", "Today's Daily Note")
          .addOption("custom-path", "Custom path")
          .setValue(snap.taskTargetMode)
          .onChange(async (value) => {
            await store.setVaultAwareness({
              taskTargetMode: value as TaskTargetMode,
            });
          }),
      );

    new Setting(containerEl)
      .setName("Custom task target path")
      .setDesc(
        "Vault-relative path used when `taskTargetMode` is 'Custom path'. " +
          "Ignored otherwise.",
      )
      .addText((text) =>
        text
          .setPlaceholder("Inbox/tasks.md")
          .setValue(snap.customTaskTargetPath)
          .onChange(async (value) => {
            await store.setVaultAwareness({ customTaskTargetPath: value });
          }),
      );

    const previewWrapper = containerEl.createEl("details");
    previewWrapper.createEl("summary", { text: "Preview assembled preamble" });
    previewEl = previewWrapper.createEl("pre", {
      cls: "copilot-agent-preamble-preview",
    });
    previewEl.style.whiteSpace = "pre-wrap";
    previewEl.style.maxHeight = "320px";
    previewEl.style.overflow = "auto";
    previewEl.style.padding = "0.5rem";
    previewEl.style.border = "1px solid var(--background-modifier-border)";
    renderPreview();
  }

  hide(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.catalogUnsubscribe?.();
    this.catalogUnsubscribe = undefined;
    this.mcpSection?.dispose();
    this.mcpSection = undefined;
    this.modelDropdownContainer = undefined;
    this.unavailableNoticeShown = false;
    super.hide?.();
  }

  private renderDefaultModelSection(containerEl: HTMLElement): void {
    if (!this.safetyStore || !this.modelCatalog) return;
    const safetyStore = this.safetyStore;
    const catalog = this.modelCatalog;

    containerEl.createEl("h3", { text: "Model" });

    // Container we re-render in place when catalog state changes.
    // Holds exactly one Setting row (the dropdown). Re-running display()
    // would fight Obsidian's tab-open lifecycle, so we update this
    // sub-tree directly via a subscription on the catalog.
    const section = containerEl.createDiv({
      cls: "copilot-agent-default-model-section",
    });
    this.modelDropdownContainer = section;

    const renderRow = () => {
      if (!this.modelDropdownContainer) return;
      const host = this.modelDropdownContainer;
      host.empty();
      const state = catalog.getState();
      const persisted = safetyStore.snapshot().defaultModelId;

      const setting = new Setting(host)
        .setName("Default model for new conversations")
        .setDesc(describeCatalogStatus(state));

      setting.addDropdown((dd) => {
        // Auto sentinel — the `null` value rendered as the empty
        // string. We translate `""` ↔ `null` at the boundary so the
        // SDK never sees the literal string "" as a model id.
        dd.addOption("", "Auto (heuristic)");

        let inUnavailableMode = false;
        if (state.kind === "ready") {
          for (const m of state.chatModels) {
            const id = m.id ?? "";
            if (!id) continue;
            const label = m.name && m.name.length > 0 ? `${m.name} (${id})` : id;
            dd.addOption(id, label);
          }
          // If the persisted id is no longer in the chat-capable list,
          // surface it as "<id> (unavailable)" so the user can SEE
          // their current binding. Auto sentinel (null) bypasses this.
          if (
            persisted !== null &&
            !state.chatModels.some((m) => m.id === persisted)
          ) {
            inUnavailableMode = true;
            dd.addOption(persisted, `${persisted} (unavailable)`);
            if (!this.unavailableNoticeShown) {
              this.unavailableNoticeShown = true;
              new Notice(
                `Default model "${persisted}" is no longer available. Pick another or switch to Auto.`,
                6000,
              );
            }
          }
        } else if (
          (state.kind === "loading" ||
            state.kind === "empty" ||
            state.kind === "error") &&
          persisted !== null
        ) {
          // Catalog is not ready — keep the persisted value visible
          // so it survives the round-trip even if we can't validate
          // it right now.
          dd.addOption(persisted, persisted);
        }

        dd.setValue(persisted ?? "");
        if (state.kind !== "ready" && !inUnavailableMode) {
          dd.selectEl.disabled = true;
        }

        dd.onChange(async (value) => {
          const next = value === "" ? null : value;
          await safetyStore.setDefaultModelId(next);
          // Re-render so the (unavailable) badge updates without
          // waiting for the next catalog tick.
          renderRow();
        });
      });
    };

    renderRow();
    this.catalogUnsubscribe?.();
    this.catalogUnsubscribe = catalog.subscribe(() => renderRow());
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
          .onClick(() => this.authController!.cancelConnect()),
      );
    } else if (state.kind === "connected") {
      this.connectionBtnSetting.addButton((btn) =>
        btn
          .setButtonText("Disconnect")
          .setWarning()
          .onClick(async () => {
            await this.authController!.disconnect();
          }),
      );
    }
  }

  private openDeviceFlowModal(): void {
    if (!this.authController) return;
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

function describeCatalogStatus(state: ModelCatalogState): string {
  switch (state.kind) {
    case "loading":
      return "Loading available models…";
    case "ready":
      return (
        `Auto (heuristic) lets the plugin pick a sensible default per ` +
        `conversation; pinning a specific model applies it to NEW ` +
        `conversations only — existing ones keep their bound model.`
      );
    case "empty":
      return (
        "No models are available for this account. Reconnect or check " +
          "your Copilot entitlement."
      );
    case "error":
      return `Could not load model list: ${state.message}`;
  }
}
