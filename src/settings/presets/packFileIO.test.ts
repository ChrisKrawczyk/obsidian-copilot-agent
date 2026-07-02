import { describe, expect, test, vi } from "vitest";
import {
  createDesktopPackFileReader,
  type PackFileReader,
  type PackFileReadResult,
} from "./packFileIO";

describe("PackFileReader injection contract", () => {
  test("fake reader round-trips ok result", async () => {
    const fake: PackFileReader = {
      pickAndReadPackFile: vi.fn(async () => ({
        ok: true,
        text: '{"id":"vendor"}',
        sourcePath: "/v.json",
        byteLength: 16,
      })),
    };
    const r = await fake.pickAndReadPackFile();
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.sourcePath).toBe("/v.json");
  });

  test("fake reader round-trips error reasons", async () => {
    const reasons: Array<PackFileReadResult & { ok: false }> = [
      { ok: false, reason: "cancelled" },
      { ok: false, reason: "io", message: "EACCES" },
      { ok: false, reason: "too-large", message: "2 MB > 1 MB" },
    ];
    for (const r of reasons) {
      const fake: PackFileReader = { pickAndReadPackFile: async () => r };
      const out = await fake.pickAndReadPackFile();
      expect(out.ok).toBe(false);
      if (!out.ok) expect(out.reason).toBe(r.reason);
    }
  });
});

describe("createDesktopPackFileReader (non-Electron runtime)", () => {
  test("returns io error when not running in Electron", async () => {
    const reader = createDesktopPackFileReader();
    // Vitest's node test env has no `window.process.versions.electron`.
    // Stub minimal window so the factory's runtime probe runs.
    (globalThis as Record<string, unknown>).window = {} as unknown;
    const r = await reader.pickAndReadPackFile();
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("io");
      expect(r.message).toMatch(/Desktop/i);
    }
    delete (globalThis as Record<string, unknown>).window;
  });
});
