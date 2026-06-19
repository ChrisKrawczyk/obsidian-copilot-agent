import { describe, expect, it } from "vitest";
import {
  REQUIRED_ASSET_FILES,
  validateManifestVersion,
  validateReleaseAssets,
  validateRequiredAssetSet,
  validateVersionsJsonEntry,
} from "./releaseAssets";

describe("validateRequiredAssetSet", () => {
  it("passes when exactly the three required files are present", () => {
    const r = validateRequiredAssetSet([...REQUIRED_ASSET_FILES]);
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual([]);
  });

  it("ignores list ordering", () => {
    const r = validateRequiredAssetSet(["styles.css", "main.js", "manifest.json"]);
    expect(r.ok).toBe(true);
  });

  it("fails with a clear error when main.js is missing", () => {
    const r = validateRequiredAssetSet(["manifest.json", "styles.css"]);
    expect(r.ok).toBe(false);
    expect(r.errors.join("\n")).toContain("Missing required asset: main.js");
  });

  it("fails when any required asset is missing", () => {
    const r = validateRequiredAssetSet(["main.js"]);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes("manifest.json"))).toBe(true);
    expect(r.errors.some((e) => e.includes("styles.css"))).toBe(true);
  });

  it("rejects an extra file alongside the required three", () => {
    const r = validateRequiredAssetSet([
      "main.js",
      "manifest.json",
      "styles.css",
      "README.md",
    ]);
    expect(r.ok).toBe(false);
    expect(r.errors.join("\n")).toContain("Unexpected asset(s)");
    expect(r.errors.join("\n")).toContain("README.md");
  });

  it("rejects an empty directory", () => {
    const r = validateRequiredAssetSet([]);
    expect(r.ok).toBe(false);
    expect(r.errors.length).toBe(3);
  });
});

describe("validateManifestVersion", () => {
  it("passes when versions match", () => {
    const r = validateManifestVersion({ version: "0.6.0" }, "0.6.0");
    expect(r.ok).toBe(true);
  });

  it("fails with descriptive message when versions diverge", () => {
    const r = validateManifestVersion({ version: "0.5.0" }, "0.6.0");
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toContain("0.5.0");
    expect(r.errors[0]).toContain("0.6.0");
  });

  it("fails on unreadable manifest (null)", () => {
    const r = validateManifestVersion(null, "0.6.0");
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toContain("missing or not a JSON object");
  });

  it("fails on non-object manifest", () => {
    const r = validateManifestVersion("not-an-object", "0.6.0");
    expect(r.ok).toBe(false);
  });

  it("fails when version field is missing", () => {
    const r = validateManifestVersion({ name: "X" }, "0.6.0");
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toContain("missing a string `version` field");
  });

  it("fails when version is empty string", () => {
    const r = validateManifestVersion({ version: "" }, "0.6.0");
    expect(r.ok).toBe(false);
  });
});

describe("validateVersionsJsonEntry", () => {
  it("passes when entry exists", () => {
    const r = validateVersionsJsonEntry({ "0.6.0": "0.15.0" }, "0.6.0");
    expect(r.ok).toBe(true);
  });

  it("fails when entry missing", () => {
    const r = validateVersionsJsonEntry({ "0.5.0": "0.15.0" }, "0.6.0");
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toContain("0.6.0");
    expect(r.errors[0]).toContain("version-bump");
  });

  it("fails when versions.json itself is missing/null", () => {
    const r = validateVersionsJsonEntry(null, "0.6.0");
    expect(r.ok).toBe(false);
  });
});

describe("validateReleaseAssets (composed)", () => {
  const goodFiles = [...REQUIRED_ASSET_FILES];
  const goodManifest = { version: "0.6.0" };
  const goodVersions = { "0.5.0": "0.15.0", "0.6.0": "0.15.0" };

  it("passes when every component validates", () => {
    const r = validateReleaseAssets({
      presentFiles: goodFiles,
      manifest: goodManifest,
      versionsMap: goodVersions,
      targetVersion: "0.6.0",
    });
    expect(r.ok).toBe(true);
  });

  it("aggregates errors across components", () => {
    const r = validateReleaseAssets({
      presentFiles: ["main.js"],
      manifest: { version: "0.5.0" },
      versionsMap: {},
      targetVersion: "0.6.0",
    });
    expect(r.ok).toBe(false);
    expect(r.errors.length).toBeGreaterThanOrEqual(4);
  });

  describe("bootstrap mode", () => {
    it("relaxes manifest-version mismatch", () => {
      const r = validateReleaseAssets({
        presentFiles: goodFiles,
        manifest: { version: "0.6.0" },
        versionsMap: {},
        targetVersion: "0.5.0",
        bootstrap: true,
      });
      expect(r.ok).toBe(true);
    });

    it("relaxes missing versions.json entry", () => {
      const r = validateReleaseAssets({
        presentFiles: goodFiles,
        manifest: { version: "anything" },
        versionsMap: {},
        targetVersion: "0.5.0",
        bootstrap: true,
      });
      expect(r.ok).toBe(true);
    });

    it("still enforces exactly-three-files in bootstrap mode", () => {
      const r = validateReleaseAssets({
        presentFiles: ["main.js", "manifest.json", "styles.css", "extra.txt"],
        manifest: goodManifest,
        versionsMap: goodVersions,
        targetVersion: "0.5.0",
        bootstrap: true,
      });
      expect(r.ok).toBe(false);
      expect(r.errors.join("\n")).toContain("Unexpected asset(s)");
    });

    it("still enforces manifest shape in bootstrap mode", () => {
      const r = validateReleaseAssets({
        presentFiles: goodFiles,
        manifest: { name: "no-version" },
        versionsMap: goodVersions,
        targetVersion: "0.5.0",
        bootstrap: true,
      });
      expect(r.ok).toBe(false);
      expect(r.errors.join("\n")).toContain("missing a string `version` field");
    });

    it("still rejects an unreadable manifest in bootstrap mode", () => {
      const r = validateReleaseAssets({
        presentFiles: goodFiles,
        manifest: null,
        versionsMap: goodVersions,
        targetVersion: "0.5.0",
        bootstrap: true,
      });
      expect(r.ok).toBe(false);
    });
  });
});
