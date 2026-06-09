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
}

export const DEFAULT_SAFETY_SETTINGS: SafetySettings = {
  defaultMode: "require-approval",
  allowlist: [],
  autoApproveBuiltins: {},
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
  };
}
