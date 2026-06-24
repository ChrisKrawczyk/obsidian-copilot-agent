import { describe, expect, test } from "vitest";
import {
  canonicalStringify,
  canonicalizePack,
  packsCanonicalEqual,
} from "./packCanonical";
import type { Pack } from "./packTypes";

function pack(presets: Pack["presets"] = []): Pack {
  return { schemaVersion: 1, id: "p", label: "P", version: "1", presets };
}

describe("packCanonical", () => {
  test("identical packs with shuffled key order produce identical canonical strings", () => {
    const a = pack();
    const aReordered = { presets: [], version: "1", label: "P", id: "p", schemaVersion: 1 } as unknown as Pack;
    expect(canonicalizePack(a)).toBe(canonicalizePack(aReordered));
  });

  test("array order is preserved (preset order is part of the pack)", () => {
    const a = canonicalizePack(
      pack([
        { id: "x", label: "x", server: { name: "x", transport: "http", url: "https://example.org/x" }, credentials: { kind: "none" } },
        { id: "y", label: "y", server: { name: "y", transport: "http", url: "https://example.org/y" }, credentials: { kind: "none" } },
      ]),
    );
    const b = canonicalizePack(
      pack([
        { id: "y", label: "y", server: { name: "y", transport: "http", url: "https://example.org/y" }, credentials: { kind: "none" } },
        { id: "x", label: "x", server: { name: "x", transport: "http", url: "https://example.org/x" }, credentials: { kind: "none" } },
      ]),
    );
    expect(a).not.toBe(b);
  });

  test("nested objects sorted at every depth", () => {
    const a = canonicalStringify({ b: { d: 1, c: 2 }, a: 0 });
    const b = canonicalStringify({ a: 0, b: { c: 2, d: 1 } });
    expect(a).toBe(b);
    expect(a).toBe('{"a":0,"b":{"c":2,"d":1}}');
  });

  test("unicode characters preserved", () => {
    const s = canonicalStringify({ k: "中文 / αβ / 𝓐" });
    expect(JSON.parse(s)).toEqual({ k: "中文 / αβ / 𝓐" });
  });

  test("numeric values stable", () => {
    expect(canonicalStringify({ a: 1.5 })).toBe('{"a":1.5}');
    expect(canonicalStringify({ a: 0 })).toBe('{"a":0}');
    expect(canonicalStringify({ a: -0 })).toBe('{"a":0}');
  });

  test("undefined values dropped from objects", () => {
    expect(canonicalStringify({ a: 1, b: undefined })).toBe('{"a":1}');
  });

  test("packsCanonicalEqual is true for byte-equivalent canonical form", () => {
    expect(packsCanonicalEqual(pack(), pack())).toBe(true);
  });
});
