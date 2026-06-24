import { describe, expect, test } from "vitest";
import {
  PACK_MAX_BYTES,
  PACK_WARN_BYTES,
  parsePackText,
} from "./packParser";

const validBody = JSON.stringify({
  schemaVersion: 1,
  id: "p",
  label: "P",
  version: "1",
  presets: [],
});

describe("packParser", () => {
  test("strips a leading UTF-8 BOM", () => {
    const text = "\ufeff" + validBody;
    const result = parsePackText(text);
    expect(result.ok).toBe(true);
    expect((result.raw as { id: string }).id).toBe("p");
  });

  test("happy path returns raw object", () => {
    const result = parsePackText(validBody);
    expect(result.ok).toBe(true);
    expect(result.raw).toEqual({
      schemaVersion: 1,
      id: "p",
      label: "P",
      version: "1",
      presets: [],
    });
  });

  test("trailing comma rejected with line/column", () => {
    const text = '{\n  "a": 1,\n}\n';
    const result = parsePackText(text);
    expect(result.ok).toBe(false);
    expect(result.error?.kind).toBe("parse");
    expect(result.error?.line).toBeGreaterThanOrEqual(1);
    expect(result.error?.column).toBeGreaterThanOrEqual(1);
  });

  test("rejects // line comments outside strings", () => {
    const text = '{\n// hi\n  "a": 1\n}';
    const result = parsePackText(text);
    expect(result.ok).toBe(false);
    expect(result.error?.kind).toBe("parse");
    expect(result.error?.message).toMatch(/JSON-with-comments/);
    expect(result.error?.line).toBe(2);
    expect(result.error?.column).toBe(1);
  });

  test("rejects /* block comments outside strings", () => {
    const text = '{\n  "a": /* x */ 1\n}';
    const result = parsePackText(text);
    expect(result.ok).toBe(false);
    expect(result.error?.message).toMatch(/JSON-with-comments/);
  });

  test('does not flag "//" or "/*" inside string values', () => {
    const text = JSON.stringify({
      schemaVersion: 1,
      id: "p",
      label: "// not a comment /* nor this */",
      version: "1",
      presets: [],
    });
    const result = parsePackText(text);
    expect(result.ok).toBe(true);
  });

  test("byte-length > maxBytes rejected before parse (multi-byte payload)", () => {
    // A 3-byte UTF-8 character (CJK) is 1 JS char each.
    const multibyte = "中"; // 3 UTF-8 bytes, 1 char
    const maxBytes = 32;
    const fill = multibyte.repeat(20); // 60 bytes, 20 chars
    const text = `{"v":"${fill}"}`;
    expect(text.length).toBeLessThan(maxBytes); // 27 chars < 32
    expect(Buffer.byteLength(text, "utf8")).toBeGreaterThan(maxBytes); // 67 bytes > 32
    const result = parsePackText(text, { maxBytes });
    expect(result.ok).toBe(false);
    expect(result.error?.kind).toBe("size");
  });

  test("byte-length > warnBytes sets sizeWarning", () => {
    const result = parsePackText(validBody, {
      maxBytes: 1000,
      warnBytes: 10,
    });
    expect(result.ok).toBe(true);
    expect(result.sizeWarning).toBe(true);
  });

  test("empty string rejected", () => {
    const result = parsePackText("");
    expect(result.ok).toBe(false);
    expect(result.error?.kind).toBe("parse");
  });

  test("default limits match the documented constants", () => {
    expect(PACK_MAX_BYTES).toBe(1_048_576);
    expect(PACK_WARN_BYTES).toBe(102_400);
  });
});
