import { describe, expect, test, vi } from "vitest";
import schema from "../../../docs/schemas/preset-pack-v1.json";
import { RESERVED_BUILTIN_PACK_ID, validatePack } from "./packValidator";

type SchemaNode = Record<string, unknown>;

function definition(name: string): SchemaNode {
  return (schema.definitions as Record<string, SchemaNode>)[name];
}

function minimalPack(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    id: "example-corp-graph",
    label: "Example Corp Graph",
    version: "1.0.0",
    presets: [
      {
        id: "internal-mcp-cli",
        label: "Internal MCP CLI",
        server: {
          name: "Internal MCP CLI",
          transport: "http",
          url: "https://example.org/mcp",
        },
        credentials: { kind: "none" },
      },
    ],
    ...overrides,
  };
}

function commentsOf(value: unknown): string {
  if (!value || typeof value !== "object") return "";
  const chunks: string[] = [];
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (key === "$comment" || key === "description") chunks.push(String(child));
    else if (typeof child === "object") chunks.push(commentsOf(child));
  }
  return chunks.join("\n");
}

function branchConstNames(defName: string, property: string): string[] {
  const node = definition(defName);
  const oneOf = node.oneOf as Array<{ $ref?: string }>;
  return oneOf.map((branch) => {
    const refName = branch.$ref?.replace("#/definitions/", "");
    const resolved = refName ? definition(refName) : (branch as SchemaNode);
    return ((resolved.properties as Record<string, SchemaNode>)[property] as SchemaNode).const as string;
  }).sort();
}

describe("preset pack JSON Schema drift gate", () => {
  test("top-level pack invariants mirror validatePack basics", () => {
    expect(schema.$schema).toBe("http://json-schema.org/draft-07/schema#");
    expect(schema.required).toEqual(["schemaVersion", "id", "label", "version", "presets"]);
    expect(schema.additionalProperties).toBe(true);
    expect(schema.properties.schemaVersion.const).toBe(1);
    expect(schema.properties.id.not.const).toBe(RESERVED_BUILTIN_PACK_ID);
    expect(schema.properties.presets.minItems).toBe(1);
  });

  test("preset shape is strict and uses the runtime preset-id pattern", () => {
    const preset = definition("preset");
    expect(preset.required).toEqual(["id", "label", "server", "credentials"]);
    expect(preset.additionalProperties).toBe(false);
    expect(((preset.properties as Record<string, SchemaNode>).id as SchemaNode).pattern).toBe(
      "^[A-Za-z0-9][A-Za-z0-9._-]*$",
    );
  });

  test("server and credential branches cover runtime discriminants", () => {
    expect(branchConstNames("server", "transport")).toEqual(["http", "stdio"]);
    expect(branchConstNames("credentials", "kind")).toEqual([
      "command-based",
      "none",
      "oauth-pkce",
      "static-bearer",
    ]);
  });

  test("preflight shape mirrors the accepted findOnPath form", () => {
    const preflight = definition("preflight");
    expect(preflight.required).toEqual(["type", "command"]);
    expect(((preflight.properties as Record<string, SchemaNode>).type as SchemaNode).const).toBe("findOnPath");
  });

  test("accepted fixture families have matching schema structure", () => {
    const fixtures = [
      minimalPack(),
      minimalPack({
        presets: [
          {
            id: "stdio-tool",
            label: "Stdio Tool",
            server: {
              name: "internal-mcp-cli",
              transport: "stdio",
              command: "internal-mcp-cli",
              args: ["--endpoint", "https://example.org/mcp"],
              env: { MCP_LOG_LEVEL: "info" },
            },
            credentials: { kind: "none" },
            preflight: { type: "findOnPath", command: "internal-mcp-cli" },
          },
        ],
      }),
      minimalPack({
        presets: [
          {
            id: "bearer",
            label: "Bearer",
            server: { name: "Bearer", transport: "http", url: "https://example.org/mcp" },
            credentials: { kind: "static-bearer", token: "__NEEDS_VALUE__" },
          },
          {
            id: "command",
            label: "Command",
            server: { name: "Command", transport: "http", url: "https://example.org/mcp" },
            credentials: {
              kind: "command-based",
              command: "internal-mcp-cli",
              args: ["token"],
              tokenPath: "accessToken",
              expiryPath: "expiresOn",
              refreshBufferSeconds: 300,
            },
          },
          {
            id: "oauth",
            label: "OAuth",
            server: { name: "OAuth", transport: "http", url: "https://example.org/mcp" },
            credentials: {
              kind: "oauth-pkce",
              authorizationEndpoint: "https://example.org/authorize",
              tokenEndpoint: "https://example.org/token",
              clientId: "example-corp-graph",
              scopes: ["graph.read"],
              refreshTokenRef: "__NEEDS_VALUE__",
            },
          },
        ],
      }),
    ];

    for (const fixture of fixtures) {
      expect(validatePack(fixture).ok).toBe(true);
    }
    expect(branchConstNames("server", "transport")).toEqual(["http", "stdio"]);
    expect(branchConstNames("credentials", "kind")).toContain("oauth-pkce");
    expect(definition("preflight").properties).toHaveProperty("installHint");
  });

  test("schema-expressible rejected families are represented structurally", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const cases = [
      { pack: { ...minimalPack(), schemaVersion: 2 }, schemaCheck: () => schema.properties.schemaVersion.const === 1 },
      { pack: { ...minimalPack(), id: "builtin" }, schemaCheck: () => schema.properties.id.not.const === "builtin" },
      {
        pack: minimalPack({
          presets: [
            {
              id: ".bad",
              label: "Bad",
              server: { name: "Bad", transport: "http", url: "https://example.org/mcp" },
              credentials: { kind: "none" },
            },
          ],
        }),
        schemaCheck: () => ((definition("preset").properties as Record<string, SchemaNode>).id as SchemaNode).pattern,
      },
      {
        pack: minimalPack({
          presets: [
            {
              id: "bad",
              label: "Bad",
              server: { name: "Bad", transport: "http", url: "https://example.org/mcp" },
              credentials: { kind: "unsupported" },
            },
          ],
        }),
        schemaCheck: () => branchConstNames("credentials", "kind").length === 4,
      },
      {
        pack: minimalPack({
          presets: [
            {
              id: "bad",
              label: "Bad",
              server: { name: "Bad", transport: "http", url: "https://example.org/mcp" },
              credentials: { kind: "none" },
              extra: true,
            },
          ],
        }),
        schemaCheck: () => definition("preset").additionalProperties === false,
      },
    ];

    for (const entry of cases) {
      expect(validatePack(entry.pack).ok).toBe(false);
      expect(entry.schemaCheck()).toBeTruthy();
    }
    warn.mockRestore();
  });

  test("validator-only rejected families are documented instead of over-promised", () => {
    const duplicate = minimalPack({
      presets: [
        {
          id: "dup",
          label: "Dup A",
          server: { name: "Dup A", transport: "http", url: "https://example.org/mcp" },
          credentials: { kind: "none" },
        },
        {
          id: "dup",
          label: "Dup B",
          server: { name: "Dup B", transport: "http", url: "https://example.org/mcp" },
          credentials: { kind: "none" },
        },
      ],
    });
    const publicHttp = minimalPack({
      presets: [
        {
          id: "plain-http",
          label: "Plain HTTP",
          server: { name: "Plain HTTP", transport: "http", url: "http://example.org/mcp" },
          credentials: { kind: "none" },
        },
      ],
    });

    expect(validatePack(duplicate).ok).toBe(false);
    expect(validatePack(publicHttp).ok).toBe(false);
    const comments = commentsOf(schema);
    for (const phrase of ["Duplicate preset ids", "strict JSON", "JSONC", "1 MB", "100 KB", "URL"]) {
      expect(comments).toContain(phrase);
    }
  });
});
