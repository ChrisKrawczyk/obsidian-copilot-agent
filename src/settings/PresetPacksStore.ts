import { Notice } from "obsidian";
import type { PluginDataIO } from "../auth/TokenStore";
import { validatePack } from "./presets/packValidator";
import type { ImportedPackRecord, Pack } from "./presets/packTypes";

interface PersistedShapeWithPacks {
  mcpPresetPacks?: unknown;
  [topLevelKey: string]: unknown;
}

type NotifyFn = (message: string) => void;

/**
 * Persists imported preset packs under the top-level `mcpPresetPacks` key.
 *
 * Sibling-store invariants:
 * - persist() re-reads the plugin data blob before writing so concurrent
 *   writers (McpSettingsStore, TokenStore, SafetySettingsStore, …) don't
 *   stomp each other (see TokenStore.ts:6-9 for the same idiom).
 * - remove(packId) MUST NOT touch `mcpServers` (FR-008).
 */
export class PresetPacksStore {
  private tail: Promise<void> = Promise.resolve();
  private cached: ImportedPackRecord[] = [];
  private loaded = false;
  private listeners = new Set<(records: ImportedPackRecord[]) => void>();
  private lastDropNotice = "";

  constructor(
    private readonly io: PluginDataIO,
    private readonly notify: NotifyFn = (message) => {
      new Notice(message, 8000);
    },
    private readonly now: () => number = () => Date.now(),
    private readonly genRecordId: () => string = defaultRecordId,
  ) {}

  async load(): Promise<ImportedPackRecord[]> {
    const raw = (await this.io.loadData()) as
      | PersistedShapeWithPacks
      | null
      | undefined;
    const entries =
      raw && typeof raw === "object" ? raw.mcpPresetPacks : undefined;
    if (!Array.isArray(entries)) {
      this.cached = [];
      this.loaded = true;
      return this.snapshot();
    }
    const valid: ImportedPackRecord[] = [];
    const dropped: string[] = [];
    for (const entry of entries) {
      const parsed = parseRecord(entry);
      if (!parsed) {
        dropped.push(discernLabel(entry));
        continue;
      }
      valid.push(parsed);
    }
    this.cached = valid;
    this.loaded = true;
    this.notifyDroppedOnce(dropped);
    return this.snapshot();
  }

  snapshot(): ImportedPackRecord[] {
    return this.cached.map(cloneRecord);
  }

  subscribe(fn: (records: ImportedPackRecord[]) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /**
   * Insert or replace a record by `pack.id`. Returns a deep-cloned copy of
   * the newly-stored record. Always generates a fresh `recordId` and sets
   * `importedAt = now()` — re-imports are observable.
   */
  async addOrReplace(
    pack: Pack,
    sourcePath: string,
  ): Promise<ImportedPackRecord> {
    const record: ImportedPackRecord = {
      recordId: this.genRecordId(),
      pack: cloneJson(pack),
      sourcePath,
      importedAt: this.now(),
    };
    const idx = this.cached.findIndex((r) => r.pack.id === pack.id);
    if (idx >= 0) {
      this.cached = [
        ...this.cached.slice(0, idx),
        record,
        ...this.cached.slice(idx + 1),
      ];
    } else {
      this.cached = [...this.cached, record];
    }
    await this.persist();
    return cloneRecord(record);
  }

  async remove(packId: string): Promise<void> {
    const next = this.cached.filter((r) => r.pack.id !== packId);
    if (next.length === this.cached.length) return;
    this.cached = next;
    await this.persist();
  }

  isLoaded(): boolean {
    return this.loaded;
  }

  private persist(): Promise<void> {
    const snap = this.snapshot();
    this.listeners.forEach((fn) => {
      try {
        fn(snap);
      } catch {
        // Subscriber failures must not interrupt persistence.
      }
    });
    return this.enqueue(async () => {
      const fresh = (await this.io.loadData()) as
        | PersistedShapeWithPacks
        | null
        | undefined;
      const base =
        fresh && typeof fresh === "object"
          ? (fresh as PersistedShapeWithPacks)
          : {};
      await this.io.saveData({
        ...base,
        mcpPresetPacks: snap.map(toPersisted),
      });
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

  private notifyDroppedOnce(labels: string[]): void {
    if (labels.length === 0) return;
    const signature = labels.join("\u0000");
    if (signature === this.lastDropNotice) return;
    this.lastDropNotice = signature;
    this.notify(
      `[Copilot Agent] Dropped malformed preset pack records: ${labels.join(", ")}`,
    );
  }
}

function parseRecord(value: unknown): ImportedPackRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const validation = validatePack(raw.pack);
  if (!validation.ok || !validation.pack) return null;
  const importedAt =
    typeof raw.importedAt === "number" && Number.isFinite(raw.importedAt)
      ? raw.importedAt
      : Date.now();
  const recordId =
    typeof raw.recordId === "string" && raw.recordId.length > 0
      ? raw.recordId
      : defaultRecordId();
  const sourcePath =
    typeof raw.sourcePath === "string" && raw.sourcePath.length > 0
      ? raw.sourcePath
      : null;
  if (sourcePath === null) return null;
  return {
    recordId,
    pack: validation.pack,
    sourcePath,
    importedAt,
  };
}

function discernLabel(value: unknown): string {
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const pack = obj.pack;
    if (pack && typeof pack === "object") {
      const id = (pack as Record<string, unknown>).id;
      if (typeof id === "string" && id.length > 0) return id;
    }
  }
  return "(unknown)";
}

function cloneRecord(record: ImportedPackRecord): ImportedPackRecord {
  return cloneJson(record);
}

function toPersisted(record: ImportedPackRecord): ImportedPackRecord {
  return cloneJson(record);
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function defaultRecordId(): string {
  return `pk_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}
