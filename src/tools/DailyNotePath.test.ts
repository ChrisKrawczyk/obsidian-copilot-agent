import { describe, test, expect } from "vitest";
import {
  formatDailyNoteName,
  resolveDailyNotePath,
} from "./DailyNotePath";
import { ObsidianApi, type AppLike } from "./ObsidianApi";

function makeApi(opts: { folder?: string; format?: string; enabled: boolean }): ObsidianApi {
  const app: AppLike = {
    vault: {} as unknown as AppLike["vault"],
    internalPlugins: opts.enabled
      ? {
          plugins: {
            "daily-notes": {
              instance: { options: { folder: opts.folder, format: opts.format } },
            },
          },
        }
      : { plugins: {} },
  };
  return new ObsidianApi(app);
}

describe("formatDailyNoteName", () => {
  const day = new Date(2026, 5, 9); // 2026-06-09 local time

  test("default YYYY-MM-DD when format is empty", () => {
    expect(formatDailyNoteName(day)).toBe("2026-06-09");
    expect(formatDailyNoteName(day, "")).toBe("2026-06-09");
    expect(formatDailyNoteName(day, "   ")).toBe("2026-06-09");
  });

  test("supports YYYY/MM/DD", () => {
    expect(formatDailyNoteName(day, "YYYY/MM/DD")).toBe("2026/06/09");
  });

  test("supports YY and unpadded M D", () => {
    expect(formatDailyNoteName(day, "YY-M-D")).toBe("26-6-9");
  });

  test("supports moment.js literal-escape brackets", () => {
    expect(formatDailyNoteName(day, "[Daily ]YYYY-MM-DD")).toBe(
      "Daily 2026-06-09",
    );
  });

  test("unterminated literal bracket falls through", () => {
    // Treat the unterminated tail as a format segment so we still get tokens.
    expect(formatDailyNoteName(day, "[oops")).toBe("[oops");
  });

  test("empty result falls back to YYYY-MM-DD", () => {
    expect(formatDailyNoteName(day, "[]")).toBe("2026-06-09");
  });
});

describe("resolveDailyNotePath", () => {
  const day = new Date(2026, 5, 9);

  test("plugin disabled → fallback to YYYY-MM-DD.md at root", () => {
    const r = resolveDailyNotePath(makeApi({ enabled: false }), day);
    expect(r).toEqual({ path: "2026-06-09.md", source: "fallback" });
  });

  test("plugin enabled, no folder → root + formatted name", () => {
    const r = resolveDailyNotePath(makeApi({ enabled: true }), day);
    expect(r.source).toBe("plugin-config");
    expect(r.path).toBe("2026-06-09.md");
  });

  test("plugin enabled with folder → folder/format.md", () => {
    const r = resolveDailyNotePath(
      makeApi({ enabled: true, folder: "Journal", format: "YYYY/MM-DD" }),
      day,
    );
    expect(r.source).toBe("plugin-config");
    expect(r.path).toBe("Journal/2026/06-09.md");
  });

  test("strips leading/trailing slashes from folder", () => {
    const r = resolveDailyNotePath(
      makeApi({ enabled: true, folder: "/Journal/" }),
      day,
    );
    expect(r.path).toBe("Journal/2026-06-09.md");
  });

  test("invalid filename format (empty) falls back to YYYY-MM-DD", () => {
    const r = resolveDailyNotePath(
      makeApi({ enabled: true, folder: "J", format: "[]" }),
      day,
    );
    expect(r.path).toBe("J/2026-06-09.md");
  });
});

describe("formatDailyNoteName — final-review F14 (unsupported tokens)", () => {
  const day = new Date(2026, 5, 9, 14, 37, 12);

  test("falls back to YYYY-MM-DD when format contains MMM", () => {
    const warns: string[] = [];
    const orig = console.warn;
    console.warn = (m: unknown) => { warns.push(String(m)); };
    try {
      expect(formatDailyNoteName(day, "YYYY-MMM-DD")).toBe("2026-06-09");
    } finally {
      console.warn = orig;
    }
    expect(warns.length).toBe(1);
    expect(warns[0]).toMatch(/MMM/);
  });

  test("falls back to YYYY-MM-DD when format contains HH:mm time tokens", () => {
    const orig = console.warn;
    console.warn = () => {};
    try {
      expect(formatDailyNoteName(day, "YYYY-MM-DD HH:mm")).toBe("2026-06-09");
    } finally {
      console.warn = orig;
    }
  });

  test("supported tokens still format normally (no warn, no fallback)", () => {
    const warns: string[] = [];
    const orig = console.warn;
    console.warn = (m: unknown) => { warns.push(String(m)); };
    try {
      expect(formatDailyNoteName(day, "YYYY/MM/DD")).toBe("2026/06/09");
    } finally {
      console.warn = orig;
    }
    expect(warns).toEqual([]);
  });
});