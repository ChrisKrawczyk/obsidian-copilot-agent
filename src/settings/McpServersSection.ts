import { Notice } from "obsidian";
import type { McpManager } from "../mcp/McpManager";
import type { McpServerConfig, McpServerRuntimeSnapshot } from "../mcp/McpTypes";
import { redactSensitive } from "../mcp/redactSensitive";
import type { SafetySettingsStore } from "./SafetySettingsStore";
import type { McpSettingsStore, McpSettingsMutationResult } from "./McpSettingsStore";
import {
  AUTHORIZATION_STORAGE_NOTICE,
  MCP_CALL_TIMEOUT_DEFAULT_SECONDS,
  PRIVATE_NETWORK_CONFIRMATION_COPY,
  displaySensitiveValue,
  validateMcpServerForm,
  type McpServerFormInput,
} from "./mcpServerFormLogic";

export interface McpServersSectionOptions {
  store: McpSettingsStore;
  manager: McpManager;
  safetyStore: Pick<SafetySettingsStore, "revokeGrantsForServer">;
  vaultRoot: string;
  pathExists?: (path: string) => boolean;
  notify?: (message: string) => void;
}

type DomEl = HTMLElement & {
  empty?: () => void;
  setText?: (text: string) => void;
  createEl?: (tag: string, options?: { text?: string; cls?: string; attr?: Record<string, string> }) => DomEl;
  createDiv?: (options?: { text?: string; cls?: string; attr?: Record<string, string> }) => DomEl;
};

const TRUST_REVOKE_NOTICE_PREFIX = "MCP grants were revoked for";

export class McpServersSection {
  private root: DomEl | null = null;
  private disposed = false;
  private unsubs: Array<() => void> = [];
  private domCleanups: Array<() => void> = [];
  private lastGrantNoticeEpochByServer = new Map<string, string>();
  private authStorageNoticeShown = false;

  constructor(private readonly options: McpServersSectionOptions) {}

  mount(containerEl: HTMLElement): void {
    this.disposeDom();
    this.disposed = false;
    this.root = child(containerEl as DomEl, "div", { cls: "copilot-agent-mcp-servers" });
    this.root.setAttribute("role", "region");
    this.root.setAttribute("aria-label", "MCP servers settings");
    this.unsubs.push(this.options.store.subscribe(() => this.render()));
    this.unsubs.push(this.options.manager.subscribe(() => this.render()));
    this.render();
  }

  dispose(): void {
    this.disposed = true;
    for (const unsub of this.unsubs.splice(0)) unsub();
    this.disposeDom();
  }

  private disposeDom(): void {
    for (const cleanup of this.domCleanups.splice(0)) cleanup();
    if (this.root) empty(this.root);
    this.root = null;
  }

  private render(): void {
    if (this.disposed || !this.root) return;
    const root = this.root;
    empty(root);
    child(root, "h3", { text: "MCP servers" });
    child(root, "p", {
      cls: "setting-item-description",
      text: "Configure MCP servers. Tools are not exposed to chat until the MCP tool bridge phase.",
    });
    const addButton = child(root, "button", { text: "Add server", attr: { "aria-label": "Add MCP server" } });
    on(addButton, "click", () => this.openForm());

    const list = child(root, "div", { attr: { role: "list", "aria-label": "Configured MCP servers" } });
    const servers = this.options.store.snapshot();
    const statuses = new Map(this.options.manager.statusSnapshot().map((snapshot) => [snapshot.id, snapshot]));
    if (servers.length === 0) {
      child(list, "p", { text: "No MCP servers configured." });
      return;
    }
    for (const server of servers) this.renderRow(list, server, statuses.get(server.id));
  }

  private renderRow(list: DomEl, server: McpServerConfig, runtime?: McpServerRuntimeSnapshot): void {
    const status = runtime?.status ?? (server.enabled ? "disconnected" : "disabled");
    const row = child(list, "div", {
      cls: "copilot-agent-mcp-server-row",
      attr: {
        role: "listitem",
        "aria-label": `MCP server ${server.name} (${server.id}) status ${status}`,
      },
    });
    child(row, "strong", { text: server.name });
    child(row, "span", { text: ` ${server.id} · ${server.transport} · ${server.enabled ? "enabled" : "disabled"} · ${status}` });
    child(row, "span", { text: ` · tools: ${runtime?.toolCount ?? 0}` });
    const lastError = runtime?.lastError ?? stringField(server, "lastError");
    if (lastError) {
      child(row, "div", {
        cls: "copilot-agent-mcp-last-error",
        attr: { role: "status", "aria-label": `Last error for ${server.name}` },
        text: `Last error: ${redactSensitive(lastError)}`,
      });
    }
    const denyWarnings = server.transport === "stdio"
      ? validateMcpServerForm(toInput(server), {
          vaultRoot: this.options.vaultRoot,
          pathExists: this.options.pathExists,
        }).denylistEnvWarnings
      : [];
    if (denyWarnings.length > 0) {
      child(row, "div", {
        cls: "copilot-agent-mcp-env-warning",
        attr: { role: "alert" },
        text: `Warning: explicit env keys override denylist: ${denyWarnings.map((w) => w.key).join(", ")}`,
      });
    }

    const edit = child(row, "button", { text: "Edit", attr: { "aria-label": `Edit ${server.name}` } });
    on(edit, "click", () => this.openForm(server));
    const toggle = child(row, "button", {
      text: server.enabled ? "Disable" : "Enable",
      attr: { "aria-label": `${server.enabled ? "Disable" : "Enable"} ${server.name}` },
    });
    on(toggle, "click", () => void this.setEnabled(server, !server.enabled));
    const reconnect = child(row, "button", { text: "Reconnect", attr: { "aria-label": `Reconnect ${server.name}` } });
    reconnect.toggleAttribute("disabled", !server.enabled);
    on(reconnect, "click", () => void this.options.manager.manualReconnect(server.id).catch((err: unknown) => this.noticeError(err)));
    const remove = child(row, "button", { text: "Remove", attr: { "aria-label": `Remove ${server.name}` } });
    on(remove, "click", () => void this.remove(server));
  }

  private openForm(existing?: McpServerConfig): void {
    if (!this.root) return;
    const modal = child(this.root, "div", {
      cls: "copilot-agent-mcp-modal",
      attr: { role: "dialog", "aria-label": existing ? "Edit MCP server" : "Add MCP server" },
    });
    child(modal, "h4", { text: existing ? "Edit MCP server" : "Add MCP server" });
    const id = input(modal, "Server id", existing?.id ?? "");
    const name = input(modal, "Display name", existing?.name ?? "");
    const transport = select(modal, "Transport", ["stdio", "http"], existing?.transport ?? "stdio");
    const command = input(modal, "Command", existing?.transport === "stdio" ? existing.command : "");
    const args = input(modal, "Arguments", existing?.transport === "stdio" ? existing.args.join(" ") : "");
    const url = input(modal, "URL", existing?.transport === "http" ? existing.url : "");
    const authorization = input(modal, "Authorization", existing?.transport === "http" ? displaySensitiveValue(existing.authorization, false) : "");
    authorization.type = "password";
    authorization.dataset.redacted = existing?.transport === "http" && existing.authorization ? "true" : "false";
    const reveal = checkbox(modal, "Reveal sensitive fields", false);
    on(reveal, "change", () => {
      if (existing?.transport === "http" && existing.authorization) {
        authorization.value = displaySensitiveValue(existing.authorization, reveal.checked);
        authorization.type = reveal.checked ? "text" : "password";
        authorization.dataset.redacted = reveal.checked ? "false" : "true";
      }
    });
    const cwd = input(modal, "Working directory", existing?.transport === "stdio" ? existing.cwd ?? this.options.vaultRoot : this.options.vaultRoot);
    const env = textarea(modal, "Environment", existing?.transport === "stdio" && existing.env ? envToText(existing.env) : "");
    const timeout = input(modal, "Tool call timeout seconds", String(numberField(existing, "callTimeoutSeconds") ?? MCP_CALL_TIMEOUT_DEFAULT_SECONDS));
    timeout.type = "number";
    const privateConfirm = checkbox(modal, PRIVATE_NETWORK_CONFIRMATION_COPY, false);
    const message = child(modal, "div", { attr: { role: "alert", "aria-label": "MCP server form message" } });
    const save = child(modal, "button", { text: "Save", attr: { "aria-label": "Save MCP server" } });
    const cancel = child(modal, "button", { text: "Cancel", attr: { "aria-label": "Cancel MCP server edit" } });
    on(cancel, "click", () => modal.remove());
    on(save, "click", () => {
      const authValue = authorization.dataset.redacted === "true" && existing?.transport === "http"
        ? existing.authorization
        : authorization.value;
      const form: McpServerFormInput = {
        id: id.value,
        name: name.value,
        enabled: existing?.enabled ?? true,
        transport: transport.value === "http" ? "http" : "stdio",
        command: command.value,
        args: args.value,
        url: url.value,
        authorization: authValue,
        cwd: cwd.value,
        env: parseEnv(env.value),
        callTimeoutSeconds: Number(timeout.value),
        privateNetworkConfirmed: privateConfirm.checked,
      };
      const result = validateMcpServerForm(form, {
        existingIds: this.options.store.snapshot().map((server) => server.id),
        originalId: existing?.id,
        vaultRoot: this.options.vaultRoot,
        pathExists: this.options.pathExists,
      });
      if ((!result.ok || !result.config) || (result.confirmationRequired && !privateConfirm.checked)) {
        setText(message, [...result.errors, ...result.warnings].join("\n"));
        return;
      }
      void this.saveForm(result.config, existing, result.denylistEnvWarnings.map((w) => w.key)).then(() => {
        modal.remove();
      }).catch((err: unknown) => setText(message, err instanceof Error ? err.message : String(err)));
    });
  }

  private async saveForm(config: McpServerConfig, existing: McpServerConfig | undefined, denyKeys: string[]): Promise<void> {
    const meta = existing
      ? await this.options.store.updateServer(existing.id, config)
      : await this.options.store.addServer(config);
    if (denyKeys.length > 0) {
      this.notify(`Explicit MCP env keys override the denylist: ${denyKeys.join(", ")}`);
    }
    if (!existing && config.transport === "http" && config.authorization && !this.authStorageNoticeShown) {
      this.authStorageNoticeShown = true;
      this.notify(AUTHORIZATION_STORAGE_NOTICE);
    }
    await this.handleTrustEpochChange(meta, config.name, config.trustEpoch);
    if (config.enabled) {
      void this.options.manager.enable(config.id).catch((err: unknown) => this.noticeError(err));
    }
  }

  private async setEnabled(server: McpServerConfig, enabled: boolean): Promise<void> {
    await this.options.store.setEnabled(server.id, enabled);
    if (enabled) await this.options.manager.enable(server.id);
    else await this.options.manager.disable(server.id);
  }

  private async remove(server: McpServerConfig): Promise<void> {
    if (!confirmRemove(server.name)) return;
    await this.options.manager.remove(server.id);
    const meta = await this.options.store.removeServer(server.id);
    await this.options.safetyStore.revokeGrantsForServer(server.id);
    await this.handleTrustEpochChange(meta, server.name);
  }

  private async handleTrustEpochChange(meta: McpSettingsMutationResult, name: string, trustEpoch?: string): Promise<void> {
    if (!meta.trustEpochChanged) return;
    await this.options.safetyStore.revokeGrantsForServer(meta.serverId);
    if (trustEpoch) {
      const lastNotifiedEpoch = this.lastGrantNoticeEpochByServer.get(meta.serverId);
      if (lastNotifiedEpoch === trustEpoch) return;
      this.lastGrantNoticeEpochByServer.set(meta.serverId, trustEpoch);
    }
    this.notify(`${TRUST_REVOKE_NOTICE_PREFIX} ${name}.`);
  }

  private notify(message: string): void {
    if (this.options.notify) this.options.notify(message);
    else new Notice(message, 8000);
  }

  private noticeError(err: unknown): void {
    this.notify(`[Copilot Agent] MCP server operation failed: ${redactSensitive(err instanceof Error ? err.message : String(err))}`);
  }
}

function toInput(server: McpServerConfig): McpServerFormInput {
  return server.transport === "stdio"
    ? { ...server, id: server.id, env: server.env, cwd: server.cwd, transport: "stdio" }
    : { ...server, id: server.id, transport: "http" };
}

function child(parent: DomEl, tag: string, options: { text?: string; cls?: string; attr?: Record<string, string> } = {}): DomEl {
  const el = parent.createEl ? parent.createEl(tag, options) : document.createElement(tag) as DomEl;
  if (!parent.createEl) {
    if (options.cls) el.className = options.cls;
    if (options.text !== undefined) el.textContent = options.text;
    for (const [key, value] of Object.entries(options.attr ?? {})) el.setAttribute(key, value);
    parent.appendChild(el);
  }
  return el;
}

function input(parent: DomEl, labelText: string, value: string): HTMLInputElement {
  const label = child(parent, "label");
  setText(label, labelText);
  const el = child(label, "input") as HTMLInputElement;
  el.value = value;
  el.setAttribute("aria-label", labelText);
  return el;
}

function textarea(parent: DomEl, labelText: string, value: string): HTMLTextAreaElement {
  const label = child(parent, "label");
  setText(label, labelText);
  const el = child(label, "textarea") as HTMLTextAreaElement;
  el.value = value;
  el.setAttribute("aria-label", labelText);
  return el;
}

function select(parent: DomEl, labelText: string, options: string[], value: string): HTMLSelectElement {
  const label = child(parent, "label");
  setText(label, labelText);
  const el = child(label, "select") as HTMLSelectElement;
  for (const option of options) {
    const optionEl = child(el as unknown as DomEl, "option") as HTMLOptionElement;
    optionEl.value = option;
    setText(optionEl as unknown as DomEl, option);
  }
  el.value = value;
  el.setAttribute("aria-label", labelText);
  return el;
}

function checkbox(parent: DomEl, labelText: string, checked: boolean): HTMLInputElement {
  const el = input(parent, labelText, "") as HTMLInputElement;
  el.type = "checkbox";
  el.checked = checked;
  return el;
}

function on(el: HTMLElement, name: string, fn: EventListener): void {
  el.addEventListener(name, fn);
}

function empty(el: DomEl): void {
  if (el.empty) el.empty();
  else el.replaceChildren();
}

function setText(el: DomEl, text: string): void {
  if (el.setText) el.setText(text);
  else el.textContent = text;
}

function confirmRemove(name: string): boolean {
  const prompt = `Remove MCP server "${name}"?`;
  if (typeof window !== "undefined" && typeof window.confirm === "function") return window.confirm(prompt);
  return true;
}

function envToText(env: Record<string, string>): string {
  return Object.entries(env).map(([key, value]) => `${key}=${value}`).join("\n");
}

function parseEnv(raw: string): Record<string, string> | undefined {
  const entries = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => {
    const idx = line.indexOf("=");
    return idx < 0 ? [line, ""] : [line.slice(0, idx), line.slice(idx + 1)];
  });
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function stringField(server: McpServerConfig, key: string): string | undefined {
  const value = (server as unknown as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
}

function numberField(server: McpServerConfig | undefined, key: string): number | undefined {
  const value = server ? (server as unknown as Record<string, unknown>)[key] : undefined;
  return typeof value === "number" ? value : undefined;
}
