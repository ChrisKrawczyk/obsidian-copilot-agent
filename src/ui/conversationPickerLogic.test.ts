import { describe, expect, test } from "vitest";
import {
  buildPickerItems,
  PICKER_NAME_MAX_CHARS,
  suffixDisambiguatedName,
  truncateLabel,
  wouldTriggerArchiveOnCreate,
} from "./conversationPickerLogic";
import type { Conversation } from "../domain/Conversation";

function conv(
  id: string,
  overrides: Partial<Conversation> = {},
): Conversation {
  return {
    id,
    name: id,
    createdAt: 1,
    lastActiveAt: 1,
    ...overrides,
  };
}

describe("buildPickerItems — sorting (FR-003)", () => {
  test("orders by lastActiveAt descending", () => {
    const items = buildPickerItems(
      [
        conv("a", { name: "A", lastActiveAt: 10 }),
        conv("b", { name: "B", lastActiveAt: 30 }),
        conv("c", { name: "C", lastActiveAt: 20 }),
      ],
      null,
    );
    expect(items.map((i) => i.id)).toEqual(["b", "c", "a"]);
  });

  test("breaks ties on createdAt descending (newer first)", () => {
    const items = buildPickerItems(
      [
        conv("a", { lastActiveAt: 10, createdAt: 1 }),
        conv("b", { lastActiveAt: 10, createdAt: 5 }),
        conv("c", { lastActiveAt: 10, createdAt: 3 }),
      ],
      null,
    );
    expect(items.map((i) => i.id)).toEqual(["b", "c", "a"]);
  });

  test("excludes archived conversations (FR-020)", () => {
    const items = buildPickerItems(
      [
        conv("a", { lastActiveAt: 10 }),
        conv("b", { lastActiveAt: 20, archived: true }),
        conv("c", { lastActiveAt: 5 }),
      ],
      null,
    );
    expect(items.map((i) => i.id)).toEqual(["a", "c"]);
  });

  test("flags the active item", () => {
    const items = buildPickerItems(
      [conv("a"), conv("b"), conv("c")],
      "b",
    );
    expect(items.find((i) => i.id === "b")?.isActive).toBe(true);
    expect(items.find((i) => i.id === "a")?.isActive).toBe(false);
  });

  test("doesn't mutate the input array", () => {
    const input = [
      conv("a", { lastActiveAt: 10 }),
      conv("b", { lastActiveAt: 30 }),
    ];
    const before = [...input];
    buildPickerItems(input, null);
    expect(input).toEqual(before);
  });
});

describe("truncateLabel", () => {
  test("leaves short names unchanged", () => {
    expect(truncateLabel("Short")).toBe("Short");
  });

  test("truncates with ellipsis at PICKER_NAME_MAX_CHARS", () => {
    const long = "x".repeat(PICKER_NAME_MAX_CHARS + 10);
    const out = truncateLabel(long);
    expect(Array.from(out)).toHaveLength(PICKER_NAME_MAX_CHARS);
    expect(out.endsWith("…")).toBe(true);
  });

  test("counts a 4-byte emoji as one character (Array.from split)", () => {
    // `🎯` is a surrogate pair in UTF-16. A naive substring would split
    // it; Array.from + slice avoids that.
    const name = "🎯".repeat(PICKER_NAME_MAX_CHARS); // exactly cap chars
    const out = truncateLabel(name);
    expect(out).toBe(name); // no truncation at exactly cap
    const longer = "🎯".repeat(PICKER_NAME_MAX_CHARS + 1);
    const out2 = truncateLabel(longer);
    expect(Array.from(out2)).toHaveLength(PICKER_NAME_MAX_CHARS);
    expect(out2.endsWith("…")).toBe(true);
  });

  test("respects custom max", () => {
    expect(truncateLabel("abcdef", 4)).toBe("abc…");
  });
});

describe("suffixDisambiguatedName (FR-005)", () => {
  test("returns trimmed name when no collision", () => {
    expect(
      suffixDisambiguatedName("My chat", [conv("x", { name: "Other" })], null),
    ).toBe("My chat");
  });

  test("appends ' 2' on first collision, then ' 3', …", () => {
    const existing = [
      conv("a", { name: "Chat" }),
      conv("b", { name: "Chat 2" }),
    ];
    expect(suffixDisambiguatedName("Chat", existing, null)).toBe("Chat 3");
  });

  test("excludeId lets rename-to-self keep the same name", () => {
    const existing = [conv("a", { name: "Chat" })];
    expect(suffixDisambiguatedName("Chat", existing, "a")).toBe("Chat");
  });

  test("falls back to 'New conversation' when seed is empty/whitespace", () => {
    expect(suffixDisambiguatedName("   ", [], null)).toBe("New conversation");
  });

  test("strips surrounding whitespace before comparing", () => {
    const existing = [conv("a", { name: "Chat" })];
    expect(suffixDisambiguatedName("  Chat  ", existing, null)).toBe("Chat 2");
  });
});

describe("wouldTriggerArchiveOnCreate (FR-002)", () => {
  test("false when active count + 1 ≤ cap", () => {
    const list = Array.from({ length: 10 }, (_, i) => conv(`c${i}`));
    expect(wouldTriggerArchiveOnCreate(list, 20)).toBe(false);
  });

  test("true when active count + 1 > cap", () => {
    const list = Array.from({ length: 20 }, (_, i) => conv(`c${i}`));
    expect(wouldTriggerArchiveOnCreate(list, 20)).toBe(true);
  });

  test("ignores archived conversations in the count", () => {
    const list = [
      ...Array.from({ length: 18 }, (_, i) => conv(`a${i}`)),
      ...Array.from({ length: 5 }, (_, i) =>
        conv(`z${i}`, { archived: true }),
      ),
    ];
    // 18 active + 1 = 19 ≤ 20
    expect(wouldTriggerArchiveOnCreate(list, 20)).toBe(false);
  });
});
