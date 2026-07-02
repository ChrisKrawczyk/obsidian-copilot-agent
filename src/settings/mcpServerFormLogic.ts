import { normalizeServerId } from "../mcp/McpIdentity";
import type { McpServerConfig, McpServerId } from "../mcp/McpTypes";
import { assertNoTlsBypassOptions, validateMcpHttpUrl, type HostClass } from "../mcp/httpPolicy";
import type { ExplicitDenylistOverrideWarning } from "../mcp/stdioEnv";
import { redactSensitive } from "../mcp/redactSensitive";
import {
  collectDenylistWarnings as collectDenylistWarningsShared,
  findTlsBypassKey as findTlsBypassKeyShared,
  hasControlCharacter as hasControlCharacterShared,
  parseArgsString,
} from "./mcpServerFormLogic.shared";

export const MCP_INITIALIZE_TIMEOUT_SECONDS = 10;
export const MCP_TOOLS_LIST_PAGE_TIMEOUT_SECONDS = 10;
export const MCP_CALL_TIMEOUT_MAX_SECONDS = 300;
export const MCP_CALL_TIMEOUT_DEFAULT_SECONDS = 60;
export const PRIVATE_NETWORK_CONFIRMATION_COPY = "This server is on a private network. Continue?";
export const AUTHORIZATION_STORAGE_NOTICE =
  "Authorization headers are stored in plain text in data.json. If your vault is synced (Obsidian Sync, iCloud, Dropbox, etc.) this credential will sync too.";

export type McpCredentialKindUiSelection = "none" | "static-bearer" | "command-based";

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
  /** Phase 5: HTTP-only credential variant selected in the UI. */
  credentialKind?: McpCredentialKindUiSelection;
  /** Phase 5: command-based variant fields. */
  credentialCommand?: string;
  /** Phase 4 (preset packs / FR-020): structural args for command-based creds. */
  credentialArgs?: string[];
  credentialTokenPath?: string;
  credentialExpiryPath?: string;
  credentialRefreshBufferSeconds?: number;
  /**
   * Phase 4 (preset packs / FR-020): form-field names that were sourced
   * from an imported pack with templatized secret values. The validator
   * fails the submit when any listed field is empty so the user is
   * forced to supply the missing secret. Encoded as:
   *   - "authorization"        — HTTP static-bearer token
   *   - "env.<KEY>"            — stdio env value templated by exporter
   *   - "refreshTokenRef"      — oauth-pkce refresh-token reference
   * Anything not in this enumeration is ignored.
   */
  requiredSecretFields?: string[];
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
  /** Phase 4 (preset packs / FR-020): echo of the required-secret-field
   *  names that were checked. Populated even when validation passes. */
  requiredSecretFields: string[];
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

  const tlsError = findTlsBypassKeyShared(input as unknown as Record<string, unknown>);
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
      if (hasControlCharacterShared(command)) errors.push("Command contains invalid control characters.");
      const args = Array.isArray(input.args) ? input.args : parseArgsString(input.args ?? "");
      if (args.some((arg) => hasControlCharacterShared(arg))) {
        errors.push("Arguments contain invalid control characters.");
      }
      const cwd = input.cwd?.trim() || context.vaultRoot;
      if (!cwd) errors.push("Working directory is required.");
      if (context.pathExists && !context.pathExists(cwd)) {
        errors.push(`Working directory does not exist: ${cwd}`);
      }
      const denylistEnvWarnings = collectDenylistWarningsShared(input.env, context.platform);
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
          const credentialResult = resolveCredentialsFromForm(input, authorization, errors);
          config = {
            id: normalizedId,
            name,
            enabled: input.enabled ?? true,
            trustEpoch: "" as McpServerConfig["trustEpoch"],
            transport: "http",
            url: validation.url.href,
            ...(credentialResult ? { credentials: credentialResult } : {}),
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
    input.transport === "stdio" ? collectDenylistWarningsShared(input.env, context.platform) : [];
  const requiredSecretFields = Array.isArray(input.requiredSecretFields)
    ? [...input.requiredSecretFields]
    : [];
  for (const field of requiredSecretFields) {
    if (isRequiredSecretFieldEmpty(field, input, authorization)) {
      errors.push(
        `Required field ${field} from imported pack must be filled in before saving.`,
      );
    }
  }
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
    requiredSecretFields,
  };
}

/**
 * FR-020 / Phase 4: returns true when a pack-required field is empty in
 * the form, blocking save. Supported field names:
 *   - "authorization": HTTP static-bearer token (also matches an
 *     Authorization header passed via `headers`).
 *   - "env.<KEY>": stdio env value templated by the exporter.
 *   - "refreshTokenRef": oauth-pkce refresh-token reference (parked for
 *     when oauth-pkce surfaces in the form UI).
 * Unknown field names are ignored (treated as already-satisfied).
 */
function isRequiredSecretFieldEmpty(
  field: string,
  input: McpServerFormInput,
  authorization: string | undefined,
): boolean {
  if (field === "authorization") {
    return !authorization || authorization.length === 0;
  }
  if (field.startsWith("env.")) {
    const key = field.slice(4);
    const value = input.env?.[key];
    return !value || value.length === 0;
  }
  if (field === "refreshTokenRef") {
    // Form does not surface this yet; defer to future UI.
    return false;
  }
  return false;
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
  const key = findTlsBypassKeyShared(value);
  if (key) throw new Error(`TLS bypass option "${key}" is not supported.`);
}

function normalizeAuthorization(input: Pick<McpServerFormInput, "authorization" | "headers">): string | undefined {
  const direct = input.authorization?.trim();
  if (direct) return direct;
  const header = Object.entries(input.headers ?? {}).find(([name]) => name.toLowerCase() === "authorization");
  return header?.[1]?.trim() || undefined;
}

const MAX_REFRESH_BUFFER_SECONDS = 86_400;

/**
 * Phase 5: derive a `ServerCredentials` block from the form input based on
 * `credentialKind`. Returns `undefined` when the user explicitly chose
 * `none` AND no legacy `authorization` value is present (preserves the
 * pre-Phase-5 behavior of writing no credentials block when neither is set).
 *
 * Validation errors are pushed onto the shared `errors` array; the function
 * still returns the candidate credentials block (when buildable) so the
 * surrounding code can decide based on `errors.length`.
 */
function resolveCredentialsFromForm(
  input: McpServerFormInput,
  authorization: string | undefined,
  errors: string[],
): import("../mcp/credentials/CredentialTypes").ServerCredentials | undefined {
  const kind = input.credentialKind;
  if (!kind) {
    // Legacy path: no explicit kind. If an authorization value exists,
    // emit a `static-bearer` block (matches pre-Phase-5 behavior).
    return authorization
      ? { kind: "static-bearer", token: authorization }
      : undefined;
  }
  switch (kind) {
    case "none":
      // Backward compat: if the user typed into the Authorization field
      // without explicitly choosing a kind, still emit a static-bearer block
      // (matches pre-Phase-5 behavior so existing UI flows keep working).
      return authorization
        ? { kind: "static-bearer", token: authorization }
        : undefined;
    case "static-bearer": {
      if (!authorization) {
        errors.push("Static bearer credentials require a non-empty token.");
        return undefined;
      }
      return { kind: "static-bearer", token: authorization };
    }
    case "command-based": {
      const command = input.credentialCommand?.trim();
      if (!command) {
        errors.push("Command-based credentials require a non-empty command.");
        return undefined;
      }
      const refreshBuffer = input.credentialRefreshBufferSeconds;
      if (refreshBuffer != null) {
        if (
          !Number.isFinite(refreshBuffer) ||
          !Number.isInteger(refreshBuffer) ||
          refreshBuffer < 0 ||
          refreshBuffer > MAX_REFRESH_BUFFER_SECONDS
        ) {
          errors.push(
            `Refresh buffer must be between 0 and ${MAX_REFRESH_BUFFER_SECONDS} seconds.`,
          );
        }
      }
      const tokenPath = input.credentialTokenPath?.trim();
      const expiryPath = input.credentialExpiryPath?.trim();
      const credArgs = Array.isArray(input.credentialArgs) && input.credentialArgs.length > 0
        ? [...input.credentialArgs]
        : undefined;
      return {
        kind: "command-based",
        command,
        ...(credArgs ? { args: credArgs } : {}),
        ...(tokenPath ? { tokenPath } : {}),
        ...(expiryPath ? { expiryPath } : {}),
        ...(refreshBuffer != null ? { refreshBufferSeconds: refreshBuffer } : {}),
      };
    }
  }
}

/**
 * Phase 5: human-readable credential-status text for the per-server row.
 * Pure formatter — DOM code in `McpServersSection` simply binds the
 * returned string into a text node.
 *
 * PA-1 / FR-014: when `copyable` is present (e.g. `az login --tenant <id>`),
 * render it inline so the user sees the exact remediation command alongside
 * the textual hint. Mirrors how `McpManager.formatMessageWithCopyable`
 * appends the copyable to the chat error.
 *
 * SM-3 / Phase 5 minimum: when `nextRefreshAt` is populated, render it as
 * a relative-time string so the user knows when the resolver will refresh
 * the credential next.
 */
export function buildCredentialStatusText(input: {
  state?: "ok" | "failed" | "not-applicable";
  variant?: string;
  expiresAt?: number;
  nextRefreshAt?: number;
  remediation?: string;
  copyable?: string;
  /** SM-3: last Test-connection result + timestamp for inline display. */
  lastTestResult?: { ok: boolean; at: number; error?: string };
  now?: number;
}): string {
  const segments: string[] = [];
  if (!input.state) {
    segments.push("Credentials: not yet resolved.");
  } else if (input.state === "not-applicable") {
    segments.push("Credentials: not applicable.");
  } else if (input.state === "failed") {
    const base = input.remediation
      ? `Credentials: failed — ${input.remediation}`
      : "Credentials: failed.";
    segments.push(input.copyable ? `${base}\nRun: ${input.copyable}` : base);
  } else {
    const now = input.now ?? Date.now();
    const expiresIn = input.expiresAt ? Math.max(0, input.expiresAt - now) : null;
    if (expiresIn != null) {
      const mins = Math.floor(expiresIn / 60_000);
      segments.push(`Credentials: ok (expires in ${mins} min).`);
    } else {
      segments.push("Credentials: ok.");
    }
    if (input.nextRefreshAt) {
      const refreshIn = Math.max(0, input.nextRefreshAt - now);
      segments.push(`Next refresh in ${formatRelativeMinutes(refreshIn)}.`);
    }
  }
  if (input.lastTestResult) {
    const now = input.now ?? Date.now();
    const ago = formatRelativeAgo(Math.max(0, now - input.lastTestResult.at));
    if (input.lastTestResult.ok) {
      segments.push(`Last test: OK (${ago}).`);
    } else {
      const detail = input.lastTestResult.error ? ` — ${input.lastTestResult.error}` : "";
      segments.push(`Last test: failed (${ago})${detail}.`);
    }
  }
  return segments.join(" ");
}

function formatRelativeMinutes(ms: number): string {
  const mins = Math.floor(ms / 60_000);
  if (mins <= 0) return "<1 min";
  return `${mins} min`;
}

function formatRelativeAgo(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
}
