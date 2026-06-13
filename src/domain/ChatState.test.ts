import { describe, expect, test, vi } from "vitest";
import { ChatState } from "./ChatState";

describe("ChatState", () => {
  test("starts empty", () => {
    const s = new ChatState();
    expect(s.getMessages()).toEqual([]);
  });

  test("appends preserve insertion order and assign unique ids", () => {
    const s = new ChatState();
    const a = s.append({ role: "user", content: "hi" });
    const b = s.append({ role: "assistant", content: "hello" });
    expect(a).not.toEqual(b);
    const msgs = s.getMessages();
    expect(msgs).toHaveLength(2);
    expect(msgs[0].role).toBe("user");
    expect(msgs[0].content).toBe("hi");
    expect(msgs[0].status).toBe("complete");
    expect(msgs[1].role).toBe("assistant");
    expect(msgs[1].id).toBe(b);
  });

  test("update patches existing message and ignores unknown ids", () => {
    const s = new ChatState();
    const id = s.append({
      role: "assistant",
      content: "thinking",
      status: "pending",
    });
    s.update(id, { content: "done", status: "complete" });
    const m = s.getMessages()[0];
    expect(m.content).toBe("done");
    expect(m.status).toBe("complete");
    expect(m.id).toBe(id); // id preserved

    s.update("nope", { content: "x" });
    expect(s.getMessages()[0].content).toBe("done");
  });

  test("update preserves createdAt", () => {
    const s = new ChatState();
    const id = s.append({ role: "user", content: "a" });
    const original = s.getMessages()[0].createdAt;
    s.update(id, { content: "b" });
    expect(s.getMessages()[0].createdAt).toBe(original);
  });

  test("clear removes all messages and notifies once", () => {
    const s = new ChatState();
    s.append({ role: "user", content: "a" });
    s.append({ role: "user", content: "b" });
    const listener = vi.fn();
    s.subscribe(listener);
    s.clear();
    expect(s.getMessages()).toEqual([]);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  test("clear on empty state is a no-op (no listener fire)", () => {
    const s = new ChatState();
    const listener = vi.fn();
    s.subscribe(listener);
    s.clear();
    expect(listener).not.toHaveBeenCalled();
  });

  test("subscribe → unsubscribe stops emissions", () => {
    const s = new ChatState();
    const listener = vi.fn();
    const off = s.subscribe(listener);
    s.append({ role: "user", content: "a" });
    expect(listener).toHaveBeenCalledTimes(1);
    off();
    s.append({ role: "user", content: "b" });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  test("listener that throws does not break others", () => {
    const s = new ChatState();
    const bad = vi.fn(() => {
      throw new Error("boom");
    });
    const good = vi.fn();
    s.subscribe(bad);
    s.subscribe(good);
    // Suppress console.error noise during the test.
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    s.append({ role: "user", content: "x" });
    expect(bad).toHaveBeenCalledTimes(1);
    expect(good).toHaveBeenCalledTimes(1);
    errSpy.mockRestore();
  });

  test("getMessages returns a snapshot copy (mutation-safe)", () => {
    const s = new ChatState();
    s.append({ role: "user", content: "a" });
    const snapshot = s.getMessages();
    (snapshot as Message[]).pop();
    expect(s.getMessages()).toHaveLength(1);
  });

  test("appendDelta accumulates chunks and flips status to streaming", () => {
    const s = new ChatState();
    const id = s.append({ role: "assistant", content: "", status: "pending" });
    const listener = vi.fn();
    s.subscribe(listener);

    expect(s.appendDelta(id, "Hel")).toBe(true);
    expect(s.appendDelta(id, "lo")).toBe(true);
    expect(s.appendDelta(id, " world")).toBe(true);

    const m = s.getMessages()[0];
    expect(m.content).toBe("Hello world");
    expect(m.status).toBe("streaming");
    // One emission per applied delta.
    expect(listener).toHaveBeenCalledTimes(3);
  });

  test("update to complete after streaming locks final content", () => {
    const s = new ChatState();
    const id = s.append({ role: "assistant", content: "", status: "pending" });
    s.appendDelta(id, "partial");
    s.update(id, { content: "final response", status: "complete" });

    const m = s.getMessages()[0];
    expect(m.status).toBe("complete");
    expect(m.content).toBe("final response");

    // Further deltas after `complete` must NOT mutate the message.
    expect(s.appendDelta(id, " extra")).toBe(false);
    expect(s.getMessages()[0].content).toBe("final response");
    expect(s.getMessages()[0].status).toBe("complete");
  });

  test("interruptStreaming freezes partial content and blocks further deltas", () => {
    const s = new ChatState();
    const id = s.append({ role: "assistant", content: "", status: "pending" });
    s.appendDelta(id, "Hello, this is half a ");
    expect(s.interruptStreaming(id)).toBe(true);

    const m = s.getMessages()[0];
    expect(m.status).toBe("interrupted");
    expect(m.content).toBe("Hello, this is half a ");

    // Late-arriving deltas after interrupt are ignored.
    expect(s.appendDelta(id, "sentence")).toBe(false);
    expect(s.getMessages()[0].content).toBe("Hello, this is half a ");

    // Double-interrupt is a no-op.
    expect(s.interruptStreaming(id)).toBe(false);
  });

  test("appendDelta is a no-op for unknown ids, empty text, or terminal states", () => {
    const s = new ChatState();
    expect(s.appendDelta("missing", "x")).toBe(false);

    const id = s.append({ role: "assistant", content: "", status: "pending" });
    expect(s.appendDelta(id, "")).toBe(false);

    s.update(id, { status: "error", content: "oops" });
    expect(s.appendDelta(id, " more")).toBe(false);
    expect(s.getMessages()[0].content).toBe("oops");
  });
});

// Imported lazily for the cast in the snapshot test only.
import type { Message } from "./types";

describe("ChatState - upsertToolCall (Phase 5)", () => {
  test("upsertToolCall appends a new tool call to the message", () => {
    const s = new ChatState();
    const id = s.append({ role: "assistant", content: "", status: "pending" });
    expect(
      s.upsertToolCall(id, {
        id: "tc-1",
        kind: "tool",
        name: "read_file",
        source: "custom",
        outcome: "approved",
        argsPreview: "{}",
      }),
    ).toBe(true);
    const m = s.getMessages()[0];
    expect(m.toolCalls).toHaveLength(1);
    expect(m.toolCalls![0]).toMatchObject({
      id: "tc-1",
      outcome: "approved",
      source: "custom",
    });
  });

  test("upsertToolCall merges fields when the id already exists", () => {
    const s = new ChatState();
    const id = s.append({ role: "assistant", content: "", status: "pending" });
    s.upsertToolCall(id, {
      id: "tc-1",
      kind: "tool",
      name: "read_file",
      source: "custom",
      outcome: "approved",
      argsPreview: '{"path":"x"}',
    });
    s.upsertToolCall(id, {
      id: "tc-1",
      kind: "tool",
      outcome: "completed",
      resultContent: "file contents",
    });
    const m = s.getMessages()[0];
    expect(m.toolCalls).toHaveLength(1);
    expect(m.toolCalls![0]).toMatchObject({
      id: "tc-1",
      name: "read_file",
      outcome: "completed",
      source: "custom",
      argsPreview: '{"path":"x"}',
      resultContent: "file contents",
    });
  });

  test("upsertToolCall returns false when the message id is unknown", () => {
    const s = new ChatState();
    expect(
      s.upsertToolCall("nope", {
        id: "tc-1",
        kind: "tool",
        outcome: "approved",
      }),
    ).toBe(false);
  });

  // v0.4 FR-005: interruptStreamingMessage — id-less variant used by
  // ConversationRuntime.setModelId before SDK abort.
  test("interruptStreamingMessage freezes the first streaming/pending message and returns its id", () => {
    const s = new ChatState();
    s.append({ role: "user", content: "u1", status: "complete" });
    const placeholderId = s.append({
      role: "assistant",
      content: "partial",
      status: "streaming",
    });
    const ret = s.interruptStreamingMessage();
    expect(ret).toBe(placeholderId);
    const msgs = s.getMessages();
    expect(msgs[1].status).toBe("interrupted");
    // Idempotent: second call returns null because nothing is live.
    expect(s.interruptStreamingMessage()).toBeNull();
  });

  test("interruptStreamingMessage returns null when nothing is streaming or pending", () => {
    const s = new ChatState();
    s.append({ role: "user", content: "u1", status: "complete" });
    s.append({ role: "assistant", content: "a1", status: "complete" });
    expect(s.interruptStreamingMessage()).toBeNull();
  });
});
