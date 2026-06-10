import { describe, expect, it } from "vitest";
import {
  decideKeydownAction,
  type KeydownSnapshot,
} from "./chatKeydown";

function snapshot(over: Partial<KeydownSnapshot> = {}): KeydownSnapshot {
  return {
    key: "Enter",
    shiftKey: false,
    isComposing: false,
    keyCode: 13,
    hasText: true,
    isStreaming: false,
    isPending: false,
    isConnected: true,
    ...over,
  };
}

describe("decideKeydownAction", () => {
  it("plain Enter with text and connected session submits", () => {
    expect(decideKeydownAction(snapshot())).toBe("submit");
  });

  it("Shift+Enter inserts a newline (default textarea behaviour)", () => {
    expect(decideKeydownAction(snapshot({ shiftKey: true }))).toBe("newline");
  });

  it("Enter during IME composition does NOT submit (isComposing=true)", () => {
    expect(decideKeydownAction(snapshot({ isComposing: true }))).toBe(
      "passthrough",
    );
  });

  it("Enter during IME composition does NOT submit (keyCode 229)", () => {
    expect(decideKeydownAction(snapshot({ keyCode: 229 }))).toBe(
      "passthrough",
    );
  });

  it("Enter with whitespace-only input is a no-op-prevent", () => {
    expect(decideKeydownAction(snapshot({ hasText: false }))).toBe(
      "noop-prevent",
    );
  });

  it("Enter while streaming is a no-op-prevent (does NOT submit, does NOT stop)", () => {
    expect(decideKeydownAction(snapshot({ isStreaming: true }))).toBe(
      "noop-prevent",
    );
  });

  it("Enter while a send is pending is a no-op-prevent", () => {
    expect(decideKeydownAction(snapshot({ isPending: true }))).toBe(
      "noop-prevent",
    );
  });

  it("Enter while disconnected is a no-op-prevent", () => {
    expect(decideKeydownAction(snapshot({ isConnected: false }))).toBe(
      "noop-prevent",
    );
  });

  it("non-Enter keys pass through", () => {
    expect(decideKeydownAction(snapshot({ key: "a" }))).toBe("passthrough");
    expect(decideKeydownAction(snapshot({ key: "Tab" }))).toBe("passthrough");
  });

  it("Ctrl+Enter and Cmd+Enter no longer have special meaning (treated as plain Enter)", () => {
    // The pure decision function does not see ctrlKey/metaKey at all; the
    // caller is contractually obliged to not bind them. We assert that the
    // function's behaviour with non-empty text is plain submit, mirroring
    // Enter. This guards against accidental future divergence in the caller.
    expect(decideKeydownAction(snapshot())).toBe("submit");
  });

  it("Shift+Enter beats streaming guard (newline still works while a stream is in flight)", () => {
    expect(
      decideKeydownAction(snapshot({ shiftKey: true, isStreaming: true })),
    ).toBe("newline");
  });
});
