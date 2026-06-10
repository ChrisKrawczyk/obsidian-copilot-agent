import { describe, expect, test } from "vitest";
import { formatTodayInTimezone } from "./formatToday";

describe("formatTodayInTimezone", () => {
  test("formats a fixed UTC instant as the local date in the requested IANA zone", () => {
    // 2025-01-01T05:00:00Z is 2025-01-01 in UTC/Asia/Tokyo but 2024-12-31
    // 21:00 in America/Los_Angeles (UTC-8 standard time). Guarantees the
    // formatter is actually consulting the timezone rather than slicing
    // toISOString().
    const instant = new Date("2025-01-01T05:00:00Z");
    expect(formatTodayInTimezone(instant, "UTC")).toBe("2025-01-01");
    expect(formatTodayInTimezone(instant, "Asia/Tokyo")).toBe("2025-01-01");
    expect(formatTodayInTimezone(instant, "America/Los_Angeles")).toBe(
      "2024-12-31",
    );
  });

  test("produces zero-padded YYYY-MM-DD even for single-digit month/day", () => {
    const instant = new Date("2025-03-05T12:00:00Z");
    expect(formatTodayInTimezone(instant, "UTC")).toBe("2025-03-05");
  });
});
