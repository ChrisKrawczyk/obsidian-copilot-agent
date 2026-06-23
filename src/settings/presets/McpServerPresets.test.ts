import { describe, expect, test } from "vitest";
import {
  BUILT_IN_PRESETS,
  M365_GRAPH_COMMAND,
  M365_GRAPH_EXPIRY_PATH,
  M365_GRAPH_PRESET_ID,
  M365_GRAPH_REFRESH_BUFFER_SECONDS,
  M365_GRAPH_TOKEN_PATH,
  M365_GRAPH_URL,
  getPresetById,
} from "./McpServerPresets";

describe("McpServerPresets (FR-008 pinned values)", () => {
  test("BUILT_IN_PRESETS contains exactly the M365 Graph preset", () => {
    expect(BUILT_IN_PRESETS).toHaveLength(1);
    expect(BUILT_IN_PRESETS[0].id).toBe(M365_GRAPH_PRESET_ID);
    expect(BUILT_IN_PRESETS[0].label).toBe("Microsoft 365 Graph (via Azure CLI)");
  });

  test("M365 preset build() output is pinned to FR-008 values (snapshot)", () => {
    const preset = getPresetById(M365_GRAPH_PRESET_ID);
    expect(preset).toBeDefined();
    const result = preset!.build();
    expect(result).toEqual({
      server: {
        name: "Microsoft 365 Graph",
        transport: "http",
        url: "https://mcp.svc.cloud.microsoft/enterprise",
      },
      credentials: {
        kind: "command-based",
        command:
          "az account get-access-token --scope api://e8c77dc2-69b3-43f4-bc51-3213c9d915b4/.default --output json",
        tokenPath: "accessToken",
        expiryPath: "expiresOn",
        refreshBufferSeconds: 300,
      },
      preflight: {
        type: "findOnPath",
        command: "az",
        installHint: "winget install Microsoft.AzureCLI",
      },
    });
  });

  test("FR-008 constants match preset build output", () => {
    const result = BUILT_IN_PRESETS[0].build();
    expect(result.server.url).toBe(M365_GRAPH_URL);
    expect(result.credentials.kind).toBe("command-based");
    if (result.credentials.kind === "command-based") {
      expect(result.credentials.command).toBe(M365_GRAPH_COMMAND);
      expect(result.credentials.tokenPath).toBe(M365_GRAPH_TOKEN_PATH);
      expect(result.credentials.expiryPath).toBe(M365_GRAPH_EXPIRY_PATH);
      expect(result.credentials.refreshBufferSeconds).toBe(
        M365_GRAPH_REFRESH_BUFFER_SECONDS,
      );
    }
  });

  test("getPresetById returns undefined for unknown id", () => {
    expect(getPresetById("not-a-preset")).toBeUndefined();
  });

  test("preset list is frozen — registry is immutable at runtime", () => {
    expect(Object.isFrozen(BUILT_IN_PRESETS)).toBe(true);
  });
});
