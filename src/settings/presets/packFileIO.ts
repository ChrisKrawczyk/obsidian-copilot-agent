/**
 * Pluggable file I/O for preset-pack import/export.
 *
 * - **Reader** (FR-001): import path uses the HTML5 `File` API exclusively.
 *   The desktop implementation creates a transient off-DOM
 *   `<input type="file" accept=".json,application/json">`, programmatically
 *   `.click()`s it, and reads the selected `File` via `await file.text()`.
 *   `sourcePath` (FR-006) comes from Electron's `file.path` property exposed
 *   on the browser `File` object in Obsidian Desktop's Electron runtime.
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

/**
 * Desktop reader: triggers a native file picker via an off-DOM `<input>`,
 * enforces the byte cap before reading, and surfaces Electron's `file.path`
 * as the `sourcePath`.
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
          window.removeEventListener("focus", onFocus);
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
          const sourcePath = (file as ElectronFile).path;
          if (!sourcePath) {
            settle({
              ok: false,
              reason: "io",
              message: "Selected file lacks an absolute path (Electron runtime required).",
            });
            return;
          }
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

        // Browsers fire `focus` on `window` when the picker is dismissed
        // without a selection. Use a microtask delay to give `change` a
        // chance to fire first when a file WAS selected.
        const onFocus = () => {
          setTimeout(() => {
            if (!settled) settle({ ok: false, reason: "cancelled" });
          }, 200);
        };

        input.addEventListener("change", () => {
          void onChange();
        });
        window.addEventListener("focus", onFocus, { once: true });
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
