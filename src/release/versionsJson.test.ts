import { describe, it, expect } from "vitest";
import {
  parseVersionsJson,
  stringifyVersionsJson,
  addVersionEntry,
} from "./versionsJson";

describe("parseVersionsJson", () => {
  it("returns empty map on empty input", () => {
    expect(parseVersionsJson("")).toEqual({});
    expect(parseVersionsJson("   \n")).toEqual({});
  });

  it("parses a valid map", () => {
    expect(parseVersionsJson('{"0.5.0":"1.5.0"}')).toEqual({ "0.5.0": "1.5.0" });
  });

  it("rejects non-object JSON", () => {
    expect(() => parseVersionsJson("[]")).toThrow(/must be a JSON object/);
    expect(() => parseVersionsJson('"hello"')).toThrow(/must be a JSON object/);
    expect(() => parseVersionsJson("null")).toThrow(/must be a JSON object/);
  });

  it("rejects invalid JSON", () => {
    expect(() => parseVersionsJson("{not json}")).toThrow(/not valid JSON/);
  });

  it("rejects non-string values", () => {
    expect(() => parseVersionsJson('{"0.5.0": 150}')).toThrow(/must map to a string/);
  });
});

describe("stringifyVersionsJson", () => {
  it("emits 2-space indented JSON with trailing newline", () => {
    const out = stringifyVersionsJson({ "0.5.0": "1.5.0" });
    expect(out).toBe('{\n  "0.5.0": "1.5.0"\n}\n');
  });

  it("preserves key insertion order", () => {
    const out = stringifyVersionsJson({ "0.5.0": "1.5.0", "0.6.0": "1.5.0" });
    expect(out.indexOf("0.5.0")).toBeLessThan(out.indexOf("0.6.0"));
  });
});

describe("addVersionEntry", () => {
  it("adds a new entry to an existing file", () => {
    const out = addVersionEntry('{"0.5.0":"1.5.0"}\n', "0.6.0", "1.5.0");
    expect(out).toBe('{\n  "0.5.0": "1.5.0",\n  "0.6.0": "1.5.0"\n}\n');
  });

  it("creates a new file when starting from empty input", () => {
    const out = addVersionEntry("", "0.5.0", "1.5.0");
    expect(out).toBe('{\n  "0.5.0": "1.5.0"\n}\n');
  });

  it("orders newest entry last", () => {
    const out = addVersionEntry('{"0.6.0":"1.5.0"}\n', "0.5.0", "1.5.0");
    // 0.5.0 < 0.6.0 so 0.6.0 stays last; merged sort puts 0.5.0 first
    expect(out).toBe('{\n  "0.5.0": "1.5.0",\n  "0.6.0": "1.5.0"\n}\n');
  });
});
