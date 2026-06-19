import { describe, it, expect } from "vitest";
import {
  findSection,
  extractSection,
  insertStubSection,
  normalizeUnreleasedHeading,
} from "./changelog";

const SAMPLE = `# Changelog

## [0.5.0] - 2026-06-18

### Added

- Foo
- Bar

## [0.4.0] - 2026-06-12

### Added

- Baz

## [0.3.0] - 2026-06-11

### Added

- Qux
`;

describe("findSection", () => {
  it("locates an existing section", () => {
    const r = findSection(SAMPLE, "0.4.0");
    expect(r).not.toBeNull();
    const lines = SAMPLE.split("\n");
    expect(lines[r!.startLine]).toBe("## [0.4.0] - 2026-06-12");
    expect(lines[r!.endLine + 1]).toBe("## [0.3.0] - 2026-06-11");
  });

  it("handles the last section (extends to EOF)", () => {
    const r = findSection(SAMPLE, "0.3.0");
    expect(r).not.toBeNull();
    expect(r!.endLine).toBe(SAMPLE.split("\n").length - 1);
  });

  it("returns null for missing version", () => {
    expect(findSection(SAMPLE, "9.9.9")).toBeNull();
  });

  it("does not partial-match versions", () => {
    expect(findSection("## [0.5.0-rc.1] - 2026-06-18\n", "0.5.0")).toBeNull();
  });
});

describe("extractSection", () => {
  it("returns the section body verbatim", () => {
    const body = extractSection(SAMPLE, "0.4.0");
    expect(body).toBe("## [0.4.0] - 2026-06-12\n\n### Added\n\n- Baz\n");
  });

  it("returns null for missing version", () => {
    expect(extractSection(SAMPLE, "9.9.9")).toBeNull();
  });

  it("preserves CRLF when present", () => {
    const crlf = SAMPLE.replace(/\n/g, "\r\n");
    const body = extractSection(crlf, "0.4.0");
    expect(body).toContain("\r\n");
    expect(body).toContain("- Baz");
  });
});

describe("insertStubSection", () => {
  it("inserts above the most-recent existing entry", () => {
    const r = insertStubSection(SAMPLE, "0.6.0", "2026-06-19");
    expect(r.inserted).toBe(true);
    expect(r.content).toMatch(/## \[0\.6\.0\] - 2026-06-19/);
    const idx06 = r.content.indexOf("## [0.6.0]");
    const idx05 = r.content.indexOf("## [0.5.0]");
    expect(idx06).toBeLessThan(idx05);
    expect(idx06).toBeGreaterThan(0);
  });

  it("is idempotent if the section already exists", () => {
    const first = insertStubSection(SAMPLE, "0.6.0", "2026-06-19");
    const second = insertStubSection(first.content, "0.6.0", "2026-06-19");
    expect(second.inserted).toBe(false);
    expect(second.content).toBe(first.content);
  });

  it("includes a stub Added section", () => {
    const r = insertStubSection(SAMPLE, "0.6.0", "2026-06-19");
    expect(r.content).toMatch(/## \[0\.6\.0\] - 2026-06-19\n+### Added/);
  });

  it("appends when no sections exist yet", () => {
    const r = insertStubSection("# Changelog\n", "0.1.0", "2026-01-01");
    expect(r.inserted).toBe(true);
    expect(r.content).toMatch(/## \[0\.1\.0\] - 2026-01-01/);
  });
});

describe("normalizeUnreleasedHeading", () => {
  it("converts [Unreleased] to a dated entry", () => {
    const src = "# Changelog\n\n## [Unreleased]\n\n### Added\n- foo\n";
    const out = normalizeUnreleasedHeading(src, "0.6.0", "2026-06-19");
    expect(out).toContain("## [0.6.0] - 2026-06-19");
    expect(out).not.toContain("[Unreleased]");
  });

  it("converts `## [0.5.0] - Unreleased`-style heading", () => {
    const src = "## [0.5.0] – Unreleased\n";
    const out = normalizeUnreleasedHeading(src, "0.5.0", "2026-06-18");
    expect(out).toContain("## [0.5.0] - 2026-06-18");
    expect(out).not.toMatch(/Unreleased/i);
  });

  it("leaves content unchanged when no unreleased heading present", () => {
    const out = normalizeUnreleasedHeading(SAMPLE, "9.9.9", "2026-01-01");
    expect(out).toBe(SAMPLE);
  });
});
