import { describe, expect, test, vi } from "vitest";
import { computeTrustEpoch, normalizeServerId } from "../mcp/McpIdentity";
import { McpServersSection } from "./McpServersSection";
import { McpSettingsStore } from "./McpSettingsStore";
import type { McpServerConfig, McpServerRuntimeSnapshot } from "../mcp/McpTypes";

class FakeElement {
  children: FakeElement[] = [];
  parent: FakeElement | null = null;
  textContent = "";
  className = "";
  attrs: Record<string, string> = {};
  value = "";
  checked = false;
  type = "";
  placeholder = "";
  dataset: Record<string, string> = {};
  constructor(public tagName = "div") {}
  setAttribute(name: string, value: string): void { this.attrs[name] = value; }
  getAttribute(name: string): string | null { return this.attrs[name] ?? null; }
  removeAttribute(name: string): void { delete this.attrs[name]; }
  toggleAttribute(name: string, force?: boolean): void { if (force === false || (force === undefined && name in this.attrs)) delete this.attrs[name]; else this.attrs[name] = ""; }
  createEl(tag: string, options: { text?: string; cls?: string; attr?: Record<string, string> } = {}): FakeElement {
    const el = new FakeElement(tag);
    if (options.text !== undefined) el.textContent = options.text;
    if (options.cls) el.className = options.cls;
    for (const [k, v] of Object.entries(options.attr ?? {})) el.setAttribute(k, v);
    this.appendChild(el);
    return el;
  }
  createDiv(o?: { text?: string; cls?: string; attr?: Record<string, string> }): FakeElement { return this.createEl("div", o); }
  appendChild(el: FakeElement): void { el.parent = this; this.children.push(el); }
  empty(): void { this.children = []; this.textContent = ""; }
  setText(text: string): void { this.textContent = text; }
  replaceChildren(): void { this.children = []; }
  remove(): void { if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this); }
  addEventListener(name: string, fn: EventListener): void { (this as unknown as Record<string, EventListener>)["__" + name] = fn; }
  click(): void { const fn = (this as unknown as Record<string, EventListener>)["__click"]; if (fn) fn({ target: this } as unknown as Event); }
  queryAll(predicate: (el: FakeElement) => boolean): FakeElement[] { return [this, ...this.children.flatMap((c) => c.queryAll(predicate))].filter(predicate); }
  byAria(label: string): FakeElement { const found = this.queryAll((e) => e.getAttribute("aria-label") === label)[0]; if (!found) throw new Error(`Missing aria ${label}`); return found; }
  byText(text: string): FakeElement { const found = this.queryAll((e) => e.textContent.includes(text))[0]; if (!found) throw new Error(`Missing text ${text}`); return found; }
}

function io(initial: unknown) {
  let data = initial;
  return { loadData: async () => data, saveData: async (next: unknown) => { data = next; }, peek: () => data };
}

function manager(statuses: McpServerRuntimeSnapshot[] = []) {
  const listeners = new Set<() => void>();
  return {
    enable: vi.fn(async () => undefined),
    disable: vi.fn(async () => undefined),
    reconnect: vi.fn(async () => undefined),
    manualReconnect: vi.fn(async () => undefined),
    remove: vi.fn(async () => undefined),
    statusSnapshot: () => statuses,
    subscribe: (fn: () => void) => { listeners.add(fn); return () => listeners.delete(fn); },
    onCredentialConfigChanged: vi.fn(),
    testConnection: vi.fn(async () => ({ ok: true as const })),
  };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

async function mount(initial: McpServerConfig[] = [], statuses: McpServerRuntimeSnapshot[] = [], pathExists?: (p: string) => boolean) {
  const backing = io({ mcpServers: initial });
  const store = new McpSettingsStore(backing);
  await store.load();
  const notices: string[] = [];
  const mgr = manager(statuses);
  const safety = { revokeGrantsForServer: vi.fn(async () => undefined) };
  const root = new FakeElement();
  const section = new McpServersSection({
    store,
    manager: mgr as never,
    safetyStore: safety,
    vaultRoot: "C:\\vault",
    pathExists: pathExists ?? ((p) => p === "C:\\vault"),
    notify: (m) => notices.push(m),
  });
  section.mount(root as never);
  return { root, section, store, mgr, safety, notices };
}

describe("McpServersSection Phase 5 — preset + credential editor + test connection", () => {
  test("preset dropdown is present on add form and lists the M365 Graph preset", async () => {
    const ctx = await mount();
    ctx.root.byAria("Add MCP server").click();
    const presetSelect = ctx.root.byAria("Preset");
    expect(presetSelect).toBeDefined();
    const optionValues = presetSelect.children.map((c) => c.value);
    expect(optionValues).toContain("m365-graph-az-cli");
  });

  test("credential editor dropdown defaults to 'none' for fresh add", async () => {
    const ctx = await mount();
    ctx.root.byAria("Add MCP server").click();
    expect(ctx.root.byAria("Credential kind").value).toBe("none");
  });

  test("preset selection populates URL + credential command + kind", async () => {
    const ctx = await mount();
    ctx.root.byAria("Add MCP server").click();
    const preset = ctx.root.byAria("Preset");
    preset.value = "m365-graph-az-cli";
    const fn = (preset as unknown as Record<string, EventListener>)["__change"];
    expect(fn).toBeDefined();
    fn({ target: preset } as unknown as Event);
    expect(ctx.root.byAria("URL").value).toBe("https://mcp.svc.cloud.microsoft/enterprise");
    expect(ctx.root.byAria("Credential kind").value).toBe("command-based");
    expect(ctx.root.byAria("Credential command").value).toContain("az account get-access-token");
  });

  test("preset preflight hint surfaces when CLI not on PATH (non-blocking)", async () => {
    // pathExists returns false for 'az' → preflight hint should appear.
    const ctx = await mount([], [], (p) => p === "C:\\vault");
    ctx.root.byAria("Add MCP server").click();
    const preset = ctx.root.byAria("Preset");
    preset.value = "m365-graph-az-cli";
    const fn = (preset as unknown as Record<string, EventListener>)["__change"];
    fn({ target: preset } as unknown as Event);
    const hint = ctx.root.byAria("Preset preflight hint");
    expect(hint.textContent).toMatch(/not found on PATH/);
    expect(hint.textContent).toMatch(/winget install Microsoft\.AzureCLI/);
  });

  test("preset preflight hint is empty when CLI is on PATH", async () => {
    const ctx = await mount([], [], (p) => p === "az" || p === "C:\\vault");
    ctx.root.byAria("Add MCP server").click();
    const preset = ctx.root.byAria("Preset");
    preset.value = "m365-graph-az-cli";
    const fn = (preset as unknown as Record<string, EventListener>)["__change"];
    fn({ target: preset } as unknown as Event);
    const hint = ctx.root.byAria("Preset preflight hint");
    expect(hint.textContent).toBe("");
  });

  test("Test connection button on row invokes manager.testConnection and reports OK", async () => {
    const base = {
      id: normalizeServerId("m365"),
      name: "M365",
      enabled: true,
      transport: "http" as const,
      url: "https://example.com/mcp",
      credentials: {
        kind: "command-based" as const,
        command: "az account get-access-token --output json",
      },
    };
    const server: McpServerConfig = { ...base, trustEpoch: computeTrustEpoch(base) };
    const ctx = await mount([server]);
    const button = ctx.root.byAria("Test connection for M365");
    button.click();
    await flush();
    expect(ctx.mgr.testConnection).toHaveBeenCalledWith(server.id);
    expect(ctx.notices.some((n) => n.includes("connection OK"))).toBe(true);
  });

  test("Test connection failure surfaces error message", async () => {
    const base = {
      id: normalizeServerId("m365"),
      name: "M365",
      enabled: true,
      transport: "http" as const,
      url: "https://example.com/mcp",
      credentials: { kind: "command-based" as const, command: "az foo" },
    };
    const server: McpServerConfig = { ...base, trustEpoch: computeTrustEpoch(base) };
    const ctx = await mount([server]);
    (ctx.mgr.testConnection as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: false,
      error: "Server returned HTTP 401.",
    });
    ctx.root.byAria("Test connection for M365").click();
    await flush();
    expect(ctx.notices.some((n) => n.includes("Server returned HTTP 401"))).toBe(true);
  });

  test("credential row status renders for HTTP server with credentials", async () => {
    const base = {
      id: normalizeServerId("m365"),
      name: "M365",
      enabled: true,
      transport: "http" as const,
      url: "https://example.com/mcp",
      credentials: { kind: "static-bearer" as const, token: "Bearer x" },
    };
    const server: McpServerConfig = { ...base, trustEpoch: computeTrustEpoch(base) };
    const ctx = await mount([server], [
      {
        id: server.id,
        status: "connected",
        credential: { state: "ok", variant: "static-bearer" },
      },
    ]);
    const status = ctx.root.byAria("Credential status for M365");
    expect(status.textContent).toMatch(/ok/);
  });

  test("Test connection button is available for HTTP server without credentials (FR-013)", async () => {
    const base = {
      id: normalizeServerId("plain"),
      name: "Plain",
      enabled: true,
      transport: "http" as const,
      url: "https://example.com/mcp",
    };
    const server: McpServerConfig = { ...base, trustEpoch: computeTrustEpoch(base) };
    const ctx = await mount([server]);
    expect(() => ctx.root.byAria("Test connection for Plain")).not.toThrow();
    expect(() => ctx.root.byAria("Credential status for Plain")).toThrow();
  });

  test("stdio server has no Test connection button", async () => {
    const base = {
      id: normalizeServerId("std"),
      name: "Std",
      enabled: true,
      transport: "stdio" as const,
      command: "node",
      args: [],
    };
    const server: McpServerConfig = { ...base, trustEpoch: computeTrustEpoch(base) };
    const ctx = await mount([server]);
    expect(() => ctx.root.byAria("Test connection for Std")).toThrow();
  });

  test("FR-012: oauth-pkce credentials survive an edit+save round-trip unchanged", async () => {
    const base = {
      id: normalizeServerId("oauth"),
      name: "OAuth",
      enabled: true,
      transport: "http" as const,
      url: "https://example.com/oauth",
      credentials: {
        kind: "oauth-pkce" as const,
        clientId: "abc",
        authorizationEndpoint: "https://example.com/authorize",
        tokenEndpoint: "https://example.com/token",
        scopes: ["openid"],
      },
    };
    const server: McpServerConfig = { ...base, trustEpoch: computeTrustEpoch(base) };
    const ctx = await mount([server]);
    ctx.root.byAria("Edit OAuth").click();
    ctx.root.byAria("Save MCP server").click();
    await flush();
    const saved = ctx.store.snapshot().find((s) => s.id === server.id);
    expect(saved?.transport === "http" && saved.credentials).toEqual(server.credentials);
  });

  test("new HTTP server with credentials fires onCredentialConfigChanged on save", async () => {
    const ctx = await mount();
    ctx.root.byAria("Add MCP server").click();
    ctx.root.byAria("Server ID").value = "newone";
    ctx.root.byAria("Transport").value = "http";
    ctx.root.byAria("URL").value = "https://example.com/mcp";
    ctx.root.byAria("Credential kind").value = "static-bearer";
    ctx.root.byAria("Authorization").value = "Bearer abc";
    ctx.root.byAria("Save MCP server").click();
    await flush();
    await flush();
    await flush();
    expect(ctx.store.snapshot().map((s) => s.id)).toContain(normalizeServerId("newone"));
    const saved = ctx.store.snapshot().find((s) => s.id === normalizeServerId("newone"));
    expect(saved?.transport === "http" && saved.credentials).toEqual({ kind: "static-bearer", token: "Bearer abc" });
    expect(ctx.mgr.onCredentialConfigChanged).toHaveBeenCalledWith(normalizeServerId("newone"));
  });

  test("preset preflight prefers executableExists over pathExists", async () => {
    const calls: string[] = [];
    const backing = io({ mcpServers: [] });
    const store = new McpSettingsStore(backing);
    await store.load();
    const mgr = manager();
    const safety = { revokeGrantsForServer: vi.fn(async () => undefined) };
    const root = new FakeElement();
    const section = new McpServersSection({
      store,
      manager: mgr as never,
      safetyStore: safety,
      vaultRoot: "C:\\vault",
      pathExists: () => true, // would mask the issue if used
      executableExists: (cmd) => { calls.push(cmd); return true; },
      notify: () => {},
    });
    section.mount(root as never);
    root.byAria("Add MCP server").click();
    const preset = root.byAria("Preset");
    preset.value = "m365-graph-az-cli";
    const fn = (preset as unknown as Record<string, EventListener>)["__change"];
    fn({ target: preset } as unknown as Event);
    expect(calls).toContain("az");
  });

  test("SM-2: static-bearer edit form populates token from canonical credentials.token (not legacy authorization)", async () => {
    // After Phase 1 canonicalization, the token lives at
    // `credentials.token`. The edit form previously read
    // `existing.authorization` only — re-opening the form showed an empty
    // token and re-saving silently dropped it.
    const base = {
      id: normalizeServerId("canon"),
      name: "Canonical",
      enabled: true,
      transport: "http" as const,
      url: "https://example.com/mcp",
      credentials: { kind: "static-bearer" as const, token: "Bearer canonical-token-xyz" },
    };
    const server: McpServerConfig = { ...base, trustEpoch: computeTrustEpoch(base) };
    const ctx = await mount([server]);
    ctx.root.byAria("Edit Canonical").click();
    // After save, the token must round-trip unchanged.
    ctx.root.byAria("Save MCP server").click();
    await flush();
    const saved = ctx.store.snapshot().find((s) => s.id === server.id);
    expect(saved?.transport === "http" && saved.credentials).toEqual({
      kind: "static-bearer",
      token: "Bearer canonical-token-xyz",
    });
  });

  test("SM-3: Test connection result is rendered inline on the row", async () => {
    const base = {
      id: normalizeServerId("m365"),
      name: "M365",
      enabled: true,
      transport: "http" as const,
      url: "https://example.com/mcp",
      credentials: { kind: "command-based" as const, command: "az foo" },
    };
    const server: McpServerConfig = { ...base, trustEpoch: computeTrustEpoch(base) };
    const ctx = await mount([server], [
      { id: server.id, status: "connected", credential: { state: "ok", variant: "command-based" } },
    ]);
    ctx.root.byAria("Test connection for M365").click();
    await flush();
    await flush();
    // After Test connection, the credential row should now include the
    // last-test result string.
    const status = ctx.root.byAria("Credential status for M365");
    expect(status.textContent).toMatch(/Last test: OK/);
  });

  test("SM-3: nextRefreshAt is rendered inline as relative-time hint", async () => {
    const now = Date.now();
    const base = {
      id: normalizeServerId("m365"),
      name: "M365",
      enabled: true,
      transport: "http" as const,
      url: "https://example.com/mcp",
      credentials: { kind: "command-based" as const, command: "az foo" },
    };
    const server: McpServerConfig = { ...base, trustEpoch: computeTrustEpoch(base) };
    const ctx = await mount([server], [
      {
        id: server.id,
        status: "connected",
        credential: {
          state: "ok",
          variant: "command-based",
          expiresAt: now + 60 * 60_000,
          nextRefreshAt: now + 15 * 60_000,
        },
      },
    ]);
    const status = ctx.root.byAria("Credential status for M365");
    expect(status.textContent).toMatch(/Next refresh in \d+ min/);
  });
});
