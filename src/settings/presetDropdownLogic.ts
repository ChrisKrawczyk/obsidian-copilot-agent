/**
 * Pure helpers for the Add Server preset dropdown (Phase 4A).
 *
 * - `buildPresetDropdownModel` produces a grouped (optgroup-style) model
 *   from an `EffectivePreset[]`. The DOM layer renders this dumbly.
 * - `applyEffectivePresetToForm` copies a preset into a form-input shape,
 *   skipping fields whose values equal `SECRET_PLACEHOLDER` and reporting
 *   them as `requiredSecretFields` so the UI can render the "must supply
 *   a value before saving" hint and the form validator can enforce it.
 *
 * NEITHER function invokes preflight, `commandExists`, or any filesystem
 * probe (SC-006). The dropdown is purely declarative pre-fill.
 */

import type { EffectivePreset } from "./presets/effectiveRegistry";
import { BUILTIN_PACK_ID } from "./presets/BuiltInPacks";
import { SECRET_PLACEHOLDER } from "./presets/packSecretPolicy";
import type { McpServerFormInput } from "./mcpServerFormLogic";

export interface DropdownOption {
  /** Submitted value — the EffectivePreset.effectiveId. */
  value: string;
  /** Human-rendered text — preset.displayLabel. */
  text: string;
}

export interface DropdownGroup {
  label: string;
  options: DropdownOption[];
}

export interface PresetDropdownModel {
  emptyOption: { value: ""; text: string };
  groups: DropdownGroup[];
}

const BUILTIN_GROUP_LABEL = "Built-in";
const EMPTY_OPTION_TEXT = "— none —";

export function buildPresetDropdownModel(
  registry: ReadonlyArray<EffectivePreset>,
): PresetDropdownModel {
  const byPack = new Map<string, { label: string; options: DropdownOption[] }>();
  const orderedPackIds: string[] = [];

  for (const eff of registry) {
    const key = eff.sourcePackId;
    if (!byPack.has(key)) {
      orderedPackIds.push(key);
      byPack.set(key, {
        label:
          key === BUILTIN_PACK_ID
            ? BUILTIN_GROUP_LABEL
            : `From ${eff.sourcePackLabel}`,
        options: [],
      });
    }
    byPack.get(key)!.options.push({
      value: eff.effectiveId,
      text: eff.displayLabel,
    });
  }

  // Built-in first regardless of registry order (the registry already puts
  // it first, but this guarantee keeps the UI stable if that contract ever
  // shifts).
  orderedPackIds.sort((a, b) => {
    if (a === BUILTIN_PACK_ID && b !== BUILTIN_PACK_ID) return -1;
    if (b === BUILTIN_PACK_ID && a !== BUILTIN_PACK_ID) return 1;
    return 0;
  });

  return {
    emptyOption: { value: "", text: EMPTY_OPTION_TEXT },
    groups: orderedPackIds.map((id) => byPack.get(id)!),
  };
}

export interface ApplyPresetResult {
  form: McpServerFormInput;
  requiredSecretFields: string[];
}

export interface ApplyPresetOptions {
  secretPlaceholder?: string;
}

/**
 * Copy an EffectivePreset's server + credentials into a McpServerFormInput,
 * substituting empty strings for values that equal the secret placeholder
 * and recording the form-field names in `requiredSecretFields`.
 *
 * `form` is treated as a base layer; this function returns a new object —
 * it does not mutate.
 */
export function applyEffectivePresetToForm(
  effective: EffectivePreset,
  form: McpServerFormInput,
  opts: ApplyPresetOptions = {},
): ApplyPresetResult {
  const placeholder = opts.secretPlaceholder ?? SECRET_PLACEHOLDER;
  const required: string[] = [];
  const next: McpServerFormInput = { ...form };

  const server = effective.preset.server;
  next.transport = server.transport;
  if (server.transport === "http") {
    next.url = server.url;
    next.command = undefined;
    next.args = undefined;
    next.env = undefined;
    next.cwd = undefined;
  } else {
    next.command = server.command;
    next.args = Array.isArray(server.args) ? [...server.args] : server.args;
    next.url = undefined;
    // Stdio preset env/cwd flow into the form so the user sees them
    // pre-filled. The placeholder sweep below clears any templatized
    // env values and reports them as `env.<KEY>` requireds.
    next.env = server.env ? { ...server.env } : undefined;
    next.cwd = server.cwd;
  }
  if (typeof server.name === "string") next.name = server.name;
  if (!next.id) next.id = effective.preset.id;

  const creds = effective.preset.credentials;
  switch (creds.kind) {
    case "none":
      next.credentialKind = "none";
      clearCredentialFields(next);
      break;
    case "static-bearer":
      next.credentialKind = "static-bearer";
      clearCommandCredentialFields(next);
      if (creds.token === placeholder) {
        next.authorization = "";
        required.push("authorization");
      } else {
        next.authorization = creds.token;
      }
      break;
    case "command-based":
      // Per revised FR-020: command/args are STRUCTURAL — preserved
      // verbatim. They are never templatized and never appear in
      // `requiredSecretFields`.
      next.credentialKind = "command-based";
      next.authorization = "";
      next.credentialCommand = creds.command;
      next.credentialArgs = Array.isArray(creds.args) ? [...creds.args] : undefined;
      next.credentialTokenPath = creds.tokenPath;
      next.credentialExpiryPath = creds.expiryPath;
      next.credentialRefreshBufferSeconds = creds.refreshBufferSeconds;
      break;
    case "oauth-pkce":
      // Phase 4 does not yet surface oauth-pkce in the form UI; clear
      // visible credential fields so stale bearer/command data cannot
      // survive a preset switch. Still mark known secret-bearing fields
      // as required so a future UI surface can read them.
      next.credentialKind = "none";
      clearCredentialFields(next);
      if ((creds as Record<string, unknown>).refreshTokenRef === placeholder) {
        required.push("refreshTokenRef");
      }
      break;
  }

  // Defensive sweep of stdio env values for the placeholder so the user
  // sees the same "required" treatment for env-derived secrets exported
  // via the denylist templating path.
  if (next.transport === "stdio" && next.env) {
    const envOut: Record<string, string> = {};
    for (const [k, v] of Object.entries(next.env)) {
      if (v === placeholder) {
        envOut[k] = "";
        required.push(`env.${k}`);
      } else {
        envOut[k] = v;
      }
    }
    next.env = envOut;
  }

  return { form: next, requiredSecretFields: required };
}

function clearCredentialFields(form: McpServerFormInput): void {
  form.authorization = "";
  clearCommandCredentialFields(form);
}

function clearCommandCredentialFields(form: McpServerFormInput): void {
  form.credentialCommand = "";
  form.credentialArgs = undefined;
  form.credentialTokenPath = "";
  form.credentialExpiryPath = "";
  form.credentialRefreshBufferSeconds = undefined;
}
