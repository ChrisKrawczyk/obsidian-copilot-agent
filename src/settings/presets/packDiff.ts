import { canonicalizePreset } from "./packCanonical";
import type { Pack, PackPreset } from "./packTypes";

export interface PackMetadataChange {
  from: { label: string; version: string };
  to: { label: string; version: string };
}

export interface PackDiff {
  added: PackPreset[];
  removed: PackPreset[];
  changed: { id: string; from: PackPreset; to: PackPreset }[];
  metadataChanged: PackMetadataChange | null;
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
  const changed: { id: string; from: PackPreset; to: PackPreset }[] = [];

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
      changed.push({ id, from: p, to: n });
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
