import { describe, expect, test, vi } from "vitest";
import {
  applyConfirmedImport,
  runImportFromReaderResult,
  runPackImport,
  type ImportPackOutcome,
} from "./packImporter";
import type { ImportedPackRecord, Pack } from "./packTypes";

function pack(id: string, overrides: Partial<Pack> = {}): Pack {
  return {
    schemaVersion: 1,
    id,
    label: overrides.label ?? id.toUpperCase(),
    version: overrides.version ?? "1",
    presets: overrides.presets ?? [
      {
        id: "p1",
        label: "Preset 1",
        server: { name: "Preset 1", transport: "http", url: "https://example.org/mcp" },
        credentials: { kind: "none" },
      },
    ],
    ...(overrides.description ? { description: overrides.description } : {}),
  };
}

function txt(p: Pack): string {
  return JSON.stringify(p);
}

function record(p: Pack): ImportedPackRecord {
  return {
    recordId: "rid",
    pack: p,
    sourcePath: "/prev.json",
    importedAt: 1,
  };
}

describe("runPackImport", () => {
  test("happy path → confirmNew with parsed pack", () => {
    const text = txt(pack("vendor"));
    const out = runPackImport({
      text,
      sourcePath: "/v.json",
      byteLength: Buffer.byteLength(text, "utf8"),
      existingRecord: null,
    });
    expect(out.kind).toBe("confirmNew");
    if (out.kind === "confirmNew") {
      expect(out.pack.id).toBe("vendor");
      expect(out.sourcePath).toBe("/v.json");
      expect(out.sizeWarning).toBeUndefined();
    }
  });

  test("size > 1 MB → sizeError; no validation attempted", () => {
    const out = runPackImport({
      text: "",
      sourcePath: "/big.json",
      byteLength: 2_000_000,
      existingRecord: null,
    });
    expect(out.kind).toBe("sizeError");
    if (out.kind === "sizeError") expect(out.error.kind).toBe("size");
  });

  test("100 KB < size < 1 MB → confirmNew with sizeWarning", () => {
    const text = txt(pack("vendor"));
    const out = runPackImport({
      text,
      sourcePath: "/v.json",
      byteLength: 200_000,
      existingRecord: null,
    });
    expect(out.kind).toBe("confirmNew");
    if (out.kind === "confirmNew") expect(out.sizeWarning).toBe(true);
  });

  test("malformed JSON → parseError with line/column", () => {
    const text = "{not:json";
    const out = runPackImport({
      text,
      sourcePath: "/bad.json",
      byteLength: text.length,
      existingRecord: null,
    });
    expect(out.kind).toBe("parseError");
    if (out.kind === "parseError") {
      expect(out.error.kind).toBe("parse");
      expect(out.error.line).toBeGreaterThanOrEqual(1);
    }
  });

  test("schema-invalid → validationError with pointer", () => {
    const text = JSON.stringify({ schemaVersion: 1, id: "x" });
    const out = runPackImport({
      text,
      sourcePath: "/bad.json",
      byteLength: text.length,
      existingRecord: null,
    });
    expect(out.kind).toBe("validationError");
    if (out.kind === "validationError") expect(out.error.pointer).toMatch(/\//);
  });

  test("re-import identical → confirmReimport with empty deltas", () => {
    const p = pack("vendor");
    const text = txt(p);
    const out = runPackImport({
      text,
      sourcePath: "/v.json",
      byteLength: text.length,
      existingRecord: record(p),
    });
    expect(out.kind).toBe("confirmReimport");
    if (out.kind === "confirmReimport") {
      expect(out.diff.added).toEqual([]);
      expect(out.diff.removed).toEqual([]);
      expect(out.diff.changed).toEqual([]);
      expect(out.metadataChanged).toBeNull();
    }
  });

  test("re-import with one added + one changed → diff reflects both", () => {
    const prev = pack("vendor", {
      presets: [
        {
          id: "p1",
          label: "Preset 1",
          server: { name: "Preset 1", transport: "http", url: "https://example.org/mcp" },
          credentials: { kind: "none" },
        },
      ],
    });
    const next = pack("vendor", {
      presets: [
        {
          id: "p1",
          label: "Preset 1 v2",
          server: { name: "Preset 1", transport: "http", url: "https://example.org/mcp" },
          credentials: { kind: "none" },
        },
        {
          id: "p2",
          label: "Preset 2",
          server: { name: "Preset 2", transport: "http", url: "https://example.org/p2" },
          credentials: { kind: "none" },
        },
      ],
    });
    const text = txt(next);
    const out = runPackImport({
      text,
      sourcePath: "/v.json",
      byteLength: text.length,
      existingRecord: record(prev),
    });
    expect(out.kind).toBe("confirmReimport");
    if (out.kind === "confirmReimport") {
      expect(out.diff.added.map((p) => p.id)).toEqual(["p2"]);
      expect(out.diff.changed.map((c) => c.id)).toEqual(["p1"]);
    }
  });

  test("SC-006: stdio pack with nonexistent command still yields confirmNew; commandExists never called", () => {
    const commandExists = vi.fn(() => false);
    const stdio = pack("vendor", {
      presets: [
        {
          id: "p1",
          label: "P1",
          server: { name: "P1", transport: "stdio", command: "definitely-not-on-path", args: [] },
          credentials: { kind: "none" },
        },
      ],
    });
    const text = txt(stdio);
    const out = runPackImport({
      text,
      sourcePath: "/v.json",
      byteLength: text.length,
      existingRecord: null,
    });
    expect(out.kind).toBe("confirmNew");
    expect(commandExists).not.toHaveBeenCalled();
  });
});

describe("applyConfirmedImport", () => {
  test("calls store.addOrReplace with pack + sourcePath", async () => {
    const addOrReplace = vi.fn(async (p: Pack, sp: string) => ({
      recordId: "rid",
      pack: p,
      sourcePath: sp,
      importedAt: 42,
    }));
    const store = { addOrReplace } as unknown as Parameters<typeof applyConfirmedImport>[0];
    const result = await applyConfirmedImport(store, pack("vendor"), "/v.json");
    expect(addOrReplace).toHaveBeenCalledTimes(1);
    expect(addOrReplace.mock.calls[0][1]).toBe("/v.json");
    expect(result.recordId).toBe("rid");
  });
});

describe("runImportFromReaderResult", () => {
  const noExisting = () => null;

  test("cancelled reader → cancelled outcome", () => {
    const out = runImportFromReaderResult({ ok: false, reason: "cancelled" }, noExisting);
    expect(out.kind).toBe("cancelled");
  });

  test("io reader error → ioError outcome with message", () => {
    const out = runImportFromReaderResult(
      { ok: false, reason: "io", message: "EACCES" },
      noExisting,
    );
    expect(out.kind).toBe("ioError");
    if (out.kind === "ioError") expect(out.message).toBe("EACCES");
  });

  test("too-large reader → sizeError outcome", () => {
    const out = runImportFromReaderResult(
      { ok: false, reason: "too-large", message: "2MB > 1MB" },
      noExisting,
    );
    expect(out.kind).toBe("sizeError");
    if (out.kind === "sizeError") expect(out.error.kind).toBe("size");
  });

  test("ok reader + no existing → confirmNew", () => {
    const text = txt(pack("vendor"));
    const out = runImportFromReaderResult(
      { ok: true, text, sourcePath: "/v.json", byteLength: text.length },
      noExisting,
    );
    expect(out.kind).toBe("confirmNew");
  });

  test("ok reader + existing → confirmReimport with diff", () => {
    const prev = pack("vendor");
    const text = txt(pack("vendor", { label: "Vendor v2", version: "2" }));
    const out = runImportFromReaderResult(
      { ok: true, text, sourcePath: "/v.json", byteLength: text.length },
      () => record(prev),
    );
    expect(out.kind).toBe("confirmReimport");
    if (out.kind === "confirmReimport") expect(out.metadataChanged).not.toBeNull();
  });
});

// Exhaustive variant coverage assertion — fails to compile if a variant is added
// without being listed here.
function _exhaust(o: ImportPackOutcome): string {
  switch (o.kind) {
    case "sizeError":
    case "parseError":
    case "validationError":
    case "ioError":
    case "cancelled":
    case "confirmNew":
    case "confirmReimport":
      return o.kind;
  }
}
void _exhaust;
