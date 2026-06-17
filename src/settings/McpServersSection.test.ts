import { describe, expect, test, vi } from "vitest";
import { computeTrustEpoch, normalizeServerId } from "../mcp/McpIdentity";
import type { McpServerConfig, McpServerRuntimeSnapshot } from "../mcp/McpTypes";
import { McpSettingsStore } from "./McpSettingsStore";
import { AUTHORIZATION_STORAGE_NOTICE, PRIVATE_NETWORK_CONFIRMATION_COPY } from "./mcpServerFormLogic";
import { McpServersSection } from "./McpServersSection";

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
  createDiv(options?: { text?: string; cls?: string; attr?: Record<string, string> }): FakeElement { return this.createEl("div", options); }
  appendChild(el: FakeElement): void { el.parent = this; this.children.push(el); }
  empty(): void { this.children = []; this.textContent = ""; }
  setText(text: string): void { this.textContent = text; }
  setAttribute(key: string, value: string): void { this.attributes.set(key, value); }
  getAttribute(key: string): string | undefined { return this.attributes.get(key); }
  addEventListener(name: string, fn: (event?: unknown) => void): void { this.listeners.set(name, [...(this.listeners.get(name) ?? []), fn]); }
  click(): void { for (const fn of this.listeners.get("click") ?? []) fn({ target: this }); }
  change(): void { for (const fn of this.listeners.get("change") ?? []) fn({ target: this }); }
  toggleAttribute(key: string, force?: boolean): void {
    if (force === false) this.attributes.delete(key);
    else this.attributes.set(key, "");
    if (key === "disabled") this.disabled = force !== false;
  }
  remove(): void { if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this); this.parent = null; }
  queryAll(predicate: (el: FakeElement) => boolean): FakeElement[] { return [this, ...this.children.flatMap((c) => c.queryAll(predicate))].filter(predicate); }
  byAria(label: string): FakeElement { const found = this.queryAll((e) => e.getAttribute("aria-label") === label)[0]; if (!found) throw new Error(`Missing aria ${label}`); return found; }
  byText(text: string): FakeElement { const found = this.queryAll((e) => e.textContent.includes(text))[0]; if (!found) throw new Error(`Missing text ${text}`); return found; }
}

function io(initial: unknown) {
  let data = initial;
  return { loadData: async () => data, saveData: async (next: unknown) => { data = next; }, peek: () => data };
}

function stdio(id = "alpha"): McpServerConfig {
  const base = { id: normalizeServerId(id), name: "Alpha", enabled: true, transport: "stdio" as const, command: "node", args: [] };
  return { ...base, trustEpoch: computeTrustEpoch(base) };
}

function http(): McpServerConfig {
  const base = { id: normalizeServerId("http"), name: "HTTP", enabled: true, transport: "http" as const, url: "https://example.com/mcp", authorization: "Bearer secret" };
  return { ...base, trustEpoch: computeTrustEpoch(base) };
}

function manager(statuses: McpServerRuntimeSnapshot[] = []) {
  const listeners = new Set<() => void>();
  return {
    enable: vi.fn(async () => undefined),
    disable: vi.fn(async () => undefined),
    reconnect: vi.fn(async () => undefined),
    remove: vi.fn(async () => undefined),
    statusSnapshot: () => statuses,
    subscribe: (fn: () => void) => { listeners.add(fn); return () => listeners.delete(fn); },
    listenerCount: () => listeners.size,
  };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

async function mount(initial: McpServerConfig[] = [], statuses: McpServerRuntimeSnapshot[] = []) {
  const store = new McpSettingsStore(io({ mcpServers: initial }));
  await store.load();
  const notices: string[] = [];
  const mgr = manager(statuses);
  const safety = { revokeGrantsForServer: vi.fn(async () => undefined) };
  const root = new FakeElement();
  const section = new McpServersSection({ store, manager: mgr as never, safetyStore: safety, vaultRoot: "C:\\vault", pathExists: (p) => p === "C:\\vault", notify: (m) => notices.push(m) });
  section.mount(root as never);
  return { root, section, store, mgr, safety, notices };
}

describe("McpServersSection", () => {
  test("add, edit, remove, enable, disable, and reconnect flows", async () => {
    const ctx = await mount();
    ctx.root.byAria("Add MCP server").click();
    ctx.root.byAria("Server id").value = "alpha";
    ctx.root.byAria("Display name").value = "Alpha";
    ctx.root.byAria("Command").value = "node";
    ctx.root.byAria("Save MCP server").click();
    await flush();
    expect(ctx.store.snapshot()).toHaveLength(1);
    expect(ctx.mgr.enable).toHaveBeenCalledTimes(1);

    ctx.root.byAria("Edit Alpha").click();
    ctx.root.byAria("Command").value = "python";
    ctx.root.byAria("Save MCP server").click();
    await flush();
    expect(ctx.store.snapshot()[0]).toMatchObject({ command: "python" });

    ctx.root.byAria("Disable Alpha").click();
    await flush();
    expect(ctx.mgr.disable).toHaveBeenCalledWith(normalizeServerId("alpha"));
    ctx.root.byAria("Enable Alpha").click();
    await flush();
    expect(ctx.mgr.enable).toHaveBeenCalledTimes(3);
    ctx.root.byAria("Reconnect Alpha").click();
    await flush();
    expect(ctx.mgr.reconnect).toHaveBeenCalledWith(normalizeServerId("alpha"));
    ctx.root.byAria("Remove Alpha").click();
    await flush();
    expect(ctx.mgr.remove).toHaveBeenCalledWith(normalizeServerId("alpha"));
    expect(ctx.store.snapshot()).toHaveLength(0);
  });

  test("private-network confirmation copy blocks save until confirmed", async () => {
    const ctx = await mount();
    ctx.root.byAria("Add MCP server").click();
    ctx.root.byAria("Server id").value = "priv";
    ctx.root.byAria("Display name").value = "Private";
    ctx.root.byAria("Transport").value = "http";
    ctx.root.byAria("URL").value = "https://192.168.1.2/mcp";
    ctx.root.byAria("Save MCP server").click();
    expect(ctx.root.byText(PRIVATE_NETWORK_CONFIRMATION_COPY)).toBeTruthy();
    ctx.root.byAria(PRIVATE_NETWORK_CONFIRMATION_COPY).checked = true;
    ctx.root.byAria("Save MCP server").click();
    await flush();
    expect(ctx.store.snapshot()).toHaveLength(1);
  });

  test("metadata-host errors render in the form", async () => {
    const ctx = await mount();
    ctx.root.byAria("Add MCP server").click();
    ctx.root.byAria("Server id").value = "meta";
    ctx.root.byAria("Transport").value = "http";
    ctx.root.byAria("URL").value = "https://169.254.169.254/mcp";
    ctx.root.byAria("Save MCP server").click();
    expect(ctx.root.byText("cloud metadata host")).toBeTruthy();
  });

  test("last-error rendering is textContent only and redacted", async () => {
    const ctx = await mount([stdio()], [{ id: normalizeServerId("alpha"), status: "error", lastError: "Bearer super-secret", toolCount: 0 }]);
    const error = ctx.root.byAria("Last error for Alpha");
    expect(error.textContent).toContain("[REDACTED]");
    expect(error.innerHTML).toBe("");
  });

  test("denylist-env warning and one-shot Notice on save", async () => {
    const ctx = await mount();
    ctx.root.byAria("Add MCP server").click();
    ctx.root.byAria("Server id").value = "env";
    ctx.root.byAria("Command").value = "node";
    ctx.root.byAria("Environment").value = "GITHUB_TOKEN=x";
    ctx.root.byAria("Save MCP server").click();
    await flush();
    expect(ctx.notices.join("\n")).toContain("GITHUB_TOKEN");
    expect(ctx.root.byText("override denylist")).toBeTruthy();
  });

  test("Authorization storage Notice is one-shot", async () => {
    const ctx = await mount();
    for (const id of ["h1", "h2"]) {
      ctx.root.byAria("Add MCP server").click();
      ctx.root.byAria("Server id").value = id;
      ctx.root.byAria("Transport").value = "http";
      ctx.root.byAria("URL").value = `https://example.com/${id}`;
      ctx.root.byAria("Authorization").value = "Bearer secret";
      ctx.root.byAria("Save MCP server").click();
      await flush();
    }
    expect(ctx.notices.filter((n) => n === AUTHORIZATION_STORAGE_NOTICE)).toHaveLength(1);
  });

  test("trust-epoch grant-revocation Notice is exactly once", async () => {
    const ctx = await mount([stdio()]);
    for (const command of ["python", "ruby"]) {
      ctx.root.byAria("Edit Alpha").click();
      ctx.root.byAria("Command").value = command;
      ctx.root.byAria("Save MCP server").click();
      await flush();
    }
    expect(ctx.notices.filter((n) => n.includes("MCP grants were revoked"))).toHaveLength(1);
    expect(ctx.safety.revokeGrantsForServer).toHaveBeenCalled();
  });

  test("accessible row labels include server identity and status", async () => {
    const ctx = await mount([http()], [{ id: normalizeServerId("http"), status: "connected", toolCount: 3 }]);
    const rows = ctx.root.queryAll((e) => e.getAttribute("role") === "listitem");
    expect(rows[0].getAttribute("aria-label")).toContain("MCP server HTTP (http) status connected");
  });
});
