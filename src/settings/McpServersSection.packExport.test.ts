import { describe, expect, test, vi } from "vitest";
import type { PluginDataIO } from "../auth/TokenStore";
import { computeTrustEpoch, normalizeServerId } from "../mcp/McpIdentity";
import type { McpServerConfig } from "../mcp/McpTypes";
import { McpSettingsStore } from "./McpSettingsStore";
import { McpServersSection } from "./McpServersSection";
import type { PackFileWriteResult } from "./presets/packFileIO";

class FakeElement {
  children: FakeElement[] = [];
  parent: FakeElement | null = null;
  textContent = "";
  className = "";
  attributes = new Map<string, string>();
  listeners = new Map<string, Array<(event?: unknown) => void>>();
  value = "";
  checked = false;
  type = "text";
  dataset: Record<string, string> = {};
  disabled = false;
  innerHTML = "";
  constructor(readonly tagName = "div") {}
  createEl(tag: string, options: { text?: string; cls?: string; attr?: Record<string, string> } = {}): FakeElement {
    const el = new FakeElement(tag);
    if (options.text !== undefined) el.textContent = options.text;
    if (options.cls) el.className = options.cls;
    for (const [k, v] of Object.entries(options.attr ?? {})) el.setAttribute(k, v);
    this.appendChild(el);
    return el;
  }
  createDiv(options?: { text?: string; cls?: string; attr?: Record<string, string> }): FakeElement {
    return this.createEl("div", options);
  }
  appendChild(el: FakeElement): void { el.parent = this; this.children.push(el); }
  empty(): void { this.children = []; this.textContent = ""; }
  setText(text: string): void { this.textContent = text; }
  setAttribute(key: string, value: string): void { this.attributes.set(key, value); }
  getAttribute(key: string): string | undefined { return this.attributes.get(key); }
  removeAttribute(key: string): void { this.attributes.delete(key); }
  addEventListener(name: string, fn: (event?: unknown) => void): void {
    this.listeners.set(name, [...(this.listeners.get(name) ?? []), fn]);
  }
  click(): void { for (const fn of this.listeners.get("click") ?? []) fn({ target: this }); }
  change(): void { for (const fn of this.listeners.get("change") ?? []) fn({ target: this }); }
  toggleAttribute(key: string, force?: boolean): void {
    if (force === false) this.attributes.delete(key);
    else this.attributes.set(key, "");
  }
  remove(): void {
    if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this);
    this.parent = null;
  }
  queryAll(predicate: (el: FakeElement) => boolean): FakeElement[] {
    return [this, ...this.children.flatMap((c) => c.queryAll(predicate))].filter(predicate);
  }
  byAria(label: string): FakeElement {
    const found = this.queryAll((e) => e.getAttribute("aria-label") === label)[0];
    if (!found) throw new Error(`Missing aria ${label}`);
    return found;
  }
  byAriaAll(label: string): FakeElement[] {
    return this.queryAll((e) => e.getAttribute("aria-label") === label);
  }
}

function memoryIo(initial: unknown = null): PluginDataIO & { peek: () => unknown } {
  let store: unknown = initial;
  return {
    loadData: async () => store,
    saveData: async (data: unknown) => { store = data; },
    peek: () => store,
  };
}

function manager() {
  const listeners = new Set<() => void>();
  return {
    enable: vi.fn(async () => undefined),
    disable: vi.fn(async () => undefined),
    reconnect: vi.fn(async () => undefined),
    manualReconnect: vi.fn(async () => undefined),
    remove: vi.fn(async () => undefined),
    statusSnapshot: () => [],
    subscribe: (fn: () => void) => { listeners.add(fn); return () => listeners.delete(fn); },
    listenerCount: () => listeners.size,
  };
}

function httpServer(id: string, name: string, authorization?: string): McpServerConfig {
  const base = {
    id: normalizeServerId(id),
    name,
    enabled: true,
    transport: "http" as const,
    url: "https://example.com/mcp",
    ...(authorization ? { authorization } : {}),
  };
  return { ...base, trustEpoch: computeTrustEpoch(base) };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

async function mount(opts: {
  servers?: McpServerConfig[];
  writer?: { saveTextToPath: (name: string, text: string) => Promise<PackFileWriteResult> };
} = {}) {
  const io = memoryIo({ mcpServers: opts.servers ?? [] });
  const settings = new McpSettingsStore(io);
  await settings.load();
  const mgr = manager();
  const safety = { revokeGrantsForServer: vi.fn(async () => undefined) };
  const notices: string[] = [];
  const root = new FakeElement();
  const writeCalls: Array<{ name: string; text: string }> = [];
  const defaultWriter = {
    saveTextToPath: vi.fn(async (name: string, text: string) => {
      writeCalls.push({ name, text });
      return { ok: true, path: `C:/vault/exported-packs/${name}` } as PackFileWriteResult;
    }),
  };
  const writer = opts.writer ?? defaultWriter;
  const section = new McpServersSection({
    store: settings,
    manager: mgr as never,
    safetyStore: safety,
    vaultRoot: "C:\\vault",
    pathExists: () => false,
    notify: (m) => notices.push(m),
    packFileWriter: writer as never,
  });
  section.mount(root as never);
  return { root, section, settings, notices, writer, writeCalls };
}

describe("McpServersSection — Export servers as pack (Phase 4)", () => {
  test("Export button is not rendered when no packFileWriter is wired", async () => {
    const io = memoryIo({ mcpServers: [] });
    const settings = new McpSettingsStore(io);
    await settings.load();
    const root = new FakeElement();
    const section = new McpServersSection({
      store: settings,
      manager: manager() as never,
      safetyStore: { revokeGrantsForServer: vi.fn(async () => undefined) },
      vaultRoot: "C:\\vault",
      pathExists: () => false,
    });
    section.mount(root as never);
    expect(() => root.byAria("Export servers as preset pack")).toThrow();
  });

  test("notifies when there are no servers to export", async () => {
    const ctx = await mount();
    ctx.root.byAria("Export servers as preset pack").click();
    await flush();
    expect(ctx.notices.some((n) => /No MCP servers/.test(n))).toBe(true);
  });

  test("opens dialog, selects, exports, and invokes writer with sanitized filename + serialized JSON", async () => {
    const ctx = await mount({
      servers: [httpServer("alpha", "Alpha Service", "Bearer secret-token")],
    });
    ctx.root.byAria("Export servers as preset pack").click();
    await flush();
    // Toggle the only server checkbox
    const checkboxes = ctx.root.queryAll((e) => e.tagName === "input" && e.type === "checkbox");
    expect(checkboxes.length).toBeGreaterThan(0);
    checkboxes[0].checked = true;
    checkboxes[0].change();
    // Update pack label
    ctx.root.byAria("Pack label").value = "My Servers";
    ctx.root.byAria("Export selected servers").click();
    await flush();
    expect(ctx.writeCalls).toHaveLength(1);
    expect(ctx.writeCalls[0].name).toBe("my-servers.pack.json");
    expect(ctx.writeCalls[0].text).toContain("__NEEDS_VALUE__");
    expect(ctx.writeCalls[0].text).not.toContain("secret-token");
    expect(ctx.notices.some((n) => /Exported pack/.test(n))).toBe(true);
  });

  test("Export with no selection surfaces inline error and does not call writer", async () => {
    const ctx = await mount({ servers: [httpServer("alpha", "Alpha")] });
    ctx.root.byAria("Export servers as preset pack").click();
    await flush();
    ctx.root.byAria("Export selected servers").click();
    await flush();
    expect(ctx.writeCalls).toHaveLength(0);
  });

  test("Cancel closes the dialog without writing", async () => {
    const ctx = await mount({ servers: [httpServer("alpha", "Alpha")] });
    ctx.root.byAria("Export servers as preset pack").click();
    await flush();
    const cancelBtns = ctx.root.queryAll((e) => e.tagName === "button" && e.textContent === "Cancel");
    expect(cancelBtns.length).toBeGreaterThan(0);
    cancelBtns[0].click();
    await flush();
    expect(ctx.writeCalls).toHaveLength(0);
  });
});
