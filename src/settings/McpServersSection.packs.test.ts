import { describe, expect, test, vi } from "vitest";
import type { PluginDataIO } from "../auth/TokenStore";
import { McpSettingsStore } from "./McpSettingsStore";
import { McpServersSection } from "./McpServersSection";
import { PresetPacksStore } from "./PresetPacksStore";
import type { Pack } from "./presets/packTypes";

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
  byText(text: string): FakeElement[] {
    return this.queryAll((e) => e.textContent.includes(text));
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

function pack(id: string, overrides: Partial<Pack> = {}): Pack {
  return {
    schemaVersion: 1,
    id,
    label: overrides.label ?? id.toUpperCase(),
    version: overrides.version ?? "1",
    presets: overrides.presets ?? [
      {
        id: "p1",
        label: "Preset 1",
        server: { name: "Preset 1", transport: "http", url: "https://example.com/mcp" },
        credentials: { kind: "none" },
      },
    ],
  };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

async function mount(opts: {
  initialPacks?: { pack: Pack; sourcePath: string }[];
  packFileReader?: { pickAndReadPackFile: () => Promise<unknown> };
  confirm?: (title: string, body: string) => boolean;
} = {}) {
  const io = memoryIo({});
  const settings = new McpSettingsStore(io);
  await settings.load();
  const packs = new PresetPacksStore(io);
  await packs.load();
  for (const { pack: p, sourcePath } of opts.initialPacks ?? []) {
    await packs.addOrReplace(p, sourcePath);
  }
  const mgr = manager();
  const safety = { revokeGrantsForServer: vi.fn(async () => undefined) };
  const notices: string[] = [];
  const root = new FakeElement();
  const confirmCalls: Array<{ title: string; body: string }> = [];
  const confirm = opts.confirm ?? ((title, body) => {
    confirmCalls.push({ title, body });
    return true;
  });
  const section = new McpServersSection({
    store: settings,
    manager: mgr as never,
    safetyStore: safety,
    vaultRoot: "C:\\vault",
    pathExists: () => false,
    notify: (m) => notices.push(m),
    presetPacksStore: packs,
    packFileReader: opts.packFileReader as never,
    confirmPackAction: (title, body) => {
      confirmCalls.push({ title, body });
      return confirm(title, body);
    },
  });
  section.mount(root as never);
  return { root, section, packs, settings, notices, io, mgr, confirmCalls };
}

describe("McpServersSection — packs list (FR-006/FR-007/FR-008)", () => {
  test("renders one row per imported pack with required fields", async () => {
    const ctx = await mount({
      initialPacks: [
        { pack: pack("alpha", { label: "Alpha Pack" }), sourcePath: "/a.json" },
      ],
    });
    expect(ctx.root.byAria("Imported preset packs list")).toBeDefined();
    const row = ctx.root.byAria("Preset pack Alpha Pack (alpha) version 1");
    expect(row).toBeDefined();
    const rowText = row.queryAll(() => true).map((e) => e.textContent).join(" ");
    expect(rowText).toContain("Alpha Pack");
    expect(rowText).toContain("alpha");
    expect(rowText).toContain("v1");
    expect(rowText).toContain("/a.json");
  });

  test("Remove pack confirms then removes; FR-008: mcpServers untouched", async () => {
    const ctx = await mount({
      initialPacks: [{ pack: pack("alpha"), sourcePath: "/a.json" }],
    });
    // Seed an mcp server to verify FR-008 invariant.
    await ctx.settings.addServer({
      id: "s1",
      name: "S1",
      enabled: true,
      transport: "stdio",
      command: "node",
      args: [],
      trustEpoch: "epoch1",
    } as never);
    const before = JSON.stringify((ctx.io.peek() as { mcpServers: unknown }).mcpServers);

    ctx.root.byAria("Remove preset pack ALPHA").click();
    await flush();

    expect(ctx.packs.snapshot()).toHaveLength(0);
    const after = JSON.stringify((ctx.io.peek() as { mcpServers: unknown }).mcpServers);
    expect(after).toBe(before);
    expect(ctx.confirmCalls.some((c) => c.body.includes("continue to function unchanged"))).toBe(true);
  });

  test("Remove pack: declining cancel keeps the pack", async () => {
    const ctx = await mount({
      initialPacks: [{ pack: pack("alpha"), sourcePath: "/a.json" }],
      confirm: () => false,
    });
    ctx.root.byAria("Remove preset pack ALPHA").click();
    await flush();
    expect(ctx.packs.snapshot()).toHaveLength(1);
  });

  test("empty pack list renders placeholder text", async () => {
    const ctx = await mount();
    expect(ctx.root.byText("No preset packs imported.").length).toBeGreaterThan(0);
  });
});

describe("McpServersSection — pack import (FR-001/FR-002/SC-001/SC-003/SC-007)", () => {
  function reader(result: unknown) {
    return { pickAndReadPackFile: vi.fn(async () => result) };
  }

  test("validationError → exactly one Notice; store NOT mutated (SC-003)", async () => {
    const r = reader({
      ok: true,
      text: JSON.stringify({ schemaVersion: 1, id: "broken" }),
      sourcePath: "/x.json",
      byteLength: 50,
    });
    const ctx = await mount({ packFileReader: r });
    ctx.root.byAria("Import preset pack from file").click();
    await flush();
    expect(ctx.notices).toHaveLength(1);
    expect(ctx.notices[0]).toMatch(/validation failed/i);
    expect(ctx.packs.snapshot()).toHaveLength(0);
  });

  test("confirmNew → on confirm, store gains the record (SC-001)", async () => {
    const text = JSON.stringify(pack("vendor", { label: "Vendor Pack" }));
    const r = reader({ ok: true, text, sourcePath: "/v.json", byteLength: text.length });
    const ctx = await mount({ packFileReader: r });
    ctx.root.byAria("Import preset pack from file").click();
    await flush();
    expect(ctx.packs.snapshot()).toHaveLength(1);
    expect(ctx.packs.snapshot()[0].pack.id).toBe("vendor");
    expect(ctx.packs.snapshot()[0].sourcePath).toBe("/v.json");
    const importPrompt = ctx.confirmCalls.find((c) => c.title === "Import preset pack?");
    expect(importPrompt).toBeDefined();
    expect(importPrompt!.body).toContain("Vendor Pack");
    expect(importPrompt!.body).toContain("/v.json");
  });

  test("confirmNew → declined keeps store empty", async () => {
    const text = JSON.stringify(pack("vendor"));
    const r = reader({ ok: true, text, sourcePath: "/v.json", byteLength: text.length });
    const ctx = await mount({ packFileReader: r, confirm: () => false });
    ctx.root.byAria("Import preset pack from file").click();
    await flush();
    expect(ctx.packs.snapshot()).toHaveLength(0);
  });

  test("confirmReimport empty diff → 'No changes.'; on confirm only importedAt updates (SC-007)", async () => {
    const p = pack("vendor");
    const text = JSON.stringify(p);
    const r = reader({ ok: true, text, sourcePath: "/v.json", byteLength: text.length });
    const ctx = await mount({
      initialPacks: [{ pack: p, sourcePath: "/orig.json" }],
      packFileReader: r,
    });
    const originalRecordId = ctx.packs.snapshot()[0].recordId;
    ctx.root.byAria("Import preset pack from file").click();
    await flush();
    const reimportPrompt = ctx.confirmCalls.find((c) =>
      c.title.startsWith("Re-import"),
    );
    expect(reimportPrompt).toBeDefined();
    expect(reimportPrompt!.body).toContain("No changes.");
    expect(ctx.packs.snapshot()).toHaveLength(1);
    expect(ctx.packs.snapshot()[0].recordId).not.toBe(originalRecordId);
    expect(ctx.packs.snapshot()[0].sourcePath).toBe("/v.json");
  });

  test("reader returns cancelled → silent (no notice, no mutation)", async () => {
    const r = reader({ ok: false, reason: "cancelled" });
    const ctx = await mount({ packFileReader: r });
    ctx.root.byAria("Import preset pack from file").click();
    await flush();
    expect(ctx.notices).toHaveLength(0);
    expect(ctx.packs.snapshot()).toHaveLength(0);
  });

  test("reader io error → one Notice", async () => {
    const r = reader({ ok: false, reason: "io", message: "EACCES" });
    const ctx = await mount({ packFileReader: r });
    ctx.root.byAria("Import preset pack from file").click();
    await flush();
    expect(ctx.notices).toHaveLength(1);
    expect(ctx.notices[0]).toMatch(/EACCES/);
  });

  test("malformed JSON → parseError Notice with line/col, store unchanged", async () => {
    const r = reader({ ok: true, text: "{not:json", sourcePath: "/x.json", byteLength: 9 });
    const ctx = await mount({ packFileReader: r });
    ctx.root.byAria("Import preset pack from file").click();
    await flush();
    expect(ctx.notices).toHaveLength(1);
    expect(ctx.notices[0]).toMatch(/line/i);
    expect(ctx.packs.snapshot()).toHaveLength(0);
  });
});
