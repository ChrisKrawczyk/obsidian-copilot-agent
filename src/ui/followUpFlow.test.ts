import { describe, expect, it } from "vitest";
import { ChatState } from "../domain/ChatState";
import { splitTurnAtFollowUp } from "./followUpFlow";

function shape(state: ChatState) {
  return state.getMessages().map((m) => ({
    role: m.role,
    content: m.content,
    status: m.status,
  }));
}

describe("splitTurnAtFollowUp", () => {
  it("finalizes a segment with text and opens a new placeholder after the user message", () => {
    const state = new ChatState();
    state.append({ role: "user", content: "first" });
    const ph = state.append({ role: "assistant", content: "", status: "pending" });
    state.appendDelta(ph, "Draft streamed");

    const split = splitTurnAtFollowUp(state, ph, "make it shorter", "Draft final");

    expect(split.converted).toBe(false);
    expect(shape(state)).toEqual([
      { role: "user", content: "first", status: "complete" },
      { role: "assistant", content: "Draft final", status: "complete" },
      { role: "user", content: "make it shorter", status: "complete" },
      { role: "assistant", content: "", status: "pending" },
    ]);
    expect(state.getMessages()[3].id).toBe(split.nextPlaceholderId);
    expect(state.getMessages()[2].id).toBe(split.userMessageId);
  });

  it("keeps streamed text when the SDK gave no final segment content", () => {
    const state = new ChatState();
    const ph = state.append({ role: "assistant", content: "", status: "pending" });
    state.appendDelta(ph, "partial");

    splitTurnAtFollowUp(state, ph, "steer", undefined);

    expect(state.getMessages()[0]).toMatchObject({ content: "partial", status: "complete" });
  });

  it("converts an empty placeholder into the user message", () => {
    const state = new ChatState();
    state.append({ role: "user", content: "first" });
    const ph = state.append({ role: "assistant", content: "", status: "pending" });

    const split = splitTurnAtFollowUp(state, ph, "queued next", undefined);

    expect(split).toMatchObject({ converted: true, userMessageId: ph });
    expect(shape(state)).toEqual([
      { role: "user", content: "first", status: "complete" },
      { role: "user", content: "queued next", status: "complete" },
      { role: "assistant", content: "", status: "pending" },
    ]);
  });

  it("does not convert a placeholder that only has tool calls", () => {
    const state = new ChatState();
    const ph = state.append({ role: "assistant", content: "", status: "pending" });
    state.upsertToolCall(ph, { id: "t1", kind: "tool", outcome: "completed" });

    const split = splitTurnAtFollowUp(state, ph, "steer", undefined);

    expect(split.converted).toBe(false);
    expect(state.getMessages().map((m) => m.role)).toEqual(["assistant", "user", "assistant"]);
  });
});
