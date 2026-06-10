/**
 * Phase 2: persisted vault-awareness configuration. Lives under the
 * `vaultAwareness` key on the SafetySettingsStore's persisted blob so we
 * reuse the existing IO + listener plumbing without inventing a new
 * store class.
 *
 * `mode` drives which preamble (if any) is sent at session start:
 *   - `none`    — no preamble at all
 *   - `default` — the assembler's built-in vault-aware block
 *   - `custom`  — `customBody` verbatim (with documented placeholders)
 *
 * `taskTargetMode` and `customTaskTargetPath` configure where Phase 5's
 * `create_task` tool appends new tasks. Persisted now (Phase 2) so the
 * Settings UI surfaces the choice up-front; Phase 5 wires it through.
 */

export type VaultAwarenessMode = "none" | "default" | "custom";

export type TaskTargetMode = "today-daily-note" | "custom-path";

export interface VaultAwarenessSettings {
  mode: VaultAwarenessMode;
  customBody: string;
  taskTargetMode: TaskTargetMode;
  /** Vault-relative path; only used when `taskTargetMode = "custom-path"`. */
  customTaskTargetPath: string;
}

export const DEFAULT_VAULT_AWARENESS_SETTINGS: VaultAwarenessSettings = {
  mode: "default",
  customBody: "",
  taskTargetMode: "today-daily-note",
  customTaskTargetPath: "",
};

export function mergeVaultAwarenessSettings(
  partial: Partial<VaultAwarenessSettings> | undefined,
): VaultAwarenessSettings {
  if (!partial || typeof partial !== "object") {
    return { ...DEFAULT_VAULT_AWARENESS_SETTINGS };
  }
  const mode: VaultAwarenessMode =
    partial.mode === "none" || partial.mode === "custom"
      ? partial.mode
      : "default";
  const taskTargetMode: TaskTargetMode =
    partial.taskTargetMode === "custom-path" ? "custom-path" : "today-daily-note";
  return {
    mode,
    customBody:
      typeof partial.customBody === "string" ? partial.customBody : "",
    taskTargetMode,
    customTaskTargetPath:
      typeof partial.customTaskTargetPath === "string"
        ? partial.customTaskTargetPath
        : "",
  };
}
