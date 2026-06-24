import type { ServerCredentials } from "../../mcp/credentials/CredentialTypes";
import type { McpServerConfig } from "../../mcp/McpTypes";
import { collectDenylistWarnings } from "../mcpServerFormLogic.shared";
import { RUNTIME_FIELDS } from "../McpSettingsStore";
import type { PartialServerInput } from "./McpServerPresets";
import type { Pack, PackPreset } from "./packTypes";
import { validatePack } from "./packValidator";
import {
  SECRET_PLACEHOLDER,
  isKnownCredentialKind,
  knownStructuralFieldsForCredentials,
  secretFieldsForCredentials,
} from "./packSecretPolicy";

/**
 * Vault-state fields that are NOT part of a pack: tracked separately from
 * RUNTIME_FIELDS because they're stable user-controlled state, not transient
 * runtime telemetry — but they still don't belong in a shareable pack.
 */
const VAULT_STATE_FIELDS: ReadonlySet<string> = new Set([
  "enabled",
  "trustEpoch",
]);

/** Fields the persistence layer already manages that don't belong in a pack. */
const PERSISTENCE_FIELDS: ReadonlySet<string> = new Set([
  "id",
  "callTimeoutMs",
]);

export interface ExportPackMeta {
  id: string;
  label: string;
  version: string;
  description?: string;
}

/**
 * Convert a list of MCP server configs into a `Pack` ready to be JSON-stringified.
 *
 * - Strips RUNTIME_FIELDS, VAULT_STATE_FIELDS, PERSISTENCE_FIELDS.
 * - Maps legacy HTTP `authorization` to canonical `{ kind: "static-bearer" }`
 *   credentials with SECRET_PLACEHOLDER token.
 * - Applies `secretFieldsForCredentials(kind)` per-credential templating.
 * - Templatizes stdio `env` values whose KEY matches the denylist
 *   (`collectDenylistWarnings`); non-denylisted env values preserved verbatim.
 * - Slugs preset `id` from server `name` (`[a-z0-9_-]+`), de-duplicating with
 *   `-2`, `-3` within the pack.
 *
 * The returned `Pack` is asserted via `validatePack` (round-trip property,
 * FR-012). Throws if validation fails (indicates a bug in the exporter).
 */
export function exportServersAsPack(
  servers: McpServerConfig[],
  meta: ExportPackMeta,
): Pack {
  const usedIds = new Set<string>();
  const presets: PackPreset[] = servers.map((raw) => {
    const cleaned = stripNonExportFields(raw);
    const server = buildPartialServerInput(cleaned);
    const credentials = buildExportedCredentials(cleaned);
    const id = uniquePresetId(slugify(cleaned.name), usedIds);
    const preset: PackPreset = {
      id,
      label: cleaned.name,
      server,
      credentials,
    };
    return preset;
  });

  // The exporter must produce a pack whose id is non-reserved and valid.
  // The reserved-id rule rejects "builtin"; export callers should pass a
  // distinct meta.id (Phase 4 dialog enforces this in the UI).
  const candidate: Pack = {
    schemaVersion: 1,
    id: meta.id,
    label: meta.label,
    version: meta.version,
    ...(meta.description ? { description: meta.description } : {}),
    presets,
  };

  const validation = validatePack(candidate);
  if (!validation.ok || !validation.pack) {
    throw new Error(
      `Exported pack failed self-validation at ${validation.error?.pointer}: ${validation.error?.message}`,
    );
  }
  return validation.pack;
}

function stripNonExportFields(server: McpServerConfig): McpServerConfig {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(server)) {
    if (RUNTIME_FIELDS.has(key)) continue;
    if (VAULT_STATE_FIELDS.has(key)) continue;
    if (PERSISTENCE_FIELDS.has(key)) continue;
    out[key] = deepClone(value);
  }
  return out as unknown as McpServerConfig;
}

function buildPartialServerInput(server: McpServerConfig): PartialServerInput {
  if (server.transport === "stdio") {
    const env = templatizeEnv(server.env);
    const out = {
      name: server.name,
      transport: "stdio" as const,
      command: server.command,
      ...(Array.isArray(server.args) ? { args: [...server.args] } : {}),
      ...(env && Object.keys(env).length > 0 ? { env } : {}),
      ...(typeof server.cwd === "string" ? { cwd: server.cwd } : {}),
    };
    return out;
  }
  // http
  return {
    name: server.name,
    transport: "http" as const,
    url: server.url,
  };
}

function templatizeEnv(
  env: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!env) return undefined;
  // collectDenylistWarnings uses process.platform to decide case-insensitivity
  // — that's the same heuristic the form uses, so the matrix matches.
  const warnings = collectDenylistWarnings(env);
  const denylisted = new Set(warnings.map((w) => w.key));
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    out[k] = denylisted.has(k) ? SECRET_PLACEHOLDER : v;
  }
  return out;
}

function buildExportedCredentials(
  server: McpServerConfig,
): ServerCredentials {
  if (server.transport === "http") {
    const http = server;
    // Legacy migration: bare authorization -> static-bearer w/ placeholder.
    if (!http.credentials && typeof http.authorization === "string") {
      return { kind: "static-bearer", token: SECRET_PLACEHOLDER };
    }
    if (!http.credentials) {
      return { kind: "none" };
    }
    return templatizeCredentials(http.credentials);
  }
  // stdio: no canonical credentials block today; treat as `none`.
  return { kind: "none" };
}

function templatizeCredentials(creds: ServerCredentials): ServerCredentials {
  if (!isKnownCredentialKind(creds.kind)) {
    // Defensive default: replace every field's VALUE except `kind` with the
    // placeholder. Returned object is shaped as `unknown` cast.
    const out: Record<string, unknown> = { kind: creds.kind };
    for (const [k, v] of Object.entries(creds as Record<string, unknown>)) {
      if (k === "kind") continue;
      out[k] = scalarPlaceholder(v);
    }
    return out as unknown as ServerCredentials;
  }

  const secretFields = new Set(secretFieldsForCredentials(creds.kind));
  const structural = knownStructuralFieldsForCredentials(creds.kind);

  const out: Record<string, unknown> = { kind: creds.kind };
  for (const [k, v] of Object.entries(creds as Record<string, unknown>)) {
    if (k === "kind") continue;
    if (secretFields.has(k)) {
      out[k] = scalarPlaceholder(v);
      continue;
    }
    if (structural.has(k)) {
      out[k] = deepClone(v);
      continue;
    }
    // Unknown future key on oauth-pkce → defensive default = secret.
    if (creds.kind === "oauth-pkce") {
      out[k] = scalarPlaceholder(v);
      continue;
    }
    // Unknown future key on a known structural kind → preserve verbatim.
    out[k] = deepClone(v);
  }
  return out as unknown as ServerCredentials;
}

function scalarPlaceholder(value: unknown): unknown {
  if (Array.isArray(value)) return [SECRET_PLACEHOLDER];
  if (value !== null && typeof value === "object") {
    return { __placeholder: SECRET_PLACEHOLDER };
  }
  return SECRET_PLACEHOLDER;
}

function deepClone<T>(value: T): T {
  return value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);
}

const SLUG_RE = /[^a-z0-9_-]+/gi;

function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(SLUG_RE, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return base.length > 0 ? base : "preset";
}

function uniquePresetId(base: string, used: Set<string>): string {
  if (!used.has(base)) {
    used.add(base);
    return base;
  }
  for (let i = 2; ; i++) {
    const candidate = `${base}-${i}`;
    if (!used.has(candidate)) {
      used.add(candidate);
      return candidate;
    }
  }
}
