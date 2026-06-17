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

  test("Content-Length above the body cap rejects before reading", async () => {
    const fetch = vi.fn(
      async () =>
        new Response("ok", {
          headers: { "content-length": "9" },
        }),
    );
    await expect(
      createMcpHttpFetchWrapper(fetch as unknown as typeof globalThis.fetch, 8)(
        "https://example.com/mcp",
      ),
    ).rejects.toThrow(/exceeds 8 bytes/);
  });

  test("chunked HTTP response above the body cap rejects while reading", async () => {
    const fetch = vi.fn(async () => new Response(chunked(["abc", "def"])));
    const response = await createMcpHttpFetchWrapper(
      fetch as unknown as typeof globalThis.fetch,
      5,
    )("https://example.com/mcp");
    await expect(response.text()).rejects.toThrow(/HTTP response exceeds 5 bytes/);
  });

  test("SSE event above the accumulator cap rejects while reading", async () => {
    const fetch = vi.fn(
      async () =>
        new Response(chunked(["data: aaa"]), {
          headers: { "content-type": "text/event-stream" },
        }),
    );
    const response = await createMcpHttpFetchWrapper(
      fetch as unknown as typeof globalThis.fetch,
      8,
    )("https://example.com/mcp");
    await expect(response.text()).rejects.toThrow(/SSE event exceeds 8 bytes/);
  });
});

function redirect(location: string): Response {
  return new Response(null, { status: 302, headers: { location } });
}

function chunked(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}
