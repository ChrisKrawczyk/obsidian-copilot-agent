import { describe, it, expect } from "vitest";
import { parseExpiry } from "./expiry";

describe("parseExpiry", () => {
  it("parses ISO-8601 string with Z", () => {
    expect(parseExpiry("2026-01-15T18:30:00Z")).toBe(
      Date.UTC(2026, 0, 15, 18, 30, 0),
    );
  });

  it("parses ISO-8601 with offset", () => {
    const ms = parseExpiry("2026-01-15T18:30:00+00:00");
    expect(ms).toBe(Date.UTC(2026, 0, 15, 18, 30, 0));
  });

  it("treats number < 1e12 as Unix seconds", () => {
    expect(parseExpiry(1_700_000_000)).toBe(1_700_000_000_000);
  });

  it("treats number >= 1e12 as Unix milliseconds", () => {
    expect(parseExpiry(1_700_000_000_000)).toBe(1_700_000_000_000);
  });

  it("floors fractional second values", () => {
    expect(parseExpiry(1_700_000_000.9)).toBe(
      Math.floor(1_700_000_000.9 * 1000),
    );
  });

  it("parses Azure CLI format with microseconds in local time", () => {
    const ms = parseExpiry("2026-01-15 18:30:00.123456");
    expect(ms).toBe(new Date(2026, 0, 15, 18, 30, 0, 123).getTime());
  });

  it("parses Azure CLI format without fractional seconds", () => {
    const ms = parseExpiry("2026-01-15 18:30:00");
    expect(ms).toBe(new Date(2026, 0, 15, 18, 30, 0, 0).getTime());
  });

  it("returns null for unparseable string", () => {
    expect(parseExpiry("not-a-date")).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(parseExpiry("")).toBeNull();
    expect(parseExpiry("   ")).toBeNull();
  });

  it("returns null for null / undefined", () => {
    expect(parseExpiry(null)).toBeNull();
    expect(parseExpiry(undefined)).toBeNull();
  });

  it("returns null for NaN / Infinity", () => {
    expect(parseExpiry(NaN)).toBeNull();
    expect(parseExpiry(Infinity)).toBeNull();
    expect(parseExpiry(-Infinity)).toBeNull();
  });

  it("returns null for object / array input", () => {
    expect(parseExpiry({})).toBeNull();
    expect(parseExpiry([])).toBeNull();
  });
});
