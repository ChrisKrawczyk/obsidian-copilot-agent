import { describe, expect, test } from "vitest";
import {
  escapeMcpPlainText,
  MCP_TEXT_TRUNCATION_MARKER,
  truncateMcpText,
} from "./approvalText";

describe("approvalText MCP helpers", () => {
  test("keeps HTML and markdown readable while neutralizing control characters", () => {
    const out = escapeMcpPlainText("<b>*run*</b>\u0001");
    expect(out).toContain("<b>*run*</b>");
    expect(out).toContain("\\u0001");
  });

  test("renders typical JSON arguments without entity or markdown escapes", () => {
    expect(escapeMcpPlainText('{"path":"<a>foo"}')).toBe('{"path":"<a>foo"}');
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
