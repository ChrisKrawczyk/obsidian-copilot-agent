import type { ServerCredentials } from "../../mcp/credentials/CredentialTypes";
import type {
  McpServerPresetPreflight,
  PartialServerInput,
} from "./McpServerPresets";

/**
 * Schema version literal — bumped on breaking changes to the pack JSON
 * shape. Parsers reject any other value.
 */
export type PackSchemaVersion = 1;

export interface PackPreset {
  id: string;
  label: string;
  description?: string;
  server: PartialServerInput;
  credentials: ServerCredentials;
  preflight?: McpServerPresetPreflight;
}

export interface Pack {
  schemaVersion: PackSchemaVersion;
  id: string;
  label: string;
  version: string;
  description?: string;
  presets: PackPreset[];
}

export interface ImportedPackRecord {
  /**
   * Unique id for this record, regenerated on every `addOrReplace`. Used by
   * the Settings UI to key list rows and trigger re-renders on re-import.
   * NOT persisted across replaces — callers must not treat `recordId` as
   * stable across re-imports of the same pack.
   */
  recordId: string;
  pack: Pack;
  /** Original on-disk path of the imported file (Electron `file.path`). */
  sourcePath: string;
  /** Epoch ms at first import. Used for deterministic ordering. */
  importedAt: number;
}

export interface PackValidationError {
  /** RFC 6901 JSON Pointer to the offending value. */
  pointer: string;
  message: string;
}

export type PackParseErrorKind = "parse" | "size" | "io";

export interface PackParseError {
  kind: PackParseErrorKind;
  message: string;
  line?: number;
  column?: number;
}
