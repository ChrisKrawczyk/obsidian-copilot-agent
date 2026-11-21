import type { VaultChange } from "../domain/VaultChangeDetector";
import type { ToolCall } from "../domain/types";

export interface VaultChangeWarningView {
  headline: string;
  lines: string[];
  footnote: string;
}

const VERB: Record<VaultChange["type"], string> = {
  created: "created",
  modified: "modified",
  deleted: "deleted",
  renamed: "renamed",
};

export function formatVaultChangeWarning(
  changes: readonly VaultChange[],
  overflow = 0,
): VaultChangeWarningView | null {
  if (changes.length === 0 && overflow <= 0) return null;
  const count = overflow > 0 ? `More than ${changes.length} vault files` : changes.length === 1 ? "1 vault file" : `${changes.length} vault files`;
  const headline = `${count} may have been changed outside the vault tools while this ran.`;
  const lines = changes.map((c) =>
    c.type === "renamed" && c.oldPath
      ? `renamed: ${c.oldPath} → ${c.path}`
      : `${VERB[c.type]}: ${c.path}`,
  );
  if (overflow > 0) lines.push(`…plus ${overflow} more change${overflow === 1 ? "" : "s"} not listed`);
  let footnote =
    "Changes made this way skip the approval prompts and can't be undone from chat.";
  if (changes.some((c) => c.type === "renamed" || c.type === "deleted")) {
    footnote += " Moves and deletes made with shell commands don't update links to these notes.";
  }
  return { headline, lines, footnote };
}

export type ExternalWindowSignal = { kind: "start" | "end"; toolCallId: string } | null;

export type ToolStreamEvent =
  | { type: "tool_call_start"; toolCall: Pick<ToolCall, "id" | "source" | "outcome"> }
  | { type: "tool_call_complete"; id: string }
  | { type: "approval_resolved"; id: string; choice: { kind: string } }
  | { type: string };

function isExternal(source: ToolCall["source"]): boolean {
  return source === "builtin" || source === "mcp";
}

/**
 * Which stream events open or close an out-of-band detection window.
 * Only built-in and MCP calls that actually run open one; denied,
 * cancelled and still-pending calls never do.
 */
export function externalWindowSignal(
  ev: ToolStreamEvent,
  sourceOf: (toolCallId: string) => ToolCall["source"] | undefined,
): ExternalWindowSignal {
  if (ev.type === "tool_call_start" && "toolCall" in ev) {
    const tc = ev.toolCall;
    if (tc.outcome !== "approved") return null;
    return isExternal(tc.source ?? sourceOf(tc.id)) ? { kind: "start", toolCallId: tc.id } : null;
  }
  if (ev.type === "approval_resolved" && "choice" in ev) {
    const kind = ev.choice.kind;
    if (kind === "reject" || kind === "cancelled") return null;
    return isExternal(sourceOf(ev.id)) ? { kind: "start", toolCallId: ev.id } : null;
  }
  if (ev.type === "tool_call_complete" && "id" in ev) {
    return { kind: "end", toolCallId: ev.id };
  }
  return null;
}
