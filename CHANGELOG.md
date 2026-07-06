# Changelog

All notable changes to this project are documented in this file.
The format is loosely based on [Keep a Changelog](https://keepachangelog.com/).

## [0.10.1] - 2026-07-06

Quality release: dependency refresh and README install guidance. No functional changes to plugin behavior.

### Changed

- **Bumped `@github/copilot-sdk` from `1.0.0` → `1.0.5`.** Picks up ~5 months of upstream stable-track improvements. Transitive `@github/copilot` binary is pinned to `1.0.68` (latest stable). All 1605 tests pass unchanged; no plugin-visible SDK API drift.
- **README: promoted BRAT install instructions above the fold.** A compact `## Install` section now sits right below the status banner so first-time readers see the install recipe before the multi-version "What's new" history. The full platform-support / first-launch / known-limitations breakdown remains further down.


## [0.10.0] - 2026-07-03

Agent-native vault navigation surface. Six new / upgraded read-only capabilities let the agent locate, inspect, and traverse notes without asking the human — a substitute for the local-embedding path explored (and rejected) in proposal #0004. All new tools are auto-approved under the FR-017 read-only gate. No breaking changes.

### Added

- **`search_content` modes (Phase 1).** The existing full-text search tool now accepts an explicit `mode`: `substring` (default; literal, byte-for-byte compatible with the v0.9 behavior), `regex` (JavaScript pattern with ranked/fuzzy fallback), or `fuzzy` (Obsidian's own scorer via `prepareFuzzySearch`). Returns match spans for precise follow-up reads. Backwards-compatible: omitting `mode` preserves the v0.9 behavior. (`src/tools/ReadTools.ts` — `searchInFiles` helper.)
- **`resolve_link` (Phase 2).** Resolves a wikilink or markdown link to its target vault path, source-aware — matches Obsidian's own click behavior. Distinguishes `unresolved` from `metadata-cache-not-ready` for the FR-014 warmup contract. (`src/tools/NavigateTools.ts`.)
- **`get_outlinks` (Phase 2).** Lists a note's outgoing links + embeds. Distinguishes wikilink vs. markdown-link kinds; includes `resolvedPath` when Obsidian can resolve the target. Capped at 200 entries with a truncation signal.
- **`get_note_structure` (Phase 2).** Returns a note's headings + sections + block IDs with line numbers, WITHOUT body prose. Cheap structural inspection to plan a targeted `read_file`. Capped at 500 combined items.
- **`search_vault` (Phase 3).** Compound query: AND-combines tag / folder-prefix / `modifiedSince` / text filters in a single call. Short-circuits without body reads when structural filters exclude every note. Delegates ranked/fuzzy text search to the Phase 1 helper. Capped at 100 results.
- **`related_notes` (Phase 4).** Ranks vault neighbours of a source note by shared tags (weight 3), shared outlinks (weight 2), and shared backlinks (weight 1). Returns up to 20 results with per-signal counts. Deterministic sort (score desc, path asc). Zero-score neighbours are dropped.

### Changed

- Session-start preamble inventory (`vaultToolManifest.ts`) lists all five new capabilities plus the updated `search_content` hint so the agent discovers them on the first turn (FR-011 / SC-011).

### Under the hood

- All five new tools share the FR-014 metadata-cache-warmup contract: when the source file exists but its cache entry hasn't populated yet, the tool returns `{ok: false, reason: "metadata-cache-not-ready"}` — a retryable signal, distinct from a terminal `not-found`.
- No new npm dependencies. No schema changes.

### Follow-ups

- Dataview query tool (deferred to proposal `#0011`).


## [0.9.0] - 2026-07-02

Two small, coherent UX follow-ups on top of v0.8.0's MCP work: the chat composer now tells you what it is waiting on when it stalls on an MCP server, and slow-authenticating servers that connect after the composer opens (or reconnect after a token expiry) get their tools injected into the live chat automatically. No breaking changes; no new user-facing settings.

### Added

- **Inline readiness indicator on the chat composer.** A small pill next to a new-chat composer names the MCP servers it is currently waiting on and updates as they resolve. Rendered only while the readiness gate is open; disappears the moment the composer becomes usable. Fast-path guarded — if the gate closes within 100 ms the pill never appears, so quick starts still feel instant. Uses `role="status"` for screen-reader announcements.
- **Automatic live tool refresh on late MCP connect.** When an MCP server reaches `connected` after the composer is already open (typical for device-flow logins, `az login` refreshes, or servers whose first-time auth exceeded the 15 s readiness ceiling), the plugin now injects that server's tools into the running chat session and shows a "Tools from *&lt;server name&gt;* are now available." Notice that names the specific server. Conversation history is preserved. **Users no longer need to reload Obsidian when a slow-auth server finally connects, or when an MCP access token expires and reconnects mid-session.** (`src/main.ts`, `src/sdk/AgentSession.ts`.)
- **Turn-boundary queueing for the refresh.** If a server connects mid-stream, the refresh is latched and applied exactly once at the turn boundary using the latest snapshot at drain time (last-write-wins). Prevents mid-response tool-list churn without dropping updates. (`src/sdk/AgentSession.ts` — `pendingToolUpdate` latch.)

### Changed

- The chat composer's disabled state during MCP readiness now carries a positive signal (the pill) instead of only a greyed-out background, resolving a v0.8.0 rollout observation that users assumed the plugin was broken during the wait.

### Under the hood

- The live tool refresh uses the Copilot SDK's `client.resumeSession(sessionId, { tools, model, onPermissionRequest, … })` to swap the SDK session in place. `sessionId` is stable across the resume, so server-side conversation history is preserved. The old session is disconnected in the background after the fresh one is installed.
- Race safety: if the user closes the chat while a refresh is in flight, the freshly-built session is disconnected and the swap is skipped. If the resume call fails, the previous session is left in place and the next transition retries with a fresh snapshot.

### Follow-ups

- The refresh above is a stop-gap while an upstream `session.updateTools(...)` primitive lands. That primitive is proposed at [github/copilot-sdk#1896](https://github.com/github/copilot-sdk/issues/1896) (re-triage of the previously-closed #735). When it ships and is published to npm, a future release will bump `@github/copilot-sdk`, wire the real primitive, and drop the session-swap fallback. **User-visible behavior is unchanged either way** — this is purely an internal simplification.

## [0.8.0] - 2026-07-01

Adds importable preset packs (JSON) and an export-as-pack flow on top of v0.7, plus targeted MCP UX hardening surfaced during smoke testing (error visibility, tool readiness on reload). Additive over v0.7; no breaking changes. Existing built-in presets and HTTP authentication paths are unchanged.

### Added

- **Pack JSON format (FR-001 / FR-019).** Strict-JSON `Pack` and `PackPreset` types with hand-written validator (single-error contract returning RFC-6901 pointer + message), canonical form, structural diff, and a hard 1 MB size cap with a 100 KB "large pack" notice. (`src/settings/presets/packTypes.ts`, `packParser.ts`, `packValidator.ts`, `packCanonical.ts`, `packDiff.ts`.)
- **Secret-templating policy (FR-020 revised).** `SECRET_PLACEHOLDER = "__NEEDS_VALUE__"` and a per-credential-kind classification table. `command-based` `command`/`args`/`tokenPath`/`expiryPath`/`refreshBufferSeconds` are STRUCTURAL (mirroring the built-in M365 reality); future / unknown credential kinds default to fully templatized. Stdio `env` keys in the form denylist are templatized. (`src/settings/presets/packSecretPolicy.ts`.)
- **PresetPacksStore (FR-009 / FR-011).** New `mcpPresetPacks` top-level settings key with sibling-key preservation invariant verified by tests. Add/replace, remove, subscribe API. (`src/settings/PresetPacksStore.ts`.)
- **Pack file I/O (FR-002 / FR-005).** `PackFileReader` and `PackFileWriter` interfaces. Production readers use a transient off-DOM `<input type=file>` and Electron `file.path` for `sourcePath`. Production writer targets `<vault>/exported-packs/` via the vault adapter (native save-dialog deferred). (`src/settings/presets/packFileIO.ts`.)
- **Import orchestrator with diff confirmation (FR-007).** Parse → validate → diff vs persisted pack → present confirmation surface → apply. Re-import of an unchanged file shows an empty diff. (`src/settings/presets/packImporter.ts`, `src/settings/packSettingsLogic.ts`.)
- **Effective registry with FR-013 namespacing.** Built-in presets always sort first; collisions resolve to `<packId>.<presetId>` for the imported side; two-imports collisions namespace BOTH; duplicate ids within one pack are rejected by the validator. (`src/settings/presets/effectiveRegistry.ts`, `src/settings/presets/BuiltInPacks.ts`.)
- **Grouped Add Server dropdown.** Dropdown is now built from the effective registry with one optgroup per source pack (built-in first). Pack-preset selection pre-fills the form and surfaces a "Pack-templatized: please supply a value before saving (…)" hint with `aria-required="true"` on required inputs. Built-in branch preserves the existing `preset.build()` + preflight-hint path exactly. (`src/settings/presetDropdownLogic.ts`, `src/settings/McpServersSection.ts`.)
- **Export servers as pack flow.** New header button + dialog (id / label / version inputs, per-server checkbox list, Cancel / Export). Templatizes secrets via the shared `packSecretPolicy`, dedupes preset ids slugged from server names, and writes via the `PackFileWriter`. (`src/settings/packExportFlow.ts`, `src/settings/presets/packExporter.ts`, `src/settings/SettingsTab.ts`.)
- **Editor JSON Schema.** Pack authors get `docs/schemas/preset-pack-v1.json` for editor assistance plus `npm run schema:check` as a no-dependency drift gate.
- **Per-row export shortcut.** Every configured MCP server row now includes **Export this server as pack…**, opening the export flow pre-scoped to that server.
- **Field-level re-import diff.** Re-import confirmations include secret-aware structural field annotations capped at 8 lines so label/command/credential-shape changes are visible without exposing secret values.
- **Imported packs UI subsection.** Per-pack rows show label, version, preset count, source path, and "imported at" timestamp; **Remove** button never touches `mcpServers` (FR-008). (`src/settings/McpServersSection.ts`.)
- **User guide** at [`docs/preset-packs.md`](docs/preset-packs.md): what packs are, JSON format, import / re-import / remove / export flows, secret-templating contract per credential kind, FR-013 namespacing example, safety model, troubleshooting matrix.

### Changed

- `McpServerFormInput` gains `requiredSecretFields?: string[]` and `credentialArgs?: string[]`. The form validator enforces non-emptiness for every field listed in `requiredSecretFields` and round-trips `credentialArgs` so command-based `args` survive pack pre-fill → save and edit → save unchanged. (`src/settings/mcpServerFormLogic.ts`.)
- Edit-form open now seeds `pendingCredentialArgs` from the existing server's `credentials.args`, preserving command-based args across saves regardless of whether the form was driven by a pack preset. (`src/settings/McpServersSection.ts`.)
- Add Server preset dropdown switches from a flat list to grouped optgroups (built-in first, then per-pack groups in `importedAt` ascending order).

### Notes

- The `oauth-pkce` credential variant remains reserved and inert; pack export does not emit `oauth-pkce` rows.
- No new runtime dependencies. Pack validation is hand-written; canonicalisation is `JSON.stringify` with sorted keys.

### MCP tool-call UX hardening

- **Tool-call errors surface as content.** MCP tool calls that return an error result are now propagated back to the model as text (prefixed with an `Error:` sentinel) instead of being swallowed. Includes both tool-reported errors (`isError: true`) and transport-level JSON-RPC errors. Chat now shows the failure inline and the model can react. (`src/mcp/McpToolBridge.ts`, `src/sdk/AgentSession.ts`.)
- **Errored tool-call chip renders red.** The tool-call chip is reclassified from `completed` to `errored` when an MCP call returns one of the sentinel error prefixes, so the UI status matches reality. Custom (non-MCP) tools that legitimately return text starting with `Error:` are exempt. (`src/sdk/AgentSession.ts`.)
- **MCP readiness gate before session creation.** On plugin load, chat now waits (up to 15s) for every enabled MCP server to reach a terminal status (`connected` / `error` / `crashloop` / `disabled`) before creating the first SDK session, so tool lists are populated on the first message. Fixes a regression where reload could drop MCP tools until "New Conversation" was clicked. Also applies to `resetConversation()` and deferred-catalog recovery. (`src/mcp/McpManager.ts`, `src/sdk/AgentSession.ts`, `src/main.ts`.)
- **Sticky stdio startup notice.** First-launch stdio startup notices in Settings are now sticky (duration 0) so they can't be missed mid-scroll.

### Fixed

- **Composer un-selectable after conversation switch.** Auto-focuses the composer input after conversation switch / create, closing a race where the input remained un-clickable after MCP settings changes. (`src/ui/ChatView.ts`.)

## [0.7.0] - 2026-06-23

Adds authenticated MCP server support and the first built-in preset (Microsoft 365 Graph via Azure CLI). Additive over v0.6; no breaking changes.

### Added

- **Per-request credential resolver for HTTP MCP servers.** New `ServerCredentials` discriminated union (`none` | `static-bearer` | `command-based`, plus reserved `oauth-pkce`). The HTTP transport asks the resolver for an `Authorization` value before each initial-hop fetch and respects the existing redirect / cross-origin / private-network policies on subsequent hops. Tokens from command-based credentials live in memory only; the resolver caches them until `expiresOn - refreshBufferSeconds`. (`src/mcp/credentials/`, `src/mcp/McpServerRuntime.ts`.)
- **One-shot 401 retry.** On a 401 from a credential-bearing request, `McpManager` invalidates the per-server token cache and retries exactly once. Token rotation across a long chat session is therefore chat-invisible. (`src/mcp/McpManager.ts`, `src/mcp/McpManager.credentials.test.ts`.)
- **Preset registry + Microsoft 365 Graph preset.** Settings → MCP Servers → Add → preset dropdown. The shipped preset is **Microsoft 365 Graph (via Azure CLI)**, pinned to the FR-008 values and asserted by snapshot test. Selecting it pre-fills the entire form. (`src/settings/presets/McpServerPresets.ts`.)
- **Inline preflight install hint.** `src/settings/isCommandOnPath.ts` resolves bare commands against `PATH` (with Windows `PATHEXT` probing). The settings form surfaces a non-blocking install hint when the preset's command is missing.
- **Test connection** button on every HTTP MCP server row. Runs the initialize handshake against the live server. (`src/settings/McpServersSection.ts`.)
- **`M365RemediationFormatter`.** Chat-side credential errors now include a copyable remediation hint specific to the M365 preset (install hint when `az` is absent, `az login --tenant <…>` when present). Custom commands fall through to a generic hint. (`src/mcp/credentials/M365RemediationFormatter.ts`, wired in `src/main.ts`.)
- **Obsidian-renderer fetch adapter.** `src/mcp/transport/obsidianFetch.ts` wraps Obsidian's `requestUrl()` API as a `fetch`-compatible function so MCP HTTP traffic bypasses Electron-renderer CORS. Required for the M365 Graph MCP and any other enterprise MCP server that doesn't emit `Access-Control-Allow-Origin` for the Obsidian origin.
- **User guide** at [`docs/m365-graph-mcp.md`](docs/m365-graph-mcp.md): quick start, credential model, troubleshooting matrix, custom commands, security posture, scope limits.
- **PAW technical reference** at [`.paw/work/authenticated-mcps/Docs.md`](.paw/work/authenticated-mcps/Docs.md). Manual smoke checklist at [`.paw/work/authenticated-mcps/SmokeChecklist.md`](.paw/work/authenticated-mcps/SmokeChecklist.md).
- **Forward-looking proposals.** [`proposals/0006`](proposals/0006-tool-picker-and-scope-aware-credentials.md) — tool picker driving scope selection via `oauth-pkce`. [`proposals/0007`](proposals/0007-importable-preset-packs.md) — importable preset packs for distributing per-product Graph MCPs outside the public plugin.

### Changed

- HTTP MCP servers configured with a top-level `authorization` string in v0.5/v0.6 are migrated to the `static-bearer` credential variant on read. The on-disk shape is preserved unless the row is re-saved through the new settings UI.
- `createMcpHttpFetchWrapper` now passes HTTP 405 through to the SDK as a `Response` instead of throwing `McpHttpError`. The MCP Streamable HTTP spec treats 405 on the optional SSE GET listening stream — and on session DELETE — as the "feature not supported" signal, which the SDK handles internally. All other ≥400 statuses still throw with the redacted `WWW-Authenticate` value preserved.

### Fixed (Obsidian renderer environment)

- `setTimeout` / `clearTimeout` in `SpawnCommandRunner` are captured at construction time as arrow wrappers so calls survive Obsidian's renderer process, where the receiver of the bare global must be `globalThis`.
- `fetch` is invoked via `globalThis.fetch.bind(globalThis)` when no adapter is injected, for the same reason.
- `az` (and any bare command without an extension) now resolves via `PATHEXT` on Windows before `spawn`, so `az` → `az.cmd` is dispatched through the existing `cmd.exe /d /s /c` wrapper.

### Known limitations

- **Permission scopes via `az` are bounded to what the Azure CLI client is pre-consented for on the MCP service** — in practice `User.Read`-class data. Calendar / mail / files / Teams calls typically return HTTP 403 server-side via OBO. Documented in [`docs/m365-graph-mcp.md`](docs/m365-graph-mcp.md) § "Permission scopes and 403 errors". Tracked forward in [`proposals/0006`](proposals/0006-tool-picker-and-scope-aware-credentials.md) and [`proposals/0007`](proposals/0007-importable-preset-packs.md).
- **`oauth-pkce` is schema-only.** The shape persists round-trip but there is no runtime resolver yet.
- **`requestUrl` follows HTTP redirects internally**, so the manual-redirect policy in `createMcpHttpFetchWrapper` only sees the initial URL and the final response when the Obsidian adapter is in use. Pre-fetch URL validation (private-network, metadata block) still applies. Cross-origin `Authorization` strip on intermediate hops becomes a trust-but-verify property of `requestUrl` under the adapter.

## [0.6.0] - 2026-06-19

Graduation of `v0.6.0-rc.1` to stable. No user-visible code changes since the RC — the RC was validated end-to-end via BRAT install in a clean Obsidian vault (binary download, OAuth sign-in, read tools, approval-gated writes, cache reuse on reload).

Post-RC commits:

- `fix(mcp/stdio)`: `findOnPath` now uses `path.win32` explicitly so the Linux release workflow's cross-platform tests pass. Production behavior on real Windows hosts is unchanged.
- `docs(release-agent)`: captured publish gotchas from the v0.5.0 retroactive publish and the rc.1 first run into the release agent skills (full-SHA requirement, `gh auth switch` flip, Windows shell quoting, `assemble-assets.mjs` cwd binding, pre-release detection, BRAT public-repo requirement).

See the [v0.6.0-rc.1](#060-rc1---2026-06-19) entry below for the full list of v0.6 changes.


## [0.6.0-rc.1] - 2026-06-19

First BRAT-installable release. The plugin can now be installed end-to-end from a GitHub Release tag without cloning the repo or copying the ~150 MB `copilot.exe` binary by hand. End-to-end release tooling is now in-repo and exercised by the same agent used to cut this release.

### Added

- **In-plugin Copilot CLI binary fetcher.** On first launch (and after maintainer-driven pinned-version bumps), the plugin downloads the platform-matching `copilot` binary from `github.com/github/copilot-cli/releases/download/v<pinned>/...`, verifies the SHA-256 against an in-repo manifest, sets `0o755` on POSIX, and caches it under the plugin's data dir. Subsequent launches skip the network entirely. A non-blocking "Downloading Copilot CLI binary…" Notice is shown during first fetch; subsequent successes are silent. Failures surface as a Notice with a Retry action and don't block the rest of plugin startup.
- **Pinned binary version generator** (`scripts/generate-pinned-binary-version.mjs`, run via `pretypecheck`/`prebuild`). Emits `src/sdk/pinnedBinaryVersion.ts` from the `@github/copilot-sdk` version recorded in `package-lock.json` so the runtime fetcher's pin is the single source of truth.
- **Settings → Copilot Agent → CLI binary section.** Shows the resolved binary path, version pin, checksum status, and a "Re-fetch binary" action. (`src/settings/CliBinarySection.ts`.)
- **End-to-end release pipeline.** `.github/workflows/release.yml` builds on tag push, validates the three required assets, auto-detects pre-releases by the `-` in the tag, and publishes via `gh release create` using release notes extracted verbatim from `CHANGELOG.md`. Pre-releases (e.g. `v0.6.0-rc.1`) are marked `prerelease: true` automatically.
- **Release tooling scripts** under `scripts/release/`: `assemble-assets.mjs` (collects `main.js`/`manifest.json`/`styles.css` into a single dir), `extract-release-notes.mjs` (slices the matching `## [<version>]` section out of `CHANGELOG.md`), `status.mjs` (per-file/per-tag state for re-entrant release runs), `bootstrap-v0.5.0.mjs` (one-shot retroactive v0.5.0 publisher).
- **Version-bump script** (`scripts/version-bump.mjs`) updates `package.json`, `manifest.json`, `versions.json`, and stubs a new `CHANGELOG.md` section in one command.
- **Release agent + skills** under `.copilot/agents/release/`. The agent orchestrates preflight → version-bump → changelog-draft → tag-and-push → ci-monitor → verify with a dry-run mode and re-entrant skip logic. Maintainers can ship a release by saying "cut v0.6.0-rc.1" inside Copilot CLI.
- **Maintainer documentation:** `RELEASING.md` (comprehensive runbook with agent quick-start, manual CLI fallback, prerequisites, recovery procedures, trust chain, Windows BRAT smoke-test procedure, two-`gh`-account note, dry-run mode, v0.5.0 reproducibility notes), `.paw/work/packaging-release/Docs.md` (technical reference for the release pipeline architecture), and a "Releasing" section in `README.md`.
- **v0.5.0 retroactive release.** Published via `bootstrap-v0.5.0.mjs` from historical commit `22f660d10881a61e52a9c2ea299f57d9d51ac1df` so the new pinned-version pipeline has a base tag to reason against. The published `manifest.json` synthesizes `"version": "0.5.0"` from the historical manifest preserving all other fields.

### Changed

- `scripts/deploy.mjs` now copies the pinned binary into the vault plugin dir when present, so deploys to the test vault don't require an Obsidian restart to pick up a new pinned version.
- `manifest.json` now declares `minAppVersion: 1.5.0` and tracks the canonical `version` field that the release pipeline expects (matched to `package.json`).
- Plugin onload sequence (`src/main.ts`) materializes the binary fetcher BEFORE the agent session boots so the SDK adapter resolves to the cached/fetched binary on every launch path (fresh install, upgrade, settings reload).

### Tests

- 944 → 1107 (+163) across new `src/release/*` suites (changelog, versioning, releaseAssets, releaseStatus, versionsJson, bootstrapRelease, version-bump CLI, extract-release-notes CLI), the binary fetcher (`BinaryFetcher.test.ts`, `BinaryFetcher.integrity.test.ts`), the CLI binary settings section (`CliBinarySection.test.ts`), and the plugin startup binary-resolution path (`main.startup.binary.test.ts`).

### Security

- Binary fetcher pins both the version (from `package-lock.json`-derived generator output) and the SHA-256 (in-repo manifest) before any binary is executed. Mismatched checksums abort the fetch and leave no partial file on disk. The fetcher is read-only on cache hits.
- Release pipeline never executes untrusted release notes — `extract-release-notes.mjs` is a pure text slice from `CHANGELOG.md`, which is reviewed in the bump commit before the tag is pushed.

### Dependencies

- No SDK or runtime dependency changes from v0.5. The pinned-binary version tracks `@github/copilot-sdk` (already exact-pinned in v0.5).


## [0.5.0] - 2026-06-18

### Added

- MCP client support for stdio and Streamable HTTP servers, powered by exact-pinned `@modelcontextprotocol/sdk@1.29.0`; the client advertises protocol `2025-06-18`, accepts `2024-11-05` on supported transports, and rejects legacy HTTP+SSE-only servers.
- Settings UI for adding, editing, enabling, disabling, removing, inspecting, and reconnecting MCP servers, including static Streamable HTTP `Authorization` support.
- MCP tools appear in chat with server attribution and the existing approval gate; image/binary results render as placeholders instead of raw base64.
- Coalesced `notifications/tools/list_changed` refresh and Stop/cancellation handling for MCP `tools/call`.

### Changed

- Safety approval scope for MCP calls now uses the exact `(serverId, toolName, trustEpoch)` tuple, where the trust epoch changes when the server's security-relevant identity changes.

### Security

- stdio child processes run with env denylist filtering; display and persistence sinks redact `Authorization`, `Mcp-Session-Id`, URL userinfo, token query params, and denylisted env values.
- Streamable HTTP has no TLS bypass options, drops `Authorization` on cross-origin redirects, rejects cloud metadata IPs, requires confirmation for private-network targets, and rejects legacy HTTP+SSE-only fallback.
- MCP server `instructions` and tool descriptions are treated as untrusted prompt-injection surfaces and cannot alter approval policy.

### Migration

- Legacy v0.4 `mcpAutoApprove` keys are preserved on round-trip but ignored at decision time unless they match the new exact-scope grant key. Users are re-prompted under the `(serverId, toolName, trustEpoch)` grant model.

### Dependencies

- `@modelcontextprotocol/sdk@1.29.0` is exact-pinned with no caret/tilde; future bumps require transport-security re-review.

### Bundle Size

- NFR-005 Phase 3 measurement: pre-SDK `main.js` gzip 83,032 bytes; post-SDK/runtime `main.js` gzip 121,915 bytes; delta +38,883 bytes (≤80 KB target). No waiver required.

### Tests

- Final v0.5 test count: 944 passing. Documentation-only Phase 7 leaves the Phase 6 second-fixup count unchanged.

## [0.4.0] – 2026-06-12

### Added

- **Per-conversation model picker** in the chat header (FR-001 / FR-002 / FR-003). A dropdown sits next to the connection status pill and shows the model bound to the currently-active conversation; clicking it lists every chat-capable Copilot model your account can reach. Each conversation remembers its own model — switching conversations updates the picker label. The picker uses Obsidian's standard `Menu` widget (the same dropdown style as the conversation picker) so it inherits keyboard accessibility and theme tokens.
- **Settings → Copilot Agent → Model → Default model** (FR-007). A new dropdown picks the model that new conversations start with. The list mirrors the same chat-capable catalog the chat-header picker uses. The default is honoured at conversation creation time; if it's not in the catalog at the moment you create a conversation, the plugin falls back to a heuristic (gpt-4.1 / gpt-4o / first chat model) and surfaces a one-shot Notice so you can update the setting.
- **Mid-conversation model swap with history preserved** (FR-005 / FR-008). Picking a different model swaps it on the underlying SDK session in-place — the conversation history is preserved and your next message is answered by the new model. The first swap on a conversation with at least one completed assistant turn opens a confirmation dialog ("Switching to <model>. The conversation history is preserved; …. Continue?"). Identity swaps and swaps on a brand-new conversation skip the dialog. Any pending tool-approval prompts are cancelled when the swap is confirmed (the dialog tells you so).
- **Recovery flows for catalog failures, empty accounts, and stale models** (FR-010 / FR-016 / FR-018). When the model list can't be fetched at startup the plugin no longer aborts: the chat opens with an inline "Models unavailable" banner above the composer and a **Retry** button that re-runs `listModels()` without a plugin reload. When the account has zero chat-capable models you see "No chat models available." instead. When a conversation's persisted modelId is no longer in the catalog (e.g. a model was deprecated), the picker shows `<id> (unavailable)` as the current selection and an inline banner blocks send until you pick a real model.
- **Lazy model resolution for migrated conversations** (FR-013). v0.3 conversations open with no bound model id; on first activation in v0.4 the plugin resolves one (configured default → heuristic) and persists it so subsequent opens are stable.
- **Deferred SDK-session creation** (S1). If the catalog is unavailable at startup the AgentSession defers `createSession()` rather than failing. It subscribes to the catalog and creates the session in-place the moment the catalog reaches the `ready` state — either because Retry succeeds or the token rotates. No plugin reload required for these recoveries.
- **`canSend()` single-source send gate** (FR-014). All four catalog/model blocked states (`unavailable-model`, `catalog-error`, `catalog-empty`, `unresolved-model`) plus the existing connection / streaming / pending reasons go through one decision function. The send button, Enter key, and inline banner all derive from the same result, so the user always sees the same reason text in the same precedence order.

### Changed

- **Chat header layout** (FR-015). The connection status pill is now smaller and adjacent to the model picker; the model name is no longer duplicated as `Connected · <model>` because the picker is the canonical model indicator. Status text is just `Connected` while connected.
- `AgentSession` interface gains `hasPendingApprovals(): boolean` and `hasDeferredSession(): boolean` so the UI can drive the swap-confirmation copy and the inline-error banner without touching internals.
- `ConversationManager` gains an optional `resolveCreationModelId` resolver (sync, runs at create time AND lazily on first activation for migrated conversations) and an optional `onUnavailableDefault(configuredDefault)` callback so the domain layer can surface a Notice without coupling to the Obsidian SDK.
- Token rotation now refreshes the model catalog automatically so entitlement changes propagate without a plugin reload.

### Migration

- **Persistence schema v1 → v2 (additive, no destructive migration)**: each persisted conversation gains an optional `modelId: string | null` field. v1 payloads parse cleanly into v2 (the field is missing → treated as v0.3-migrated → lazy-resolved on first activation). No user action required.
- The "Default model" Settings dropdown starts empty for upgraders; the plugin uses the v0.3 heuristic until you pick one.

### Tests

- 609 → 728 (+119 across 19 commits): per-conversation modelId persistence, the model catalog filter (hard `policy.state === "disabled"` only; soft signal is logged not excluded), the heuristic resolver, the swap orchestration, the model picker view-model/keyboard reducer/confirmation copy, the four canSend blocked states with precedence, the unavailable-id sentinel row, lazy resolution, and the AgentSession deferred-init recovery cycle.

## [0.3.0] – 2026-06-11

### Added

- Multi-conversation support: conversation picker dropdown at the top of the chat pane (current name + caret), with Create / Switch / Rename / Delete actions. Up to 20 active conversations; the 21st auto-archives the lowest-`lastActiveAt` non-active conversation and surfaces a one-time Notice. Archived conversations are preserved on disk for a future "Show archived" UI.
- Auto-naming: new conversations are seeded with `Untitled YYYY-MM-DD HH:MM` (local time). On the first user message the conversation auto-renames from the first non-empty line of that message (≤ 40 chars, surrogate-pair safe). Manual renames always win — the auto-name only applies while the current name still matches the default-name predicate.
- Cross-restart persistence: conversation list, per-conversation message history, per-conversation undo journals, and the active-conversation id all persist across plugin reload, Obsidian restart, and OS reboot via debounced writes (≤ 1 per 500 ms). Final flush on Obsidian's `quit` event ensures OS-level shutdown still persists everything.
- Cross-restart Undo with divergence prompt: undo entries persist alongside their conversation (50 most recent per conversation, 7-day TTL). When the file has been modified, deleted, or replaced since the recorded snapshot, the Undo button opens an overlay describing the divergence ("modified outside the agent" / "no longer exists" / "already exists") with **Cancel** / **Revert anyway** actions; choosing Revert anyway re-runs `UndoJournal.undo(id, { force: true })`. Successful undos flip to a "reverted" pill that survives a fast restart (immediate flush on `markUndone`, FR-013).
- Three new read-only auto-approved search tools: `search_by_tag`, `search_by_name`, `list_all_tags`. Backed by Obsidian's `MetadataCache`; bounded result caps; structured `{ ok: false, reason: "metadata-cache-not-ready" }` payload when the cache is cold.
- Safety setting "Expose v0.1 raw-filesystem tools" (default **ON**, opt-out). The six v0.1 raw-FS tools (`view`, `read_file`, `search_content`, `create_file`, `edit_file`, `delete_file`) remain registered as a defensive fallback while the preamble's tool inventory marks them as `(fallback)` so the model reaches for the vault-aware tools first. Toggle OFF for a strictly vault-only surface — the gating is captured at plugin onload, so when OFF the raw-FS tools are not registered with the SDK and are omitted from the preamble's tool inventory. Toggling persists immediately; the new value applies at the next plugin reload (FR-015).
- Suppressed Undo affordance for historical raw-FS tool calls while the toggle is OFF (FR-016): the call name + result still render so chat scrollback stays readable, but the Undo button is hidden. Already-undone calls still show their "reverted" pill.
- Schema versioning of persisted state with corruption-recovery sidecar: when validation fails, the malformed conversation subtree is wrapped as `{ recoveredAt, schemaVersionExpected, malformed }` and written to `<plugin-dir>/conversations_recovery.bak.json`, then the plugin proceeds from defaults; auth and safety settings survive recovery (FR-010, SC-001).
- One-shot 5 MB size warning Notice (SC-011) when the persisted blob crosses 5 × 1024 × 1024 bytes; in-memory flag prevents Notice spam within a session.
- Comprehensive new test coverage across `ConversationManager`, `ConversationsStore`, `ConversationRuntime`, `UndoJournal` cross-restart paths, and the new search tools.

### Changed

- v0.2 Undo behaviour now survives a restart. Undo button continues to appear on persisted tool-call blocks; clicks check current file content against the snapshot before reverting (no mtime/size fields are stored — divergence is detected by byte-for-byte content comparison, SI-1).
- The default preamble's tool inventory now lists the v0.2 vault-aware tools first and tags the v0.1 raw-FS tools as `(fallback)` so the model prefers the vault-aware surface. The raw-FS tools remain registered by default and are still available when needed; users who want them gone entirely can flip the new safety toggle OFF.
- Plugin onload sequence now materialises the active conversation's runtime BEFORE auth hydrates so the broadcasting `tokenSink.reconnect()` finds a live model id and the header model pill displays the current model immediately on first paint.
- `ConversationsStore.markUndone` bypasses the 500 ms debounce and writes through immediately so a successful undo cannot be undone by a fast restart.
- `UndoJournal` now accepts a richer options object (`persist`, `initialEntries`, `maxEntries`, `loadOptions.ttlMs`, `now`) for persistence wiring while remaining backward-compatible with the legacy `new UndoJournal(vault)` constructor.

### Migration

- No action required for the raw-FS tools — the new "Expose v0.1 raw-filesystem tools" safety toggle defaults ON, so the v0.1 raw-FS tools remain available exactly as before. The v0.3 preamble simply nudges the model to prefer the vault-aware tools first. To opt out: Settings → Copilot Agent → Safety → "Expose v0.1 raw-filesystem tools" → toggle OFF, then reload the plugin (Disable + Enable in Community plugins, or restart Obsidian).
- v0.2 persisted data carrying no `schemaVersion` parses cleanly into v0.3 defaults — there is no destructive migration. Forward-incompatible payloads (a future `schemaVersion > 1` from a downgrade) trigger the recovery-sidecar path so user data is preserved rather than truncated.

## [0.2.0] – 2026-06-10

### Added

- Keyboard-first chat input: Enter sends, Shift+Enter inserts a newline, IME composition is respected, empty/whitespace input is rejected. Enter is inert while a response is streaming (Stop is the only cancel path).
- Vault-aware preamble assembled on the first send of each session: vault root path, timezone, today, inventory of available vault tools, and an authoring-conventions block (wikilinks, hash-prefixed tags, Tasks-plugin checkbox syntax). Configurable via Settings → Copilot Agent → Vault Awareness (Default / Custom / None).
- Vault Awareness settings: mode toggle, custom-body textarea with `{{VAULT_ROOT}}` / `{{VAULT_TIMEZONE}}` / `{{VAULT_TODAY}}` / `{{VAULT_TOOL_INVENTORY}}` / `{{AUTHORING_CONVENTIONS}}` placeholders, default task target (today's daily note or custom path).
- Read-only vault-aware tools (auto-approved, no prompt): `get_active_note`, `list_recent_notes`, `find_backlinks`, `vault_tree`, `vault_metadata`, `find_tasks`, plus `open_note` (navigation only).
- Mutating vault-aware tools (one approval each, journal-undoable): `create_note`, `edit_note`, `insert_into_active_note`, `create_daily_note`, `create_task`, `update_task`.
- Daily Notes core plugin integration: `create_daily_note` honors the configured folder/format/template, falls back to `<vault-root>/YYYY-MM-DD.md` when disabled.
- Tasks community plugin integration: `create_task` auto-detects plugin presence and emits the matching flavor (📅/✅/⏳/➕/❌ emoji syntax when present, GFM `(field: value)` syntax otherwise). `createdDate` (➕) defaults to today.
- `update_task` structured patch tool: change status / priority / tags / due date / scheduled date / description on a single task line, with two-tier re-anchor (byte-exact `expectedRawLine` then `descriptionMatch`), idempotent status auto-stamping (`done` → ✅ today, `cancelled` → ❌ today), recurrence and block-ID preservation via an `extras` pass-through, and format-source preservation (tasks-plugin stays tasks-plugin, GFM stays GFM).

### Changed

- v0.1 tools (`view`, `read_file`, `search_content`, `create_file`, `edit_file`, `delete_file`) remain registered as defensive fallbacks. Each new capability with a fallback path reports `usedFallback: boolean` in its result.
- Test count: 166 → 401 (+235 across new domain, tool, and UI suites).

### Security / Privacy

- The default preamble sends only vault root path + timezone + today + tool inventory + authoring conventions. **No folder or file enumeration, no note contents, no recent-activity metadata, no per-file timestamps.** Folder/file structure is available on demand via the auto-approved `vault_tree` / `vault_metadata` tools. Users with the most sensitive vaults can set Vault Awareness to **None** to suppress the preamble entirely.
- The universal permission gate (`decideSafety`) is unchanged from v0.1. Every mutating capability — including `update_task` — registers without `skipPermission`, so all writes route through the same gate as v0.1's `create_file` / `edit_file` / `delete_file`.

## [0.1.0] – v0.1 private spike

Initial private spike. OAuth Device Flow sign-in via the `gh` CLI client ID, streaming chat with Stop-to-cancel, vault read tools (`view`, `read_file`, `search_content`) exempt from prompts, vault write tools (`create_file`, `edit_file`, `delete_file`) routed through a single deny-by-default approval gate, in-session Undo for any approved write, three-mode safety policy (require-approval / auto-apply-with-undo / allowlist) plus persistent trust scopes (path allowlist, per-built-in toggles). 166 tests across domain, tools, and SDK adapter.
