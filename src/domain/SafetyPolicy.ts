// SafetyPolicy: pure decision module gating every tool call.
//
// Inputs are explicit. There is no I/O. The decision function returns
// one of three outcomes; the AgentSession `handlePermission` callback
// is responsible for mapping the decision to the SDK
// `PermissionRequestResult` (and for blocking on user input when the
// outcome is `require-approval`).
//
// Source buckets:
//   - `vault`              — our registered create_file/edit_file/delete_file tools acting on a vault path
//   - `extra-vault`        — same tools acting on an extra-vault root (Phase 7+)
//   - `mcp`                — MCP server tool calls
//   - `builtin`            — every other SDK permission kind (shell, url, memory, hook, read, write, custom-tool we didn't register)
//
// Default modes:
//   - For `vault` and `extra-vault`: configurable (auto-apply-with-undo | require-approval)
//   - For `mcp` and `builtin`: always `require-approval` by spec; user opts in via per-source/per-tool toggles or per-session grants

export type SafetySource = "vault" | "extra-vault" | "mcp" | "builtin";

export type SafetyMode = "auto-apply-with-undo" | "require-approval";

export type SafetyDecision = "auto-apply" | "require-approval" | "rejected";

export interface SafetyDecisionResult {
  decision: SafetyDecision;
  /** Human-readable reason — useful for the chat block and logging. */
  reason: string;
}

import type { McpServerId, McpTrustEpoch } from "../mcp/McpTypes";

export interface SafetyPolicyInput {
  source: SafetySource;
  /** Custom or built-in tool name (e.g. "edit_file", "shell"); MCP server name not included. */
  toolName?: string;
  /** Stable MCP server id for MCP tool calls. Required for MCP auto-apply. */
  mcpServerId?: McpServerId;
  /** Exact MCP tool name for MCP tool calls. Required for MCP auto-apply. */
  mcpToolName?: string;
  /** Current server trust epoch for MCP tool calls. Required for MCP auto-apply. */
  mcpTrustEpoch?: McpTrustEpoch;
  /** Vault-relative path for vault writes; absolute path for extra-vault; undefined otherwise. */
  vaultRelativePath?: string;
  /** Extra-vault canonical root path; undefined otherwise (Phase 7+). */
  extraVaultRoot?: string;
}

export interface SafetyConfig {
  /** Default mode for filesystem writes. MCP and built-in are always require-approval by default. */
  fsDefaultMode: SafetyMode;
  /** Vault-relative path prefixes that auto-apply for vault writes. Each entry is a normalised vault path (no leading slash). */
  vaultAllowlist: string[];
  /** Per-built-in auto-approve toggles keyed by SDK permission `kind` (e.g. "shell", "url") or by tool name for custom-tool kind. */
  builtinAutoApprove: Record<string, boolean>;
  /** Per-MCP-server auto-approve toggles keyed by server name. Reserved for Phase 8; honoured here for forward compat. */
  mcpAutoApprove?: Record<string, boolean>;
}

/**
 * In-memory session-grants tracked by SafetyPolicy. Cleared on plugin
 * reload, conversation reset, or Obsidian restart per spec FR-013.
 *
 * Grants are intentionally narrow: a vault-write session grant covers
 * the WHOLE vault scope; an MCP grant covers a single exact
 * `(stable server id, tool name, trust epoch)` tuple; a
 * built-in grant covers a single `kind` (or for `custom-tool` kind, a
 * single tool name).
 */
export class SafetyState {
  private vaultGranted = false;
  /** Extra-vault grants keyed by canonical root path (Phase 7+). */
  private readonly extraVaultGranted = new Set<string>();
  private readonly mcpGranted = new Set<string>();
  private readonly builtinGranted = new Set<string>();

  grantVault(): void {
    this.vaultGranted = true;
  }
  grantExtraVault(rootPath: string): void {
    if (rootPath) this.extraVaultGranted.add(rootPath);
  }
  grantMcp(
    serverId: McpServerId,
    toolName: string,
    trustEpoch: McpTrustEpoch,
  ): void {
    const key = formatMcpGrantKey(serverId, toolName, trustEpoch);
    if (key) this.mcpGranted.add(key);
  }
  /** Grant by kind (e.g. "shell") or by tool name (for custom-tool kind). */
  grantBuiltin(key: string): void {
    if (key) this.builtinGranted.add(key);
  }

  isVaultGranted(): boolean {
    return this.vaultGranted;
  }
  isExtraVaultGranted(rootPath: string): boolean {
    return this.extraVaultGranted.has(rootPath);
  }
  isMcpGranted(
    serverId: McpServerId,
    toolName: string,
    trustEpoch: McpTrustEpoch,
  ): boolean {
    const key = formatMcpGrantKey(serverId, toolName, trustEpoch);
    return key ? this.mcpGranted.has(key) : false;
  }
  isBuiltinGranted(key: string): boolean {
    return this.builtinGranted.has(key);
  }

  /** Clear all session grants. Called on plugin reload / clear conversation. */
  clear(): void {
    this.vaultGranted = false;
    this.extraVaultGranted.clear();
    this.mcpGranted.clear();
    this.builtinGranted.clear();
  }
}

/** Normalise an allowlist entry to a vault-relative form for comparison. */
export function normaliseAllowlistEntry(raw: string): string {
  let s = (raw ?? "").trim();
  if (s.length === 0) return "";
  // Reject Windows absolute / UNC — those would be extra-vault entries.
  // Phase 6 vault-only allowlist: skip them silently rather than throwing
  // (a future phase will route them into extra-vault config).
  if (/^[a-zA-Z]:[\\/]/.test(s) || s.startsWith("\\\\")) return "";
  s = s.replace(/\\/g, "/");
  // Strip leading slashes — spec: "with no leading slash, or with leading slash, both normalize to the same scope".
  while (s.startsWith("/")) s = s.slice(1);
  // Strip trailing slash so prefix-matching works.
  while (s.length > 1 && s.endsWith("/")) s = s.slice(0, -1);
  // Reject traversal segments — defensive, since these would be
  // ineffective as allowlist entries but might confuse users.
  if (s.split("/").some((seg) => seg === "..")) return "";
  return s;
}

/** True if `vaultPath` is covered by the allowlist (exact match or `entry + "/" + …`). */
export function isVaultPathAllowlisted(
  vaultPath: string,
  allowlist: string[],
): boolean {
  const target = vaultPath.replace(/\\/g, "/").replace(/^\/+/, "");
  for (const raw of allowlist) {
    const entry = normaliseAllowlistEntry(raw);
    if (!entry) continue;
    if (target === entry) return true;
    if (target.startsWith(entry + "/")) return true;
  }
  return false;
}

/**
 * Decide the policy outcome for a single tool call.
 *
 * This function is intentionally pure: same inputs always produce the
 * same output. The caller is responsible for granting (via
 * `SafetyState.grant*`) when the user clicks "Approve for Session" in
 * the prompt UI.
 */
export function decideSafety(
  input: SafetyPolicyInput,
  config: SafetyConfig,
  state: SafetyState,
): SafetyDecisionResult {
  const {
    source,
    toolName,
    vaultRelativePath,
    extraVaultRoot,
    mcpServerId,
    mcpToolName,
    mcpTrustEpoch,
  } = input;

  switch (source) {
    case "vault": {
      if (state.isVaultGranted()) {
        return {
          decision: "auto-apply",
          reason: "Vault writes approved for this session.",
        };
      }
      if (
        vaultRelativePath !== undefined &&
        isVaultPathAllowlisted(vaultRelativePath, config.vaultAllowlist)
      ) {
        return {
          decision: "auto-apply",
          reason: `Path "${vaultRelativePath}" is covered by the allowlist.`,
        };
      }
      if (config.fsDefaultMode === "auto-apply-with-undo") {
        return {
          decision: "auto-apply",
          reason: "Default mode is auto-apply (with Undo).",
        };
      }
      return {
        decision: "require-approval",
        reason: "Default mode is require-approval for filesystem writes.",
      };
    }
    case "extra-vault": {
      if (extraVaultRoot && state.isExtraVaultGranted(extraVaultRoot)) {
        return {
          decision: "auto-apply",
          reason: `Extra-vault root "${extraVaultRoot}" approved for this session.`,
        };
      }
      if (config.fsDefaultMode === "auto-apply-with-undo") {
        return {
          decision: "auto-apply",
          reason: "Default mode is auto-apply (with Undo).",
        };
      }
      return {
        decision: "require-approval",
        reason: "Default mode is require-approval for filesystem writes.",
      };
    }
    case "mcp": {
      if (!mcpServerId || !mcpToolName || !mcpTrustEpoch) {
        return {
          decision: "require-approval",
          reason:
            "MCP tool calls require current server/tool trust metadata before auto-approval.",
        };
      }
      if (state.isMcpGranted(mcpServerId, mcpToolName, mcpTrustEpoch)) {
        return {
          decision: "auto-apply",
          reason: `MCP tool "${mcpToolName}" on server "${mcpServerId}" approved for this session.`,
        };
      }
      const key = formatMcpGrantKey(mcpServerId, mcpToolName, mcpTrustEpoch);
      if (config.mcpAutoApprove && config.mcpAutoApprove[key]) {
        return {
          decision: "auto-apply",
          reason: `MCP tool "${mcpToolName}" on server "${mcpServerId}" is auto-approved in settings.`,
        };
      }
      return {
        decision: "require-approval",
        reason: "MCP tool calls always require explicit approval by default.",
      };
    }
    case "builtin": {
      const key = toolName ?? "";
      if (key && state.isBuiltinGranted(key)) {
        return {
          decision: "auto-apply",
          reason: `Built-in "${key}" approved for this session.`,
        };
      }
      if (key && config.builtinAutoApprove[key]) {
        return {
          decision: "auto-apply",
          reason: `Built-in "${key}" is auto-approved in settings.`,
        };
      }
      return {
        decision: "require-approval",
        reason: "Built-in tool calls require explicit approval by default.",
      };
    }
    default: {
      const exhaustive: never = source;
      void exhaustive;
      return {
        decision: "rejected",
        reason: "Unknown tool source.",
      };
    }
  }
}

export function formatMcpGrantKey(
  serverId: McpServerId | undefined,
  toolName: string | undefined,
  trustEpoch: McpTrustEpoch | undefined,
): string {
  if (!serverId || !toolName || !trustEpoch) return "";
  return `mcp:${serverId}:${trustEpoch}:${toolName}`;
}
