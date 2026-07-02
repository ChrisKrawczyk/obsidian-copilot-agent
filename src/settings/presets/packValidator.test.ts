import { describe, expect, test, vi } from "vitest";
import { RESERVED_BUILTIN_PACK_ID, validatePack } from "./packValidator";

function minimalPack(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    id: "vendor-pack",
    label: "Vendor Pack",
    version: "1.0.0",
    presets: [
      {
        id: "p1",
        label: "Preset 1",
        server: {
          name: "Preset 1",
          transport: "http",
          url: "https://example.org/mcp",
        },
        credentials: { kind: "none" },
      },
    ],
    ...overrides,
  };
}

describe("validatePack — single-error contract (SC-003)", () => {
  test("minimal valid pack accepted", () => {
    const result = validatePack(minimalPack());
    expect(result.ok).toBe(true);
    expect(result.pack?.id).toBe("vendor-pack");
  });

  test("missing top-level id → pointer /id", () => {
    const { id: _drop, ...rest } = minimalPack();
    const result = validatePack(rest);
    expect(result.ok).toBe(false);
    expect(result.error?.pointer).toBe("/id");
  });

  test("missing server.command on stdio preset → pointer /presets/0/server/command", () => {
    const pack = minimalPack({
      presets: [
        {
          id: "p1",
          label: "p",
          server: { name: "p", transport: "stdio" },
          credentials: { kind: "none" },
        },
      ],
    });
    const result = validatePack(pack);
    expect(result.ok).toBe(false);
    expect(result.error?.pointer).toBe("/presets/0/server/command");
  });

  test("unknown preset-level field rejected", () => {
    const pack = minimalPack({
      presets: [
        {
          id: "p1",
          label: "p",
          server: {
            name: "p",
            transport: "http",
            url: "https://example.org/mcp",
          },
          credentials: { kind: "none" },
          rogue: 1,
        },
      ],
    });
    const result = validatePack(pack);
    expect(result.ok).toBe(false);
    expect(result.error?.pointer).toBe("/presets/0/rogue");
  });

  test("unknown TOP-level field is warned-and-accepted", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = validatePack(minimalPack({ futureField: "ok" }));
    expect(result.ok).toBe(true);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  test("duplicate preset ids rejected with pointer to second occurrence", () => {
    const pack = minimalPack({
      presets: [
        {
          id: "dup",
          label: "a",
          server: { name: "a", transport: "http", url: "https://example.org/mcp" },
          credentials: { kind: "none" },
        },
        {
          id: "dup",
          label: "b",
          server: { name: "b", transport: "http", url: "https://example.org/mcp" },
          credentials: { kind: "none" },
        },
      ],
    });
    const result = validatePack(pack);
    expect(result.ok).toBe(false);
    expect(result.error?.pointer).toBe("/presets/1/id");
  });

  test("empty presets[] rejected", () => {
    const result = validatePack(minimalPack({ presets: [] }));
    expect(result.ok).toBe(false);
    expect(result.error?.pointer).toBe("/presets");
  });

  test("each credential kind accepted", () => {
    const kinds = [
      { kind: "none" },
      { kind: "static-bearer", token: "t" },
      { kind: "command-based", command: "azd token" },
      {
        kind: "oauth-pkce",
        authorizationEndpoint: "https://example.org/a",
        tokenEndpoint: "https://example.org/t",
        clientId: "cid",
        scopes: ["s"],
      },
    ];
    for (const credentials of kinds) {
      const pack = minimalPack({
        presets: [
          {
            id: "p",
            label: "p",
            server: { name: "p", transport: "http", url: "https://example.org/mcp" },
            credentials,
          },
        ],
      });
      const result = validatePack(pack);
      expect(result.ok, JSON.stringify(credentials)).toBe(true);
    }
  });

  test("static-bearer with empty token rejected", () => {
    const pack = minimalPack({
      presets: [
        {
          id: "p",
          label: "p",
          server: { name: "p", transport: "http", url: "https://example.org/mcp" },
          credentials: { kind: "static-bearer", token: "" },
        },
      ],
    });
    const result = validatePack(pack);
    expect(result.ok).toBe(false);
    expect(result.error?.pointer).toBe("/presets/0/credentials/token");
  });

  test("HTTP URL guardrails enforced (no plain-http public URL)", () => {
    const pack = minimalPack({
      presets: [
        {
          id: "p",
          label: "p",
          server: { name: "p", transport: "http", url: "http://example.org/mcp" },
          credentials: { kind: "none" },
        },
      ],
    });
    const result = validatePack(pack);
    expect(result.ok).toBe(false);
    expect(result.error?.pointer).toBe("/presets/0/server/url");
  });

  test("stdio command with control character rejected", () => {
    const pack = minimalPack({
      presets: [
        {
          id: "p",
          label: "p",
          server: { name: "p", transport: "stdio", command: "bad\u0001cmd" },
          credentials: { kind: "none" },
        },
      ],
    });
    const result = validatePack(pack);
    expect(result.ok).toBe(false);
    expect(result.error?.pointer).toBe("/presets/0/server/command");
  });

  test("preflight with unknown type rejected", () => {
    const pack = minimalPack({
      presets: [
        {
          id: "p",
          label: "p",
          server: { name: "p", transport: "http", url: "https://example.org/mcp" },
          credentials: { kind: "none" },
          preflight: { type: "rogue", command: "x" },
        },
      ],
    });
    const result = validatePack(pack);
    expect(result.ok).toBe(false);
    expect(result.error?.pointer).toBe("/presets/0/preflight/type");
  });

  test("pack id 'builtin' is reserved and rejected", () => {
    const pack = minimalPack({ id: RESERVED_BUILTIN_PACK_ID });
    const result = validatePack(pack);
    expect(result.ok).toBe(false);
    expect(result.error?.pointer).toBe("/id");
    expect(result.error?.message).toMatch(/reserved/i);
  });

  test("single-error contract: validator returns FIRST error and stops", () => {
    // Two simultaneous errors: bad id AND bad presets shape.
    const pack = { schemaVersion: 1, id: "", label: "X", version: "1", presets: 0 };
    const result = validatePack(pack);
    expect(result.ok).toBe(false);
    expect(result.error?.pointer).toBe("/id");
    // No second error is returned: result shape carries only `error`.
    expect(Array.isArray((result as unknown as { errors?: unknown }).errors)).toBe(false);
  });

  test("RFC 6901 escaping for field names containing '/' and '~'", () => {
    // Place an unknown preset-level field whose key contains '/' and '~'.
    const pack = minimalPack({
      presets: [
        {
          id: "p",
          label: "p",
          server: { name: "p", transport: "http", url: "https://example.org/mcp" },
          credentials: { kind: "none" },
          ["a/b~c"]: 1,
        },
      ],
    });
    const result = validatePack(pack);
    expect(result.ok).toBe(false);
    // '/' -> '~1', '~' -> '~0'
    expect(result.error?.pointer).toBe("/presets/0/a~1b~0c");
  });
});
