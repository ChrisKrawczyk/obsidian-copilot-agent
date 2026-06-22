import { normalizeServerId } from "../mcp/McpIdentity";
import type { McpServerConfig, McpServerId } from "../mcp/McpTypes";
import { assertNoTlsBypassOptions, validateMcpHttpUrl, type HostClass } from "../mcp/httpPolicy";
import { matchDenylist, type ExplicitDenylistOverrideWarning } from "../mcp/stdioEnv";
import { redactSensitive } from "../mcp/redactSensitive";

export const MCP_INITIALIZE_TIMEOUT_SECONDS = 10;
export const MCP_TOOLS_LIST_PAGE_TIMEOUT_SECONDS = 10;
export const MCP_CALL_TIMEOUT_MAX_SECONDS = 300;
export const MCP_CALL_TIMEOUT_DEFAULT_SECONDS = 60;
export const PRIVATE_NETWORK_CONFIRMATION_COPY = "This server is on a private network. Continue?";
export const AUTHORIZATION_STORAGE_NOTICE =
  "Authorization headers are stored in plain text in data.json. If your vault is synced (Obsidian Sync, iCloud, Dropbox, etc.) this credential will sync too.";

const TLS_BYPASS_KEYS = ["rejectUnauthorized", "insecure", "skipTls"] as const;

export interface McpServerFormInput {
  id: string;
  name?: string;
  enabled?: boolean;
  transport: "stdio" | "http";
  command?: string;
  args?: string | string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  authorization?: string;
  headers?: Record<string, string>;
  callTimeoutSeconds?: number;
  callTimeoutMs?: number;
  privateNetworkConfirmed?: boolean;
  revealSensitive?: boolean;
  rejectUnauthorized?: never;
  insecure?: never;
  skipTls?: never;
}

export interface McpServerFormContext {
  existingIds?: readonly McpServerId[];
  originalId?: McpServerId;
  vaultRoot: string;
  pathExists?: (path: string) => boolean;
  platform?: NodeJS.Platform;
}

export interface McpHeaderDisplay {
  name: string;
  value: string;
  redacted: boolean;
}

export interface McpServerFormValidationResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
  denylistEnvWarnings: ExplicitDenylistOverrideWarning[];
  confirmationRequired: boolean;
  hostClass?: HostClass;
  normalizedId?: McpServerId;
  config?: McpServerConfig;
  callTimeoutSeconds: number;
  initializeTimeoutSeconds: number;
  toolsListPageTimeoutSeconds: number;
  headerDisplay: McpHeaderDisplay[];
  sensitiveFields: { authorizationRedacted: boolean; authorizationDisplay: string };
}

export function validateMcpServerForm(
  input: McpServerFormInput,
  context: McpServerFormContext,
): McpServerFormValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const headerDisplay = buildHeaderDisplay(input, input.revealSensitive === true);
  const authorization = normalizeAuthorization(input);
  const callTimeoutSeconds = input.callTimeoutSeconds ??
    (typeof input.callTimeoutMs === "number"
      ? Math.floor(input.callTimeoutMs / 1000)
      : MCP_CALL_TIMEOUT_DEFAULT_SECONDS);
  let normalizedId: McpServerId | undefined;
  let confirmationRequired = false;
  let hostClass: HostClass | undefined;

  const tlsError = findTlsBypassKey(input as unknown as Record<string, unknown>);
  if (tlsError) errors.push(`TLS bypass option "${tlsError}" is not supported.`);

  try {
    normalizedId = normalizeServerId(input.id.trim());
    const collides = (context.existingIds ?? []).some(
      (id) => id === normalizedId && id !== context.originalId,
    );
    if (collides) errors.push(`MCP server id "${normalizedId}" already exists.`);
  } catch (err) {
    errors.push(err instanceof Error ? err.message : String(err));
  }

  const name = (input.name?.trim() || input.id.trim()).trim();
  if (!name) errors.push("Server name is required.");

  if (!Number.isFinite(callTimeoutSeconds) || !Number.isInteger(callTimeoutSeconds)) {
    errors.push("Tool call timeout must be a whole number of seconds.");
  } else if (callTimeoutSeconds <= 0) {
    errors.push("Tool call timeout must be greater than 0 seconds.");
  } else if (callTimeoutSeconds > MCP_CALL_TIMEOUT_MAX_SECONDS) {
    errors.push(`Tool call timeout must be ${MCP_CALL_TIMEOUT_MAX_SECONDS} seconds or less.`);
  }

  let config: McpServerConfig | undefined;
  if (normalizedId && name) {
    if (input.transport === "stdio") {
      const command = input.command?.trim() ?? "";
      if (!command) errors.push("Command is required for stdio MCP servers.");
      if (hasControlCharacter(command)) errors.push("Command contains invalid control characters.");
      const args = Array.isArray(input.args) ? input.args : parseArgs(input.args ?? "");
      if (args.some((arg) => hasControlCharacter(arg))) {
        errors.push("Arguments contain invalid control characters.");
      }
      const cwd = input.cwd?.trim() || context.vaultRoot;
      if (!cwd) errors.push("Working directory is required.");
      if (context.pathExists && !context.pathExists(cwd)) {
        errors.push(`Working directory does not exist: ${cwd}`);
      }
      const denylistEnvWarnings = collectDenylistWarnings(input.env, context.platform);
      if (denylistEnvWarnings.length > 0) {
        warnings.push(
          `Explicit environment overrides match the MCP denylist: ${denylistEnvWarnings.map((w) => w.key).join(", ")}`,
        );
      }
      config = {
        id: normalizedId,
        name,
        enabled: input.enabled ?? true,
        trustEpoch: "" as McpServerConfig["trustEpoch"],
        transport: "stdio",
        command,
        args,
        ...(input.env && Object.keys(input.env).length > 0 ? { env: { ...input.env } } : {}),
        ...(cwd !== context.vaultRoot ? { cwd } : {}),
        callTimeoutMs: callTimeoutSeconds * 1000,
      } as McpServerConfig;
    } else if (input.transport === "http") {
      const rawUrl = input.url?.trim() ?? "";
      if (!rawUrl) {
        errors.push("URL is required for HTTP MCP servers.");
      } else {
        try {
          assertNoTlsBypassOptions(input as unknown as Record<string, unknown>);
          const validation = validateMcpHttpUrl(rawUrl, {
            allowPrivateNetwork: input.privateNetworkConfirmed === true,
          });
          confirmationRequired = validation.confirmationRequired;
          hostClass = validation.hostClass;
          if (validation.confirmationRequired) {
            warnings.push(PRIVATE_NETWORK_CONFIRMATION_COPY);
          }
          config = {
            id: normalizedId,
            name,
            enabled: input.enabled ?? true,
            trustEpoch: "" as McpServerConfig["trustEpoch"],
            transport: "http",
            url: validation.url.href,
            ...(authorization
              ? { credentials: { kind: "static-bearer" as const, token: authorization } }
              : {}),
            callTimeoutMs: callTimeoutSeconds * 1000,
          } as McpServerConfig;
        } catch (err) {
          errors.push(err instanceof Error ? err.message : String(err));
        }
      }
    } else {
      errors.push("Transport must be stdio or http.");
    }
  }

  const denylistEnvWarnings =
    input.transport === "stdio" ? collectDenylistWarnings(input.env, context.platform) : [];
  if (errors.length > 0 || !config) config = undefined;

  return {
    ok: errors.length === 0 && !!config,
    errors,
    warnings,
    denylistEnvWarnings,
    confirmationRequired,
    hostClass,
    normalizedId,
    config,
    callTimeoutSeconds,
    initializeTimeoutSeconds: MCP_INITIALIZE_TIMEOUT_SECONDS,
    toolsListPageTimeoutSeconds: MCP_TOOLS_LIST_PAGE_TIMEOUT_SECONDS,
    headerDisplay,
    sensitiveFields: {
      authorizationRedacted: !!authorization && input.revealSensitive !== true,
      authorizationDisplay: authorization
        ? input.revealSensitive === true
          ? authorization
          : redactAuthorizationValue(authorization)
        : "",
    },
  };
}

export function buildHeaderDisplay(input: Pick<McpServerFormInput, "authorization" | "headers">, reveal = false): McpHeaderDisplay[] {
  const entries = Object.entries(input.headers ?? {});
  const authorization = normalizeAuthorization(input);
  if (authorization && !entries.some(([name]) => name.toLowerCase() === "authorization")) {
    entries.push(["Authorization", authorization]);
  }
  return entries.map(([name, value]) => ({
    name,
    value: name.toLowerCase() === "authorization" && !reveal ? redactAuthorizationValue(value) : value,
    redacted: name.toLowerCase() === "authorization" && !reveal,
  }));
}

export function redactAuthorizationValue(value: string): string {
  if (!value) return "";
  return "••••••••";
}

export function displaySensitiveValue(value: string | undefined, reveal: boolean): string {
  if (!value) return "";
  return reveal ? value : redactAuthorizationValue(redactSensitive(value));
}

export function assertNoTlsBypassFields(value: Record<string, unknown>): void {
  const key = findTlsBypassKey(value);
  if (key) throw new Error(`TLS bypass option "${key}" is not supported.`);
}

function normalizeAuthorization(input: Pick<McpServerFormInput, "authorization" | "headers">): string | undefined {
  const direct = input.authorization?.trim();
  if (direct) return direct;
  const header = Object.entries(input.headers ?? {}).find(([name]) => name.toLowerCase() === "authorization");
  return header?.[1]?.trim() || undefined;
}

function collectDenylistWarnings(
  env: Record<string, string> | undefined,
  platform: NodeJS.Platform = process.platform,
): ExplicitDenylistOverrideWarning[] {
  const caseInsensitive = platform === "win32";
  return Object.keys(env ?? {}).flatMap((key) => {
    const pattern = matchDenylist(key, caseInsensitive);
    return pattern ? [{ key, pattern }] : [];
  });
}

function parseArgs(raw: string): string[] {
  const args: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(raw)) !== null) args.push(match[1] ?? match[2] ?? match[3]);
  return args;
}

function hasControlCharacter(value: string): boolean {
  return /[\u0000-\u001f\u007f]/.test(value);
}

function findTlsBypassKey(value: Record<string, unknown>): string | null {
  for (const key of TLS_BYPASS_KEYS) {
    if (Object.hasOwn(value, key)) return key;
  }
  if (value.headers && typeof value.headers === "object") {
    for (const key of TLS_BYPASS_KEYS) {
      if (Object.hasOwn(value.headers as Record<string, unknown>, key)) return key;
    }
  }
  return null;
}
