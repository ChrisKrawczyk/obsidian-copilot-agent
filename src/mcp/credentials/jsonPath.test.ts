import { describe, it, expect } from "vitest";
import { extractAtPath } from "./jsonPath";

describe("extractAtPath", () => {
  it("returns top-level string value", () => {
    expect(extractAtPath({ accessToken: "abc" }, "accessToken")).toBe("abc");
  });

  it("returns nested value via dotted path", () => {
    expect(extractAtPath({ result: { token: "abc" } }, "result.token")).toBe(
      "abc",
    );
  });

  it("returns deeply nested value", () => {
    const obj = { a: { b: { c: { d: 42 } } } };
    expect(extractAtPath(obj, "a.b.c.d")).toBe(42);
  });

  it("returns undefined when leading segment missing", () => {
    expect(extractAtPath({ a: { b: "x" } }, "missing.b")).toBeUndefined();
  });

  it("returns undefined when trailing segment missing", () => {
    expect(extractAtPath({ a: { b: "x" } }, "a.missing")).toBeUndefined();
  });

  it("returns undefined when traversing into non-object", () => {
    expect(extractAtPath({ a: "string-not-object" }, "a.b")).toBeUndefined();
  });

  it("returns undefined when traversing into array", () => {
    expect(extractAtPath({ a: ["x"] }, "a.0")).toBeUndefined();
  });

  it("returns undefined for null input", () => {
    expect(extractAtPath(null, "a")).toBeUndefined();
  });

  it("returns undefined for empty path string", () => {
    expect(extractAtPath({ a: 1 }, "")).toBeUndefined();
  });

  it("returns undefined for leading dot", () => {
    expect(extractAtPath({ a: 1 }, ".a")).toBeUndefined();
  });

  it("returns undefined for trailing dot", () => {
    expect(extractAtPath({ a: 1 }, "a.")).toBeUndefined();
  });

  it("returns undefined for path containing double dots", () => {
    expect(extractAtPath({ a: { b: 1 } }, "a..b")).toBeUndefined();
  });

  it("preserves falsy values that exist (null, 0, empty string)", () => {
    expect(extractAtPath({ a: 0 }, "a")).toBe(0);
    expect(extractAtPath({ a: "" }, "a")).toBe("");
    expect(extractAtPath({ a: null }, "a")).toBeNull();
  });
});
