import { describe, expect, test } from "vitest";
import {
  escapeMcpPlainText,
  MCP_TEXT_TRUNCATION_MARKER,
  truncateMcpText,
} from "./approvalText";

describe("approvalText MCP helpers", () => {
  test("escapes HTML, markdown metacharacters, and control characters", () => {
    const out = escapeMcpPlainText("<b>*run*</b>\u0001");
    expect(out).toContain("&lt;b&gt;");
    expect(out).toContain("\\*run\\*");
    expect(out).toContain("\\u0001");
  });

  test("leaves short text unmodified by truncation", () => {
    expect(truncateMcpText("short")).toBe("short");
  });

  test("uses the shared visible truncation marker", () => {
    expect(truncateMcpText("abcd", 2)).toBe(
      `ab${MCP_TEXT_TRUNCATION_MARKER}`,
    );
  });
});
