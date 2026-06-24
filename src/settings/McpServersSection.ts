import { Notice } from "obsidian";
import type { McpManager } from "../mcp/McpManager";
import type { McpServerConfig, McpServerRuntimeSnapshot } from "../mcp/McpTypes";
import { redactSensitive } from "../mcp/redactSensitive";
import type { SafetySettingsStore } from "./SafetySettingsStore";
import type { McpSettingsStore, McpSettingsMutationResult } from "./McpSettingsStore";
import type { PresetPacksStore } from "./PresetPacksStore";
import type { PackFileReader, PackFileWriter } from "./presets/packFileIO";
import { applyConfirmedImport, runImportFromReaderResult } from "./presets/packImporter";
import {
  formatImportConfirmText,
  formatReimportDiffText,
  renderModelForPackList,
} from "./packSettingsLogic";
import {
  AUTHORIZATION_STORAGE_NOTICE,
  MCP_CALL_TIMEOUT_DEFAULT_SECONDS,
  PRIVATE_NETWORK_CONFIRMATION_COPY,
  buildCredentialStatusText,
  displaySensitiveValue,
  validateMcpServerForm,
  type McpCredentialKindUiSelection,
  type McpServerFormInput,
} from "./mcpServerFormLogic";
import { getPresetById } from "./presets/McpServerPresets";
import { BUILT_IN_PACK, BUILTIN_PACK_ID } from "./presets/BuiltInPacks";
import { buildEffectiveRegistry } from "./presets/effectiveRegistry";
import {
  applyEffectivePresetToForm,
  buildPresetDropdownModel,
  type PresetDropdownModel,
} from "./presetDropdownLogic";
import type { EffectivePreset } from "./presets/effectiveRegistry";
import {
  buildExportFlowModel,
  runExport,
  suggestedFilename,
  toggleSelection,
} from "./packExportFlow";

export interface McpServersSectionOptions {
  store: McpSettingsStore;
  manager: McpManager;
  safetyStore: Pick<SafetySettingsStore, "revokeGrantsForServer">;
  vaultRoot: string;
  pathExists?: (path: string) => boolean;
  /**
   * Phase 5 (FR-018): production wiring supplies a PATH-based executable
   * probe (handles Windows PATHEXT). When omitted, falls back to
   * `pathExists` for test harness compatibility.
   */
  executableExists?: (command: string) => boolean;
  notify?: (message: string) => void;
  /**
   * Phase 2 (preset packs): store reference. Phase 3 consumes it for the
   * "Imported preset packs" subsection (list, import, remove).
   */
  presetPacksStore?: PresetPacksStore;
  /**
   * Phase 3 (preset packs): file picker for "Import pack from file…".
   * Injected so tests can drive the import flow without a real DOM picker.
   * Production wiring uses `createDesktopPackFileReader()`.
   */
  packFileReader?: PackFileReader;
  /**
   * Phase 3 (preset packs): destructive-confirm prompt. Defaults to
   * `window.confirm`, mirroring the existing Remove-server pattern.
   */
  confirmPackAction?: (title: string, body: string) => boolean | Promise<boolean>;
  /**
   * Phase 4 (preset packs): writer for "Export servers as pack…".
   * Injected so tests can drive export without a real save dialog or fs.
   * Production wiring uses `createDesktopPackFileWriter(app)`.
   */
  packFileWriter?: PackFileWriter;
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
  private formOpen = false;
  private renderQueuedWhileFormOpen = false;
  /**
   * SM-3 / Phase 5 minimum: per-server last Test-connection result, so the
   * row can render the outcome inline alongside the credential snapshot
   * (previously only emitted as a transient `Notice`).
   */
  private lastTestResultByServer = new Map<string, { ok: boolean; at: number; error?: string }>();

  constructor(private readonly options: McpServersSectionOptions) {}

  mount(containerEl: HTMLElement): void {
    this.disposeDom();
    this.disposed = false;
    this.root = child(containerEl as DomEl, "div", { cls: "copilot-agent-mcp-servers" });
    this.root.setAttribute("role", "region");
    this.root.setAttribute("aria-label", "MCP servers settings");
    this.unsubs.push(this.options.store.subscribe(() => this.render()));
    this.unsubs.push(this.options.manager.subscribe(() => this.render()));
    if (this.options.presetPacksStore) {
      this.unsubs.push(
        this.options.presetPacksStore.subscribe(() => this.render()),
      );
    }
    this.render();
  }

  dispose(): void {
    this.disposed = true;
    this.formOpen = false;
    this.renderQueuedWhileFormOpen = false;
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
    if (this.formOpen) {
      this.renderQueuedWhileFormOpen = true;
      return;
    }
    const root = this.root;
    empty(root);
    if (this.options.presetPacksStore) {
      this.renderPacksSubsection(root);
    }
    child(root, "h3", { text: "MCP servers" });
    child(root, "p", {
      cls: "setting-item-description",
      text: "Connected MCP servers expose their tools to chat. Each tool call is gated by an approval prompt unless you grant it (scoped per server, tool, and trust epoch).",
    });
    const addButton = child(root, "button", { text: "Add server", attr: { "aria-label": "Add MCP server" } });
    on(addButton, "click", () => this.openForm());
    if (this.options.packFileWriter) {
      const exportButton = child(root, "button", {
        text: "Export servers as pack…",
        attr: { "aria-label": "Export servers as preset pack" },
      });
      on(exportButton, "click", () => this.openExportDialog(root));
    }

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
    const statusMeta = statusDisplay(status);
    child(row, "span", { text: ` ${server.id} · ${server.transport} · ${server.enabled ? "enabled" : "disabled"} · ${statusMeta.icon} ${statusMeta.label}` });
    child(row, "span", { text: ` · tools: ${runtime?.toolCount ?? 0}` });
    const lastError = runtime?.lastError ?? stringField(server, "lastError");
    if (lastError) {
      child(row, "pre", {
        cls: "copilot-agent-mcp-last-error",
        attr: { role: "status", "aria-label": `Last error for ${server.name}` },
        text: `Last error:\n${redactSensitive(lastError)}`,
      });
    }
    if (runtime?.stderrTail) {
      child(row, "pre", {
        cls: "copilot-agent-mcp-stderr",
        attr: { role: "status", "aria-label": `Server log for ${server.name}` },
        text: `Server log:\n${redactSensitive(runtime.stderrTail)}`,
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

    const credSnapshot = runtime?.credential;
    if (server.transport === "http" && server.credentials) {
      const variant = server.credentials.kind;
      const statusText = buildCredentialStatusText({
        state: credSnapshot?.state,
        variant,
        expiresAt: credSnapshot?.expiresAt ?? undefined,
        nextRefreshAt: credSnapshot?.nextRefreshAt ?? undefined,
        remediation: credSnapshot?.remediation ?? undefined,
        copyable: credSnapshot?.copyable ?? undefined,
        lastTestResult: this.lastTestResultByServer.get(server.id),
      });
      child(row, "div", {
        cls: "copilot-agent-mcp-credential-status",
        attr: {
          role: "status",
          "aria-label": `Credential status for ${server.name}`,
        },
        text: statusText,
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

    if (server.transport === "http") {
      const test = child(row, "button", {
        text: "Test connection",
        attr: { "aria-label": `Test connection for ${server.name}` },
      });
      on(test, "click", () => void this.testConnection(server));
    }
  }

  private async testConnection(server: McpServerConfig): Promise<void> {
    try {
      const result = await this.options.manager.testConnection(server.id);
      // SM-3 / Phase 5 minimum: persist the outcome so the row renders it
      // inline next to the credential snapshot, not just as a transient
      // `Notice`.
      this.lastTestResultByServer.set(server.id, {
        ok: result.ok,
        at: Date.now(),
        ...(result.ok ? {} : { error: result.error }),
      });
      if (result.ok) this.notify(`MCP server "${server.name}": connection OK.`);
      else this.notify(`MCP server "${server.name}": ${result.error}`);
      this.render();
    } catch (err) {
      this.lastTestResultByServer.set(server.id, {
        ok: false,
        at: Date.now(),
        error: err instanceof Error ? err.message : String(err),
      });
      this.noticeError(err);
      this.render();
    }
  }

  private openForm(existing?: McpServerConfig): void {
    if (!this.root) return;
    this.formOpen = true;
    const closeForm = (modal: HTMLElement): void => {
      modal.remove();
      this.formOpen = false;
      if (this.renderQueuedWhileFormOpen) {
        this.renderQueuedWhileFormOpen = false;
        this.render();
      }
    };
    const modal = child(this.root, "div", {
      cls: "copilot-agent-mcp-modal",
      attr: { role: "dialog", "aria-label": existing ? "Edit MCP server" : "Add MCP server" },
    });
    child(modal, "h4", { text: existing ? "Edit MCP server" : "Add MCP server" });
    const id = input(modal, "Server ID", existing?.id ?? "", {
      placeholder: "fs-vault",
      hint: "Stable internal slug used for approvals and the tool-name prefix. Lowercase letters, digits, '-' or '_'. Hard to change later — pick something you'll keep.",
    });
    const name = input(modal, "Display name", existing?.name ?? "", {
      placeholder: "Filesystem (vault)",
      hint: "Human-readable label shown in settings and approval prompts.",
    });
    const transport = select(modal, "Transport", ["stdio", "http"], existing?.transport ?? "stdio", {
      hint: "stdio: spawn a local process. http: connect to a remote Streamable HTTP MCP server.",
    });
    const command = input(modal, "Command", existing?.transport === "stdio" ? existing.command : "", {
      placeholder: "cmd  (Windows)  or  npx  (macOS/Linux)",
      hint: "stdio only. On Windows, use 'cmd' with '/c' in Arguments to run npx-style commands.",
    });
    const args = input(modal, "Arguments", existing?.transport === "stdio" ? formatArgs(existing.args) : "", {
      placeholder: "/c npx -y @modelcontextprotocol/server-filesystem C:\\path\\to\\folder",
      hint: "Space-separated. Wrap arguments containing spaces or double-quotes in double-quotes.",
    });
    const url = input(modal, "URL", existing?.transport === "http" ? existing.url : "", {
      placeholder: "https://mcp.example.com/",
      hint: "http only. Must be https unless the host is a loopback address.",
    });
    // SM-2 / FR-001: after Phase 1 canonicalization, the static-bearer
    // token lives at `existing.credentials.token`, not `existing.authorization`.
    // Prefer the canonical location; fall back to the legacy field so
    // unmigrated rows still populate the form.
    const existingTokenSource = (() => {
      if (existing?.transport !== "http") return undefined;
      if (existing.credentials?.kind === "static-bearer") return existing.credentials.token;
      return existing.authorization;
    })();
    const authorization = input(modal, "Authorization", existingTokenSource ? displaySensitiveValue(existingTokenSource, false) : "", {
      placeholder: "Bearer <token>",
      hint: "Optional. Sent as the Authorization header. Stored in plaintext in data.json — Obsidian has no secure secret store.",
    });
    authorization.type = "password";
    authorization.dataset.redacted = existingTokenSource ? "true" : "false";
    const reveal = checkbox(modal, "Reveal sensitive fields", false);
    on(reveal, "change", () => {
      if (existingTokenSource) {
        authorization.value = displaySensitiveValue(existingTokenSource, reveal.checked);
        authorization.type = reveal.checked ? "text" : "password";
        authorization.dataset.redacted = reveal.checked ? "false" : "true";
      }
    });

    // Phase 5: credential editor block (HTTP only). The dropdown drives
    // visibility of the per-kind sub-fields. `static-bearer` reuses the
    // existing Authorization input (declared above) to keep tokens in one
    // place; `command-based` exposes command + token/expiry paths + refresh
    // buffer. `none` hides both blocks. `oauth-pkce` is configured via raw
    // data.json only (reserved for a future release).
    const existingHttpCreds = existing?.transport === "http" ? existing.credentials : undefined;
    const initialKind: McpCredentialKindUiSelection = existingHttpCreds?.kind === "command-based"
      ? "command-based"
      : existingHttpCreds?.kind === "static-bearer"
      ? "static-bearer"
      : existingHttpCreds?.kind === "oauth-pkce"
      ? "none"
      : existingTokenSource
      ? "static-bearer"
      : "none";
    const credentialKind = select(
      modal,
      "Credential kind",
      ["none", "static-bearer", "command-based"],
      initialKind,
      { hint: "How the plugin obtains an Authorization header for this server." },
    );
    const credentialBearerWarning = child(modal, "div", {
      cls: "copilot-agent-mcp-credential-warning",
      attr: { role: "alert", "aria-label": "Credential storage warning" },
    });
    const credentialCommand = input(
      modal,
      "Credential command",
      existingHttpCreds?.kind === "command-based" ? existingHttpCreds.command : "",
      {
        placeholder: "az account get-access-token --scope ... --output json",
        hint: "Command emitting JSON containing the token. The command runs locally and its stdout is parsed.",
      },
    );
    const credentialTokenPath = input(
      modal,
      "Token JSON path",
      existingHttpCreds?.kind === "command-based" ? existingHttpCreds.tokenPath ?? "" : "",
      { placeholder: "accessToken", hint: "Defaults to `accessToken` when blank." },
    );
    const credentialExpiryPath = input(
      modal,
      "Expiry JSON path",
      existingHttpCreds?.kind === "command-based" ? existingHttpCreds.expiryPath ?? "" : "",
      { placeholder: "expiresOn", hint: "Defaults to `expiresOn` when blank." },
    );
    const credentialRefreshBuffer = input(
      modal,
      "Refresh buffer (seconds)",
      existingHttpCreds?.kind === "command-based"
        ? String(existingHttpCreds.refreshBufferSeconds ?? "")
        : "",
      {
        placeholder: "300",
        hint: "Seconds before expiry to refresh proactively. Range 0-86400. Defaults to 300.",
      },
    );
    credentialRefreshBuffer.type = "number";
    const oauthNote = child(modal, "div", {
      cls: "copilot-agent-mcp-oauth-note",
      attr: { role: "status" },
      text: "oauth-pkce: configured via raw data.json; reserved for a future release.",
    });

    const updateCredentialVisibility = (): void => {
      const kind = credentialKind.value as McpCredentialKindUiSelection;
      const showStatic = kind === "static-bearer";
      const showCommand = kind === "command-based";
      const showOauthNote = existingHttpCreds?.kind === "oauth-pkce";
      setHidden(authorization.parentElement as DomEl | null, !showStatic);
      setHidden(reveal.parentElement as DomEl | null, !showStatic);
      setText(
        credentialBearerWarning,
        showStatic
          ? "Static bearer tokens are stored in plaintext in data.json."
          : "",
      );
      setHidden(credentialCommand.parentElement as DomEl | null, !showCommand);
      setHidden(credentialTokenPath.parentElement as DomEl | null, !showCommand);
      setHidden(credentialExpiryPath.parentElement as DomEl | null, !showCommand);
      setHidden(credentialRefreshBuffer.parentElement as DomEl | null, !showCommand);
      setHidden(oauthNote, !showOauthNote);
    };
    on(credentialKind, "change", updateCredentialVisibility);
    updateCredentialVisibility();

    // Phase 4 (preset packs): per-form state captured by both the preset
    // change handler (writes) and the Save click handler (reads). Lives
    // in openForm's closure so each form invocation gets a fresh array —
    // never leaks across edit sessions.
    const formRequiredFields: string[] = [];
    let pendingCredentialArgs: string[] | undefined =
      existingHttpCreds?.kind === "command-based" && Array.isArray(existingHttpCreds.args)
        ? [...existingHttpCreds.args]
        : undefined;

    // Phase 5 + Phase 4 (preset packs): preset dropdown (add-only).
    // Populates fields when selected. Built-in presets continue to use
    // their existing build()+preflight-hint path; imported-pack presets
    // use the pure `applyEffectivePresetToForm` helper and render a
    // "required" hint for templatized secret fields.
    // FR-018 / SC-006: pack code paths invoke NO preflight; the existing
    // form-level hint for built-ins is unchanged.
    if (!existing) {
      const packsSnapshot = this.options.presetPacksStore?.snapshot() ?? [];
      const registry = buildEffectiveRegistry(BUILT_IN_PACK, packsSnapshot);
      const dropdownModel = buildPresetDropdownModel(registry);
      const effectiveById = new Map(registry.map((r) => [r.effectiveId, r]));
      const presetIds = [
        dropdownModel.emptyOption.value,
        ...dropdownModel.groups.flatMap((g) => g.options.map((o) => o.value)),
      ];
      const presetSelect = select(modal, "Preset", presetIds, "", {
        hint: "Optional. Pre-fills the form for a known MCP service.",
      });
      // Rewrite option text where supported (real DOM). For real-DOM
      // builds we also re-arrange options into <optgroup> elements so
      // imported packs visually cluster under their pack label. The
      // FakeElement test harness has no `.options` API, so this is
      // skipped there and tests assert on the dropdown model instead.
      const opts = (presetSelect as unknown as { options?: ArrayLike<HTMLOptionElement> }).options;
      if (opts && opts.length > 0) {
        const blank = opts[0];
        if (blank) blank.textContent = dropdownModel.emptyOption.text;
        for (let i = 0; i < opts.length; i++) {
          const opt = opts[i];
          const eff = effectiveById.get(opt.value);
          if (eff) opt.textContent = eff.displayLabel;
        }
        applyOptgroupsToSelect(presetSelect, dropdownModel, effectiveById);
      }
      const presetHint = child(modal, "div", {
        cls: "copilot-agent-mcp-preset-hint",
        attr: { role: "status", "aria-label": "Preset preflight hint" },
      });
      on(presetSelect, "change", () => {
        setText(presetHint, "");
        formRequiredFields.length = 0;
        pendingCredentialArgs = undefined;
        const eff = effectiveById.get(presetSelect.value);
        if (!eff) return;
        if (eff.sourcePackId === BUILTIN_PACK_ID) {
          // Built-in: preserve the exact pre-Phase-4 behavior (build()
          // + form-level preflight hint).
          const preset = getPresetById(eff.preset.id);
          if (!preset) return;
          const built = preset.build();
          if (!id.value) id.value = preset.id;
          name.value = built.server.name;
          transport.value = built.server.transport;
          if (built.server.transport === "http") {
            url.value = built.server.url;
          }
          if (built.credentials.kind === "command-based") {
            credentialKind.value = "command-based";
            credentialCommand.value = built.credentials.command;
            pendingCredentialArgs = Array.isArray(built.credentials.args)
              ? [...built.credentials.args]
              : undefined;
            credentialTokenPath.value = built.credentials.tokenPath ?? "";
            credentialExpiryPath.value = built.credentials.expiryPath ?? "";
            credentialRefreshBuffer.value = String(
              built.credentials.refreshBufferSeconds ?? "",
            );
            updateCredentialVisibility();
          }
          const preflight = built.preflight;
          if (preflight?.type === "findOnPath") {
            const check = this.options.executableExists ?? this.options.pathExists;
            if (check && !check(preflight.command)) {
              setText(
                presetHint,
                `Heads up: \`${preflight.command}\` was not found on PATH. ` +
                  (preflight.installHint ? `Install with: ${preflight.installHint}` : "") +
                  " You can still save; the server will fail until the CLI is available.",
              );
            }
          }
          return;
        }
        // Imported pack preset: pure pre-fill via applyEffectivePresetToForm.
        const baseForm: McpServerFormInput = {
          id: id.value,
          name: name.value,
          transport: transport.value === "http" ? "http" : "stdio",
        };
        const { form: applied, requiredSecretFields } = applyEffectivePresetToForm(eff, baseForm);
        if (!id.value && applied.id) id.value = applied.id;
        if (applied.name) name.value = applied.name;
        transport.value = applied.transport;
        if (applied.transport === "http" && typeof applied.url === "string") {
          url.value = applied.url;
        }
        if (applied.transport === "stdio") {
          if (typeof applied.command === "string") command.value = applied.command;
          if (Array.isArray(applied.args)) args.value = formatArgs(applied.args);
          // Phase 4: stdio env/cwd from the pack preset flow into the
          // visible form fields so the user can see (and edit) them
          // before saving. Templatized env values surface as empty
          // strings + `env.<KEY>` required entries.
          if (applied.env) env.value = envToText(applied.env);
          if (typeof applied.cwd === "string") cwd.value = applied.cwd;
        }
        if (applied.credentialKind) {
          credentialKind.value = applied.credentialKind;
          if (applied.credentialKind === "command-based") {
            credentialCommand.value = applied.credentialCommand ?? "";
            pendingCredentialArgs = Array.isArray(applied.credentialArgs)
              ? [...applied.credentialArgs]
              : undefined;
            credentialTokenPath.value = applied.credentialTokenPath ?? "";
            credentialExpiryPath.value = applied.credentialExpiryPath ?? "";
            credentialRefreshBuffer.value = String(
              applied.credentialRefreshBufferSeconds ?? "",
            );
          } else if (applied.credentialKind === "static-bearer") {
            authorization.value = applied.authorization ?? "";
          }
          updateCredentialVisibility();
        }
        formRequiredFields.splice(0, formRequiredFields.length, ...requiredSecretFields);
        if (requiredSecretFields.length > 0) {
          // Mark the visible templatized inputs so the user sees the
          // required-affordance immediately (and assistive tech picks it up).
          for (const f of requiredSecretFields) {
            if (f === "authorization") authorization.setAttribute("aria-required", "true");
          }
          setText(
            presetHint,
            "Pack-templatized: please supply a value before saving (" +
              requiredSecretFields.join(", ") +
              ").",
          );
        }
      });
    }
    const cwd = input(modal, "Working directory", existing?.transport === "stdio" ? existing.cwd ?? this.options.vaultRoot : this.options.vaultRoot, {
      hint: "stdio only. Defaults to the vault root.",
    });
    const env = textarea(modal, "Environment", existing?.transport === "stdio" && existing.env ? envToText(existing.env) : "", {
      placeholder: "KEY=value\nANOTHER_KEY=value",
      hint: "stdio only. One KEY=value per line. Explicit entries override the built-in denylist.",
    });
    const timeout = input(modal, "Tool call timeout seconds", String(callTimeoutSeconds(existing)), {
      hint: "Max time a single tool call may run before being cancelled.",
    });
    timeout.type = "number";
    const privateConfirm = checkbox(modal, PRIVATE_NETWORK_CONFIRMATION_COPY, false);
    const message = child(modal, "div", { attr: { role: "alert", "aria-label": "MCP server form message" } });
    const save = child(modal, "button", { text: "Save", attr: { "aria-label": "Save MCP server" } });
    const cancel = child(modal, "button", { text: "Cancel", attr: { "aria-label": "Cancel MCP server edit" } });
    on(cancel, "click", () => closeForm(modal));
    on(save, "click", () => {
      const authValue = authorization.dataset.redacted === "true" && existingTokenSource
        ? existingTokenSource
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
        credentialKind: credentialKind.value as McpCredentialKindUiSelection,
        credentialCommand: credentialCommand.value,
        credentialTokenPath: credentialTokenPath.value,
        credentialExpiryPath: credentialExpiryPath.value,
        credentialRefreshBufferSeconds: credentialRefreshBuffer.value === ""
          ? undefined
          : Number(credentialRefreshBuffer.value),
        credentialArgs: pendingCredentialArgs,
        requiredSecretFields: formRequiredFields.length > 0 ? [...formRequiredFields] : undefined,
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
      // Phase 5 (FR-012): oauth-pkce is reserved + read-only in the UI.
      // The kind dropdown maps it to "none", which would otherwise wipe
      // the credentials block on save. Restore the original oauth-pkce
      // block here so an existing server's reserved config round-trips.
      let finalConfig = result.config;
      if (
        existing?.transport === "http" &&
        existing.credentials?.kind === "oauth-pkce" &&
        finalConfig.transport === "http" &&
        !finalConfig.credentials
      ) {
        finalConfig = { ...finalConfig, credentials: existing.credentials };
      }
      void this.saveForm(finalConfig, existing, result.denylistEnvWarnings.map((w) => w.key)).then(() => {
        closeForm(modal);
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
    if (shouldShowAuthorizationNotice(existing, config) && !this.options.store.hasAuthorizationNoticeShown()) {
      this.notify(AUTHORIZATION_STORAGE_NOTICE);
      await this.options.store.markAuthorizationNoticeShown();
    }
    await this.handleTrustEpochChange(meta, config.name, config.trustEpoch);
    // Phase 4 (FR-011): credential-only edits MUST NOT revoke grants. The
    // trust-epoch helper above is the only path that calls
    // `revokeGrantsForServer`, and `computeTrustEpoch` excludes credentials,
    // so a credential edit reaches here without touching grants. Notify the
    // manager so the cached credential is invalidated on the next request.
    if (existing && credentialsChanged(existing, config)) {
      this.options.manager.onCredentialConfigChanged?.(config.id);
    } else if (!existing && config.transport === "http" && config.credentials) {
      // Phase 5: new HTTP servers with a credentials block also trigger an
      // idempotent invalidation so the manager primes its credential cache.
      this.options.manager.onCredentialConfigChanged?.(config.id);
    }
    if (config.enabled) {
      void this.options.manager.enable(config.id).catch((err: unknown) => this.noticeError(err));
    }
  }

  private async setEnabled(server: McpServerConfig, enabled: boolean): Promise<void> {
    await this.options.store.setEnabled(server.id, enabled);
    if (enabled) await this.options.manager.enable(server.id);
    else await this.options.manager.disable(server.id);
    // The SDK locks the tool list at session creation; mid-session toggles
    // don't refresh it. Prompt the user to start a new conversation so the
    // model sees the updated tool roster.
    this.notify(
      `MCP server "${server.name}" ${enabled ? "enabled" : "disabled"}. ` +
        "Start a new conversation in the chat for the tool change to take effect.",
    );
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

  private openExportDialog(root: DomEl): void {
    const writer = this.options.packFileWriter;
    if (!writer) return;
    const servers = this.options.store.snapshot();
    if (servers.length === 0) {
      this.notify("No MCP servers configured to export.");
      return;
    }
    let model = buildExportFlowModel(servers);
    const dialog = child(root, "div", {
      cls: "copilot-agent-export-dialog",
      attr: { role: "dialog", "aria-label": "Export servers as preset pack" },
    });
    child(dialog, "h4", { text: "Export servers as preset pack" });
    child(dialog, "p", {
      cls: "setting-item-description",
      text: "Selected servers are exported with secrets replaced by __NEEDS_VALUE__ placeholders.",
    });
    const idEl = input(dialog, "Pack id", model.defaultPackMeta.id);
    const labelEl = input(dialog, "Pack label", model.defaultPackMeta.label);
    const versionEl = input(dialog, "Version", model.defaultPackMeta.version);
    const listEl = child(dialog, "div", {
      cls: "copilot-agent-export-list",
      attr: { role: "list", "aria-label": "Servers to export" },
    });
    const renderList = (): void => {
      empty(listEl);
      for (const row of model.rows) {
        const rowEl = child(listEl, "div", { cls: "copilot-agent-export-row" });
        const cb = checkbox(rowEl, `${row.name} (${row.transport})`, row.selected);
        on(cb, "change", () => {
          model = { ...model, rows: toggleSelection(model.rows, row.id) };
        });
      }
    };
    renderList();
    const message = child(dialog, "div", {
      cls: "copilot-agent-export-message",
      attr: { role: "status", "aria-live": "polite" },
    });
    const actions = child(dialog, "div", { cls: "copilot-agent-export-actions" });
    const cancelBtn = child(actions, "button", { text: "Cancel" });
    const exportBtn = child(actions, "button", {
      text: "Export",
      attr: { "aria-label": "Export selected servers" },
    });
    on(cancelBtn, "click", () => {
      dialog.remove();
    });
    on(exportBtn, "click", () => {
      const meta = {
        id: idEl.value.trim() || model.defaultPackMeta.id,
        label: labelEl.value.trim() || model.defaultPackMeta.label,
        version: versionEl.value.trim() || model.defaultPackMeta.version,
      };
      const result = runExport(model.rows, servers, meta);
      if (!result.ok) {
        setText(
          message,
          result.reason === "no-selection"
            ? "Select at least one server to export."
            : `Export failed: ${result.message ?? "validation error"}`,
        );
        return;
      }
      void writer
        .saveTextToPath(suggestedFilename(meta), result.serialized)
        .then((wr) => {
          if (wr.ok) {
            this.notify(`Exported pack to ${wr.path}`);
            dialog.remove();
          } else if (wr.reason === "cancelled") {
            setText(message, "Export cancelled.");
          } else {
            setText(message, `Export failed: ${wr.message ?? "I/O error"}`);
          }
        });
    });
  }

  private renderPacksSubsection(root: DomEl): void {
    const packsStore = this.options.presetPacksStore;
    if (!packsStore) return;
    const section = child(root, "div", {
      cls: "copilot-agent-preset-packs",
      attr: { role: "region", "aria-label": "Imported preset packs" },
    });
    child(section, "h3", { text: "Imported preset packs" });
    child(section, "p", {
      cls: "setting-item-description",
      text: "Preset packs add MCP server presets to the Add Server dropdown. Importing a pack does not configure or connect any server.",
    });

    const importBtn = child(section, "button", {
      text: "Import pack from file…",
      attr: { "aria-label": "Import preset pack from file" },
    });
    on(importBtn, "click", () => {
      void this.handleImportPack();
    });

    const list = child(section, "div", {
      attr: { role: "list", "aria-label": "Imported preset packs list" },
    });
    const records = packsStore.snapshot();
    if (records.length === 0) {
      child(list, "p", { text: "No preset packs imported." });
      return;
    }
    const model = renderModelForPackList(records);
    for (const row of model.rows) this.renderPackRow(list, row);
  }

  private renderPackRow(
    list: DomEl,
    row: ReturnType<typeof renderModelForPackList>["rows"][number],
  ): void {
    const rowEl = child(list, "div", {
      cls: "copilot-agent-preset-pack-row",
      attr: {
        role: "listitem",
        "aria-label": `Preset pack ${row.label} (${row.packId}) version ${row.version}`,
      },
    });
    child(rowEl, "strong", { text: row.label });
    child(rowEl, "span", {
      text: ` ${row.packId} · v${row.version} · ${row.presetCount} preset${row.presetCount === 1 ? "" : "s"} · imported ${row.importedAtIso}`,
    });
    child(rowEl, "div", {
      cls: "setting-item-description",
      text: `Source: ${row.sourcePath}`,
    });
    const removeBtn = child(rowEl, "button", {
      text: "Remove pack",
      attr: { "aria-label": `Remove preset pack ${row.label}` },
    });
    on(removeBtn, "click", () => {
      void this.handleRemovePack(row.packId, row.label);
    });
  }

  private async handleImportPack(): Promise<void> {
    const packsStore = this.options.presetPacksStore;
    const reader = this.options.packFileReader;
    if (!packsStore || !reader) {
      this.notify("[Copilot Agent] Pack import is unavailable in this build.");
      return;
    }
    const picked = await reader.pickAndReadPackFile();
    const outcome = runImportFromReaderResult(picked, (text) =>
      findExistingRecord(packsStore.snapshot(), text),
    );

    switch (outcome.kind) {
      case "sizeError":
      case "parseError": {
        const loc =
          outcome.error.line !== undefined && outcome.error.column !== undefined
            ? ` (line ${outcome.error.line}, column ${outcome.error.column})`
            : "";
        this.notify(`[Copilot Agent] Pack import failed: ${outcome.error.message}${loc}`);
        return;
      }
      case "validationError": {
        this.notify(
          `[Copilot Agent] Pack validation failed at ${outcome.error.pointer}: ${outcome.error.message}`,
        );
        return;
      }
      case "ioError":
        this.notify(`[Copilot Agent] Could not read pack file: ${outcome.message}`);
        return;
      case "cancelled":
        return;
      case "confirmNew": {
        const body = formatImportConfirmText(outcome);
        const ok = await this.askConfirm("Import preset pack?", body);
        if (!ok) return;
        try {
          await applyConfirmedImport(packsStore, outcome.pack, outcome.sourcePath);
        } catch (err) {
          this.noticeError(err);
        }
        return;
      }
      case "confirmReimport": {
        const body = formatReimportDiffText(outcome);
        const ok = await this.askConfirm(`Re-import "${outcome.pack.label}"?`, body);
        if (!ok) return;
        try {
          await applyConfirmedImport(packsStore, outcome.pack, outcome.sourcePath);
        } catch (err) {
          this.noticeError(err);
        }
        return;
      }
    }
  }

  private async handleRemovePack(packId: string, label: string): Promise<void> {
    const packsStore = this.options.presetPacksStore;
    if (!packsStore) return;
    const ok = await this.askConfirm(
      `Remove pack ${label}?`,
      `Remove pack ${label}? Already-configured servers will continue to function unchanged.`,
    );
    if (!ok) return;
    try {
      await packsStore.remove(packId);
    } catch (err) {
      this.noticeError(err);
    }
  }

  private async askConfirm(title: string, body: string): Promise<boolean> {
    if (this.options.confirmPackAction) {
      return Promise.resolve(this.options.confirmPackAction(title, body));
    }
    if (typeof window !== "undefined" && typeof window.confirm === "function") {
      return window.confirm(`${title}\n\n${body}`);
    }
    return true;
  }
}

/**
 * Resolve an existing record by parsing the incoming text JUST enough to
 * extract the pack id. If parsing fails here, return null — `runPackImport`
 * will surface the parse error via its own pipeline.
 */
function findExistingRecord(
  records: ReadonlyArray<import("./presets/packTypes").ImportedPackRecord>,
  text: string,
): import("./presets/packTypes").ImportedPackRecord | null {
  try {
    const stripped =
      text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
    const parsed = JSON.parse(stripped) as { id?: unknown };
    if (parsed && typeof parsed === "object" && typeof parsed.id === "string") {
      return records.find((r) => r.pack.id === parsed.id) ?? null;
    }
  } catch {
    // Ignore — main pipeline will produce the parse error.
  }
  return null;
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

function statusDisplay(status: string): { icon: string; label: string } {
  switch (status) {
    case "connected": return { icon: "●", label: "connected" };
    case "connecting": return { icon: "◌", label: "connecting" };
    case "reconnecting": return { icon: "↻", label: "reconnecting" };
    case "crashloop": return { icon: "⚠", label: "crashloop" };
    case "error": return { icon: "!", label: "error" };
    case "disabled": return { icon: "○", label: "disabled" };
    default: return { icon: "○", label: "disconnected" };
  }
}

interface FieldOptions {
  hint?: string;
  placeholder?: string;
}

function labelWithCaption(parent: DomEl, labelText: string): DomEl {
  const label = child(parent, "label");
  const caption = child(label, "span", { cls: "copilot-agent-mcp-field-caption" });
  setText(caption, labelText);
  return label;
}

function maybeAppendHint(label: DomEl, hint?: string): void {
  if (!hint) return;
  const hintEl = child(label, "small", { cls: "copilot-agent-mcp-field-hint" });
  setText(hintEl, hint);
}

function input(parent: DomEl, labelText: string, value: string, options: FieldOptions = {}): HTMLInputElement {
  const label = labelWithCaption(parent, labelText);
  const el = child(label, "input") as HTMLInputElement;
  el.value = value;
  el.setAttribute("aria-label", labelText);
  if (options.placeholder) el.placeholder = options.placeholder;
  maybeAppendHint(label, options.hint);
  return el;
}

function textarea(parent: DomEl, labelText: string, value: string, options: FieldOptions = {}): HTMLTextAreaElement {
  const label = labelWithCaption(parent, labelText);
  const el = child(label, "textarea") as HTMLTextAreaElement;
  el.value = value;
  el.setAttribute("aria-label", labelText);
  if (options.placeholder) el.placeholder = options.placeholder;
  maybeAppendHint(label, options.hint);
  return el;
}

function select(parent: DomEl, labelText: string, options: string[], value: string, fieldOptions: FieldOptions = {}): HTMLSelectElement {
  const label = labelWithCaption(parent, labelText);
  const el = child(label, "select") as HTMLSelectElement;
  for (const option of options) {
    const optionEl = child(el as unknown as DomEl, "option") as HTMLOptionElement;
    optionEl.value = option;
    setText(optionEl as unknown as DomEl, option);
  }
  el.value = value;
  el.setAttribute("aria-label", labelText);
  maybeAppendHint(label, fieldOptions.hint);
  return el;
}

function checkbox(parent: DomEl, labelText: string, checked: boolean): HTMLInputElement {
  const label = child(parent, "label", { cls: "copilot-agent-mcp-checkbox" });
  const el = child(label, "input") as HTMLInputElement;
  el.type = "checkbox";
  el.checked = checked;
  el.setAttribute("aria-label", labelText);
  const caption = child(label, "span");
  setText(caption, labelText);
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

function setHidden(el: DomEl | null, hidden: boolean): void {
  if (!el) return;
  if (hidden) el.setAttribute("hidden", "");
  else el.removeAttribute("hidden");
}

function confirmRemove(name: string): boolean {
  const prompt = `Remove MCP server "${name}"?`;
  if (typeof window !== "undefined" && typeof window.confirm === "function") return window.confirm(prompt);
  return true;
}

function envToText(env: Record<string, string>): string {
  return Object.entries(env).map(([key, value]) => `${key}=${value}`).join("\n");
}

function formatArgs(args: readonly string[]): string {
  return args.map(quoteArgIfNeeded).join(" ");
}

function quoteArgIfNeeded(arg: string): string {
  if (arg === "") return '""';
  if (!/[\s"]/.test(arg)) return arg;
  return `"${arg.replace(/"/g, '\\"')}"`;
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

function callTimeoutSeconds(server: McpServerConfig | undefined): number {
  const ms = numberField(server, "callTimeoutMs");
  if (ms && Number.isFinite(ms) && ms > 0) return Math.floor(ms / 1000);
  const legacySeconds = numberField(server, "callTimeoutSeconds");
  return legacySeconds ?? MCP_CALL_TIMEOUT_DEFAULT_SECONDS;
}

function shouldShowAuthorizationNotice(
  existing: McpServerConfig | undefined,
  next: McpServerConfig,
): boolean {
  if (next.transport !== "http") return false;
  const nextHasAuth =
    !!next.authorization || next.credentials?.kind === "static-bearer";
  if (!nextHasAuth) return false;
  if (!existing) return true;
  if (existing.transport !== "http") return true;
  const existingHasAuth =
    !!existing.authorization ||
    existing.credentials?.kind === "static-bearer";
  return !existingHasAuth;
}

export function credentialsChanged(prev: McpServerConfig, next: McpServerConfig): boolean {
  if (prev.transport !== "http" || next.transport !== "http") return false;
  const prevKey = JSON.stringify({ a: prev.authorization ?? null, c: prev.credentials ?? null });
  const nextKey = JSON.stringify({ a: next.authorization ?? null, c: next.credentials ?? null });
  return prevKey !== nextKey;
}

function applyOptgroupsToSelect(
  select: HTMLSelectElement,
  model: PresetDropdownModel,
  effectiveById: Map<string, EffectivePreset>,
): void {
  const doc = (select as unknown as { ownerDocument?: Document }).ownerDocument;
  if (!doc || typeof doc.createElement !== "function") return;
  const blank = select.options[0];
  while (select.firstChild) select.removeChild(select.firstChild);
  if (blank) select.appendChild(blank);
  for (const group of model.groups) {
    const og = doc.createElement("optgroup");
    og.label = group.label;
    for (const opt of group.options) {
      const o = doc.createElement("option");
      o.value = opt.value;
      const eff = effectiveById.get(opt.value);
      o.textContent = eff ? eff.displayLabel : opt.text;
      og.appendChild(o);
    }
    select.appendChild(og);
  }
}
