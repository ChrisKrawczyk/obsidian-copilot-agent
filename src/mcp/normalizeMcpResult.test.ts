import { describe, expect, test } from "vitest";
import { normalizeMcpArgs, normalizeMcpResult } from "./normalizeMcpResult";

describe("normalizeMcpResult", () => {
  test("mixed text and structured content is readable", () => {
    const out = normalizeMcpResult({
      content: [{ type: "text", text: "hello" }],
      structuredContent: { ok: true },
    });
    expect(out.content).toContain("hello");
    expect(out.content).toContain('"ok": true');
    expect(out.isError).toBe(false);
  });

  test("binary content becomes placeholders and raw base64 is omitted", () => {
    const base64 = "aGVsbG8=";
    const out = normalizeMcpResult({ content: [{ type: "image", mimeType: "image/png", data: base64 }] });
    expect(out.content).toContain("[image: image/png, 5 bytes]");
    expect(out.content).not.toContain(base64);
  });

  test("resource binary, isError, and JSON-RPC error are normalized distinctly", () => {
    expect(normalizeMcpResult({ isError: true, content: [{ type: "text", text: "tool failed" }] })).toMatchObject({ isError: true, errorKind: "mcp" });
    expect(normalizeMcpResult({ error: { code: -32000, message: "rpc failed" } })).toMatchObject({ isError: true, errorKind: "json-rpc" });
    expect(normalizeMcpResult({ content: [{ type: "resource", resource: { uri: "file://x", mimeType: "application/octet-stream", blob: "AAAA" } }] }).content).toContain("[resource: application/octet-stream, 3 bytes]");
  });

  test("args and results are redacted and truncated", () => {
    expect(normalizeMcpArgs({ Authorization: "Bearer secret" })).not.toContain("secret");
    const out = normalizeMcpResult({ content: [{ type: "text", text: `OPENAI_API_KEY=sk\n${"x".repeat(5000)}` }] });
    expect(out.content).not.toContain("sk");
    expect(out.content).toContain("[truncated]");
  });
});
