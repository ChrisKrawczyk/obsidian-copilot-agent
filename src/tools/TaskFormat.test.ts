import { describe, test, expect } from "vitest";
import { formatTaskLine, STRICT_DATE_REGEX, type TaskInput } from "./TaskFormat";

describe("formatTaskLine — tasks-plugin source", () => {
  test("description only", () => {
    expect(formatTaskLine({ description: "Buy milk" }, "tasks-plugin")).toBe(
      "- [ ] Buy milk",
    );
  });

  test("trims surrounding whitespace from description", () => {
    expect(formatTaskLine({ description: "  Tidy desk  " }, "tasks-plugin")).toBe(
      "- [ ] Tidy desk",
    );
  });

  test("due date", () => {
    expect(
      formatTaskLine(
        { description: "Pay bill", dueDate: "2026-06-12" },
        "tasks-plugin",
      ),
    ).toBe("- [ ] Pay bill 📅 2026-06-12");
  });

  test("scheduled date", () => {
    expect(
      formatTaskLine(
        { description: "Plan trip", scheduledDate: "2026-07-01" },
        "tasks-plugin",
      ),
    ).toBe("- [ ] Plan trip ⏳ 2026-07-01");
  });

  test.each([
    ["high", "⏫"],
    ["medium", "🔼"],
    ["low", "🔽"],
  ] as const)("priority %s renders %s", (priority, emoji) => {
    expect(
      formatTaskLine({ description: "X", priority }, "tasks-plugin"),
    ).toBe(`- [ ] X ${emoji}`);
  });

  test("tags rendered with leading #, stripping existing #, deduping internal whitespace", () => {
    expect(
      formatTaskLine(
        { description: "X", tags: ["work", "#home", "two words"] },
        "tasks-plugin",
      ),
    ).toBe("- [ ] X #work #home #two-words");
  });

  test("stable ordering: priority before due before scheduled before created before tags", () => {
    expect(
      formatTaskLine(
        {
          description: "X",
          dueDate: "2026-06-12",
          scheduledDate: "2026-06-10",
          createdDate: "2026-06-09",
          priority: "high",
          tags: ["a", "b"],
        },
        "tasks-plugin",
      ),
    ).toBe("- [ ] X ⏫ 📅 2026-06-12 ⏳ 2026-06-10 ➕ 2026-06-09 #a #b");
  });

  test("created date alone (tasks-plugin)", () => {
    expect(
      formatTaskLine(
        { description: "Note this", createdDate: "2026-06-09" },
        "tasks-plugin",
      ),
    ).toBe("- [ ] Note this ➕ 2026-06-09");
  });
});

describe("formatTaskLine — gfm source", () => {
  test("description only", () => {
    expect(formatTaskLine({ description: "Buy milk" }, "gfm")).toBe(
      "- [ ] Buy milk",
    );
  });

  test("due date as inline-text metadata", () => {
    expect(
      formatTaskLine(
        { description: "Pay bill", dueDate: "2026-06-12" },
        "gfm",
      ),
    ).toBe("- [ ] Pay bill (due: 2026-06-12)");
  });

  test("scheduled date as inline-text metadata", () => {
    expect(
      formatTaskLine(
        { description: "X", scheduledDate: "2026-07-01" },
        "gfm",
      ),
    ).toBe("- [ ] X (scheduled: 2026-07-01)");
  });

  test("priority rendered as inline-text", () => {
    expect(
      formatTaskLine({ description: "X", priority: "high" }, "gfm"),
    ).toBe("- [ ] X (priority: high)");
  });

  test("all fields combined with stable ordering", () => {
    expect(
      formatTaskLine(
        {
          description: "Ship it",
          priority: "medium",
          dueDate: "2026-06-12",
          scheduledDate: "2026-06-10",
          createdDate: "2026-06-09",
          tags: ["release"],
        },
        "gfm",
      ),
    ).toBe(
      "- [ ] Ship it (priority: medium) (due: 2026-06-12) (scheduled: 2026-06-10) (created: 2026-06-09) #release",
    );
  });

  test("created date alone (gfm)", () => {
    expect(
      formatTaskLine(
        { description: "Note this", createdDate: "2026-06-09" },
        "gfm",
      ),
    ).toBe("- [ ] Note this (created: 2026-06-09)");
  });
});

describe("STRICT_DATE_REGEX", () => {
  test.each([
    "2026-06-12",
    "2000-01-01",
    "9999-12-31",
  ])("accepts valid date %s", (d) => {
    expect(STRICT_DATE_REGEX.test(d)).toBe(true);
  });

  test.each([
    "Friday",
    "tomorrow",
    "next week",
    "2026-6-12",   // unpadded month
    "06-12-2026",  // wrong order
    "2026/06/12",  // wrong separator
    "",
  ])("rejects non-strict date %s", (d) => {
    expect(STRICT_DATE_REGEX.test(d)).toBe(false);
  });
});

describe("type guard sanity (compile-time only)", () => {
  test("TaskInput compiles", () => {
    const t: TaskInput = { description: "x" };
    expect(t.description).toBe("x");
  });
});
