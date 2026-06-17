import { describe, expect, test, vi } from "vitest";
import { createMcpHttpFetchWrapper } from "./McpServerRuntime";

describe("MCP HTTP fetch wrapper", () => {
  test("same-origin 302 keeps Authorization", async () => {
    const seen: string[] = [];
    const fetch = vi.fn(async (url: URL, init?: RequestInit) => {
      seen.push(`${url.href}:${new Headers(init?.headers).get("Authorization")}`);
      return seen.length === 1
        ? redirect("https://example.com/next")
        : new Response("ok");
    });
    await createMcpHttpFetchWrapper(fetch as unknown as typeof globalThis.fetch)(
      "https://example.com/mcp",
      { headers: { Authorization: "Bearer abc" } },
    );
    expect(seen[1]).toBe("https://example.com/next:Bearer abc");
  });

  test("cross-origin 302 drops Authorization and Mcp-Session-Id", async () => {
    const seen: string[] = [];
    const fetch = vi.fn(async (url: URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      seen.push(`${url.host}:${headers.get("Authorization")}:${headers.get("Mcp-Session-Id")}`);
      return seen.length === 1
        ? redirect("https://other.example/mcp")
        : new Response("ok");
    });
    await createMcpHttpFetchWrapper(fetch as unknown as typeof globalThis.fetch)(
      "https://example.com/mcp",
      { headers: { Authorization: "Bearer abc", "Mcp-Session-Id": "sid" } },
    );
    expect(seen[1]).toBe("other.example:null:null");
  });

  test("hop 4 rejects", async () => {
    const fetch = vi.fn(async (_url: URL) => redirect("https://example.com/again"));
    await expect(
      createMcpHttpFetchWrapper(fetch as unknown as typeof globalThis.fetch)(
        "https://example.com/mcp",
      ),
    ).rejects.toThrow(/redirect limit/);
  });

  test("redirect to metadata rejects", async () => {
    const fetch = vi.fn(async () => redirect("https://169.254.169.254/latest"));
    await expect(
      createMcpHttpFetchWrapper(fetch as unknown as typeof globalThis.fetch)(
        "https://example.com/mcp",
      ),
    ).rejects.toThrow(/metadata/);
  });

  test("TLS bypass attempts fail", async () => {
    const fetch = vi.fn(async () => new Response("ok"));
    await expect(
      createMcpHttpFetchWrapper(fetch as unknown as typeof globalThis.fetch)(
        "https://example.com/mcp",
        { skipTls: true } as RequestInit,
      ),
    ).rejects.toThrow(/TLS bypass/);
  });
});

function redirect(location: string): Response {
  return new Response(null, { status: 302, headers: { location } });
}
