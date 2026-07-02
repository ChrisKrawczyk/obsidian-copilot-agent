import {
  hasControlCharacter,
  validateMcpHttpUrl,
  type HostClass,
} from "../mcpServerFormLogic.shared";
import { parseServerCredentials } from "../parseServerCredentials";
import type {
  Pack,
  PackPreset,
  PackValidationError,
} from "./packTypes";

/**
 * Pack ID reserved for the synthetic Built-in pack. Any imported pack with
 * this id is rejected at validation so an imported pack cannot impersonate
 * the built-in namespace via FR-013(a)'s `<packId>.<presetId>` rule.
 */
export const RESERVED_BUILTIN_PACK_ID = "builtin";

const ALLOWED_TOP_LEVEL_FIELDS = new Set([
  "schemaVersion",
  "id",
  "label",
  "version",
  "description",
  "presets",
]);

const ALLOWED_PRESET_FIELDS = new Set([
  "id",
  "label",
  "description",
  "server",
  "credentials",
  "preflight",
]);

export interface PackValidationResult {
  ok: boolean;
  pack?: Pack;
  error?: PackValidationError;
}

/**
 * Validate a parsed pack object. Returns the FIRST validation error
 * (single-error contract per FR-002 / SC-003).
 *
 * Unknown TOP-level fields are ignored with `console.warn`.
 * Unknown PRESET-level fields are rejected with a pointer error.
 * Credentials are delegated to `parseServerCredentials`; the
 * oauth-pkce unknown-future-keys passthrough is preserved.
 */
export function validatePack(raw: unknown): PackValidationResult {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return fail("", "Pack must be a JSON object.");
  }
  const obj = raw as Record<string, unknown>;

  if (obj.schemaVersion !== 1) {
    return fail("/schemaVersion", "schemaVersion must be 1.");
  }
  if (!isNonEmptyString(obj.id)) {
    return fail("/id", "id must be a non-empty string.");
  }
  if (obj.id === RESERVED_BUILTIN_PACK_ID) {
    return fail(
      "/id",
      `Pack id "${RESERVED_BUILTIN_PACK_ID}" is reserved for the built-in pack.`,
    );
  }
  if (!isNonEmptyString(obj.label)) {
    return fail("/label", "label must be a non-empty string.");
  }
  if (!isNonEmptyString(obj.version)) {
    return fail("/version", "version must be a non-empty string.");
  }
  if (obj.description !== undefined && typeof obj.description !== "string") {
    return fail("/description", "description must be a string when present.");
  }
  if (!Array.isArray(obj.presets)) {
    return fail("/presets", "presets must be an array.");
  }
  if (obj.presets.length === 0) {
    return fail("/presets", "presets must contain at least one entry.");
  }

  for (const key of Object.keys(obj)) {
    if (!ALLOWED_TOP_LEVEL_FIELDS.has(key)) {
      console.warn(
        `[preset-pack] Ignoring unknown top-level field "${key}" in pack "${obj.id}".`,
      );
    }
  }

  const seenIds = new Set<string>();
  const presets: PackPreset[] = [];
  for (let i = 0; i < obj.presets.length; i++) {
    const presetPointer = `/presets/${i}`;
    const presetResult = validatePreset(obj.presets[i], presetPointer);
    if (!presetResult.ok || !presetResult.preset) {
      return { ok: false, error: presetResult.error };
    }
    if (seenIds.has(presetResult.preset.id)) {
      return fail(
        `${presetPointer}/id`,
        `Duplicate preset id "${presetResult.preset.id}" in pack.`,
      );
    }
    seenIds.add(presetResult.preset.id);
    presets.push(presetResult.preset);
  }

  const pack: Pack = {
    schemaVersion: 1,
    id: obj.id,
    label: obj.label,
    version: obj.version,
    ...(typeof obj.description === "string" ? { description: obj.description } : {}),
    presets,
  };
  return { ok: true, pack };
}

interface PresetResult {
  ok: boolean;
  preset?: PackPreset;
  error?: PackValidationError;
}

function validatePreset(value: unknown, pointer: string): PresetResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, error: { pointer, message: "Preset must be an object." } };
  }
  const obj = value as Record<string, unknown>;

  for (const key of Object.keys(obj)) {
    if (!ALLOWED_PRESET_FIELDS.has(key)) {
      return {
        ok: false,
        error: {
          pointer: `${pointer}/${escapePointerSegment(key)}`,
          message: `Unknown preset field "${key}".`,
        },
      };
    }
  }

  if (!isNonEmptyString(obj.id)) {
    return failPreset(`${pointer}/id`, "preset id must be a non-empty string.");
  }
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(obj.id)) {
    return failPreset(
      `${pointer}/id`,
      "preset id may only contain letters, digits, underscores, hyphens, and dots, and must not start with a separator.",
    );
  }
  if (!isNonEmptyString(obj.label)) {
    return failPreset(`${pointer}/label`, "preset label must be a non-empty string.");
  }
  if (obj.description !== undefined && typeof obj.description !== "string") {
    return failPreset(
      `${pointer}/description`,
      "preset description must be a string when present.",
    );
  }

  const serverResult = validateServer(obj.server, `${pointer}/server`);
  if (!serverResult.ok) {
    return { ok: false, error: serverResult.error };
  }

  if (obj.credentials === undefined) {
    return failPreset(`${pointer}/credentials`, "credentials block is required.");
  }
  const credsResult = parseServerCredentials(
    obj.credentials,
    `${pointer}/credentials`,
  );
  if (!credsResult.ok) {
    return { ok: false, error: credsResult.error };
  }
  if (!credsResult.value) {
    return failPreset(`${pointer}/credentials`, "credentials block is required.");
  }

  const preflightResult = validatePreflight(
    obj.preflight,
    `${pointer}/preflight`,
  );
  if (!preflightResult.ok) {
    return { ok: false, error: preflightResult.error };
  }

  const preset: PackPreset = {
    id: obj.id,
    label: obj.label,
    ...(typeof obj.description === "string" ? { description: obj.description } : {}),
    server: serverResult.server!,
    credentials: credsResult.value,
    ...(preflightResult.preflight ? { preflight: preflightResult.preflight } : {}),
  };
  return { ok: true, preset };
}

interface ServerResult {
  ok: boolean;
  server?: PackPreset["server"];
  error?: PackValidationError;
}

function validateServer(value: unknown, pointer: string): ServerResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return failGeneric(pointer, "server must be an object.");
  }
  const obj = value as Record<string, unknown>;
  if (!isNonEmptyString(obj.name)) {
    return failGeneric(`${pointer}/name`, "server name must be a non-empty string.");
  }
  if (hasControlCharacter(obj.name)) {
    return failGeneric(
      `${pointer}/name`,
      "server name must not contain control characters.",
    );
  }
  if (obj.transport === "http") {
    if (typeof obj.url !== "string") {
      return failGeneric(`${pointer}/url`, "http server url must be a string.");
    }
    let hostClass: HostClass | undefined;
    try {
      const result = validateMcpHttpUrl(obj.url, { allowPrivateNetwork: true });
      hostClass = result.hostClass;
    } catch (err) {
      return failGeneric(
        `${pointer}/url`,
        err instanceof Error ? err.message : String(err),
      );
    }
    void hostClass; // Pack import does NOT pre-confirm private-network — that's the import flow's job.
    const server: PackPreset["server"] = {
      name: obj.name,
      transport: "http",
      url: obj.url,
    };
    return { ok: true, server };
  }
  if (obj.transport === "stdio") {
    if (typeof obj.command !== "string" || obj.command.length === 0) {
      return failGeneric(
        `${pointer}/command`,
        "stdio server command must be a non-empty string.",
      );
    }
    if (hasControlCharacter(obj.command)) {
      return failGeneric(
        `${pointer}/command`,
        "stdio server command must not contain control characters.",
      );
    }
    if (obj.args !== undefined) {
      if (!Array.isArray(obj.args)) {
        return failGeneric(`${pointer}/args`, "args must be an array of strings.");
      }
      for (let i = 0; i < obj.args.length; i++) {
        const a = obj.args[i];
        if (typeof a !== "string") {
          return failGeneric(`${pointer}/args/${i}`, "arg must be a string.");
        }
        if (hasControlCharacter(a)) {
          return failGeneric(
            `${pointer}/args/${i}`,
            "arg must not contain control characters.",
          );
        }
      }
    }
    if (obj.env !== undefined) {
      if (
        !obj.env ||
        typeof obj.env !== "object" ||
        Array.isArray(obj.env)
      ) {
        return failGeneric(
          `${pointer}/env`,
          "env must be an object of string values.",
        );
      }
      for (const [k, v] of Object.entries(obj.env as Record<string, unknown>)) {
        if (typeof v !== "string") {
          return failGeneric(
            `${pointer}/env/${escapePointerSegment(k)}`,
            "env values must be strings.",
          );
        }
      }
    }
    if (obj.cwd !== undefined && typeof obj.cwd !== "string") {
      return failGeneric(`${pointer}/cwd`, "cwd must be a string when present.");
    }
    const server: PackPreset["server"] = {
      name: obj.name,
      transport: "stdio",
      command: obj.command,
      ...(Array.isArray(obj.args) ? { args: [...(obj.args as string[])] } : {}),
      ...(obj.env
        ? { env: { ...(obj.env as Record<string, string>) } }
        : {}),
      ...(typeof obj.cwd === "string" ? { cwd: obj.cwd } : {}),
    };
    return { ok: true, server };
  }
  return failGeneric(
    `${pointer}/transport`,
    `transport must be "http" or "stdio".`,
  );
}

interface PreflightResult {
  ok: boolean;
  preflight?: PackPreset["preflight"];
  error?: PackValidationError;
}

function validatePreflight(value: unknown, pointer: string): PreflightResult {
  if (value === undefined) return { ok: true, preflight: undefined };
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {
      ok: false,
      error: { pointer, message: "preflight must be an object when present." },
    };
  }
  const obj = value as Record<string, unknown>;
  if (obj.type !== "findOnPath") {
    return {
      ok: false,
      error: {
        pointer: `${pointer}/type`,
        message: 'preflight.type must be "findOnPath".',
      },
    };
  }
  if (!isNonEmptyString(obj.command)) {
    return {
      ok: false,
      error: {
        pointer: `${pointer}/command`,
        message: "preflight.command must be a non-empty string.",
      },
    };
  }
  if (obj.installHint !== undefined && typeof obj.installHint !== "string") {
    return {
      ok: false,
      error: {
        pointer: `${pointer}/installHint`,
        message: "preflight.installHint must be a string when present.",
      },
    };
  }
  return {
    ok: true,
    preflight: {
      type: "findOnPath",
      command: obj.command,
      ...(typeof obj.installHint === "string" ? { installHint: obj.installHint } : {}),
    },
  };
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function escapePointerSegment(segment: string): string {
  return segment.replace(/~/g, "~0").replace(/\//g, "~1");
}

function fail(pointer: string, message: string): PackValidationResult {
  return { ok: false, error: { pointer, message } };
}

function failPreset(pointer: string, message: string): PresetResult {
  return { ok: false, error: { pointer, message } };
}

function failGeneric<T extends { ok: boolean; error?: PackValidationError }>(
  pointer: string,
  message: string,
): T {
  return { ok: false, error: { pointer, message } } as T;
}
