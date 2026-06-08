// Pure domain types. No Obsidian or SDK imports. Safe to consume from
// tests, UI, or adapter layers.

export type Role = "user" | "assistant" | "system";

export type MessageStatus = "pending" | "complete" | "error";

export interface ToolCall {
  /** Stable id from the SDK request, when available. */
  id: string;
  /** SDK-reported tool source/kind (e.g. "shell", "custom-tool", "mcp"). */
  kind: string;
  /** SDK-reported tool name when present. */
  name?: string;
  /** "denied" in Phase 2 (deny-by-default). */
  outcome: "denied" | "approved" | "completed" | "errored";
  /** Optional message describing why (e.g. denial reason). */
  detail?: string;
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
