import {
  ItemView,
  MarkdownRenderer,
  Notice,
  WorkspaceLeaf,
  Component,
  setIcon,
} from "obsidian";
import { ChatState } from "../domain/ChatState";
import type { Message } from "../domain/types";
import type { AgentSession } from "../sdk/AgentSession";
import type { AuthController, AuthState } from "../auth/AuthController";

export const CHAT_VIEW_TYPE = "copilot-agent-chat";

interface ChatViewDeps {
  /** Lazily-initialised SDK adapter. The view never constructs it. */
  agent: AgentSession;
  /**
   * Auth state source. ChatView subscribes to gate the composer:
   * sends are only allowed while state.kind === "connected".
   */
  auth: AuthController;
  /**
   * Open the settings tab. Wired from main.ts so we don't depend on
   * Obsidian's internal `setting.openTabById`.
   */
  openSettings: () => void;
}

export class ChatView extends ItemView {
  private state = new ChatState();
  private agent: AgentSession;
  private auth: AuthController;
  private openSettings: () => void;
  private listEl!: HTMLElement;
  private inputEl!: HTMLTextAreaElement;
  private sendBtnEl!: HTMLButtonElement;
  private statusEl!: HTMLElement;
  private connectBtnEl?: HTMLButtonElement;
  private rendered = new Map<
    string,
    { wrapperEl: HTMLElement; bodyEl: HTMLElement; component: Component; lastContent: string }
  >();
  private pending = false;
  private unsubState?: () => void;
  private unsubAuth?: () => void;
  private currentAuthKind: AuthState["kind"] = "disconnected";

  constructor(leaf: WorkspaceLeaf, deps: ChatViewDeps) {
    super(leaf);
    this.agent = deps.agent;
    this.auth = deps.auth;
    this.openSettings = deps.openSettings;
  }

  getViewType(): string {
    return CHAT_VIEW_TYPE;
  }

  getDisplayText(): string {
    return "Copilot Agent";
  }

  getIcon(): string {
    return "bot";
  }

  async onOpen(): Promise<void> {
    const root = this.containerEl.children[1];
    root.empty();
    root.addClass("copilot-agent-chat-root");

    const header = root.createDiv({ cls: "copilot-agent-header" });
    header.createEl("div", { text: "Copilot Agent", cls: "copilot-agent-title" });
    this.statusEl = header.createDiv({
      cls: "copilot-agent-status",
      text: "…",
    });

    this.listEl = root.createDiv({ cls: "copilot-agent-messages" });

    const composer = root.createDiv({ cls: "copilot-agent-composer" });
    this.inputEl = composer.createEl("textarea", {
      cls: "copilot-agent-input",
      attr: { rows: "3", placeholder: "Ask Copilot…" },
    });
    this.inputEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        void this.handleSend();
      }
    });
    this.sendBtnEl = composer.createEl("button", {
      cls: "copilot-agent-send mod-cta",
      text: "Send",
    });
    setIcon(this.sendBtnEl.createSpan({ cls: "copilot-agent-send-icon" }), "send");
    this.sendBtnEl.addEventListener("click", () => void this.handleSend());

    // "Open settings" button shown when not connected.
    this.connectBtnEl = composer.createEl("button", {
      cls: "copilot-agent-connect-cta",
      text: "Open settings to connect",
    });
    this.connectBtnEl.addEventListener("click", () => this.openSettings());

    this.unsubState = this.state.subscribe(() => this.syncList());
    this.unsubAuth = this.auth.subscribe((s) => this.renderAuth(s));
  }

  async onClose(): Promise<void> {
    this.unsubState?.();
    this.unsubAuth?.();
    for (const r of this.rendered.values()) {
      r.component.unload();
    }
    this.rendered.clear();
  }

  private renderAuth(state: AuthState): void {
    this.currentAuthKind = state.kind;
    const isConnected = state.kind === "connected";
    // Composer is gated on connection. Don't disable mid-send — the
    // send pipeline owns `pending`.
    if (!this.pending) {
      this.inputEl.disabled = !isConnected;
      this.sendBtnEl.disabled = !isConnected;
    }
    if (this.connectBtnEl) {
      this.connectBtnEl.style.display = isConnected ? "none" : "";
    }
    switch (state.kind) {
      case "disconnected":
        this.statusEl.setText("Not connected — open settings to sign in");
        this.statusEl.addClass("copilot-agent-status-error");
        break;
      case "connecting":
        this.statusEl.setText("Connecting to GitHub…");
        this.statusEl.removeClass("copilot-agent-status-error");
        break;
      case "validating":
        this.statusEl.setText("Validating token…");
        this.statusEl.removeClass("copilot-agent-status-error");
        break;
      case "connected":
        this.statusEl.setText(
          state.model ? `Connected · ${state.model}` : "Connected",
        );
        this.statusEl.removeClass("copilot-agent-status-error");
        break;
      case "error":
        this.statusEl.setText(`Auth error: ${state.message}`);
        this.statusEl.addClass("copilot-agent-status-error");
        break;
    }
  }

  // ---- send pipeline ----

  private async handleSend(): Promise<void> {
    if (this.pending) return;
    if (this.currentAuthKind !== "connected") {
      new Notice("Not connected. Open settings to sign in.", 5000);
      return;
    }
    const text = this.inputEl.value.trim();
    if (!text) return;
    this.inputEl.value = "";
    this.setBusy(true);

    this.state.append({ role: "user", content: text });
    const placeholderId = this.state.append({
      role: "assistant",
      content: "_Thinking…_",
      status: "pending",
    });

    try {
      // agent.sendMessage() runs init() internally — and init() is
      // retryable: if a previous attempt failed, the next call kicks
      // off a fresh attempt.
      const reply = await this.agent.sendMessage(text);
      const denied = reply.toolCalls.filter((t) => t.outcome === "denied");
      let content = reply.content;
      if (denied.length > 0) {
        const lines = denied
          .map(
            (t) =>
              `- \`${t.name ?? t.kind}\` denied (${t.detail ?? "permission rejected"})`,
          )
          .join("\n");
        content = `${content || "_(no response)_"}\n\n---\n**Tool calls denied (Phase 2 deny-by-default):**\n${lines}`;
      } else if (!content) {
        content = "_(empty response)_";
      }
      this.state.update(placeholderId, {
        content,
        status: "complete",
        toolCalls: reply.toolCalls,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.state.update(placeholderId, {
        content: `**Error:** ${msg}`,
        status: "error",
      });
      new Notice(`Copilot Agent error: ${msg}`, 8000);
    } finally {
      this.setBusy(false);
      this.inputEl.focus();
    }
  }

  private setBusy(busy: boolean): void {
    this.pending = busy;
    this.sendBtnEl.disabled = busy || this.currentAuthKind !== "connected";
    this.inputEl.disabled = busy || this.currentAuthKind !== "connected";
    this.sendBtnEl.toggleClass("is-loading", busy);
  }

  // ---- incremental render ----

  private syncList(): void {
    const messages = this.state.getMessages();
    const seen = new Set<string>();
    for (const m of messages) {
      seen.add(m.id);
      const existing = this.rendered.get(m.id);
      if (!existing) {
        this.appendMessage(m);
      } else if (existing.lastContent !== m.content) {
        // Rerender body in place — cheap for short turns.
        existing.component.unload();
        existing.bodyEl.empty();
        const fresh = new Component();
        this.addChild(fresh);
        existing.component = fresh;
        existing.lastContent = m.content;
        existing.wrapperEl.toggleClass("is-pending", m.status === "pending");
        existing.wrapperEl.toggleClass("is-error", m.status === "error");
        void MarkdownRenderer.render(
          this.app,
          m.content,
          existing.bodyEl,
          "",
          fresh,
        );
      }
    }
    // Remove messages that were dropped (e.g. on clear()).
    for (const [id, r] of this.rendered) {
      if (!seen.has(id)) {
        r.component.unload();
        r.wrapperEl.detach();
        this.rendered.delete(id);
      }
    }
    // Auto-scroll to bottom.
    this.listEl.scrollTop = this.listEl.scrollHeight;
  }

  private appendMessage(m: Message): void {
    const wrapper = this.listEl.createDiv({
      cls: `copilot-agent-msg copilot-agent-msg-${m.role}${
        m.status === "pending" ? " is-pending" : ""
      }${m.status === "error" ? " is-error" : ""}`,
    });
    wrapper.createEl("div", {
      cls: "copilot-agent-msg-role",
      text: m.role === "user" ? "You" : m.role === "assistant" ? "Copilot" : "System",
    });
    const body = wrapper.createDiv({ cls: "copilot-agent-msg-body" });
    const component = new Component();
    this.addChild(component);
    void MarkdownRenderer.render(this.app, m.content, body, "", component);
    this.rendered.set(m.id, {
      wrapperEl: wrapper,
      bodyEl: body,
      component,
      lastContent: m.content,
    });
  }
}
