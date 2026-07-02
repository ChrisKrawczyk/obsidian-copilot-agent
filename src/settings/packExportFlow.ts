/**
 * Pure orchestration for the "Export servers as pack…" UI (Phase 4B).
 *
 * The DOM layer renders the multi-select dialog dumbly off this model and
 * calls back into `runExport` when the user confirms. Saving to disk is
 * delegated to an injected `PackFileWriter` so the orchestration stays
 * testable without filesystem access.
 */

import type { McpServerConfig } from "../mcp/McpTypes";
import { exportServersAsPack, type ExportPackMeta } from "./presets/packExporter";
import type { Pack } from "./presets/packTypes";

export interface ExportRow {
  id: string;
  name: string;
  transport: "stdio" | "http";
  selected: boolean;
}

export interface ExportFlowModel {
  rows: ExportRow[];
  defaultPackMeta: ExportPackMeta;
}

export function buildExportFlowModel(
  servers: ReadonlyArray<McpServerConfig>,
  now: () => Date = () => new Date(),
): ExportFlowModel {
  const rows: ExportRow[] = servers.map((s) => ({
    id: s.id,
    name: s.name,
    transport: s.transport,
    selected: false,
  }));
  return {
    rows,
    defaultPackMeta: {
      id: "exported-pack",
      label: "Exported servers",
      version: now().toISOString().slice(0, 10),
    },
  };
}

export function buildExportFlowModelForServer(
  server: McpServerConfig,
  allServers: ReadonlyArray<McpServerConfig>,
): ExportFlowModel {
  return {
    rows: [
      {
        id: server.id,
        name: server.name,
        transport: server.transport,
        selected: true,
      },
    ],
    defaultPackMeta: {
      id: defaultPackIdForServer(server, allServers),
      label: server.name,
      version: "1.0.0",
    },
  };
}

export function toggleSelection(
  rows: ReadonlyArray<ExportRow>,
  id: string,
): ExportRow[] {
  return rows.map((r) => (r.id === id ? { ...r, selected: !r.selected } : r));
}

export type ExportResult =
  | { ok: true; pack: Pack; serialized: string }
  | { ok: false; reason: "no-selection" | "validation"; message?: string };

export function runExport(
  rows: ReadonlyArray<ExportRow>,
  servers: ReadonlyArray<McpServerConfig>,
  meta: ExportPackMeta,
  exporter: (servers: McpServerConfig[], meta: ExportPackMeta) => Pack = exportServersAsPack,
): ExportResult {
  const selectedIds = new Set(rows.filter((r) => r.selected).map((r) => r.id));
  if (selectedIds.size === 0) return { ok: false, reason: "no-selection" };
  const ordered = servers.filter((s) => selectedIds.has(s.id));
  try {
    const pack = exporter([...ordered], meta);
    const serialized = JSON.stringify(pack, null, 2);
    return { ok: true, pack, serialized };
  } catch (err) {
    return {
      ok: false,
      reason: "validation",
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

export function suggestedFilename(meta: ExportPackMeta): string {
  const slug = meta.label
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  const safe = slug.length > 0 ? slug : meta.id;
  return `${safe}.pack.json`;
}

function defaultPackIdForServer(
  server: McpServerConfig,
  allServers: ReadonlyArray<McpServerConfig>,
): string {
  const targetBase = slugForPackId(server.name);
  let seen = 0;
  for (const candidate of allServers) {
    if (slugForPackId(candidate.name) !== targetBase) continue;
    seen += 1;
    if (candidate.id === server.id) return seen === 1 ? targetBase : `${targetBase}-${seen}`;
  }
  return targetBase;
}

function slugForPackId(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (base.length === 0) return "server";
  return /^[a-z0-9]/.test(base) ? base : `server${base}`;
}
