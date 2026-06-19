import { describe, expect, test } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { FileSystemAdapter } from "obsidian";
import { CliBinarySection, describeBinaryStatus, type CliBinaryHostPlugin } from "./CliBinarySection";
import { FetcherError, MARKER_FILE, type PlatformProbe } from "../sdk/BinaryFetcher";

class FakeElement {
  children: FakeElement[] = [];
  parent: FakeElement | null = null;
  textContent = "";
  className = "";
  attributes = new Map<string, string>();
  listeners = new Map<string, Array<(event?: unknown) => void>>();
  disabled = false;
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
  appendChild(el: FakeElement): void {
    el.parent = this;
    this.children.push(el);
  }
  empty(): void {
    this.children = [];
    this.textContent = "";
  }
  setText(text: string): void {
    this.textContent = text;
  }
  setAttribute(key: string, value: string): void {
    this.attributes.set(key, value);
    if (key === "disabled") this.disabled = value !== "false";
  }
  getAttribute(key: string): string | undefined {
    return this.attributes.get(key);
  }
  addEventListener(name: string, fn: (event?: unknown) => void): void {
    this.listeners.set(name, [...(this.listeners.get(name) ?? []), fn]);
  }
  click(): void {
    for (const fn of this.listeners.get("click") ?? []) fn({ target: this });
  }
  queryAll(pred: (e: FakeElement) => boolean): FakeElement[] {
    return [this, ...this.children.flatMap((c) => c.queryAll(pred))].filter(pred);
  }
  byAria(label: string): FakeElement {
    const found = this.queryAll((e) => e.getAttribute("aria-label") === label)[0];
    if (!found) throw new Error(`Missing aria ${label}`);
    return found;
  }
}

function probeWin(): PlatformProbe {
  return { platform: "win32", arch: "x64", probeLinuxLibc: () => "glibc" };
}

function probeUnsupported(): PlatformProbe {
  return { platform: "freebsd" as NodeJS.Platform, arch: "x64", probeLinuxLibc: () => "glibc" };
}

function makePlugin(dir: string): CliBinaryHostPlugin {
  const adapter = new FileSystemAdapter();
  (adapter as unknown as { getBasePath: () => string }).getBasePath = () => dir;
  return {
    app: { vault: { adapter } },
    manifest: { dir: "." },
    binaryFetchError: null,
  } as unknown as CliBinaryHostPlugin;
}

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

describe("CliBinarySection", () => {
  test("installed state renders the installed status line", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-cli-section-"));
    fs.writeFileSync(path.join(dir, "copilot.exe"), "x");
    fs.writeFileSync(path.join(dir, MARKER_FILE), "1.0.0");
    const plugin = makePlugin(dir);
    const root = new FakeElement();
    const notices: string[] = [];
    new CliBinarySection({
      plugin,
      pinnedVersion: "1.0.0",
      notify: (m) => notices.push(m),
      probe: probeWin(),
    }).mount(root as never);
    const statusEl = root.queryAll((e) => e.getAttribute("aria-label") === "CLI binary status")[0];
    expect(statusEl.textContent).toContain("Binary installed (version 1.0.0)");
  });

  test("missing binary renders Retry button", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-cli-section-"));
    const plugin = makePlugin(dir);
    const root = new FakeElement();
    new CliBinarySection({
      plugin,
      pinnedVersion: "1.0.0",
      notify: () => undefined,
      probe: probeWin(),
    }).mount(root as never);
    const retry = root.byAria("Retry CLI binary download");
    expect(retry.disabled).toBe(false);
    const statusEl = root.queryAll((e) => e.getAttribute("aria-label") === "CLI binary status")[0];
    expect(statusEl.textContent).toContain("Binary missing");
  });

  test("Retry invokes plugin.ensureCliBinaryReady; success surfaces success notice", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-cli-section-"));
    const plugin = makePlugin(dir);
    let called = 0;
    plugin.ensureCliBinaryReady = async () => {
      called++;
      fs.writeFileSync(path.join(dir, "copilot.exe"), "x");
      fs.writeFileSync(path.join(dir, MARKER_FILE), "1.0.0");
      plugin.binaryFetchError = null;
      return path.join(dir, "copilot.exe");
    };
    const root = new FakeElement();
    const notices: string[] = [];
    new CliBinarySection({
      plugin,
      pinnedVersion: "1.0.0",
      notify: (m) => notices.push(m),
      probe: probeWin(),
    }).mount(root as never);
    root.byAria("Retry CLI binary download").click();
    await flush();
    expect(called).toBe(1);
    expect(notices.some((n) => n.includes("installed"))).toBe(true);
    const statusEl = root.queryAll((e) => e.getAttribute("aria-label") === "CLI binary status")[0];
    expect(statusEl.textContent).toContain("Binary installed");
  });

  test("Retry failure surfaces the redacted error in a notice", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-cli-section-"));
    const plugin = makePlugin(dir);
    plugin.ensureCliBinaryReady = async () => {
      plugin.binaryFetchError = new FetcherError("network", "registry unreachable token=abcd");
      return null;
    };
    const root = new FakeElement();
    const notices: string[] = [];
    new CliBinarySection({
      plugin,
      pinnedVersion: "1.0.0",
      notify: (m) => notices.push(m),
      probe: probeWin(),
    }).mount(root as never);
    root.byAria("Retry CLI binary download").click();
    await flush();
    expect(notices.some((n) => n.includes("failed") || n.includes("registry"))).toBe(true);
  });

  test("unsupported-platform disables Retry", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-cli-section-"));
    const plugin = makePlugin(dir);
    const root = new FakeElement();
    new CliBinarySection({
      plugin,
      pinnedVersion: "1.0.0",
      notify: () => undefined,
      probe: probeUnsupported(),
    }).mount(root as never);
    const retry = root.byAria("Retry CLI binary download");
    expect(retry.disabled).toBe(true);
    const statusEl = root.queryAll((e) => e.getAttribute("aria-label") === "CLI binary status")[0];
    expect(statusEl.textContent).toContain("Unsupported platform");
  });
});

describe("describeBinaryStatus (pure helper)", () => {
  test("installed", () => {
    expect(
      describeBinaryStatus({ installed: true, pinnedVersion: "1.2.3", binaryPath: "/p/copilot" }),
    ).toBe("Binary installed (version 1.2.3) at /p/copilot");
  });
  test("unsupported beats installed flag", () => {
    expect(
      describeBinaryStatus({
        installed: true,
        pinnedVersion: "1.0",
        binaryPath: "/p",
        unsupported: new FetcherError("unsupported-platform", "freebsd"),
      }),
    ).toContain("Unsupported platform");
  });
  test("lastError takes precedence over default missing", () => {
    expect(
      describeBinaryStatus({
        installed: false,
        pinnedVersion: "1.0",
        lastError: new FetcherError("network", "down"),
      }),
    ).toContain("(network)");
  });
  test("default missing", () => {
    expect(describeBinaryStatus({ installed: false, pinnedVersion: "1.0" })).toBe(
      "Binary missing — click Retry to download.",
    );
  });
});
