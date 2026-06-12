import type { Message, MessageStatus, Role, ToolCall } from "./types";

export type ChatStateListener = (state: ChatState) => void;

/**
 * In-memory ordered conversation log. Pure data; no UI / SDK / IO.
 * Listeners receive the same instance after every mutation so renderers
 * can diff and update incrementally.
 */
export class ChatState {
  private readonly messages: Message[] = [];
  private readonly listeners = new Set<ChatStateListener>();
  private idCounter = 0;

  /**
   * Optionally seed initial messages (v0.3 Phase 4 hydration). Uses
   * `silent: true` semantics — no listeners fire and id counter is
   * advanced past any numeric ids in the seed so future `append`
   * calls don't collide.
   */
  constructor(initial?: readonly Message[]) {
    if (initial && initial.length > 0) {
      for (const m of initial) {
        this.messages.push({ ...m });
        // Ids look like "m12"; advance counter past the largest seed id
        // so future `append` calls don't collide.
        const match = /^m(\d+)$/.exec(m.id);
        if (match) {
          const n = Number(match[1]);
          if (Number.isFinite(n) && n > this.idCounter) this.idCounter = n;
        }
      }
    }
  }

  /** Snapshot of the current message list (immutable copy). */
  getMessages(): readonly Message[] {
    return this.messages.slice();
  }

  /** Append a message and return its id. */
  append(input: {
    role: Role;
    content: string;
    status?: MessageStatus;
    toolCalls?: ToolCall[];
  }): string {
    const id = this.nextId();
    this.messages.push({
      id,
      role: input.role,
      content: input.content,
      status: input.status ?? "complete",
      toolCalls: input.toolCalls,
      createdAt: Date.now(),
    });
    this.emit();
    return id;
  }

  /** Patch an existing message in place. No-op if id not found. */
  update(id: string, patch: Partial<Omit<Message, "id" | "createdAt">>): void {
    const idx = this.messages.findIndex((m) => m.id === id);
    if (idx < 0) return;
    const existing = this.messages[idx];
    this.messages[idx] = {
      ...existing,
      ...patch,
      id: existing.id,
      createdAt: existing.createdAt,
    };
    this.emit();
  }

  /**
   * Append a streaming text chunk to an existing message and (idempotently)
   * mark its status as `streaming`. No-op if id not found or the message is
   * already in a terminal state (`complete` / `interrupted` / `error`).
   *
   * Returns true if the delta was applied. Used by Phase 4 streaming.
   */
  appendDelta(id: string, text: string): boolean {
    const idx = this.messages.findIndex((m) => m.id === id);
    if (idx < 0) return false;
    if (text.length === 0) return false;
    const existing = this.messages[idx];
    if (
      existing.status === "complete" ||
      existing.status === "interrupted" ||
      existing.status === "error"
    ) {
      return false;
    }
    this.messages[idx] = {
      ...existing,
      content: existing.content + text,
      status: "streaming",
      id: existing.id,
      createdAt: existing.createdAt,
    };
    this.emit();
    return true;
  }

  /**
   * Freeze a streaming/pending message as `interrupted` and keep whatever
   * content has accumulated so far. No-op if the message is already in a
   * terminal state. Used by Phase 4 when the user clicks Stop.
   */
  interruptStreaming(id: string): boolean {
    const idx = this.messages.findIndex((m) => m.id === id);
    if (idx < 0) return false;
    const existing = this.messages[idx];
    if (
      existing.status === "complete" ||
      existing.status === "interrupted" ||
      existing.status === "error"
    ) {
      return false;
    }
    this.messages[idx] = {
      ...existing,
      status: "interrupted",
      id: existing.id,
      createdAt: existing.createdAt,
    };
    this.emit();
    return true;
  }

  /**
   * v0.4 FR-005: id-less variant used by `ConversationRuntime.setModelId`
   * to freeze whichever assistant message is currently streaming/pending
   * BEFORE the SDK abort fires during a model swap. Without this, the
   * abort gets bucketed as `error` by the stream finalizer rather than
   * as a clean `interrupted`. Returns the id of the message that was
   * frozen, or `null` if nothing was live.
   */
  interruptStreamingMessage(): string | null {
    const idx = this.messages.findIndex(
      (m) => m.status === "streaming" || m.status === "pending",
    );
    if (idx < 0) return null;
    const existing = this.messages[idx];
    this.messages[idx] = {
      ...existing,
      status: "interrupted",
      id: existing.id,
      createdAt: existing.createdAt,
    };
    this.emit();
    return existing.id;
  }

  /**
   * Append a tool call to a message's `toolCalls` list, or update an
   * existing one with the same id. Returns true if state mutated.
   * Used by Phase 5 to render live tool-call blocks as the SDK fires
   * `tool.execution_start` / `tool.execution_complete` events.
   */
  upsertToolCall(messageId: string, toolCall: ToolCall): boolean {
    const idx = this.messages.findIndex((m) => m.id === messageId);
    if (idx < 0) return false;
    const existing = this.messages[idx];
    const calls = existing.toolCalls ? existing.toolCalls.slice() : [];
    const callIdx = calls.findIndex((c) => c.id === toolCall.id);
    if (callIdx < 0) {
      calls.push(toolCall);
    } else {
      // Merge: keep prior fields that the new update doesn't override
      // (e.g. `argsPreview` from start event when complete event lacks it).
      calls[callIdx] = { ...calls[callIdx], ...toolCall };
    }
    this.messages[idx] = {
      ...existing,
      toolCalls: calls,
      id: existing.id,
      createdAt: existing.createdAt,
    };
    this.emit();
    return true;
  }

  /** Remove all messages. */
  clear(): void {
    if (this.messages.length === 0) return;
    this.messages.length = 0;
    this.emit();
  }

  /** Subscribe to mutations. Returns an unsubscribe function. */
  subscribe(listener: ChatStateListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    for (const listener of this.listeners) {
      try {
        listener(this);
      } catch (e) {
        console.error("[ChatState] listener threw", e);
      }
    }
  }

  private nextId(): string {
    this.idCounter += 1;
    return `m${this.idCounter}`;
  }
}
