import { describe, expect, test, vi } from "vitest";
import { shouldRenderUndoButton } from "./ToolCallBlock";
import type { ToolCall } from "../domain/types";

/**
 * v0.3 Phase 6 (FR-016): unit-tests for the pure suppression decision
 * helper. The rendering layer (renderToolCallBlock) wires this and
 * adds/skips the DOM button accordingly; we keep this file DOM-free
 * per project test policy (`.github/copilot-instructions.md`).
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

describe("shouldRenderUndoButton — Undo suppression (FR-016)", () => {
  test("renders Undo when isUndoSuppressed is omitted", () => {
    expect(shouldRenderUndoButton(call(), { onUndo: vi.fn() })).toBe(true);
  });

  test("renders Undo when isUndoSuppressed returns false", () => {
    expect(
      shouldRenderUndoButton(call(), {
        onUndo: vi.fn(),
        isUndoSuppressed: () => false,
      }),
    ).toBe(true);
  });

  test("suppresses Undo when isUndoSuppressed returns true", () => {
    expect(
      shouldRenderUndoButton(call({ name: "write_file" }), {
        onUndo: vi.fn(),
        isUndoSuppressed: (n) => n === "write_file",
      }),
    ).toBe(false);
  });

  test("predicate receives the tool name verbatim", () => {
    const predicate = vi.fn().mockReturnValue(false);
    shouldRenderUndoButton(call({ name: "delete_file" }), {
      onUndo: vi.fn(),
      isUndoSuppressed: predicate,
    });
    expect(predicate).toHaveBeenCalledWith("delete_file");
  });

  test("does NOT call predicate when call has no name (defensive)", () => {
    const predicate = vi.fn().mockReturnValue(true);
    const result = shouldRenderUndoButton(
      call({ name: undefined }),
      { onUndo: vi.fn(), isUndoSuppressed: predicate },
    );
    expect(predicate).not.toHaveBeenCalled();
    expect(result).toBe(true);
  });

  test("already-undone calls never show Undo regardless of suppression", () => {
    expect(
      shouldRenderUndoButton(call({ undone: true }), {
        onUndo: vi.fn(),
        isUndoSuppressed: () => false,
      }),
    ).toBe(false);
  });

  test("non-completed outcomes never show Undo", () => {
    expect(
      shouldRenderUndoButton(call({ outcome: "pending_approval" }), {
        onUndo: vi.fn(),
      }),
    ).toBe(false);
  });

  test("missing onUndo handler hides Undo", () => {
    expect(shouldRenderUndoButton(call(), {})).toBe(false);
  });
});
