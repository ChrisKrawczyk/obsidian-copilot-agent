import {
  ItemView,
  Notice,
  WorkspaceLeaf,
  setIcon,
} from "obsidian";
import { ChatState } from "../domain/ChatState";
import type { AgentSession } from "../sdk/AgentSession";
import type { AuthController, AuthState } from "../auth/AuthController";
import { MessageRenderer } from "./MessageRenderer";
import type { UndoJournal } from "../domain/UndoJournal";
import { decideKeydownAction } from "./chatKeydown";

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
  /**
   * Phase 6: undo journal for vault write tools. Click on the inline
   * Undo button routes here. Optional so Phase 5 tests still construct
   * the view without it.
   */
  undoJournal?: UndoJournal;
}

export class ChatView extends ItemView {
  private state = new ChatState();
  private agent: AgentSession;
  private auth: AuthController;
  private openSettings: () => void;
  private undoJournal?: UndoJournal;
  private listEl!: HTMLElement;
  private inputEl!: HTMLTextAreaElement;
  private sendBtnEl!: HTMLButtonElement;
  private sendIconEl!: HTMLElement;
  private sendLabelEl!: HTMLElement;
  private statusEl!: HTMLElement;
  private connectBtnEl?: HTMLButtonElement;
  private renderer?: MessageRenderer;
  private pending = false;
  /**
   * Set while a streaming turn is in flight. When true, the Send button
   * acts as Stop and clicking it calls `agent.cancelCurrent()`. We track
   * this separately from `pending` because the latter is set/cleared
   * synchronously, while the streaming state can outlive `cancelCurrent`
   * for the brief window before the stream terminates.
   */
  private streaming = false;
  /**
   * Set when handleStop is in flight to guard against double-clicks
   * calling `session.abort()` repeatedly. Cleared when the stream
   * actually settles (in handleSend's finally chain).
   */
  private stopping = false;
  /**
   * Set when the user clicks Stop. Read by handleSend after the stream
   * loop finishes to decide whether to freeze the placeholder as
   * `interrupted`. Cleared at the start of each new send.
   */
  private userRequestedStop = false;
  /**
   * Placeholder message id of the in-flight assistant turn, or undefined
   * between turns. Captured at send time so handleStop can immediately
   * call `interruptStreaming(id)` — that flips the message to
   * `interrupted` and makes all subsequent `appendDelta` calls no-ops
   * (the state layer refuses to mutate terminal messages). This is the
   * defensive fallback the plan requires for the case where the SDK's
   * `abort()` does not flush in-flight deltas.
   */
  private currentPlaceholderId?: string;
  private unsubState?: () => void;
  private unsubAuth?: () => void;
  private currentAuthKind: AuthState["kind"] = "disconnected";
  /**
   * IME composition state, tracked via the textarea's compositionstart /
   * compositionend events. Mirrors `KeyboardEvent.isComposing` but lets us
   * cover browsers/Electron versions that fire `keydown` before
   * `compositionend` updates `event.isComposing`. The keydown handler also
   * inspects `event.isComposing` and `event.keyCode === 229` for defence
   * in depth.
   */
  private isComposing = false;

  constructor(leaf: WorkspaceLeaf, deps: ChatViewDeps) {
    super(leaf);
    this.agent = deps.agent;
    this.auth = deps.auth;
    this.openSettings = deps.openSettings;
    this.undoJournal = deps.undoJournal;
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
    this.renderer = new MessageRenderer(
      this.app,
      this.listEl,
      (c) => this.addChild(c),
    );
    // Phase 6: wire ApprovalPrompt + Undo button clicks into the
    // agent's resolveApproval / undo journal entry points. The view
    // (not the renderer) owns these effects so the renderer stays
    // pure-render.
    this.renderer.setToolCallHandlers({
      onApprove: (id) =>
        this.agent.resolveApproval(id, { kind: "approve-once" }),
      onApproveForSession: (id) =>
        this.agent.resolveApproval(id, { kind: "approve-for-session" }),
      onReject: (id) =>
        this.agent.resolveApproval(id, {
          kind: "reject",
          reason: "Rejected by user.",
        }),
      onUndo: (id) => void this.handleUndoClick(id),
    });

    const composer = root.createDiv({ cls: "copilot-agent-composer" });
    this.inputEl = composer.createEl("textarea", {
      cls: "copilot-agent-input",
      attr: { rows: "3", placeholder: "Ask Copilot…" },
    });
    this.inputEl.addEventListener("compositionstart", () => {
      this.isComposing = true;
    });
    this.inputEl.addEventListener("compositionend", () => {
      this.isComposing = false;
    });
    this.inputEl.addEventListener("keydown", (e) => {
      const action = decideKeydownAction({
        key: e.key,
        shiftKey: e.shiftKey,
        // Respect BOTH the native event flag and our tracked flag — either
        // being true means an IME composition is in progress.
        isComposing: e.isComposing || this.isComposing,
        keyCode: e.keyCode,
        hasText: this.inputEl.value.trim().length > 0,
        isStreaming: this.streaming,
        isPending: this.pending,
        isConnected: this.currentAuthKind === "connected",
      });
      switch (action) {
        case "submit":
          e.preventDefault();
          void this.submitMessage();
          break;
        case "noop-prevent":
          // Suppress newline-then-no-send to avoid surprising the user, but
          // do NOT route into the Stop handler — only the Stop button
          // aborts a stream (spec FR-004).
          e.preventDefault();
          break;
        case "newline":
        case "passthrough":
          // Default textarea behaviour (newline or other keys).
          break;
      }
    });
    this.sendBtnEl = composer.createEl("button", {
      cls: "copilot-agent-send mod-cta",
    });
    this.sendIconEl = this.sendBtnEl.createSpan({
      cls: "copilot-agent-send-icon",
    });
    this.sendLabelEl = this.sendBtnEl.createSpan({
      cls: "copilot-agent-send-label",
      text: "Send",
    });
    setIcon(this.sendIconEl, "send");
    this.sendBtnEl.addEventListener("click", () => void this.handleSendOrStop());

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
    this.renderer?.dispose();
    this.renderer = undefined;
  }

  private renderAuth(state: AuthState): void {
    this.currentAuthKind = state.kind;
    const isConnected = state.kind === "connected";
    // Composer is gated on connection. Don't disable mid-send — the
    // send pipeline owns `pending`/`streaming`.
    if (!this.pending && !this.streaming) {
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

  /**
   * Single entry point that the Send button click AND the Enter-key
   * handler both call. Keeps the two surfaces in lockstep so future
   * changes to "what does sending mean" land in one place.
   *
   * Unlike `handleSendOrStop`, this NEVER routes into Stop — it is the
   * pure "submit" path. The keyboard handler is contractually responsible
   * for not invoking this while a stream is in flight.
   */
  private submitMessage(): Promise<void> {
    return this.handleSend();
  }

  private handleSendOrStop(): Promise<void> {
    if (this.streaming) {
      return this.handleStop();
    }
    return this.handleSend();
  }

  private async handleStop(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    this.userRequestedStop = true;
    // Immediately freeze the placeholder. This serves two purposes:
    //   1. The user gets instant visual feedback (status flips to
    //      `interrupted`, "(stopped)" suffix appears).
    //   2. Any deltas the SDK emits after this point are ignored,
    //      because ChatState.appendDelta refuses to mutate terminal
    //      messages. We do this BEFORE awaiting cancelCurrent() so a
    //      slow abort can't leak more text into the visible message.
    if (this.currentPlaceholderId) {
      this.state.interruptStreaming(this.currentPlaceholderId);
    }
    this.sendBtnEl.disabled = true;
    try {
      await this.agent.cancelCurrent();
    } catch (e) {
      console.warn("[ChatView] cancelCurrent threw", e);
    }
    // The streaming loop's `finally` will flip status + reset Send UI.
  }

  private async handleSend(): Promise<void> {
    if (this.pending) return;
    if (this.currentAuthKind !== "connected") {
      new Notice("Not connected. Open settings to sign in.", 5000);
      return;
    }
    const text = this.inputEl.value.trim();
    if (!text) return;
    this.inputEl.value = "";
    this.userRequestedStop = false;
    this.setBusy(true);

    this.state.append({ role: "user", content: text });
    const placeholderId = this.state.append({
      role: "assistant",
      content: "",
      status: "pending",
    });
    this.currentPlaceholderId = placeholderId;

    let receivedAnyDelta = false;
    let finalContent = "";
    let finalToolCalls: import("../domain/types").ToolCall[] = [];
    let failure: unknown = null;

    this.setStreaming(true);
    try {
      for await (const ev of this.agent.sendMessageStreaming(text)) {
        if (this.userRequestedStop) {
          // Drain the iterator but don't apply any further updates.
          // The placeholder is already frozen as `interrupted`; we
          // just need to let the generator's `finally` clean up.
          continue;
        }
        if (ev.type === "delta") {
          receivedAnyDelta = true;
          this.state.appendDelta(placeholderId, ev.text);
        } else if (ev.type === "tool_call_start") {
          // Live tool-call block. We map AgentSession's structural
          // type to the domain ToolCall shape (they share fields).
          this.state.upsertToolCall(placeholderId, {
            id: ev.toolCall.id,
            kind: ev.toolCall.kind,
            name: ev.toolCall.name,
            source: ev.toolCall.source,
            outcome: ev.toolCall.outcome,
            detail: ev.toolCall.detail,
            argsPreview: ev.toolCall.argsPreview,
            resultContent: ev.toolCall.resultContent,
            approval: ev.toolCall.approval,
          });
        } else if (ev.type === "tool_call_complete") {
          // Capture the undoId surfaced by our write-tool handlers so
          // the ToolCallBlock can render an Undo button for vault
          // writes. We look at the JSON result content for a
          // `"undoId"` field set by createFileImpl/editFileImpl/
          // deleteFileImpl. If absent, undoId stays undefined.
          const undoId = extractUndoId(ev.content);
          this.state.upsertToolCall(placeholderId, {
            id: ev.id,
            kind: "tool",
            outcome: ev.outcome,
            resultContent: ev.content,
            detail: ev.errorMessage,
            undoId,
          });
        } else if (ev.type === "approval_prompt") {
          // Pending-approval pseudo-tool-call: render an inline
          // ApprovalPrompt block. Resolution comes back via the
          // approval_resolved event below or via real tool execution.
          // Pass undefined for fields the prior state may have set
          // (resultContent, detail, undoId, undone) so a same-id
          // re-prompt doesn't render stale post-execution chrome.
          this.state.upsertToolCall(placeholderId, {
            id: ev.toolCall.id,
            kind: ev.toolCall.kind,
            name: ev.toolCall.name,
            source: ev.toolCall.source,
            outcome: ev.toolCall.outcome,
            argsPreview: ev.toolCall.argsPreview,
            approval: ev.toolCall.approval,
            resultContent: undefined,
            detail: undefined,
            undoId: undefined,
            undone: undefined,
          });
        } else if (ev.type === "approval_resolved") {
          // Transition pending -> approved/denied so the prompt
          // disappears. tool_call_complete (or tool.execution_*) will
          // overwrite this immediately if execution proceeds.
          const newOutcome =
            ev.choice.kind === "reject" ? "denied" : "approved";
          this.state.upsertToolCall(placeholderId, {
            id: ev.id,
            kind: "tool",
            outcome: newOutcome,
            detail:
              ev.choice.kind === "reject"
                ? (ev.choice.reason ?? "Rejected by user.")
                : undefined,
            approval: undefined,
          });
        } else if (ev.type === "complete") {
          finalContent = ev.content;
          finalToolCalls = ev.toolCalls;
        }
      }
    } catch (err) {
      failure = err;
    } finally {
      this.setStreaming(false);
    }

    // Once the user has clicked Stop, the placeholder is already frozen
    // as `interrupted` by handleStop(). A late `complete` event (e.g.
    // because the model finished its final segment between our abort
    // request and the SDK delivering it) must NOT overwrite that —
    // the user's intent wins. Set cancelled unconditionally on stop.
    const cancelled = this.userRequestedStop;
    this.userRequestedStop = false;
    this.stopping = false;
    this.currentPlaceholderId = undefined;

    if (failure) {
      const msg = failure instanceof Error ? failure.message : String(failure);
      this.state.update(placeholderId, {
        content: `**Error:** ${msg}`,
        status: "error",
      });
      new Notice(`Copilot Agent error: ${msg}`, 8000);
    } else if (cancelled) {
      // User clicked Stop before any delta arrived. Freeze placeholder
      // as interrupted with whatever (if anything) was streamed.
      this.state.interruptStreaming(placeholderId);
    } else {
      // Normal completion. Prefer the SDK's final content over the
      // concatenated deltas (they may differ — e.g. when the model
      // produces tool calls between text segments). Phase 5: tool
      // calls (including denials) render as live blocks above the
      // message body via `upsertToolCall`, so we no longer append a
      // text summary of denied calls — the blocks themselves are the
      // canonical UI for that.
      // Merge any tool calls present in the final summary into the
      // existing live entries (preserves entries we already rendered
      // via tool_call_start/complete events under the same id, and
      // adds any final-only entries we hadn't seen). We never
      // wholesale replace `toolCalls` here, so denied/streamed blocks
      // are preserved verbatim even if the final summary omits them.
      for (const tc of finalToolCalls) {
        this.state.upsertToolCall(placeholderId, tc);
      }
      let content = finalContent;
      if (!content && !receivedAnyDelta && finalToolCalls.length === 0) {
        content = "_(empty response)_";
      }
      // If streaming yielded content but the final is empty, keep what
      // we streamed rather than blanking the message.
      if (!content && receivedAnyDelta) {
        // Just flip status; ChatState already holds the streamed text.
        this.state.update(placeholderId, {
          status: "complete",
        });
      } else {
        this.state.update(placeholderId, {
          content,
          status: "complete",
        });
      }
    }

    this.setBusy(false);
    this.inputEl.focus();
  }

  private setBusy(busy: boolean): void {
    this.pending = busy;
    const gated = this.currentAuthKind !== "connected";
    // Input stays disabled until the turn fully completes (post-streaming).
    this.inputEl.disabled = busy || gated;
    if (!busy) {
      this.sendBtnEl.disabled = gated;
      this.sendBtnEl.toggleClass("is-loading", false);
    }
  }

  private setStreaming(streaming: boolean): void {
    this.streaming = streaming;
    if (streaming) {
      // Repurpose Send → Stop. Keep it enabled so the user can cancel.
      this.sendBtnEl.disabled = false;
      this.sendBtnEl.toggleClass("is-loading", true);
      this.sendBtnEl.toggleClass("mod-warning", true);
      this.sendBtnEl.toggleClass("mod-cta", false);
      this.sendLabelEl.setText("Stop");
      setIcon(this.sendIconEl, "square");
    } else {
      this.sendBtnEl.toggleClass("is-loading", false);
      this.sendBtnEl.toggleClass("mod-warning", false);
      this.sendBtnEl.toggleClass("mod-cta", true);
      this.sendLabelEl.setText("Send");
      setIcon(this.sendIconEl, "send");
    }
  }

  // ---- incremental render ----

  private syncList(): void {
    if (!this.renderer) return;
    this.renderer.sync(this.state.getMessages());
  }

  /**
   * Handle an Undo button click. Finds the journal entry, runs the
   * revert, and updates the message's tool-call entry so the block
   * flips into its "reverted" state. Failures surface as a Notice so
   * the user sees the reason (e.g. file has been modified since).
   */
  private async handleUndoClick(undoId: string): Promise<void> {
    if (!this.undoJournal) {
      new Notice("Undo is not available in this build.");
      return;
    }
    const entry = this.undoJournal.get(undoId);
    if (!entry) {
      new Notice("Cannot undo: no journal entry for this action.");
      return;
    }
    const outcome = await this.undoJournal.undo(entry.id);
    if (!outcome.ok) {
      new Notice(outcome.reason ?? "Undo failed.");
      return;
    }
    const messages = this.state.getMessages();
    for (const m of messages) {
      const hit = m.toolCalls?.find((c) => c.undoId === entry.id);
      if (hit) {
        this.state.upsertToolCall(m.id, {
          id: hit.id,
          kind: hit.kind,
          outcome: "completed",
          undoId: entry.id,
          undone: true,
        });
        break;
      }
    }
  }
}

/**
 * Pull the undoId from a write-tool result. Our handlers return a
 * `{ ok: true, undoId: "..." }` JSON envelope; we parse it leniently
 * here so non-write tool results (which never carry undoId) just
 * yield undefined.
 */
function extractUndoId(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as { ok?: boolean; undoId?: string };
    if (parsed?.ok === true && typeof parsed.undoId === "string") {
      return parsed.undoId;
    }
  } catch {
    // Result wasn't JSON; that's expected for many built-in tools.
  }
  return undefined;
}

