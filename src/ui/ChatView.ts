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
import type { ConversationManager } from "../domain/ConversationManager";
import type { PersistedMessage } from "../persistence/PersistedShape";
import { decideKeydownAction } from "./chatKeydown";
import { ConversationPicker, confirmDestructive, promptForText } from "./ConversationPicker";
import { buildPickerItems } from "./conversationPickerLogic";
import { CONVERSATION_SOFT_CAP } from "../domain/ConversationManager";
import { V01_RAW_FS_TOOL_NAMES } from "../domain/vaultToolManifest";
import { runUndoFlow } from "./undoFlow";

export const CHAT_VIEW_TYPE = "copilot-agent-chat";

/**
 * v0.3 Phase 6 (FR-016): precomputed Set of raw-FS tool names so the
 * per-render Undo-suppression predicate stays O(1). Kept module-level
 * (not per-instance) because the manifest is a static compile-time
 * constant.
 */
const RAW_FS_TOOL_NAME_SET: ReadonlySet<string> = new Set(
  V01_RAW_FS_TOOL_NAMES,
);

interface ChatViewDeps {
  /**
   * v0.3 Phase 4: per-conversation runtime architecture. The view
   * reads the active runtime via `manager.getActiveRuntime()` and
   * re-binds on `active-changed` events. The manager owns the
   * Map<id, runtime> so this view never sees a half-constructed one.
   */
  manager: ConversationManager;
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
   * v0.3 Phase 6 (FR-016) + SINGLE-2 / FR-015: returns the
   * `exposeRawFsTools` STARTUP snapshot (not the live setting). Used
   * by the Undo-button suppression predicate handed to MessageRenderer
   * so the UI matches the runtime's actual registered tool surface
   * (which was frozen at plugin onload). main.ts wires this to
   * `exposeRawFsToolsAtStartup`.
   */
  getExposeRawFsTools: () => boolean;
}

export class ChatView extends ItemView {
  private readonly manager: ConversationManager;
  /**
   * Cached references to the active runtime's state/session/journal.
   * Re-bound whenever `manager` emits `active-changed`. Initialised
   * to placeholder values (a synthetic empty `ChatState`) until the
   * manager finishes hydrating; the view subscribes to `list-changed`
   * to pick up the real runtime once available.
   */
  private state: ChatState = new ChatState();
  private agent: AgentSession | null = null;
  private undoJournal?: UndoJournal;
  private boundConversationId: string | null = null;
  private auth: AuthController;
  private openSettings: () => void;
  private getExposeRawFsTools: () => boolean;
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
  /** v0.3 Phase 4: ChatState owning the in-flight stream. Captured
   *  alongside `currentPlaceholderId` at handleSend so handleStop can
   *  freeze the right runtime's placeholder even after a mid-stream
   *  active switch. */
  private currentStreamState?: ChatState;
  /** v0.3 Phase 4: AgentSession driving the in-flight stream. Captured
   *  at handleSend so handleStop cancels the originating runtime's
   *  session even if the user switched the active conversation
   *  mid-stream (Phase 5 picker). Without this, this.agent points at
   *  the NEW active runtime and we'd never abort the actual stream. */
  private currentStreamSession?: AgentSession;
  private unsubState?: () => void;
  private unsubAuth?: () => void;
  private unsubManager?: () => void;
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
  /** v0.3 Phase 5: header conversation picker. Constructed in onOpen,
   *  destroyed in onClose. Re-rendered on every manager event so the
   *  visible list/active-name stays in sync without coupling the
   *  picker to the manager directly. */
  private picker?: ConversationPicker;

  constructor(leaf: WorkspaceLeaf, deps: ChatViewDeps) {
    super(leaf);
    this.manager = deps.manager;
    this.auth = deps.auth;
    this.openSettings = deps.openSettings;
    this.getExposeRawFsTools = deps.getExposeRawFsTools;
    this.bindActiveRuntime();
  }

  /**
   * Pull the active runtime from the manager and re-bind cached
   * `state`/`agent`/`undoJournal` references. Safe to call before
   * hydration (returns early when no active id is set yet).
   */
  private bindActiveRuntime(): void {
    const activeId = this.manager.getActiveId();
    if (!activeId) return;
    if (activeId === this.boundConversationId) return;
    const runtime = this.manager.getActiveRuntime();
    this.state = runtime.state;
    this.agent = runtime.session;
    this.undoJournal = runtime.journal;
    this.boundConversationId = activeId;
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
    // v0.3 Phase 5: picker mounts above the title row so users can
    // switch conversations without leaving the view. Callbacks route
    // back through `this.manager` — the picker holds no catalog state.
    this.picker = new ConversationPicker(header, this.app, {
      onSelect: (id) => {
        try {
          this.manager.setActive(id);
        } catch (e) {
          new Notice(`Could not switch conversation: ${(e as Error).message}`);
        }
      },
      onCreate: () => {
        try {
          // CONS-4 / FR-002: the UI used to fire a generic "archiving
          // the oldest" Notice here BEFORE create()/enforceSoftCap()
          // ran, which couldn't name the archived conversation. The
          // named Notice now fires from the manager subscription
          // below in response to an `auto-archived` event.
          const conv = this.manager.create();
          return conv.id;
        } catch (e) {
          new Notice(`Could not create conversation: ${(e as Error).message}`);
          return undefined;
        }
      },
      onRename: (id, currentName) => {
        void (async () => {
          const next = await promptForText(
            this.app,
            "Rename conversation",
            currentName,
            "Conversation name",
          );
          if (next === null) return;
          try {
            this.manager.rename(id, next);
          } catch (e) {
            new Notice(`Rename failed: ${(e as Error).message}`);
          }
        })();
      },
      onDelete: (id, currentName) => {
        void (async () => {
          const ok = await confirmDestructive(
            this.app,
            "Delete conversation",
            `"${currentName}" will be permanently removed. This cannot be undone.`,
            "Delete",
          );
          if (!ok) return;
          try {
            await this.manager.removeConversation(id);
          } catch (e) {
            new Notice(`Delete failed: ${(e as Error).message}`);
          }
        })();
      },
    });
    // v0.3 Phase 5 hotfix: title + status share a flex row underneath
    // the picker so the model name ("Connected · gpt-4o") stays
    // visible alongside the title (the original v0.2 layout).
    const titleRow = header.createDiv({ cls: "copilot-agent-header-row" });
    titleRow.createEl("div", { text: "Copilot Agent", cls: "copilot-agent-title" });
    this.statusEl = titleRow.createDiv({
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
        this.agent?.resolveApproval(id, { kind: "approve-once" }),
      onApproveForSession: (id) =>
        this.agent?.resolveApproval(id, { kind: "approve-for-session" }),
      onReject: (id) =>
        this.agent?.resolveApproval(id, {
          kind: "reject",
          reason: "Rejected by user.",
        }),
      onUndo: (id) => void this.handleUndoClick(id),
      // v0.3 Phase 6 (FR-016): suppress the Undo affordance on
      // historical raw-FS tool calls when the user has the
      // `exposeRawFsTools` setting OFF AT STARTUP. The call name +
      // result still render so the user can read what happened —
      // only the action button disappears. Reads the startup snapshot
      // (per FR-015) so a mid-session toggle does not hide Undo for
      // tools the runtime still has registered.
      isUndoSuppressed: (toolName) => {
        if (this.getExposeRawFsTools()) return false;
        return RAW_FS_TOOL_NAME_SET.has(toolName);
      },
      // v0.3 Phase 2 (FR-018, MF-3): clicking a search-result row opens
      // the matched note in the active leaf. We reuse Obsidian's
      // openLinkText so the user lands on the canonical resolved file
      // (including any aliases / link-text resolution Obsidian applies).
      onOpenLink: (linkText) => {
        try {
          (this.app.workspace as unknown as {
            openLinkText?: (
              link: string,
              src: string,
              newLeaf?: boolean,
            ) => void;
          }).openLinkText?.(linkText, "", false);
        } catch (e) {
          new Notice(`Could not open ${linkText}: ${(e as Error).message}`);
        }
      },
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
    // v0.3 Phase 4: re-bind when the manager flips active conversations
    // (or when first hydrating from disk and the active runtime appears).
    this.unsubManager = this.manager.subscribe((ev) => {
      if (ev.kind === "active-changed" || ev.kind === "list-changed") {
        const prevId = this.boundConversationId;
        this.bindActiveRuntime();
        if (this.boundConversationId !== prevId) {
          // New runtime → tear down the stale state subscription and
          // re-attach to the new runtime's ChatState. Then re-render
          // the list against the new state's current messages.
          this.unsubState?.();
          this.unsubState = this.state.subscribe(() => this.syncList());
          this.syncList();
        }
      }
      if (ev.kind === "auto-archived") {
        // CONS-4 / FR-002: surface a Notice naming the archived
        // conversation so the user understands why an old chat just
        // disappeared from the picker.
        new Notice(
          `Soft cap of ${CONVERSATION_SOFT_CAP} conversations reached — archived "${ev.name}".`,
          4000,
        );
      }
      // v0.3 Phase 5: picker mirrors the manager catalog. Cheap enough
      // to re-render on every event (≤ 20 items per FR-002).
      this.refreshPicker();
    });
    // Initial render so the picker reflects whatever the manager
    // already hydrated by the time the view opens.
    this.refreshPicker();
  }

  /** Build picker items from the manager's current catalog + active
   *  id, then push them into the picker. */
  private refreshPicker(): void {
    if (!this.picker) return;
    const items = buildPickerItems(
      this.manager.listActive(),
      this.manager.getActiveId(),
    );
    const active = items.find((i) => i.isActive);
    this.picker.render(items, active?.fullName ?? null);
  }

  async onClose(): Promise<void> {
    this.unsubState?.();
    this.unsubAuth?.();
    this.unsubManager?.();
    this.picker?.destroy();
    this.picker = undefined;
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
      const streamState = this.currentStreamState ?? this.state;
      streamState.interruptStreaming(this.currentPlaceholderId);
    }
    this.sendBtnEl.disabled = true;
    try {
      // Cancel the ORIGINATING session, not whatever `this.agent` now
      // points at — a mid-stream `setActive(other)` swaps `this.agent`
      // to the new runtime's session and calling cancelCurrent() on
      // it is a no-op (it's idle).
      const session = this.currentStreamSession ?? this.agent;
      await session?.cancelCurrent();
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
    // v0.3 Phase 4: ensure we're bound to the latest active runtime
    // (covers the boot-time window between view construction and
    // ConversationManager.hydrate completing).
    this.bindActiveRuntime();
    const session = this.agent;
    if (!session) {
      new Notice("Conversation not ready yet — please retry.", 5000);
      return;
    }
    const text = this.inputEl.value.trim();
    if (!text) return;
    this.inputEl.value = "";
    this.userRequestedStop = false;
    this.setBusy(true);

    // v0.3 Phase 4: capture the originating runtime's state + id at
    // send time. A mid-stream `setActive(other)` switches `this.state`
    // and `this.agent` to a DIFFERENT runtime — without capture, the
    // streaming deltas/tool-calls below would silently leak into the
    // wrong conversation's ChatState (and persist to the wrong row).
    const state = this.state;
    const convId = this.boundConversationId;
    // SINGLE-1: bump lastActiveAt on the active conversation so the
    // picker order and soft-cap victim selection reflect activity. A
    // switch already calls touchActive via setActive; this covers the
    // "send to the already-active conv" path that wouldn't otherwise
    // refresh the timestamp.
    this.manager.touchActive();
    const userMsgId = state.append({ role: "user", content: text });
    const placeholderId = state.append({
      role: "assistant",
      content: "",
      status: "pending",
    });
    this.currentPlaceholderId = placeholderId;
    this.currentStreamState = state;
    this.currentStreamSession = session;
    // Persist the user message immediately so a crash mid-stream
    // doesn't lose the prompt. The assistant placeholder is also
    // persisted as `pending` so the conversation row has a slot for
    // the final replace at the end of the turn.
    if (convId) {
      // v0.3 Phase 5 follow-up (FR-005): auto-derive a conversation
      // name from the very first user message. The manager itself
      // gates on "is the current name still a default?" so this is
      // safe to call unconditionally — if the user already renamed
      // the conversation, it's a no-op.
      const userMsgCount = state
        .getMessages()
        .filter((m) => m.role === "user").length;
      if (userMsgCount === 1) {
        try {
          this.manager.maybeAutoNameFromFirstMessage(convId, text);
        } catch (e) {
          console.warn("[ChatView] auto-name failed", e);
        }
      }
      const userMsg = state
        .getMessages()
        .find((m) => m.id === userMsgId);
      if (userMsg) {
        // User messages should always be `complete` once appended;
        // narrow the broader ChatState `MessageStatus` to the persisted
        // shape. Any unexpected non-terminal value collapses to
        // `complete` for the persisted form (we already wrote the
        // canonical user text).
        const persistedStatus: PersistedMessage["status"] =
          userMsg.status === "interrupted"
            ? "interrupted"
            : userMsg.status === "error"
              ? "error"
              : "complete";
        this.manager.persistMessageAppend(convId, {
          id: userMsg.id,
          role: userMsg.role,
          content: userMsg.content,
          status: persistedStatus,
          createdAt: userMsg.createdAt,
        });
      }
      this.manager.persistMessageAppend(convId, {
        id: placeholderId,
        role: "assistant",
        content: "",
        // Persist as `interrupted` so a crash mid-stream restores the
        // turn in a non-misleading state (matches PersistedShape's
        // doc: volatile streaming/pending statuses collapse to
        // `interrupted` on persist). The final replace below flips
        // this to `complete` / `error` / `interrupted` based on the
        // actual outcome once the stream resolves.
        status: "interrupted",
        createdAt: Date.now(),
      });
    }

    let receivedAnyDelta = false;
    let finalContent = "";
    let finalToolCalls: import("../domain/types").ToolCall[] = [];
    let failure: unknown = null;

    this.setStreaming(true);
    try {
      for await (const ev of session.sendMessageStreaming(text)) {
        if (this.userRequestedStop) {
          // Drain the iterator but don't apply any further updates.
          // The placeholder is already frozen as `interrupted`; we
          // just need to let the generator's `finally` clean up.
          continue;
        }
        if (ev.type === "delta") {
          receivedAnyDelta = true;
          state.appendDelta(placeholderId, ev.text);
        } else if (ev.type === "tool_call_start") {
          // Live tool-call block. We map AgentSession's structural
          // type to the domain ToolCall shape (they share fields).
          state.upsertToolCall(placeholderId, {
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
          state.upsertToolCall(placeholderId, {
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
          state.upsertToolCall(placeholderId, {
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
          state.upsertToolCall(placeholderId, {
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
    this.currentStreamState = undefined;
    this.currentStreamSession = undefined;

    if (failure) {
      const msg = failure instanceof Error ? failure.message : String(failure);
      state.update(placeholderId, {
        content: `**Error:** ${msg}`,
        status: "error",
      });
      new Notice(`Copilot Agent error: ${msg}`, 8000);
    } else if (cancelled) {
      // User clicked Stop before any delta arrived. Freeze placeholder
      // as interrupted with whatever (if anything) was streamed.
      state.interruptStreaming(placeholderId);
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
        state.upsertToolCall(placeholderId, tc);
      }
      let content = finalContent;
      if (!content && !receivedAnyDelta && finalToolCalls.length === 0) {
        content = "_(empty response)_";
      }
      // If streaming yielded content but the final is empty, keep what
      // we streamed rather than blanking the message.
      if (!content && receivedAnyDelta) {
        // Just flip status; ChatState already holds the streamed text.
        state.update(placeholderId, {
          status: "complete",
        });
      } else {
        state.update(placeholderId, {
          content,
          status: "complete",
        });
      }
    }

    // v0.3 Phase 4 (FR-007): land the final assistant message in the
    // persisted store. We snapshot from `state` (the originating
    // runtime), so a mid-stream conversation switch can't redirect
    // the write to the wrong row. `ConversationsStore` debounces, so
    // this single replace coalesces with the earlier pending-append.
    if (convId) {
      const finalMsg = state
        .getMessages()
        .find((m) => m.id === placeholderId);
      if (finalMsg) {
        const status: PersistedMessage["status"] =
          finalMsg.status === "complete"
            ? "complete"
            : finalMsg.status === "error"
              ? "error"
              : "interrupted";
        // Filter out non-persisted tool-call outcomes (e.g. the
        // transient `pending_approval` pseudo-state used while a
        // prompt is awaiting the user). Only terminal outcomes
        // belong in the persisted shape.
        const persistedToolCalls = toPersistedToolCalls(finalMsg.toolCalls);
        this.manager.persistMessageReplace(convId, placeholderId, {
          content: finalMsg.content,
          status,
          toolCalls: persistedToolCalls,
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
    const result = await runUndoFlow(undoId, {
      journal: this.undoJournal,
      confirm: (title, body, ctaLabel) =>
        confirmDestructive(this.app, title, body, ctaLabel),
      notify: (m) => {
        new Notice(m);
      },
    });
    if (result.result !== "success") return;
    const undoneId = result.entry.id;
    const messages = this.state.getMessages();
    for (const m of messages) {
      const hit = m.toolCalls?.find((c) => c.undoId === undoneId);
      if (hit) {
        this.state.upsertToolCall(m.id, {
          id: hit.id,
          kind: hit.kind,
          outcome: "completed",
          undoId: undoneId,
          undone: true,
        });
        // CONS-1 / FR-013: also persist the updated `toolCalls[].undone`
        // flag so a restart sees the entry as reverted instead of
        // re-rendering the Undo button. Without this write the
        // ConversationsStore.markUndone (which flips the journal entry)
        // and the rendered tool-call block fall out of sync on reload.
        const convId = this.boundConversationId;
        if (convId) {
          const updated = this.state
            .getMessages()
            .find((mm) => mm.id === m.id);
          const persistedToolCalls = toPersistedToolCalls(updated?.toolCalls);
          if (persistedToolCalls) {
            this.manager.persistMessageReplace(convId, m.id, {
              toolCalls: persistedToolCalls,
            });
          }
        }
        break;
      }
    }
  }
}

// divergenceConfirmMessage moved to ./undoFlow.ts (Phase 6 refactor for
// unit-testability).

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

/**
 * Map ChatState `ToolCall[]` → `PersistedMessage["toolCalls"]`. Drops
 * the transient `pending_approval` outcome (only terminal outcomes
 * belong on disk). Used by the streaming send-completion writer AND by
 * the Undo flow's persistence write so cross-restart Undo state stays
 * in sync with the journal entry's `undone` flag (CONS-1, FR-013).
 */
function toPersistedToolCalls(
  toolCalls: import("../domain/types").ToolCall[] | undefined,
): PersistedMessage["toolCalls"] | undefined {
  if (!toolCalls) return undefined;
  return toolCalls
    .filter(
      (tc) =>
        tc.outcome === "completed" ||
        tc.outcome === "errored" ||
        tc.outcome === "approved" ||
        tc.outcome === "denied",
    )
    .map((tc) => ({
      id: tc.id,
      kind: tc.kind,
      name: tc.name,
      source: tc.source,
      outcome: tc.outcome as
        | "completed"
        | "errored"
        | "approved"
        | "denied",
      detail: tc.detail,
      argsPreview: tc.argsPreview,
      resultContent: tc.resultContent,
      undoId: tc.undoId,
      undone: tc.undone,
    }));
}

