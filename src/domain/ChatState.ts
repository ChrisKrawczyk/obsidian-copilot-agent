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
