import type { ServerCredentials } from "../../mcp/credentials/CredentialTypes";

/**
 * Optional preflight check for a preset. The settings UI calls
 * `pathExists(command)` (or a real `findOnPath` probe at runtime) to decide
 * whether to show the install hint. Saving is never blocked by a failing
 * preflight (FR-018 — install hints are non-blocking).
 */
export interface McpServerPresetPreflight {
  type: "findOnPath";
  command: string;
  installHint?: string;
}

export interface PartialHttpServerInput {
  url: string;
  transport: "http";
  name: string;
}

export interface McpServerPresetBuildResult {
  server: PartialHttpServerInput;
  credentials: ServerCredentials;
  preflight?: McpServerPresetPreflight;
}

export interface McpServerPreset {
  id: string;
  label: string;
  description?: string;
  build(): McpServerPresetBuildResult;
}

export const M365_GRAPH_PRESET_ID = "m365-graph-az-cli";
export const M365_GRAPH_URL = "https://mcp.svc.cloud.microsoft/enterprise";
export const M365_GRAPH_COMMAND =
  "az account get-access-token --scope api://e8c77dc2-69b3-43f4-bc51-3213c9d915b4/.default --output json";
export const M365_GRAPH_REFRESH_BUFFER_SECONDS = 300;
export const M365_GRAPH_TOKEN_PATH = "accessToken";
export const M365_GRAPH_EXPIRY_PATH = "expiresOn";

/**
 * Spec FR-008: the only preset shipped today. Builder values are pinned by
 * a snapshot test in `McpServerPresets.test.ts`; intentional drift requires
 * updating both the constants above and the snapshot.
 */
const M365_GRAPH_PRESET: McpServerPreset = {
  id: M365_GRAPH_PRESET_ID,
  label: "Microsoft 365 Graph (via Azure CLI)",
  description:
    "Microsoft 365 Graph MCP via Azure CLI token. Requires `az` signed in to the target tenant.",
  build(): McpServerPresetBuildResult {
    return {
      server: {
        name: "Microsoft 365 Graph",
        transport: "http",
        url: M365_GRAPH_URL,
      },
      credentials: {
        kind: "command-based",
        command: M365_GRAPH_COMMAND,
        tokenPath: M365_GRAPH_TOKEN_PATH,
        expiryPath: M365_GRAPH_EXPIRY_PATH,
        refreshBufferSeconds: M365_GRAPH_REFRESH_BUFFER_SECONDS,
      },
      preflight: {
        type: "findOnPath",
        command: "az",
        installHint: "winget install Microsoft.AzureCLI",
      },
    };
  },
};

export const BUILT_IN_PRESETS: readonly McpServerPreset[] = Object.freeze([
  M365_GRAPH_PRESET,
]);

export function getPresetById(id: string): McpServerPreset | undefined {
  return BUILT_IN_PRESETS.find((p) => p.id === id);
}
