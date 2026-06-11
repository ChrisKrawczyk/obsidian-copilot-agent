import { describe, expect, it } from "vitest";
import { parseSearchToolResult } from "./searchResultRenderer";

describe("parseSearchToolResult (FR-018, MF-3)", () => {
  it("returns null for unknown tool names", () => {
    expect(
      parseSearchToolResult("read_note", JSON.stringify({ ok: true })),
    ).toBeNull();
    expect(parseSearchToolResult(undefined, "{}")).toBeNull();
  });

  it("returns null on malformed JSON", () => {
    expect(parseSearchToolResult("search_by_tag", "{not json")).toBeNull();
  });

  it("returns null on { ok: false } payloads (diagnostic — read better as plain text)", () => {
    const json = JSON.stringify({ ok: false, reason: "metadata-cache-not-ready" });
    expect(parseSearchToolResult("search_by_tag", json)).toBeNull();
    expect(parseSearchToolResult("list_all_tags", json)).toBeNull();
  });

  it("parses search_by_tag matches with total + truncated", () => {
    const json = JSON.stringify({
      ok: true,
      tag: "#project",
      matches: [
        { path: "a.md", displayName: "a" },
        { path: "b.md", displayName: "b" },
      ],
      total: 5,
      truncated: true,
    });
    const r = parseSearchToolResult("search_by_tag", json);
    expect(r).not.toBeNull();
    if (r?.kind !== "matches") throw new Error("expected matches kind");
    expect(r.matches).toEqual([
      { path: "a.md", displayName: "a" },
      { path: "b.md", displayName: "b" },
    ]);
    expect(r.total).toBe(5);
    expect(r.truncated).toBe(true);
  });

  it("parses search_by_name matches identically to search_by_tag", () => {
    const json = JSON.stringify({
      ok: true,
      query: "alpha",
      matches: [{ path: "Alpha.md", displayName: "Alpha" }],
      total: 1,
      truncated: false,
    });
    const r = parseSearchToolResult("search_by_name", json);
    if (r?.kind !== "matches") throw new Error("expected matches kind");
    expect(r.matches).toHaveLength(1);
    expect(r.truncated).toBe(false);
  });

  it("defaults total to matches.length and truncated to false when omitted", () => {
    const json = JSON.stringify({
      ok: true,
      matches: [{ path: "a.md", displayName: "a" }],
    });
    const r = parseSearchToolResult("search_by_tag", json);
    if (r?.kind !== "matches") throw new Error("expected matches kind");
    expect(r.total).toBe(1);
    expect(r.truncated).toBe(false);
  });

  it("filters out malformed match entries (defensive against future shape drift)", () => {
    const json = JSON.stringify({
      ok: true,
      matches: [
        { path: "a.md", displayName: "a" },
        { path: 123, displayName: "no-string-path" },
        { path: "c.md" }, // missing displayName
        null,
        { path: "d.md", displayName: "d" },
      ],
      total: 5,
    });
    const r = parseSearchToolResult("search_by_tag", json);
    if (r?.kind !== "matches") throw new Error("expected matches kind");
    expect(r.matches.map((m) => m.path)).toEqual(["a.md", "d.md"]);
    // total preserved from payload (the tool's view of how many matched
    // server-side), not the count of well-formed entries.
    expect(r.total).toBe(5);
  });

  it("returns null when matches is not an array (search tools)", () => {
    const json = JSON.stringify({ ok: true, matches: "oops" });
    expect(parseSearchToolResult("search_by_tag", json)).toBeNull();
  });

  it("parses list_all_tags into a tags shape", () => {
    const json = JSON.stringify({
      ok: true,
      tags: [
        { tag: "#project", count: 3 },
        { tag: "#work", count: 1 },
      ],
    });
    const r = parseSearchToolResult("list_all_tags", json);
    if (r?.kind !== "tags") throw new Error("expected tags kind");
    expect(r.tags).toEqual([
      { tag: "#project", count: 3 },
      { tag: "#work", count: 1 },
    ]);
  });

  it("filters out malformed tag entries", () => {
    const json = JSON.stringify({
      ok: true,
      tags: [
        { tag: "#good", count: 1 },
        { tag: "#bad", count: "n/a" }, // non-number count
        { tag: 123, count: 2 }, // non-string tag
        null,
        { tag: "#also-good", count: 5 },
      ],
    });
    const r = parseSearchToolResult("list_all_tags", json);
    if (r?.kind !== "tags") throw new Error("expected tags kind");
    expect(r.tags.map((t) => t.tag)).toEqual(["#good", "#also-good"]);
  });

  it("returns null when tags is not an array (list_all_tags)", () => {
    const json = JSON.stringify({ ok: true, tags: { foo: 1 } });
    expect(parseSearchToolResult("list_all_tags", json)).toBeNull();
  });

  it("returns null when the parsed JSON is not an object", () => {
    expect(parseSearchToolResult("search_by_tag", "[]")).toBeNull();
    expect(parseSearchToolResult("search_by_tag", "null")).toBeNull();
    expect(parseSearchToolResult("search_by_tag", '"string"')).toBeNull();
    expect(parseSearchToolResult("search_by_tag", "42")).toBeNull();
  });

  it("returns a kind=matches shape for empty matches arrays (so the renderer can show 'No matches')", () => {
    const json = JSON.stringify({ ok: true, matches: [], total: 0 });
    const r = parseSearchToolResult("search_by_tag", json);
    if (r?.kind !== "matches") throw new Error("expected matches kind");
    expect(r.matches).toEqual([]);
    expect(r.total).toBe(0);
  });
});
