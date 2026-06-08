/**
 * Persists the OAuth token + persist-enabled flag through Obsidian's
 * `Plugin.loadData` / `saveData`. Two correctness concerns drive the
 * implementation:
 *
 *  1. saveData writes the WHOLE plugin data blob. If two callers both
 *     `loadData → mutate → saveData` concurrently, one overwrites the
 *     other. Settings + AuthController can both touch the blob, so we
 *     serialise writes through a single tail promise.
 *
 *  2. Toggling persistEnabled OFF must wipe any already-persisted token
 *     immediately (the user just expressed they don't want it on disk).
 *     `setPersistEnabled(false)` therefore writes `token: null` in the
 *     same atomic merge.
 */

export interface PersistedShape {
  auth?: { token?: string | null };
  settings?: { persistEnabled?: boolean };
}

export interface PluginDataIO {
  loadData(): Promise<unknown>;
  saveData(data: unknown): Promise<void>;
}

export class TokenStore {
  private tail: Promise<void> = Promise.resolve();
  private cached: PersistedShape = {};
  private loaded = false;

  constructor(private readonly io: PluginDataIO) {}

  async load(): Promise<{ token: string | null; persistEnabled: boolean }> {
    const raw = (await this.io.loadData()) as PersistedShape | null | undefined;
    this.cached = raw && typeof raw === "object" ? { ...raw } : {};
    this.loaded = true;
    return this.snapshot();
  }

  snapshot(): { token: string | null; persistEnabled: boolean } {
    return {
      // persistEnabled defaults to TRUE so the plan's "default persist mode
      // preserves connection on restart" success criterion is satisfied.
      // The settings UI surfaces a clear plaintext-storage warning.
      persistEnabled: this.cached.settings?.persistEnabled ?? true,
      token: this.cached.auth?.token ?? null,
    };
  }

  /**
   * Write the token. If persistEnabled is false this writes `null` — the
   * caller is expected to keep the token in memory for the current
   * session and re-set it on next plugin load (which there won't be one
   * because the user opted out of persistence).
   */
  async setToken(token: string | null): Promise<void> {
    return this.enqueue(async () => {
      const persistEnabled = this.cached.settings?.persistEnabled ?? true;
      const toWrite = persistEnabled ? token : null;
      this.cached = mergeAuth(this.cached, toWrite);
      await this.flush();
    });
  }

  /**
   * Toggle persistence. When turning OFF we IMMEDIATELY wipe the on-disk
   * token (rubber-duck blocker: don't leave a token behind that the user
   * just told us not to keep).
   */
  async setPersistEnabled(enabled: boolean): Promise<void> {
    return this.enqueue(async () => {
      this.cached = mergeSettings(this.cached, { persistEnabled: enabled });
      if (!enabled) {
        this.cached = mergeAuth(this.cached, null);
      }
      await this.flush();
    });
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    if (!this.loaded) {
      throw new Error("TokenStore.load() must be called before mutating");
    }
    const next = this.tail.then(fn, fn);
    this.tail = next.then(
      () => {},
      () => {},
    );
    return next;
  }

  private async flush(): Promise<void> {
    // Re-read the latest blob and merge our cached delta on top so we
    // don't clobber concurrent writes from other code paths.
    const fresh = (await this.io.loadData()) as
      | PersistedShape
      | null
      | undefined;
    const base =
      fresh && typeof fresh === "object" ? (fresh as PersistedShape) : {};
    const merged: PersistedShape = {
      ...base,
      auth: { ...base.auth, ...this.cached.auth },
      settings: { ...base.settings, ...this.cached.settings },
    };
    this.cached = merged;
    await this.io.saveData(merged);
  }
}

function mergeAuth(
  base: PersistedShape,
  token: string | null,
): PersistedShape {
  return {
    ...base,
    auth: { ...base.auth, token },
  };
}

function mergeSettings(
  base: PersistedShape,
  patch: Partial<NonNullable<PersistedShape["settings"]>>,
): PersistedShape {
  return {
    ...base,
    settings: { ...base.settings, ...patch },
  };
}
