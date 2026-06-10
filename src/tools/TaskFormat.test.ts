import { describe, test, expect } from "vitest";
import {
  formatTaskLine,
  parseTaskLine,
  STRICT_DATE_REGEX,
  type TaskInput,
  type TaskFormatSource,
} from "./TaskFormat";

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

describe("formatTaskLine — status checkbox symbol", () => {
  test.each([
    ["todo", " "],
    ["in-progress", "/"],
    ["done", "x"],
    ["cancelled", "-"],
  ] as const)("status %s emits [%s]", (status, sym) => {
    expect(
      formatTaskLine({ description: "X", status }, "tasks-plugin"),
    ).toBe(`- [${sym}] X`);
    expect(formatTaskLine({ description: "X", status }, "gfm")).toBe(
      `- [${sym}] X`,
    );
  });

  test("completedDate emitted after createdDate, before tags", () => {
    expect(
      formatTaskLine(
        {
          description: "X",
          status: "done",
          createdDate: "2026-06-09",
          completedDate: "2026-06-11",
          tags: ["a"],
        },
        "tasks-plugin",
      ),
    ).toBe("- [x] X ➕ 2026-06-09 ✅ 2026-06-11 #a");
  });

  test("cancelledDate (gfm)", () => {
    expect(
      formatTaskLine(
        { description: "X", status: "cancelled", cancelledDate: "2026-06-11" },
        "gfm",
      ),
    ).toBe("- [-] X (cancelled: 2026-06-11)");
  });

  test("extras appended verbatim at end of line", () => {
    expect(
      formatTaskLine(
        {
          description: "Weekly review",
          dueDate: "2026-06-14",
          tags: ["weekly"],
          extras: "🔁 every Sunday ^abc123",
        },
        "tasks-plugin",
      ),
    ).toBe("- [ ] Weekly review 📅 2026-06-14 #weekly 🔁 every Sunday ^abc123");
  });
});

describe("parseTaskLine", () => {
  test("rejects non-task line", () => {
    expect(parseTaskLine("just text").ok).toBe(false);
    expect(parseTaskLine("- [?] unknown status").ok).toBe(false);
    expect(parseTaskLine("").ok).toBe(false);
  });

  test.each([
    [" ", "todo"],
    ["/", "in-progress"],
    ["x", "done"],
    ["X", "done"],
    ["-", "cancelled"],
  ] as const)("recognizes status symbol [%s] -> %s", (sym, status) => {
    const r = parseTaskLine(`- [${sym}] hello`);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.parsed.status).toBe(status);
      expect(r.parsed.description).toBe("hello");
      expect(r.parsed.rawStatusSymbol).toBe(sym);
    }
  });

  test("parses tasks-plugin flavor with all fields", () => {
    const r = parseTaskLine(
      "- [x] Ship it ⏫ 📅 2026-06-12 ⏳ 2026-06-10 ➕ 2026-06-09 ✅ 2026-06-11 #work #release",
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.parsed).toMatchObject({
      description: "Ship it",
      status: "done",
      priority: "high",
      dueDate: "2026-06-12",
      scheduledDate: "2026-06-10",
      createdDate: "2026-06-09",
      completedDate: "2026-06-11",
      tags: ["work", "release"],
      source: "tasks-plugin",
      extras: "",
    });
  });

  test("parses gfm flavor with all fields and tag", () => {
    const r = parseTaskLine(
      "- [ ] Buy milk (priority: medium) (due: 2026-06-12) #shopping",
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.parsed).toMatchObject({
      description: "Buy milk",
      status: "todo",
      priority: "medium",
      dueDate: "2026-06-12",
      tags: ["shopping"],
      source: "gfm",
    });
  });

  test("preserves leading indent for nested tasks", () => {
    const r = parseTaskLine("    - [ ] nested");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.parsed.leadingIndent).toBe("    ");
  });

  test("captures recurrence + block-id as extras", () => {
    const r = parseTaskLine(
      "- [ ] Weekly review 📅 2026-06-14 🔁 every Sunday ^abc123",
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.parsed.description).toBe("Weekly review");
    expect(r.parsed.dueDate).toBe("2026-06-14");
    expect(r.parsed.extras).toBe("🔁 every Sunday ^abc123");
  });

  test("captures unmodeled emoji (🛫 start) as extras", () => {
    const r = parseTaskLine("- [ ] task 🛫 2026-06-01");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.parsed.extras).toBe("🛫 2026-06-01");
  });
});

describe("round-trip parse-then-format (post-normalization)", () => {
  function normalize(input: TaskInput): TaskInput {
    const out: TaskInput = { ...input, description: (input.description ?? "").trim() };
    if (input.tags) {
      const sanitized: string[] = [];
      for (const t of input.tags) {
        if (typeof t !== "string") continue;
        const trimmed = t.trim().replace(/^#+/, "").replace(/\s+/g, "-");
        if (trimmed) sanitized.push(trimmed);
      }
      if (sanitized.length) out.tags = sanitized; else delete out.tags;
    }
    if (!out.status) out.status = "todo";
    return out;
  }

  const cases: Array<[TaskInput, TaskFormatSource]> = [
    [{ description: "Buy milk" }, "tasks-plugin"],
    [{ description: "Pay bill", dueDate: "2026-06-12" }, "tasks-plugin"],
    [{ description: "Ship it", status: "done", priority: "high", dueDate: "2026-06-12", completedDate: "2026-06-13", tags: ["release"] }, "tasks-plugin"],
    [{ description: "Buy milk", dueDate: "2026-06-12" }, "gfm"],
    [{ description: "Plan", status: "in-progress", scheduledDate: "2026-07-01", tags: ["plan"] }, "gfm"],
    [{ description: "Weekly", dueDate: "2026-06-14", extras: "🔁 every Sunday" }, "tasks-plugin"],
  ];

  test.each(cases)("normalize(input) == parse(format(input)) — case %#", (input, source) => {
    const formatted = formatTaskLine(input, source);
    const r = parseTaskLine(formatted);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const n = normalize(input);
    // Strip parsed-only fields before comparing.
    const { leadingIndent, source: parsedSource, rawStatusSymbol, ...rest } = r.parsed;
    void leadingIndent; void parsedSource; void rawStatusSymbol;
    // Compare extras explicitly (round-trip preserves them).
    if (!n.extras) {
      expect(rest.extras).toBe("");
    } else {
      expect(rest.extras).toBe(n.extras);
    }
    // Drop empty extras from comparison shape.
    const restWithoutEmpty: Record<string, unknown> = { ...rest };
    if (restWithoutEmpty.extras === "") delete restWithoutEmpty.extras;
    const expected: Record<string, unknown> = { ...n };
    if (!expected.extras) delete expected.extras;
    expect(restWithoutEmpty).toEqual(expected);
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
