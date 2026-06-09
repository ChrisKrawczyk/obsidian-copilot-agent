import type { ToolCall } from "../domain/types";

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
 */
export function renderToolCallBlock(call: ToolCall): HTMLElement {
  const wrapper = document.createElement("details");
  wrapper.classList.add(
    "copilot-agent-toolcall",
    `copilot-agent-toolcall-${call.outcome}`,
    `copilot-agent-toolcall-source-${call.source ?? "unknown"}`,
  );

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

  wrapper.appendChild(summary);

  // Body — args, result, error (when present).
  const body = document.createElement("div");
  body.classList.add("copilot-agent-toolcall-body");

  if (call.argsPreview) {
    body.appendChild(makeLabeledPre("Arguments", call.argsPreview));
  }
  if (call.outcome === "completed" && call.resultContent) {
    body.appendChild(makeLabeledPre("Result", call.resultContent));
  }
  if (
    (call.outcome === "errored" || call.outcome === "denied") &&
    call.detail
  ) {
    body.appendChild(makeLabeledPre("Error", call.detail));
  }
  if (call.outcome === "approved") {
    // Approved but not yet completed (running): give a subtle hint.
    const running = document.createElement("div");
    running.classList.add("copilot-agent-toolcall-running");
    running.textContent = "Running…";
    body.appendChild(running);
  }

  wrapper.appendChild(body);
  return wrapper;
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
    default:
      return outcome;
  }
}
