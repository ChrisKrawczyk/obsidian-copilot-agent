import { Component, MarkdownRenderer, type App } from "obsidian";
import type { Message, ToolCall } from "../domain/types";
import { renderToolCallBlock, type ToolCallBlockHandlers } from "./ToolCallBlock";

/**
 * Internal render slot tracked per message id. Owned by MessageRenderer.
 */
interface MessageSlot {
  /** Outer container that holds role label + tool calls + body. */
  wrapperEl: HTMLElement;
  /** Container for tool-call blocks (rendered above the message text). */
  toolCallsEl: HTMLElement;
  /** Body element re-rendered on content change. */
  bodyEl: HTMLElement;
  /**
   * Component scope for the current Markdown render. We unload + replace
   * it on each non-streaming re-render so embedded preview lifecycles
   * (code blocks, embeds, etc.) clean up properly.
   */
  component: Component;
  /** Last `content` we rendered for this message. Used to avoid no-op work. */
  lastContent: string;
  /** Last `status` we rendered (drives wrapper CSS classes). */
  lastStatus: Message["status"];
  /**
   * Cheap signature of the last rendered toolCalls so we can skip
   * re-rendering when nothing changed. Captures id + outcome + result
   * length + detail length so any meaningful update invalidates it.
   */
  lastToolCallsSig: string;
  /**
   * If the message is currently in `streaming` mode, we render its
   * incremental text into this plain <pre>-like node and skip Markdown.
   * On `complete` (or `interrupted`/`error`) we tear it down and render
   * the final Markdown into `bodyEl` once.
   */
  streamingTextEl?: HTMLElement;
  /**
   * RAF id for a scheduled streaming-text flush. Coalesces multiple
   * delta updates within a single animation frame.
   */
  scheduledRaf?: number;
  /** Pending streaming text not yet flushed to DOM. */
  pendingStreamText?: string;
}

/**
 * Owns the per-message render lifecycle for ChatView. Strategy:
 *
 * - **Streaming messages** render plain text into a `<div class="…-stream">`
 *   node and update via requestAnimationFrame batching. We deliberately
 *   skip MarkdownRenderer.render on every delta — running a full
 *   Markdown render per token is expensive and visually jittery
 *   (lists/code blocks rebuild constantly). Plain text streaming gives
 *   the user immediate feedback; the final Markdown render happens once
 *   when the message transitions out of `streaming`.
 *
 * - **Terminal messages** (`complete` / `interrupted` / `error` / `pending`)
 *   render via MarkdownRenderer.render. Re-rendering is in-place: we
 *   unload the old Component scope, empty `bodyEl`, and render again.
 *
 * Keeping all of this here lets ChatView stay focused on input/auth/state
 * orchestration and gives Phase 5 a single place to extend rendering for
 * interleaved tool calls.
 */
export class MessageRenderer {
  private readonly slots = new Map<string, MessageSlot>();
  /**
   * Phase 6: handlers used when rendering tool-call blocks (approval
   * and undo button clicks). Mutable so ChatView can set them after
   * MessageRenderer construction without changing the ctor signature.
   */
  private toolCallHandlers: ToolCallBlockHandlers = {};

  constructor(
    private readonly app: App,
    private readonly listEl: HTMLElement,
    /** Adds a child component to the parent view's lifecycle. */
    private readonly addChild: (c: Component) => void,
  ) {}

  setToolCallHandlers(handlers: ToolCallBlockHandlers): void {
    this.toolCallHandlers = handlers;
  }

  /**
   * Sync the DOM against `messages`. Appends new messages, updates
   * changed ones, removes dropped ones. Idempotent.
   */
  sync(messages: readonly Message[]): void {
    const seen = new Set<string>();
    for (const m of messages) {
      seen.add(m.id);
      const existing = this.slots.get(m.id);
      if (!existing) {
        this.appendMessage(m);
        continue;
      }
      const contentChanged = existing.lastContent !== m.content;
      const statusChanged = existing.lastStatus !== m.status;
      const toolSig = toolCallsSig(m.toolCalls);
      const toolsChanged = existing.lastToolCallsSig !== toolSig;
      if (!contentChanged && !statusChanged && !toolsChanged) continue;

      if (toolsChanged) {
        this.renderToolCalls(existing, m.toolCalls);
        existing.lastToolCallsSig = toolSig;
      }
      if (contentChanged || statusChanged) {
        if (m.status === "streaming") {
          this.updateStreaming(existing, m);
        } else {
          this.updateFinal(existing, m);
        }
      }
    }
    for (const [id, slot] of this.slots) {
      if (!seen.has(id)) {
        this.cancelRaf(slot);
        slot.component.unload();
        slot.wrapperEl.detach();
        this.slots.delete(id);
      }
    }
    this.listEl.scrollTop = this.listEl.scrollHeight;
  }

  /** Tear down all per-message Component scopes. Called from ChatView.onClose. */
  dispose(): void {
    for (const slot of this.slots.values()) {
      this.cancelRaf(slot);
      slot.component.unload();
    }
    this.slots.clear();
  }

  // ---- internals ----

  private appendMessage(m: Message): void {
    const wrapper = this.listEl.createDiv({
      cls: `copilot-agent-msg copilot-agent-msg-${m.role}${
        statusClass(m.status)
      }`,
    });
    wrapper.createEl("div", {
      cls: "copilot-agent-msg-role",
      text:
        m.role === "user" ? "You" : m.role === "assistant" ? "Copilot" : "System",
    });
    const toolCallsEl = wrapper.createDiv({
      cls: "copilot-agent-msg-toolcalls",
    });
    const body = wrapper.createDiv({ cls: "copilot-agent-msg-body" });
    const component = new Component();
    this.addChild(component);

    const slot: MessageSlot = {
      wrapperEl: wrapper,
      toolCallsEl,
      bodyEl: body,
      component,
      lastContent: m.content,
      lastStatus: m.status,
      lastToolCallsSig: toolCallsSig(m.toolCalls),
    };
    this.slots.set(m.id, slot);
    this.renderToolCalls(slot, m.toolCalls);

    if (m.status === "streaming") {
      this.installStreamingNode(slot, m.content);
    } else {
      void MarkdownRenderer.render(this.app, m.content, body, "", component);
    }
  }

  private renderToolCalls(slot: MessageSlot, calls: ToolCall[] | undefined): void {
    slot.toolCallsEl.empty();
    if (!calls || calls.length === 0) return;
    for (const c of calls) {
      slot.toolCallsEl.appendChild(
        renderToolCallBlock(c, this.toolCallHandlers),
      );
    }
  }

  private updateStreaming(slot: MessageSlot, m: Message): void {
    slot.lastContent = m.content;
    slot.lastStatus = m.status;
    this.refreshWrapperClasses(slot, m);
    if (!slot.streamingTextEl) {
      this.installStreamingNode(slot, m.content);
      return;
    }
    slot.pendingStreamText = m.content;
    if (slot.scheduledRaf != null) return;
    slot.scheduledRaf = requestAnimationFrame(() => {
      slot.scheduledRaf = undefined;
      if (slot.streamingTextEl && slot.pendingStreamText != null) {
        slot.streamingTextEl.textContent = slot.pendingStreamText;
        this.listEl.scrollTop = this.listEl.scrollHeight;
      }
      slot.pendingStreamText = undefined;
    });
  }

  private updateFinal(slot: MessageSlot, m: Message): void {
    this.cancelRaf(slot);
    if (slot.streamingTextEl) {
      slot.streamingTextEl.remove();
      slot.streamingTextEl = undefined;
    }
    slot.component.unload();
    slot.bodyEl.empty();
    const fresh = new Component();
    this.addChild(fresh);
    slot.component = fresh;
    slot.lastContent = m.content;
    slot.lastStatus = m.status;
    this.refreshWrapperClasses(slot, m);
    void MarkdownRenderer.render(
      this.app,
      m.content,
      slot.bodyEl,
      "",
      fresh,
    );
  }

  private installStreamingNode(slot: MessageSlot, content: string): void {
    slot.bodyEl.empty();
    const stream = slot.bodyEl.createDiv({ cls: "copilot-agent-msg-stream" });
    stream.textContent = content;
    slot.streamingTextEl = stream;
  }

  private refreshWrapperClasses(slot: MessageSlot, m: Message): void {
    slot.wrapperEl.toggleClass("is-pending", m.status === "pending");
    slot.wrapperEl.toggleClass("is-streaming", m.status === "streaming");
    slot.wrapperEl.toggleClass("is-error", m.status === "error");
    slot.wrapperEl.toggleClass("is-interrupted", m.status === "interrupted");
  }

  private cancelRaf(slot: MessageSlot): void {
    if (slot.scheduledRaf != null) {
      cancelAnimationFrame(slot.scheduledRaf);
      slot.scheduledRaf = undefined;
    }
    slot.pendingStreamText = undefined;
  }
}

function statusClass(status: Message["status"]): string {
  switch (status) {
    case "pending":
      return " is-pending";
    case "streaming":
      return " is-streaming";
    case "error":
      return " is-error";
    case "interrupted":
      return " is-interrupted";
    default:
      return "";
  }
}

/**
 * Cheap signature that changes whenever a tool call list would render
 * differently. Captures id, outcome, source, and lengths of mutable
 * text fields. We don't hash the full content because it can be large
 * (full file contents) and `lastToolCallsSig` is compared on every
 * `sync` — but the lengths catch any append.
 */
function toolCallsSig(calls: ToolCall[] | undefined): string {
  if (!calls || calls.length === 0) return "";
  return calls
    .map(
      (c) =>
        `${c.id}|${c.outcome}|${c.source ?? ""}|${
          c.resultContent?.length ?? 0
        }|${c.detail?.length ?? 0}|${c.argsPreview?.length ?? 0}|${
          c.approval?.summary?.length ?? 0
        }|${c.undoId ?? ""}|${c.undone ? "u" : ""}`,
    )
    .join(";");
}
