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
  };
}

function httpServer(id: string, name: string, authorization?: string): McpServerConfig {
  const base = {
    id: normalizeServerId(id),
    name,
    enabled: true,
    transport: "http" as const,
    url: "https://example.org/mcp",
    ...(authorization ? { authorization } : {}),
  };
  return { ...base, trustEpoch: computeTrustEpoch(base) };
}

function stdioServer(id: string, name: string): McpServerConfig {
  const base = {
    id: normalizeServerId(id),
    name,
    enabled: true,
    transport: "stdio" as const,
    command: "internal-mcp-cli",
    args: ["--endpoint", "https://example.org/mcp"],
    env: { MCP_LOG_LEVEL: "info" },
  };
  return { ...base, trustEpoch: computeTrustEpoch(base) };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

async function mount(opts: {
  servers?: McpServerConfig[];
  writer?: { saveTextToPath: (name: string, text: string) => Promise<PackFileWriteResult> } | null;
} = {}) {
  const io = memoryIo({ mcpServers: opts.servers ?? [] });
  const settings = new McpSettingsStore(io);
  await settings.load();
  const root = new FakeElement();
  const writeCalls: Array<{ name: string; text: string }> = [];
  const writer = opts.writer === undefined
    ? {
        saveTextToPath: vi.fn(async (name: string, text: string) => {
          writeCalls.push({ name, text });
          return { ok: true, path: `C:/vault/exported-packs/${name}` } as PackFileWriteResult;
        }),
      }
    : opts.writer;
  const notices: string[] = [];
  const section = new McpServersSection({
    store: settings,
    manager: manager() as never,
    safetyStore: { revokeGrantsForServer: vi.fn(async () => undefined) },
    vaultRoot: "C:\\vault",
    pathExists: () => false,
    notify: (m) => notices.push(m),
    ...(writer ? { packFileWriter: writer as never } : {}),
  });
  section.mount(root as never);
  return { root, writeCalls, notices };
}

describe("McpServersSection — per-row pack export", () => {
  test("row shortcut writes a one-preset pack and omits other servers", async () => {
    const ctx = await mount({
      servers: [
        httpServer("alpha", "Example Corp Graph", "Bearer generic-token"),
        httpServer("beta", "Other Server"),
      ],
    });
    ctx.root.byAria("Export Example Corp Graph as preset pack").click();
    await flush();
    ctx.root.byAria("Export Example Corp Graph").click();
    await flush();

    expect(ctx.writeCalls).toHaveLength(1);
    const pack = JSON.parse(ctx.writeCalls[0].text) as { id: string; presets: Array<{ label: string }> };
    expect(pack.id).toBe("example-corp-graph");
    expect(pack.presets).toHaveLength(1);
    expect(pack.presets[0].label).toBe("Example Corp Graph");
    expect(ctx.writeCalls[0].text).not.toContain("Other Server");
    expect(ctx.writeCalls[0].text).not.toContain("generic-token");
    expect(ctx.writeCalls[0].text).toContain("__NEEDS_VALUE__");
  });

  test("cancel closes the row dialog without writing", async () => {
    const ctx = await mount({ servers: [httpServer("alpha", "Example Corp Graph")] });
    ctx.root.byAria("Export Example Corp Graph as preset pack").click();
    await flush();
    const cancel = ctx.root.queryAll((e) => e.tagName === "button" && e.textContent === "Cancel")[0];
    cancel.click();
    await flush();
    expect(ctx.writeCalls).toHaveLength(0);
    expect(ctx.root.byAriaAll("Export Example Corp Graph as preset pack")).toHaveLength(1);
  });

  test("duplicate server-name slugs get stable default pack ids", async () => {
    const ctx = await mount({
      servers: [
        httpServer("first", "Example Graph"),
        httpServer("second", "Example---Graph"),
      ],
    });
    ctx.root.byAria("Export Example---Graph as preset pack").click();
    await flush();
    expect(ctx.root.byAria("Pack id").value).toBe("example-graph-2");
  });

  test("stdio rows expose the shortcut and export successfully", async () => {
    const ctx = await mount({ servers: [stdioServer("stdio", "internal-mcp-cli")] });
    ctx.root.byAria("Export internal-mcp-cli as preset pack").click();
    await flush();
    ctx.root.byAria("Export internal-mcp-cli").click();
    await flush();
    expect(ctx.writeCalls).toHaveLength(1);
    expect(ctx.writeCalls[0].text).toContain('"transport": "stdio"');
    expect(ctx.writeCalls[0].text).toContain('"command": "internal-mcp-cli"');
  });

  test("row shortcut is absent when no writer is wired", async () => {
    const ctx = await mount({
      servers: [httpServer("alpha", "Example Corp Graph")],
      writer: null,
    });
    expect(() => ctx.root.byAria("Export Example Corp Graph as preset pack")).toThrow();
  });
});
