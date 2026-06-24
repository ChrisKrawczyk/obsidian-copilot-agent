import { describe, expect, test } from "vitest";
import type { McpServerConfig, McpServerId, McpTrustEpoch } from "../mcp/McpTypes";
import {
  buildExportFlowModel,
  buildExportFlowModelForServer,
  runExport,
  suggestedFilename,
  toggleSelection,
} from "./packExportFlow";
import { SECRET_PLACEHOLDER } from "./presets/packSecretPolicy";
import { validatePack } from "./presets/packValidator";

function brand(id: string): McpServerId {
  return id as McpServerId;
}

function epoch(): McpTrustEpoch {
  return "epoch_test" as McpTrustEpoch;
}

function httpServer(
  partial: Partial<McpServerConfig> = {},
): McpServerConfig {
  return {
    id: brand("s1"),
    name: "Example",
    enabled: true,
    trustEpoch: epoch(),
    transport: "http",
    url: "https://example.org/mcp",
    ...partial,
  } as McpServerConfig;
}

describe("buildExportFlowModel", () => {
  test("rows mirror servers and default selected = false", () => {
    const a = httpServer({ id: brand("a"), name: "Alpha" });
    const b = httpServer({ id: brand("b"), name: "Beta" });
    const model = buildExportFlowModel([a, b]);
    expect(model.rows).toEqual([
      { id: "a", name: "Alpha", transport: "http", selected: false },
      { id: "b", name: "Beta", transport: "http", selected: false },
    ]);
  });

  test("default meta uses ISO date for version", () => {
    const fixed = new Date("2025-06-15T12:00:00Z");
    const model = buildExportFlowModel([], () => fixed);
    expect(model.defaultPackMeta.version).toBe("2025-06-15");
    expect(model.defaultPackMeta.id).toBe("exported-pack");
    expect(model.defaultPackMeta.label).toBe("Exported servers");
  });
});

describe("buildExportFlowModelForServer", () => {
  test("selects only the requested server and derives single-server defaults", () => {
    const alpha = httpServer({ id: brand("alpha"), name: "Example Corp Graph" });
    const beta = httpServer({ id: brand("beta"), name: "Other" });
    const model = buildExportFlowModelForServer(alpha, [alpha, beta]);
    expect(model.rows).toEqual([
      { id: "alpha", name: "Example Corp Graph", transport: "http", selected: true },
    ]);
    expect(model.defaultPackMeta).toEqual({
      id: "example-corp-graph",
      label: "Example Corp Graph",
      version: "1.0.0",
    });
  });

  test("slug generation preserves dot underscore dash and prefixes non-alphanumeric starts", () => {
    const server = httpServer({ id: brand("s"), name: "...Example_Corp.Graph" });
    const model = buildExportFlowModelForServer(server, [server]);
    expect(model.defaultPackMeta.id).toBe("server...example_corp.graph");
  });

  test("empty slug falls back to server", () => {
    const server = httpServer({ id: brand("s"), name: "!!!" });
    const model = buildExportFlowModelForServer(server, [server]);
    expect(model.defaultPackMeta.id).toBe("server");
  });

  test("slug collisions get deterministic row-order suffixes", () => {
    const first = httpServer({ id: brand("a"), name: "Example Graph" });
    const second = httpServer({ id: brand("b"), name: "Example---Graph" });
    const third = httpServer({ id: brand("c"), name: "Example Graph!" });
    expect(buildExportFlowModelForServer(first, [first, second, third]).defaultPackMeta.id).toBe("example-graph");
    expect(buildExportFlowModelForServer(second, [first, second, third]).defaultPackMeta.id).toBe("example-graph-2");
    expect(buildExportFlowModelForServer(third, [first, second, third]).defaultPackMeta.id).toBe("example-graph-3");
  });
});

describe("toggleSelection", () => {
  test("flips the matching row and leaves others untouched", () => {
    const rows = [
      { id: "a", name: "A", transport: "http" as const, selected: false },
      { id: "b", name: "B", transport: "http" as const, selected: false },
    ];
    const next = toggleSelection(rows, "a");
    expect(next[0].selected).toBe(true);
    expect(next[1].selected).toBe(false);
    expect(rows[0].selected).toBe(false);
  });
});

describe("runExport", () => {
  test("no selection returns no-selection error", () => {
    const server = httpServer();
    const rows = [{ id: "s1", name: "x", transport: "http" as const, selected: false }];
    const result = runExport(rows, [server], {
      id: "p",
      label: "L",
      version: "1",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("no-selection");
  });

  test("static-bearer secret is templatized in the round-trip (SC-009)", () => {
    const server = httpServer({
      authorization: "Bearer SECRET_TOKEN_123",
    });
    const rows = [{ id: "s1", name: server.name, transport: "http" as const, selected: true }];
    const result = runExport(rows, [server], {
      id: "exp",
      label: "Exported",
      version: "1",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.serialized).toContain(SECRET_PLACEHOLDER);
    expect(result.serialized).not.toContain("SECRET_TOKEN_123");
    // Validates as a real pack
    const validation = validatePack(result.pack);
    expect(validation.ok).toBe(true);
  });

  test("none credentials roundtrip do not introduce placeholders (SC-009)", () => {
    const server = httpServer({ id: brand("ok"), name: "Open" });
    const rows = [{ id: "ok", name: "Open", transport: "http" as const, selected: true }];
    const result = runExport(rows, [server], {
      id: "exp",
      label: "Exported",
      version: "1",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.serialized).not.toContain(SECRET_PLACEHOLDER);
  });

  test("SC-002: 1, 5, and 20 servers all roundtrip and validate", () => {
    for (const n of [1, 5, 20]) {
      const servers: McpServerConfig[] = Array.from({ length: n }, (_, i) =>
        httpServer({ id: brand(`s${i}`), name: `Server ${i}` }),
      );
      const rows = servers.map((s) => ({
        id: s.id,
        name: s.name,
        transport: s.transport as "http",
        selected: true,
      }));
      const result = runExport(rows, servers, {
        id: `pack${n}`,
        label: `Pack ${n}`,
        version: "1",
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.pack.presets).toHaveLength(n);
      expect(validatePack(result.pack).ok).toBe(true);
    }
  });

  test("JSON output uses 2-space indent", () => {
    const server = httpServer();
    const rows = [{ id: "s1", name: server.name, transport: "http" as const, selected: true }];
    const result = runExport(rows, [server], { id: "p", label: "L", version: "1" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.serialized.startsWith("{\n  ")).toBe(true);
  });

  test("single-server model exports exactly one selected server", () => {
    const alpha = httpServer({ id: brand("alpha"), name: "Alpha" });
    const beta = httpServer({ id: brand("beta"), name: "Beta" });
    const model = buildExportFlowModelForServer(beta, [alpha, beta]);
    const exportedNames: string[][] = [];
    const result = runExport(model.rows, [alpha, beta], model.defaultPackMeta, (servers, meta) => {
      exportedNames.push(servers.map((server) => server.name));
      return {
        schemaVersion: 1,
        id: meta.id,
        label: meta.label,
        version: meta.version,
        presets: [
          {
            id: "beta",
            label: "Beta",
            server: { name: "Beta", transport: "http", url: "https://example.org/mcp" },
            credentials: { kind: "none" },
          },
        ],
      };
    });
    expect(result.ok).toBe(true);
    expect(exportedNames).toEqual([["Beta"]]);
  });
});

describe("suggestedFilename", () => {
  test("slugifies the label", () => {
    expect(suggestedFilename({ id: "x", label: "My Cool Pack!", version: "1" })).toBe(
      "my-cool-pack.pack.json",
    );
  });

  test("falls back to id when label produces an empty slug", () => {
    expect(suggestedFilename({ id: "fallback", label: "!!!", version: "1" })).toBe(
      "fallback.pack.json",
    );
  });

  test("truncates to 64 chars", () => {
    const long = "a".repeat(200);
    const name = suggestedFilename({ id: "x", label: long, version: "1" });
    expect(name.length).toBeLessThanOrEqual("a".repeat(64).length + ".pack.json".length);
  });
});
