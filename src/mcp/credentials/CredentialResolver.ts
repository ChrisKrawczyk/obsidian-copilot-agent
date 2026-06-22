import {
  DEFAULT_EXPIRY_PATH,
  DEFAULT_REFRESH_BUFFER_SECONDS,
  DEFAULT_TOKEN_PATH,
  type CommandBasedCredentials,
  type ServerCredentials,
} from "./CredentialTypes";
import type { CommandRunner } from "./CommandRunner";
import { extractAtPath } from "./jsonPath";
import { parseExpiry } from "./expiry";
import { redactSensitive } from "../redactSensitive";
import { parseCommandLine } from "./argv";

/** Hard timeout for credential-command execution per FR-015. */
export const COMMAND_TIMEOUT_MS = 15_000;

/** Minimum interval between re-resolves when the expiry is unknown (per server). */
export const MIN_RERESOLVE_INTERVAL_MS = 5_000;

/** Max stderr bytes surfaced in structured errors (FR-010 + spec edge case 1). */
export const MAX_STDERR_SNIPPET_LENGTH = 200;

export interface ResolvedCredential {
  authorization: string;
  expiresAt: number | null;
  tenantId: string | null;
}

/**
 * Discriminated structured error emitted by the resolver.
 *
 * Kinds mirror the categories the manager (Phase 4) uses to dispatch into
 * the remediation formatter. The `detail` is a redaction-safe, field-name
 * scoped string — never the raw stdout, never a token substring.
 */
export type CredentialResolutionError =
  | { kind: "command-failed"; detail: string; exitCode: number }
  | { kind: "timeout"; detail: string }
  | { kind: "parse-failed"; detail: string }
  | { kind: "token-path-missing"; detail: string; tokenPath: string }
  | { kind: "not-implemented"; variant: "oauth-pkce"; detail: string };

export class CredentialResolutionFailed extends Error {
  readonly error: CredentialResolutionError;
  constructor(error: CredentialResolutionError) {
    super(error.detail);
    this.name = "CredentialResolutionFailed";
    this.error = error;
  }
}

export interface RedactedLogger {
  warn(message: string): void;
}

export interface CredentialResolverDeps {
  clock: () => number;
  runner: CommandRunner;
  logger?: RedactedLogger;
  /** Override for testing only — defaults to COMMAND_TIMEOUT_MS. */
  commandTimeoutMs?: number;
}

interface CacheEntry {
  authorization: string;
  expiresAt: number | null;
  tenantId: string | null;
  resolvedAtMs: number;
}

/**
 * Pure, I/O-free credential resolver.
 *
 * The resolver caches resolved credentials in memory keyed by `serverId` and
 * delegates command execution to an injected `CommandRunner` (Phase 3
 * supplies the real spawn-backed implementation). It never logs nor includes
 * raw token material in errors — `CredentialResolutionError.detail` always
 * references field names only (FR-010).
 *
 * Tenant-id capture (FR-014 input): when a command-based resolution returns
 * a top-level `tenant` field in its JSON output (Azure CLI does this for
 * `az account get-access-token`), the resolver caches it alongside the
 * token AND retains it across `invalidate(serverId)` calls so failure-path
 * remediation formatters can still render `--tenant <id>` after the
 * credential cache has been cleared on a 401. Only `clear(serverId)` (server
 * removal) drops the retained tenant id.
 */
export class CredentialResolver {
  private readonly clock: () => number;
  private readonly runner: CommandRunner;
  private readonly logger?: RedactedLogger;
  private readonly commandTimeoutMs: number;
  private readonly cache = new Map<string, CacheEntry>();
  private readonly lastResolveAtMs = new Map<string, number>();
  private readonly lastKnownTenantId = new Map<string, string>();

  constructor(deps: CredentialResolverDeps) {
    this.clock = deps.clock;
    this.runner = deps.runner;
    this.logger = deps.logger;
    this.commandTimeoutMs = deps.commandTimeoutMs ?? COMMAND_TIMEOUT_MS;
    void this.logger;
  }

  async resolve(
    serverId: string,
    credentials: ServerCredentials,
  ): Promise<ResolvedCredential | null> {
    switch (credentials.kind) {
      case "none":
        return null;
      case "static-bearer":
        return {
          authorization: prefixBearerIfMissing(credentials.token),
          expiresAt: null,
          tenantId: null,
        };
      case "command-based":
        return this.resolveCommandBased(serverId, credentials);
      case "oauth-pkce":
        throw new CredentialResolutionFailed({
          kind: "not-implemented",
          variant: "oauth-pkce",
          detail:
            "oauth-pkce credentials are reserved in this release; see docs/m365-graph-mcp.md for the current options.",
        });
    }
  }

  invalidate(serverId: string): void {
    this.cache.delete(serverId);
    this.lastResolveAtMs.delete(serverId);
    // Intentionally does NOT clear lastKnownTenantId — see class docstring.
  }

  clear(serverId: string): void {
    this.cache.delete(serverId);
    this.lastResolveAtMs.delete(serverId);
    this.lastKnownTenantId.delete(serverId);
  }

  getLastKnownTenantId(serverId: string): string | null {
    return this.lastKnownTenantId.get(serverId) ?? null;
  }

  private async resolveCommandBased(
    serverId: string,
    credentials: CommandBasedCredentials,
  ): Promise<ResolvedCredential> {
    const refreshBufferMs =
      (credentials.refreshBufferSeconds ?? DEFAULT_REFRESH_BUFFER_SECONDS) *
      1000;
    const tokenPath = credentials.tokenPath ?? DEFAULT_TOKEN_PATH;
    const expiryPath = credentials.expiryPath ?? DEFAULT_EXPIRY_PATH;
    const now = this.clock();

    const cached = this.cache.get(serverId);
    if (cached) {
      if (cached.expiresAt === null) {
        // Unknown expiry: enforce a per-server rate limit so a missing
        // `expiresOn` cannot turn every outbound call into a fresh command
        // spawn. See spec edge case 4 fallback.
        const lastResolveAt = this.lastResolveAtMs.get(serverId) ?? 0;
        if (now - lastResolveAt < MIN_RERESOLVE_INTERVAL_MS) {
          return toResolved(cached);
        }
      } else if (now < cached.expiresAt - refreshBufferMs) {
        return toResolved(cached);
      }
    }

    const argv = buildArgv(credentials);
    const result = await this.runner.run(argv, this.commandTimeoutMs);

    if (result.timedOut) {
      throw new CredentialResolutionFailed({
        kind: "timeout",
        detail: `Credential command timed out after ${this.commandTimeoutMs}ms (server "${serverId}").`,
      });
    }

    if (result.exitCode !== 0) {
      const stderrSnippet = truncateRedacted(result.stderr);
      throw new CredentialResolutionFailed({
        kind: "command-failed",
        detail: stderrSnippet
          ? `Credential command exited with code ${result.exitCode}: ${stderrSnippet}`
          : `Credential command exited with code ${result.exitCode}.`,
        exitCode: result.exitCode,
      });
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(result.stdout);
    } catch {
      throw new CredentialResolutionFailed({
        kind: "parse-failed",
        // FR-010: reference field name only, never the raw stdout.
        detail: `Credential command stdout is not valid JSON; expected an object with "${tokenPath}" and "${expiryPath}" fields.`,
      });
    }

    const tokenValue = extractAtPath(parsed, tokenPath);
    if (typeof tokenValue !== "string" || tokenValue.length === 0) {
      throw new CredentialResolutionFailed({
        kind: "token-path-missing",
        // Spec edge case 3: distinct error string format. The configured
        // path is non-secret (user-controlled), so it is included verbatim.
        detail: `token field not found at path: ${tokenPath}`,
        tokenPath,
      });
    }

    const expiryValue = extractAtPath(parsed, expiryPath);
    const expiresAt = parseExpiry(expiryValue);

    let tenantId: string | null = null;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const candidate = (parsed as Record<string, unknown>).tenant;
      if (typeof candidate === "string" && candidate.length > 0) {
        tenantId = candidate;
        this.lastKnownTenantId.set(serverId, candidate);
      }
    }

    const entry: CacheEntry = {
      authorization: prefixBearerIfMissing(tokenValue),
      expiresAt,
      tenantId: tenantId ?? this.lastKnownTenantId.get(serverId) ?? null,
      resolvedAtMs: now,
    };
    this.cache.set(serverId, entry);
    this.lastResolveAtMs.set(serverId, now);
    return toResolved(entry);
  }
}

function toResolved(entry: CacheEntry): ResolvedCredential {
  return {
    authorization: entry.authorization,
    expiresAt: entry.expiresAt,
    tenantId: entry.tenantId,
  };
}

function buildArgv(credentials: CommandBasedCredentials): string[] {
  if (Array.isArray(credentials.args)) {
    return [credentials.command, ...credentials.args];
  }
  return parseCommandLine(credentials.command);
}

function prefixBearerIfMissing(token: string): string {
  if (/^Bearer\s+/i.test(token)) return token;
  return `Bearer ${token}`;
}

function truncateRedacted(value: string): string {
  if (!value) return "";
  const sanitized = redactSensitive(value);
  const trimmed = sanitized.replace(/\s+/g, " ").trim();
  if (trimmed.length <= MAX_STDERR_SNIPPET_LENGTH) return trimmed;
  return `${trimmed.slice(0, MAX_STDERR_SNIPPET_LENGTH)}…`;
}
