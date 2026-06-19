import { describe, expect, it } from "vitest";
import {
  REQUIRED_RELEASE_ASSETS,
  buildAssetPaths,
  buildBootstrapReleaseBody,
  resolveHistoricalSha,
} from "./bootstrapRelease";

describe("REQUIRED_RELEASE_ASSETS", () => {
  it("matches the three-file invariant from the release pipeline", () => {
    expect([...REQUIRED_RELEASE_ASSETS].sort()).toEqual([
      "main.js",
      "manifest.json",
      "styles.css",
    ]);
  });
});

describe("buildAssetPaths", () => {
  it("joins each required asset under the staged directory", () => {
    const paths = buildAssetPaths("/tmp/staged");
    expect(paths).toHaveLength(3);
    for (const p of paths) {
      expect(p.startsWith("/tmp/staged")).toBe(true);
    }
    const names = paths.map((p) => p.split(/[\\/]/).pop()).sort();
    expect(names).toEqual(["main.js", "manifest.json", "styles.css"]);
  });
});

describe("buildBootstrapReleaseBody", () => {
  it("appends the historical-completeness notice", () => {
    const body = buildBootstrapReleaseBody("## [0.5.0] - 2026-06-18\n\n### Added\n- thing\n");
    expect(body).toContain("## [0.5.0] - 2026-06-18");
    expect(body).toContain("- thing");
    expect(body).toMatch(/historical completeness/i);
    expect(body).toMatch(/pin v0\.6\.0 or later/i);
  });

  it("strips trailing whitespace from the changelog section before appending", () => {
    const body = buildBootstrapReleaseBody("section\n\n\n   \n");
    expect(body.startsWith("section\n\n---\n\n")).toBe(true);
  });

  it("throws TypeError on non-string input", () => {
    // @ts-expect-error intentional bad input
    expect(() => buildBootstrapReleaseBody(null)).toThrow(TypeError);
    // @ts-expect-error intentional bad input
    expect(() => buildBootstrapReleaseBody(42)).toThrow(TypeError);
  });

  it("produces deterministic output for identical input", () => {
    const input = "## [0.5.0]\n\nNotes.";
    expect(buildBootstrapReleaseBody(input)).toBe(buildBootstrapReleaseBody(input));
  });
});

describe("resolveHistoricalSha", () => {
  it("defaults to the v0.5.0 merge sha when no argument is supplied", () => {
    expect(resolveHistoricalSha(undefined)).toBe("22f660d");
    expect(resolveHistoricalSha("")).toBe("22f660d");
  });

  it("lowercases and accepts valid short or full shas", () => {
    expect(resolveHistoricalSha("22f660D")).toBe("22f660d");
    expect(resolveHistoricalSha("ABCDEF0123456789ABCDEF0123456789ABCDEF01")).toBe(
      "abcdef0123456789abcdef0123456789abcdef01",
    );
  });

  it("rejects non-hex or wrongly-sized shas", () => {
    expect(() => resolveHistoricalSha("zzzzzzz")).toThrow(/invalid sha/);
    expect(() => resolveHistoricalSha("123")).toThrow(/invalid sha/);
    expect(() => resolveHistoricalSha("g".repeat(7))).toThrow(/invalid sha/);
  });

  it("rejects non-string input", () => {
    // @ts-expect-error intentional bad input
    expect(() => resolveHistoricalSha(123)).toThrow(TypeError);
  });
});
