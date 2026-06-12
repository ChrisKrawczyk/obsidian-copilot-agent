/**
 * Persists Phase 6 SafetyPolicy configuration alongside the auth blob
 * via Obsidian's `Plugin.loadData` / `saveData`. Lives in a separate
 * file (and a separate key on the persisted shape) so it doesn't
 * couple to TokenStore's auth concerns.
 *
 * Writes are serialised through a single tail promise so concurrent
 * `setX()` calls don't lose updates. We always re-read the latest
 * persisted blob before each write so we don't clobber unrelated
 * top-level keys (auth, etc.) written by other stores.
 */

import type { PluginDataIO } from "../auth/TokenStore";
import {
  DEFAULT_VAULT_AWARENESS_SETTINGS,
  mergeVaultAwarenessSettings,
  type VaultAwarenessSettings,
} from "./VaultAwarenessSettings";

/** Default safety mode applied to actions with no matching grant. */
export type SafetyDefaultMode = "auto-apply-with-undo" | "require-approval";

export interface SafetySettings {
  /**
   * The default action when the policy has no explicit grant.
   * - `auto-apply-with-undo`: vault writes proceed silently and a
   *   journal entry is recorded so the user can revert.
   * - `require-approval`: every action surfaces an inline ApprovalPrompt.
   *
   * Built-ins (shell, url, etc.) are NEVER auto-applied even in
   * `auto-apply-with-undo` mode unless `autoApproveBuiltins[kind]` is
   * true; the toggle is the only path to silent built-in execution.
   */
  defaultMode: SafetyDefaultMode;

  /**
   * Vault-relative path prefixes that bypass the approval prompt for
   * vault writes. Normalised (no leading/trailing `/`, no `..`).
   * Empty means no allowlist entries — every vault write either
   * auto-applies (if defaultMode is auto-apply-with-undo) or prompts.
   */
  allowlist: string[];

  /**
   * Per-built-in-kind auto-approve toggles. Keyed by SDK permission
   * `kind` (NOT tool name): "shell", "url", "memory", "hook",
   * "write" (non-vault), "read" (non-vault). All default OFF; the
   * UI exposes them as individual switches.
   */
  autoApproveBuiltins: Record<string, boolean>;

  /**
   * Phase 2 (Chat UX + Vault Tools): vault-aware preamble + task target
   * configuration. Persisted under the same store so Settings UI reads
   * one snapshot. See `VaultAwarenessSettings.ts` for field semantics.
   */
  vaultAwareness: VaultAwarenessSettings;

  /**
   * v0.3 Phase 1: gates the six v0.1 raw-filesystem tools (`view`,
   * `read_file`, `search_content`, `create_file`, `edit_file`,
   * `delete_file`). Default ON — the model is offered both the
   * higher-level v0.2 vault tools AND the raw-FS tools, with preamble
   * guidance directing it to prefer vault tools first and treat the
   * raw-FS tools as a fallback. Users who want a strictly vault-only
   * agent can turn this OFF; the gated tools are then dropped from
   * the SDK manifest and the preamble inventory.
   *
   * Per FR-015, toggling this takes effect on the next session start
   * only: `main.ts` snapshots the value at plugin onload and freezes
   * the SDK tools list and preamble tool-inventory for the lifetime of
   * the plugin instance. A plugin reload is required to re-snapshot.
   */
  exposeRawFsTools: boolean;
  /**
   * v0.4 Phase 2: optional default model id applied to NEW
   * conversations created after this setting is saved. `null` is the
   * `Auto (heuristic)` sentinel — the conversation factory falls back
   * to `resolveHeuristicModelId()` against the live catalog. A non-
   * null string is resolved against `ModelCatalog.isModelAvailable`
   * at conversation creation; if unavailable, we fall back to the
   * heuristic and surface a one-shot Notice (Spec.md Edge Cases:
   * "Global default unavailable at conversation creation").
   *
   * EXISTING conversations are never mutated by changes to this
   * setting — `modelId` is captured per-conversation at creation time.
   */
  defaultModelId: string | null;
}

export const DEFAULT_SAFETY_SETTINGS: SafetySettings = {
  defaultMode: "require-approval",
  allowlist: [],
  autoApproveBuiltins: {},
  vaultAwareness: { ...DEFAULT_VAULT_AWARENESS_SETTINGS },
  exposeRawFsTools: true,
  defaultModelId: null,
};

/** SDK kinds we surface as built-in toggles in the settings UI. */
export const KNOWN_BUILTIN_KINDS = [
  "shell",
  "url",
  "memory",
  "hook",
  "write",
  "read",
] as const;

interface PersistedShapeWithSafety {
  auth?: unknown;
  settings?: unknown;
  safety?: Partial<SafetySettings>;
}

export class SafetySettingsStore {
  private tail: Promise<void> = Promise.resolve();
  private cached: SafetySettings = { ...DEFAULT_SAFETY_SETTINGS };
  private listeners = new Set<(s: SafetySettings) => void>();

  constructor(private readonly io: PluginDataIO) {}

  async load(): Promise<SafetySettings> {
    const raw = (await this.io.loadData()) as
      | PersistedShapeWithSafety
      | null
      | undefined;
    const fromDisk = raw && typeof raw === "object" ? raw.safety : undefined;
    this.cached = mergeWithDefaults(fromDisk);
    return this.snapshot();
  }

  snapshot(): SafetySettings {
    // Return a deep-ish copy so callers can't mutate our cache.
    return {
      defaultMode: this.cached.defaultMode,
      allowlist: [...this.cached.allowlist],
      autoApproveBuiltins: { ...this.cached.autoApproveBuiltins },
      vaultAwareness: { ...this.cached.vaultAwareness },
      exposeRawFsTools: this.cached.exposeRawFsTools,
      defaultModelId: this.cached.defaultModelId,
    };
  }

  /** Subscribe to settings changes. Returns an unsubscribe function. */
  subscribe(fn: (s: SafetySettings) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  async setDefaultMode(mode: SafetyDefaultMode): Promise<void> {
    this.cached = { ...this.cached, defaultMode: mode };
    await this.persist();
  }

  async setAllowlist(entries: string[]): Promise<void> {
    this.cached = { ...this.cached, allowlist: entries };
    await this.persist();
  }

  async setBuiltinAutoApprove(kind: string, enabled: boolean): Promise<void> {
    this.cached = {
      ...this.cached,
      autoApproveBuiltins: {
        ...this.cached.autoApproveBuiltins,
        [kind]: enabled,
      },
    };
    await this.persist();
  }

  async setVaultAwareness(
    update: Partial<VaultAwarenessSettings>,
  ): Promise<void> {
    this.cached = {
      ...this.cached,
      vaultAwareness: { ...this.cached.vaultAwareness, ...update },
    };
    await this.persist();
  }

  async setExposeRawFsTools(value: boolean): Promise<void> {
    this.cached = { ...this.cached, exposeRawFsTools: value };
    await this.persist();
  }

  /**
   * v0.4 Phase 2: persist the global default model id. `null` is the
   * `Auto (heuristic)` sentinel and is always a valid value (no
   * availability check). A non-null string is stored verbatim; the
   * SettingsTab is responsible for offering only chat-capable values
   * but we tolerate any string here so a stale/unavailable value
   * survives a reload (and is surfaced in the UI as `<id>
   * (unavailable)`).
   */
  async setDefaultModelId(id: string | null): Promise<void> {
    this.cached = { ...this.cached, defaultModelId: id };
    await this.persist();
  }

  private persist(): Promise<void> {
    const snap = this.snapshot();
    this.listeners.forEach((fn) => {
      try {
        fn(snap);
      } catch {
        // Subscriber errors must not corrupt the persistence path.
      }
    });
    return this.enqueue(async () => {
      const fresh = (await this.io.loadData()) as
        | PersistedShapeWithSafety
        | null
        | undefined;
      const base =
        fresh && typeof fresh === "object"
          ? (fresh as PersistedShapeWithSafety)
          : {};
      const merged: PersistedShapeWithSafety = {
        ...base,
        safety: snap,
      };
      await this.io.saveData(merged);
    });
  }

  private enqueue(fn: () => Promise<void>): Promise<void> {
    const next = this.tail.then(fn, fn);
    this.tail = next.then(
      () => {},
      () => {},
    );
    return next;
  }
}

function mergeWithDefaults(
  partial: Partial<SafetySettings> | undefined,
): SafetySettings {
  if (!partial || typeof partial !== "object") {
    return { ...DEFAULT_SAFETY_SETTINGS };
  }
  return {
    defaultMode:
      partial.defaultMode === "auto-apply-with-undo"
        ? "auto-apply-with-undo"
        : "require-approval",
    allowlist: Array.isArray(partial.allowlist)
      ? partial.allowlist.filter((e): e is string => typeof e === "string")
      : [],
    autoApproveBuiltins:
      partial.autoApproveBuiltins && typeof partial.autoApproveBuiltins === "object"
        ? Object.fromEntries(
            Object.entries(partial.autoApproveBuiltins).filter(
              (entry): entry is [string, boolean] =>
                typeof entry[1] === "boolean",
            ),
          )
        : {},
    vaultAwareness: mergeVaultAwarenessSettings(partial.vaultAwareness),
    exposeRawFsTools:
      typeof partial.exposeRawFsTools === "boolean"
        ? partial.exposeRawFsTools
        : true,
    // v0.4: accept null (Auto sentinel) or a non-empty string.
    // Anything else (number, object, empty string, undefined) → null.
    defaultModelId:
      partial.defaultModelId === null
        ? null
        : typeof partial.defaultModelId === "string" &&
            partial.defaultModelId.length > 0
          ? partial.defaultModelId
          : null,
  };
}
