import { App, Modal, Setting } from "obsidian";
import type { AuthController, AuthState } from "../auth/AuthController";

/**
 * Modal shown during Device Flow. Displays the user code, GitHub
 * verification URL, and a status line that updates as we move from
 * "fetching code" → "waiting for browser" → final outcome.
 *
 * The modal subscribes to AuthController state — it does NOT drive the
 * flow itself. Closing the modal calls `cancelConnect()`. This way the
 * settings tab and the modal share a single source of truth.
 */
export class DeviceFlowModal extends Modal {
  private unsubscribe?: () => void;
  private codeEl?: HTMLElement;
  private urlEl?: HTMLElement;
  private statusEl?: HTMLElement;
  private copyBtn?: HTMLButtonElement;
  private openBtn?: HTMLButtonElement;
  /** Set when the connection succeeds, so onClose doesn't cancel. */
  private completed = false;

  constructor(
    app: App,
    private readonly controller: AuthController,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("copilot-agent-device-flow");
    contentEl.createEl("h2", { text: "Sign in to GitHub" });

    const intro = contentEl.createEl("p", {
      cls: "copilot-agent-device-intro",
    });
    intro.appendText(
      "Copilot Agent needs to sign in via GitHub's Device Flow. ",
    );
    intro.appendText(
      "Open the URL below, paste the code, and approve the request.",
    );

    const codeRow = contentEl.createDiv({ cls: "copilot-agent-device-code-row" });
    codeRow.createEl("div", {
      text: "Your code",
      cls: "copilot-agent-device-label",
    });
    this.codeEl = codeRow.createEl("div", {
      cls: "copilot-agent-device-code",
      text: "Fetching…",
    });
    this.copyBtn = codeRow.createEl("button", {
      text: "Copy",
      cls: "copilot-agent-device-copy",
    });
    this.copyBtn.disabled = true;
    this.copyBtn.addEventListener("click", () => {
      const code = this.codeEl?.getText() ?? "";
      if (code && code !== "Fetching…") {
        void navigator.clipboard.writeText(code);
        this.copyBtn!.setText("Copied!");
        setTimeout(() => this.copyBtn?.setText("Copy"), 1500);
      }
    });

    const urlRow = contentEl.createDiv({ cls: "copilot-agent-device-url-row" });
    urlRow.createEl("div", {
      text: "Open this URL",
      cls: "copilot-agent-device-label",
    });
    this.urlEl = urlRow.createEl("div", {
      cls: "copilot-agent-device-url",
      text: "—",
    });
    this.openBtn = urlRow.createEl("button", {
      text: "Open in browser",
      cls: "copilot-agent-device-open",
    });
    this.openBtn.disabled = true;
    this.openBtn.addEventListener("click", () => {
      const url = this.urlEl?.getText();
      if (url && url !== "—") window.open(url, "_blank");
    });

    this.statusEl = contentEl.createDiv({
      cls: "copilot-agent-device-status",
      text: "Requesting code from GitHub…",
    });

    new Setting(contentEl).addButton((btn) =>
      btn.setButtonText("Cancel").onClick(() => {
        this.close();
      }),
    );

    this.unsubscribe = this.controller.subscribe((state) =>
      this.render(state),
    );
  }

  onClose(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    if (!this.completed) {
      // User dismissed the modal mid-flow → cancel the device flow.
      this.controller.cancelConnect();
    }
    this.contentEl.empty();
  }

  private render(state: AuthState): void {
    if (state.kind === "connecting") {
      const v = state.verification;
      if (v) {
        this.codeEl?.setText(v.user_code);
        this.urlEl?.setText(v.verification_uri);
        if (this.copyBtn) this.copyBtn.disabled = false;
        if (this.openBtn) this.openBtn.disabled = false;
        this.statusEl?.setText(
          `Waiting for you to authorise in your browser… (code expires in ${Math.round(
            v.expires_in / 60,
          )}m)`,
        );
      } else {
        this.statusEl?.setText("Requesting code from GitHub…");
      }
      return;
    }
    if (state.kind === "validating") {
      this.statusEl?.setText("Token received — validating with Copilot…");
      return;
    }
    if (state.kind === "connected") {
      this.completed = true;
      this.statusEl?.setText(
        `Connected${state.model ? ` · ${state.model}` : ""}. Closing…`,
      );
      setTimeout(() => this.close(), 600);
      return;
    }
    if (state.kind === "error") {
      this.completed = true;
      this.statusEl?.setText(`Failed: ${state.message}`);
      // Leave the modal open with a Cancel/Close button so the user can
      // read the error.
      return;
    }
    // disconnected — flow was cancelled.
    if (!this.completed) {
      this.completed = true;
      this.close();
    }
  }
}
