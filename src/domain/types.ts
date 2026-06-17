// Pure domain types. No Obsidian or SDK imports. Safe to consume from
// tests, UI, or adapter layers.

export type Role = "user" | "assistant" | "system";

/**
 * Lifecycle of an assistant or user message in the chat log.
 *
 * - `pending`     — placeholder created, no content yet (e.g. "Thinking…").
 * - `streaming`   — receiving incremental deltas; `content` grows over time.
 * - `complete`    — final content received and locked.
 * - `interrupted` — user cancelled mid-stream; partial `content` frozen.
 * - `error`       — turn failed; `content` typically holds the error text.
 */
export type MessageStatus =
  | "pending"
  | "streaming"
  | "complete"
  | "interrupted"
  | "error";

export interface ToolCall {
  /** Stable id from the SDK request, when available. */
  id: string;
  /** SDK-reported tool source/kind (e.g. "shell", "custom-tool", "mcp"). */
  kind: string;
  /** SDK-reported tool name when present. */
  name?: string;
  /**
   * Phase 5: high-level source classification for UI rendering.
   *   - `custom`  — registered by us (vault read tools)
   *   - `mcp`     — provided by an MCP server
   *   - `builtin` — bundled with the CLI runtime (shell, web_fetch, …)
   */
  source?: "custom" | "mcp" | "builtin";
  /** "denied" in Phase 2 (deny-by-default). Phase 6 adds `pending_approval`. */
  outcome:
    | "denied"
    | "approved"
    | "completed"
    | "errored"
    | "cancelled"
    | "pending_approval";
  /** Optional message describing why (e.g. denial reason / error). */
  detail?: string;
  /** Pretty-printed arguments for display. */
  argsPreview?: string;
  /** Successful result content for display. */
  resultContent?: string;
  /**
   * Phase 6: populated when `outcome === "pending_approval"` so the UI
   * can render an inline ApprovalPrompt block. Cleared on resolution.
   */
  approval?: {
    summary: string;
    detail?: string;
    canOfferSession: boolean;
  };
  /**
   * Phase 6: id of the corresponding UndoJournal entry for successful
   * vault writes. Drives the inline Undo button. Undefined for
   * non-write or failed calls.
   */
  undoId?: string;
  /**
   * Phase 6: true once the user has clicked Undo and the action was
   * reverted successfully. The Undo button becomes inert.
   */
  undone?: boolean;
}

export interface Message {
  id: string;
  role: Role;
  /** Markdown content. May be empty for placeholders or tool-error messages. */
  content: string;
  /** Tool calls observed/affected during this turn. */
  toolCalls?: ToolCall[];
  status: MessageStatus;
  createdAt: number;
}

/**
 * Subset of the SDK's PermissionRequest shape. We intentionally avoid
 * importing the SDK type here so the domain layer stays SDK-agnostic.
 */
export interface PermissionRequest {
  kind: string;
  toolName?: string;
  /** Free-form passthrough payload from SDK. Useful for logging. */
  raw?: unknown;
}
