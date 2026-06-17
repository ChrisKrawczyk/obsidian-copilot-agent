import { describe, expect, test } from "vitest";
import { redactSensitive } from "./redactSensitive";

describe("redactSensitive", () => {
  test("redacts Authorization and bearer values", () => {
    expect(redactSensitive("Authorization: Bearer abc.def")).toBe(
      "Authorization: [REDACTED]",
    );
    expect(redactSensitive("error Bearer secret-token")).toContain(
      "Bearer [REDACTED]",
    );
  });

  test("redacts Mcp-Session-Id header and query variants", () => {
    const out = redactSensitive(
      "Mcp-Session-Id: sid123 https://x.test/mcp?mcp_session_id=sid456",
    );
    expect(out).not.toContain("sid123");
    expect(out).not.toContain("sid456");
    expect(out).toContain("Mcp-Session-Id: [REDACTED]");
    expect(out).toContain("mcp_session_id=[REDACTED]");
  });

  test("redacts URL userinfo and token query params", () => {
    const out = redactSensitive(
      "https://user:pass@example.test/a?token=t&api_key=k&safe=ok&access_token=a",
    );
    expect(out).toContain("https://[REDACTED]@example.test");
    expect(out).toContain("token=[REDACTED]");
    expect(out).toContain("api_key=[REDACTED]");
    expect(out).toContain("access_token=[REDACTED]");
    expect(out).toContain("safe=ok");
  });

  test("redacts every env denylist pattern", () => {
    const keys = [
      "GITHUB_TOKEN",
      "GH_TOKEN",
      "COPILOT_FOO",
      "OPENAI_API_KEY",
      "ANTHROPIC_API_KEY",
      "AZURE_OPENAI_KEY",
      "AWS_SECRET_ACCESS_KEY",
      "GCP_TOKEN",
      "SERVICE_TOKEN",
      "SERVICE_API_KEY",
      "SERVICE_SECRET",
      "SERVICE_PASSWORD",
    ];
    const out = redactSensitive(keys.map((key) => `${key}=secret`).join("\n"));
    for (const key of keys) {
      expect(out).toContain(`${key}=[REDACTED]`);
    }
    expect(out).not.toContain("secret");
  });

  test("redacts SDK Error.message and stack strings", () => {
    const err = new Error(
      "request failed: Authorization: Bearer abc Mcp-Session-Id=sid",
    );
    err.stack = `Error: ${err.message}\n    at run (file.js:1:1)\nOPENAI_API_KEY=sk`;
    const out = redactSensitive(`${err.message}\n${err.stack}`);
    expect(out).not.toContain("abc");
    expect(out).not.toContain("sid");
    expect(out).not.toContain("sk");
    expect(out).toContain("[REDACTED]");
  });
});
