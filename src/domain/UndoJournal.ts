// UndoJournal: per-session log of filesystem write actions performed
// by our vault write tools, with one-step revert per entry.
//
// In-memory only. Cleared on plugin reload, "Clear conversation", or
// Obsidian restart — NOT on chat-view close (spec FR-013).
//
// MCP and built-in tool calls are NOT recorded. Their effects are
// out of scope for one-step revert.
//
// Per the Phase 6 design critique: each `undo` is guarded by a
// current-content check so a stale entry (the same path has been
// modified again since the recorded action) refuses to undo
// destructively. The journal reports the refusal via a returned
// `UndoOutcome` rather than throwing.

import type { TFile, Vault } from "obsidian";

export type UndoKind = "create" | "modify" | "delete";

export type UndoScope = "vault" | "extra-vault";

export interface UndoEntry {
  id: string;
  kind: UndoKind;
  scope: UndoScope;
  /** Vault-relative path for vault scope; absolute for extra-vault. */
  path: string;
  /** Content present before the action (for `modify` and `delete`). */
  before?: string;
  /** Content present after the action (for `create` and `modify`). Used for guard. */
  after?: string;
  /** Wall-clock timestamp of the action. */
  recordedAt: number;
  /** True once `undo` has run successfully — entry is then inert. */
  undone?: boolean;
}

export interface UndoOutcome {
  ok: boolean;
  /** If `ok === false`, a human-readable reason. */
  reason?: string;
}

/**
 * Minimal vault surface UndoJournal needs. We accept a structurally
 * compatible shape so tests can pass a fake vault.
 */
export interface UndoJournalVault {
  getFileByPath?: (path: string) => unknown;
  getAbstractFileByPath?: (path: string) => unknown;
  read?: (file: unknown) => Promise<string>;
  cachedRead?: (file: unknown) => Promise<string>;
  create?: (path: string, content: string) => Promise<unknown>;
  modify?: (file: unknown, content: string) => Promise<unknown>;
  delete?: (file: unknown, system?: boolean) => Promise<void>;
  trash?: (file: unknown, system?: boolean) => Promise<void>;
}

export class UndoJournal {
  private readonly entries = new Map<string, UndoEntry>();
  private idCounter = 0;

  constructor(private readonly vault: UndoJournalVault) {}

  /**
   * Record a write action. Returns the canonical entry stored in the
   * journal (with assigned id and timestamp).
   *
   * Callers MUST call `record` only after the write has succeeded, so
   * a failed write doesn't poison the Undo button.
   */
  record(entry: Omit<UndoEntry, "id" | "recordedAt"> & { id?: string }): UndoEntry {
    const id = entry.id ?? `undo-${++this.idCounter}`;
    const stored: UndoEntry = {
      ...entry,
      id,
      recordedAt: Date.now(),
    };
    this.entries.set(id, stored);
    return stored;
  }

  get(id: string): UndoEntry | undefined {
    return this.entries.get(id);
  }

  /**
   * Attempt to revert the action with `id`. Returns `{ ok: true }` on
   * success, or `{ ok: false, reason }` if the guard check (current
   * file content equals `after`) fails or if the file system layer
   * returns an error.
   *
   * Per the design critique: this guard preserves per-action Undo
   * while preventing destructive revert when a subsequent edit has
   * changed the file.
   */
  async undo(id: string): Promise<UndoOutcome> {
    const e = this.entries.get(id);
    if (!e) return { ok: false, reason: "Undo entry not found." };
    if (e.undone) {
      return { ok: false, reason: "This action has already been undone." };
    }
    if (e.scope !== "vault") {
      // Phase 7+ will implement extra-vault undo.
      return {
        ok: false,
        reason: "Undo for extra-vault writes is not supported in this phase.",
      };
    }

    try {
      switch (e.kind) {
        case "create": {
          // Guard: file should still exist and have the after-content.
          const file = this.lookup(e.path);
          if (!file) {
            return {
              ok: false,
              reason: `Cannot undo: "${e.path}" no longer exists.`,
            };
          }
          const current = await this.readVault(file);
          if (e.after !== undefined && current !== e.after) {
            return {
              ok: false,
              reason: `Cannot undo: "${e.path}" has changed since it was created.`,
            };
          }
          await this.deleteVault(file);
          e.undone = true;
          return { ok: true };
        }
        case "modify": {
          const file = this.lookup(e.path);
          if (!file) {
            return {
              ok: false,
              reason: `Cannot undo: "${e.path}" no longer exists.`,
            };
          }
          const current = await this.readVault(file);
          if (e.after !== undefined && current !== e.after) {
            return {
              ok: false,
              reason: `Cannot undo: "${e.path}" has changed since this edit.`,
            };
          }
          if (e.before === undefined) {
            return {
              ok: false,
              reason: "Cannot undo: no recorded prior content.",
            };
          }
          await this.modifyVault(file, e.before);
          e.undone = true;
          return { ok: true };
        }
        case "delete": {
          // Guard: file should still be absent.
          const existing = this.lookup(e.path);
          if (existing) {
            return {
              ok: false,
              reason: `Cannot undo: "${e.path}" already exists.`,
            };
          }
          if (e.before === undefined) {
            return {
              ok: false,
              reason: "Cannot undo: no recorded prior content.",
            };
          }
          await this.createVault(e.path, e.before);
          e.undone = true;
          return { ok: true };
        }
        default: {
          const exhaustive: never = e.kind;
          void exhaustive;
          return { ok: false, reason: "Unknown undo kind." };
        }
      }
    } catch (err) {
      return {
        ok: false,
        reason: `Undo failed: ${(err as Error).message || String(err)}`,
      };
    }
  }

  /** Wipe the journal (plugin reload / clear conversation). */
  clear(): void {
    this.entries.clear();
  }

  // ---- Vault adapter helpers (work with both real Obsidian Vault and our fake) ----

  private lookup(vaultPath: string): unknown | null {
    const get =
      this.vault.getFileByPath ?? this.vault.getAbstractFileByPath;
    if (!get) return null;
    return get.call(this.vault, vaultPath) ?? null;
  }

  private async readVault(file: unknown): Promise<string> {
    if (this.vault.cachedRead) return this.vault.cachedRead(file);
    if (this.vault.read) return this.vault.read(file);
    throw new Error("Vault has no read method");
  }

  private async createVault(path: string, content: string): Promise<unknown> {
    if (!this.vault.create) throw new Error("Vault has no create method");
    return this.vault.create(path, content);
  }

  private async modifyVault(file: unknown, content: string): Promise<unknown> {
    if (!this.vault.modify) throw new Error("Vault has no modify method");
    return this.vault.modify(file, content);
  }

  private async deleteVault(file: unknown): Promise<void> {
    // Prefer `trash` (recoverable in Obsidian) over `delete` if both exist.
    if (this.vault.trash) return this.vault.trash(file, true);
    if (this.vault.delete) return this.vault.delete(file, true);
    throw new Error("Vault has no delete method");
  }
}

/** Re-export helper to satisfy unused-import lints when TFile shows up only in JSDoc. */
export type _UndoTFile = TFile;
export type _UndoVault = Vault;
