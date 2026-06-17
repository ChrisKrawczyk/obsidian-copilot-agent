import { describe, expect, test, vi } from "vitest";
import { computeTrustEpoch, normalizeServerId } from "../mcp/McpIdentity";
import type { McpServerConfig } from "../mcp/McpTypes";
import { McpSettingsStore } from "./McpSettingsStore";
import { McpServersSection } from "./McpServersSection";

class El {
  children: El[] = [];
  textContent = "";
  attributes = new Map<string, string>();
  value = "";
  checked = false;
  type = "text";
  dataset: Record<string, string> = {};
  removedWrites = 0;
  constructor(private readonly onWrite?: () => void) {}
  createEl(_tag: string, opts: { text?: string; attr?: Record<string, string> } = {}): El { const el = new El(this.onWrite); if (opts.text) el.textContent = opts.text; for (const [k, v] of Object.entries(opts.attr ?? {})) el.setAttribute(k, v); this.children.push(el); return el; }
  createDiv(opts?: { text?: string; attr?: Record<string, string> }): El { return this.createEl("div", opts); }
  empty(): void { this.onWrite?.(); this.children = []; }
  setText(text: string): void { this.onWrite?.(); this.textContent = text; }
  setAttribute(k: string, v: string): void { this.attributes.set(k, v); }
  addEventListener(): void {}
  toggleAttribute(): void {}
  remove(): void { this.removedWrites += 1; }
}

function io(initial: unknown) { let data = initial; return { loadData: async () => data, saveData: async (next: unknown) => { data = next; } }; }
function server(): McpServerConfig { const base = { id: normalizeServerId("alpha"), name: "Alpha", enabled: true, transport: "stdio" as const, command: "node", args: [] }; return { ...base, trustEpoch: computeTrustEpoch(base) }; }
function manager() { const listeners = new Set<() => void>(); return { statusSnapshot: () => [], enable: vi.fn(), disable: vi.fn(), reconnect: vi.fn(), remove: vi.fn(), subscribe: (fn: () => void) => { listeners.add(fn); return () => listeners.delete(fn); }, emit: () => listeners.forEach((fn) => fn()), count: () => listeners.size }; }

describe("McpServersSection lifecycle", () => {
  test("mounting and unmounting repeatedly cleans subscriptions", async () => {
    const store = new McpSettingsStore(io({ mcpServers: [server()] }));
    await store.load();
    const mgr = manager();
    for (let i = 0; i < 5; i += 1) {
      const section = new McpServersSection({ store, manager: mgr as never, safetyStore: { revokeGrantsForServer: vi.fn() }, vaultRoot: "C:\\vault" });
      section.mount(new El() as never);
      expect((store as unknown as { listeners: Set<unknown> }).listeners.size).toBe(1);
      expect(mgr.count()).toBe(1);
      section.dispose();
      expect((store as unknown as { listeners: Set<unknown> }).listeners.size).toBe(0);
      expect(mgr.count()).toBe(0);
    }
  });

  test("plugin reload does not update destroyed DOM nodes", async () => {
    const store = new McpSettingsStore(io({ mcpServers: [server()] }));
    await store.load();
    const mgr = manager();
    let writesAfterDestroy = 0;
    let destroyed = false;
    const root = new El(() => { if (destroyed) writesAfterDestroy += 1; });
    const section = new McpServersSection({ store, manager: mgr as never, safetyStore: { revokeGrantsForServer: vi.fn() }, vaultRoot: "C:\\vault" });
    section.mount(root as never);
    section.dispose();
    destroyed = true;
    mgr.emit();
    await store.setEnabled(normalizeServerId("alpha"), false);
    expect(writesAfterDestroy).toBe(0);
  });
});
