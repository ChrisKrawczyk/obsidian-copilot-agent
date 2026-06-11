import type { ToolCall } from "../domain/types";
import {
  parseSearchToolResult,
  type SearchMatchView,
  type TagCountView,
} from "./searchResultRenderer";

/**
 * Callback surface from the chat view into the block. The block emits
 * approval clicks and undo clicks; the view dispatches them onto the
 * agent / undo journal. Kept as plain functions so the block stays
 * pure-render and testable.
 */
export interface ToolCallBlockHandlers {
  onApprove?: (callId: string) => void;
  onApproveForSession?: (callId: string) => void;
  onReject?: (callId: string) => void;
  onUndo?: (callId: string) => void;
  /**
   * v0.3 Phase 2 (FR-018, MF-3): the block calls this when the user
   * clicks a search-tool match row. The view wires it to
   * `app.workspace.openLinkText(path, "", false)` so the target note
   * opens in the active leaf. Kept as a callback (not a direct
   * Obsidian dependency) so the block stays unit-testable.
   */
  onOpenLink?: (linkText: string) => void;
  /**
   * v0.3 Phase 6 (FR-016): predicate the view supplies so the block
   * can hide the Undo button for raw-FS tool calls when the user has
   * the `exposeRawFsTools` safety setting OFF. The block still
   * renders the call name + result so historical context survives
   * setting toggles; only the action affordance is suppressed.
   * Suppression does NOT affect the "reverted" pill on already-undone
   * calls (those remain visible so the user knows what happened).
   * Returning `false`/`undefined` keeps the default Undo affordance.
   */
  isUndoSuppressed?: (toolName: string) => boolean;
}

/**
 * Render a single tool call as a collapsible `<details>` block. The
 * element is fully self-contained (no event listeners or component
 * lifecycle) so MessageRenderer can drop it and rebuild on any state
 * change without leaking resources.
 *
 * Design choices:
 *  - `<details>` rather than a custom toggle so keyboard / screen-reader
 *    behaviour is correct out of the box.
 *  - Status pill on the right of the summary so the user can tell at a
 *    glance whether a call ran, was denied, or errored.
 *  - Args + result/error are rendered as plain text inside `<pre>` so
 *    arbitrary content (including code snippets, JSON, paths) can't
 *    inject HTML.
 *
 * Phase 6 additions:
 *  - Pending-approval state renders an inline ApprovalPrompt UI inside
 *    the body (Approve / Approve for Session / Reject buttons).
 *  - Completed write tool calls (with `undoId`) render an Undo button
 *    next to the status pill; the button is replaced with "reverted"
 *    text after a successful undo.
 */
export function renderToolCallBlock(
  call: ToolCall,
  handlers: ToolCallBlockHandlers = {},
): HTMLElement {
  const wrapper = document.createElement("details");
  wrapper.classList.add(
    "copilot-agent-toolcall",
    `copilot-agent-toolcall-${call.outcome}`,
    `copilot-agent-toolcall-source-${call.source ?? "unknown"}`,
  );
  // Open pending-approval blocks by default so the user sees the
  // prompt without having to click into them.
  if (call.outcome === "pending_approval") wrapper.open = true;

  const summary = document.createElement("summary");
  summary.classList.add("copilot-agent-toolcall-summary");

  const icon = document.createElement("span");
  icon.classList.add("copilot-agent-toolcall-icon");
  icon.textContent = sourceIcon(call.source);
  summary.appendChild(icon);

  const nameEl = document.createElement("span");
  nameEl.classList.add("copilot-agent-toolcall-name");
  nameEl.textContent = call.name ?? call.kind ?? "tool";
  summary.appendChild(nameEl);

  const sourceLabel = document.createElement("span");
  sourceLabel.classList.add("copilot-agent-toolcall-source");
  sourceLabel.textContent = sourceLabelText(call.source);
  summary.appendChild(sourceLabel);

  const statusPill = document.createElement("span");
  statusPill.classList.add(
    "copilot-agent-toolcall-status",
    `copilot-agent-toolcall-status-${call.outcome}`,
  );
  statusPill.textContent = statusText(call.outcome);
  summary.appendChild(statusPill);

  // Undo button (rendered for completed write calls with an undoId).
  const undoSuppressed =
    !!call.name && !!handlers.isUndoSuppressed?.(call.name);
  if (
    call.outcome === "completed" &&
    call.undoId &&
    !call.undone &&
    handlers.onUndo &&
    !undoSuppressed
  ) {
    const undoBtn = document.createElement("button");
    undoBtn.type = "button";
    undoBtn.classList.add("copilot-agent-toolcall-undo");
    undoBtn.textContent = "Undo";
    // Stop the click from toggling the <details> open state.
    undoBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (call.undoId) handlers.onUndo?.(call.undoId);
    });
    summary.appendChild(undoBtn);
  } else if (call.outcome === "completed" && call.undone) {
    const undone = document.createElement("span");
    undone.classList.add("copilot-agent-toolcall-undone");
    undone.textContent = "reverted";
    summary.appendChild(undone);
  }

  wrapper.appendChild(summary);

  // Body — args, result, error, approval prompt (when present).
  const body = document.createElement("div");
  body.classList.add("copilot-agent-toolcall-body");

  if (call.argsPreview) {
    body.appendChild(makeLabeledPre("Arguments", call.argsPreview));
  }
  if (call.outcome === "completed" && call.resultContent) {
    const matchesEl = renderSearchMatchesIfAny(
      call.name,
      call.resultContent,
      handlers,
    );
    if (matchesEl) {
      body.appendChild(matchesEl);
    } else {
      body.appendChild(makeLabeledPre("Result", call.resultContent));
    }
  }
  if (
    (call.outcome === "errored" || call.outcome === "denied") &&
    call.detail
  ) {
    body.appendChild(makeLabeledPre("Error", call.detail));
  }
  if (call.outcome === "approved") {
    const running = document.createElement("div");
    running.classList.add("copilot-agent-toolcall-running");
    running.textContent = "Running…";
    body.appendChild(running);
  }
  if (call.outcome === "pending_approval" && call.approval) {
    body.appendChild(renderApprovalPrompt(call, handlers));
  }

  wrapper.appendChild(body);
  return wrapper;
}

function renderApprovalPrompt(
  call: ToolCall,
  handlers: ToolCallBlockHandlers,
): HTMLElement {
  const wrap = document.createElement("div");
  wrap.classList.add("copilot-agent-toolcall-approval");

  const headline = document.createElement("div");
  headline.classList.add("copilot-agent-toolcall-approval-headline");
  headline.textContent =
    call.approval?.summary ?? "Approval required for this tool call.";
  wrap.appendChild(headline);

  if (call.approval?.detail) {
    const pre = document.createElement("pre");
    pre.classList.add("copilot-agent-toolcall-approval-detail");
    pre.textContent = truncate(call.approval.detail, 4000);
    wrap.appendChild(pre);
  }

  const helpText = document.createElement("div");
  helpText.classList.add("copilot-agent-toolcall-approval-help");
  helpText.textContent =
    "Approve runs this call once. " +
    "Approve for Session lets the assistant make similar calls without " +
    "asking again until you reload the plugin, clear the conversation, " +
    "or restart Obsidian.";
  wrap.appendChild(helpText);

  const buttons = document.createElement("div");
  buttons.classList.add("copilot-agent-toolcall-approval-buttons");

  buttons.appendChild(
    button("Approve Once", "copilot-agent-toolcall-approve", () =>
      handlers.onApprove?.(call.id),
    ),
  );
  if (call.approval?.canOfferSession !== false) {
    buttons.appendChild(
      button(
        "Approve for Session",
        "copilot-agent-toolcall-approve-session",
        () => handlers.onApproveForSession?.(call.id),
      ),
    );
  }
  buttons.appendChild(
    button("Reject", "copilot-agent-toolcall-reject", () =>
      handlers.onReject?.(call.id),
    ),
  );

  wrap.appendChild(buttons);
  return wrap;
}

function button(
  text: string,
  className: string,
  onClick: () => void,
): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.classList.add(className);
  b.textContent = text;
  b.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    onClick();
  });
  return b;
}

function makeLabeledPre(label: string, text: string): HTMLElement {
  const wrap = document.createElement("div");
  wrap.classList.add("copilot-agent-toolcall-section");
  const labelEl = document.createElement("div");
  labelEl.classList.add("copilot-agent-toolcall-section-label");
  labelEl.textContent = label;
  const pre = document.createElement("pre");
  pre.classList.add("copilot-agent-toolcall-section-content");
  pre.textContent = truncate(text, 4000);
  wrap.appendChild(labelEl);
  wrap.appendChild(pre);
  return wrap;
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}\n… (${s.length - max} more bytes)` : s;
}

function sourceIcon(source: ToolCall["source"]): string {
  switch (source) {
    case "custom":
      return "🛠";
    case "mcp":
      return "🔌";
    case "builtin":
      return "⚙";
    default:
      return "◆";
  }
}

function sourceLabelText(source: ToolCall["source"]): string {
  switch (source) {
    case "custom":
      return "custom";
    case "mcp":
      return "mcp";
    case "builtin":
      return "built-in";
    default:
      return "";
  }
}

function statusText(outcome: ToolCall["outcome"]): string {
  switch (outcome) {
    case "approved":
      return "running";
    case "completed":
      return "completed";
    case "errored":
      return "error";
    case "denied":
      return "denied";
    case "pending_approval":
      return "needs approval";
    default:
      return outcome;
  }
}

function renderSearchMatchesIfAny(
  toolName: string | undefined,
  resultJson: string,
  handlers: ToolCallBlockHandlers,
): HTMLElement | null {
  const shape = parseSearchToolResult(toolName, resultJson);
  if (!shape) return null;
  if (shape.kind === "matches") {
    return renderMatchList(shape.matches, shape.total, shape.truncated, handlers);
  }
  return renderTagList(shape.tags);
}

function renderMatchList(
  matches: SearchMatchView[],
  total: number,
  truncated: boolean,
  handlers: ToolCallBlockHandlers,
): HTMLElement {
  const wrap = document.createElement("div");
  wrap.classList.add(
    "copilot-agent-toolcall-section",
    "copilot-agent-search-results",
  );
  const labelEl = document.createElement("div");
  labelEl.classList.add("copilot-agent-toolcall-section-label");
  labelEl.textContent =
    matches.length === 0
      ? "No matching notes."
      : truncated
        ? `${matches.length} of ${total} matches (truncated)`
        : `${matches.length} match${matches.length === 1 ? "" : "es"}`;
  wrap.appendChild(labelEl);

  if (matches.length === 0) return wrap;

  const list = document.createElement("ul");
  list.classList.add("copilot-agent-search-list");
  for (const m of matches) {
    const li = document.createElement("li");
    li.classList.add("copilot-agent-search-item");
    const link = document.createElement("a");
    link.classList.add("copilot-agent-search-link");
    link.href = "#";
    link.textContent = m.displayName;
    link.title = m.path;
    link.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      handlers.onOpenLink?.(m.path);
    });
    li.appendChild(link);
    const pathHint = document.createElement("span");
    pathHint.classList.add("copilot-agent-search-path");
    pathHint.textContent = ` — ${m.path}`;
    li.appendChild(pathHint);
    list.appendChild(li);
  }
  wrap.appendChild(list);
  return wrap;
}

function renderTagList(
  tags: TagCountView[],
): HTMLElement {
  const wrap = document.createElement("div");
  wrap.classList.add(
    "copilot-agent-toolcall-section",
    "copilot-agent-search-results",
  );
  const labelEl = document.createElement("div");
  labelEl.classList.add("copilot-agent-toolcall-section-label");
  labelEl.textContent =
    tags.length === 0
      ? "No tags in vault."
      : `${tags.length} tag${tags.length === 1 ? "" : "s"}`;
  wrap.appendChild(labelEl);

  if (tags.length === 0) return wrap;

  const list = document.createElement("ul");
  list.classList.add("copilot-agent-search-list");
  for (const t of tags) {
    const li = document.createElement("li");
    li.classList.add("copilot-agent-search-item");
    const tagEl = document.createElement("span");
    tagEl.classList.add("copilot-agent-search-tag");
    tagEl.textContent = t.tag;
    li.appendChild(tagEl);
    const countEl = document.createElement("span");
    countEl.classList.add("copilot-agent-search-count");
    countEl.textContent = ` × ${t.count}`;
    li.appendChild(countEl);
    list.appendChild(li);
  }
  wrap.appendChild(list);
  return wrap;
}
