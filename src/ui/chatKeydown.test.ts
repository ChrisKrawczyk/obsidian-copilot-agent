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

  it("Ctrl/Cmd+Enter submits like Enter when idle", () => {
    expect(decideKeydownAction(snapshot({ modKey: true }))).toBe("submit");
  });

  it("Shift+Enter beats streaming guard (newline still works while a stream is in flight)", () => {
    expect(
      decideKeydownAction(snapshot({ shiftKey: true, isStreaming: true })),
    ).toBe("newline");
  });

  describe("follow-ups while streaming", () => {
    const live = { isStreaming: true, canFollowUp: true };

    it("Enter steers and Ctrl/Cmd+Enter queues", () => {
      expect(decideKeydownAction(snapshot(live))).toBe("steer");
      expect(decideKeydownAction(snapshot({ ...live, modKey: true }))).toBe("queue");
    });

    it("stays inert when follow-ups are not allowed, input is empty, or disconnected", () => {
      expect(decideKeydownAction(snapshot({ ...live, canFollowUp: false }))).toBe(
        "noop-prevent",
      );
      expect(decideKeydownAction(snapshot({ ...live, hasText: false }))).toBe(
        "noop-prevent",
      );
      expect(decideKeydownAction(snapshot({ ...live, isConnected: false }))).toBe(
        "noop-prevent",
      );
    });

    it("IME composition still passes through", () => {
      expect(decideKeydownAction(snapshot({ ...live, isComposing: true }))).toBe(
        "passthrough",
      );
    });

    it("ArrowUp in an empty composer retracts when something is retractable", () => {
      const up = { key: "ArrowUp", keyCode: 38, hasText: false, canRetract: true };
      expect(decideKeydownAction(snapshot(up))).toBe("retract");
      expect(decideKeydownAction(snapshot({ ...up, hasText: true }))).toBe("passthrough");
      expect(decideKeydownAction(snapshot({ ...up, canRetract: false }))).toBe(
        "passthrough",
      );
      expect(decideKeydownAction(snapshot({ ...up, shiftKey: true }))).toBe("passthrough");
    });
  });
});
