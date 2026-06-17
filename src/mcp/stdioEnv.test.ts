import { describe, expect, test } from "vitest";
import { buildStdioEnv, matchDenylist } from "./stdioEnv";

describe("buildStdioEnv", () => {
  test.each([
    ["GITHUB_TOKEN"],
    ["GH_TOKEN"],
    ["COPILOT_FOO"],
    ["COPILOT_AGENT_BAR"],
    ["OPENAI_API_KEY"],
    ["ANTHROPIC_API_KEY"],
    ["AZURE_OPENAI_ENDPOINT"],
    ["AWS_PROFILE"],
    ["GCP_PROJECT"],
    ["GOOGLE_APPLICATION_CREDENTIALS"],
    ["SSH_AUTH_SOCK"],
    ["SSH_PRIVATE_KEY"],
    ["SERVICE_TOKEN"],
    ["SERVICE_API_KEY"],
    ["SERVICE_SECRET"],
    ["SERVICE_PASSWORD"],
  ])("filters denylisted inherited key %s", (key) => {
    const result = buildStdioEnv({
      inheritedEnv: { [key]: "secret", PATH: "bin" },
      platform: "linux",
    });
    expect(result.env[key]).toBeUndefined();
    expect(result.env.PATH).toBe("bin");
  });

  test("filters exact and wildcard denied variables", () => {
    const result = buildStdioEnv({
      inheritedEnv: {
        GITHUB_TOKEN: "x",
        GH_TOKEN: "x",
        COPILOT_AGENT_TOKEN: "x",
        OPENAI_API_KEY: "x",
        ANTHROPIC_API_KEY: "x",
        AWS_REGION: "x",
        GCP_PROJECT: "x",
        SERVICE_TOKEN: "x",
        SERVICE_API_KEY: "x",
        SERVICE_SECRET: "x",
        SERVICE_PASSWORD: "x",
        PATH: "bin",
        HOME: "home",
      },
      platform: "linux",
    });
    expect(result.env).toEqual({ PATH: "bin", HOME: "home" });
  });

  test("injects explicit env after filtering and reports denylist overrides", () => {
    const result = buildStdioEnv({
      inheritedEnv: { GITHUB_TOKEN: "inherited", SAFE: "1" },
      explicitEnv: { GITHUB_TOKEN: "explicit", SAFE2: "2" },
      platform: "linux",
    });
    expect(result.env.GITHUB_TOKEN).toBe("explicit");
    expect(result.env.SAFE).toBe("1");
    expect(result.env.SAFE2).toBe("2");
    expect(result.explicitDenylistOverrides).toEqual([
      { key: "GITHUB_TOKEN", pattern: "GITHUB_TOKEN" },
    ]);
  });

  test("does not warn for non-denylisted explicit keys", () => {
    const result = buildStdioEnv({
      inheritedEnv: {},
      explicitEnv: { MCP_MODE: "test" },
    });
    expect(result.explicitDenylistOverrides).toHaveLength(0);
  });

  test("prepends macOS Homebrew paths before inherited PATH without duplicates", () => {
    const result = buildStdioEnv({
      inheritedEnv: { PATH: "/opt/homebrew/bin:/bin" },
      platform: "darwin",
    });
    expect(result.env.PATH).toBe("/usr/local/bin:/opt/homebrew/bin:/bin");
  });

  test("matches Windows environment keys case-insensitively", () => {
    const result = buildStdioEnv({
      inheritedEnv: { github_token: "x", Path: "bin" },
      explicitEnv: { service_password: "p" },
      platform: "win32",
    });
    expect(result.env.github_token).toBeUndefined();
    expect(result.env.service_password).toBe("p");
    expect(result.explicitDenylistOverrides[0]?.pattern).toBe("*_PASSWORD");
  });

  test("matchDenylist returns null for ordinary usability variables", () => {
    expect(matchDenylist("TMP")).toBeNull();
    expect(matchDenylist("USERPROFILE")).toBeNull();
  });
});
