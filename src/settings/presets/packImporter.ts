/**
 * Pure orchestration for the preset-pack import flow.
 *
 * `runPackImport` composes parse → validate → (if existing) diff into a
 * single discriminated outcome. NO side effects: it does not touch the
 * store, does not invoke preflight (SC-006), does not emit Notices.
 * `applyConfirmedImport` is the only function here that mutates state —
 * called by the Settings UI after the user clicks Confirm.
 */

import { parsePackText } from "./packParser";
import { validatePack } from "./packValidator";
import { diffPacks, type PackDiff, type PackMetadataChange } from "./packDiff";
import type {
  ImportedPackRecord,
  Pack,
  PackParseError,
  PackValidationError,
} from "./packTypes";
import type { PackFileReadResult } from "./packFileIO";
import type { PresetPacksStore } from "../PresetPacksStore";

export interface ImportInputs {
  text: string;
  sourcePath: string;
  byteLength: number;
  existingRecord: ImportedPackRecord | null;
}

export type ImportPackOutcome =
  | { kind: "sizeError"; error: PackParseError }
  | { kind: "parseError"; error: PackParseError }
  | { kind: "validationError"; error: PackValidationError; sizeWarning?: boolean }
  | { kind: "ioError"; message: string }
  | { kind: "cancelled" }
  | {
      kind: "confirmNew";
      pack: Pack;
      sourcePath: string;
      sizeWarning?: boolean;
    }
  | {
      kind: "confirmReimport";
      pack: Pack;
      sourcePath: string;
      diff: PackDiff;
      metadataChanged: PackMetadataChange | null;
      sizeWarning?: boolean;
    };

export function runPackImport(args: ImportInputs): ImportPackOutcome {
  const parsed = parsePackText(args.text, { byteLength: args.byteLength });
  if (!parsed.ok) {
    const err = parsed.error!;
    return err.kind === "size"
      ? { kind: "sizeError", error: err }
      : { kind: "parseError", error: err };
  }

  const validation = validatePack(parsed.raw);
  if (!validation.ok || !validation.pack) {
    return {
      kind: "validationError",
      error: validation.error!,
      ...(parsed.sizeWarning ? { sizeWarning: true as const } : {}),
    };
  }

  const pack = validation.pack;
  const sizeWarning = parsed.sizeWarning ? { sizeWarning: true as const } : {};

  if (args.existingRecord) {
    const diff = diffPacks(args.existingRecord.pack, pack);
    return {
      kind: "confirmReimport",
      pack,
      sourcePath: args.sourcePath,
      diff,
      metadataChanged: diff.metadataChanged,
      ...sizeWarning,
    };
  }

  return {
    kind: "confirmNew",
    pack,
    sourcePath: args.sourcePath,
    ...sizeWarning,
  };
}

export async function applyConfirmedImport(
  store: PresetPacksStore,
  pack: Pack,
  sourcePath: string,
): Promise<ImportedPackRecord> {
  return store.addOrReplace(pack, sourcePath);
}

/**
 * Adapter that maps a `PackFileReader` result into the unified
 * `ImportPackOutcome` union. The Settings UI uses this so that ALL flow
 * states (including reader-side `cancelled` / `io` / `too-large`) flow
 * through a single switch in the caller.
 */
export function runImportFromReaderResult(
  reader: PackFileReadResult,
  existingResolver: (text: string) => ImportedPackRecord | null,
): ImportPackOutcome {
  if (!reader.ok) {
    if (reader.reason === "cancelled") return { kind: "cancelled" };
    if (reader.reason === "too-large") {
      return {
        kind: "sizeError",
        error: {
          kind: "size",
          message: reader.message ?? "Pack file exceeds the maximum allowed size.",
        },
      };
    }
    return { kind: "ioError", message: reader.message ?? reader.reason };
  }
  return runPackImport({
    text: reader.text,
    sourcePath: reader.sourcePath,
    byteLength: reader.byteLength,
    existingRecord: existingResolver(reader.text),
  });
}
