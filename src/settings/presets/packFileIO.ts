/**
 * Pluggable file I/O for preset-pack import/export.
 *
 * - **Reader** (FR-001): import path uses the HTML5 `File` API exclusively.
 *   The desktop implementation creates a transient off-DOM
 *   `<input type="file" accept=".json,application/json">`, programmatically
 *   `.click()`s it, and reads the selected `File` via `await file.text()`.
 *   `sourcePath` (FR-006) is resolved in this order: (1) Electron 33+'s
 *   `webUtils.getPathForFile(file)`; (2) the legacy `file.path` property
 *   on older Electron; (3) `file.name` as a last-resort display label
 *   when neither is available (re-import matching is by pack id, so a
 *   non-absolute label still works — only the displayed source path
 *   degrades).
 *   Size cap (FR-023) is enforced from `file.size` BEFORE reading bytes.
 *
 * - **Writer** (export): not used by Phase 3 (Phase 4B). Exported as an
 *   interface here so the export UI can share the same factory module.
 *
 * Tests inject a fake reader/writer; production wiring uses the
 * `createDesktopPackFileIO()` factory below.
 */

import { PACK_MAX_BYTES } from "./packParser";

export interface PackFileReadOk {
  ok: true;
  text: string;
  sourcePath: string;
  byteLength: number;
}

export interface PackFileReadErr {
  ok: false;
  reason: "cancelled" | "io" | "too-large";
  message?: string;
}

export type PackFileReadResult = PackFileReadOk | PackFileReadErr;

export interface PackFileReader {
  pickAndReadPackFile(): Promise<PackFileReadResult>;
}

export interface PackFileWriteOk {
  ok: true;
  path: string;
}

export interface PackFileWriteErr {
  ok: false;
  reason: "cancelled" | "io";
  message?: string;
}

export type PackFileWriteResult = PackFileWriteOk | PackFileWriteErr;

export interface PackFileWriter {
  saveTextToPath(
    suggestedFilename: string,
    text: string,
  ): Promise<PackFileWriteResult>;
}

interface ElectronFile extends File {
  path?: string;
}

interface ElectronWebUtils {
  getPathForFile?: (file: File) => string;
}

interface ElectronRequireResult {
  webUtils?: ElectronWebUtils;
}

function resolveFileSourcePath(file: File): string {
  const fromLegacy = (file as ElectronFile).path;
  if (typeof fromLegacy === "string" && fromLegacy.length > 0) return fromLegacy;
  try {
    const w = window as unknown as {
      require?: (id: string) => ElectronRequireResult;
    };
    const electron = w.require?.("electron");
    const fromWebUtils = electron?.webUtils?.getPathForFile?.(file);
    if (typeof fromWebUtils === "string" && fromWebUtils.length > 0) {
      return fromWebUtils;
    }
  } catch {
    // electron not reachable from renderer (mobile / sandboxed) — fall through
  }
  return file.name;
}

/**
 * Desktop reader: triggers a native file picker via an off-DOM `<input>`,
 * enforces the byte cap before reading, and resolves `sourcePath` via
 * `webUtils.getPathForFile` (Electron 33+) with fallbacks to `file.path`
 * and `file.name`.
 *
 * Mobile / non-Electron gating: if the host runtime isn't Electron, the
 * reader returns `io` with the desktop-only message — consistent with the
 * existing MCP feature's desktop requirement.
 */
export function createDesktopPackFileReader(): PackFileReader {
  return {
    pickAndReadPackFile(): Promise<PackFileReadResult> {
      if (!isElectronRuntime()) {
        return Promise.resolve({
          ok: false,
          reason: "io",
          message: "Desktop-only feature.",
        });
      }
      return new Promise<PackFileReadResult>((resolve) => {
        const input = document.createElement("input");
        input.type = "file";
        input.accept = ".json,application/json";
        input.style.display = "none";

        let settled = false;
        const settle = (result: PackFileReadResult) => {
          if (settled) return;
          settled = true;
          input.remove();
          resolve(result);
        };

        const onChange = async () => {
          const file = input.files?.[0];
          if (!file) {
            settle({ ok: false, reason: "cancelled" });
            return;
          }
          if (file.size > PACK_MAX_BYTES) {
            settle({
              ok: false,
              reason: "too-large",
              message: `File is ${file.size.toLocaleString()} bytes; limit is ${PACK_MAX_BYTES.toLocaleString()}.`,
            });
            return;
          }
          const sourcePath = resolveFileSourcePath(file);
          try {
            const text = await file.text();
            settle({ ok: true, text, sourcePath, byteLength: file.size });
          } catch (err) {
            settle({
              ok: false,
              reason: "io",
              message: err instanceof Error ? err.message : String(err),
            });
          }
        };

        // Modern Chromium fires `cancel` on the input when the picker is
        // dismissed without a selection. This avoids the race that a
        // window-`focus` heuristic introduces (focus can fire before
        // `change` lands for large files, silently dropping the import).
        input.addEventListener("change", () => {
          void onChange();
        });
        input.addEventListener("cancel", () => {
          settle({ ok: false, reason: "cancelled" });
        });
        document.body.appendChild(input);
        input.click();
      });
    },
  };
}

function isElectronRuntime(): boolean {
  const w = window as unknown as { process?: { versions?: { electron?: string } } };
  return Boolean(w.process?.versions?.electron);
}

/**
 * Desktop writer (Phase 4B fallback path).
 *
 * The pure-Electron `dialog.showSaveDialog` path requires running inside
 * Obsidian and is unverifiable from automated tooling, so the production
 * writer falls back to the vault adapter: writes
 * `<vaultRoot>/exported-packs/<filename>` and returns the path so the UI
 * can surface a Notice. Tests inject a fake writer and never exercise
 * this factory.
 */
export function createDesktopPackFileWriter(app: {
  vault: {
    adapter: {
      write: (path: string, data: string) => Promise<void>;
      mkdir?: (path: string) => Promise<void>;
      exists?: (path: string) => Promise<boolean>;
    };
  };
}): PackFileWriter {
  return {
    async saveTextToPath(
      suggestedFilename: string,
      text: string,
    ): Promise<PackFileWriteResult> {
      try {
        const dir = "exported-packs";
        const path = `${dir}/${suggestedFilename}`;
        const adapter = app.vault.adapter;
        if (adapter.mkdir && adapter.exists) {
          const exists = await adapter.exists(dir);
          if (!exists) await adapter.mkdir(dir);
        }
        await adapter.write(path, text);
        return { ok: true, path };
      } catch (err) {
        return {
          ok: false,
          reason: "io",
          message: err instanceof Error ? err.message : String(err),
        };
      }
    },
  };
}
