export type VaultChangeType = "created" | "modified" | "deleted" | "renamed";

export interface VaultChange {
  type: VaultChangeType;
  path: string;
  oldPath?: string;
}

export interface VaultEventInput {
  type: "create" | "modify" | "delete" | "rename";
  path: string;
  oldPath?: string;
}

export interface AttributedVaultChange {
  toolCallId: string;
  change: VaultChange;
}

export interface SelfWriteSpan {
  end(writtenPaths?: readonly string[]): void;
}

export interface VaultChangeDetectorOptions {
  now?: () => number;
  graceMs?: number;
  settleMs?: number;
  configDir?: string;
}

export const DEFAULT_GRACE_MS = 2000;
export const DEFAULT_SETTLE_MS = 1500;
export const MAX_LISTED_VAULT_CHANGES = 20;

const EVENT_TO_CHANGE: Record<VaultEventInput["type"], VaultChangeType> = {
  create: "created",
  modify: "modified",
  delete: "deleted",
  rename: "renamed",
};

/**
 * Attributes vault events to the built-in or MCP tool call that was
 * running (or had just finished) when they arrived. Events caused by
 * the plugin's own vault tools are excluded through self-write spans.
 */
export class VaultChangeDetector {
  private readonly now: () => number;
  private readonly graceMs: number;
  private readonly settleMs: number;
  private readonly configDir: string | undefined;
  private seq = 0;
  private readonly active = new Map<string, number>();
  private readonly grace = new Map<string, { seq: number; until: number }>();
  private openSpans = 0;
  private readonly spanPaths = new Set<string>();
  private readonly settled = new Map<string, number>();
  private readonly listeners = new Set<(c: AttributedVaultChange) => void>();

  constructor(options: VaultChangeDetectorOptions = {}) {
    this.now = options.now ?? Date.now;
    this.graceMs = options.graceMs ?? DEFAULT_GRACE_MS;
    this.settleMs = options.settleMs ?? DEFAULT_SETTLE_MS;
    const dir = options.configDir?.replace(/\/+$/, "");
    this.configDir = dir ? dir.toLowerCase() : undefined;
  }

  externalToolStarted(toolCallId: string): void {
    if (this.active.has(toolCallId)) return;
    this.grace.delete(toolCallId);
    this.active.set(toolCallId, ++this.seq);
  }

  externalToolCompleted(toolCallId: string): void {
    const seq = this.active.get(toolCallId);
    if (seq === undefined) return;
    this.active.delete(toolCallId);
    this.grace.set(toolCallId, { seq, until: this.now() + this.graceMs });
  }

  hasOpenWindow(): boolean {
    this.pruneGrace(this.now());
    return this.active.size > 0 || this.grace.size > 0;
  }

  beginSelfWrite(): SelfWriteSpan {
    this.openSpans++;
    let ended = false;
    return {
      end: (writtenPaths = []) => {
        if (ended) return;
        ended = true;
        this.openSpans--;
        const until = this.now() + this.settleMs;
        for (const p of writtenPaths) this.remember(p, until);
        if (this.openSpans === 0) {
          for (const key of this.spanPaths) this.settled.set(key, until);
          this.spanPaths.clear();
        }
      },
    };
  }

  observe(ev: VaultEventInput, focusedEditorPath?: string | null): AttributedVaultChange | null {
    const paths = ev.oldPath ? [ev.path, ev.oldPath] : [ev.path];
    if (paths.every((p) => this.isConfigPath(p))) return null;
    const t = this.now();
    if (this.openSpans > 0) {
      for (const p of paths) {
        const key = p.toLowerCase();
        this.spanPaths.add(key);
        this.settled.set(key, Number.POSITIVE_INFINITY);
      }
      return null;
    }
    this.pruneSettled(t);
    if (paths.some((p) => this.settled.has(p.toLowerCase()))) return null;
    const toolCallId = this.attribute(t);
    if (!toolCallId) return null;
    if (ev.type === "modify" && focusedEditorPath && focusedEditorPath === ev.path) return null;
    const change: VaultChange = { type: EVENT_TO_CHANGE[ev.type], path: ev.path };
    if (ev.type === "rename" && ev.oldPath) change.oldPath = ev.oldPath;
    const out = { toolCallId, change };
    for (const fn of this.listeners) {
      try {
        fn(out);
      } catch (err) {
        console.warn("[copilot-agent] vault change listener failed", err);
      }
    }
    return out;
  }

  subscribe(fn: (c: AttributedVaultChange) => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  private remember(path: string, until: number): void {
    const key = path.toLowerCase();
    const prev = this.settled.get(key);
    if (prev === undefined || prev < until) this.settled.set(key, until);
  }

  private isConfigPath(path: string): boolean {
    if (!this.configDir) return false;
    const p = path.toLowerCase();
    return p === this.configDir || p.startsWith(`${this.configDir}/`);
  }

  private attribute(t: number): string | null {
    this.pruneGrace(t);
    let best: string | null = null;
    let bestSeq = -1;
    for (const [id, seq] of this.active) {
      if (seq > bestSeq) {
        best = id;
        bestSeq = seq;
      }
    }
    for (const [id, g] of this.grace) {
      if (g.seq > bestSeq) {
        best = id;
        bestSeq = g.seq;
      }
    }
    return best;
  }

  private pruneGrace(t: number): void {
    for (const [id, g] of this.grace) if (g.until < t) this.grace.delete(id);
  }

  private pruneSettled(t: number): void {
    for (const [key, until] of this.settled) if (until < t) this.settled.delete(key);
  }
}

/**
 * Fold one attributed change into a tool call's change list: one entry
 * per path, a creation stays a creation when later modified, and paths
 * beyond `max` only bump the overflow count.
 */
export function mergeVaultChanges(
  existing: readonly VaultChange[] | undefined,
  overflow: number | undefined,
  change: VaultChange,
  max: number = MAX_LISTED_VAULT_CHANGES,
): { changes: VaultChange[]; overflow: number } {
  const changes = existing ? existing.slice() : [];
  const idx = changes.findIndex((c) => c.path === change.path);
  if (idx >= 0) {
    const prev = changes[idx];
    if (!(prev.type === "created" && change.type === "modified")) changes[idx] = { ...change };
    return { changes, overflow: overflow ?? 0 };
  }
  if (changes.length >= max) return { changes, overflow: (overflow ?? 0) + 1 };
  changes.push({ ...change });
  return { changes, overflow: overflow ?? 0 };
}
