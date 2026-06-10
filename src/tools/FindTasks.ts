/**
 * Phase 6: `find_tasks` — enumerate task-list items across the vault
 * (or a single note) and filter by status/tag/date/regex/path.
 *
 * Read-only. No vault mutation. Registered with `skipPermission: true`.
 *
 * Implementation:
 *   1. Enumerate markdown files (or one file if `path` is supplied).
 *   2. Per file, ask `metadataCache.getFileCache(file).listItems` for the
 *      0-based line numbers of all list items whose `task` char is set
 *      (i.e. they're checkbox tasks, not plain bullets).
 *   3. Read the file content once; slice the matching lines; parse with
 *      `parseTaskLine`.
 *   4. Apply filters; return `[{ path, line, raw, parsed }]` with
 *      **1-based** line numbers (consistent with `search_vault`).
 *
 * Caps: 500 results per call; 5 MB per-file size limit.
 */

import type { ObsidianApi } from "./ObsidianApi";
import type { ReadToolsVault, TFileLike } from "./ReadTools";
import {
  resolveVaultPath,
  toVaultRelative,
  lookupTFile,
  VaultPathError,
} from "./VaultPath";
import { parseTaskLine, type ParsedTask, type TaskStatus } from "./TaskFormat";

const MAX_RESULTS = 500;
const MAX_FILE_BYTES = 5 * 1024 * 1024;

export interface FindTasksFilter {
  /** Optional vault-relative file path — restrict to a single note. */
  path?: string;
  /** Tag without leading `#` — case-insensitive exact match. */
  tag?: string;
  /** Filter by status. */
  status?: TaskStatus;
  /** `YYYY-MM-DD`. Inclusive. */
  dueBefore?: string;
  /** `YYYY-MM-DD`. Inclusive. */
  dueAfter?: string;
  /** Regex tested against the parsed description (post-parse). */
  descriptionRegex?: string;
}

export interface FindTasksHit {
  path: string;
  /** 1-based. */
  line: number;
  raw: string;
  parsed: ParsedTask;
}

export type FindTasksResult =
  | {
      ok: true;
      results: FindTasksHit[];
      /** True when `MAX_RESULTS` was hit. */
      truncated: boolean;
      /** Files scanned (after path filter). */
      scanned: number;
    }
  | { ok: false; reason: "invalid_path"; details?: string }
  | { ok: false; reason: "invalid_regex"; error: string }
  | { ok: false; reason: "invalid_date_format"; field: "dueBefore" | "dueAfter" };

const STRICT_DATE = /^\d{4}-\d{2}-\d{2}$/;

export async function findTasksImpl(
  filter: FindTasksFilter,
  deps: { api: ObsidianApi; vault: ReadToolsVault },
): Promise<FindTasksResult> {
  const { api, vault } = deps;

  if (filter.dueBefore !== undefined && !STRICT_DATE.test(filter.dueBefore)) {
    return { ok: false, reason: "invalid_date_format", field: "dueBefore" };
  }
  if (filter.dueAfter !== undefined && !STRICT_DATE.test(filter.dueAfter)) {
    return { ok: false, reason: "invalid_date_format", field: "dueAfter" };
  }

  let descRe: RegExp | undefined;
  if (filter.descriptionRegex !== undefined) {
    try {
      descRe = new RegExp(filter.descriptionRegex);
    } catch (e) {
      return {
        ok: false,
        reason: "invalid_regex",
        error: (e as Error).message ?? String(e),
      };
    }
  }

  let files: TFileLike[];
  if (filter.path !== undefined) {
    let vaultRel: string;
    try {
      const abs = resolveVaultPath(filter.path, vault);
      vaultRel = toVaultRelative(abs, vault);
    } catch (e) {
      if (e instanceof VaultPathError) {
        return { ok: false, reason: "invalid_path", details: e.message };
      }
      throw e;
    }
    const tf = lookupTFile(vaultRel, vault) as TFileLike | null;
    if (!tf) return { ok: true, results: [], truncated: false, scanned: 0 };
    files = [tf];
  } else {
    files = (vault.getMarkdownFiles && vault.getMarkdownFiles()) ?? [];
  }

  const wantedTag = filter.tag?.replace(/^#+/, "").toLowerCase();

  const results: FindTasksHit[] = [];
  let truncated = false;

  for (const file of files) {
    if (results.length >= MAX_RESULTS) {
      truncated = true;
      break;
    }

    const cacheR = api.getFileCache(file);
    if (!cacheR.ok) continue;
    const items = cacheR.value.listItems ?? [];
    const taskLines = items.filter((it) => typeof it.task === "string");
    if (taskLines.length === 0) continue;

    let content: string;
    try {
      const reader = vault.cachedRead ?? vault.read;
      if (!reader) continue;
      content = await reader(file);
    } catch {
      continue;
    }
    if (content.length > MAX_FILE_BYTES) continue;
    const lines = content.split("\n");

    for (const item of taskLines) {
      if (results.length >= MAX_RESULTS) {
        truncated = true;
        break;
      }
      const lineIdx0 = item.position?.start?.line;
      if (typeof lineIdx0 !== "number" || lineIdx0 < 0 || lineIdx0 >= lines.length) continue;
      const raw = lines[lineIdx0];
      const pr = parseTaskLine(raw);
      if (!pr.ok) continue;
      const parsed = pr.parsed;

      if (filter.status && parsed.status !== filter.status) continue;
      if (wantedTag) {
        const tags = (parsed.tags ?? []).map((t) => t.toLowerCase());
        if (!tags.includes(wantedTag)) continue;
      }
      if (filter.dueBefore !== undefined) {
        if (!parsed.dueDate || parsed.dueDate > filter.dueBefore) continue;
      }
      if (filter.dueAfter !== undefined) {
        if (!parsed.dueDate || parsed.dueDate < filter.dueAfter) continue;
      }
      if (descRe && !descRe.test(parsed.description)) continue;

      results.push({
        path: file.path,
        line: lineIdx0 + 1,
        raw,
        parsed,
      });
    }
  }

  return { ok: true, results, truncated, scanned: files.length };
}
