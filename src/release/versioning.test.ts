import { describe, it, expect } from "vitest";
import {
  parseSemver,
  compareSemver,
  assertMonotonic,
  mergeVersionsMap,
  VersionError,
} from "./versioning";

describe("parseSemver", () => {
  it("parses basic semver", () => {
    expect(parseSemver("0.6.0")).toEqual({ major: 0, minor: 6, patch: 0, preRelease: undefined, build: undefined });
    expect(parseSemver("1.2.3")).toMatchObject({ major: 1, minor: 2, patch: 3 });
    expect(parseSemver("10.20.30")).toMatchObject({ major: 10, minor: 20, patch: 30 });
  });

  it("parses pre-release identifiers", () => {
    expect(parseSemver("0.6.0-rc.1")).toMatchObject({ major: 0, minor: 6, patch: 0, preRelease: "rc.1" });
    expect(parseSemver("1.0.0-alpha")).toMatchObject({ preRelease: "alpha" });
    expect(parseSemver("1.0.0-alpha.0.0")).toMatchObject({ preRelease: "alpha.0.0" });
  });

  it("parses build metadata", () => {
    expect(parseSemver("1.0.0+sha.abc")).toMatchObject({ build: "sha.abc" });
    expect(parseSemver("1.0.0-rc.1+build.5")).toMatchObject({ preRelease: "rc.1", build: "build.5" });
  });

  it("rejects empty", () => {
    expect(() => parseSemver("")).toThrow(VersionError);
  });

  it("rejects leading v", () => {
    expect(() => parseSemver("v1.2.3")).toThrow(/leading "v"/);
    expect(() => parseSemver("V1.2.3")).toThrow(/leading "v"/);
  });

  it("rejects non-numeric components", () => {
    expect(() => parseSemver("1.2")).toThrow(VersionError);
    expect(() => parseSemver("1.2.x")).toThrow(VersionError);
    expect(() => parseSemver("a.b.c")).toThrow(VersionError);
    expect(() => parseSemver("not-a-version")).toThrow(VersionError);
  });

  it("rejects leading zeros in numeric components", () => {
    expect(() => parseSemver("01.0.0")).toThrow(VersionError);
    expect(() => parseSemver("1.02.0")).toThrow(VersionError);
  });

  it("rejects malformed pre-release", () => {
    expect(() => parseSemver("1.0.0-")).toThrow(VersionError);
    expect(() => parseSemver("1.0.0-rc..1")).toThrow(VersionError);
  });
});

describe("compareSemver", () => {
  it("compares major/minor/patch", () => {
    expect(compareSemver("1.0.0", "2.0.0")).toBe(-1);
    expect(compareSemver("2.0.0", "1.0.0")).toBe(1);
    expect(compareSemver("1.0.0", "1.0.0")).toBe(0);
    expect(compareSemver("1.2.3", "1.2.4")).toBe(-1);
    expect(compareSemver("1.3.0", "1.2.99")).toBe(1);
  });

  it("treats pre-release as lower than release", () => {
    expect(compareSemver("1.0.0-rc.1", "1.0.0")).toBe(-1);
    expect(compareSemver("1.0.0", "1.0.0-rc.1")).toBe(1);
  });

  it("orders pre-release identifiers per semver spec", () => {
    expect(compareSemver("1.0.0-alpha", "1.0.0-alpha.1")).toBe(-1);
    expect(compareSemver("1.0.0-alpha.1", "1.0.0-alpha.beta")).toBe(-1);
    expect(compareSemver("1.0.0-alpha.beta", "1.0.0-beta")).toBe(-1);
    expect(compareSemver("1.0.0-beta", "1.0.0-beta.2")).toBe(-1);
    expect(compareSemver("1.0.0-rc.1", "1.0.0-rc.2")).toBe(-1);
    expect(compareSemver("1.0.0-rc.10", "1.0.0-rc.2")).toBe(1);
  });

  it("ignores build metadata", () => {
    expect(compareSemver("1.0.0+a", "1.0.0+b")).toBe(0);
  });

  it("accepts pre-parsed inputs", () => {
    const a = parseSemver("1.0.0");
    const b = parseSemver("1.0.1");
    expect(compareSemver(a, b)).toBe(-1);
  });
});

describe("assertMonotonic", () => {
  it("accepts strictly greater target", () => {
    expect(() => assertMonotonic("0.5.0", "0.6.0")).not.toThrow();
    expect(() => assertMonotonic("0.5.0", "0.6.0-rc.1")).not.toThrow();
    expect(() => assertMonotonic("0.6.0-rc.1", "0.6.0")).not.toThrow();
  });

  it("rejects equal target", () => {
    expect(() => assertMonotonic("0.6.0", "0.6.0")).toThrow(/equal/);
  });

  it("rejects lesser target", () => {
    expect(() => assertMonotonic("0.6.0", "0.5.9")).toThrow(/less than/);
    expect(() => assertMonotonic("0.6.0", "0.6.0-rc.1")).toThrow(/less than/);
  });
});

describe("mergeVersionsMap", () => {
  it("adds a new entry preserving existing entries", () => {
    const merged = mergeVersionsMap({ "0.5.0": "1.5.0" }, "0.6.0", "1.5.0");
    expect(merged).toEqual({ "0.5.0": "1.5.0", "0.6.0": "1.5.0" });
    // Newest last
    expect(Object.keys(merged)).toEqual(["0.5.0", "0.6.0"]);
  });

  it("orders keys with newest last regardless of input order", () => {
    const merged = mergeVersionsMap({ "0.6.0": "1.5.0", "0.5.0": "1.5.0" }, "0.7.0", "1.6.0");
    expect(Object.keys(merged)).toEqual(["0.5.0", "0.6.0", "0.7.0"]);
  });

  it("overwrites an existing entry if present", () => {
    const merged = mergeVersionsMap({ "0.5.0": "1.5.0", "0.6.0": "1.5.0" }, "0.6.0", "1.6.0");
    expect(merged).toEqual({ "0.5.0": "1.5.0", "0.6.0": "1.6.0" });
    expect(Object.keys(merged)).toEqual(["0.5.0", "0.6.0"]);
  });

  it("rejects malformed version", () => {
    expect(() => mergeVersionsMap({}, "not-a-version", "1.0.0")).toThrow(VersionError);
  });

  it("rejects empty minAppVersion", () => {
    expect(() => mergeVersionsMap({}, "1.0.0", "")).toThrow(VersionError);
  });

  it("orders pre-release entries correctly", () => {
    const merged = mergeVersionsMap({ "0.6.0": "1.5.0" }, "0.6.0-rc.1", "1.5.0");
    expect(Object.keys(merged)).toEqual(["0.6.0-rc.1", "0.6.0"]);
  });
});
