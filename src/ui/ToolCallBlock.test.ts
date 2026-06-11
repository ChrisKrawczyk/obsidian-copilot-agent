/**
 * @vitest-environment jsdom
 */
import { describe, expect, test, vi } from "vitest";
import { renderToolCallBlock } from "./ToolCallBlock";
import type { ToolCall } from "../domain/types";

/**
 * v0.3 Phase 6 (FR-016): the renderer must hide the Undo button when
 * the chat view says the tool call is suppressed (raw-FS tool + user
 * opted out of exposeRawFsTools). The rest of the block (name,
 * status, args, result) MUST continue to render so historical context
 * survives a setting toggle.
 */

function call(overrides: Partial<ToolCall> = {}): ToolCall {
  return {
    id: "tc-1",
    kind: "write",
    name: "write_note",
    outcome: "completed",
    undoId: "undo-1",
    undone: false,
    ...overrides,
  } as ToolCall;
}

describe("renderToolCallBlock — Undo suppression (FR-016)", () => {
  test("renders Undo button when isUndoSuppressed is omitted", () => {
    const onUndo = vi.fn();
    const el = renderToolCallBlock(call(), { onUndo });
    const btn = el.querySelector("button.copilot-agent-toolcall-undo");
    expect(btn).not.toBeNull();
  });

  test("renders Undo button when isUndoSuppressed returns false", () => {
    const onUndo = vi.fn();
    const el = renderToolCallBlock(call(), {
      onUndo,
      isUndoSuppressed: () => false,
    });
    expect(el.querySelector("button.copilot-agent-toolcall-undo")).not.toBeNull();
  });

  test("suppresses Undo button when isUndoSuppressed returns true", () => {
    const onUndo = vi.fn();
    const el = renderToolCallBlock(call({ name: "write_file" }), {
      onUndo,
      isUndoSuppressed: (n) => n === "write_file",
    });
    expect(el.querySelector("button.copilot-agent-toolcall-undo")).toBeNull();
    // Name still rendered.
    expect(
      el.querySelector(".copilot-agent-toolcall-name")?.textContent,
    ).toBe("write_file");
    // Status pill still rendered.
    expect(el.querySelector(".copilot-agent-toolcall-status")).not.toBeNull();
  });

  test("predicate receives the tool name verbatim", () => {
    const predicate = vi.fn().mockReturnValue(false);
    renderToolCallBlock(call({ name: "delete_file" }), {
      onUndo: vi.fn(),
      isUndoSuppressed: predicate,
    });
    expect(predicate).toHaveBeenCalledWith("delete_file");
  });

  test("suppression does NOT hide the 'reverted' pill on already-undone calls", () => {
    const el = renderToolCallBlock(call({ undone: true, name: "write_file" }), {
      onUndo: vi.fn(),
      isUndoSuppressed: () => true,
    });
    expect(el.querySelector(".copilot-agent-toolcall-undone")).not.toBeNull();
  });
});
