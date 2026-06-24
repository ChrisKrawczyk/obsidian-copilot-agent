---
date: 2026-06-23T18:01:23.744-07:00
git_commit: f77b757c40afef9f9666e67cad412180fb9129a6
branch: feature/preset-packs
repository: obsidian-copilot-agent
topic: "Importable Preset Packs"
tags: [research, codebase, mcp, presets, credentials, settings]
status: complete
last_updated: 2026-06-23
---

# Research: Importable Preset Packs

## Research Question

Ground `.paw\work\preset-packs\Spec.md` and `proposals\0007-importable-preset-packs.md` in the current TypeScript Obsidian plugin codebase, with priority on the v0.7.0 `authenticated-mcps` surfaces: preset registry, credential union, validation primitives, settings persistence, Add Server UI, safety prompts, test/doc patterns, file picker and JSON/export mechanics.

## Summary

The current preset registry is a small in-code registry under `src\settings\presets\McpServerPresets.ts`. It exports `McpServerPreset`, `McpServerPresetBuildResult`, `McpServerPresetPreflight`, one built-in M365 Graph preset, and helper `getPresetById` (`src\settings\presets\McpServerPresets.ts:1-82`). The present preset build result is HTTP-only through `PartialHttpServerInput` (`src\settings\presets\McpServerPresets.ts:15-25`), while the spec defines packed presets as direct serialization of the existing build output and expects future packs to carry stdio examples as data (`.paw\work\preset-packs\Spec.md:16-24`, `proposals\0007-importable-preset-packs.md:39-75`).

The credential union actually present in code is `none | static-bearer | command-based | oauth-pkce`; there are no exact variants named `azure-cli-token`, `header-static`, or `command` in source (`src\mcp\credentials\CredentialTypes.ts:5-49`). The M365 Azure CLI preset is represented by the generic `command-based` variant, not a dedicated `azure-cli-token` discriminator (`src\settings\presets\McpServerPresets.ts:59-65`).

Settings persistence currently uses top-level keys in Obsidian plugin `data.json`: `mcpServers` and `mcpAuthorizationNoticeShown` in `McpSettingsStore`, `safety` in `SafetySettingsStore`, and other sibling stores that merge before saving (`src\settings\McpSettingsStore.ts:18-22`, `src\settings\McpSettingsStore.ts:209-230`, `src\settings\SafetySettingsStore.ts:121-125`, `src\settings\SafetySettingsStore.ts:253-276`). There is no existing nested `mcp` object convention.

The Add Server flow lives in `McpServersSection.openForm`. It renders a manual DOM dialog, adds a built-in-only `Preset` select for add-only forms, rewrites option labels to preset labels, calls `preset.build()` on change, and copies build output into the form fields (`src\settings\McpServersSection.ts:222-429`). Preflight checks only display a non-blocking hint and never execute a preset command (`src\settings\McpServersSection.ts:373-427`). Command execution remains in the MCP runtime/credential resolver paths, and MCP tool calls are approval-gated by `SafetyPolicy` and `AgentSession.handlePermissionViaSafetyPolicy` (`src\domain\SafetyPolicy.ts:1-18`, `src\sdk\AgentSession.ts:1536-1728`).

## Documentation System

- **Framework**: Plain Markdown. User-facing docs are repository Markdown files; no docs framework config is present in `package.json` scripts (`package.json:8-27`).
- **Docs Directory**: `docs\` exists and currently contains `docs\m365-graph-mcp.md`; that guide is linked from README and CHANGELOG (`README.md:7-19`, `CHANGELOG.md:12-21`, `docs\m365-graph-mcp.md:1-20`).
- **Navigation Config**: N/A; no mkdocs/docusaurus/sphinx navigation file is referenced by `package.json` scripts (`package.json:8-27`).
- **Style Conventions**: README uses release-oriented `## What's new` sections, bullets, and JSON examples (`README.md:7-66`). `docs\m365-graph-mcp.md` uses task-oriented headings, numbered quick-start steps, tables, and troubleshooting sections (`docs\m365-graph-mcp.md:21-75`, `docs\m365-graph-mcp.md:118-120`). Proposals use short Markdown documents with `Problem`, `Sketch`, and `Open questions` conventions (`proposals\README.md:1-17`).
- **Build Command**: N/A for docs; no docs build script exists in `package.json` (`package.json:8-27`).
- **Standard Files**: `README.md`, `CHANGELOG.md`, `RELEASING.md`, `docs\m365-graph-mcp.md`, `proposals\README.md` (`README.md:1-19`, `CHANGELOG.md:1-21`, `proposals\README.md:1-17`).

## Verification Commands

- **Test Command**: `npm test` (`package.json:12`).
- **Lint Command**: No lint script is defined in `package.json` (`package.json:8-27`).
- **Build Command**: `npm run build` (`package.json:9`).
- **Type Check**: `npm run typecheck` (`package.json:11`).
- **Deploy Command**: `npm run deploy` builds then runs the deploy script (`package.json:13`); repository instructions require `npm test`, `npm run build` or deploy, and `npm run deploy` for source changes before Obsidian manual testing (`.github\copilot-instructions.md:39-51`).

## Detailed Findings

### 1. In-code preset registry

The preset registry is `src\settings\presets\McpServerPresets.ts` (`src\settings\presets\McpServerPresets.ts:1-82`). It imports the credential union type from `src\mcp\credentials\CredentialTypes.ts` (`src\settings\presets\McpServerPresets.ts:1`).

Exact exported interfaces:

```ts
export interface McpServerPresetPreflight {
  type: "findOnPath";
  command: string;
  installHint?: string;
}

export interface PartialHttpServerInput {
  url: string;
  transport: "http";
  name: string;
}

export interface McpServerPresetBuildResult {
  server: PartialHttpServerInput;
  credentials: ServerCredentials;
  preflight?: McpServerPresetPreflight;
}

export interface McpServerPreset {
  id: string;
  label: string;
  description?: string;
  build(): McpServerPresetBuildResult;
}
```

(`src\settings\presets\McpServerPresets.ts:9-32`)

The registry constants pin the one built-in preset id, URL, command, refresh buffer, token path, and expiry path (`src\settings\presets\McpServerPresets.ts:34-40`). The full built-in preset definition is:

```ts
const M365_GRAPH_PRESET: McpServerPreset = {
  id: M365_GRAPH_PRESET_ID,
  label: "Microsoft 365 Graph (via Azure CLI)",
  description:
    "Microsoft 365 Graph MCP via Azure CLI token. Requires `az` signed in to the target tenant.",
  build(): McpServerPresetBuildResult {
    return {
      server: {
        name: "Microsoft 365 Graph",
        transport: "http",
        url: M365_GRAPH_URL,
      },
      credentials: {
        kind: "command-based",
        command: M365_GRAPH_COMMAND,
        tokenPath: M365_GRAPH_TOKEN_PATH,
        expiryPath: M365_GRAPH_EXPIRY_PATH,
        refreshBufferSeconds: M365_GRAPH_REFRESH_BUFFER_SECONDS,
      },
      preflight: {
        type: "findOnPath",
        command: "az",
        installHint: "winget install Microsoft.AzureCLI",
      },
    };
  },
};
```

(`src\settings\presets\McpServerPresets.ts:47-73`)

Built-ins are registered by freezing an array with this single preset, and lookup scans the array by id:

```ts
export const BUILT_IN_PRESETS: readonly McpServerPreset[] = Object.freeze([
  M365_GRAPH_PRESET,
]);

export function getPresetById(id: string): McpServerPreset | undefined {
  return BUILT_IN_PRESETS.find((p) => p.id === id);
}
```

(`src\settings\presets\McpServerPresets.ts:75-81`)

The registry test asserts there is exactly one built-in preset, its id/label are pinned, its build output matches the full M365 object, `getPresetById` returns undefined for unknown ids, and the registry array is frozen (`src\settings\presets\McpServerPresets.test.ts:13-67`). The CHANGELOG entry describes this as the v0.7.0 preset registry and says the M365 preset values are snapshot asserted (`CHANGELOG.md:12-15`).

Observed constraint for FR-005/pack shape: current `McpServerPresetBuildResult.server` is HTTP-only (`PartialHttpServerInput`) even though the proposal and spec include stdio servers (`src\settings\presets\McpServerPresets.ts:15-25`, `proposals\0007-importable-preset-packs.md:41-75`, `.paw\work\preset-packs\Spec.md:16-24`).

### 2. Credential discriminated union and export templating inventory

The exact credential type declarations are:

```ts
export interface NoneCredentials {
  kind: "none";
}

export interface StaticBearerCredentials {
  kind: "static-bearer";
  token: string;
}

export interface CommandBasedCredentials {
  kind: "command-based";
  command: string;
  args?: string[];
  tokenPath?: string;
  expiryPath?: string;
  refreshBufferSeconds?: number;
}

/**
 * Reserved-but-inert OAuth 2.1 + PKCE credentials shape (FR-012).
 *
 * No runtime code in this release consumes this variant; the schema is
 * preserved verbatim so a future plugin version implementing OAuth + PKCE
 * can read configurations written today without migration loss. The index
 * signature lets unknown future fields round-trip losslessly through the
 * settings store (SC-008 byte-equivalence obligation).
 */
export interface OAuthPkceCredentials {
  kind: "oauth-pkce";
  authorizationEndpoint: string;
  tokenEndpoint: string;
  clientId: string;
  tenantId?: string;
  scopes: string[];
  redirectUri?: string;
  refreshTokenRef?: string;
  pkceMethod?: string;
  [futureKey: string]: unknown;
}

export type ServerCredentials =
  | NoneCredentials
  | StaticBearerCredentials
  | CommandBasedCredentials
  | OAuthPkceCredentials;
```

(`src\mcp\credentials\CredentialTypes.ts:5-49`)

Runtime behavior by present variant:

- `none`: resolver returns `null` (`src\mcp\credentials\CredentialResolver.ts:116-123`). No secret-bearing fields in the type (`src\mcp\credentials\CredentialTypes.ts:5-7`).
- `static-bearer`: resolver returns `authorization: prefixBearerIfMissing(credentials.token)` with no expiry (`src\mcp\credentials\CredentialResolver.ts:123-128`). Secret-bearing field: `token` (`src\mcp\credentials\CredentialTypes.ts:9-12`). The form also treats legacy `authorization` and header-derived Authorization as the source for this token (`src\settings\mcpServerFormLogic.ts:241-246`, `src\settings\mcpServerFormLogic.ts:265-287`).
- `command-based`: resolver runs the command or `command + args`, parses stdout JSON, extracts token/expiry by paths, caches the resolved bearer token in memory, and never persists resolved token values (`src\mcp\credentials\CredentialResolver.ts:159-285`, `src\mcp\credentials\CredentialResolver.ts:296-301`, `docs\m365-graph-mcp.md:57-68`). Fields that determine command execution are `command` and optional `args`; structural parse/cache fields are `tokenPath`, `expiryPath`, and `refreshBufferSeconds` (`src\mcp\credentials\CredentialTypes.ts:14-21`). The spec's FR-020 classifies raw credential-command strings as secret-bearing for export templating (`.paw\work\preset-packs\Spec.md:97-126`, `.paw\work\preset-packs\Spec.md:197-198`).
- `oauth-pkce`: resolver throws a structured `not-implemented` error (`src\mcp\credentials\CredentialResolver.ts:131-137`). The type includes OAuth endpoints, client id, tenant id, scopes, redirect URI, refresh token reference, PKCE method, and unknown future keys (`src\mcp\credentials\CredentialTypes.ts:32-43`). Settings parsing preserves the full object including future keys (`src\settings\McpSettingsStore.ts:492-515`), and tests assert byte-equivalent round-trip for the full reserved field set plus unknown keys (`src\settings\McpSettingsStore.test.ts:241-280`).

Exact present variant names are `none`, `static-bearer`, `command-based`, and `oauth-pkce`; no source variant is named `azure-cli-token`, `header-static`, or `command` (`src\mcp\credentials\CredentialTypes.ts:45-51`). The closest source mapping for a future pack validator/exporter is:

| Spec/user shorthand | Present source discriminator | Evidence | SECRET vs structural fields for export |
| --- | --- | --- | --- |
| `none` | `none` | `src\mcp\credentials\CredentialTypes.ts:5-7` | No fields beyond `kind`; no secret fields. |
| `azure-cli-token` | No dedicated kind; M365 Azure CLI preset uses `command-based` | `src\settings\presets\McpServerPresets.ts:59-65` | Current M365 command fields are part of `command-based`; docs say resolved token is memory-only (`docs\m365-graph-mcp.md:57-68`). |
| `static-bearer` | `static-bearer` | `src\mcp\credentials\CredentialTypes.ts:9-12` | `token` is secret-bearing. |
| `header-static` | No persisted credential kind; form can read `headers.Authorization` into `static-bearer` | `src\settings\mcpServerFormLogic.ts:241-246`, `src\settings\mcpServerFormLogic.test.ts:113-127` | Authorization header value maps to `static-bearer.token`; header name is structural. |
| `command` | Present source name is `command-based` | `src\mcp\credentials\CredentialTypes.ts:14-21` | `command` and optional `args` are command-execution fields; FR-020 names raw credential-command strings as secret-bearing (`.paw\work\preset-packs\Spec.md:197-198`). `tokenPath`, `expiryPath`, `refreshBufferSeconds` are structural. |
| Other present | `oauth-pkce` | `src\mcp\credentials\CredentialTypes.ts:32-43` | Reserved/inert at runtime; `refreshTokenRef` is a reference field, not a token value by type name. Unknown future keys are preserved (`src\settings\McpSettingsStore.ts:492-515`). |

Server config also has non-credential fields relevant to FR-020 export:

- `McpStdioServerConfig` includes `command`, `args`, optional `env`, and optional `cwd` (`src\mcp\McpTypes.ts:35-41`). The form parses environment text into `Record<string,string>` (`src\settings\McpServersSection.ts:433-436`, `src\settings\McpServersSection.ts:704-710`). Existing validation warns on denylisted env key names but does not mark env entries as secret/non-secret (`src\settings\mcpServerFormLogic.ts:132-137`, `src\settings\mcpServerFormLogic.ts:397-406`, `src\settings\mcpServerFormLogic.test.ts:150-155`).
- Legacy HTTP `authorization?: string` remains on `McpHttpServerConfig` for one release of read-only compatibility, while new saves emit `credentials: { kind: "static-bearer", token }` (`src\mcp\McpTypes.ts:43-54`, `src\settings\McpSettingsStore.ts:394-413`).

### 3. Validation primitives in the settings layer

`mcpServerFormLogic.ts` is the existing DOM-free validation/build module for the MCP settings form (`src\settings\mcpServerFormLogic.ts:17-80`). Its input and result signatures are:

```ts
export type McpCredentialKindUiSelection = "none" | "static-bearer" | "command-based";

export interface McpServerFormInput {
  id: string;
  name?: string;
  enabled?: boolean;
  transport: "stdio" | "http";
  command?: string;
  args?: string | string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  authorization?: string;
  headers?: Record<string, string>;
  callTimeoutSeconds?: number;
  callTimeoutMs?: number;
  privateNetworkConfirmed?: boolean;
  revealSensitive?: boolean;
  rejectUnauthorized?: never;
  insecure?: never;
  skipTls?: never;
  /** Phase 5: HTTP-only credential variant selected in the UI. */
  credentialKind?: McpCredentialKindUiSelection;
  /** Phase 5: command-based variant fields. */
  credentialCommand?: string;
  credentialTokenPath?: string;
  credentialExpiryPath?: string;
  credentialRefreshBufferSeconds?: number;
}

export interface McpServerFormValidationResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
  denylistEnvWarnings: ExplicitDenylistOverrideWarning[];
  confirmationRequired: boolean;
  hostClass?: HostClass;
  normalizedId?: McpServerId;
  config?: McpServerConfig;
  callTimeoutSeconds: number;
  initializeTimeoutSeconds: number;
  toolsListPageTimeoutSeconds: number;
  headerDisplay: McpHeaderDisplay[];
  sensitiveFields: { authorizationRedacted: boolean; authorizationDisplay: string };
}
```

(`src\settings\mcpServerFormLogic.ts:17-75`)

Validation error reporting is accumulated as a `string[]`; `ok` is `errors.length === 0 && !!config`, and the UI joins errors and warnings with newlines in the form message (`src\settings\mcpServerFormLogic.ts:81-115`, `src\settings\mcpServerFormLogic.ts:185-210`, `src\settings\McpServersSection.ts:471-480`). Example error strings include `Command is required for stdio MCP servers.`, `URL is required for HTTP MCP servers.`, `MCP server id "..." already exists.`, `Static bearer credentials require a non-empty token.`, and `Command-based credentials require a non-empty command.` (`src\settings\mcpServerFormLogic.ts:101-104`, `src\settings\mcpServerFormLogic.ts:120-131`, `src\settings\mcpServerFormLogic.ts:151-178`, `src\settings\mcpServerFormLogic.ts:281-292`). Tests assert these error message patterns (`src\settings\mcpServerFormLogic.test.ts:14-33`, `src\settings\mcpServerFormLogic.credentials.test.ts:18-63`).

Primitive validators and helpers already available in or adjacent to the settings layer:

- `normalizeServerId` lowercases ids and enforces `[a-z0-9_-]+`, max length, no slashes/control characters, and no `mcp__` prefix (`src\mcp\McpIdentity.ts:3-25`).
- URL validation uses `assertNoTlsBypassOptions` and `validateMcpHttpUrl`, producing private-network confirmation warnings and host classification (`src\settings\mcpServerFormLogic.ts:151-165`, `src\mcp\httpPolicy.ts` referenced by import at `src\settings\mcpServerFormLogic.ts:3`).
- TLS bypass keys are rejected at top-level or under headers by `findTlsBypassKey`/`assertNoTlsBypassFields` (`src\settings\mcpServerFormLogic.ts:15`, `src\settings\mcpServerFormLogic.ts:93-95`, `src\settings\mcpServerFormLogic.ts:236-239`, `src\settings\mcpServerFormLogic.ts:420-430`).
- Stdio args are parsed from a shell-like string by `parseArgs`, which supports double-quoted, single-quoted, and non-space tokens (`src\settings\mcpServerFormLogic.ts:123-124`, `src\settings\mcpServerFormLogic.ts:408-413`).
- Control characters are rejected in commands and args (`src\settings\mcpServerFormLogic.ts:120-126`, `src\settings\mcpServerFormLogic.ts:416-418`).
- Env denylist warnings come from `matchDenylist` through `collectDenylistWarnings` (`src\settings\mcpServerFormLogic.ts:132-137`, `src\settings\mcpServerFormLogic.ts:397-406`).
- Credential variant validation is in `resolveCredentialsFromForm`, with branch-specific errors and `refreshBufferSeconds` range checking (`src\settings\mcpServerFormLogic.ts:260-318`).
- Persistence-level credential parsing validates raw settings objects in `parseCredentials`, accepting only known discriminators and required field types (`src\settings\McpSettingsStore.ts:428-517`). This function is currently private to the store.

No JSON-schema dependency is present in runtime dependencies or devDependencies; package dependencies are `@github/copilot-sdk` and `@modelcontextprotocol/sdk`, and devDependencies are TypeScript/Vitest/esbuild/Obsidian/tsx/types (`package.json:32-43`). The spec requires no new schema-library dependency for pack validation (`.paw\work\preset-packs\Spec.md:208-215`).

### 4. Settings persistence

`main.ts` wires `McpSettingsStore` to Obsidian's `Plugin.loadData()` / `Plugin.saveData()` (`src\main.ts:254-266`). The `McpSettingsStore` constructor accepts the same `PluginDataIO` shape used by auth storage (`src\settings\McpSettingsStore.ts:1-6`, `src\settings\McpSettingsStore.ts:51-56`).

The persisted MCP shape is currently modeled as:

```ts
interface PersistedShapeWithMcp {
  mcpServers?: unknown;
  mcpAuthorizationNoticeShown?: unknown;
  [topLevelKey: string]: unknown;
}
```

(`src\settings\McpSettingsStore.ts:18-22`)

`load()` reads `raw.mcpServers`, validates each entry, drops malformed or duplicate entries with a one-time Notice, and caches valid `McpServerConfig[]` (`src\settings\McpSettingsStore.ts:58-97`). `persist()` re-reads the latest full plugin data object, spreads all existing top-level keys, then writes `mcpAuthorizationNoticeShown` and canonical `mcpServers` (`src\settings\McpSettingsStore.ts:209-230`). Tests assert sibling top-level keys such as `auth`, `safety`, and `conversations` are preserved when saving MCP settings (`src\settings\McpSettingsStore.test.ts:66-81`).

The current config shape is:

```ts
export interface McpServerConfigBase {
  id: McpServerId;
  name: string;
  enabled: boolean;
  trustEpoch: McpTrustEpoch;
  callTimeoutMs?: number;
  [futureKey: string]: unknown;
}

export interface McpStdioServerConfig extends McpServerConfigBase {
  transport: "stdio";
  command: string;
  args: string[];
  env?: Record<string, string>;
  cwd?: string;
}

export interface McpHttpServerConfig extends McpServerConfigBase {
  transport: "http";
  url: string;
  /**
   * Legacy field retained for one release of read-only backward compatibility.
   * New saves emit a canonical `credentials: { kind: "static-bearer", token }`
   * instead. The settings store migrates legacy `authorization` to
   * `credentials` on load (FR-001, FR-002, Phase 1 plan).
   */
  authorization?: string;
  credentials?: ServerCredentials;
}

export type McpServerConfig = McpStdioServerConfig | McpHttpServerConfig;
```

(`src\mcp\McpTypes.ts:26-56`)

Runtime-only fields stripped before persistence are `status`, `lastError`, `lastConnectedAt`, `lastDisconnectedAt`, `mcpSessionId`, `Mcp-Session-Id`, `sessionId`, `tools`, and `instructions`; `callTimeoutSeconds` is also normalized away, and `headers.Mcp-Session-Id` is removed if present (`src\settings\McpSettingsStore.ts:32-42`, `src\settings\McpSettingsStore.ts:366-381`). Tests assert runtime fields do not serialize (`src\settings\McpSettingsStore.test.ts:128-146`, `src\settings\McpSettingsStore.test.ts:319-342`).

Existing key convention is top-level merged stores: `safety` is stored by `SafetySettingsStore` under a top-level `safety` key while preserving `auth` and `settings` siblings (`src\settings\SafetySettingsStore.ts:121-125`, `src\settings\SafetySettingsStore.ts:253-276`); conversations use their own top-level keys per the comment in `main.ts` (`src\main.ts:269-273`). Therefore the spec's `mcp.presetPacks` wording does not match an existing nested `mcp` object convention; the existing MCP keys are `mcpServers` and `mcpAuthorizationNoticeShown` (`src\settings\McpSettingsStore.ts:18-22`, `src\settings\McpSettingsStore.ts:225-229`).

### 5. Add Server flow: preset dropdown and pre-fill logic

`McpServersSection.render()` creates the MCP settings region, description, and `Add server` button; clicking opens `openForm()` (`src\settings\McpServersSection.ts:85-109`). `openForm(existing?)` creates a manual DOM dialog with role `dialog`, then creates form fields for server id, name, transport, command, args, URL, authorization, credential kind, command credential fields, working directory, env, timeout, private-network checkbox, Save, and Cancel (`src\settings\McpServersSection.ts:222-498`).

Preset UI is add-only:

```ts
if (!existing) {
  const presetIds = BUILT_IN_PRESETS.map((p) => p.id);
  const presetSelect = select(modal, "Preset", ["", ...presetIds], "", {
    hint: "Optional. Pre-fills the form for a known MCP service.",
  });
  // Rewrite option text where supported (real DOM only; FakeElement test
  // harness has no `.options` API so this is best-effort).
  const opts = (presetSelect as unknown as { options?: ArrayLike<HTMLOptionElement> }).options;
  if (opts && opts.length > 0) {
    const blank = opts[0];
    if (blank) blank.textContent = "— none —";
    for (let i = 0; i < opts.length; i++) {
      const opt = opts[i];
      const preset = getPresetById(opt.value);
      if (preset) opt.textContent = preset.label;
    }
  }
```

(`src\settings\McpServersSection.ts:373-392`)

On preset change, current code gets the preset by id, clears the hint, calls `preset.build()`, fills the id only if blank, copies `name`, `transport`, and HTTP `url`, then fills command-based credential fields when applicable (`src\settings\McpServersSection.ts:397-416`). It then checks `preflight.type === "findOnPath"`; if the configured command is missing according to `executableExists` or `pathExists`, it renders a non-blocking hint (`src\settings\McpServersSection.ts:416-427`).

The Phase 5 UI tests assert the dropdown exists, lists `m365-graph-az-cli`, selecting the preset fills URL, credential kind, and credential command, and missing `az` produces the non-blocking install hint (`src\settings\McpServersSection.phase5.test.ts:88-128`). The test for `executableExists` confirms preflight prefers the command-on-PATH probe over path existence (`src\settings\McpServersSection.phase5.test.ts:273-297`).

Observed constraint for FR-004 grouped dropdown: the local `select(...)` helper only creates a flat `<select>` and flat `<option>` children from string options; it has no optgroup/source grouping support today (`src\settings\McpServersSection.ts:639-651`).

### 6. Settings UI conventions and primitives

The plugin uses both Obsidian Settings API components and manual DOM helpers:

- `SettingsTab.ts` extends `PluginSettingTab`, imports `Setting`, and uses `new Setting(...).addToggle`, `.addDropdown`, `.addTextArea`, `.addText`, and `.addButton` for global settings (`src\settings\SettingsTab.ts:1-24`, `src\settings\SettingsTab.ts:38-55`, `src\settings\SettingsTab.ts:134-254`, `src\settings\SettingsTab.ts:336-404`).
- `McpServersSection.ts` manually creates DOM with helper functions `child`, `input`, `textarea`, `select`, and `checkbox`, plus buttons and custom role attributes (`src\settings\McpServersSection.ts:577-687`). This section uses `new Notice` for transient feedback (`src\settings\McpServersSection.ts:561-568`).
- Device flow uses a real Obsidian `Modal` subclass and a `Setting` button inside it (`src\ui\DeviceFlowModal.ts:1-13`, `src\ui\DeviceFlowModal.ts:33-105`). `SettingsTab` opens it by constructing `DeviceFlowModal` and calling `modal.open()` (`src\settings\SettingsTab.ts:565-574`).
- Conversation rename/delete uses lightweight manual overlays, and `confirmDestructive` renders a Yes/No confirmation card with `Cancel` and warning-confirm buttons (`src\ui\ConversationPicker.ts:208-260`). Chat undo calls `confirmDestructive` with custom title/body/CTA (`src\ui\ChatView.ts:1117-1125`).
- MCP server removal currently uses browser `window.confirm` via `confirmRemove`, falling back to `true` outside browser tests (`src\settings\McpServersSection.ts:542-548`, `src\settings\McpServersSection.ts:684-688`).

The Obsidian test mock includes `PluginSettingTab`, `Setting`, `ButtonComponent`, `Modal`, `Notice`, and `FileSystemAdapter.getBasePath()` stubs for node-environment tests (`src\test\obsidianMock.ts:21-54`, `src\test\obsidianMock.ts:77-100`, `src\test\obsidianMock.ts:111-115`).

No existing source code path uses a native open/save file dialog API: repository searches for `showOpenDialog`, `showSaveDialog`, `window.electron`, and `electron.remote` return no source hits; existing desktop-only filesystem access obtains the vault root via `adapter.getBasePath()` and Node `fs` in settings/main code (`src\settings\SettingsTab.ts:1-3`, `src\settings\SettingsTab.ts:276-288`, `src\main.ts:315-316`).

### 7. Existing safety prompt / first-run trust gate for imported preset commands

Safety policy is a pure decision module gating every tool call. It classifies sources as `vault`, `extra-vault`, `mcp`, or `builtin`; comments state MCP and built-ins always require approval by default unless explicitly granted (`src\domain\SafetyPolicy.ts:1-18`). MCP session grants are scoped to exact `(stable server id, tool name, trust epoch)` tuples (`src\domain\SafetyPolicy.ts:60-70`, `src\domain\SafetyPolicy.ts:83-109`). Persistent grants use keys from `formatMcpApprovalKey(serverId, toolName, trustEpoch)` (`src\settings\SafetySettingsStore.ts:92-99`, `src\settings\SafetySettingsStore.ts:213-239`, `src\mcp\McpIdentity.ts:50-56`).

Trust epoch material includes stdio server name, transport, command, and args, or HTTP name, transport, and URL. Credential fields are explicitly excluded (`src\mcp\McpIdentity.ts:27-48`). This means a configured stdio server created from an imported preset has command/args in its trust epoch; changing those identity fields changes approval scope (`src\mcp\McpIdentity.ts:35-47`). Settings code revokes grants on trust-epoch changes and on server removal (`src\settings\McpServersSection.ts:500-558`). Tests assert grant-revocation Notice behavior on epoch and non-epoch edits (`src\settings\McpServersSection.test.ts:275-295`).

`AgentSession` sends SDK sessions with `availableTools: ["builtin:*", "custom:*", "mcp:*"]` and an `onPermissionRequest` callback (`src\sdk\AgentSession.ts:1137-1144`, `src\sdk\AgentSession.ts:1321-1328`). `handlePermissionViaSafetyPolicy` builds a safety input, calls `decideSafety`, renders an `approval_prompt` stream event when approval is required, waits for the UI's deferred choice, grants session scopes for approve-for-session, and returns SDK approve-once for both approve-once and approve-for-session (`src\sdk\AgentSession.ts:1536-1728`). For MCP requests, `buildSafetyInput` obtains stable server/tool/trust metadata and sets source `mcp` (`src\sdk\AgentSession.ts:1730-1766`).

The chat UI wires prompt buttons to `agent.resolveApproval` with approve-once, approve-for-session, and reject choices (`src\ui\ChatView.ts:314-328`). Pending approval events render inline approval blocks (`src\ui\ChatView.ts:926-940`). `ToolCallBlock` opens pending approval blocks by default and renders `Approve Once`, `Approve for Session`, and `Reject` buttons with explanatory text (`src\ui\ToolCallBlock.ts:70-80`, `src\ui\ToolCallBlock.ts:91-93`, `src\ui\ToolCallBlock.ts:177-240`).

Preset import/render paths do not run commands today. Existing preset preflight only calls `executableExists`/`pathExists` and writes a hint; command execution happens later through saved server runtime or credential resolver paths (`src\settings\McpServersSection.ts:416-427`, `src\mcp\credentials\CredentialResolver.ts:211-285`, `src\mcp\transport\StdioTransport.ts:54-80`).

### 8. Existing PAW patterns from `authenticated-mcps`

The predecessor work's implementation plan describes a phased sequence with phase status checkboxes, current state analysis, desired end state, explicit non-goals, per-phase changes, tests, automated verification, and manual verification (`.paw\work\authenticated-mcps\ImplementationPlan.md:1-63`, `.paw\work\authenticated-mcps\ImplementationPlan.md:64-130`). The final phase list shows six completed phases: credential schema/persistence, pure resolver, command runner, HTTP integration/401/trust invariance, preset registry/settings UI/test connection/preflight, and documentation (`.paw\work\authenticated-mcps\ImplementationPlan.md:49-56`).

The prior CodeResearch captured Documentation System, Verification Commands, Detailed Findings, Code References, and Architecture Documentation, with file:line claims throughout (`.paw\work\authenticated-mcps\CodeResearch.md:1-43`). It records the node-only Vitest pattern and pure sibling module approach as a baseline for settings/UI logic (`.paw\work\authenticated-mcps\ImplementationPlan.md:14-19`, `.paw\work\authenticated-mcps\ImplementationPlan.md:18-19`).

The predecessor plan's test scaffolding pattern placed pure validation in `src\settings\mcpServerFormLogic.ts`, settings-store round-trip tests in `src\settings\McpSettingsStore.test.ts`, and UI orchestration tests in `src\settings\McpServersSection*.test.ts` (`.paw\work\authenticated-mcps\ImplementationPlan.md:77-82`, `.paw\work\authenticated-mcps\ImplementationPlan.md:114-118`). Current source reflects those files and tests (`src\settings\mcpServerFormLogic.test.ts:1-169`, `src\settings\mcpServerFormLogic.credentials.test.ts:1-197`, `src\settings\McpSettingsStore.test.ts:164-344`, `src\settings\McpServersSection.phase5.test.ts:88-345`).

Repository instructions require the implement/review loop and deploy/manual-smoke loop for source changes (`.github\copilot-instructions.md:7-37`, `.github\copilot-instructions.md:39-51`, `.github\copilot-instructions.md:53-62`).

### 9. Test conventions and likely testing surface

Vitest is configured for a node environment, includes `src/**/*.test.ts`, and aliases `obsidian` to `src\test\obsidianMock.ts` (`vitest.config.ts:1-19`). Repository instructions explicitly say UI code that needs unit tests should be refactored into pure sibling modules and tested without jsdom/happy-dom (`.github\copilot-instructions.md:39-45`). Existing tests follow this pattern with pure `mcpServerFormLogic` tests, UI fake-element tests, and `chatKeydown.ts` pure tests (`src\settings\mcpServerFormLogic.test.ts:1-169`, `src\settings\McpServersSection.phase5.test.ts:1-88`, `src\ui\chatKeydown.test.ts:1-72`).

Likely surfaces for pack import/export/validation logic based on current conventions:

- Pure pack schema/normalization/diff/template logic can live in a sibling pure module and be tested under `src\settings\...*.test.ts`, mirroring `mcpServerFormLogic.ts` and credential tests (`src\settings\mcpServerFormLogic.ts:77-80`, `src\settings\mcpServerFormLogic.credentials.test.ts:6-137`).
- Settings persistence for imported pack records can be tested like `McpSettingsStore`: memory IO, load/save, sibling preservation, malformed drops/rejections, canonical save behavior (`src\settings\McpSettingsStore.test.ts:7-16`, `src\settings\McpSettingsStore.test.ts:43-81`, `src\settings\McpSettingsStore.test.ts:164-344`).
- Add Server/import/export UI orchestration can be tested with the existing FakeElement pattern in `McpServersSection` tests, not browser DOM (`src\settings\McpServersSection.test.ts:8-48`, `src\settings\McpServersSection.phase5.test.ts:7-42`).
- Existing phase-5 preset tests are the current precedent for testing dropdown entries, pre-fill, and non-blocking preflight (`src\settings\McpServersSection.phase5.test.ts:88-128`, `src\settings\McpServersSection.phase5.test.ts:273-297`).

### 10. File picker on desktop Obsidian

Current code uses Obsidian's vault adapter `getBasePath()` for desktop-only absolute path access in settings and main wiring (`src\settings\SettingsTab.ts:276-288`, `src\main.ts:315-316`). The `FileSystemAdapter` mock exposes `getBasePath()` only (`src\test\obsidianMock.ts:111-115`).

No plugin source currently calls Electron native dialog APIs (`showOpenDialog`, `showSaveDialog`, `window.electron`, or `electron.remote`). Existing code that needs HTTP outside browser CORS uses Obsidian `requestUrl`, not Electron APIs (`src\auth\HttpClient.ts:1-5`, `src\auth\HttpClient.ts:51-70`, `src\mcp\transport\obsidianFetch.ts:1-24`, `src\mcp\transport\obsidianFetch.ts:50-89`). Existing file writes in persistence use the vault adapter `write` method for conversation sidecars, not a native save dialog (`src\persistence\ConversationsStore.ts:511`).

Observed constraint for FR-001/FR-011: there is no existing file-picker or save-dialog abstraction to reuse; current desktop filesystem precedent is `getBasePath()` plus Node `fs` in settings (`src\settings\SettingsTab.ts:1-3`, `src\settings\SettingsTab.ts:276-288`).

### 11. JSON parsing: strict JSONC rejection and BOM handling

All JSON parsing in current source uses `JSON.parse` directly, including credential command stdout, Device Flow responses, requestUrl error JSON, search result rendering, undo id extraction, binary metadata, and release helpers (`src\mcp\credentials\CredentialResolver.ts:239-248`, `src\auth\DeviceFlow.ts:248-267`, `src\auth\HttpClient.ts:70`, `src\ui\searchResultRenderer.ts:55`, `src\ui\ChatView.ts:1174`, `src\sdk\BinaryFetcher.ts:272`, `src\release\versionsJson.ts:9`). `McpSettingsStore.cloneServerConfig` also deep-clones with `JSON.parse(JSON.stringify(server))` (`src\settings\McpSettingsStore.ts:415-417`).

The pack spec requires strict JSON, rejection of JSONC comments, and BOM tolerance by stripping before parse (`.paw\work\preset-packs\Spec.md:150-159`, `.paw\work\preset-packs\Spec.md:199-200`, `.paw\work\preset-packs\Spec.md:221-227`). No current JSON helper strips a UTF-8 BOM before parsing; direct `JSON.parse` call sites do not include BOM handling (`src\mcp\credentials\CredentialResolver.ts:239-248`, `src\auth\HttpClient.ts:70`, `src\release\versionsJson.ts:9`). Therefore pack parsing needs a new pre-parse string step for BOM removal while still feeding strict JSON text to `JSON.parse`.

### 12. Export: picking servers and writing a file

Configured servers are available from `McpSettingsStore.snapshot()` as cloned `McpServerConfig[]` (`src\settings\McpSettingsStore.ts:99-101`). The settings section uses `this.options.store.snapshot()` to render rows and to validate id collisions (`src\settings\McpServersSection.ts:101-108`, `src\settings\McpServersSection.ts:471-476`). Each configured row currently has per-server buttons: Edit, Enable/Disable, Reconnect, Remove, and HTTP-only Test connection (`src\settings\McpServersSection.ts:175-194`). There is no existing multi-select UI in the MCP settings list; rows are rendered as divs with role `listitem` and per-row buttons (`src\settings\McpServersSection.ts:111-195`).

Server config export must strip runtime-only state. The existing store already strips runtime keys on save (`src\settings\McpSettingsStore.ts:32-42`, `src\settings\McpSettingsStore.ts:366-381`) and tests assert fields such as `status`, `lastError`, and `Mcp-Session-Id` are absent after save (`src\settings\McpSettingsStore.test.ts:128-146`). `toPersistedServerConfig` canonicalizes legacy HTTP authorization to `credentials` on save (`src\settings\McpSettingsStore.ts:394-413`).

There is no existing native save dialog or browser download helper in source. The closest write precedent is `ConversationsStore` writing sidecar JSON via Obsidian's adapter (`src\persistence\ConversationsStore.ts:511`), and the closest desktop absolute-path precedent is `getBasePath()` plus Node `fs` (`src\settings\SettingsTab.ts:1-3`, `src\settings\SettingsTab.ts:276-288`).

## Code References

- `src\settings\presets\McpServerPresets.ts:9-32` - Preset/preflight/build interfaces.
- `src\settings\presets\McpServerPresets.ts:47-73` - Full M365 Graph preset object.
- `src\settings\presets\McpServerPresets.ts:75-81` - Frozen built-in registry and id lookup.
- `src\mcp\credentials\CredentialTypes.ts:5-49` - `ServerCredentials` union and variants.
- `src\settings\McpSettingsStore.ts:18-22` - Current persisted MCP top-level shape.
- `src\settings\McpSettingsStore.ts:209-230` - Merge-and-save persistence under top-level keys.
- `src\settings\McpSettingsStore.ts:428-517` - Current private credential parser for persisted settings.
- `src\settings\mcpServerFormLogic.ts:17-75` - Form input/result validation contracts.
- `src\settings\mcpServerFormLogic.ts:77-210` - Core validation return path and error/warning arrays.
- `src\settings\McpServersSection.ts:373-427` - Current preset dropdown, pre-fill, and preflight hint.
- `src\settings\McpServersSection.ts:639-651` - Flat select helper used by the dropdown.
- `src\domain\SafetyPolicy.ts:1-18` - Tool-call safety policy sources and default approval behavior.
- `src\sdk\AgentSession.ts:1536-1728` - Approval prompt/deferred safety flow.
- `src\ui\ToolCallBlock.ts:177-240` - Rendered approval prompt buttons.
- `vitest.config.ts:12-18` - Node test environment and source test include pattern.
- `.github\copilot-instructions.md:39-51` - Test/deploy expectations for plugin code changes.

## Architecture Documentation

The existing architecture separates pure validation/build logic from DOM orchestration. `McpServersSection` owns rendering and user events, while `mcpServerFormLogic` builds canonical `McpServerConfig` objects and returns string errors/warnings (`src\settings\McpServersSection.ts:471-497`, `src\settings\mcpServerFormLogic.ts:77-210`). Persistence stores validate raw `unknown` settings data and preserve unrelated top-level keys by merge-and-write (`src\settings\McpSettingsStore.ts:58-97`, `src\settings\McpSettingsStore.ts:209-230`, `src\settings\SafetySettingsStore.ts:253-276`).

Preset selection today is a pure data pre-fill into the same form and save path as manual entry; it does not bypass validation or persistence (`src\settings\McpServersSection.ts:397-497`). This is the surface FR-005 can extend for imported presets.

Safety is attached to configured server/tool use, not preset import. Imported pack data that becomes a saved server will flow through `computeTrustEpoch`, MCP grant keys, SDK permission requests, and inline approval prompts during tool calls (`src\mcp\McpIdentity.ts:27-56`, `src\settings\SafetySettingsStore.ts:213-250`, `src\sdk\AgentSession.ts:1536-1728`, `src\ui\ToolCallBlock.ts:177-240`).

## Open Questions / Risks for Planning

- Current preset build output is HTTP-only (`PartialHttpServerInput`), while the pack proposal/spec examples include stdio servers (`src\settings\presets\McpServerPresets.ts:15-25`, `proposals\0007-importable-preset-packs.md:51-61`).
- Current credential variant names do not include `azure-cli-token`, `header-static`, or `command`; the present union uses `command-based` and `static-bearer` (`src\mcp\credentials\CredentialTypes.ts:45-49`).
- There is no persisted header-static credential shape. `headers.Authorization` is only an input compatibility path that emits `static-bearer` credentials (`src\settings\mcpServerFormLogic.ts:241-246`, `src\settings\mcpServerFormLogic.test.ts:113-127`).
- There is no env secret marking field in `McpStdioServerConfig`; env values are a plain `Record<string,string>` with denylist warnings by key (`src\mcp\McpTypes.ts:35-41`, `src\settings\mcpServerFormLogic.ts:397-406`).
- The existing MCP settings UI has no multi-select pattern for choosing one or more servers to export (`src\settings\McpServersSection.ts:111-195`).
- The codebase has no existing open/save file-dialog wrapper or Electron dialog usage; current desktop filesystem precedent is `getBasePath()` plus Node `fs` (`src\settings\SettingsTab.ts:1-3`, `src\settings\SettingsTab.ts:276-288`, `src\test\obsidianMock.ts:111-115`).
- Direct `JSON.parse` call sites do not strip BOM before parse; strict JSONC rejection is natural, but BOM tolerance needs an explicit string normalization step (`src\mcp\credentials\CredentialResolver.ts:239-248`, `src\auth\HttpClient.ts:70`, `.paw\work\preset-packs\Spec.md:150-155`).

## Recommendations for implementation plan

- Decide whether to evolve `McpServerPresetBuildResult.server` from HTTP-only to a union aligned with `McpServerConfig` transport shapes before adding pack validation (`src\settings\presets\McpServerPresets.ts:15-25`, `src\mcp\McpTypes.ts:35-56`).
- Decide the persisted settings key shape explicitly: existing MCP settings use top-level `mcpServers`/`mcpAuthorizationNoticeShown`, not nested `mcp.presetPacks` (`src\settings\McpSettingsStore.ts:18-22`, `src\settings\McpSettingsStore.ts:225-229`).
- Keep pack validation/diff/canonicalization/templating in pure modules with node Vitest coverage, and keep `McpServersSection` as a thin UI/event layer, matching existing test conventions (`vitest.config.ts:12-18`, `.github\copilot-instructions.md:39-45`, `src\settings\mcpServerFormLogic.test.ts:1-169`).
- Reuse existing form validation and canonical save paths after preset selection so imported presets have the same pre-fill and save behavior as built-ins (`src\settings\McpServersSection.ts:397-497`).
- Treat file picker/save dialog work as a new platform abstraction because no native dialog precedent exists in source; tests will need an injectable abstraction rather than real Electron/Obsidian desktop APIs (`src\settings\SettingsTab.ts:276-288`, `src\test\obsidianMock.ts:111-115`).
