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
});

// Imported lazily for the cast in the snapshot test only.
import type { Message } from "./types";
