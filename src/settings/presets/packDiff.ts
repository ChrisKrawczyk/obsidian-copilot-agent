import { canonicalStringify, canonicalizePreset } from "./packCanonical";
import type { Pack, PackPreset } from "./packTypes";
import { collectDenylistWarnings } from "../mcpServerFormLogic.shared";
import {
  SECRET_PLACEHOLDER,
  isKnownCredentialKind,
  knownStructuralFieldsForCredentials,
  secretFieldsForCredentials,
} from "./packSecretPolicy";

export interface PackMetadataChange {
  from: { label: string; version: string };
  to: { label: string; version: string };
}

export interface PackDiff {
  added: PackPreset[];
  removed: PackPreset[];
  changed: PackPresetChange[];
  metadataChanged: PackMetadataChange | null;
}

export interface PackPresetFieldDiff {
  pointer: string;
  before: unknown;
  after: unknown;
  secret?: boolean;
  placeholderState?:
    | "unchanged-placeholder"
    | "placeholder-to-value"
    | "value-to-placeholder"
    | "value-to-value";
}

export interface PackPresetChange {
  id: string;
  from: PackPreset;
  to: PackPreset;
  fields: PackPresetFieldDiff[];
}

/**
 * Diff two pack snapshots by preset id (case-sensitive per Edge Cases).
 *
 * - `added`: presets present only in `next`.
 * - `removed`: presets present only in `prev`.
 * - `changed`: same id with differing canonical form.
 * - `metadataChanged`: non-null when top-level `label` or `version` differ.
 *
 * Note: top-level `description` changes are NOT surfaced (FR-021 scopes the
 * "metadata" presentation surface to label+version).
 */
export function diffPacks(prev: Pack, next: Pack): PackDiff {
  const prevById = new Map(prev.presets.map((p) => [p.id, p]));
  const nextById = new Map(next.presets.map((p) => [p.id, p]));

  const added: PackPreset[] = [];
  const removed: PackPreset[] = [];
  const changed: PackPresetChange[] = [];

  for (const [id, p] of prevById) {
    if (!nextById.has(id)) {
      removed.push(p);
    }
  }
  for (const [id, n] of nextById) {
    const p = prevById.get(id);
    if (!p) {
      added.push(n);
      continue;
    }
    if (canonicalizePreset(p) !== canonicalizePreset(n)) {
      const nextIndex = next.presets.findIndex((preset) => preset.id === id);
      changed.push({
        id,
        from: p,
        to: n,
        fields: diffPresetFields(p, n, nextIndex),
      });
    }
  }

  const metadataChanged =
    prev.label !== next.label || prev.version !== next.version
      ? {
          from: { label: prev.label, version: prev.version },
          to: { label: next.label, version: next.version },
        }
      : null;

  return { added, removed, changed, metadataChanged };
}

function diffPresetFields(
  before: PackPreset,
  after: PackPreset,
  nextIndex: number,
): PackPresetFieldDiff[] {
  const fields: PackPresetFieldDiff[] = [];
  const canonicalBefore = JSON.parse(canonicalizePreset(before)) as PackPreset;
  const canonicalAfter = JSON.parse(canonicalizePreset(after)) as PackPreset;
  walkFieldDiffs(
    canonicalBefore,
    canonicalAfter,
    `/presets/${nextIndex}`,
    canonicalBefore,
    canonicalAfter,
    fields,
  );
  return fields;
}

function walkFieldDiffs(
  before: unknown,
  after: unknown,
  pointer: string,
  beforePreset: PackPreset,
  afterPreset: PackPreset,
  fields: PackPresetFieldDiff[],
): void {
  if (deepEqual(before, after)) return;
  if (isPlainObject(before) && isPlainObject(after)) {
    for (const key of [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()) {
      walkFieldDiffs(
        before[key],
        after[key],
        `${pointer}/${escapePointerSegment(key)}`,
        beforePreset,
        afterPreset,
        fields,
      );
    }
    return;
  }
  if (Array.isArray(before) && Array.isArray(after)) {
    const max = Math.max(before.length, after.length);
    for (let i = 0; i < max; i += 1) {
      walkFieldDiffs(before[i], after[i], `${pointer}/${i}`, beforePreset, afterPreset, fields);
    }
    return;
  }

  const secret = isSecretPointer(pointer, beforePreset, afterPreset);
  const placeholderState = secret ? classifyPlaceholderState(before, after) : undefined;
  if (placeholderState === "unchanged-placeholder") return;
  const redact = secret;
  fields.push({
    pointer,
    before: redact ? undefined : before,
    after: redact ? undefined : after,
    ...(secret ? { secret: true } : {}),
    ...(placeholderState ? { placeholderState } : {}),
  });
}

function isSecretPointer(
  pointer: string,
  beforePreset: PackPreset,
  afterPreset: PackPreset,
): boolean {
  const parts = pointer.split("/").slice(3).map(unescapePointerSegment);
  if (parts[0] === "server" && parts[1] === "env" && parts[2]) {
    return collectDenylistWarnings({ [parts[2]]: "" }).length > 0;
  }
  if (parts[0] !== "credentials" || !parts[1] || parts[1] === "kind") return false;

  const credentials = afterPreset.credentials ?? beforePreset.credentials;
  const kind = credentials.kind;
  if (!isKnownCredentialKind(kind)) return true;
  if (secretFieldsForCredentials(kind).includes(parts[1])) return true;
  if (knownStructuralFieldsForCredentials(kind).has(parts[1])) return false;
  return true;
}

function classifyPlaceholderState(
  before: unknown,
  after: unknown,
): PackPresetFieldDiff["placeholderState"] {
  const beforePlaceholder = before === SECRET_PLACEHOLDER;
  const afterPlaceholder = after === SECRET_PLACEHOLDER;
  if (beforePlaceholder && afterPlaceholder) return "unchanged-placeholder";
  if (beforePlaceholder && !afterPlaceholder) return "placeholder-to-value";
  if (!beforePlaceholder && afterPlaceholder) return "value-to-placeholder";
  return "value-to-value";
}

function deepEqual(a: unknown, b: unknown): boolean {
  return canonicalStringify(a) === canonicalStringify(b);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function escapePointerSegment(segment: string): string {
  return segment.replace(/~/g, "~0").replace(/\//g, "~1");
}

function unescapePointerSegment(segment: string): string {
  return segment.replace(/~1/g, "/").replace(/~0/g, "~");
}
