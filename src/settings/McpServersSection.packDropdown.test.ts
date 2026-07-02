import { describe, expect, test, vi } from "vitest";
import type { PluginDataIO } from "../auth/TokenStore";
import { McpSettingsStore } from "./McpSettingsStore";
import { McpServersSection } from "./McpServersSection";
import { PresetPacksStore } from "./PresetPacksStore";
import type { Pack } from "./presets/packTypes";
import { SECRET_PLACEHOLDER } from "./presets/packSecretPolicy";

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

function bearerPack(packId: string, presetId: string, label: string): Pack {
  return {
    schemaVersion: 1,
    id: packId,
    label,
    version: "1",
    presets: [
      {
        id: presetId,
        label,
        server: { name: label, transport: "http", url: "https://example.org/api/mcp" },
        credentials: { kind: "static-bearer", token: SECRET_PLACEHOLDER },
      },
    ],
  };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

async function mount(opts: { initialPacks?: Pack[]; commandExists?: (cmd: string) => boolean } = {}) {
  const io = memoryIo({});
  const settings = new McpSettingsStore(io);
  await settings.load();
  const packs = new PresetPacksStore(io);
  await packs.load();
  for (const p of opts.initialPacks ?? []) {
    await packs.addOrReplace(p, `/path/${p.id}.json`);
  }
  const mgr = manager();
  const safety = { revokeGrantsForServer: vi.fn(async () => undefined) };
  const notices: string[] = [];
  const root = new FakeElement();
  const executableExists = vi.fn(opts.commandExists ?? (() => true));
  const section = new McpServersSection({
    store: settings,
    manager: mgr as never,
    safetyStore: safety,
    vaultRoot: "C:\\vault",
    pathExists: (p) => p === "C:\\vault",
    executableExists,
    notify: (m) => notices.push(m),
    presetPacksStore: packs,
    confirmPackAction: () => true,
  });
  section.mount(root as never);
  return { root, section, packs, settings, notices, executableExists };
}

describe("McpServersSection preset dropdown (Phase 4)", () => {
  test("zero imported packs: dropdown still appears with built-in presets only", async () => {
    const ctx = await mount();
    ctx.root.byAria("Add MCP server").click();
    const presetSelect = ctx.root.byAria("Preset");
    expect(presetSelect).toBeDefined();
  });

  test("imported pack adds selectable preset option", async () => {
    const p = bearerPack("alpha", "svc", "Alpha Service");
    const ctx = await mount({ initialPacks: [p] });
    ctx.root.byAria("Add MCP server").click();
    const presetSelect = ctx.root.byAria("Preset");
    // FakeElement renders the flat option-id children
    const childIds = presetSelect.children.map((c) => c.value);
    expect(childIds).toContain("svc");
  });

  test("selecting a templatized pack preset leaves authorization empty and renders required hint", async () => {
    const p = bearerPack("alpha", "svc", "Alpha Service");
    const ctx = await mount({ initialPacks: [p] });
    ctx.root.byAria("Add MCP server").click();
    const presetSelect = ctx.root.byAria("Preset");
    presetSelect.value = "svc";
    presetSelect.change();
    await flush();
    const auth = ctx.root.byAria("Authorization");
    expect(auth.value).toBe("");
    expect(auth.getAttribute("aria-required")).toBe("true");
    const hint = ctx.root.byAria("Preset preflight hint");
    expect(hint.textContent).toMatch(/Pack-templatized/);
    expect(hint.textContent).toMatch(/authorization/);
  });

  test("removing pack hides its presets from dropdown on re-render", async () => {
    const p = bearerPack("alpha", "svc", "Alpha Service");
    const ctx = await mount({ initialPacks: [p] });
    await ctx.packs.remove("alpha");
    await flush();
    ctx.root.byAria("Add MCP server").click();
    const presetSelect = ctx.root.byAria("Preset");
    const childIds = presetSelect.children.map((c) => c.value);
    expect(childIds).not.toContain("svc");
  });

  test("selecting pack preset without preflight does NOT invoke executableExists", async () => {
    const p = bearerPack("alpha", "svc", "Alpha Service");
    const ctx = await mount({ initialPacks: [p] });
    ctx.root.byAria("Add MCP server").click();
    const presetSelect = ctx.root.byAria("Preset");
    presetSelect.value = "svc";
    presetSelect.change();
    await flush();
    expect(ctx.executableExists).not.toHaveBeenCalled();
  });

  test("selecting pack preset with preflight renders install hint when binary is absent", async () => {
    const p = bearerPack("alpha", "svc", "Alpha Service");
    p.presets[0].credentials = { kind: "none" };
    p.presets[0].preflight = {
      type: "findOnPath",
      command: "internal-mcp-cli",
      installHint: "Install internal-mcp-cli",
    };
    const ctx = await mount({
      initialPacks: [p],
      commandExists: () => false,
    });

    ctx.root.byAria("Add MCP server").click();
    const presetSelect = ctx.root.byAria("Preset");
    presetSelect.value = "svc";
    presetSelect.change();
    await flush();

    expect(ctx.executableExists).toHaveBeenCalledWith("internal-mcp-cli");
    const hint = ctx.root.byAria("Preset preflight hint");
    expect(hint.textContent).toContain("internal-mcp-cli");
    expect(hint.textContent).toContain("Install with: Install internal-mcp-cli");
    expect(hint.textContent).toContain("You can still save");
  });

  test("save fails until templatized field filled (FR-020 hard block)", async () => {
    const p = bearerPack("alpha", "svc", "Alpha Service");
    const ctx = await mount({ initialPacks: [p] });
    ctx.root.byAria("Add MCP server").click();
    ctx.root.byAria("Server ID").value = "newsvc";
    ctx.root.byAria("Display name").value = "New Svc";
    const presetSelect = ctx.root.byAria("Preset");
    presetSelect.value = "svc";
    presetSelect.change();
    await flush();
    ctx.root.byAria("Save MCP server").click();
    await flush();
    expect(ctx.settings.snapshot()).toHaveLength(0);
    // Fill the field and try again
    ctx.root.byAria("Authorization").value = "Bearer real-token";
    ctx.root.byAria("Save MCP server").click();
    await flush();
    expect(ctx.settings.snapshot()).toHaveLength(1);
  });

  test("requiredSecretFields does NOT leak across forms (issue 3 regression)", async () => {
    const p = bearerPack("alpha", "svc", "Alpha Service");
    const ctx = await mount({ initialPacks: [p] });
    // First Add: select templatized pack preset but never fill it.
    ctx.root.byAria("Add MCP server").click();
    const sel1 = ctx.root.byAria("Preset");
    sel1.value = "svc";
    sel1.change();
    await flush();
    // Cancel the first form
    ctx.root.byAria("Cancel MCP server edit").click();
    await flush();
    // Second Add: do NOT select a pack preset; fill in a basic stdio server.
    ctx.root.byAria("Add MCP server").click();
    ctx.root.byAria("Server ID").value = "plain";
    ctx.root.byAria("Display name").value = "Plain";
    ctx.root.byAria("Command").value = "node";
    ctx.root.byAria("Save MCP server").click();
    await flush();
    // The leaked `authorization` required field would have blocked this save.
    expect(ctx.settings.snapshot()).toHaveLength(1);
    expect(ctx.settings.snapshot()[0].name).toBe("Plain");
  });
});
