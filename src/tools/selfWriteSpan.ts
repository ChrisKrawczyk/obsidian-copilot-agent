import type { SelfWriteSpan } from "../domain/VaultChangeDetector";
import type { UndoEntry } from "../domain/UndoJournal";

export interface SelfWriteSpanSource {
  beginSelfWrite(): SelfWriteSpan;
}

const PATH_KEYS = new Set(["path", "paths", "from", "to", "oldPath", "newPath"]);
const MAX_COLLECTED_PATHS = 500;

/**
 * Best-effort list of vault paths named in a tool's arguments or result
 * (`path`, `paths`, `from`, `to`, … at any nesting depth up to 4), so
 * events that land just after the span closes are still recognised.
 */
export function collectWrittenPaths(...values: unknown[]): string[] {
  const out = new Set<string>();
  const visit = (v: unknown, depth: number, underPathKey: boolean): void => {
    if (out.size >= MAX_COLLECTED_PATHS || depth > 4) return;
    if (typeof v === "string") {
      if (underPathKey && v.length > 0) out.add(v);
      return;
    }
    if (Array.isArray(v)) {
      for (const item of v) visit(item, depth + 1, underPathKey);
      return;
    }
    if (v && typeof v === "object") {
      for (const [k, child] of Object.entries(v as Record<string, unknown>)) {
        visit(child, depth + 1, PATH_KEYS.has(k));
      }
    }
  };
  for (const v of values) visit(parseMaybeJson(v), 0, false);
  return [...out];
}

function parseMaybeJson(v: unknown): unknown {
  if (typeof v !== "string") return v;
  const s = v.trim();
  if (!s.startsWith("{") && !s.startsWith("[")) return v;
  try {
    return JSON.parse(s);
  } catch {
    return v;
  }
}

export function undoEntryPaths(entry: Pick<UndoEntry, "path" | "items" | "scope"> | undefined): string[] {
  if (!entry || entry.scope !== "vault") return [];
  const out = [entry.path];
  for (const it of entry.items ?? []) {
    if (it.op === "move") out.push(it.from, it.to);
    else out.push(it.path);
  }
  return out;
}

/**
 * Run every tool handler inside a self-write span so vault events the
 * tool causes (including link rewrites Obsidian makes in other notes)
 * are never reported as out-of-band changes. Only mutating tools seed
 * the post-span settle list with the paths they name; a read-only tool
 * must not hide an external write that lands just after it. All other
 * tool fields are passed through untouched.
 */
export function wrapToolsWithSelfWriteSpan<T extends { name?: string; handler?: unknown }>(
  tools: readonly T[],
  source: SelfWriteSpanSource,
  isReadOnly: (name: string) => boolean = () => false,
): T[] {
  return tools.map((tool) => {
    const handler = tool.handler;
    if (typeof handler !== "function") return tool;
    const readOnly = typeof tool.name === "string" && isReadOnly(tool.name);
    const wrapped = async function (this: unknown, ...args: unknown[]): Promise<unknown> {
      const span = source.beginSelfWrite();
      let result: unknown;
      try {
        result = await (handler as (...a: unknown[]) => unknown).apply(this, args);
        return result;
      } finally {
        span.end(readOnly ? [] : collectWrittenPaths(args[0], result));
      }
    };
    return { ...tool, handler: wrapped };
  });
}
