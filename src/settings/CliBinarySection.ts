import { Notice } from "obsidian";
import type { Plugin } from "obsidian";
import { redactSensitive } from "../mcp/redactSensitive";
import {
  FetcherError,
  detectPlatformTuple,
  getRequiredBinaryPath,
  isInstalled,
  type PlatformProbe,
} from "../sdk/BinaryFetcher";

/**
 * Section in the plugin Settings tab that surfaces CLI-binary install
 * state and a Retry affordance. Mirrors the structural patterns in
 * `src/settings/McpServersSection.ts:16-94`: injectable `notify` for
 * tests, a synchronous `mount(containerEl)` + `dispose()` lifecycle,
 * and a single small `render()` that owns the section DOM.
 *
 * The section is mountable in ANY binary state (installed / missing /
 * failed / unsupported), so it works even when Band B of `onload()`
 * short-circuited. Retry calls back into `plugin.ensureCliBinaryReady()`
 * which is idempotent — subsequent re-mounts re-read state via
 * `isInstalled()`.
 */
export interface CliBinaryHostPlugin extends Plugin {
  /** Last error from the most recent acquisition attempt (or null on success). */
  binaryFetchError?: FetcherError | null;
  /** Idempotent re-acquisition. Resolves to the binary path or null on failure. */
  ensureCliBinaryReady?: () => Promise<string | null>;
  /** Optional version probe — defaults to live process.platform/arch. */
  binaryFetchProbe?: PlatformProbe;
  /** Pinned binary version this build targets. */
  pinnedBinaryVersion?: string;
}

export interface CliBinarySectionOptions {
  plugin: CliBinaryHostPlugin;
  pinnedVersion: string;
  notify?: (message: string) => void;
  probe?: PlatformProbe;
}

type DomEl = HTMLElement & {
  empty?: () => void;
  setText?: (text: string) => void;
  createEl?: (tag: string, options?: { text?: string; cls?: string; attr?: Record<string, string> }) => DomEl;
  createDiv?: (options?: { text?: string; cls?: string; attr?: Record<string, string> }) => DomEl;
};

export class CliBinarySection {
  private root: DomEl | null = null;
  private retrying = false;

  constructor(private readonly options: CliBinarySectionOptions) {}

  mount(containerEl: HTMLElement): void {
    this.dispose();
    this.root = child(containerEl as DomEl, "div", { cls: "copilot-agent-cli-binary" });
    this.root.setAttribute("role", "region");
    this.root.setAttribute("aria-label", "Copilot CLI binary status");
    this.render();
  }

  dispose(): void {
    if (this.root) empty(this.root);
    this.root = null;
  }

  private render(): void {
    if (!this.root) return;
    const root = this.root;
    empty(root);
    child(root, "h3", { text: "Copilot CLI binary" });

    const probe = this.options.probe;
    const pinned = this.options.pinnedVersion;

    let unsupported: FetcherError | null = null;
    let installed = false;
    let binaryPath: string | null = null;
    try {
      binaryPath = getRequiredBinaryPath(this.options.plugin, probe);
      installed = isInstalled(this.options.plugin, pinned, probe);
    } catch (err) {
      if (err instanceof FetcherError && err.kind === "unsupported-platform") {
        unsupported = err;
      } else if (err instanceof FetcherError) {
        // filesystem / other — surface as last error
        this.options.plugin.binaryFetchError = err;
      }
    }

    const lastError = this.options.plugin.binaryFetchError ?? null;

    child(root, "p", {
      cls: "setting-item-description",
      text:
        "The plugin embeds an Obsidian-managed copy of the Copilot CLI binary. " +
        "On first launch (and after upgrades) it is downloaded automatically. " +
        `Pinned version: ${pinned}.`,
    });

    const status = child(root, "p", {
      attr: { role: "status", "aria-label": "CLI binary status" },
    });

    if (unsupported) {
      setText(status, `Unsupported platform: ${unsupported.message}`);
      const retry = child(root, "button", {
        text: "Retry",
        attr: { "aria-label": "Retry CLI binary download", disabled: "true" },
      }) as HTMLButtonElement;
      retry.disabled = true;
      child(root, "p", {
        cls: "setting-item-description",
        text: "Retry is unavailable on unsupported platforms. Please file an issue with your platform details.",
      });
      return;
    }

    if (installed && binaryPath) {
      setText(status, `Binary installed (version ${pinned}) at ${binaryPath}`);
    } else if (lastError) {
      const reason = redactSensitive(lastError.message);
      child(root, "pre", {
        cls: "copilot-agent-cli-binary-error",
        attr: { role: "status", "aria-label": "CLI binary error" },
        text: `Last download failed (${lastError.kind}):\n${reason}`,
      });
      setText(status, "Binary missing — click Retry to download.");
    } else {
      setText(status, "Binary missing — click Retry to download.");
    }

    const retry = child(root, "button", {
      text: this.retrying ? "Retrying…" : "Retry",
      attr: { "aria-label": "Retry CLI binary download" },
    }) as HTMLButtonElement;
    if (this.retrying) retry.disabled = true;
    on(retry, "click", () => void this.handleRetry());

    if (!installed) {
      child(root, "p", {
        cls: "setting-item-description",
        text:
          "After a successful Retry, reload Obsidian (command palette → 'Reload app without saving') " +
          "to finish wiring up chat and MCP runtimes.",
      });
    }
  }

  private async handleRetry(): Promise<void> {
    if (this.retrying) return;
    const fn = this.options.plugin.ensureCliBinaryReady;
    if (!fn) {
      this.notify("Plugin does not expose ensureCliBinaryReady; please reload Obsidian.");
      return;
    }
    this.retrying = true;
    this.render();
    try {
      const result = await fn.call(this.options.plugin);
      if (result) {
        this.notify("Copilot CLI binary installed. Reload Obsidian to finish initialization.");
      } else {
        const err = this.options.plugin.binaryFetchError;
        this.notify(`Copilot CLI binary download failed: ${err ? redactSensitive(err.message) : "unknown error"}`);
      }
    } catch (err) {
      this.notify(`Copilot CLI binary retry threw: ${redactSensitive(err instanceof Error ? err.message : String(err))}`);
    } finally {
      this.retrying = false;
      this.render();
    }
  }

  private notify(message: string): void {
    if (this.options.notify) this.options.notify(message);
    else new Notice(message, 8000);
  }
}

/**
 * Pure helper: status-line copy for a given installation state. Extracted
 * so tests can assert UI strings without DOM.
 */
export function describeBinaryStatus(input: {
  installed: boolean;
  pinnedVersion: string;
  binaryPath?: string | null;
  lastError?: FetcherError | null;
  unsupported?: FetcherError | null;
}): string {
  if (input.unsupported) return `Unsupported platform: ${input.unsupported.message}`;
  if (input.installed && input.binaryPath) {
    return `Binary installed (version ${input.pinnedVersion}) at ${input.binaryPath}`;
  }
  if (input.lastError) {
    return `Binary missing — last failure (${input.lastError.kind}): ${input.lastError.message}`;
  }
  return "Binary missing — click Retry to download.";
}

/** Re-export for callers that want to inspect detected tuple. */
export { detectPlatformTuple };

function child(
  parent: DomEl,
  tag: string,
  options: { text?: string; cls?: string; attr?: Record<string, string> } = {},
): DomEl {
  const el = parent.createEl ? parent.createEl(tag, options) : (document.createElement(tag) as DomEl);
  if (!parent.createEl) {
    if (options.cls) el.className = options.cls;
    if (options.text !== undefined) el.textContent = options.text;
    for (const [k, v] of Object.entries(options.attr ?? {})) el.setAttribute(k, v);
    parent.appendChild(el);
  }
  return el;
}

function empty(el: DomEl): void {
  if (el.empty) el.empty();
  else el.replaceChildren();
}

function setText(el: DomEl, text: string): void {
  if (el.setText) el.setText(text);
  else el.textContent = text;
}

function on(el: HTMLElement, name: string, fn: EventListener): void {
  el.addEventListener(name, fn);
}
